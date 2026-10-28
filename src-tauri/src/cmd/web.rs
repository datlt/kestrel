//! Tauri commands for the `web` feature. Owner: web agent. See docs/DESIGN.md section 10.3.
//! Command names start with `web_`.
//!
//! A web tab is a native child web view of the window (`Window::add_child`).
//! It has the label `web-<n>`, where `n` counts up for the whole app. The
//! frontend moves and hides the view, because only the frontend knows where
//! the tab content area is.
//!
//! Safety rules:
//! - Only `http` and `https` addresses open in a web view.
//! - A web view never calls these commands. No capability lists a remote
//!   address, so Tauri blocks the call already. Every command also checks that
//!   the caller is not a `web-*` view.
//! - A window can only change its own web views.
//!
//! Events go to the owning window only, as `kestrel://web` with a `kind` field.

use super::{Handler, SetupResult};
use kestrel_common::error::{Error, Result};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::utils::config::WebviewUrl;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{App, AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, State, Url, Webview};

const EVENT: &str = "kestrel://web";

/// Sites check the user agent. The default one of WKWebView has no "Safari"
/// part, so some sites think it is an unknown browser. Other systems keep
/// the default of their web view.
#[cfg(target_os = "macos")]
const USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
);
#[cfg(not(target_os = "macos"))]
const USER_AGENT: Option<&str> = None;

// ---- State ---------------------------------------------------------------------------------

#[derive(Default)]
pub struct WebState {
    counter: AtomicU64,
    /// Web view label -> label of the window that owns it.
    views: Mutex<HashMap<String, String>>,
    /// Download address -> target file, until the download ends.
    downloads: Mutex<HashMap<String, PathBuf>>,
}

/// What the frontend receives. `label` is the web view label.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum WebEvent {
    /// The address changed.
    Url { label: String, url: String },
    /// The page title changed.
    Title { label: String, title: String },
    /// A page started or finished loading.
    Loading { label: String, loading: bool, url: String },
    /// The page wants a new window. The frontend opens a new web tab.
    Popup { label: String, url: String },
    /// A download started, finished or failed. `state` is `started`, `done` or `failed`.
    Download { label: String, state: &'static str, name: String, path: Option<String> },
}

fn emit(app: &AppHandle, window: &str, event: &WebEvent) {
    let target = EventTarget::AnyLabel { label: window.to_string() };
    if let Err(e) = app.emit_to(target, EVENT, event) {
        log::debug!("web: emit failed: {e}");
    }
}

// ---- Pure helpers (unit tested) -----------------------------------------------------------------

/// Parses an address for a web view. Only http and https are allowed.
fn parse_web_url(text: &str) -> Result<Url> {
    let url = Url::parse(text.trim()).map_err(|e| Error::invalid(format!("Not a valid address: {e}")))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        _ => Err(Error::invalid("Only http and https addresses can open in a web tab.")),
    }
}

/// Schemes that we hand to the system (mail program, phone app).
fn is_external_scheme(scheme: &str) -> bool {
    matches!(scheme, "mailto" | "tel")
}

/// A safe file name for a download: no folders, no leading dots, never empty.
fn safe_file_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() { "download".to_string() } else { cleaned }
}

/// Returns `dir/name`, or `dir/name (2).ext`, `dir/name (3).ext`, ... when the file exists.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn download_name(url: &Url, suggested: &Path) -> String {
    if let Some(name) = suggested.file_name().and_then(|n| n.to_str()) {
        return safe_file_name(name);
    }
    let from_url = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    safe_file_name(from_url)
}

// ---- Commands --------------------------------------------------------------------------------

/// Stops calls that come from a web view. Only Kestrel pages may call.
fn guard(webview: &Webview) -> Result<()> {
    if webview.label().starts_with("web-") {
        return Err(Error::new(kestrel_common::error::codes::PERMISSION_DENIED, "web views cannot call Kestrel commands"));
    }
    Ok(())
}

/// Finds a web view that belongs to the calling window.
fn find(caller: &Webview, state: &WebState, label: &str) -> Result<Webview> {
    guard(caller)?;
    let window = caller.window().label().to_string();
    let owner = state.views.lock().get(label).cloned();
    if owner.as_deref() != Some(window.as_str()) {
        return Err(Error::not_found(format!("no web view {label} in this window")));
    }
    caller.app_handle().get_webview(label).ok_or_else(|| Error::not_found(format!("web view {label} is gone")))
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    let fix = |v: f64| if v.is_finite() { v } else { 0.0 };
    Rect {
        position: LogicalPosition::new(fix(x), fix(y)).into(),
        size: LogicalSize::new(fix(width).max(1.0), fix(height).max(1.0)).into(),
    }
}

/// Creates a web view over the given area (logical pixels, relative to the
/// window content) and returns its label.
#[tauri::command]
async fn web_open(
    webview: Webview,
    state: State<'_, WebState>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String> {
    guard(&webview)?;
    let start = parse_web_url(&url)?;
    let window = webview.window();
    let window_label = window.label().to_string();
    let app = webview.app_handle().clone();
    let label = format!("web-{}", state.counter.fetch_add(1, Ordering::Relaxed) + 1);
    log::debug!("web: create {label} in window {window_label} url={start} at {x},{y} {width}x{height}");

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(start));
    if let Some(ua) = USER_AGENT {
        builder = builder.user_agent(ua);
    }

    // Navigation: http and https go on. mailto and tel go to the system.
    // Everything else (file:, javascript:, custom schemes) is blocked.
    let (a, w, l) = (app.clone(), window_label.clone(), label.clone());
    builder = builder.on_navigation(move |url| {
        if matches!(url.scheme(), "http" | "https" | "about" | "blob" | "data") {
            if url.scheme().starts_with("http") {
                emit(&a, &w, &WebEvent::Url { label: l.clone(), url: url.to_string() });
            }
            return true;
        }
        if is_external_scheme(url.scheme()) {
            open_external(&a, url);
        }
        false
    });

    // window.open() and target=_blank: a new web tab, never a new native window.
    let (a, w, l) = (app.clone(), window_label.clone(), label.clone());
    builder = builder.on_new_window(move |url, _features| {
        if matches!(url.scheme(), "http" | "https") {
            emit(&a, &w, &WebEvent::Popup { label: l.clone(), url: url.to_string() });
        } else if is_external_scheme(url.scheme()) {
            open_external(&a, &url);
        } else {
            log::debug!("web: blocked new window for {}", url.scheme());
        }
        NewWindowResponse::Deny
    });

    let (a, w, l) = (app.clone(), window_label.clone(), label.clone());
    builder = builder.on_page_load(move |_view, payload| {
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        emit(&a, &w, &WebEvent::Loading { label: l.clone(), loading, url: payload.url().to_string() });
    });

    // Single page apps change the address without a page load, but they
    // also change the title most of the time. Send the address with it.
    let (a, w, l) = (app.clone(), window_label.clone(), label.clone());
    builder = builder.on_document_title_changed(move |view, title| {
        if let Ok(url) = view.url() {
            emit(&a, &w, &WebEvent::Url { label: l.clone(), url: url.to_string() });
        }
        emit(&a, &w, &WebEvent::Title { label: l.clone(), title });
    });

    let (a, w, l) = (app.clone(), window_label.clone(), label.clone());
    builder = builder.on_download(move |_view, event| match event {
        DownloadEvent::Requested { url, destination } => {
            let Ok(dir) = a.path().download_dir() else {
                log::debug!("web: no downloads folder, download blocked");
                return false;
            };
            let name = download_name(&url, destination);
            let target = unique_path(&dir, &name);
            log::debug!("web: download {url} -> {}", target.display());
            a.state::<WebState>().downloads.lock().insert(url.to_string(), target.clone());
            *destination = target.clone();
            let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("download").to_string();
            emit(&a, &w, &WebEvent::Download { label: l.clone(), state: "started", name, path: Some(target.display().to_string()) });
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            // macOS does not tell the path when it ends, so use the one we chose.
            let chosen = a.state::<WebState>().downloads.lock().remove(url.as_str());
            let path = path.or(chosen);
            let name = path.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("download").to_string();
            let state = if success { "done" } else { "failed" };
            emit(&a, &w, &WebEvent::Download { label: l.clone(), state, name, path: path.map(|p| p.display().to_string()) });
            true
        }
        _ => true,
    });

    // Register before the build, so early events find the owner.
    state.views.lock().insert(label.clone(), window_label.clone());
    let result = window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0)));
    if let Err(e) = result {
        state.views.lock().remove(&label);
        return Err(Error::internal(format!("could not create the web view: {e}")));
    }
    Ok(label)
}

fn open_external(app: &AppHandle, url: &Url) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        log::debug!("web: could not open {url} in the system: {e}");
    }
}

#[tauri::command]
async fn web_set_bounds(webview: Webview, state: State<'_, WebState>, label: String, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    log::debug!("web: bounds {label} {x:.1},{y:.1} {width:.1}x{height:.1}");
    view.set_bounds(rect(x, y, width, height)).map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_show(webview: Webview, state: State<'_, WebState>, label: String) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    log::debug!("web: show {label}");
    view.show().map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_hide(webview: Webview, state: State<'_, WebState>, label: String) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    log::debug!("web: hide {label}");
    view.hide().map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_navigate(webview: Webview, state: State<'_, WebState>, label: String, url: String) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    let url = parse_web_url(&url)?;
    log::debug!("web: navigate {label} {url}");
    view.navigate(url).map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_back(webview: Webview, state: State<'_, WebState>, label: String) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    view.eval("history.back()").map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_forward(webview: Webview, state: State<'_, WebState>, label: String) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    view.eval("history.forward()").map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_reload(webview: Webview, state: State<'_, WebState>, label: String) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    view.reload().map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_zoom(webview: Webview, state: State<'_, WebState>, label: String, factor: f64) -> Result<()> {
    let view = find(&webview, &state, &label)?;
    let factor = if factor.is_finite() { factor.clamp(0.25, 5.0) } else { 1.0 };
    view.set_zoom(factor).map_err(|e| Error::internal(e.to_string()))
}

#[tauri::command]
async fn web_close(webview: Webview, state: State<'_, WebState>, label: String) -> Result<()> {
    guard(&webview)?;
    // A view that is gone already is fine.
    let Ok(view) = find(&webview, &state, &label) else {
        return Ok(());
    };
    log::debug!("web: close {label}");
    state.views.lock().remove(&label);
    view.close().map_err(|e| Error::internal(e.to_string()))
}

// ---- Wiring ----------------------------------------------------------------------------------

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        web_open,
        web_set_bounds,
        web_show,
        web_hide,
        web_navigate,
        web_back,
        web_forward,
        web_reload,
        web_zoom,
        web_close
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(WebState::default());
    Ok(())
}

/// Closes all web views of a window that is gone.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<WebState>() else {
        return;
    };
    let labels: Vec<String> = {
        let mut views = state.views.lock();
        let mine: Vec<String> = views.iter().filter(|(_, w)| w.as_str() == label).map(|(l, _)| l.clone()).collect();
        for l in &mine {
            views.remove(l);
        }
        mine
    };
    for l in labels {
        log::debug!("web: close {l} (window {label} closed)");
        if let Some(view) = app.get_webview(&l) {
            let _ = view.close();
        }
    }
}

pub fn on_exit(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_open() {
        assert!(parse_web_url("https://chat.example.com/#/").is_ok());
        assert!(parse_web_url("  http://localhost:3000/a ").is_ok());
        assert!(parse_web_url("file:///etc/passwd").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
        assert!(parse_web_url("not a url").is_err());
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(safe_file_name(".hidden"), "hidden");
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(safe_file_name("re:port?.pdf"), "report.pdf");
    }

    #[test]
    fn unique_names_count_up() {
        let dir = std::env::temp_dir().join(format!("kestrel-web-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a.txt"));
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a (2).txt"));
        std::fs::write(dir.join("a (2).txt"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a (3).txt"));
        std::fs::write(dir.join("noext"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "noext"), dir.join("noext (2)"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
