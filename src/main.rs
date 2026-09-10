use ffweb::{caps, cli, dropbox, jobs, paths, server, state, thumbs, wasmcache};

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;

use caps::Capabilities;
use cli::{CacheAction, Cli, Command};
use dropbox::Dropbox;
use jobs::JobStore;
use paths::Roots;
use state::AppState;
use thumbs::BlobCache;
use wasmcache::WasmCache;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();

    match cli.command {
        Some(Command::Doctor) => doctor(&cli.serve),
        Some(Command::Cache { action }) => cache(action, cli.serve.offline).await,
        Some(Command::Serve(args)) => serve(args).await,
        None => serve(cli.serve).await,
    }
}

fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_env("FFWEB_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(fmt::layer().without_time().with_target(false))
        .with(filter)
        .init();
}

async fn serve(args: cli::ServeArgs) -> Result<()> {
    let caps = Arc::new(Capabilities::detect(
        args.ffmpeg.as_deref(),
        args.ffprobe.as_deref(),
    ));

    if !caps.has_ffmpeg() && matches!(args.backend, cli::Backend::Native) {
        anyhow::bail!("--backend native was requested but no ffmpeg binary was found");
    }
    if !caps.has_ffmpeg() {
        tracing::warn!("no ffmpeg found; processing will run in the browser via WebAssembly");
    }

    let cwd = std::env::current_dir().context("reading the current directory")?;
    let browse = args.root.clone().unwrap_or_else(|| cwd.clone());
    let out = args.out.clone().unwrap_or_else(|| cwd.join("ffweb-out"));
    let dropbox = Dropbox::create()?;
    let roots = Roots::new(browse, out, dropbox.dir().to_path_buf())?;

    // Files named on the command line are opened in the UI, so they have to be
    // reachable through the same containment rules as anything else.
    let mut preload = Vec::new();
    for file in &args.files {
        match roots.resolve(&file.to_string_lossy()) {
            Ok(path) if path.is_file() => preload.push(path),
            Ok(path) => tracing::warn!("skipping {}: not a file", path.display()),
            Err(err) => tracing::warn!("skipping {}: {err:#}", file.display()),
        }
    }

    let wasm_cache = WasmCache::new(args.offline)?;
    let cache_root = wasm_cache
        .dir()
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| wasm_cache.dir())
        .to_path_buf();
    let thumbs = BlobCache::new(&cache_root, "thumbs", "jpg")?;
    let peaks = BlobCache::new(&cache_root, "peaks", "json")?;
    // Trim anything left over from previous sessions before adding to it.
    thumbs.prune();
    peaks.prune();

    let state = Arc::new(AppState {
        jobs: JobStore::new(args.jobs, caps.ffmpeg_path.clone()),
        cache: wasm_cache,
        dropbox,
        thumbs,
        peaks,
        // Two at a time: enough that the timeline fills in promptly, few
        // enough that it cannot crowd out an encode.
        sidework: Arc::new(tokio::sync::Semaphore::new(2)),
        caps,
        roots,
        backend: args.backend,
        unsafe_args: args.unsafe_args,
        token: (!args.no_token).then(server::new_token),
        preload,
        dev_assets: server::dev_assets_dir(),
    });

    server::run(state, &args.host, args.port, args.should_open()).await
}

fn doctor(args: &cli::ServeArgs) -> Result<()> {
    let caps = Capabilities::detect(args.ffmpeg.as_deref(), args.ffprobe.as_deref());

    println!("ffweb {}", env!("CARGO_PKG_VERSION"));
    println!();

    match (&caps.ffmpeg_path, &caps.ffmpeg_version) {
        (Some(path), Some(version)) => {
            println!("  ffmpeg    {}", path.display());
            println!("            {version}");
        }
        (Some(path), None) => println!("  ffmpeg    {} (version unreadable)", path.display()),
        (None, _) => println!("  ffmpeg    not found on PATH — the wasm engine will be used"),
    }
    match &caps.ffprobe_path {
        Some(path) => println!("  ffprobe   {}", path.display()),
        None => println!("  ffprobe   not found — media info and progress percentages degrade"),
    }

    if caps.has_ffmpeg() {
        println!();
        println!("  encoders  {}", join_or_none(&caps.encoders));
        println!("  hwaccels  {}", join_or_none(&caps.hwaccels));
        println!("  filters   {}", join_or_none(&caps.filters));
    }

    println!();
    let cache = WasmCache::new(args.offline)?;
    let status = cache.status();
    println!(
        "  wasm      core {} in {}",
        status.version,
        status.dir.display()
    );
    println!(
        "            single-thread: {}   multi-thread: {} (opt-in)   {}",
        yes_no(status.st_ready),
        yes_no(status.mt_ready),
        human_bytes(status.bytes)
    );
    if !status.st_ready {
        println!("            run `ffweb cache fetch` to download it ahead of time");
    }

    println!();
    let engine = if caps.has_ffmpeg() { "native" } else { "wasm" };
    println!("  engine    {engine} would be used by default");

    Ok(())
}

async fn cache(action: CacheAction, offline: bool) -> Result<()> {
    let cache = WasmCache::new(offline)?;
    match action {
        CacheAction::Path => println!("{}", cache.dir().display()),
        CacheAction::Size => {
            let status = cache.status();
            println!("{} ({})", human_bytes(status.bytes), status.dir.display());
        }
        CacheAction::Clear => {
            cache.clear()?;
            println!("cleared {}", cache.dir().display());
        }
        CacheAction::Fetch { all } => {
            cache.fetch_all(all).await?;
            let status = cache.status();
            println!(
                "cached {} in {}",
                human_bytes(status.bytes),
                status.dir.display()
            );
        }
    }
    Ok(())
}

fn yes_no(v: bool) -> &'static str {
    if v {
        "ready"
    } else {
        "missing"
    }
}

fn join_or_none(set: &std::collections::BTreeSet<String>) -> String {
    if set.is_empty() {
        "(none detected)".to_string()
    } else {
        set.iter().cloned().collect::<Vec<_>>().join(" ")
    }
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
