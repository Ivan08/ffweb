//! Running the system ffmpeg and turning its output into job events.

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// What a running ffmpeg tells us as it goes.
#[derive(Debug, Clone)]
pub enum Tick {
    /// A line of ffmpeg's stderr: the human-readable log.
    Log(String),
    /// A machine-readable progress update from `-progress pipe:1`.
    Progress(Progress),
}

#[derive(Debug, Clone, Default)]
pub struct Progress {
    /// Position in the output, in seconds.
    pub out_time: Option<f64>,
    pub frame: Option<u64>,
    pub fps: Option<f64>,
    /// Encoding speed relative to realtime, as reported by ffmpeg ("1.5x").
    pub speed: Option<f64>,
    pub total_size: Option<u64>,
    pub bitrate: Option<String>,
    /// True once ffmpeg reports `progress=end`.
    pub finished: bool,
}

/// Arguments we always prepend. `-nostdin` matters: without it a backgrounded
/// ffmpeg can steal the terminal. `-progress pipe:1` gives us structured
/// progress on stdout, which is far more reliable than scraping the stderr
/// status line.
pub fn base_args() -> Vec<String> {
    [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "level+info",
        "-y",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.2",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Fold one `-progress` line into the block being assembled.
///
/// `-progress` emits `key=value` lines and closes each block with
/// `progress=continuing` or `progress=end`. Returns true when the block just
/// ended and is ready to report.
fn absorb(current: &mut Progress, line: &str) -> bool {
    let Some((key, value)) = line.split_once('=') else {
        return false;
    };
    let value = value.trim();
    match key.trim() {
        "out_time_us" | "out_time_ms" => {
            // Despite the name, ffmpeg reports microseconds for both. Before
            // the first frame it reports a negative placeholder, which would
            // otherwise show up as a progress bar jumping backwards.
            if let Ok(us) = value.parse::<i64>() {
                if us >= 0 {
                    current.out_time = Some(us as f64 / 1_000_000.0);
                }
            }
        }
        "frame" => current.frame = value.parse().ok(),
        "fps" => current.fps = value.parse().ok(),
        "total_size" => current.total_size = value.parse().ok(),
        "bitrate" => current.bitrate = Some(value.to_string()),
        // Reported as `1.02x`, and as `N/A` until there is enough to measure.
        "speed" => current.speed = value.trim_end_matches('x').trim().parse().ok(),
        "progress" => {
            current.finished = value == "end";
            return true;
        }
        _ => {}
    }
    false
}

/// Spawn ffmpeg and stream its output into `tx`. The child is returned so the
/// caller can kill it on cancellation.
pub fn spawn(ffmpeg: &Path, args: &[String], tx: mpsc::UnboundedSender<Tick>) -> Result<Child> {
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("spawning {}", ffmpeg.display()))?;

    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut current = Progress::default();
            while let Ok(Some(line)) = lines.next_line().await {
                if !absorb(&mut current, &line) {
                    continue;
                }
                // A block is complete; report it and start the next one.
                if tx.send(Tick::Progress(current.clone())).is_err() {
                    break;
                }
                current = Progress::default();
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(Tick::Log(line)).is_err() {
                    break;
                }
            }
        });
    }

    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One complete block, as ffmpeg writes it.
    fn block(lines: &[&str]) -> (Progress, bool) {
        let mut progress = Progress::default();
        let mut done = false;
        for line in lines {
            done = absorb(&mut progress, line);
        }
        (progress, done)
    }

    #[test]
    fn reads_a_whole_progress_block() {
        let (progress, done) = block(&[
            "frame=120",
            "fps=25.0",
            "stream_0_0_q=28.0",
            "bitrate=1234.5kbits/s",
            "total_size=192512",
            "out_time_us=4800000",
            "out_time=00:00:04.800000",
            "dup_frames=0",
            "drop_frames=0",
            "speed=1.02x",
            "progress=continuing",
        ]);
        assert!(done, "the block should be complete");
        assert_eq!(progress.frame, Some(120));
        assert_eq!(progress.fps, Some(25.0));
        assert_eq!(progress.total_size, Some(192_512));
        assert_eq!(progress.bitrate.as_deref(), Some("1234.5kbits/s"));
        assert_eq!(progress.out_time, Some(4.8));
        assert_eq!(progress.speed, Some(1.02));
        assert!(!progress.finished);
    }

    #[test]
    fn reports_the_block_only_when_it_ends() {
        let mut progress = Progress::default();
        assert!(!absorb(&mut progress, "frame=1"));
        assert!(!absorb(&mut progress, "speed=2.0x"));
        assert!(absorb(&mut progress, "progress=continuing"));
    }

    #[test]
    fn recognises_the_final_block() {
        let (progress, done) = block(&["out_time_us=9000000", "progress=end"]);
        assert!(done);
        assert!(progress.finished);
        assert_eq!(progress.out_time, Some(9.0));
    }

    #[test]
    fn ignores_the_negative_placeholder_before_the_first_frame() {
        // ffmpeg reports a large negative out_time until it has encoded
        // something; taken literally the bar would start by going backwards.
        let (progress, _) = block(&["out_time_us=-5000000", "progress=continuing"]);
        assert_eq!(progress.out_time, None);
    }

    #[test]
    fn treats_out_time_ms_as_microseconds_too() {
        // The name is a long-standing misnomer: the value is microseconds.
        let (progress, _) = block(&["out_time_ms=2500000", "progress=continuing"]);
        assert_eq!(progress.out_time, Some(2.5));
    }

    #[test]
    fn copes_with_values_ffmpeg_has_not_measured_yet() {
        let (progress, done) = block(&[
            "frame=0",
            "fps=0.0",
            "bitrate=N/A",
            "total_size=N/A",
            "speed=N/A",
            "progress=continuing",
        ]);
        assert!(done);
        assert_eq!(progress.speed, None);
        assert_eq!(progress.total_size, None);
        assert_eq!(progress.frame, Some(0));
    }

    #[test]
    fn ignores_lines_that_are_not_key_values() {
        let mut progress = Progress::default();
        for line in ["", "   ", "not a pair", "[info] something else"] {
            assert!(!absorb(&mut progress, line), "`{line}` should be ignored");
        }
        assert_eq!(progress.frame, None);
    }

    #[test]
    fn tolerates_whitespace_around_the_separator() {
        let (progress, _) = block(&["frame = 42 ", " speed = 3.5x ", "progress=continuing"]);
        assert_eq!(progress.frame, Some(42));
        assert_eq!(progress.speed, Some(3.5));
    }

    #[test]
    fn base_args_request_structured_progress() {
        let args = base_args();
        let position = args.iter().position(|a| a == "-progress").unwrap();
        assert_eq!(args[position + 1], "pipe:1");
    }
}
