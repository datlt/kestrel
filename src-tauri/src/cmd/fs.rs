//! Tauri commands for files and workspaces (`fs_*` and `ws_*`).
//! The logic lives in `crates/kestrel-fs`. This file handles arguments,
//! threads, the watcher per window and root, and new windows.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result, roots};
use kestrel_fs::store::RecentFolder;
use kestrel_fs::{DirEntry, FsChange, LineEnding, ListOptions, Store, Watcher, WriteOptions, WriteResult};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::{Request, Response};
use tauri::{App, AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const FS_CHANGED_EVENT: &str = "kestrel://fs-changed";

/// One folder that a workbench of a window has open, with its watcher.
struct OpenRoot {
    _watcher: Option<Watcher>,
}

/// A window can show several workbenches, each with its own folder.
/// The key is the window label and the normalized root.
type RootKey = (String, PathBuf);

struct Inner {
    store: Store,
    /// Open folders per window label and root.
    windows: Mutex<HashMap<RootKey, OpenRoot>>,
    /// Folders that we already allowed for the preview protocol after a file read.
    allowed_parents: Mutex<HashSet<PathBuf>>,
    window_counter: AtomicU64,
}

#[derive(Clone)]
struct FsState(Arc<Inner>);

fn state(app: &AppHandle) -> Arc<Inner> {
    app.state::<FsState>().0.clone()
}

/// Runs blocking work on a worker thread, so the main thread never waits.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::internal(format!("task failed: {e}")))?
}

/// Accepts only absolute paths for commands that change the disk. A relative path
/// would be resolved against the working folder of the app, which is never what the user means.
fn abs(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        Ok(p)
    } else {
        Err(Error::invalid(format!("path is not absolute: {path}")))
    }
}

// --- Files -----------------------------------------------------------------

#[tauri::command]
async fn fs_read_file(app: AppHandle, path: String, encoding: Option<String>, max_bytes: u64) -> Result<Response> {
    let st = state(&app);
    let bytes = blocking(move || {
        let p = PathBuf::from(&path);
        let out = kestrel_fs::read_file(&p, encoding.as_deref(), max_bytes)?;
        // Never allow a disk root (`/` or `C:\`): that would open the whole disk to the preview protocol.
        if let Some(parent) = p.parent().filter(|d| d.parent().is_some()) {
            if st.allowed_parents.lock().insert(parent.to_path_buf()) {
                roots::allow(parent);
            }
        }
        out.into_wire()
    })
    .await?;
    Ok(Response::new(bytes))
}

fn percent_decode(s: &str) -> Result<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|_| Error::invalid("bad x-path"))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| Error::invalid("bad x-path"))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| Error::invalid("x-path is not valid UTF-8"))
}

#[tauri::command]
async fn fs_write_file(request: Request<'_>) -> Result<WriteResult> {
    let header = |name: &str| -> Result<String> {
        let v = request.headers().get(name).ok_or_else(|| Error::invalid(format!("missing header {name}")))?;
        Ok(v.to_str().map_err(|_| Error::invalid(format!("bad header {name}")))?.to_string())
    };
    let path = abs(&percent_decode(&header("x-path")?)?)?;
    let line_ending = LineEnding::parse(&header("x-line-ending")?).ok_or_else(|| Error::invalid("bad x-line-ending"))?;
    let expected = header("x-expected-mtime")?;
    let opts = WriteOptions {
        encoding: header("x-encoding")?,
        bom: header("x-bom")? == "1",
        line_ending,
        expected_mtime_ms: if expected.is_empty() {
            None
        } else {
            Some(expected.parse::<i64>().map_err(|_| Error::invalid("bad x-expected-mtime"))?)
        },
    };
    let text = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => String::from_utf8(bytes.clone()).map_err(|_| Error::invalid("body is not valid UTF-8"))?,
        tauri::ipc::InvokeBody::Json(_) => return Err(Error::invalid("expected a raw body")),
    };
    blocking(move || kestrel_fs::write_file(&path, &text, &opts)).await
}

#[tauri::command]
async fn fs_stat(path: String) -> Result<kestrel_fs::StatResult> {
    blocking(move || Ok(kestrel_fs::stat(Path::new(&path)))).await
}

#[tauri::command]
async fn fs_list_dir(dir: String, root: String, compact: Option<bool>, exclude: Option<Vec<String>>) -> Result<Vec<DirEntry>> {
    let opts = ListOptions { compact: compact.unwrap_or(false), exclude: exclude.unwrap_or_default() };
    blocking(move || kestrel_fs::list_dir_with(Path::new(&dir), Path::new(&root), &opts)).await
}

#[tauri::command]
async fn fs_create_file(path: String) -> Result<()> {
    let path = abs(&path)?;
    blocking(move || kestrel_fs::create_file(&path)).await
}

#[tauri::command]
async fn fs_create_dir(path: String) -> Result<()> {
    let path = abs(&path)?;
    blocking(move || kestrel_fs::create_dir(&path)).await
}

#[tauri::command]
async fn fs_rename(from: String, to: String) -> Result<()> {
    let (from, to) = (abs(&from)?, abs(&to)?);
    blocking(move || kestrel_fs::rename(&from, &to)).await
}

#[tauri::command]
async fn fs_delete(path: String, permanent: Option<bool>) -> Result<()> {
    let path = abs(&path)?;
    blocking(move || kestrel_fs::delete(&path, permanent.unwrap_or(false))).await
}

// --- Workspace -------------------------------------------------------------

#[derive(Serialize)]
struct OpenResult {
    root: String,
    name: String,
}

fn folder_name(root: &Path) -> String {
    root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().into_owned())
}

/// Stops the watcher of one folder of a window and removes the folder from the preview allow list.
fn release(inner: &Inner, label: &str, root: &Path) {
    let old = inner.windows.lock().remove(&(label.to_string(), root.to_path_buf()));
    if old.is_some() {
        roots::disallow(root);
    }
}

/// Does `release` for every folder of a window.
fn release_all(inner: &Inner, label: &str) {
    let keys: Vec<RootKey> = inner.windows.lock().keys().filter(|k| k.0 == label).cloned().collect();
    for (label, root) in keys {
        release(inner, &label, &root);
    }
}

#[tauri::command]
async fn ws_open(app: AppHandle, window: WebviewWindow, root: String) -> Result<OpenResult> {
    let st = state(&app);
    let label = window.label().to_string();
    blocking(move || {
        let root = kestrel_common::paths::normalize(Path::new(&root));
        if !root.is_dir() {
            return Err(Error::not_found(format!("{} is not a folder", root.display())));
        }
        // Opening the same folder again in this window replaces the old watcher.
        release(&st, &label, &root);
        roots::allow(&root);
        let emit_app = app.clone();
        let emit_label = label.clone();
        let watcher = Watcher::start(
            &root,
            Arc::new(move |change: FsChange| {
                let _ = emit_app.emit_to(EventTarget::webview_window(emit_label.clone()), FS_CHANGED_EVENT, change);
            }),
        );
        // A folder that cannot be watched still opens. The tree just does not refresh by itself.
        let watcher = match watcher {
            Ok(w) => Some(w),
            Err(e) => {
                log::warn!("cannot watch {}: {e}", root.display());
                None
            }
        };
        let name = folder_name(&root);
        let path = root.to_string_lossy().into_owned();
        st.windows.lock().insert((label, root), OpenRoot { _watcher: watcher });
        if let Err(e) = st.store.recent_add(&path, &name) {
            log::warn!("cannot save recent folders: {e}");
        }
        Ok(OpenResult { root: path, name })
    })
    .await
}

/// Closes one folder of this window. Without `root`, closes all folders of the window.
#[tauri::command]
async fn ws_close(app: AppHandle, window: WebviewWindow, root: Option<String>) -> Result<()> {
    let st = state(&app);
    match root {
        Some(root) => release(&st, window.label(), &kestrel_common::paths::normalize(Path::new(&root))),
        None => release_all(&st, window.label()),
    }
    Ok(())
}

/// Percent-encodes a string for a URL query value.
fn encode_query(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[tauri::command]
async fn ws_new_window(app: AppHandle, root: Option<String>) -> Result<String> {
    let st = state(&app);
    let label = loop {
        let n = st.window_counter.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("win-{n}");
        if app.get_webview_window(&label).is_none() {
            break label;
        }
    };
    let url = match root {
        Some(r) => format!("index.html?root={}", encode_query(&r)),
        None => "index.html".to_string(),
    };
    // Same settings as the main window in tauri.conf.json.
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Kestrel")
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 320.0)
        .visible(false)
        .background_color(tauri::window::Color(0x1f, 0x20, 0x23, 0xff))
        .zoom_hotkeys_enabled(false);
    // On macOS the tab strip is in the title bar, as in tauri.conf.json.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0));
    builder
        .build()
        .map_err(|e| Error::internal(format!("cannot create window: {e}")))?;
    Ok(label)
}

#[derive(Serialize)]
struct LaunchTarget {
    /// `folder` or `file`.
    kind: &'static str,
    path: String,
}

/// The folder or file from the command line. Only the main window gets it.
#[tauri::command]
async fn ws_launch_args(window: WebviewWindow) -> Result<Option<LaunchTarget>> {
    if window.label() != "main" {
        return Ok(None);
    }
    blocking(|| {
        for arg in std::env::args().skip(1) {
            // Skip flags and the `-psn_...` argument that macOS can add.
            if arg.starts_with('-') {
                continue;
            }
            let p = kestrel_common::paths::normalize(Path::new(&arg));
            if p.is_dir() {
                return Ok(Some(LaunchTarget { kind: "folder", path: p.to_string_lossy().into_owned() }));
            }
            if p.is_file() {
                return Ok(Some(LaunchTarget { kind: "file", path: p.to_string_lossy().into_owned() }));
            }
        }
        Ok(None)
    })
    .await
}

// --- Saved state -----------------------------------------------------------

#[tauri::command]
async fn ws_recent_list(app: AppHandle) -> Result<Vec<RecentFolder>> {
    let st = state(&app);
    blocking(move || Ok(st.store.recent_list().into_iter().filter(|r| Path::new(&r.path).is_dir()).collect())).await
}

#[tauri::command]
async fn ws_recent_remove(app: AppHandle, path: String) -> Result<()> {
    let st = state(&app);
    blocking(move || st.store.recent_remove(&path)).await
}

#[tauri::command]
async fn ws_session_load(app: AppHandle, root: String) -> Result<Value> {
    let st = state(&app);
    blocking(move || Ok(st.store.session_load(&root))).await
}

#[tauri::command]
async fn ws_session_save(app: AppHandle, root: String, session: Value) -> Result<()> {
    let st = state(&app);
    blocking(move || st.store.session_save(&root, &session)).await
}

#[tauri::command]
async fn ws_global_load(app: AppHandle) -> Result<Map<String, Value>> {
    let st = state(&app);
    blocking(move || Ok(st.store.global_load())).await
}

#[tauri::command]
async fn ws_global_patch(app: AppHandle, patch: Map<String, Value>) -> Result<()> {
    let st = state(&app);
    blocking(move || st.store.global_patch(patch)).await
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        fs_read_file,
        fs_write_file,
        fs_stat,
        fs_list_dir,
        fs_create_file,
        fs_create_dir,
        fs_rename,
        fs_delete,
        ws_open,
        ws_close,
        ws_new_window,
        ws_launch_args,
        ws_recent_list,
        ws_recent_remove,
        ws_session_load,
        ws_session_save,
        ws_global_load,
        ws_global_patch,
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    let dir = app.path().app_data_dir().map_err(|e| Error::internal(e.to_string()))?;
    app.manage(FsState(Arc::new(Inner {
        store: Store::new(dir),
        windows: Mutex::new(HashMap::new()),
        allowed_parents: Mutex::new(HashSet::new()),
        window_counter: AtomicU64::new(0),
    })));
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(st) = app.try_state::<FsState>() {
        release_all(&st.0, label);
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(st) = app.try_state::<FsState>() {
        let all: Vec<RootKey> = st.0.windows.lock().keys().cloned().collect();
        for (label, root) in all {
            release(&st.0, &label, &root);
        }
    }
}
