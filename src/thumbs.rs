//! A disk cache for preview frames.
//!
//! Zooming the timeline asks for a fresh row of frames, and every one of those
//! is an ffmpeg process. Without a cache, zooming in and back out re-extracts
//! frames that were on screen a second ago; with one, revisiting a range is
//! instant and only genuinely new positions cost anything.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Roughly a hundred megabytes of JPEGs at the sizes used here.
const MAX_ENTRIES: usize = 4000;

#[derive(Debug, Clone)]
pub struct ThumbCache {
    dir: PathBuf,
}

impl ThumbCache {
    pub fn new(base: &Path) -> Result<Self> {
        let dir = base.join("thumbs");
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        Ok(Self { dir })
    }

    /// Key on the file's identity *and* its modification time, so editing a
    /// file in place does not keep serving frames from the old one.
    fn key(&self, source: &Path, at: f64, width: u32) -> Option<PathBuf> {
        let meta = std::fs::metadata(source).ok()?;
        let modified = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        let mut hasher = Sha256::new();
        hasher.update(source.to_string_lossy().as_bytes());
        hasher.update(modified.to_le_bytes());
        hasher.update(meta.len().to_le_bytes());
        // Milliseconds are finer than anything the UI asks for and keep the key
        // free of float formatting quirks.
        hasher.update(((at * 1000.0).round() as i64).to_le_bytes());
        hasher.update(width.to_le_bytes());
        let digest = hasher.finalize();
        let name: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
        Some(self.dir.join(format!("{name}.jpg")))
    }

    pub fn get(&self, source: &Path, at: f64, width: u32) -> Option<Vec<u8>> {
        let path = self.key(source, at, width)?;
        let bytes = std::fs::read(&path).ok()?;
        if bytes.is_empty() {
            return None;
        }
        // Touch the file so the sweep below can treat it as recently used.
        let _ = filetime_now(&path);
        Some(bytes)
    }

    pub fn put(&self, source: &Path, at: f64, width: u32, bytes: &[u8]) {
        let Some(path) = self.key(source, at, width) else {
            return;
        };
        // Written under a unique name and renamed, so a killed process cannot
        // leave a truncated JPEG that later looks like a cache hit.
        let tmp = path.with_extension(format!("{}.part", std::process::id()));
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// Drop the oldest entries when the cache grows past its budget.
    pub fn prune(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, entry.path()))
            })
            .collect();
        if files.len() <= MAX_ENTRIES {
            return;
        }
        files.sort_by_key(|(modified, _)| *modified);
        for (_, path) in files.iter().take(files.len() - MAX_ENTRIES) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Bump a file's modification time to now, as a crude access record.
fn filetime_now(path: &Path) -> std::io::Result<()> {
    let file = std::fs::OpenOptions::new().append(true).open(path)?;
    // Appending nothing still updates the timestamp on the platforms we target.
    file.set_len(file.metadata()?.len())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(dir: &Path, bytes: &[u8]) -> PathBuf {
        let path = dir.join("clip.mp4");
        std::fs::write(&path, bytes).expect("write");
        path
    }

    #[test]
    fn returns_what_it_stored() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let clip = source(dir.path(), b"video");

        assert!(cache.get(&clip, 1.5, 200).is_none(), "nothing cached yet");
        cache.put(&clip, 1.5, 200, b"jpeg-bytes");
        assert_eq!(
            cache.get(&clip, 1.5, 200).as_deref(),
            Some(&b"jpeg-bytes"[..])
        );
    }

    #[test]
    fn keys_on_the_position_and_the_width() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let clip = source(dir.path(), b"video");
        cache.put(&clip, 1.5, 200, b"one-and-a-half");

        assert!(cache.get(&clip, 2.0, 200).is_none(), "a different moment");
        assert!(cache.get(&clip, 1.5, 400).is_none(), "a different width");
        assert!(cache.get(&clip, 1.5, 200).is_some());
    }

    #[test]
    fn rounds_the_position_to_the_millisecond() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let clip = source(dir.path(), b"video");
        cache.put(&clip, 1.5, 200, b"frame");
        // Float formatting must not turn the same moment into two keys.
        assert!(cache.get(&clip, 1.50004, 200).is_some());
    }

    #[test]
    fn forgets_a_frame_when_the_file_changes_underneath_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let clip = source(dir.path(), b"video");
        cache.put(&clip, 1.0, 200, b"old-frame");
        assert!(cache.get(&clip, 1.0, 200).is_some());

        // Editing a file in place must not keep serving frames of the old one.
        std::fs::write(&clip, b"a different video entirely").expect("rewrite");
        assert!(cache.get(&clip, 1.0, 200).is_none());
    }

    #[test]
    fn tells_two_different_files_apart() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let one = source(dir.path(), b"video");
        let two = dir.path().join("other.mp4");
        std::fs::write(&two, b"video").expect("write");

        cache.put(&one, 1.0, 200, b"first");
        assert!(
            cache.get(&two, 1.0, 200).is_none(),
            "same size, different file"
        );
    }

    #[test]
    fn ignores_a_source_that_is_gone() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let missing = dir.path().join("gone.mp4");
        assert!(cache.get(&missing, 1.0, 200).is_none());
        // Storing against a missing source is a no-op rather than an error.
        cache.put(&missing, 1.0, 200, b"frame");
    }

    #[test]
    fn leaves_no_partial_file_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let clip = source(dir.path(), b"video");
        cache.put(&clip, 1.0, 200, b"frame");

        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("thumbs"))
            .expect("read dir")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(leftovers.is_empty(), "a `.part` file survived the rename");
    }

    #[test]
    fn prunes_down_to_its_budget() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let thumbs = dir.path().join("thumbs");
        for index in 0..MAX_ENTRIES + 50 {
            std::fs::write(thumbs.join(format!("{index:06}.jpg")), b"x").expect("write");
        }
        cache.prune();
        let remaining = std::fs::read_dir(&thumbs).expect("read dir").count();
        assert_eq!(remaining, MAX_ENTRIES);
    }

    #[test]
    fn leaves_a_cache_within_its_budget_alone() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ThumbCache::new(dir.path()).expect("cache");
        let thumbs = dir.path().join("thumbs");
        for index in 0..10 {
            std::fs::write(thumbs.join(format!("{index}.jpg")), b"x").expect("write");
        }
        cache.prune();
        assert_eq!(std::fs::read_dir(&thumbs).expect("read dir").count(), 10);
    }
}
