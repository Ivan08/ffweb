//! The interface itself, baked into the binary.

use std::path::PathBuf;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::state::SharedState;

/// The built frontend. The path is relative to the crate root.
#[derive(rust_embed::Embed)]
#[folder = "assets/dist"]
struct Assets;

pub async fn serve(State(state): State<SharedState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // In development the frontend is read from disk, so Vite's output can be
    // refreshed without rebuilding the binary.
    if let Some(dir) = &state.dev_assets {
        if let Ok(bytes) = std::fs::read(dir.join(path)) {
            return respond(path, bytes);
        }
        if let Ok(bytes) = std::fs::read(dir.join("index.html")) {
            return respond("index.html", bytes);
        }
    }

    if let Some(file) = Assets::get(path) {
        return respond(path, file.data.into_owned());
    }
    // Single-page app: an unknown route renders the shell.
    if let Some(file) = Assets::get("index.html") {
        return respond("index.html", file.data.into_owned());
    }

    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "ffweb: the frontend was not built into this binary.\n\
         Build it with `npm --prefix web ci && npm --prefix web run build`.",
    )
        .into_response()
}

fn respond(path: &str, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path == "index.html" {
        "no-cache"
    } else {
        // Vite fingerprints asset file names, so they are safe to pin forever.
        "public, max-age=31536000, immutable"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        Body::from(bytes),
    )
        .into_response()
}

/// Serve the interface from disk in a debug build, so a rebuilt bundle shows up
/// without recompiling.
pub fn dev_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/dist");
    (cfg!(debug_assertions) && dir.is_dir()).then_some(dir)
}
