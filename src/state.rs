//! Shared server state.

use std::path::PathBuf;
use std::sync::Arc;

use crate::caps::Capabilities;
use crate::cli::Backend;
use crate::dropbox::Dropbox;
use crate::jobs::JobStore;
use crate::paths::Roots;
use crate::thumbs::ThumbCache;
use crate::wasmcache::WasmCache;

pub struct AppState {
    pub caps: Arc<Capabilities>,
    pub cache: WasmCache,
    /// Scratch space for dropped files, wiped when the process exits.
    pub dropbox: Dropbox,
    pub thumbs: ThumbCache,
    pub jobs: JobStore,
    pub roots: Roots,
    pub backend: Backend,
    pub unsafe_args: bool,
    /// Access token guarding the API, or None when --no-token was given.
    pub token: Option<String>,
    /// Files named on the command line, preloaded into the UI.
    pub preload: Vec<PathBuf>,
    /// Serve the frontend from disk instead of the embedded copy.
    pub dev_assets: Option<PathBuf>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    /// Which engine the UI should default to.
    pub fn effective_backend(&self) -> &'static str {
        match self.backend {
            Backend::Native => "native",
            Backend::Wasm => "wasm",
            Backend::Auto => {
                if self.caps.has_ffmpeg() {
                    "native"
                } else {
                    "wasm"
                }
            }
        }
    }
}
