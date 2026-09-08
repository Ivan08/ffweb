//! ffprobe wrappers: media metadata and single-frame thumbnails.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
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
