//! Download and cache the ffmpeg.wasm core so the binary stays self-contained.
//!
//! Only the *core* is fetched at runtime — the `@ffmpeg/ffmpeg` JS wrapper is
//! bundled into our own frontend by Vite. The core is the ~31 MB part, and it
//! must be served same-origin: browsers refuse cross-origin module workers, and
//! blob URLs break the core's own relative imports.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Version of `@ffmpeg/core` and `@ffmpeg/core-mt` we pin to. Both packages are
/// released together and must match the `@ffmpeg/ffmpeg` version in web/package.json.
pub const CORE_VERSION: &str = "0.12.10";

const CDN: &str = "https://cdn.jsdelivr.net/npm";

/// A single file we mirror into the cache.
#[derive(Debug, Clone, Copy)]
pub struct CoreFile {
    /// Path under the cache version directory, also the URL path under `/wasm/`.
    pub name: &'static str,
    /// npm package the file comes from.
    pub package: &'static str,
    /// Path inside that package.
    pub path: &'static str,
    /// Whether this file must start with the WebAssembly magic number.
    pub is_wasm: bool,
}

/// Single-threaded core: the universal fallback. Works without cross-origin
/// isolation, so it is what we serve when `crossOriginIsolated` is false.
pub const ST_FILES: &[CoreFile] = &[
    CoreFile {
        name: "st/ffmpeg-core.js",
        package: "@ffmpeg/core",
        path: "dist/esm/ffmpeg-core.js",
        is_wasm: false,
    },
    CoreFile {
        name: "st/ffmpeg-core.wasm",
        package: "@ffmpeg/core",
        path: "dist/esm/ffmpeg-core.wasm",
        is_wasm: true,
    },
];

/// Multi-threaded core: much faster, but needs SharedArrayBuffer, which is why
/// the server sets COOP/COEP on every response.
pub const MT_FILES: &[CoreFile] = &[
    CoreFile {
        name: "mt/ffmpeg-core.js",
        package: "@ffmpeg/core-mt",
        path: "dist/esm/ffmpeg-core.js",
        is_wasm: false,
    },
    CoreFile {
        name: "mt/ffmpeg-core.wasm",
        package: "@ffmpeg/core-mt",
        path: "dist/esm/ffmpeg-core.wasm",
        is_wasm: true,
    },
    CoreFile {
        name: "mt/ffmpeg-core.worker.js",
        package: "@ffmpeg/core-mt",
        path: "dist/esm/ffmpeg-core.worker.js",
        is_wasm: false,
    },
];

pub fn all_files() -> impl Iterator<Item = &'static CoreFile> {
    ST_FILES.iter().chain(MT_FILES.iter())
}

fn find_file(name: &str) -> Option<&'static CoreFile> {
    all_files().find(|f| f.name == name)
}

#[derive(Debug, Clone)]
pub struct WasmCache {
    root: PathBuf,
    offline: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CacheStatus {
    pub dir: PathBuf,
    pub version: String,
    pub offline: bool,
    /// Both variants fully present?
    pub st_ready: bool,
    pub mt_ready: bool,
    pub bytes: u64,
    pub missing: Vec<String>,
}

impl WasmCache {
    pub fn new(offline: bool) -> Result<Self> {
        let base = directories::ProjectDirs::from("", "", "ffmpeg-webrust")
            .map(|d| d.cache_dir().to_path_buf())
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache/ffmpeg-webrust"))
            })
            .ok_or_else(|| anyhow!("cannot determine a cache directory"))?;
        Ok(Self {
            root: base.join("wasm").join(CORE_VERSION),
            offline,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.root
    }

    pub fn path_of(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn status(&self) -> CacheStatus {
        let mut bytes = 0;
        let mut missing = Vec::new();
        for f in all_files() {
            let path = self.path_of(f.name);
            match std::fs::metadata(&path) {
                Ok(m) if m.len() > 0 && is_usable(&path, f.is_wasm) => bytes += m.len(),
                _ => missing.push(f.name.to_string()),
            }
        }
        CacheStatus {
            dir: self.root.clone(),
            version: CORE_VERSION.to_string(),
            offline: self.offline,
            st_ready: ST_FILES
                .iter()
                .all(|f| !missing.contains(&f.name.to_string())),
            mt_ready: MT_FILES
                .iter()
                .all(|f| !missing.contains(&f.name.to_string())),
            bytes,
            missing,
        }
    }

    /// Return the on-disk path for a cached file, downloading it if needed.
    pub async fn ensure(&self, name: &str) -> Result<PathBuf> {
        let file = find_file(name).ok_or_else(|| anyhow!("unknown core file: {name}"))?;
        let dest = self.path_of(file.name);
        if is_usable(&dest, file.is_wasm) {
            return Ok(dest);
        }
        self.download(file).await?;
        Ok(dest)
    }

    /// Download the cores. The multi-threaded build is skipped unless asked for:
    /// it is another 32 MB and the browser only loads it on request, because the
    /// published 0.12.10 multi-threaded core stalls on ordinary jobs.
    pub async fn fetch_all(&self, include_mt: bool) -> Result<()> {
        for file in all_files() {
            if !include_mt && file.name.starts_with("mt/") {
                continue;
            }
            if is_usable(&self.path_of(file.name), file.is_wasm) {
                continue;
            }
            self.download(file).await?;
        }
        Ok(())
    }

    async fn download(&self, file: &CoreFile) -> Result<()> {
        // Checked here rather than at each call site: this is the only place
        // that touches the network, so it is the only place that can promise
        // --offline means what it says.
        if self.offline {
            bail!(
                "{} is not cached and --offline was given; run `ffweb cache fetch` with network access",
                file.name
            );
        }

        let url = format!("{CDN}/{}@{CORE_VERSION}/{}", file.package, file.path);
        tracing::info!("downloading {url}");

        let client = reqwest::Client::builder()
            .user_agent(concat!("ffmpeg-webrust/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let resp = client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        let resp = resp
            .error_for_status()
            .with_context(|| format!("GET {url}"))?;
        let body = resp
            .bytes()
            .await
            .with_context(|| format!("reading body of {url}"))?;

        if body.is_empty() {
            bail!("{url} returned an empty body");
        }
        // A truncated or HTML-error response is the failure mode that actually
        // happens with CDNs, and it produces a baffling error much later, so
        // reject it right here.
        if file.is_wasm && !body.starts_with(b"\0asm") {
            bail!("{url} does not look like a WebAssembly module");
        }

        let dest = self.path_of(file.name);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        // Write to a temporary file and rename, so a killed process can never
        // leave a half-written core that later looks cached. The suffix is
        // appended rather than substituted: `ffmpeg-core.js` and
        // `ffmpeg-core.wasm` live in the same directory and `with_extension`
        // would give both of them the same temporary name.
        let tmp = append_suffix(&dest, ".part");
        std::fs::write(&tmp, &body).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &dest)
            .with_context(|| format!("renaming into {}", dest.display()))?;

        let digest = Sha256::digest(&body);
        std::fs::write(append_suffix(&dest, ".sha256"), hex(&digest)).ok();
        tracing::info!("cached {} ({} bytes)", file.name, body.len());
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root)
                .with_context(|| format!("removing {}", self.root.display()))?;
        }
        Ok(())
    }
}

/// Append to a file name instead of replacing its extension.
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// A cached file counts only if it is non-empty and, for the core module, still
/// starts with the WebAssembly magic number. A truncated cache is the failure
/// that otherwise surfaces as an inscrutable error inside the browser.
fn is_usable(path: &Path, is_wasm: bool) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() == 0 {
        return false;
    }
    if !is_wasm {
        return true;
    }
    read_magic(path)
        .map(|magic| magic == *b"\0asm")
        .unwrap_or(false)
}

fn read_magic(path: &Path) -> Option<[u8; 4]> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).ok()?;
    Some(magic)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_a_suffix_rather_than_replacing_the_extension() {
        // `ffmpeg-core.js` and `ffmpeg-core.wasm` share a directory, and
        // `with_extension` would give both the same temporary and checksum
        // names — one download would then overwrite the other's.
        let js = append_suffix(Path::new("/cache/ffmpeg-core.js"), ".part");
        let wasm = append_suffix(Path::new("/cache/ffmpeg-core.wasm"), ".part");
        assert_eq!(js, PathBuf::from("/cache/ffmpeg-core.js.part"));
        assert_ne!(js, wasm);
    }

    #[test]
    fn treats_a_truncated_core_as_not_cached() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("ffmpeg-core.wasm");

        std::fs::write(&path, b"").expect("write");
        assert!(!is_usable(&path, true), "an empty file is not a core");

        // A CDN error page saved under the right name is the failure that
        // actually happens, and it surfaces much later as a baffling error.
        std::fs::write(&path, b"<!doctype html><html>404").expect("write");
        assert!(!is_usable(&path, true));

        std::fs::write(&path, b"\0asm\x01\0\0\0").expect("write");
        assert!(
            is_usable(&path, true),
            "a real module starts with the magic"
        );
    }

    #[test]
    fn only_checks_the_magic_number_for_the_module_itself() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("ffmpeg-core.js");
        std::fs::write(&path, b"var createFFmpegCore = ...").expect("write");
        assert!(is_usable(&path, false));
        assert!(!is_usable(&path, true));
    }

    #[test]
    fn treats_a_missing_file_as_not_cached() {
        assert!(!is_usable(Path::new("/nonexistent/ffmpeg-core.wasm"), true));
    }

    #[test]
    fn knows_which_files_belong_to_which_variant() {
        let names: Vec<&str> = all_files().map(|file| file.name).collect();
        assert!(names.contains(&"st/ffmpeg-core.js"));
        assert!(names.contains(&"st/ffmpeg-core.wasm"));
        assert!(names.contains(&"mt/ffmpeg-core.worker.js"));
        // Only the module itself is checked for the magic number.
        for file in all_files() {
            assert_eq!(file.is_wasm, file.name.ends_with(".wasm"), "{}", file.name);
        }
    }

    #[test]
    fn refuses_to_reach_the_network_when_offline() {
        let cache = WasmCache {
            root: PathBuf::from("/nonexistent"),
            offline: true,
        };
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(cache.ensure("st/ffmpeg-core.js"))
            .expect_err("offline must refuse");
        assert!(format!("{error:#}").contains("--offline"));
    }

    #[test]
    fn reports_an_empty_cache_as_missing_everything() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = WasmCache {
            root: dir.path().to_path_buf(),
            offline: false,
        };
        let status = cache.status();
        assert!(!status.st_ready);
        assert!(!status.mt_ready);
        assert_eq!(status.bytes, 0);
        assert_eq!(status.missing.len(), all_files().count());
    }

    #[test]
    fn reports_a_populated_variant_as_ready() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = WasmCache {
            root: dir.path().to_path_buf(),
            offline: false,
        };
        for file in ST_FILES {
            let path = cache.path_of(file.name);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("create");
            std::fs::write(
                &path,
                if file.is_wasm {
                    &b"\0asm\x01\0\0\0"[..]
                } else {
                    b"core"
                },
            )
            .expect("write");
        }
        let status = cache.status();
        assert!(status.st_ready);
        assert!(!status.mt_ready, "the multi-threaded core is opt-in");
        assert!(status.bytes > 0);
    }

    #[test]
    fn rejects_a_file_it_does_not_know_about() {
        let cache = WasmCache {
            root: PathBuf::from("/nonexistent"),
            offline: false,
        };
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(cache.ensure("../../etc/passwd"))
            .expect_err("unknown names must be refused");
        assert!(format!("{error:#}").contains("unknown core file"));
    }
}
