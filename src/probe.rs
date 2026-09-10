//! ffprobe wrappers: media metadata, single frames and audio peaks.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct MediaInfo {
    pub duration: Option<f64>,
    pub size: Option<u64>,
    pub bit_rate: Option<u64>,
    pub format_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub has_video: bool,
    pub has_audio: bool,
    /// The unmodified ffprobe payload, for the "media info" panel.
    pub raw: serde_json::Value,
}

pub async fn probe(ffprobe: &Path, file: &Path) -> Result<MediaInfo> {
    let output = Command::new(ffprobe)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(file)
        .output()
        .await
        .with_context(|| format!("running ffprobe on {}", file.display()))?;

    if !output.status.success() {
        bail!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let raw: serde_json::Value = serde_json::from_slice(&output.stdout)
        .context("ffprobe returned output that is not JSON")?;

    Ok(parse_media_info(raw))
}

/// Turn ffprobe's JSON into the shape the interface uses.
///
/// Kept separate from running the process so it can be checked against real
/// ffprobe output without needing ffmpeg on the machine.
pub fn parse_media_info(raw: serde_json::Value) -> MediaInfo {
    let format = raw.get("format");
    let streams = raw
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("video"));
    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"));

    MediaInfo {
        duration: format.and_then(|f| num(f, "duration")),
        size: format.and_then(|f| num(f, "size")).map(|v| v as u64),
        bit_rate: format.and_then(|f| num(f, "bit_rate")).map(|v| v as u64),
        format_name: format
            .and_then(|f| f.get("format_name"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        width: video.and_then(|v| num(v, "width")).map(|v| v as u32),
        height: video.and_then(|v| num(v, "height")).map(|v| v as u32),
        fps: video.and_then(|v| {
            v.get("avg_frame_rate")
                .or_else(|| v.get("r_frame_rate"))
                .and_then(|r| r.as_str())
                .and_then(parse_rational)
        }),
        video_codec: video
            .and_then(|v| v.get("codec_name"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        audio_codec: audio
            .and_then(|v| v.get("codec_name"))
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        has_video: video.is_some(),
        has_audio: audio.is_some(),
        raw,
    }
}

/// How the decoded soundtrack is asked for: mono, and coarse on purpose.
///
/// A thousand samples a second is 2 kB/s, so a two-hour film is fourteen
/// megabytes of decoding rather than a gigabyte — and still far finer than a
/// track thirty pixels tall can show. It also means the running time falls out
/// of the sample count, with no separate probe to disagree with it.
const PEAK_RATE: u32 = 1000;

/// How long a waveform may take before it is abandoned.
///
/// The decode is the one thing here that grows with the length of the file,
/// and a request nobody is waiting for should not go on holding a permit.
const PEAK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
pub struct Peaks {
    /// Seconds of sound the peaks cover.
    pub duration: f64,
    /// Where in the file they start.
    pub from: f64,
    /// One magnitude per bucket, 0 to 1.
    pub peaks: Vec<f32>,
}

/// The loudest moment in each of `buckets` equal slices of a file's sound.
///
/// Folded as the samples arrive rather than collected first. The catch is that
/// which bucket a sample belongs to depends on how many samples there turn out
/// to be, which is not known until the end — so this keeps a fixed number of
/// buckets and, whenever they fill, halves the resolution by merging them in
/// pairs. Merging maxima is exact, so the answer is the same as it would have
/// been with the whole soundtrack in hand, and the memory never grows.
pub async fn peaks(
    ffmpeg: &Path,
    file: &Path,
    buckets: usize,
    from: f64,
    to: Option<f64>,
) -> Result<Peaks> {
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    // Seeking before -i is the fast path, as it is for a frame.
    if from > 0.0 {
        command.args(["-ss", &format!("{from:.3}")]);
    }
    command.arg("-i").arg(file);
    if let Some(end) = to {
        command.args(["-t", &format!("{:.3}", (end - from).max(0.0))]);
    }
    command.args([
        // The first soundtrack and nothing else: a file with a picture would
        // otherwise have that decoded too, for nothing.
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        &PEAK_RATE.to_string(),
        "-f",
        "s16le",
        "pipe:1",
    ]);

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("running {}", ffmpeg.display()))?;

    let mut stdout = child.stdout.take().context("ffmpeg produced no output")?;
    let mut stderr = child.stderr.take().context("ffmpeg produced no errors")?;

    let collected = tokio::time::timeout(PEAK_TIMEOUT, async {
        let mut fold = Fold::new(buckets);
        let mut buffer = vec![0u8; 64 * 1024];
        // A sample straddling two reads would otherwise be read as two.
        let mut carry: Option<u8> = None;

        loop {
            let read = stdout.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            let mut chunk = &buffer[..read];
            if let Some(low) = carry.take() {
                match chunk.split_first() {
                    Some((&high, rest)) => {
                        fold.push(i16::from_le_bytes([low, high]));
                        chunk = rest;
                    }
                    None => {
                        carry = Some(low);
                        continue;
                    }
                }
            }
            if chunk.len() % 2 == 1 {
                carry = Some(chunk[chunk.len() - 1]);
                chunk = &chunk[..chunk.len() - 1];
            }
            for pair in chunk.chunks_exact(2) {
                fold.push(i16::from_le_bytes([pair[0], pair[1]]));
            }
        }
        Ok::<Fold, std::io::Error>(fold)
    })
    .await;

    let fold = match collected {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.start_kill();
            bail!("reading the sound of {} took too long", file.display());
        }
    };

    let mut message = String::new();
    stderr.read_to_string(&mut message).await.ok();
    let status = child.wait().await?;
    if !status.success() && fold.samples == 0 {
        bail!("{}", message.trim());
    }
    if fold.samples == 0 {
        bail!("{} has no sound in it", file.display());
    }

    Ok(Peaks {
        duration: fold.samples as f64 / f64::from(PEAK_RATE),
        from,
        peaks: fold.finish(buckets),
    })
}

/// A fixed number of buckets, halved in resolution whenever they fill.
struct Fold {
    values: Vec<f32>,
    /// How many samples each bucket currently stands for.
    per_bucket: usize,
    /// How many have gone into the bucket being filled.
    filled: usize,
    samples: usize,
    capacity: usize,
}

impl Fold {
    fn new(buckets: usize) -> Self {
        // Several times the wanted resolution, so that the slices asked for at
        // the end line up closely with the ones collected along the way. A
        // bucket straddling a change in the sound has to report the louder
        // part of it, so the finer these are, the less of that there is.
        let capacity = buckets.max(1) * 8;
        Self {
            values: Vec::with_capacity(capacity),
            per_bucket: 1,
            filled: 0,
            samples: 0,
            capacity,
        }
    }

    fn push(&mut self, sample: i16) {
        self.samples += 1;
        let magnitude = (f32::from(sample) / f32::from(i16::MAX)).abs();

        if self.filled == 0 {
            self.values.push(magnitude);
        } else if let Some(last) = self.values.last_mut() {
            *last = last.max(magnitude);
        }

        self.filled += 1;
        if self.filled == self.per_bucket {
            self.filled = 0;
            if self.values.len() == self.capacity {
                self.halve();
            }
        }
    }

    /// Merge the buckets in pairs, which doubles what each one stands for.
    ///
    /// Exact, because the maximum of two maxima is the maximum of the four.
    fn halve(&mut self) {
        let merged: Vec<f32> = self
            .values
            .chunks(2)
            .map(|pair| pair.iter().copied().fold(0.0f32, f32::max))
            .collect();
        self.values = merged;
        self.per_bucket *= 2;
    }

    /// Spread what was collected over exactly the number of buckets asked for.
    ///
    /// Measured in samples rather than in collected buckets. The last bucket
    /// is usually part full, so its share of the array is not its share of the
    /// sound — going by the array stretched every waveform slightly, and the
    /// slices at the end of it overlapped the ones before.
    fn finish(self, buckets: usize) -> Vec<f32> {
        let buckets = buckets.max(1);
        if self.values.is_empty() || self.samples == 0 {
            return vec![0.0; buckets];
        }
        (0..buckets)
            .map(|index| {
                let first = index * self.samples / buckets;
                let last = ((index + 1) * self.samples / buckets).max(first + 1);
                let start = first / self.per_bucket;
                let end = last.div_ceil(self.per_bucket).max(start + 1);
                self.values[start.min(self.values.len() - 1)..end.min(self.values.len())]
                    .iter()
                    .copied()
                    .fold(0.0f32, f32::max)
            })
            .map(|value| (value * 1000.0).round() / 1000.0)
            .collect()
    }
}

/// Grab one frame as JPEG. Used by the crop canvas and the timeline strip.
pub async fn thumbnail(ffmpeg: &Path, file: &Path, at: f64, width: u32) -> Result<Vec<u8>> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        // Seeking before -i is the fast path; without it a seek into a long
        // file decodes everything up to that point.
        .args(["-ss", &format!("{at:.3}")])
        .arg("-i")
        .arg(file)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={width}:-2:flags=bilinear"),
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "-q:v",
            "4",
            "pipe:1",
        ])
        .output()
        .await
        .with_context(|| format!("extracting a frame from {}", file.display()))?;

    if !output.status.success() || output.stdout.is_empty() {
        bail!(
            "could not extract a frame: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

/// ffprobe reports numbers as JSON strings in some fields and numbers in others.
fn num(value: &serde_json::Value, key: &str) -> Option<f64> {
    let field = value.get(key)?;
    field
        .as_f64()
        .or_else(|| field.as_str().and_then(|s| s.parse().ok()))
}

/// `"30000/1001"` -> `29.97`
fn parse_rational(text: &str) -> Option<f64> {
    let (num, den) = text.split_once('/')?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    (den != 0.0).then(|| num / den)
}

pub fn require<'a>(path: &'a Option<std::path::PathBuf>, what: &str) -> Result<&'a Path> {
    path.as_deref()
        .ok_or_else(|| anyhow!("{what} was not found on this machine"))
}

#[cfg(test)]
mod peak_tests {
    use super::Fold;

    /// Feed a fold a run of samples and read the buckets back.
    fn fold(buckets: usize, samples: &[i16]) -> Vec<f32> {
        let mut fold = Fold::new(buckets);
        for &sample in samples {
            fold.push(sample);
        }
        fold.finish(buckets)
    }

    #[test]
    fn gives_back_exactly_the_number_of_buckets_asked_for() {
        // However few samples there are, and however many.
        assert_eq!(fold(8, &[1000; 3]).len(), 8);
        assert_eq!(fold(8, &[1000; 100_000]).len(), 8);
        assert_eq!(fold(1, &[1000; 50]).len(), 1);
    }

    #[test]
    fn measures_the_loudest_moment_in_each_slice() {
        // Quiet, then loud. Not averaged into one middling number — a beat
        // lasting a moment is exactly what a waveform is for.
        //
        // The two buckets on either side of the change are left out of it: a
        // bucket covering samples from both halves has to report the louder,
        // and asking otherwise would be asking for a resolution finer than the
        // one requested.
        let mut samples = vec![i16::MAX / 10; 5_000];
        samples.extend(vec![i16::MAX; 5_000]);
        let peaks = fold(10, &samples);

        assert!(
            peaks[..4].iter().all(|&value| value < 0.2),
            "the quiet half read as {:?}",
            &peaks[..4]
        );
        assert!(
            peaks[6..].iter().all(|&value| value > 0.9),
            "the loud half read as {:?}",
            &peaks[6..]
        );
    }

    #[test]
    fn keeps_a_peak_that_lasts_a_single_sample() {
        // The whole point of a maximum rather than an average: a click is one
        // sample among thousands and is exactly what a waveform should show.
        let mut samples = vec![0i16; 100_000];
        samples[70_000] = i16::MAX;
        let peaks = fold(10, &samples);
        assert!(peaks[7] > 0.9, "the click read as {}", peaks[7]);
        assert_eq!(peaks[0], 0.0, "silence elsewhere");
    }

    #[test]
    fn keeps_the_sound_at_the_very_end_of_a_file() {
        // The samples rarely divide evenly into buckets, so the last one is
        // part full. Rounding it away loses however much sound is in it —
        // which for a file ending on a note is the note.
        let mut samples = vec![0i16; 10_000];
        samples[9_999] = i16::MAX;
        let peaks = fold(10, &samples);
        assert!(peaks[9] > 0.9, "the last moment read as {}", peaks[9]);
    }

    #[test]
    fn reads_a_negative_swing_as_loudly_as_a_positive_one() {
        // Sound is symmetric about zero; taking the sign along would draw the
        // troughs of every waveform as silence.
        assert_eq!(fold(1, &[i16::MIN + 1]), fold(1, &[i16::MAX]));
    }

    #[test]
    fn survives_far_more_samples_than_it_has_room_for() {
        // Two hours at the rate used here. The fold halves its resolution as
        // it fills rather than growing, so this costs the same as a short clip.
        let mut samples = vec![0i16; 7_200_000];
        samples[3_600_000] = i16::MAX;
        let peaks = fold(100, &samples);
        assert_eq!(peaks.len(), 100);
        assert!(peaks[50] > 0.9 || peaks[49] > 0.9, "the peak was lost");
    }

    #[test]
    fn is_silent_about_silence() {
        assert!(fold(4, &[0; 1000]).iter().all(|&value| value == 0.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(json: &str) -> MediaInfo {
        parse_media_info(serde_json::from_str(json).expect("valid JSON"))
    }

    #[test]
    fn parses_rational_frame_rates() {
        assert_eq!(parse_rational("30/1"), Some(30.0));
        assert!((parse_rational("30000/1001").expect("ntsc") - 29.97).abs() < 0.01);
        assert_eq!(parse_rational("0/0"), None, "an unknown rate is not zero");
        assert_eq!(parse_rational("25"), None);
    }

    #[test]
    fn reads_an_ordinary_video_file() {
        // ffprobe reports most numbers as strings, and a few as numbers.
        let info = info(
            r#"{
              "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                 "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1"},
                {"codec_type": "audio", "codec_name": "aac", "channels": 2}
              ],
              "format": {"duration": "60.291667", "size": "14529606",
                         "bit_rate": "1927000", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"}
            }"#,
        );
        assert_eq!(info.width, Some(1920));
        assert_eq!(info.height, Some(1080));
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!(info.audio_codec.as_deref(), Some("aac"));
        assert!(info.has_video && info.has_audio);
        assert_eq!(info.size, Some(14_529_606));
        assert_eq!(info.bit_rate, Some(1_927_000));
        assert!((info.duration.expect("duration") - 60.291667).abs() < 1e-6);
        assert!((info.fps.expect("fps") - 29.97).abs() < 0.01);
    }

    #[test]
    fn prefers_the_average_frame_rate_over_the_nominal_one() {
        let info = info(
            r#"{"streams": [{"codec_type": "video", "avg_frame_rate": "24/1", "r_frame_rate": "48/1"}],
                "format": {}}"#,
        );
        assert_eq!(info.fps, Some(24.0));
    }

    #[test]
    fn falls_back_to_the_nominal_rate_when_there_is_no_average() {
        let info =
            info(r#"{"streams": [{"codec_type": "video", "r_frame_rate": "50/1"}], "format": {}}"#);
        assert_eq!(info.fps, Some(50.0));
    }

    #[test]
    fn recognises_a_file_with_no_audio() {
        let info =
            info(r#"{"streams": [{"codec_type": "video", "codec_name": "h264"}], "format": {}}"#);
        assert!(info.has_video);
        assert!(
            !info.has_audio,
            "a silent file must not claim an audio track"
        );
        assert_eq!(info.audio_codec, None);
    }

    #[test]
    fn recognises_an_audio_only_file() {
        let info = info(
            r#"{"streams": [{"codec_type": "audio", "codec_name": "mp3"}],
                "format": {"duration": "180.5", "format_name": "mp3"}}"#,
        );
        assert!(!info.has_video);
        assert!(info.has_audio);
        assert_eq!(info.width, None);
        assert_eq!(info.fps, None);
    }

    #[test]
    fn takes_the_first_stream_of_each_kind() {
        // Multi-language files have several audio tracks; the first is the one
        // the interface reports.
        let info = info(
            r#"{"streams": [
                 {"codec_type": "audio", "codec_name": "aac"},
                 {"codec_type": "video", "codec_name": "hevc"},
                 {"codec_type": "audio", "codec_name": "ac3"},
                 {"codec_type": "subtitle", "codec_name": "subrip"}
               ], "format": {}}"#,
        );
        assert_eq!(info.audio_codec.as_deref(), Some("aac"));
        assert_eq!(info.video_codec.as_deref(), Some("hevc"));
    }

    #[test]
    fn copes_with_a_file_ffprobe_could_barely_read() {
        // A stream ffprobe cannot measure reports nothing rather than zero, and
        // the interface has to keep working from what is left.
        let empty = info(r#"{"streams": [], "format": {}}"#);
        assert_eq!(empty.duration, None);
        assert_eq!(empty.size, None);
        assert!(!empty.has_video && !empty.has_audio);

        let nothing = info("{}");
        assert_eq!(nothing.format_name, None);
    }

    #[test]
    fn accepts_numbers_whether_quoted_or_not() {
        let quoted = info(r#"{"streams": [], "format": {"duration": "12.5", "size": "100"}}"#);
        let bare = info(r#"{"streams": [], "format": {"duration": 12.5, "size": 100}}"#);
        assert_eq!(quoted.duration, bare.duration);
        assert_eq!(quoted.size, bare.size);
    }

    #[test]
    fn ignores_a_duration_that_is_not_a_number() {
        // Some streams report "N/A" rather than omitting the field.
        let info = info(r#"{"streams": [], "format": {"duration": "N/A"}}"#);
        assert_eq!(info.duration, None);
    }

    #[test]
    fn keeps_the_original_payload_for_the_info_panel() {
        let info = info(r#"{"streams": [], "format": {"tags": {"title": "Holiday"}}}"#);
        assert_eq!(
            info.raw
                .pointer("/format/tags/title")
                .and_then(|v| v.as_str()),
            Some("Holiday")
        );
    }
}
