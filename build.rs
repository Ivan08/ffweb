//! Builds the frontend into `assets/dist` so `rust-embed` can bake it in.
//!
//! The bundle is not in version control: it is generated, and generated files
//! in a repository mean every rebuild shows up as a diff. Building it needs
//! Node.js. A machine without Node still compiles — the directory is created
//! empty and the server says plainly that the interface was not built — which
//! keeps `cargo build` working for anyone who only wants the CLI. Ready-made
//! binaries are distributed separately, with the interface already inside.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let web = root.join("web");
    let dist = root.join("assets/dist");

    // `rust-embed` refuses to compile against a directory that is not there, so
    // this has to happen before any early return below.
    if let Err(err) = std::fs::create_dir_all(&dist) {
        panic!("could not create {}: {err}", dist.display());
    }

    println!("cargo:rerun-if-changed=web/src");
    println!("cargo:rerun-if-changed=web/package.json");
    println!("cargo:rerun-if-changed=web/vite.config.ts");
    println!("cargo:rerun-if-env-changed=FFWEB_SKIP_UI_BUILD");

    if std::env::var_os("FFWEB_SKIP_UI_BUILD").is_some() {
        return;
    }
    if !web.join("package.json").is_file() {
        return;
    }
    if !has_node() {
        if !dist.join("index.html").is_file() {
            println!(
                "cargo:warning=Node.js was not found, so the interface was not built. \
                 The binary will start and explain this. Install Node.js and rebuild, \
                 or use a released binary, which has the interface inside."
            );
        }
        return;
    }
    if dist.join("index.html").is_file() && !sources_are_newer(&web, &dist) {
        return;
    }

    if !web.join("node_modules").is_dir() {
        run(&web, "npm", &["ci", "--no-audit", "--no-fund"]);
    }
    run(&web, "npm", &["run", "build"]);
}

fn has_node() -> bool {
    Command::new("npm")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Compare the newest source file against the built bundle.
fn sources_are_newer(web: &Path, dist: &Path) -> bool {
    let Some(built) = modified(&dist.join("index.html")) else {
        return true;
    };
    newest_under(&web.join("src"))
        .into_iter()
        .chain(modified(&web.join("package.json")))
        .chain(modified(&web.join("vite.config.ts")))
        .any(|time| time > built)
}

fn newest_under(dir: &Path) -> Option<std::time::SystemTime> {
    let mut newest = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(time) = modified(&path) {
                newest =
                    Some(newest.map_or(time, |current: std::time::SystemTime| current.max(time)));
            }
        }
    }
    newest
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn run(dir: &Path, program: &str, args: &[&str]) {
    let status = Command::new(program)
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap_or_else(|err| panic!("failed to run `{program} {}`: {err}", args.join(" ")));
    if !status.success() {
        panic!("`{program} {}` failed with {status}", args.join(" "));
    }
}
