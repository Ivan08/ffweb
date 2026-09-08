//! One way of reporting a refusal.
//!
//! Handlers return `ApiResult`, so a failure reaches the browser as JSON with a
//! sentence in it rather than an empty 500 — the interface shows that sentence
//! verbatim, and it is usually the only explanation the user gets.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError(StatusCode::BAD_REQUEST, message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError(StatusCode::NOT_FOUND, message.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    /// Anything that failed while preparing a request is the request's fault
    /// until shown otherwise; the message carries the detail.
    fn from(err: anyhow::Error) -> Self {
        ApiError(StatusCode::BAD_REQUEST, format!("{err:#}"))
    }
}

/// For failures that are the server's own, not the caller's.
pub fn server_error(err: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;
