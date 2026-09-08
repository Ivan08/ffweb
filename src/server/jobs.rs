//! Submitting work, watching it, and stopping it.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;

use super::error::{ApiError, ApiResult};
use crate::jobs::{JobEvent, JobRequest, JobView};
use crate::state::SharedState;
use crate::{native, validate};

pub async fn list(State(state): State<SharedState>) -> impl IntoResponse {
    Json(state.jobs.list().await)
}

#[derive(Serialize)]
pub struct CreatedJob {
    id: String,
    /// The command as it will be run, so the interface can show what happened.
    command: Vec<String>,
    output: String,
}

/// Accept a job from the interface.
///
/// The arguments are composed in the browser, so this is where they are checked:
/// placeholders only, resolved against the directories the server is willing to
/// touch, and substituted here rather than there.
pub async fn create(
    State(state): State<SharedState>,
    Json(request): Json<JobRequest>,
) -> ApiResult<Json<CreatedJob>> {
    if !state.caps.has_ffmpeg() {
        return Err(ApiError(
            axum::http::StatusCode::PRECONDITION_FAILED,
            "no ffmpeg binary on this machine; use the browser engine".into(),
        ));
    }

    let checked = validate::validate(&request.args, state.unsafe_args)?;
    if request.inputs.len() < checked.input_count {
        return Err(ApiError::bad_request(format!(
            "arguments reference {} input(s) but {} were given",
            checked.input_count,
            request.inputs.len()
        )));
    }

    let mut inputs = Vec::with_capacity(request.inputs.len());
    for raw in &request.inputs {
        let path = state.roots.resolve(raw)?;
        if !path.is_file() {
            return Err(ApiError::bad_request(format!(
                "{} is not a file",
                path.display()
            )));
        }
        inputs.push(path.to_string_lossy().into_owned());
    }

    let output = state.roots.resolve_new_unique(&request.output)?;
    let output_string = output.to_string_lossy().into_owned();

    let mut command = native::base_args();
    command.extend(validate::substitute(
        &request.args,
        &inputs,
        &output_string,
    )?);

    let label = request.label.clone().unwrap_or_else(|| {
        output
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "job".into())
    });

    let id = state
        .jobs
        .submit(
            label,
            request.inputs.clone(),
            output,
            command.clone(),
            request.duration,
        )
        .await;

    Ok(Json(CreatedJob {
        id,
        command,
        output: output_string,
    }))
}

pub async fn view(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<JobView>> {
    state
        .jobs
        .view(&id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("no job {id}")))
}

pub async fn log(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<Vec<String>>> {
    state
        .jobs
        .log(&id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("no job {id}")))
}

pub async fn cancel(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let canceled = state.jobs.cancel(&id).await;
    Ok(Json(json!({ "canceled": canceled })))
}

/// Stream a job's progress and log.
///
/// The log so far and the current state are replayed first, so a client that
/// connects late still sees everything that happened.
pub async fn events(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Sse<impl Stream<Item = std::result::Result<Event, Infallible>>>> {
    let (view, log, receiver) = state
        .jobs
        .subscribe(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("no job {id}")))?;

    let mut replay: VecDeque<JobEvent> =
        log.into_iter().map(|line| JobEvent::Log { line }).collect();
    replay.push_back(JobEvent::State {
        state: view.state,
        error: view.error.clone(),
    });

    // The stream must end as soon as the terminal state has been *sent*, not
    // when the next event arrives — after a job finishes there is no next
    // event, and the client's EventSource would hang open and then reconnect.
    let stream = futures::stream::unfold(
        (replay, Some(receiver)),
        |(mut queue, mut receiver)| async move {
            loop {
                if let Some(event) = queue.pop_front() {
                    if matches!(&event, JobEvent::State { state, .. } if state.is_terminal()) {
                        receiver = None;
                    }
                    return Some((event, (queue, receiver)));
                }
                match receiver.as_mut()?.recv().await {
                    Ok(event) => queue.push_back(event),
                    // A slow client missed events; keep going with what follows.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    )
    .map(|event| Ok(Event::default().data(serde_json::to_string(&event).unwrap_or_default())));

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
