use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[value(rename_all = "lowercase")]
pub enum Backend {
    /// Pick native ffmpeg when it is available, otherwise fall back to wasm.
    Auto,
    /// Always shell out to the system ffmpeg binary.
    Native,
    /// Always run ffmpeg.wasm inside the browser tab.
    Wasm,
}

impl std::fmt::Display for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Backend::Auto => "auto",
            Backend::Native => "native",
            Backend::Wasm => "wasm",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "ffweb",
    version,
    about = "Local web UI for ffmpeg — native when available, WebAssembly otherwise",
    long_about = None,
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[command(flatten)]
    pub serve: ServeArgs,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start the local server (this is the default when no subcommand is given).
    Serve(ServeArgs),
    /// Report what the tool found on this machine: ffmpeg, codecs, wasm cache.
    Doctor,
    /// Inspect or manage the downloaded ffmpeg.wasm core.
    Cache {
        #[command(subcommand)]
        action: CacheAction,
    },
}

#[derive(Debug, Subcommand)]
pub enum CacheAction {
    /// Download the ffmpeg.wasm core into the cache directory.
    Fetch {
        /// Also download the multi-threaded core, which the UI loads only when
        /// explicitly asked for with `?core=mt`.
        #[arg(long)]
        all: bool,
    },
    /// Print the cache directory path.
    Path,
    /// Print how much disk the cache uses.
    Size,
    /// Remove all cached files.
    Clear,
}

#[derive(Debug, Clone, Args)]
pub struct ServeArgs {
    /// Port to listen on. 0 picks a free port; the default probes upward if busy.
    #[arg(short, long, default_value_t = 7788, env = "FFWEB_PORT")]
    pub port: u16,

    /// Address to bind. Anything other than a loopback address exposes the machine.
    #[arg(long, default_value = "127.0.0.1", env = "FFWEB_HOST")]
    pub host: String,

    /// Root directory the built-in file browser is allowed to walk.
    #[arg(long, env = "FFWEB_ROOT")]
    pub root: Option<PathBuf>,

    /// Where finished files are written.
    #[arg(short, long, env = "FFWEB_OUT")]
    pub out: Option<PathBuf>,

    /// Which execution engine to prefer.
    #[arg(long, value_enum, default_value_t = Backend::Auto)]
    pub backend: Backend,

    /// Explicit path to the ffmpeg binary.
    #[arg(long, env = "FFWEB_FFMPEG")]
    pub ffmpeg: Option<PathBuf>,

    /// Explicit path to the ffprobe binary.
    #[arg(long, env = "FFWEB_FFPROBE")]
    pub ffprobe: Option<PathBuf>,

    /// How many jobs may encode at the same time.
    #[arg(short, long, default_value_t = 1)]
    pub jobs: usize,

    /// Open the UI in a browser on startup.
    #[arg(long, default_value_t = true, overrides_with = "no_open")]
    pub open: bool,

    /// Do not open a browser.
    #[arg(long = "no-open", action = clap::ArgAction::SetTrue)]
    pub no_open: bool,

    /// Refuse any network access; the wasm core must already be cached.
    #[arg(long)]
    pub offline: bool,

    /// Allow absolute and relative paths in job arguments instead of placeholders only.
    #[arg(long)]
    pub unsafe_args: bool,

    /// Disable the access token that guards the API.
    #[arg(long = "no-token", action = clap::ArgAction::SetTrue)]
    pub no_token: bool,

    /// Files to preload into the UI.
    pub files: Vec<PathBuf>,
}

impl ServeArgs {
    pub fn should_open(&self) -> bool {
        self.open && !self.no_open
    }
}
