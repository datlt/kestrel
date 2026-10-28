//! Tauri commands for the `lsp` feature: start, talk to and stop language servers.
//! The protocol work happens in the frontend. Here we only move messages.

use super::{Handler, SetupResult};
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use kestrel_lsp::{Callbacks, ExitInfo, Server, SpawnOptions};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{App, AppHandle, Manager, State, Window};

struct Entry {
    window: String,
    server: Arc<Server>,
}

#[derive(Default)]
struct LspState {
    servers: Mutex<HashMap<String, Entry>>,
    next: AtomicU64,
    /// Stop threads of closed windows. `on_exit` waits for them, so no server
    /// stays alive when the app quits while a stop is still running.
    stopping: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

/// Events for the output panel and for crash handling.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LspEvent {
    /// New stderr lines (sent in batches).
    Stderr { lines: Vec<String> },
    /// The process ended. `stopped` is true when we stopped it on purpose.
    Exit { code: Option<i32>, signal: Option<i32>, stopped: bool },
}

#[derive(Serialize)]
struct StartResult {
    key: String,
}

/// Collects stderr lines and sends them to the frontend at most every 50 ms.
struct LineBatcher {
    pending: Mutex<(Vec<String>, bool)>,
    events: Channel<LspEvent>,
}

impl LineBatcher {
    fn push(self: &Arc<Self>, line: String) {
        let schedule = {
            let mut p = self.pending.lock();
            p.0.push(line);
            !std::mem::replace(&mut p.1, true)
        };
        if schedule {
            let me = self.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                me.flush();
            });
        }
    }

    fn flush(&self) {
        let lines = {
            let mut p = self.pending.lock();
            p.1 = false;
            std::mem::take(&mut p.0)
        };
        if !lines.is_empty() {
            let _ = self.events.send(LspEvent::Stderr { lines });
        }
    }
}

/// Resolves the program: a path is used as it is, a bare name is searched in the login-shell PATH.
fn resolve_program(program: &str) -> Option<PathBuf> {
    if program.contains('/') || program.contains('\\') {
        let p = PathBuf::from(program);
        return p.exists().then_some(p);
    }
    kestrel_common::process::find_program(program)
}

fn is_jdtls(server_id: &str, program: &str) -> bool {
    let name = Path::new(program).file_stem().and_then(|s| s.to_str()).unwrap_or("");
    server_id == "jdtls" || name.eq_ignore_ascii_case("jdtls")
}

#[tauri::command]
async fn lsp_start(
    app: AppHandle,
    window: Window,
    server_id: String,
    root: String,
    command: Vec<String>,
    env: Option<HashMap<String, String>>,
    channel: Channel<String>,
    events: Channel<LspEvent>,
) -> Result<StartResult> {
    let Some(program) = command.first().cloned() else {
        return Err(Error::invalid("the server command is empty"));
    };
    let mut args: Vec<String> = command[1..].to_vec();
    // jdtls keeps its project index in a `-data` folder. One folder per project root.
    // The folder is created later, on the worker thread (it touches the disk).
    let mut data_dir: Option<PathBuf> = None;
    if is_jdtls(&server_id, &program) && !args.iter().any(|a| a == "-data") {
        let cache = app.path().app_cache_dir().map_err(|e| Error::internal(e.to_string()))?;
        let dir = cache.join("jdtls").join(kestrel_lsp::root_hash(&root));
        args.push("-data".into());
        args.push(dir.to_string_lossy().into_owned());
        data_dir = Some(dir);
    }
    let label = window.label().to_string();
    let env: Vec<(String, String)> = env.unwrap_or_default().into_iter().collect();

    let server = tauri::async_runtime::spawn_blocking(move || -> Result<Server> {
        if let Some(dir) = &data_dir {
            std::fs::create_dir_all(dir)?;
        }
        let Some(path) = resolve_program(&program) else {
            return Err(Error::new(codes::SERVER_MISSING, format!("`{program}` was not found in PATH")));
        };
        let mut opts = SpawnOptions::new(path.to_string_lossy().into_owned(), args);
        opts.env = env;
        let root_path = PathBuf::from(&root);
        if root_path.is_dir() {
            opts.cwd = Some(root_path);
        }
        let batcher = Arc::new(LineBatcher { pending: Mutex::new((Vec::new(), false)), events: events.clone() });
        let on_stderr_batcher = batcher.clone();
        let callbacks = Callbacks {
            on_message: Box::new(move |m| {
                let _ = channel.send(m);
            }),
            on_stderr: Box::new(move |line| on_stderr_batcher.push(line)),
            on_exit: Box::new(move |info: ExitInfo| {
                batcher.flush();
                let _ = events.send(LspEvent::Exit { code: info.code, signal: info.signal, stopped: info.stopped });
            }),
        };
        Server::start(opts, callbacks).map_err(|e| Error::new(codes::IO, format!("cannot start `{program}`: {e}")))
    })
    .await
    .map_err(|e| Error::internal(e.to_string()))??;

    let state = app.state::<LspState>();
    let key = format!("lsp-{}", state.next.fetch_add(1, Ordering::Relaxed) + 1);
    let server = Arc::new(server);
    state.servers.lock().insert(key.clone(), Entry { window: label.clone(), server: server.clone() });
    // The window may have closed while the server was starting. Its cleanup ran
    // before the insert above, so nobody would stop this server. Stop it here.
    if app.get_webview_window(&label).is_none() {
        state.servers.lock().remove(&key);
        let _ = tauri::async_runtime::spawn_blocking(move || server.stop()).await;
        return Err(Error::cancelled());
    }
    Ok(StartResult { key })
}

/// Sync on purpose: commands that are not `async` run in order on one thread,
/// and the order of LSP messages matters. The work is only a queue push.
#[tauri::command]
fn lsp_send(state: State<'_, LspState>, key: String, message: String) -> Result<()> {
    let server = state.servers.lock().get(&key).map(|e| e.server.clone());
    match server {
        Some(s) => Ok(s.send(&message)?),
        None => Err(Error::not_found(format!("no language server with key {key}"))),
    }
}

#[tauri::command]
async fn lsp_stop(state: State<'_, LspState>, key: String) -> Result<()> {
    let entry = state.servers.lock().remove(&key);
    if let Some(e) = entry {
        let server = e.server;
        let _ = tauri::async_runtime::spawn_blocking(move || server.stop()).await;
    }
    Ok(())
}

#[tauri::command]
fn lsp_logs(state: State<'_, LspState>, key: String) -> Vec<String> {
    state.servers.lock().get(&key).map(|e| e.server.logs()).unwrap_or_default()
}

/// `async` because `find_root` reads the disk (it must not run on the main thread).
#[tauri::command]
async fn lsp_find_root(file: String, markers: Vec<String>, workspace_root: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        kestrel_lsp::find_root(Path::new(&file), &markers, Path::new(&workspace_root))
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn lsp_which(program: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || resolve_program(&program).map(|p| p.to_string_lossy().into_owned()))
        .await
        .ok()
        .flatten()
}

#[derive(Deserialize)]
struct LineRequest {
    path: String,
    /// 0-based line numbers.
    lines: Vec<usize>,
}

/// Returns the text of some lines of some files (for the list of references).
/// The result has one list per request, with one string per requested line.
/// Unreadable files give empty strings. Files over 8 MB are skipped.
#[tauri::command]
async fn lsp_read_lines(requests: Vec<LineRequest>) -> Vec<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        requests
            .into_iter()
            .map(|r| {
                let text = match std::fs::metadata(&r.path) {
                    Ok(m) if m.len() <= 8 * 1024 * 1024 => std::fs::read(&r.path).ok(),
                    _ => None,
                };
                let text = text.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                let all: Vec<&str> = text.lines().collect();
                r.lines.iter().map(|i| all.get(*i).map(|l| clip(l.trim())).unwrap_or_default()).collect()
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

fn clip(s: &str) -> String {
    s.chars().take(300).collect()
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        lsp_start,
        lsp_send,
        lsp_stop,
        lsp_logs,
        lsp_find_root,
        lsp_which,
        lsp_read_lines
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(LspState::default());
    Ok(())
}

/// Starts one thread per server to stop it. The caller keeps the handles.
fn stop_all(servers: Vec<Arc<Server>>) -> Vec<std::thread::JoinHandle<()>> {
    servers.into_iter().map(|s| std::thread::spawn(move || s.stop())).collect()
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<LspState>() else { return };
    let mut map = state.servers.lock();
    let keys: Vec<String> = map.iter().filter(|(_, e)| e.window == label).map(|(k, _)| k.clone()).collect();
    let servers: Vec<_> = keys.iter().filter_map(|k| map.remove(k)).map(|e| e.server).collect();
    drop(map);
    let handles = stop_all(servers);
    let mut pending = state.stopping.lock();
    pending.retain(|h| !h.is_finished());
    pending.extend(handles);
}

pub fn on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<LspState>() else { return };
    let servers: Vec<_> = state.servers.lock().drain().map(|(_, e)| e.server).collect();
    let mut handles = stop_all(servers);
    handles.extend(state.stopping.lock().drain(..));
    for h in handles {
        let _ = h.join();
    }
}
