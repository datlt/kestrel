//! Tauri commands for the `search` feature: the file index (quick open) and
//! the text search (find in files). The work is done in `kestrel-search`.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result};
use kestrel_search::{search_text as run_text_search, FileMatches, IndexManager, IndexStatus, QueryResult, TextOptions};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{App, AppHandle, Emitter, Manager, State, Window};

/// Sent to all windows when an index build ends. The frontend refreshes quick open.
const INDEX_EVENT: &str = "kestrel://search-index";

struct SearchState {
    index: IndexManager,
    /// Running text searches: id -> (window label, cancel flag).
    running: Mutex<HashMap<u64, (String, Arc<AtomicBool>)>>,
    next_id: AtomicU64,
}

#[derive(Clone, Serialize)]
struct IndexEvent {
    root: String,
    count: usize,
}

/// Messages sent through the channel of `search_text`.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TextEvent {
    #[serde(rename_all = "camelCase")]
    Batch { files: Vec<FileMatches> },
    #[serde(rename_all = "camelCase")]
    Done {
        total_matches: usize,
        files_with_matches: usize,
        truncated: bool,
        cancelled: bool,
        elapsed_ms: u64,
    },
    Error { code: String, message: String },
}

fn root_path(root: &str) -> Result<PathBuf> {
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err(Error::not_found(format!("not a folder: {root}")));
    }
    Ok(p)
}

fn join_error(e: tauri::Error) -> Error {
    Error::internal(format!("search task failed: {e}"))
}

/// Fuzzy search in the file index of `root`. Starts the index when needed.
#[tauri::command]
async fn search_files(state: State<'_, SearchState>, root: String, query: String, limit: usize) -> Result<QueryResult> {
    let root = root_path(&root)?;
    let index = state.index.get_or_start(&root);
    tauri::async_runtime::spawn_blocking(move || index.query(&query, limit.clamp(1, 1000)))
        .await
        .map_err(join_error)
}

/// Status of the index of `root`. Starts the index when needed.
/// It is `async` because it checks the disk (`root_path`) and can start a build.
#[tauri::command]
async fn search_index_status(state: State<'_, SearchState>, root: String) -> Result<IndexStatus> {
    let root = root_path(&root)?;
    Ok(state.index.get_or_start(&root).status())
}

/// Applies file changes to the index. With `rescan` (or when the index is
/// new) it rebuilds the whole index in the background.
#[tauri::command]
async fn search_index_update(
    state: State<'_, SearchState>,
    root: String,
    paths: Vec<String>,
    rescan: bool,
) -> Result<IndexStatus> {
    let root = root_path(&root)?;
    let existing = state.index.get(&root);
    let index = state.index.get_or_start(&root);
    if existing.is_none() {
        // A new index reads the folder now, so it already has these changes.
        return Ok(index.status());
    }
    if rescan {
        index.rebuild();
        return Ok(index.status());
    }
    let list: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let idx = index.clone();
    tauri::async_runtime::spawn_blocking(move || idx.update(&list)).await.map_err(join_error)?;
    Ok(index.status())
}

/// Starts a text search and returns its id. Results come through `channel`.
#[tauri::command]
async fn search_text(
    window: Window,
    state: State<'_, SearchState>,
    root: String,
    options: TextOptions,
    channel: Channel<TextEvent>,
) -> Result<u64> {
    let root = root_path(&root)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    state.running.lock().insert(id, (window.label().to_string(), cancel.clone()));
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sender = channel.clone();
        let stop = cancel.clone();
        let result = run_text_search(&root, &options, &cancel, &move |files| {
            // The send fails when the page is gone (reload or closed window).
            // Nobody reads the results then, so stop the search.
            if sender.send(TextEvent::Batch { files }).is_err() {
                stop.store(true, Ordering::Relaxed);
            }
        });
        let event = match result {
            Ok(s) => TextEvent::Done {
                total_matches: s.total_matches,
                files_with_matches: s.files_with_matches,
                truncated: s.truncated,
                cancelled: s.cancelled,
                elapsed_ms: s.elapsed_ms,
            },
            Err(e) => TextEvent::Error { code: e.code().to_string(), message: e.to_string() },
        };
        let _ = channel.send(event);
        if let Some(st) = app.try_state::<SearchState>() {
            st.running.lock().remove(&id);
        }
    });
    Ok(id)
}

#[tauri::command]
fn search_cancel(state: State<'_, SearchState>, id: u64) {
    if let Some((_, flag)) = state.running.lock().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        search_files,
        search_index_status,
        search_index_update,
        search_text,
        search_cancel
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    let handle = app.handle().clone();
    let listener: kestrel_search::ReadyListener = Arc::new(move |root: &Path, count: usize| {
        let payload = IndexEvent { root: root.to_string_lossy().into_owned(), count };
        let _ = handle.emit(INDEX_EVENT, payload);
    });
    app.manage(SearchState {
        index: IndexManager::new(Some(listener)),
        running: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
    });
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(st) = app.try_state::<SearchState>() {
        for (l, flag) in st.running.lock().values() {
            if l == label {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(st) = app.try_state::<SearchState>() {
        for (_, flag) in st.running.lock().values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
