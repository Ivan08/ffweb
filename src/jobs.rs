//! The job queue: one entry per ffmpeg invocation, with live progress and
//! cancellation. Jobs executed by the browser's wasm engine are tracked by the
//! frontend and never reach this module.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, Mutex, Semaphore};

use crate::native::{self, Tick};

/// How many log lines a job keeps. Enough to explain a failure, bounded so a
/// chatty encode cannot grow without limit.
const LOG_CAPACITY: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Canceled,
}

impl JobState {
    pub fn is_terminal(self) -> bool {
        matches!(self, JobState::Done | JobState::Failed | JobState::Canceled)
    }
}

/// What the client asks for. Paths are client-relative; args carry placeholders.
#[derive(Debug, Clone, Deserialize)]
pub struct JobRequest {
    /// Input files, in the order `@in0`, `@in1`, ... refer to them.
    #[serde(default)]
    pub inputs: Vec<String>,
    /// ffmpeg arguments with `@inN` / `@out` placeholders.
    pub args: Vec<String>,
    /// Desired output file name, relative to the output directory.
    pub output: String,
    /// Source duration in seconds, used to turn progress into a percentage.
    #[serde(default)]
    pub duration: Option<f64>,
    /// Label shown in the queue; defaults to the output file name.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobView {
    pub id: String,
    pub label: String,
    pub state: JobState,
    pub progress: f32,
    pub inputs: Vec<String>,
    pub output: String,
    /// The exact command line, so the UI can show what really ran.
    pub command: Vec<String>,
    pub duration: Option<f64>,
    pub out_time: Option<f64>,
    pub speed: Option<f64>,
    pub fps: Option<f64>,
    pub frame: Option<u64>,
    pub output_size: Option<u64>,
    pub error: Option<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
}

/// Events pushed to `/api/jobs/{id}/events`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum JobEvent {
    Log {
        line: String,
    },
    Progress {
        progress: f32,
        out_time: Option<f64>,
        speed: Option<f64>,
        fps: Option<f64>,
        frame: Option<u64>,
        size: Option<u64>,
    },
    State {
        state: JobState,
        error: Option<String>,
    },
}

struct Job {
    view: JobView,
    log: VecDeque<String>,
    events: broadcast::Sender<JobEvent>,
    cancel: Arc<tokio::sync::Notify>,
    canceled: bool,
}

#[derive(Clone)]
pub struct JobStore {
    jobs: Arc<DashMap<String, Arc<Mutex<Job>>>>,
    order: Arc<Mutex<Vec<String>>>,
    permits: Arc<Semaphore>,
    ffmpeg: Option<PathBuf>,
}

impl JobStore {
    pub fn new(concurrency: usize, ffmpeg: Option<PathBuf>) -> Self {
        Self {
            jobs: Arc::new(DashMap::new()),
            order: Arc::new(Mutex::new(Vec::new())),
            permits: Arc::new(Semaphore::new(concurrency.max(1))),
            ffmpeg,
        }
    }

    /// Register a job and start it. `command` is the fully substituted argument
    /// list, ready to hand to ffmpeg.
    pub async fn submit(
        &self,
        label: String,
        inputs: Vec<String>,
        output: PathBuf,
        command: Vec<String>,
        duration: Option<f64>,
    ) -> String {
        let id = new_id();
        let (events, _) = broadcast::channel(256);
        let view = JobView {
            id: id.clone(),
            label,
            state: JobState::Queued,
            progress: 0.0,
            inputs,
            output: output.to_string_lossy().into_owned(),
            command: command.clone(),
            duration,
            out_time: None,
            speed: None,
            fps: None,
            frame: None,
            output_size: None,
            error: None,
            created_at: now(),
            finished_at: None,
        };
        let job = Arc::new(Mutex::new(Job {
            view,
            log: VecDeque::with_capacity(64),
            events,
            cancel: Arc::new(tokio::sync::Notify::new()),
            canceled: false,
        }));

        self.jobs.insert(id.clone(), job.clone());
        self.order.lock().await.push(id.clone());

        let store = self.clone();
        tokio::spawn(async move {
            store.run(job, command, output).await;
        });

        id
    }

    async fn run(&self, job: Arc<Mutex<Job>>, command: Vec<String>, output: PathBuf) {
        // Wait for a slot. Cancelling a queued job must not wait for the slot,
        // so the notification races the permit.
        let cancel = job.lock().await.cancel.clone();
        let permit = tokio::select! {
            permit = self.permits.clone().acquire_owned() => permit,
            _ = cancel.notified() => {
                self.finish(&job, JobState::Canceled, None).await;
                return;
            }
        };
        let _permit = match permit {
            Ok(permit) => permit,
            Err(_) => {
                self.finish(
                    &job,
                    JobState::Failed,
                    Some("job queue was shut down".into()),
                )
                .await;
                return;
            }
        };

        if job.lock().await.canceled {
            self.finish(&job, JobState::Canceled, None).await;
            return;
        }

        let Some(ffmpeg) = self.ffmpeg.clone() else {
            self.finish(
                &job,
                JobState::Failed,
                Some("no ffmpeg binary is available".into()),
            )
            .await;
            return;
        };

        self.set_state(&job, JobState::Running, None).await;

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut child = match native::spawn(&ffmpeg, &command, tx) {
            Ok(child) => child,
            Err(err) => {
                self.finish(&job, JobState::Failed, Some(format!("{err:#}")))
                    .await;
                return;
            }
        };

        let duration = job.lock().await.view.duration;
        let exit;

        loop {
            tokio::select! {
                tick = rx.recv() => match tick {
                    Some(Tick::Log(line)) => self.push_log(&job, line).await,
                    Some(Tick::Progress(progress)) => self.push_progress(&job, progress, duration).await,
                    // The pipes closed: ffmpeg is done writing, so wait for it.
                    None => {
                        exit = Some(child.wait().await);
                        break;
                    }
                },
                status = child.wait() => {
                    exit = Some(status);
                    // Drain whatever the reader tasks already queued.
                    while let Ok(tick) = rx.try_recv() {
                        match tick {
                            Tick::Log(line) => self.push_log(&job, line).await,
                            Tick::Progress(p) => self.push_progress(&job, p, duration).await,
                        }
                    }
                    break;
                }
                _ = cancel.notified() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    // A half-written output file is worse than none: it looks
                    // playable in the UI and is not.
                    let _ = std::fs::remove_file(&output);
                    self.finish(&job, JobState::Canceled, None).await;
                    return;
                }
            }
        }

        match exit {
            Some(Ok(status)) if status.success() => {
                let size = std::fs::metadata(&output).ok().map(|m| m.len());
                {
                    let mut guard = job.lock().await;
                    guard.view.output_size = size;
                    guard.view.progress = 1.0;
                }
                self.finish(&job, JobState::Done, None).await;
            }
            Some(Ok(status)) => {
                let _ = std::fs::remove_file(&output);
                let detail = self.last_error_line(&job).await;
                let message = match detail {
                    Some(line) => format!("ffmpeg exited with {status}: {line}"),
                    None => format!("ffmpeg exited with {status}"),
                };
                self.finish(&job, JobState::Failed, Some(message)).await;
            }
            Some(Err(err)) => {
                self.finish(&job, JobState::Failed, Some(format!("{err}")))
                    .await;
            }
            None => {
                self.finish(&job, JobState::Failed, Some("ffmpeg vanished".into()))
                    .await;
            }
        }
    }

    async fn push_log(&self, job: &Arc<Mutex<Job>>, line: String) {
        let mut guard = job.lock().await;
        if guard.log.len() == LOG_CAPACITY {
            guard.log.pop_front();
        }
        guard.log.push_back(line.clone());
        let _ = guard.events.send(JobEvent::Log { line });
    }

    async fn push_progress(
        &self,
        job: &Arc<Mutex<Job>>,
        progress: native::Progress,
        duration: Option<f64>,
    ) {
        let mut guard = job.lock().await;
        let fraction = match (progress.out_time, duration) {
            (Some(t), Some(d)) if d > 0.0 => (t / d).clamp(0.0, 1.0) as f32,
            // Without a duration we cannot compute a percentage; the UI shows an
            // indeterminate bar and the elapsed output time instead.
            _ => guard.view.progress,
        };
        guard.view.progress = fraction;
        guard.view.out_time = progress.out_time.or(guard.view.out_time);
        guard.view.speed = progress.speed.or(guard.view.speed);
        guard.view.fps = progress.fps.or(guard.view.fps);
        guard.view.frame = progress.frame.or(guard.view.frame);
        guard.view.output_size = progress.total_size.or(guard.view.output_size);
        let _ = guard.events.send(JobEvent::Progress {
            progress: fraction,
            out_time: guard.view.out_time,
            speed: guard.view.speed,
            fps: guard.view.fps,
            frame: guard.view.frame,
            size: guard.view.output_size,
        });
    }

    async fn set_state(&self, job: &Arc<Mutex<Job>>, state: JobState, error: Option<String>) {
        let mut guard = job.lock().await;
        guard.view.state = state;
        guard.view.error = error.clone();
        if state.is_terminal() {
            guard.view.finished_at = Some(now());
        }
        let _ = guard.events.send(JobEvent::State { state, error });
    }

    async fn finish(&self, job: &Arc<Mutex<Job>>, state: JobState, error: Option<String>) {
        self.set_state(job, state, error).await;
    }

    /// ffmpeg puts the real reason near the end of stderr; surface it instead of
    /// making the user open the log.
    async fn last_error_line(&self, job: &Arc<Mutex<Job>>) -> Option<String> {
        let guard = job.lock().await;
        guard
            .log
            .iter()
            .rev()
            .find(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("error") || lower.contains("invalid") || lower.contains("no such")
            })
            .cloned()
    }

    pub async fn cancel(&self, id: &str) -> bool {
        let Some(job) = self.jobs.get(id).map(|j| j.clone()) else {
            return false;
        };
        let mut guard = job.lock().await;
        if guard.view.state.is_terminal() {
            return false;
        }
        guard.canceled = true;
        guard.cancel.notify_waiters();
        true
    }

    pub async fn view(&self, id: &str) -> Option<JobView> {
        let job = self.jobs.get(id).map(|j| j.clone())?;
        let guard = job.lock().await;
        Some(guard.view.clone())
    }

    pub async fn log(&self, id: &str) -> Option<Vec<String>> {
        let job = self.jobs.get(id).map(|j| j.clone())?;
        let guard = job.lock().await;
        Some(guard.log.iter().cloned().collect())
    }

    pub async fn subscribe(
        &self,
        id: &str,
    ) -> Option<(JobView, Vec<String>, broadcast::Receiver<JobEvent>)> {
        let job = self.jobs.get(id).map(|j| j.clone())?;
        let guard = job.lock().await;
        Some((
            guard.view.clone(),
            guard.log.iter().cloned().collect(),
            guard.events.subscribe(),
        ))
    }

    pub async fn list(&self) -> Vec<JobView> {
        let order = self.order.lock().await.clone();
        let mut out = Vec::with_capacity(order.len());
        for id in order {
            if let Some(view) = self.view(&id).await {
                out.push(view);
            }
        }
        out
    }

    pub async fn cancel_all(&self) {
        let order = self.order.lock().await.clone();
        for id in order {
            self.cancel(&id).await;
        }
    }
}

fn new_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| {
            const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
            ALPHABET[rng.gen_range(0..ALPHABET.len())] as char
        })
        .collect()
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for ffmpeg: `sleep` is spawned and killed the same way.
    fn sleeper(seconds: &str) -> (JobStore, Vec<String>) {
        let store = JobStore::new(1, Some(PathBuf::from("/bin/sleep")));
        (store, vec![seconds.to_string()])
    }

    async fn wait_for(store: &JobStore, id: &str, state: JobState) -> JobView {
        for _ in 0..200 {
            let view = store.view(id).await.expect("job exists");
            if view.state == state {
                return view;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("job never reached {state:?}: {:?}", store.view(id).await);
    }

    #[tokio::test]
    async fn runs_a_job_to_completion() {
        let (store, args) = sleeper("0");
        let id = store
            .submit(
                "quick".into(),
                vec!["in.mp4".into()],
                PathBuf::from("/tmp/out.mp4"),
                args,
                Some(1.0),
            )
            .await;

        let view = wait_for(&store, &id, JobState::Done).await;
        assert_eq!(view.progress, 1.0);
        assert!(view.finished_at.is_some());
        assert!(view.error.is_none());
    }

    #[tokio::test]
    async fn reports_a_command_that_fails() {
        let store = JobStore::new(1, Some(PathBuf::from("/bin/false")));
        let id = store
            .submit(
                "doomed".into(),
                vec![],
                PathBuf::from("/tmp/none.mp4"),
                vec![],
                None,
            )
            .await;

        let view = wait_for(&store, &id, JobState::Failed).await;
        assert!(view.error.expect("a reason").contains("exited"));
    }

    #[tokio::test]
    async fn reports_a_binary_that_is_not_there() {
        let store = JobStore::new(1, Some(PathBuf::from("/nonexistent/ffmpeg")));
        let id = store
            .submit(
                "missing".into(),
                vec![],
                PathBuf::from("/tmp/none.mp4"),
                vec![],
                None,
            )
            .await;
        wait_for(&store, &id, JobState::Failed).await;
    }

    #[tokio::test]
    async fn refuses_to_run_without_an_ffmpeg() {
        let store = JobStore::new(1, None);
        let id = store
            .submit(
                "no engine".into(),
                vec![],
                PathBuf::from("/tmp/none.mp4"),
                vec![],
                None,
            )
            .await;
        let view = wait_for(&store, &id, JobState::Failed).await;
        assert!(view.error.expect("a reason").contains("no ffmpeg"));
    }

    #[tokio::test]
    async fn cancels_a_job_that_is_already_running() {
        let dir = tempfile::tempdir().expect("temp dir");
        let output = dir.path().join("partial.mp4");
        let (store, args) = sleeper("30");
        let id = store
            .submit("long".into(), vec![], output.clone(), args, Some(30.0))
            .await;

        wait_for(&store, &id, JobState::Running).await;
        // A half-written file looks playable in the interface and is not.
        std::fs::write(&output, b"half a video").expect("write");

        assert!(
            store.cancel(&id).await,
            "cancelling a running job must take"
        );
        let view = wait_for(&store, &id, JobState::Canceled).await;
        assert!(view.error.is_none(), "cancelling is not a failure");
        assert!(!output.exists(), "the partial output must be removed");
    }

    #[tokio::test]
    async fn cancels_a_job_still_waiting_for_its_turn() {
        // One at a time, so the second job never starts.
        let (store, args) = sleeper("30");
        let first = store
            .submit(
                "first".into(),
                vec![],
                PathBuf::from("/tmp/a.mp4"),
                args.clone(),
                None,
            )
            .await;
        let second = store
            .submit(
                "second".into(),
                vec![],
                PathBuf::from("/tmp/b.mp4"),
                args,
                None,
            )
            .await;

        wait_for(&store, &first, JobState::Running).await;
        assert_eq!(
            store.view(&second).await.expect("queued").state,
            JobState::Queued
        );

        assert!(store.cancel(&second).await);
        wait_for(&store, &second, JobState::Canceled).await;
        assert_eq!(
            store.view(&first).await.expect("still there").state,
            JobState::Running
        );

        store.cancel(&first).await;
    }

    #[tokio::test]
    async fn will_not_cancel_a_job_that_has_finished() {
        let (store, args) = sleeper("0");
        let id = store
            .submit(
                "done".into(),
                vec![],
                PathBuf::from("/tmp/out.mp4"),
                args,
                None,
            )
            .await;
        wait_for(&store, &id, JobState::Done).await;
        assert!(!store.cancel(&id).await, "there is nothing left to cancel");
    }

    #[tokio::test]
    async fn cancels_everything_on_shutdown() {
        let (store, args) = sleeper("30");
        let ids = vec![
            store
                .submit(
                    "a".into(),
                    vec![],
                    PathBuf::from("/tmp/a.mp4"),
                    args.clone(),
                    None,
                )
                .await,
            store
                .submit(
                    "b".into(),
                    vec![],
                    PathBuf::from("/tmp/b.mp4"),
                    args.clone(),
                    None,
                )
                .await,
            store
                .submit("c".into(), vec![], PathBuf::from("/tmp/c.mp4"), args, None)
                .await,
        ];
        wait_for(&store, &ids[0], JobState::Running).await;

        store.cancel_all().await;
        for id in &ids {
            wait_for(&store, id, JobState::Canceled).await;
        }
    }

    #[tokio::test]
    async fn runs_one_job_at_a_time_when_told_to() {
        let store = JobStore::new(1, Some(PathBuf::from("/bin/sleep")));
        let first = store
            .submit(
                "first".into(),
                vec![],
                PathBuf::from("/tmp/a.mp4"),
                vec!["30".into()],
                None,
            )
            .await;
        let second = store
            .submit(
                "second".into(),
                vec![],
                PathBuf::from("/tmp/b.mp4"),
                vec!["30".into()],
                None,
            )
            .await;

        wait_for(&store, &first, JobState::Running).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert_eq!(
            store.view(&second).await.expect("queued").state,
            JobState::Queued,
            "the second job must wait for the slot"
        );
        store.cancel_all().await;
    }

    #[tokio::test]
    async fn runs_jobs_side_by_side_when_allowed_to() {
        let store = JobStore::new(3, Some(PathBuf::from("/bin/sleep")));
        let ids = vec![
            store
                .submit(
                    "a".into(),
                    vec![],
                    PathBuf::from("/tmp/a.mp4"),
                    vec!["30".into()],
                    None,
                )
                .await,
            store
                .submit(
                    "b".into(),
                    vec![],
                    PathBuf::from("/tmp/b.mp4"),
                    vec!["30".into()],
                    None,
                )
                .await,
        ];
        for id in &ids {
            wait_for(&store, id, JobState::Running).await;
        }
        store.cancel_all().await;
    }

    #[tokio::test]
    async fn lists_jobs_newest_last_and_keeps_their_details() {
        let (store, args) = sleeper("0");
        store
            .submit(
                "first".into(),
                vec!["a.mp4".into()],
                PathBuf::from("/tmp/a.mp4"),
                args.clone(),
                None,
            )
            .await;
        store
            .submit(
                "second".into(),
                vec!["b.mp4".into()],
                PathBuf::from("/tmp/b.mp4"),
                args,
                None,
            )
            .await;

        let listed = store.list().await;
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].label, "first");
        assert_eq!(listed[1].label, "second");
        assert_eq!(listed[0].inputs, vec!["a.mp4".to_string()]);
    }

    #[tokio::test]
    async fn knows_nothing_about_an_id_it_never_issued() {
        let (store, _) = sleeper("0");
        assert!(store.view("nope").await.is_none());
        assert!(store.log("nope").await.is_none());
        assert!(store.subscribe("nope").await.is_none());
        assert!(!store.cancel("nope").await);
    }

    #[tokio::test]
    async fn replays_the_log_and_the_state_to_a_late_subscriber() {
        let store = JobStore::new(1, Some(PathBuf::from("/bin/sh")));
        let id = store
            .submit(
                "chatty".into(),
                vec![],
                PathBuf::from("/tmp/out.mp4"),
                vec!["-c".into(), "echo one >&2; echo two >&2".into()],
                None,
            )
            .await;
        wait_for(&store, &id, JobState::Done).await;

        // Subscribing after the fact still shows everything that happened.
        let (view, log, _events) = store.subscribe(&id).await.expect("job exists");
        assert_eq!(view.state, JobState::Done);
        assert!(
            log.iter().any(|line| line.contains("one")),
            "log was {log:?}"
        );
        assert!(log.iter().any(|line| line.contains("two")));
    }

    #[tokio::test]
    async fn keeps_the_log_from_growing_without_limit() {
        let store = JobStore::new(1, Some(PathBuf::from("/bin/sh")));
        let id = store
            .submit(
                "noisy".into(),
                vec![],
                PathBuf::from("/tmp/out.mp4"),
                vec!["-c".into(), format!("seq 1 {} >&2", LOG_CAPACITY + 500)],
                None,
            )
            .await;
        wait_for(&store, &id, JobState::Done).await;

        let log = store.log(&id).await.expect("log");
        assert_eq!(log.len(), LOG_CAPACITY, "the log is a bounded tail");
        // It is the *tail* that is kept, because that is where the reason is.
        assert_eq!(
            log.last().map(String::as_str),
            Some((LOG_CAPACITY + 500).to_string().as_str())
        );
    }

    #[tokio::test]
    async fn describes_a_terminal_state_as_terminal() {
        assert!(JobState::Done.is_terminal());
        assert!(JobState::Failed.is_terminal());
        assert!(JobState::Canceled.is_terminal());
        assert!(!JobState::Queued.is_terminal());
        assert!(!JobState::Running.is_terminal());
    }
}
