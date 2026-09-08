//! Turning client-supplied paths into real paths we are willing to touch.
//!
//! The browser only ever sends paths relative to one of the configured roots.
//! Everything goes through [`Roots::resolve`], which canonicalises and then
//! checks containment, so `..` and symlinks cannot escape.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};

#[derive(Debug, Clone)]
pub struct Roots {
    /// Directory the file browser walks; also where inputs normally live.
    pub browse: PathBuf,
    /// Directory finished files are written to.
    pub out: PathBuf,
    /// Temporary home for dropped files that were not found on disk.
    pub drop: PathBuf,
}

impl Roots {
    pub fn new(browse: PathBuf, out: PathBuf, drop: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&browse)?;
        std::fs::create_dir_all(&out)?;
        std::fs::create_dir_all(&drop)?;
        Ok(Self {
            browse: canonical(&browse)?,
            out: canonical(&out)?,
            drop: canonical(&drop)?,
        })
    }

    fn all(&self) -> [&Path; 3] {
        [
            self.browse.as_path(),
            self.out.as_path(),
            self.drop.as_path(),
        ]
    }

    /// Resolve a client path for reading. The path may be absolute (as returned
    /// by the file browser) or relative to the browse root.
    pub fn resolve(&self, raw: &str) -> Result<PathBuf> {
        let candidate = as_candidate(raw, &self.browse);
        let resolved = canonical(&candidate)?;
        self.assert_contained(&resolved)?;
        Ok(resolved)
    }

    /// Resolve a path for writing, refusing to land on a file that is already
    /// there: `result.mp4` becomes `result-2.mp4`, then `result-3.mp4`.
    ///
    /// The client cannot do this for itself. It only knows the results of the
    /// current session, so clearing the workspace and running the same job
    /// again used to reuse the name — and `ffmpeg -y` overwrote yesterday's
    /// export without a word. The server is the only party that can see the
    /// directory, so the server picks the name and hands it back.
    pub fn resolve_new_unique(&self, raw: &str) -> Result<PathBuf> {
        let candidate = self.resolve_new(raw)?;
        if !candidate.exists() {
            return Ok(candidate);
        }

        let parent = candidate.parent().unwrap_or(&self.out).to_path_buf();
        let name = candidate.file_name().unwrap_or_default().to_string_lossy();
        let (stem, extension) = match name.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
            _ => (name.as_ref(), String::new()),
        };

        for suffix in 2..10_000 {
            let attempt = parent.join(format!("{stem}-{suffix}{extension}"));
            if !attempt.exists() {
                return Ok(attempt);
            }
        }
        anyhow::bail!("could not find a free name next to `{raw}`")
    }

    /// Resolve a path for writing. The file need not exist yet, so containment
    /// is checked against the deepest existing ancestor.
    pub fn resolve_new(&self, raw: &str) -> Result<PathBuf> {
        let candidate = as_candidate(raw, &self.out);
        let parent = candidate
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.out.clone());
        std::fs::create_dir_all(&parent)?;
        let parent = canonical(&parent)?;
        self.assert_contained(&parent)?;
        let name = candidate
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("`{raw}` has no file name"))?;
        Ok(parent.join(name))
    }

    fn assert_contained(&self, path: &Path) -> Result<()> {
        if self.all().iter().any(|root| path.starts_with(root)) {
            return Ok(());
        }
        bail!(
            "`{}` is outside the allowed directories ({}, {} and {})",
            path.display(),
            self.browse.display(),
            self.out.display(),
            self.drop.display()
        )
    }
}

fn as_candidate(raw: &str, base: &Path) -> PathBuf {
    let raw = Path::new(raw);
    if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        base.join(raw)
    }
}

/// `std::fs::canonicalize` requires the path to exist; for anything that does
/// we use it, and otherwise we normalise `.`/`..` lexically.
fn canonical(path: &Path) -> Result<PathBuf> {
    if let Ok(real) = std::fs::canonicalize(path) {
        return Ok(real);
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    if out.as_os_str().is_empty() {
        bail!("`{}` resolves to an empty path", path.display());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox {
        _dir: tempfile::TempDir,
        roots: Roots,
        browse: PathBuf,
        out: PathBuf,
        outside: PathBuf,
    }

    /// A browse root, an output root and a directory outside both of them.
    fn sandbox() -> Sandbox {
        let dir = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical base");
        let browse = base.join("browse");
        let out = base.join("out");
        let drop = base.join("drop");
        let outside = base.join("outside");
        for path in [&browse, &out, &drop, &outside] {
            std::fs::create_dir_all(path).expect("create dir");
        }
        std::fs::write(browse.join("clip.mp4"), b"video").expect("write");
        std::fs::write(outside.join("secret.txt"), b"secret").expect("write");

        let roots = Roots::new(browse.clone(), out.clone(), drop).expect("roots");
        Sandbox {
            _dir: dir,
            roots,
            browse,
            out,
            outside,
        }
    }

    #[test]
    fn resolves_a_file_inside_the_browse_root() {
        let sandbox = sandbox();
        let resolved = sandbox.roots.resolve("clip.mp4").expect("relative name");
        assert_eq!(resolved, sandbox.browse.join("clip.mp4"));

        let absolute = sandbox.browse.join("clip.mp4");
        let resolved = sandbox
            .roots
            .resolve(&absolute.to_string_lossy())
            .expect("absolute path inside the root");
        assert_eq!(resolved, absolute);
    }

    #[test]
    fn refuses_a_path_outside_every_root() {
        let sandbox = sandbox();
        let outside = sandbox.outside.join("secret.txt");
        assert!(sandbox.roots.resolve(&outside.to_string_lossy()).is_err());
        assert!(sandbox.roots.resolve("/etc/passwd").is_err());
    }

    #[test]
    fn refuses_to_climb_out_with_dot_dot() {
        let sandbox = sandbox();
        for attempt in [
            "../outside/secret.txt",
            "../../etc/passwd",
            "./../outside/secret.txt",
            "sub/../../outside/secret.txt",
        ] {
            assert!(
                sandbox.roots.resolve(attempt).is_err(),
                "`{attempt}` escaped the browse root"
            );
        }
    }

    #[test]
    fn allows_dot_dot_that_stays_inside() {
        let sandbox = sandbox();
        std::fs::create_dir_all(sandbox.browse.join("sub")).expect("create sub");
        let resolved = sandbox
            .roots
            .resolve("sub/../clip.mp4")
            .expect("stays inside");
        assert_eq!(resolved, sandbox.browse.join("clip.mp4"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_points_outside() {
        let sandbox = sandbox();
        // Containment is checked after canonicalisation, so a link cannot be
        // used to smuggle a path past it.
        std::os::unix::fs::symlink(
            sandbox.outside.join("secret.txt"),
            sandbox.browse.join("link"),
        )
        .expect("symlink");
        assert!(sandbox.roots.resolve("link").is_err());
    }

    #[test]
    fn does_not_treat_a_name_prefix_as_containment() {
        let dir = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical");
        let browse = base.join("root");
        // `root-evil` starts with `root`; a plain string comparison would let
        // it through.
        let sibling = base.join("root-evil");
        std::fs::create_dir_all(&browse).expect("create");
        std::fs::create_dir_all(&sibling).expect("create");
        std::fs::write(sibling.join("secret.txt"), b"secret").expect("write");

        let roots = Roots::new(browse, base.join("out"), base.join("drop")).expect("roots");
        let target = sibling.join("secret.txt");
        assert!(roots.resolve(&target.to_string_lossy()).is_err());
    }

    #[test]
    fn resolves_a_new_file_under_the_output_root() {
        let sandbox = sandbox();
        let resolved = sandbox.roots.resolve_new("result.mp4").expect("new file");
        assert_eq!(resolved, sandbox.out.join("result.mp4"));
        assert!(!resolved.exists(), "resolving must not create the file");
    }

    #[test]
    fn creates_the_parent_of_a_new_file() {
        let sandbox = sandbox();
        let resolved = sandbox
            .roots
            .resolve_new("nested/deeper/result.mp4")
            .expect("nested");
        assert_eq!(resolved, sandbox.out.join("nested/deeper/result.mp4"));
        assert!(resolved.parent().expect("parent").is_dir());
    }

    #[test]
    fn steps_around_a_file_that_is_already_there() {
        let sandbox = sandbox();
        let first = sandbox
            .roots
            .resolve_new_unique("result.mp4")
            .expect("first");
        std::fs::write(&first, b"x").expect("write");

        let second = sandbox
            .roots
            .resolve_new_unique("result.mp4")
            .expect("second");
        assert_ne!(first, second, "the existing file must not be reused");
        assert_eq!(second.file_name().unwrap(), "result-2.mp4");

        std::fs::write(&second, b"x").expect("write");
        let third = sandbox
            .roots
            .resolve_new_unique("result.mp4")
            .expect("third");
        assert_eq!(third.file_name().unwrap(), "result-3.mp4");
    }

    #[test]
    fn keeps_a_name_that_is_free() {
        let sandbox = sandbox();
        let resolved = sandbox
            .roots
            .resolve_new_unique("fresh.mp4")
            .expect("new file");
        assert_eq!(resolved.file_name().unwrap(), "fresh.mp4");
    }

    #[test]
    fn steps_around_a_name_with_no_extension() {
        let sandbox = sandbox();
        let first = sandbox.roots.resolve_new_unique("result").expect("first");
        std::fs::write(&first, b"x").expect("write");
        let second = sandbox.roots.resolve_new_unique("result").expect("second");
        assert_eq!(second.file_name().unwrap(), "result-2");
    }

    #[test]
    fn refuses_to_write_outside_every_root() {
        let sandbox = sandbox();
        let target = sandbox.outside.join("planted.mp4");
        assert!(sandbox
            .roots
            .resolve_new(&target.to_string_lossy())
            .is_err());
        assert!(sandbox.roots.resolve_new("../outside/planted.mp4").is_err());
        assert!(sandbox.roots.resolve_new("/tmp/planted.mp4").is_err());
        assert!(!target.exists(), "a refused write must not create anything");
    }

    #[test]
    fn refuses_a_target_with_no_file_name() {
        let sandbox = sandbox();
        assert!(sandbox.roots.resolve_new("/").is_err());
    }

    #[test]
    fn accepts_the_scratch_directory_as_a_root() {
        let dir = tempfile::tempdir().expect("temp dir");
        let base = std::fs::canonicalize(dir.path()).expect("canonical");
        let drop = base.join("drop");
        std::fs::create_dir_all(&drop).expect("create");
        std::fs::write(drop.join("dropped.mp4"), b"video").expect("write");

        let roots = Roots::new(base.join("browse"), base.join("out"), drop.clone()).expect("roots");
        // A dropped file lives outside both the browse and output roots, and
        // still has to be readable.
        let target = drop.join("dropped.mp4");
        assert_eq!(
            roots
                .resolve(&target.to_string_lossy())
                .expect("scratch file"),
            target
        );
    }
}
