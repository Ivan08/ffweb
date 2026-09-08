//! Validation of the ffmpeg argument list the browser sends us.
//!
//! The frontend is the single source of truth for how an operation becomes
//! ffmpeg arguments, which means arbitrary argument lists arrive over HTTP. No
//! shell is involved, so command injection is not the threat — reading or
//! writing files outside the allowed directories is. Every path in the argument
//! list must therefore be a placeholder (`@in0`, `@in1`, ..., `@out`) that the
//! server substitutes with paths it resolved itself.

use anyhow::{bail, Result};

/// Placeholder for the n-th input file.
pub const IN_PREFIX: &str = "@in";
/// Placeholder for the output file.
pub const OUT: &str = "@out";

/// Filter-graph sources that can open a file behind our back.
const FORBIDDEN_FILTER_SOURCES: &[&str] = &["movie=", "amovie=", "src_movie="];

/// Protocol prefixes ffmpeg understands that reach outside the sandbox.
const FORBIDDEN_PROTOCOLS: &[&str] = &[
    "file:", "pipe:", "concat:", "subfile:", "http:", "https:", "ftp:", "rtmp:", "rtsp:", "udp:",
    "tcp:", "unix:", "data:", "srt:", "sftp:", "ssh:", "async:", "cache:", "crypto:", "fd:",
];

/// Options that name a file and would otherwise slip past the path checks.
const FILE_VALUED_OPTIONS: &[&str] = &[
    "-i",
    "-passlogfile",
    "-attach",
    "-vstats_file",
    "-dump_attachment",
];

/// Filter options whose value is a file name. A filtergraph is one argument, so
/// `-vf subtitles=/etc/passwd` never looks like a path argument on its own —
/// these keys are how a filter reaches the filesystem, and each one's value must
/// therefore be a placeholder.
const FILE_VALUED_FILTER_KEYS: &[&str] = &[
    "subtitles=",
    "ass=",
    "textfile=",
    "fontfile=",
    "filename=",
    "sub_file=",
    "result=",
    "stats_file=",
    "model=",
    "file=",
];

pub struct Validated {
    /// How many distinct `@inN` placeholders the arguments reference.
    pub input_count: usize,
    /// Whether `@out` appears. Always true unless --unsafe-args is in effect.
    #[allow(dead_code)]
    pub has_output: bool,
}

/// Check an argument list. `unsafe_args` relaxes the path rules for users who
/// deliberately want to reach the wider filesystem.
pub fn validate(args: &[String], unsafe_args: bool) -> Result<Validated> {
    if args.is_empty() {
        bail!("empty argument list");
    }
    if args.len() > 512 {
        bail!("argument list is implausibly long ({} entries)", args.len());
    }

    let mut max_input: Option<usize> = None;
    let mut has_output = false;

    for (index, arg) in args.iter().enumerate() {
        if arg.len() > 8192 {
            bail!("argument {index} is too long");
        }
        if arg.contains('\0') {
            bail!("argument {index} contains a NUL byte");
        }

        if arg == OUT {
            has_output = true;
            continue;
        }
        if let Some(rest) = arg.strip_prefix(IN_PREFIX) {
            let n: usize = rest
                .parse()
                .map_err(|_| anyhow::anyhow!("malformed input placeholder `{arg}`"))?;
            max_input = Some(max_input.map_or(n, |m: usize| m.max(n)));
            continue;
        }

        if unsafe_args {
            continue;
        }

        let lower = arg.to_ascii_lowercase();
        for proto in FORBIDDEN_PROTOCOLS {
            // A protocol anywhere in the argument counts: a filtergraph is a
            // single argument, so `subtitles=file:/etc/passwd` would otherwise
            // sail past a prefix-only check.
            if lower.contains(proto) {
                bail!(
                    "argument `{arg}` uses the `{proto}` protocol; pass --unsafe-args to allow it"
                );
            }
        }
        for source in FORBIDDEN_FILTER_SOURCES {
            if lower.contains(source) {
                bail!("filter source `{source}` can read arbitrary files; pass --unsafe-args to allow it");
            }
        }
        check_filter_file_values(arg, &lower)?;

        // Anything that looks like a filesystem path must have been a placeholder.
        if looks_like_path(arg) {
            bail!("argument `{arg}` names a path directly; use @in0/@out placeholders or pass --unsafe-args");
        }

        // The value that follows a file-valued option must be a placeholder
        // too, otherwise a bare relative name like `out.mp4` would sneak
        // through — and every option in the list names a file, not just `-i`.
        if let Some(previous) = index.checked_sub(1).map(|i| args[i].as_str()) {
            if FILE_VALUED_OPTIONS.contains(&previous) {
                bail!("`{previous}` must be followed by an @inN placeholder, got `{arg}`");
            }
        }
    }

    if !has_output && !unsafe_args {
        bail!("argument list has no @out placeholder");
    }

    Ok(Validated {
        input_count: max_input.map_or(0, |m| m + 1),
        has_output,
    })
}

/// Every file-valued filter option must be given a placeholder, never a name.
fn check_filter_file_values(arg: &str, lower: &str) -> Result<()> {
    for key in FILE_VALUED_FILTER_KEYS {
        let mut from = 0;
        while let Some(found) = lower[from..].find(key) {
            let value_at = from + found + key.len();
            let value = &arg[value_at..];
            // A leading quote is legal filtergraph syntax around the value.
            let value = value.trim_start_matches(['\'', '"']);
            if !value.starts_with(IN_PREFIX) && !value.starts_with(OUT) {
                bail!(
                    "`{}` in `{arg}` must be given an @inN placeholder; pass --unsafe-args to allow a path",
                    key.trim_end_matches('=')
                );
            }
            from = value_at;
        }
    }
    Ok(())
}

fn looks_like_path(arg: &str) -> bool {
    arg.starts_with('/')
        || arg.starts_with('~')
        || arg.starts_with("./")
        || arg.starts_with("../")
        || arg.contains("/../")
        || (cfg!(windows) && arg.len() > 2 && arg.as_bytes()[1] == b':')
}

/// Replace placeholders with real paths once validation has passed.
///
/// A placeholder can also appear *inside* a larger argument — `subtitles=@in1`
/// is the case that matters — and there the path becomes part of a filtergraph,
/// where `\`, `:` and `\'` carry meaning and have to be escaped.
pub fn substitute(args: &[String], inputs: &[String], output: &str) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(args.len());
    for arg in args {
        if arg == OUT {
            out.push(output.to_string());
        } else if let Some(rest) = arg.strip_prefix(IN_PREFIX) {
            if let Ok(n) = rest.parse::<usize>() {
                out.push(input_path(inputs, n, arg)?.clone());
                continue;
            }
            out.push(substitute_embedded(arg, inputs, output)?);
        } else if arg.contains(IN_PREFIX) || arg.contains(OUT) {
            out.push(substitute_embedded(arg, inputs, output)?);
        } else {
            out.push(arg.clone());
        }
    }
    Ok(out)
}

fn input_path<'a>(inputs: &'a [String], n: usize, arg: &str) -> Result<&'a String> {
    inputs
        .get(n)
        .ok_or_else(|| anyhow::anyhow!("`{arg}` has no matching input file"))
}

fn substitute_embedded(arg: &str, inputs: &[String], output: &str) -> Result<String> {
    let mut result = String::with_capacity(arg.len());
    let bytes = arg.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'@' {
            if arg[i..].starts_with(OUT) {
                result.push_str(&escape_filter_path(output));
                i += OUT.len();
                continue;
            }
            if arg[i..].starts_with(IN_PREFIX) {
                let digits_at = i + IN_PREFIX.len();
                let digits: String = arg[digits_at..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect();
                if !digits.is_empty() {
                    let n: usize = digits.parse()?;
                    let path = input_path(inputs, n, arg)?;
                    result.push_str(&escape_filter_path(path));
                    i = digits_at + digits.len();
                    continue;
                }
            }
        }
        // Push one whole character, not one byte, so multi-byte paths survive.
        let ch = arg[i..]
            .chars()
            .next()
            .expect("index is on a char boundary");
        result.push(ch);
        i += ch.len_utf8();
    }

    Ok(result)
}

/// Escape a path for use inside a filtergraph argument.
fn escape_filter_path(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '\\' | ':' | '\'' | '[' | ']' | ',' | ';' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Result<Validated> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        validate(&owned, false)
    }

    #[test]
    fn accepts_placeholder_only_commands() {
        let result = v(&["-i", "@in0", "-c:v", "libx264", "-crf", "28", "@out"]).unwrap();
        assert_eq!(result.input_count, 1);
        assert!(result.has_output);
    }

    #[test]
    fn counts_multiple_inputs() {
        let result = v(&[
            "-i",
            "@in0",
            "-i",
            "@in1",
            "-filter_complex",
            "hstack",
            "@out",
        ])
        .unwrap();
        assert_eq!(result.input_count, 2);
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(v(&["-i", "/etc/passwd", "@out"]).is_err());
    }

    #[test]
    fn rejects_bare_relative_input() {
        assert!(v(&["-i", "secret.mp4", "@out"]).is_err());
    }

    #[test]
    fn rejects_a_file_named_after_any_file_valued_option() {
        for option in FILE_VALUED_OPTIONS {
            assert!(
                v(&["-i", "@in0", option, "somewhere", "@out"]).is_err(),
                "`{option}` accepted a plain name"
            );
        }
    }

    #[test]
    fn rejects_movie_filter_source() {
        assert!(v(&["-i", "@in0", "-vf", "movie=/etc/passwd", "@out"]).is_err());
    }

    #[test]
    fn rejects_protocols() {
        assert!(v(&["-i", "@in0", "-vf", "subtitles=file:/etc/passwd", "@out"]).is_err());
        assert!(v(&["-i", "concat:a.ts|b.ts", "@out"]).is_err());
    }

    #[test]
    fn rejects_file_reading_filter_options() {
        assert!(v(&["-i", "@in0", "-vf", "subtitles=/etc/passwd", "@out"]).is_err());
        assert!(v(&["-i", "@in0", "-vf", "drawtext=textfile=/etc/passwd", "@out"]).is_err());
        assert!(v(&["-i", "@in0", "-vf", "ass=../../secret.ass", "@out"]).is_err());
    }

    #[test]
    fn allows_placeholder_valued_filter_options() {
        assert!(v(&[
            "-i",
            "@in0",
            "-i",
            "@in1",
            "-vf",
            "subtitles=@in1:force_style='FontSize=24'",
            "@out"
        ])
        .is_ok());
    }

    #[test]
    fn allows_ordinary_filter_graphs() {
        assert!(v(&["-i", "@in0", "-vf", "scale=640:-2,eq=contrast=1.1", "@out"]).is_ok());
        assert!(v(&["-i", "@in0", "-vf", "overlay=(W-w)/2:(H-h)/2", "@out"]).is_ok());
        assert!(v(&["-i", "@in0", "-vf", "vignette=PI/4", "@out"]).is_ok());
    }

    #[test]
    fn allows_srt_as_a_muxer_name() {
        assert!(v(&["-i", "@in0", "-c:s", "srt", "@out"]).is_ok());
    }

    #[test]
    fn requires_an_output() {
        assert!(v(&["-i", "@in0", "-c", "copy"]).is_err());
    }

    #[test]
    fn substitutes_embedded_placeholders_and_escapes_them() {
        let args: Vec<String> = ["-vf", "subtitles=@in1:force_style='FontSize=24'", "@out"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let inputs = vec!["/tmp/a.mp4".to_string(), "/tmp/sub:1.srt".to_string()];
        let out = substitute(&args, &inputs, "/tmp/out.mp4").unwrap();
        assert_eq!(
            out[1],
            "subtitles=/tmp/sub\\:1.srt:force_style='FontSize=24'"
        );
        assert_eq!(out[2], "/tmp/out.mp4");
    }

    /// Every command the interface can produce, as exported by the frontend
    /// tests. The two sides enforce this contract in different languages, and
    /// a rule that tightens here but not there gives a UI that composes
    /// commands the server then refuses.
    #[test]
    fn accepts_every_command_the_interface_generates() {
        #[derive(serde::Deserialize)]
        struct Exported {
            label: String,
            inputs: usize,
            args: Vec<String>,
        }

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/web/src/ops/__fixtures__/commands.json"
        );
        let Ok(json) = std::fs::read_to_string(path) else {
            panic!("run the frontend tests first: they write {path}");
        };
        let commands: Vec<Exported> =
            serde_json::from_str(&json).expect("the exported commands are not valid JSON");
        assert!(
            commands.len() > 100,
            "only {} commands exported; the frontend fixture looks stale",
            commands.len()
        );

        for command in &commands {
            let checked = validate(&command.args, false)
                .unwrap_or_else(|err| panic!("{} was rejected: {err:#}", command.label));
            assert_eq!(
                checked.input_count, command.inputs,
                "{} declares {} inputs but the validator counted {}",
                command.label, command.inputs, checked.input_count
            );

            // Substitution has to succeed too: a placeholder the validator
            // accepts but cannot resolve would fail at run time instead.
            let inputs: Vec<String> = (0..command.inputs.max(1))
                .map(|index| format!("/clips/input{index}.mp4"))
                .collect();
            substitute(&command.args, &inputs, "/out/result.mp4").unwrap_or_else(|err| {
                panic!("{} could not be substituted: {err:#}", command.label)
            });
        }
    }

    #[test]
    fn substitutes_placeholders() {
        let args: Vec<String> = ["-i", "@in0", "-i", "@in1", "@out"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let inputs = vec!["/tmp/a.mp4".to_string(), "/tmp/b.mp4".to_string()];
        let out = substitute(&args, &inputs, "/tmp/out.mp4").unwrap();
        assert_eq!(
            out,
            vec!["-i", "/tmp/a.mp4", "-i", "/tmp/b.mp4", "/tmp/out.mp4"]
        );
    }
}
