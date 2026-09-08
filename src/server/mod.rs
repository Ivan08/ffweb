//! The HTTP layer.
//!
//! One router, assembled from handlers that each deal with a single thing:
//! [`files`] reaches the disk, [`jobs`] runs ffmpeg, [`wasm`] mirrors the
//! browser engine's core, [`assets`] serves the interface, and [`auth`] keeps
//! other web pages out of all of it.

mod assets;
mod auth;
mod error;
mod files;
mod jobs;
mod wasm;

use anyhow::{Context, Result};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderValue};
use axum::middleware;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tokio::net::TcpListener;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::state::SharedState;
use crate::wasmcache;

pub use assets::dev_dir as dev_assets_dir;
pub use auth::new_token;

/// Dropped files are streamed to disk, but a runaway upload should still stop
/// somewhere. 8 GiB comfortably covers real video.
const MAX_UPLOAD: usize = 8 * 1024 * 1024 * 1024;

pub async fn run(state: SharedState, host: &str, port: u16, open_browser: bool) -> Result<()> {
    let listener = bind(host, port).await?;
    let addr = listener.local_addr()?;

    let url = match &state.token {
        Some(token) => format!("http://{addr}/?token={token}"),
        None => format!("http://{addr}/"),
    };

    println!();
    println!("  ffweb is running at  {url}");
    println!("  engine               {}", state.effective_backend());
    println!("  browsing             {}", state.roots.browse.display());
    println!("  output               {}", state.roots.out.display());
    println!();
    println!("  press Ctrl-C to stop");
    println!();

    if open_browser {
        if let Err(err) = open::that_detached(&url) {
            tracing::warn!("could not open a browser: {err}");
        }
    }

    let shutdown_state = state.clone();
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            println!("\n  stopping — cancelling running jobs");
            shutdown_state.jobs.cancel_all().await;
            shutdown_state.dropbox.cleanup();
        })
        .await
        .context("server error")?;

    Ok(())
}

pub fn router(state: SharedState) -> Router {
    let api = Router::new()
        .route("/capabilities", get(capabilities))
        .route("/fs", get(files::browse))
        .route("/file", get(files::serve_file))
        .route("/files", post(files::receive_file))
        .route("/probe", get(files::probe_file))
        .route("/thumb", get(files::thumb))
        .route("/jobs", get(jobs::list).post(jobs::create))
        .route("/jobs/{id}", get(jobs::view))
        .route("/jobs/{id}/log", get(jobs::log))
        .route("/jobs/{id}/events", get(jobs::events))
        .route("/jobs/{id}/cancel", post(jobs::cancel))
        .route("/wasm/status", get(wasm::status))
        .route("/wasm/fetch", post(wasm::fetch))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD));

    Router::new()
        .nest("/api", api)
        .route("/wasm/{*file}", get(wasm::file))
        .fallback(get(assets::serve))
        .layer(middleware::from_fn_with_state(state.clone(), auth::guard))
        // Cross-origin isolation is what makes `SharedArrayBuffer` — and so the
        // multi-threaded wasm core — available. It has to be on every response,
        // including the core files themselves.
        .layer(always("cross-origin-opener-policy", "same-origin"))
        .layer(always("cross-origin-embedder-policy", "require-corp"))
        .layer(always("cross-origin-resource-policy", "same-origin"))
        .with_state(state)
}

/// A header set on every response, whatever the handler said.
fn always(name: &'static str, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(
        header::HeaderName::from_static(name),
        HeaderValue::from_static(value),
    )
}

/// What the machine can do, so the interface knows what to offer.
async fn capabilities(State(state): State<SharedState>) -> impl IntoResponse {
    let caps = &state.caps;
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "backend": state.effective_backend(),
        "backendLocked": !matches!(state.backend, crate::cli::Backend::Auto),
        "native": {
            "available": caps.has_ffmpeg(),
            "ffprobe": caps.has_ffprobe(),
            "path": caps.ffmpeg_path,
            "version": caps.ffmpeg_version,
            "versionNumber": caps.ffmpeg_version_number,
            "encoders": caps.encoders,
            "decoders": caps.decoders,
            "filters": caps.filters,
            "muxers": caps.muxers,
            "hwaccels": caps.hwaccels,
        },
        "wasm": {
            "coreVersion": wasmcache::CORE_VERSION,
            "cache": state.cache.status(),
        },
        "roots": {
            "browse": state.roots.browse,
            "out": state.roots.out,
        },
        "preload": state.preload,
        "unsafeArgs": state.unsafe_args,
    }))
}

/// Bind the requested port, walking upward when it is taken. Port 0 means "any".
async fn bind(host: &str, port: u16) -> Result<TcpListener> {
    if port == 0 {
        return TcpListener::bind((host, 0))
            .await
            .with_context(|| format!("binding {host}:0"));
    }
    let mut last = None;
    for candidate in port..port.saturating_add(20) {
        match TcpListener::bind((host, candidate)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => last = Some((candidate, err)),
        }
    }
    let (candidate, err) = last.expect("the range is non-empty");
    Err(anyhow::anyhow!(
        "could not bind {host}:{port}..{candidate}: {err}"
    ))
}

/// Wait for the process to be asked to stop.
///
/// Ctrl-C is the obvious one, but a terminal closing or a service manager
/// stopping the process sends SIGTERM, and that path has to run the same
/// cleanup — otherwise the scratch directory for dropped files is left behind.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(err) => {
                tracing::warn!("cannot listen for SIGTERM: {err}");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
