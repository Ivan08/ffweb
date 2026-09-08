//! ffweb: a local web interface for ffmpeg.
//!
//! The binary is a thin wrapper around this library; the split exists so the
//! integration tests can start a real server in-process.

pub mod caps;
pub mod cli;
pub mod dropbox;
pub mod fsapi;
pub mod jobs;
pub mod native;
pub mod paths;
pub mod probe;
pub mod server;
pub mod state;
pub mod thumbs;
pub mod validate;
pub mod wasmcache;
