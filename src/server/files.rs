//! Reaching the machine's own filesystem: browsing it, reading from it,
//! describing what is in it, and the one case where bytes get copied.

use axum::extract::{Multipart, Query, Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::error::{server_error, ApiError, ApiResult};
use crate::state::SharedState;
use crate::{fsapi, probe, thumbs};

#[derive(Deserialize)]
pub struct PathQuery {
    path: Option<String>,
}

impl PathQuery {
    fn required(&self) -> ApiResult<&str> {
        self.path
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| ApiError::bad_request("missing path"))
    }
}

pub async fn browse(
    State(state): State<SharedState>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Json<fsapi::Listing>> {
    let dir = match query.path.as_deref() {
        Some(path) if !path.is_empty() => state.roots.resolve(path)?,
        _ => state.roots.browse.clone(),
    };
    if !dir.is_dir() {
        return Err(ApiError::bad_request(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    Ok(Json(
        fsapi::list(&dir, &state.roots.browse).map_err(server_error)?,
    ))
}

/// Serve a media file for preview or download.
///
/// Range support is not optional: `<video>` seeks with range requests, and
/// without them scrubbing is broken.
pub async fn serve_file(
    State(state): State<SharedState>,
    Query(query): Query<PathQuery>,
    request: Request,
) -> ApiResult<Response> {
    let path = state.roots.resolve(query.required()?)?;
    if !path.is_file() {
        return Err(ApiError::not_found(format!(
            "{} is not a file",
            path.display()
        )));
    }
    ServeFile::new(path)
        .oneshot(request)
        .await
        .map(IntoResponse::into_response)
        .map_err(server_error)
}

/// Accept a file dropped from a desktop file manager.
///
/// A browser will not say where a dropped file came from, so its bytes are all
/// there is to work with. They go to the scratch directory, which is deleted
/// when the process exits. Opening the same file through the file browser
/// instead reads it in place, with no copy at all.
pub async fn receive_file(
    State(state): State<SharedState>,
    mut multipart: Multipart,
) -> ApiResult<Json<serde_json::Value>> {
    let mut written = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(server_error)? {
        let Some(name) = field.file_name().map(fsapi::sanitize_name) else {
            continue;
        };
        let dest = state
            .roots
            .resolve_new(&state.dropbox.dir().join(&name).to_string_lossy())?;
        let bytes = field.bytes().await.map_err(server_error)?;
        tokio::fs::write(&dest, &bytes)
            .await
            .map_err(server_error)?;
        written.push(json!({
            "name": name,
            "path": dest.to_string_lossy(),
            "size": bytes.len(),
        }));
    }
    Ok(Json(json!({ "files": written })))
}

pub async fn probe_file(
    State(state): State<SharedState>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Json<probe::MediaInfo>> {
    let path = state.roots.resolve(query.required()?)?;
    let ffprobe = probe::require(&state.caps.ffprobe_path, "ffprobe")?;
    Ok(Json(probe::probe(ffprobe, &path).await?))
}

/// The sound of a file, as one number per slice of it.
///
/// Named at length on purpose. The access token is spelled `token` and the
/// frame position is `t`, and those two have been confused once already — a
/// short name here would be a third thing to mistake for either.
#[derive(Deserialize)]
pub struct PeaksQuery {
    path: String,
    /// How many slices to divide the sound into.
    #[serde(default)]
    buckets: Option<u32>,
    /// Seconds into the file to start, and to stop.
    #[serde(default)]
    from: Option<f64>,
    #[serde(default)]
    to: Option<f64>,
}

pub async fn peaks(
    State(state): State<SharedState>,
    Query(query): Query<PeaksQuery>,
) -> ApiResult<Response> {
    let path = state.roots.resolve(&query.path)?;
    // Enough to draw a wide track, few enough that the reply stays small.
    let buckets = query.buckets.unwrap_or(2000).clamp(64, 4000);
    let from = query.from.unwrap_or(0.0).max(0.0);
    let to = query.to.filter(|end| *end > from);

    let key = thumbs::peaks_key(buckets, from, to);
    let json = match state.peaks.get(&path, &key) {
        Some(cached) => cached,
        None => {
            let ffmpeg = probe::require(&state.caps.ffmpeg_path, "ffmpeg")?;
            let _permit = state.sidework.acquire().await.map_err(server_error)?;
            let measured = probe::peaks(ffmpeg, &path, buckets as usize, from, to).await?;
            let fresh = serde_json::to_vec(&measured).map_err(server_error)?;
            state.peaks.put(&path, &key, &fresh);
            fresh
        }
    };

    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        json,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct ThumbQuery {
    path: String,
    /// Position in seconds.
    #[serde(default)]
    t: Option<f64>,
    /// Width in pixels.
    #[serde(default)]
    w: Option<u32>,
}

pub async fn thumb(
    State(state): State<SharedState>,
    Query(query): Query<ThumbQuery>,
) -> ApiResult<Response> {
    let path = state.roots.resolve(&query.path)?;
    let width = query.w.unwrap_or(640).clamp(16, 4096);
    let at = query.t.unwrap_or(0.0).max(0.0);

    // Zooming the timeline asks for a whole row of frames at once, and the same
    // positions come back as soon as the view returns. Extracting them again
    // every time is what made zooming slow.
    let key = thumbs::frame_key(at, width);
    let jpeg = match state.thumbs.get(&path, &key) {
        Some(cached) => cached,
        None => {
            let ffmpeg = probe::require(&state.caps.ffmpeg_path, "ffmpeg")?;
            // Extracting a frame is an ffmpeg run outside the job queue, so it
            // takes a permit of its own rather than competing with an encode.
            let _permit = state.sidework.acquire().await.map_err(server_error)?;
            let fresh = probe::thumbnail(ffmpeg, &path, at, width).await?;
            state.thumbs.put(&path, &key, &fresh);
            fresh
        }
    };

    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            // Frames are addressed by path, time and width, so the browser can
            // keep them for the session and never ask twice.
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        jpeg,
    )
        .into_response())
}
