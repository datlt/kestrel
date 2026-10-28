//! Tauri commands for the code index (class diagram, find usages). The work
//! is done in `kestrel-code`. Command names start with `code_`.

use super::{Handler, SetupResult};
use kestrel_code::{CodeIndexStatus, CodeManager, DiagramRequest, DiagramResult, UsagesRequest, UsagesResult};
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{App, AppHandle, Manager, State, Window};

struct CodeState {
    manager: CodeManager,
    /// Running requests: (window label, id) -> cancel flag.
    running: Mutex<HashMap<(String, u64), Arc<AtomicBool>>>,
}

fn join_error(e: tauri::Error) -> Error {
    Error::internal(format!("code task failed: {e}"))
}

/// Removes the request from `running` when the work ends.
struct Registered<'a> {
    state: &'a CodeState,
    key: (String, u64),
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.state.running.lock().remove(&self.key);
    }
}

fn register(state: &CodeState, label: &str, id: u64) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state.running.lock().insert((label.to_owned(), id), flag.clone());
    flag
}

/// Does not start a build.
#[tauri::command]
async fn code_index_status(state: State<'_, CodeState>, root: String) -> Result<CodeIndexStatus> {
    Ok(state.manager.status(&root))
}

#[tauri::command]
async fn code_index_update(state: State<'_, CodeState>, root: String, paths: Vec<String>, rescan: bool) -> Result<()> {
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.update(&root, &paths, rescan)).await.map_err(join_error)?
}

#[tauri::command]
async fn code_index_drop(window: Window, state: State<'_, CodeState>, root: String) -> Result<()> {
    state.manager.drop_root(window.label(), &root);
    Ok(())
}

#[tauri::command]
fn code_cancel(window: Window, state: State<'_, CodeState>, id: u64) {
    if let Some(flag) = state.running.lock().get(&(window.label().to_owned(), id)) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn code_diagram(window: Window, state: State<'_, CodeState>, id: u64, request: DiagramRequest) -> Result<DiagramResult> {
    let label = window.label().to_owned();
    let flag = register(&state, &label, id);
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<CodeState>();
        let _reg = Registered { state: &st, key: (label.clone(), id) };
        st.manager.diagram(&label, &request, &flag)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn code_usages(window: Window, state: State<'_, CodeState>, id: u64, request: UsagesRequest) -> Result<UsagesResult> {
    let label = window.label().to_owned();
    let flag = register(&state, &label, id);
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<CodeState>();
        let _reg = Registered { state: &st, key: (label.clone(), id) };
        st.manager.usages(&label, &request, &flag)
    })
    .await
    .map_err(join_error)?
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        code_index_status,
        code_index_update,
        code_index_drop,
        code_cancel,
        code_diagram,
        code_usages
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(CodeState { manager: CodeManager::new(), running: Mutex::new(HashMap::new()) });
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(st) = app.try_state::<CodeState>() {
        for ((l, _), flag) in st.running.lock().iter() {
            if l == label {
                flag.store(true, Ordering::Relaxed);
            }
        }
        st.manager.window_destroyed(label);
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(st) = app.try_state::<CodeState>() {
        for flag in st.running.lock().values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
