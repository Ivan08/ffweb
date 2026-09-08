//! Where copies of dropped files live.
//!
//! A file dropped from a file manager arrives without a path, and if it is not
//! already somewhere ffweb can reach, the bytes have to be written down. That
//! copy is scratch data, not output: it belongs in a temporary directory that
//! disappears when the process does, not in the folder where results are kept.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// How long a directory has to sit before age alone is reason enough to remove it.
///
/// Age is the fallback. Where the owning process can be asked about directly,
/// it is — a directory belonging to a process that is gone has nothing left to
/// protect, whatever its age.
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Whether a process with this id is still running.
///
/// Only ever used to decide *not* to delete: an id that is alive keeps its
/// directory, and an id that has been reused by something unrelated keeps it
/// too. Being wrong in that direction costs a stale directory until the age
/// rule catches it; being wrong the other way would delete a running instance's
/// files.
#[cfg(target_os = "linux")]
fn process_is_alive(pid: u32) -> Option<bool> {
    Some(Path::new(&format!("/proc/{pid}")).exists())
}

#[cfg(not(target_os = "linux"))]
fn process_is_alive(_pid: u32) -> Option<bool> {
    // Nothing portable to ask, so the age rule decides on its own.
    None
}

/// The process id out of `ffweb-drop-<pid>-<suffix>`.
fn owner_of(name: &str) -> Option<u32> {
    name.strip_prefix("ffweb-drop-")?
        .split('-')
        .next()?
        .parse()
        .ok()
}

#[derive(Debug, Clone)]
pub struct Dropbox {
    dir: PathBuf,
}

impl Dropbox {
    /// Create this run's directory and clear out any left by earlier ones.
    pub fn create() -> Result<Self> {
        Self::create_in(&std::env::temp_dir())
    }

    /// The same, somewhere other than the system's temporary directory.
    ///
    /// Tests use it to keep their scratch inside their own temporary directory,
    /// which is removed with them. Reaching into the shared one instead left a
    /// directory behind for every test in every run.
    pub fn create_in(base: &Path) -> Result<Self> {
        sweep_stale(base);

        // The process id alone is not unique enough: two instances in one
        // process would share a directory, and either one cleaning up would
        // take the other's files with it. The id is kept because the sweep
        // below and anyone reading /tmp both want to know who owned this.
        let suffix: String = {
            use rand::Rng;
            const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
            let mut rng = rand::thread_rng();
            (0..6)
                .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
                .collect()
        };
        let dir = base.join(format!("ffweb-drop-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Remove the directory and everything in it.
    pub fn cleanup(&self) {
        if let Err(err) = std::fs::remove_dir_all(&self.dir) {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("could not remove {}: {err}", self.dir.display());
            }
        }
    }
}

/// A killed process cannot clean up after itself, so the next run does it.
fn sweep_stale(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("ffweb-drop-") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .map(|time| time.elapsed().map(|age| age > STALE_AFTER).unwrap_or(false))
            .unwrap_or(false);

        // A process killed outright cannot clean up after itself. Waiting a day
        // to notice was safe but slow: when the owner is demonstrably gone, the
        // directory goes now.
        let abandoned = owner_of(name)
            .filter(|pid| *pid != std::process::id())
            .and_then(process_is_alive)
            .map(|alive| !alive)
            .unwrap_or(false);

        if old || abandoned {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_each_instance_a_directory_of_its_own() {
        let base = tempfile::tempdir().expect("temp dir");
        let one = Dropbox::create_in(base.path()).expect("dropbox");
        let two = Dropbox::create_in(base.path()).expect("dropbox");
        assert_ne!(
            one.dir(),
            two.dir(),
            "two instances must not share a directory"
        );

        // Cleaning one up must not disturb the other.
        std::fs::write(two.dir().join("kept.mp4"), b"video").expect("write");
        one.cleanup();
        assert!(two.dir().join("kept.mp4").is_file());
        two.cleanup();
    }

    #[test]
    fn creates_a_directory_of_its_own_and_removes_it() {
        let base = tempfile::tempdir().expect("temp dir");
        let dropbox = Dropbox::create_in(base.path()).expect("dropbox");
        let dir = dropbox.dir().to_path_buf();
        assert!(dir.is_dir());
        assert!(
            dir.file_name()
                .expect("name")
                .to_string_lossy()
                .contains(&std::process::id().to_string()),
            "the directory has to be this process's own"
        );

        std::fs::write(dir.join("dropped.mp4"), b"video").expect("write");
        dropbox.cleanup();
        assert!(!dir.exists(), "cleanup must take the contents with it");
    }

    #[test]
    fn cleaning_up_twice_is_not_an_error() {
        let base = tempfile::tempdir().expect("temp dir");
        let dropbox = Dropbox::create_in(base.path()).expect("dropbox");
        dropbox.cleanup();
        dropbox.cleanup();
    }

    #[test]
    fn sweeps_what_a_killed_process_left_behind() {
        let base = tempfile::tempdir().expect("temp dir");
        let old = base.path().join("ffweb-drop-999999-aaaaaa");
        let abandoned = base.path().join("ffweb-drop-999998-bbbbbb");
        let ours = base
            .path()
            .join(format!("ffweb-drop-{}-cccccc", std::process::id()));
        let unrelated = base.path().join("someone-elses-data");
        for path in [&old, &abandoned, &ours, &unrelated] {
            std::fs::create_dir_all(path).expect("create");
        }

        let long_ago =
            std::time::SystemTime::now() - STALE_AFTER - std::time::Duration::from_secs(60);
        filetime_set(&old, long_ago);

        sweep_stale(base.path());

        assert!(!old.exists(), "an old directory should be gone");
        // A process killed outright cannot clean up after itself, and waiting a
        // day to notice left the files it copied lying about until then.
        assert!(
            !abandoned.exists() || process_is_alive(999_998) != Some(false),
            "a directory whose owner is gone should not wait for the age rule"
        );
        assert!(ours.exists(), "a running instance keeps its own directory");
        assert!(unrelated.exists(), "nothing else may be touched");
    }

    #[test]
    fn reads_the_owner_out_of_the_name() {
        assert_eq!(owner_of("ffweb-drop-1234-ab12cd"), Some(1234));
        assert_eq!(owner_of("ffweb-drop-1234"), Some(1234));
        assert_eq!(owner_of("someone-elses-data"), None);
        assert_eq!(owner_of("ffweb-drop-notanumber-x"), None);
    }

    /// Backdate a directory, so the sweep sees it as old.
    fn filetime_set(path: &Path, when: std::time::SystemTime) {
        let file = std::fs::File::open(path).expect("open");
        file.set_times(std::fs::FileTimes::new().set_modified(when))
            .expect("set times");
    }
}
