//! The HTTP surface, against a real server.
//!
//! Two of the faults this covers were found by hand rather than by a test: the
//! access token used the same `t` query parameter as the thumbnail timestamp,
//! so every thumbnail request was rejected; and the job event stream stayed
//! open after a job finished, so the browser reconnected to it forever. Both
//! would sail past a unit test of any single function.

use std::path::PathBuf;
use std::sync::Arc;

/// Start a server on a free port and return its base URL.
async fn serve(token: Option<String>) -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let base = std::fs::canonicalize(dir.path()).expect("canonical");
    let browse = base.join("browse");
    let out = base.join("out");
    let drop = base.join("drop");
    std::fs::create_dir_all(&browse).expect("create");
    std::fs::write(browse.join("clip.txt"), b"0123456789").expect("write");
    std::fs::create_dir_all(browse.join("sub")).expect("create");
    make_tiny_clip(&browse.join("tiny.mp4"));

    let state = build_state(browse, out, drop, &base, token);
    let app = ffweb::server::router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), dir)
}

/// A fraction of a second of video, when there is an ffmpeg to make it with.
fn make_tiny_clip(path: &std::path::Path) {
    let Some(ffmpeg) = ffweb::caps::Capabilities::detect(None, None).ffmpeg_path else {
        return;
    };
    let _ = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=1"])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(path)
        .status();
}

fn build_state(
    browse: PathBuf,
    out: PathBuf,
    drop: PathBuf,
    scratch: &std::path::Path,
    token: Option<String>,
) -> Arc<ffweb::state::AppState> {
    let caps = Arc::new(ffweb::caps::Capabilities::detect(None, None));
    let roots = ffweb::paths::Roots::new(browse, out, drop.clone()).expect("roots");
    // Inside the test's own temporary directory, like the scratch: reaching
    // into the shared one left a cache behind for every run.
    let cache_dir = scratch.join("thumbs");
    Arc::new(ffweb::state::AppState {
        jobs: ffweb::jobs::JobStore::new(1, caps.ffmpeg_path.clone()),
        cache: ffweb::wasmcache::WasmCache::new(true).expect("cache"),
        // Inside the test's own temporary directory, so it goes when that does.
        dropbox: ffweb::dropbox::Dropbox::create_in(scratch).expect("dropbox"),
        thumbs: ffweb::thumbs::ThumbCache::new(&cache_dir).expect("thumbs"),
        caps,
        roots,
        backend: ffweb::cli::Backend::Auto,
        unsafe_args: false,
        token,
        preload: Vec::new(),
        dev_assets: None,
    })
}

async fn get(url: &str) -> reqwest::Response {
    reqwest::Client::new()
        .get(url)
        .send()
        .await
        .expect("request")
}

#[tokio::test]
async fn sends_the_headers_that_make_sharedarraybuffer_available() {
    let (base, _dir) = serve(None).await;
    let response = get(&format!("{base}/api/capabilities")).await;
    let headers = response.headers();
    // Without cross-origin isolation the browser withholds SharedArrayBuffer
    // and the multi-threaded wasm core cannot load at all.
    assert_eq!(headers["cross-origin-opener-policy"], "same-origin");
    assert_eq!(headers["cross-origin-embedder-policy"], "require-corp");
}

#[tokio::test]
async fn describes_what_the_machine_can_do() {
    let (base, _dir) = serve(None).await;
    let body: serde_json::Value = get(&format!("{base}/api/capabilities"))
        .await
        .json()
        .await
        .expect("json");
    assert!(body["native"]["available"].is_boolean());
    assert!(body["roots"]["browse"].is_string());
    assert!(body["wasm"]["coreVersion"].is_string());
}

#[tokio::test]
async fn lists_a_directory_and_refuses_to_leave_the_root() {
    let (base, _dir) = serve(None).await;
    let listing: serde_json::Value = get(&format!("{base}/api/fs"))
        .await
        .json()
        .await
        .expect("json");
    let names: Vec<&str> = listing["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| e["name"].as_str().expect("name"))
        .collect();
    assert!(names.contains(&"clip.txt"));
    assert!(names.contains(&"sub"));

    let escaped = get(&format!("{base}/api/fs?path=/etc")).await;
    assert_eq!(escaped.status(), 400, "the browse root is a boundary");
}

#[tokio::test]
async fn serves_a_file_and_answers_range_requests() {
    let (base, _dir) = serve(None).await;
    let url = format!("{base}/api/file?path=clip.txt");

    let whole = get(&url).await;
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.text().await.expect("body"), "0123456789");

    // `<video>` seeks with range requests; without them scrubbing is broken.
    let part = reqwest::Client::new()
        .get(&url)
        .header("Range", "bytes=2-5")
        .send()
        .await
        .expect("request");
    assert_eq!(part.status(), 206);
    assert_eq!(part.text().await.expect("body"), "2345");
}

#[tokio::test]
async fn refuses_to_serve_a_file_outside_the_roots() {
    let (base, _dir) = serve(None).await;
    for attempt in ["/etc/passwd", "../../etc/passwd"] {
        let response = get(&format!(
            "{base}/api/file?path={}",
            urlencoding::encode(attempt)
        ))
        .await;
        assert_eq!(response.status(), 400, "`{attempt}` was served");
    }
}

#[tokio::test]
async fn guards_the_api_with_the_access_token() {
    let (base, _dir) = serve(Some("secret".into())).await;

    // Loopback is reachable from any page the user happens to visit.
    assert_eq!(get(&format!("{base}/api/capabilities")).await.status(), 401);
    assert_eq!(
        get(&format!("{base}/api/capabilities?token=wrong"))
            .await
            .status(),
        401
    );
    assert_eq!(
        get(&format!("{base}/api/capabilities?token=secret"))
            .await
            .status(),
        200
    );

    let with_header = reqwest::Client::new()
        .get(format!("{base}/api/capabilities"))
        .header("Authorization", "Bearer secret")
        .send()
        .await
        .expect("request");
    assert_eq!(with_header.status(), 200);
}

#[tokio::test]
async fn hands_out_a_cookie_so_the_token_is_needed_only_once() {
    let (base, _dir) = serve(Some("secret".into())).await;

    let first = get(&format!("{base}/api/capabilities?token=secret")).await;
    let cookie = first
        .headers()
        .get("set-cookie")
        .expect("the token should come back as a cookie")
        .to_str()
        .expect("ascii")
        .to_string();
    assert!(cookie.contains("ffweb_token=secret"));
    // Same-site only: another site must not be able to send it along.
    assert!(cookie.contains("SameSite=Strict"), "cookie was {cookie}");

    // From here on the cookie carries the token, so a reload needs no URL.
    let second = reqwest::Client::new()
        .get(format!("{base}/api/capabilities"))
        .header("Cookie", cookie.split(';').next().expect("name=value"))
        .send()
        .await
        .expect("request");
    assert_eq!(second.status(), 200);
}

#[tokio::test]
async fn does_not_confuse_the_token_with_another_parameter_named_t() {
    let (base, _dir) = serve(Some("secret".into())).await;
    // The thumbnail endpoint takes `t` for the timestamp. Naming the token `t`
    // too made the server compare the token against `2.5` and refuse every
    // thumbnail — a fault no single-endpoint test would have shown.
    let response = get(&format!(
        "{base}/api/thumb?path=clip.txt&t=2.5&w=200&token=secret"
    ))
    .await;
    assert_ne!(
        response.status(),
        401,
        "the timestamp was mistaken for the token"
    );
}

#[tokio::test]
async fn refuses_a_request_from_another_origin() {
    let (base, _dir) = serve(Some("secret".into())).await;
    let response = reqwest::Client::new()
        .get(format!("{base}/api/capabilities"))
        .header("Authorization", "Bearer secret")
        .header("Origin", "https://evil.example")
        .send()
        .await
        .expect("request");
    // A page elsewhere can hold the cookie but cannot forge the origin.
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn refuses_a_job_that_names_a_path_directly() {
    let (base, _dir) = serve(None).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/api/jobs"))
        .json(&serde_json::json!({
            "inputs": [], "args": ["-i", "/etc/passwd", "@out"], "output": "x.mp4"
        }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), 400);
    let body: serde_json::Value = response.json().await.expect("json");
    assert!(body["error"]
        .as_str()
        .expect("error")
        .contains("placeholder"));
}

#[tokio::test]
async fn refuses_a_job_with_fewer_inputs_than_it_references() {
    let (base, _dir) = serve(None).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/api/jobs"))
        .json(&serde_json::json!({
            "inputs": ["clip.txt"], "args": ["-i", "@in0", "-i", "@in1", "@out"], "output": "x.mp4"
        }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn reports_an_unknown_job() {
    let (base, _dir) = serve(None).await;
    assert_eq!(get(&format!("{base}/api/jobs/nope")).await.status(), 404);
    assert_eq!(
        get(&format!("{base}/api/jobs/nope/events")).await.status(),
        404
    );
}

#[tokio::test]
async fn ends_the_event_stream_when_the_job_ends() {
    let (base, dir) = serve(None).await;
    let _ = dir;
    if ffweb::caps::Capabilities::detect(None, None)
        .ffmpeg_path
        .is_none()
    {
        eprintln!("skipping: no ffmpeg on this machine");
        return;
    }

    let created: serde_json::Value = reqwest::Client::new()
        .post(format!("{base}/api/jobs"))
        .json(&serde_json::json!({
            "inputs": ["tiny.mp4"],
            "args": ["-i", "@in0", "-frames:v", "1", "@out"],
            "output": "frame.png",
            "duration": 1.0
        }))
        .send()
        .await
        .expect("request")
        .json()
        .await
        .expect("json");
    let id = created["id"]
        .as_str()
        .unwrap_or_else(|| panic!("job was refused: {created}"))
        .to_string();

    // The stream has to close by itself. Left open, the browser's EventSource
    // reconnects to a finished job for as long as the page is up.
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        get(&format!("{base}/api/jobs/{id}/events")).await.text(),
    )
    .await
    .expect("the event stream never closed")
    .expect("body");

    assert!(body.contains("\"type\":\"state\""));
    assert!(
        body.contains("\"state\":\"done\"") || body.contains("\"state\":\"failed\""),
        "the stream ended without a terminal state: {body}"
    );
}

#[tokio::test]
async fn falls_back_to_the_shell_page_for_an_unknown_route() {
    let (base, _dir) = serve(None).await;
    let response = get(&format!("{base}/some/deep/route")).await;
    // Either the embedded interface or the explanation that it was not built.
    assert!(response.status() == 200 || response.status() == 404);
}

/// The tests must not leave anything in the shared temporary directory.
///
/// Every server built here used to take its scratch and its frame cache from
/// `std::env::temp_dir()` and never remove them, so a run left one directory
/// per test lying about — a hundred and sixty-nine of them had piled up before
/// anybody looked.
#[tokio::test]
async fn leaves_nothing_in_the_shared_temporary_directory() {
    let before = shared_leftovers();
    {
        let (base, _dir) = serve(None).await;
        let response = get(&format!("{base}/api/capabilities")).await;
        assert_eq!(response.status(), 200);
    }
    assert_eq!(
        shared_leftovers(),
        before,
        "a test server left scratch behind in {}",
        std::env::temp_dir().display()
    );
}

fn shared_leftovers() -> usize {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("ffweb-drop-") || name.starts_with("ffweb-test-thumbs-")
        })
        .count()
}
