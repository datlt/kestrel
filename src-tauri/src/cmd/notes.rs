//! Tauri commands for the note index (Graph View, wiki links of the
//! preview). The work is done in `kestrel-notes`. Command names start with
//! `notes_`.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result};
use kestrel_notes::{NoteGraph, NoteIndexStatus, NoteManager, ResolvedLink};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{App, AppHandle, Manager, State, Window};

struct NotesState {
    manager: NoteManager,
    /// Running graph requests: (window label, id) -> cancel flag.
    running: Mutex<HashMap<(String, u64), Arc<AtomicBool>>>,
}

fn join_error(e: tauri::Error) -> Error {
    Error::internal(format!("notes task failed: {e}"))
}

/// Removes the request from `running` when the work ends.
struct Registered<'a> {
    state: &'a NotesState,
    key: (String, u64),
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.state.running.lock().remove(&self.key);
    }
}

fn register(state: &NotesState, label: &str, id: u64) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state.running.lock().insert((label.to_owned(), id), flag.clone());
    flag
}

/// Does not start a build.
#[tauri::command]
async fn notes_index_status(state: State<'_, NotesState>, root: String) -> Result<NoteIndexStatus> {
    Ok(state.manager.status(&root))
}

#[tauri::command]
async fn notes_index_update(state: State<'_, NotesState>, root: String, paths: Vec<String>, rescan: bool) -> Result<()> {
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.update(&root, &paths, rescan)).await.map_err(join_error)?
}

#[tauri::command]
async fn notes_index_drop(window: Window, state: State<'_, NotesState>, root: String) -> Result<()> {
    state.manager.drop_root(window.label(), &root);
    Ok(())
}

#[tauri::command]
fn notes_cancel(window: Window, state: State<'_, NotesState>, id: u64) {
    if let Some(flag) = state.running.lock().get(&(window.label().to_owned(), id)) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn notes_graph(window: Window, state: State<'_, NotesState>, id: u64, root: String) -> Result<NoteGraph> {
    let label = window.label().to_owned();
    let flag = register(&state, &label, id);
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<NotesState>();
        let _reg = Registered { state: &st, key: (label.clone(), id) };
        st.manager.graph(&label, &root, &flag)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn notes_resolve(
    window: Window,
    state: State<'_, NotesState>,
    root: String,
    from: String,
    target: String,
    wiki: bool,
) -> Result<Option<ResolvedLink>> {
    let label = window.label().to_owned();
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.resolve(&label, &root, &from, &target, wiki)).await.map_err(join_error)?
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        notes_index_status,
        notes_index_update,
        notes_index_drop,
        notes_cancel,
        notes_graph,
        notes_resolve
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(NotesState { manager: NoteManager::new(), running: Mutex::new(HashMap::new()) });
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(st) = app.try_state::<NotesState>() {
        for ((l, _), flag) in st.running.lock().iter() {
            if l == label {
                flag.store(true, Ordering::Relaxed);
            }
        }
        st.manager.window_destroyed(label);
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(st) = app.try_state::<NotesState>() {
        for flag in st.running.lock().values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
