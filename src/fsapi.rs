//! The built-in file browser.
//!
//! The whole application runs on the user's machine, so files are read where
//! they already are — nothing is uploaded and nothing is copied. Dropping a
//! file from a desktop file manager is the one exception: the browser hands us
//! bytes without a path, so those are streamed into the output directory.

use std::path::Path;

use serde::Serialize;

/// Extensions the UI treats as media. Anything else is listed but not selectable.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "avi", "m4v", "mpg", "mpeg", "wmv", "flv", "ts", "m2ts", "ogv",
    "3gp", "gif", "apng", "webp", "png", "jpg", "jpeg", "bmp", "tiff", "mp3", "wav", "flac", "aac",
    "ogg", "opus", "m4a", "wma", "aiff", "srt", "vtt", "ass", "ssa",
];

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the epoch, for sorting by recency.
    pub modified: u64,
    pub is_media: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Listing {
    pub path: String,
    /// Parent directory, or None when at a root boundary.
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

pub fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// List a directory. Hidden entries are skipped; unreadable ones are omitted
/// rather than failing the whole listing.
pub fn list(dir: &Path, boundary: &Path) -> std::io::Result<Listing> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let path = entry.path();
        entries.push(Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            is_media: !meta.is_dir() && is_media(&path),
        });
    }

    // Directories first, then media, then the rest — each alphabetically.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(b.is_media.cmp(&a.is_media))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let parent = (dir != boundary)
        .then(|| dir.parent())
        .flatten()
        .filter(|p| p.starts_with(boundary))
        .map(|p| p.to_string_lossy().into_owned());

    Ok(Listing {
        path: dir.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

/// Strip any directory component a browser might send along with a file name.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '\0' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "dropped-file".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, bytes).expect("write");
    }

    #[test]
    fn strips_any_directory_a_browser_sends_with_a_name() {
        assert_eq!(sanitize_name("clip.mp4"), "clip.mp4");
        assert_eq!(sanitize_name("/etc/passwd"), "passwd");
        assert_eq!(sanitize_name("../../escape.mp4"), "escape.mp4");
        assert_eq!(sanitize_name("C:\\Users\\me\\clip.mp4"), "clip.mp4");
    }

    #[test]
    fn keeps_names_that_are_not_latin() {
        assert_eq!(sanitize_name("отпуск.mp4"), "отпуск.mp4");
        assert_eq!(sanitize_name("休暇.mp4"), "休暇.mp4");
    }

    #[test]
    fn substitutes_a_name_that_would_be_no_name_at_all() {
        for awkward in ["", ".", "..", "/", "???"] {
            let cleaned = sanitize_name(awkward);
            assert!(!cleaned.is_empty(), "`{awkward}` produced an empty name");
            assert_ne!(cleaned, ".");
            assert_ne!(cleaned, "..");
        }
    }

    #[test]
    fn recognises_media_by_extension_whatever_its_case() {
        assert!(is_media(Path::new("a.mp4")));
        assert!(is_media(Path::new("a.MP4")));
        assert!(is_media(Path::new("a.SrT")));
        assert!(!is_media(Path::new("a.txt")));
        assert!(!is_media(Path::new("noextension")));
    }

    #[test]
    fn lists_directories_first_then_media_then_the_rest() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        write(&root.join("zebra.mp4"), b"video");
        write(&root.join("notes.txt"), b"text");
        write(&root.join("apple.mp4"), b"video");
        std::fs::create_dir(root.join("sub")).expect("create dir");

        let listing = list(root, root).expect("listing");
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "apple.mp4", "zebra.mp4", "notes.txt"]);
        assert!(listing.entries[0].is_dir);
        assert!(listing.entries[1].is_media);
        assert!(!listing.entries[3].is_media);
    }

    #[test]
    fn hides_dotfiles_and_offers_a_parent_only_inside_the_boundary() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        write(&root.join(".hidden"), b"x");
        std::fs::create_dir(root.join("sub")).expect("create dir");

        let top = list(root, root).expect("listing");
        assert!(top.entries.iter().all(|e| e.name != ".hidden"));
        // At the boundary there is nowhere further up to go.
        assert!(top.parent.is_none());

        let inner = list(&root.join("sub"), root).expect("listing");
        assert_eq!(
            inner.parent.as_deref(),
            Some(root.to_string_lossy().as_ref())
        );
    }
}
