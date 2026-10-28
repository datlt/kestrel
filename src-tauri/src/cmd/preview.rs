//! Tauri commands for the `preview` feature (markdown render, `preview://` protocol).
//! Command names must start with `md_` or `preview_`.

use super::{Handler, SetupResult};
use kestrel_common::Result;
use kestrel_markdown::{ByteRange, decode_uri_path, mime_for, parse_range};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{App, AppHandle, Builder, Wry};

/// Renders markdown to HTML on a worker thread.
#[tauri::command]
async fn md_render(text: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || kestrel_markdown::render(&text))
        .await
        .map_err(|e| kestrel_common::Error::internal(e.to_string()))
}

/// Lets the protocol serve files in the folder of `path`. The image viewer calls
/// it for images that are outside the open folder. One call per folder and
/// window session is enough, so the list below stops repeated counting.
///
/// It is `async` because `normalize` reads the disk (it must not run on the main thread).
#[tauri::command]
async fn preview_allow_parent(path: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        static DONE: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashSet<std::path::PathBuf>>> =
            std::sync::OnceLock::new();
        // Never allow a disk root (`/` or `C:\`): that would open the whole disk.
        let Some(dir) = Path::new(&path).parent().filter(|d| d.parent().is_some()) else { return };
        let dir = kestrel_common::paths::normalize(dir);
        let done = DONE.get_or_init(Default::default);
        if done.lock().insert(dir.clone()) {
            kestrel_common::roots::allow(&dir);
        }
    })
    .await;
}

/// Text of HTML previews with scripts on, by preview id. The frame loads it
/// with `?kestrel-live=<id>` at the URL of the real file, so relative links
/// work, and it gets its own CSP (a `srcdoc` frame would get the strict CSP
/// of the main window, which blocks inline scripts).
///
/// Each entry remembers the window label. When a window closes, its entries are
/// removed, because the page may not call `preview_drop_live` before it dies.
type LiveDocs = std::collections::HashMap<String, (String, Vec<u8>)>;

fn live_docs() -> &'static parking_lot::Mutex<LiveDocs> {
    static LIVE: std::sync::OnceLock<parking_lot::Mutex<LiveDocs>> = std::sync::OnceLock::new();
    LIVE.get_or_init(Default::default)
}

#[tauri::command]
fn preview_set_live(window: tauri::Window, id: String, html: String) {
    live_docs().lock().insert(id, (window.label().to_string(), html.into_bytes()));
}

#[tauri::command]
fn preview_drop_live(id: String) {
    live_docs().lock().remove(&id);
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![md_render, preview_allow_parent, preview_set_live, preview_drop_live])
}

/// Registers the `preview://` URI scheme on the builder.
pub fn register_protocol(builder: Builder<Wry>) -> Builder<Wry> {
    builder.register_asynchronous_uri_scheme_protocol("preview", |_ctx, request, responder| {
        // File reads can be slow, so they never run on the main thread.
        // The shared pool limits the threads: a page with 500 images must not start 500 threads.
        tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&request)));
    })
}

/// CSP of the live HTML document (scripts on).
const LIVE_CSP: &str = "default-src * data: blob: preview: 'unsafe-inline' 'unsafe-eval'";

/// Biggest file that we send without a Range header.
const MAX_FULL_BYTES: u64 = 64 * 1024 * 1024;
/// Biggest part that we send for one Range request.
const MAX_PART_BYTES: u64 = 32 * 1024 * 1024;

/// Headers for every answer of the protocol.
///
/// There is no general `Access-Control-Allow-Origin` header on purpose. A
/// script in a previewed page runs in an opaque origin, and it must not read
/// other files with `fetch()`. Images, CSS, classic scripts and media still
/// load, because they do not need CORS (see `cors_allowed` for the exception).
/// `nosniff` stops the web view from guessing a script or HTML type for a file
/// that is served as another type.
fn base_headers(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
}

/// Module scripts (`<script type="module">`, `import`) and web fonts load only
/// with CORS, even from the same folder. The page in a sandboxed frame has the
/// origin `null`, so we allow `null` for these file types only. A script can
/// then read `.js` and font files with `fetch()`, but not other files (data,
/// source code of other languages, keys).
fn cors_allowed(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".js", ".mjs", ".cjs", ".woff", ".woff2", ".ttf", ".otf"].iter().any(|ext| lower.ends_with(ext))
}

fn reply(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    base_headers(Response::builder())
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body)
        .unwrap()
}

fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(native) = decode_uri_path(request.uri().path()) else {
        return reply(StatusCode::BAD_REQUEST, b"bad path".to_vec());
    };
    // Use the resolved path (symlinks and `..` removed) for the check and for the read.
    // Then the file we read is the file we checked.
    let resolved = kestrel_common::paths::normalize(Path::new(&native));
    let path = resolved.as_path();
    // Check first, so a web page cannot tell which files exist outside the roots.
    if !kestrel_common::roots::is_allowed(path) {
        return reply(StatusCode::FORBIDDEN, b"forbidden".to_vec());
    }
    let live_id = request
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("kestrel-live=")));
    if let Some(id) = live_id {
        let Some(body) = live_docs().lock().get(id).map(|(_, b)| b.clone()) else {
            return reply(StatusCode::NOT_FOUND, b"no live document".to_vec());
        };
        // The frame is sandboxed without allow-same-origin, so this page
        // cannot reach the app. Inside the frame, the page may run its scripts.
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::CONTENT_SECURITY_POLICY, LIVE_CSP)
            .body(body)
            .unwrap();
    }
    let meta = match std::fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return reply(StatusCode::NOT_FOUND, b"not a file".to_vec()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return reply(StatusCode::NOT_FOUND, b"not found".to_vec()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return reply(StatusCode::FORBIDDEN, b"permission denied".to_vec());
        }
        Err(e) => return reply(StatusCode::INTERNAL_SERVER_ERROR, e.to_string().into_bytes()),
    };
    let size = meta.len();
    let mime = mime_for(&native);
    // The whole body is read into memory. A big file must come in parts (Range requests).
    if size > MAX_FULL_BYTES && request.headers().get(header::RANGE).is_none() {
        return reply(StatusCode::PAYLOAD_TOO_LARGE, b"file too large".to_vec());
    }

    let range_header = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let range = match range_header {
        Some(h) => match parse_range(h, size) {
            // A server may send less than the client asked for. We cap each part,
            // so `bytes=0-` on a 4 GB video does not read 4 GB into memory.
            Some(mut r) => {
                r.end = r.end.min(r.start + (MAX_PART_BYTES - 1));
                Some(r)
            }
            None => {
                return base_headers(Response::builder())
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                    .body(Vec::new())
                    .unwrap();
            }
        },
        None => None,
    };

    let result = match range {
        Some(r) => read_range(path, r),
        None => std::fs::read(path),
    };
    let body = match result {
        Ok(b) => b,
        Err(e) => return reply(StatusCode::INTERNAL_SERVER_ERROR, e.to_string().into_bytes()),
    };

    let mut b = base_headers(Response::builder())
        .header(header::CONTENT_TYPE, mime)
        .header(header::VARY, "Origin")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len());
    if cors_allowed(&native) {
        b = b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null");
    }
    b = match range {
        Some(r) => b
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", r.start, r.end, size)),
        None => b.status(StatusCode::OK),
    };
    b.body(body).unwrap()
}

fn read_range(path: &Path, r: ByteRange) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(r.start))?;
    let mut buf = Vec::new();
    f.take(r.len()).read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn setup(_app: &mut App) -> SetupResult {
    Ok(())
}

pub fn on_window_destroyed(_app: &AppHandle, label: &str) {
    live_docs().lock().retain(|_, (owner, _)| owner != label);
}

pub fn on_exit(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_cors(r: &Response<Vec<u8>>) {
        assert!(r.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert_eq!(r.headers().get(header::X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
    }

    #[test]
    fn cors_only_for_module_scripts_and_fonts() {
        assert!(cors_allowed("/w/app/main.js"));
        assert!(cors_allowed("/w/app/lib.MJS"));
        assert!(cors_allowed("/w/fonts/a.woff2"));
        assert!(!cors_allowed("/w/data.json"));
        assert!(!cors_allowed("/w/Main.kt"));
        assert!(!cors_allowed("/w/.env"));
        assert!(!cors_allowed("/w/page.html"));
    }

    #[test]
    fn error_replies_have_no_cors_and_nosniff() {
        no_cors(&reply(StatusCode::FORBIDDEN, b"forbidden".to_vec()));
        no_cors(&reply(StatusCode::NOT_FOUND, Vec::new()));
    }

    #[test]
    fn base_headers_keep_other_headers() {
        let r = base_headers(Response::builder()).status(StatusCode::OK).header(header::CONTENT_TYPE, "image/png").body(Vec::new()).unwrap();
        no_cors(&r);
        assert_eq!(r.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "image/png");
    }

    #[test]
    fn bad_path_and_forbidden_path_replies() {
        let req = Request::builder().uri("preview://localhost/a/../b").body(Vec::new()).unwrap();
        let r = serve(&req);
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        no_cors(&r);
        // A folder that nobody allowed.
        let req = Request::builder().uri("preview://localhost/kestrel-test-not-allowed/x.txt").body(Vec::new()).unwrap();
        let r = serve(&req);
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        no_cors(&r);
    }

    #[cfg(unix)]
    #[test]
    fn live_document_has_csp_and_no_cors() {
        let dir = std::env::temp_dir().join(format!("kestrel-preview-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = kestrel_common::paths::normalize(&dir);
        kestrel_common::roots::allow(&dir);
        live_docs().lock().insert("t1".into(), ("w".into(), b"<p>x</p>".to_vec()));
        let file = dir.join("a.html");
        std::fs::write(&file, "x").unwrap();
        let uri = format!("preview://localhost{}?kestrel-live=t1", file.to_string_lossy().replace('\\', "/"));
        let r = serve(&Request::builder().uri(uri).body(Vec::new()).unwrap());
        live_docs().lock().remove("t1");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(r.status(), StatusCode::OK);
        no_cors(&r);
        assert!(r.headers().get(header::CONTENT_SECURITY_POLICY).is_some());
    }
}
