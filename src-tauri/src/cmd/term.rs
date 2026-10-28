//! Tauri commands for the `term` feature: shells in a PTY for the terminal panel.
//! The PTY work is done in `kestrel-term`. Command names start with `term_`.
//!
//! Output goes to the frontend as raw bytes (the JS side gets an `ArrayBuffer`).
//! Sessions are keyed by (window label, id), so a window can only touch its own.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result};
use kestrel_term::{resolve_shell, zsh, Session, SpawnOptions};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{App, AppHandle, Manager, State, Window};

#[derive(Default)]
struct TermState {
    /// Running sessions: (window label, id) -> session.
    sessions: Mutex<HashMap<(String, u64), Arc<Session>>>,
    next_id: AtomicU64,
}

/// Messages sent through the `events` channel of `term_spawn`.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TermEvent {
    Exit { code: i32 },
}

#[derive(Serialize)]
struct SpawnResult {
    id: u64,
    /// The program that runs in the terminal.
    shell: String,
}

fn join_error(e: tauri::Error) -> Error {
    Error::internal(format!("terminal task failed: {e}"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn find_session(state: &TermState, label: &str, id: u64) -> Result<Arc<Session>> {
    state
        .sessions
        .lock()
        .get(&(label.to_string(), id))
        .cloned()
        .ok_or_else(|| Error::not_found(format!("terminal {id} is not running")))
}

/// The folder with the zsh startup files of Kestrel (in the app cache folder). It
/// returns `None` when zsh should not get them: the setting is off, the shell is
/// not zsh, or the files cannot be written. The shell must start in every case.
fn zsh_integration_dir(app: &AppHandle, program: &str, highlight: bool) -> Option<PathBuf> {
    if !highlight || !zsh::is_zsh(program) {
        return None;
    }
    let dir = app.path().app_cache_dir().ok()?.join("shell-integration").join("zsh");
    match zsh::install(&dir) {
        Ok(()) => Some(dir),
        Err(e) => {
            log::warn!("cannot write the zsh files for the terminal colors in {}: {e}", dir.display());
            None
        }
    }
}

/// Starts a shell in `cwd`. Output arrives in `channel` as raw byte batches.
/// `events` gets `{ kind: "exit", code }` when the shell ends.
/// `highlight` is the setting `terminal.highlightCommands` (default true): zsh
/// gets the command line colors.
#[tauri::command]
async fn term_spawn(
    window: Window,
    state: State<'_, TermState>,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    highlight: Option<bool>,
    channel: Channel<InvokeResponseBody>,
    events: Channel<TermEvent>,
) -> Result<SpawnResult> {
    let label = window.label().to_string();
    let app = window.app_handle().clone();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    // Reading the login shell environment can wait for a few seconds, so this
    // runs on a worker thread and not on the main thread.
    let started = tauri::async_runtime::spawn_blocking(move || -> Result<(Arc<Session>, String)> {
        let env: Vec<(String, String)> = kestrel_common::process::shell_env()
            .into_iter()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect();
        let env_shell = env
            .iter()
            .find(|(k, _)| k == "SHELL")
            .map(|(_, v)| v.clone())
            .or_else(|| std::env::var("SHELL").ok());
        let command = resolve_shell(shell.as_deref(), env_shell.as_deref());
        let shell_name = command.program.clone();
        let zsh_dir = zsh_integration_dir(&app, &command.program, highlight.unwrap_or(true));

        let mut dir = PathBuf::from(&cwd);
        if !dir.is_dir() {
            dir = home_dir().filter(|d| d.is_dir()).unwrap_or_else(std::env::temp_dir);
        }

        let exit_label = label.clone();
        let session = Session::spawn(
            SpawnOptions { command, cwd: dir, cols, rows, env, zsh_dir },
            move |bytes| {
                // The send fails when the page is gone. The window cleanup kills the shell then.
                let _ = channel.send(InvokeResponseBody::Raw(bytes));
            },
            move |code| {
                let _ = events.send(TermEvent::Exit { code });
                if let Some(st) = app.try_state::<TermState>() {
                    st.sessions.lock().remove(&(exit_label, id));
                }
            },
        )
        .map_err(|e| Error::new(kestrel_common::error::codes::IO, e))?;
        Ok((Arc::new(session), shell_name))
    })
    .await
    .map_err(join_error)??;

    let (session, shell_name) = started;
    let key = (window.label().to_string(), id);
    state.sessions.lock().insert(key.clone(), session.clone());
    // A shell that ends at once can finish before we store it. Then nobody removes it.
    if session.is_exited() {
        state.sessions.lock().remove(&key);
    }
    Ok(SpawnResult { id, shell: shell_name })
}

/// Sends typed text to the shell.
#[tauri::command]
async fn term_write(window: Window, state: State<'_, TermState>, id: u64, data: String) -> Result<()> {
    let session = find_session(&state, window.label(), id)?;
    // A full PTY buffer can block the write, so it must not run on the main thread.
    tauri::async_runtime::spawn_blocking(move || session.write(data.as_bytes()).map_err(|e| Error::new(kestrel_common::error::codes::IO, e)))
        .await
        .map_err(join_error)?
}

#[tauri::command]
async fn term_resize(window: Window, state: State<'_, TermState>, id: u64, cols: u16, rows: u16) -> Result<()> {
    let session = find_session(&state, window.label(), id)?;
    session.resize(cols, rows).map_err(|e| Error::new(kestrel_common::error::codes::IO, e))
}

/// Stops the shell and its child programs. Unknown ids are ignored.
#[tauri::command]
async fn term_kill(window: Window, state: State<'_, TermState>, id: u64) -> Result<()> {
    let removed = state.sessions.lock().remove(&(window.label().to_string(), id));
    if let Some(session) = removed {
        session.kill();
    }
    Ok(())
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![term_spawn, term_write, term_resize, term_kill])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(TermState::default());
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(st) = app.try_state::<TermState>() {
        let doomed: Vec<Arc<Session>> = {
            let mut map = st.sessions.lock();
            let keys: Vec<_> = map.keys().filter(|(l, _)| l == label).cloned().collect();
            keys.iter().filter_map(|k| map.remove(k)).collect()
        };
        for s in doomed {
            s.kill();
        }
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(st) = app.try_state::<TermState>() {
        let all: Vec<Arc<Session>> = st.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in all {
            s.kill();
        }
    }
}
