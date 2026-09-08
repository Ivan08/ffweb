//! The same-origin mirror of the ffmpeg.wasm core.
//!
//! Everything the browser engine loads has to be served from here. Browsers
//! refuse to start a cross-origin module worker even when CORS allows the
//! fetch, and a blob URL breaks the core's own relative imports — so the files
//! are cached on disk and handed back from this origin.

use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::error::{server_error, ApiResult};
use crate::state::SharedState;

pub async fn status(State(state): State<SharedState>) -> impl IntoResponse {
    Json(state.cache.status())
}

pub async fn fetch(State(state): State<SharedState>) -> ApiResult<Json<serde_json::Value>> {
    state.cache.fetch_all(false).await?;
    Ok(Json(json!(state.cache.status())))
}

/// Serve a cached core file, downloading it on first use.
pub async fn file(
    State(state): State<SharedState>,
    AxumPath(file): AxumPath<String>,
    request: Request,
) -> ApiResult<Response> {
    let path = state.cache.ensure(&file).await?;
    let content_type = if file.ends_with(".wasm") {
        "application/wasm"
    } else {
        "text/javascript"
    };
    let mut response = ServeFile::new_with_mime(
        path,
        &content_type.parse().expect("a literal media type parses"),
    )
    .oneshot(request)
    .await
    .map(IntoResponse::into_response)
    .map_err(server_error)?;

    // The cache directory is versioned, so these bytes never change.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok(response)
}
