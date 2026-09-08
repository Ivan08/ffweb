//! Detection of the system ffmpeg/ffprobe and of what they can actually do.
//!
//! The frontend builds ffmpeg argument lists itself, so it needs to know which
//! encoders and filters exist before it offers an operation to the user.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Encoders and filters the UI asks about. Parsing the full `-encoders` output
/// costs nothing, but shipping the whole list to the browser does, so we filter
/// it down to the names any operation can plausibly require.
const INTERESTING_ENCODERS: &[&str] = &[
    "libx264",
    "libx265",
    "libsvtav1",
    "librav1e",
    "libaom-av1",
    "libvpx",
    "libvpx-vp9",
    "mpeg4",
    "gif",
    "libwebp",
    "png",
    "mjpeg",
    "aac",
    "libmp3lame",
    "libopus",
    "libvorbis",
    "flac",
    "pcm_s16le",
    "ac3",
    "mov_text",
    "srt",
    "webvtt",
    "h264_nvenc",
    "hevc_nvenc",
    "h264_qsv",
    "h264_vaapi",
    "h264_videotoolbox",
    "hevc_videotoolbox",
];

const INTERESTING_FILTERS: &[&str] = &[
    "scale",
    "crop",
    "pad",
    "eq",
    "fps",
    "setpts",
    "atempo",
    "reverse",
    "areverse",
    "fade",
    "afade",
    "hqdn3d",
    "nlmeans",
    "unsharp",
    "gblur",
    "boxblur",
    "transpose",
    "hflip",
    "vflip",
    "palettegen",
    "paletteuse",
    "split",
    "overlay",
    "hstack",
    "vstack",
    "concat",
    "amix",
    "loudnorm",
    "volume",
    "subtitles",
    "ass",
    "drawtext",
    "vignette",
    "deshake",
    "vidstabdetect",
    "zscale",
    "format",
    "trim",
    "atrim",
    "silencedetect",
    // The plumbing a timeline needs. These are never chosen by name in the
    // interface, but a project's graph is built out of them, so the interface
    // has to be able to ask whether this ffmpeg has them before offering to
    // run one.
    "setsar",
    "asetpts",
    "aformat",
    "aresample",
    "anullsrc",
    "adelay",
    "asplit",
    "scale2ref",
    "colorchannelmixer",
    "select",
];

#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    /// Absolute path to ffmpeg, if one was found.
    pub ffmpeg_path: Option<PathBuf>,
    pub ffprobe_path: Option<PathBuf>,
    /// Human readable version line, e.g. "ffmpeg version 8.0.1-3ubuntu2".
    pub ffmpeg_version: Option<String>,
    /// Just the numeric part when we can isolate it, e.g. "8.0.1".
    pub ffmpeg_version_number: Option<String>,
    pub encoders: BTreeSet<String>,
    pub decoders: BTreeSet<String>,
    pub filters: BTreeSet<String>,
    pub muxers: BTreeSet<String>,
    pub hwaccels: BTreeSet<String>,
}

impl Capabilities {
    /// Probe the machine. `ffmpeg_hint`/`ffprobe_hint` come from the CLI flags.
    pub fn detect(ffmpeg_hint: Option<&Path>, ffprobe_hint: Option<&Path>) -> Self {
        let ffmpeg_path = resolve(ffmpeg_hint, "ffmpeg");
        let ffprobe_path = resolve(ffprobe_hint, "ffprobe")
            // A build tree often ships both binaries side by side, so if ffprobe
            // is not on PATH try next to the ffmpeg we did find.
            .or_else(|| ffmpeg_path.as_deref().and_then(sibling_ffprobe));

        let mut caps = Capabilities {
            ffmpeg_path,
            ffprobe_path,
            ffmpeg_version: None,
            ffmpeg_version_number: None,
            encoders: BTreeSet::new(),
            decoders: BTreeSet::new(),
            filters: BTreeSet::new(),
            muxers: BTreeSet::new(),
            hwaccels: BTreeSet::new(),
        };

        let Some(ffmpeg) = caps.ffmpeg_path.clone() else {
            return caps;
        };

        if let Some(line) = run(&ffmpeg, &["-hide_banner", "-version"])
            .and_then(|out| out.lines().next().map(str::to_owned))
        {
            caps.ffmpeg_version_number = parse_version_number(&line);
            caps.ffmpeg_version = Some(line);
        }

        if let Some(out) = run(&ffmpeg, &["-hide_banner", "-encoders"]) {
            caps.encoders = parse_codec_table(&out, INTERESTING_ENCODERS);
        }
        if let Some(out) = run(&ffmpeg, &["-hide_banner", "-decoders"]) {
            caps.decoders = parse_codec_table(&out, INTERESTING_ENCODERS);
        }
        if let Some(out) = run(&ffmpeg, &["-hide_banner", "-filters"]) {
            caps.filters = parse_filter_table(&out, INTERESTING_FILTERS);
        }
        if let Some(out) = run(&ffmpeg, &["-hide_banner", "-muxers"]) {
            caps.muxers = parse_muxer_table(&out);
        }
        if let Some(out) = run(&ffmpeg, &["-hide_banner", "-hwaccels"]) {
            caps.hwaccels = out
                .lines()
                .skip(1)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect();
        }

        caps
    }

    pub fn has_ffmpeg(&self) -> bool {
        self.ffmpeg_path.is_some()
    }

    pub fn has_ffprobe(&self) -> bool {
        self.ffprobe_path.is_some()
    }
}

/// Turn a hint or a bare command name into an absolute, executable path.
fn resolve(hint: Option<&Path>, name: &str) -> Option<PathBuf> {
    if let Some(hint) = hint {
        return run(hint, &["-hide_banner", "-version"]).map(|_| hint.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        // Windows carries the extension; everywhere else the bare name is right.
        let candidate = if cfg!(windows) {
            candidate.with_extension("exe")
        } else {
            candidate
        };
        if candidate.is_file() && run(&candidate, &["-hide_banner", "-version"]).is_some() {
            return Some(candidate);
        }
    }
    None
}

fn sibling_ffprobe(ffmpeg: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let candidate = ffmpeg.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

fn run(bin: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stderr).into_owned();
    }
    Some(text)
}

/// `ffmpeg version 8.0.1-3ubuntu2 Copyright ...` -> `8.0.1`
fn parse_version_number(line: &str) -> Option<String> {
    let rest = line.strip_prefix("ffmpeg version ")?;
    let token = rest.split_whitespace().next()?;
    let numeric: String = token
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    (!numeric.is_empty()).then_some(numeric)
}

/// Rows in `-encoders`/`-decoders` look like ` V....D libx264   H.264 ...`.
/// The name is the second whitespace-separated field, after the flag column.
fn parse_codec_table(output: &str, wanted: &[&str]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for line in output.lines().skip_while(|l| !l.contains("------")).skip(1) {
        let mut fields = line.split_whitespace();
        let _flags = fields.next();
        if let Some(name) = fields.next() {
            if wanted.contains(&name) {
                found.insert(name.to_owned());
            }
        }
    }
    found
}

/// Rows in `-filters` look like ` T.. scale   V->V  Scale the input video.`
///
/// Unlike the codec tables this listing has no `-----` separator after its
/// legend, so rows are recognised by their signature column (`V->V`, `A->A`,
/// `N->N`, ...) instead. Legend lines use `=` and never match.
fn parse_filter_table(output: &str, wanted: &[&str]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_flags), Some(name), Some(signature)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if signature.contains("->") && wanted.contains(&name) {
            found.insert(name.to_owned());
        }
    }
    found
}

/// Rows in `-muxers` look like ` E mp4   MP4 (MPEG-4 Part 14)`. A muxer entry
/// may list several comma-separated names; we keep them all.
fn parse_muxer_table(output: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for line in output.lines().skip_while(|l| l.trim() != "---").skip(1) {
        let mut fields = line.split_whitespace();
        let _flags = fields.next();
        if let Some(names) = fields.next() {
            for name in names.split(',') {
                found.insert(name.to_owned());
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    /// Every filter a project can ask for must be one this probe looks for.
    ///
    /// The interface will not run a project whose filters this ffmpeg lacks,
    /// and it decides that from what `/api/capabilities` reports. A filter the
    /// graph uses but `INTERESTING_FILTERS` omits therefore reads as missing on
    /// every machine, and the Run button goes dead with nothing to explain it.
    /// The frontend writes its vocabulary out; this reads the same file back.
    #[test]
    fn looks_for_every_filter_the_interface_can_need() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/web/src/ops/__fixtures__/filters.json"
        );
        let raw = std::fs::read_to_string(path).unwrap_or_else(|err| {
            panic!("run `npm --prefix web test` to write {path} first: {err}")
        });
        let wanted: Vec<String> = serde_json::from_str(&raw).expect("filters.json");
        assert!(wanted.len() > 10, "the vocabulary looks truncated");

        let missing: Vec<&String> = wanted
            .iter()
            .filter(|name| !super::INTERESTING_FILTERS.contains(&name.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "the interface can ask for filters this probe never reports: {missing:?}"
        );
    }

    use super::*;

    /// Real `ffmpeg -encoders` output, trimmed to a handful of rows.
    const ENCODERS: &str = "\
Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC
 V....D libx265              libx265 H.265 / HEVC
 V....D libvpx-vp9           libvpx VP9
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libmp3lame           libmp3lame MP3
 S....D mov_text             3GPP Timed Text subtitle
 V....D not_interesting      Something the interface never asks for
";

    /// Real `ffmpeg -filters` output. Note it has no `-----` separator.
    const FILTERS: &str = "\
Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 TS aap               AA->A      Apply Affine Projection algorithm.
 .. acopy             A->A       Copy the input audio unchanged.
 TSC scale            V->V       Scale the input video.
 ... palettegen       V->V       Find the optimal palette.
 ... paletteuse       VV->V      Use a palette to downsample.
 ... hstack           N->V       Stack video inputs horizontally.
 ..C overlay          VV->V      Overlay a video source on top of the input.
 ... nosuchfilter     V->V       Not one the interface asks about.
";

    const MUXERS: &str = "\
Formats:
 D.. = Demuxing supported
 .E. = Muxing supported
 ..d = Is a device
 ---
  E  3g2             3GP2 (3GPP2 file format)
  E  mp4             MP4 (MPEG-4 Part 14)
 DE  matroska,webm   Matroska / WebM
  E  mp3             MP3 (MPEG audio layer 3)
";

    #[test]
    fn reads_the_version_number_out_of_the_banner() {
        assert_eq!(
            parse_version_number(
                "ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025 the FFmpeg developers"
            )
            .as_deref(),
            Some("8.0.1")
        );
        assert_eq!(
            parse_version_number("ffmpeg version 6.1 Copyright (c)").as_deref(),
            Some("6.1")
        );
    }

    #[test]
    fn copes_with_a_version_that_is_not_a_number() {
        // Distribution and git builds both happen.
        assert_eq!(
            parse_version_number("ffmpeg version N-109321-g1a2b3c"),
            None
        );
        assert_eq!(parse_version_number("something else entirely"), None);
    }

    #[test]
    fn reads_encoder_names_past_the_flag_column() {
        let found = parse_codec_table(ENCODERS, &["libx264", "aac", "libmp3lame", "mov_text"]);
        assert!(found.contains("libx264"));
        assert!(found.contains("aac"));
        assert!(found.contains("libmp3lame"));
        assert!(found.contains("mov_text"));
    }

    #[test]
    fn keeps_only_the_encoders_it_was_asked_about() {
        let found = parse_codec_table(ENCODERS, &["libx264"]);
        assert_eq!(found.len(), 1);
        assert!(!found.contains("not_interesting"));
    }

    #[test]
    fn does_not_mistake_the_legend_for_a_codec() {
        // Everything above the `------` line describes the flag columns.
        let found = parse_codec_table(ENCODERS, &["V.....", "Encoders:", "------"]);
        assert!(found.is_empty(), "picked up the legend: {found:?}");
    }

    #[test]
    fn reads_filter_names_although_the_listing_has_no_separator() {
        // `-filters` ends its legend without a `-----` rule, so rows are found
        // by their signature column instead. Getting this wrong once made the
        // whole filter list come back empty.
        let found = parse_filter_table(
            FILTERS,
            &["scale", "palettegen", "paletteuse", "hstack", "overlay"],
        );
        assert!(found.contains("scale"));
        assert!(found.contains("palettegen"));
        assert!(found.contains("hstack"), "N->V signatures must count too");
        assert!(found.contains("overlay"), "VV->V signatures must count too");
        assert_eq!(found.len(), 5);
    }

    #[test]
    fn does_not_mistake_the_filter_legend_for_a_filter() {
        let found = parse_filter_table(FILTERS, &["=", "Timeline", "Filters:", "|"]);
        assert!(found.is_empty(), "picked up the legend: {found:?}");
    }

    #[test]
    fn ignores_filters_it_was_not_asked_about() {
        let found = parse_filter_table(FILTERS, &["scale"]);
        assert_eq!(found.len(), 1);
        assert!(!found.contains("nosuchfilter"));
    }

    #[test]
    fn reads_muxers_and_splits_the_comma_separated_names() {
        let found = parse_muxer_table(MUXERS);
        assert!(found.contains("mp4"));
        assert!(found.contains("mp3"));
        // `matroska,webm` is one row naming two formats.
        assert!(found.contains("matroska"));
        assert!(found.contains("webm"));
        assert!(!found.contains("Formats:"));
    }

    #[test]
    fn returns_nothing_for_empty_or_unexpected_output() {
        assert!(parse_codec_table("", &["libx264"]).is_empty());
        assert!(parse_filter_table("", &["scale"]).is_empty());
        assert!(parse_muxer_table("").is_empty());
        assert!(parse_codec_table("command not found", &["libx264"]).is_empty());
    }

    #[test]
    fn reports_a_machine_with_no_ffmpeg_as_having_none() {
        let caps = Capabilities::detect(Some(Path::new("/nonexistent/ffmpeg")), None);
        assert!(!caps.has_ffmpeg());
        assert!(caps.encoders.is_empty());
        assert!(caps.ffmpeg_version.is_none());
    }
}
