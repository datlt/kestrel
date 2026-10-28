//! Tauri commands for the GitHub CLI (`gh`). Owner: gh-backend agent.
//! See docs/DESIGN.md section 12.3. Command names start with `gh_`.
//! The work is done in `kestrel-gh`. Every call runs in `spawn_blocking`.
//!
//! A call with an `id` can be stopped with `gh_cancel`. Running calls are
//! keyed by window label and id, so one window cannot stop a call of another.
//! Kestrel never sees a token: `gh` adds it to each request.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result};
use kestrel_gh::{ApiRequest, Gh, GhStatus, Job, RepoRef};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{App, AppHandle, Manager, State, Window};

#[derive(Default)]
pub struct GhState {
    gh: Gh,
    /// Running calls: (window label, id) -> job.
    running: Mutex<HashMap<(String, u64), Arc<Job>>>,
}

type Shared<'a> = State<'a, GhState>;

/// Takes the job out of the running list when the call ends.
struct Registered<'a> {
    state: &'a GhState,
    key: (String, u64),
    job: Arc<Job>,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        // A newer call with the same id may have replaced this entry. Keep it.
        let mut running = self.state.running.lock();
        if running.get(&self.key).is_some_and(|j| Arc::ptr_eq(j, &self.job)) {
            running.remove(&self.key);
        }
    }
}

fn join_error(e: tauri::Error) -> Error {
    Error::internal(format!("gh task failed: {e}"))
}

/// Runs `work` on a blocking thread with a job that `gh_cancel` can stop.
/// `id` is `None` for calls that cannot be cancelled.
async fn run_job<T, F>(window: &Window, state: &Shared<'_>, id: Option<u64>, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Gh, &Job) -> Result<T> + Send + 'static,
{
    let job = Arc::new(Job::default());
    let key = id.map(|id| (window.label().to_string(), id));
    if let Some(key) = &key {
        // A new call with an id that is still running replaces it.
        if let Some(old) = state.running.lock().insert(key.clone(), job.clone()) {
            old.cancel();
        }
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GhState>();
        let _guard = key.map(|key| Registered { state: &state, key, job: job.clone() });
        work(&state.gh, &job)
    })
    .await
    .map_err(join_error)?
}

fn folder(root: &str) -> PathBuf {
    PathBuf::from(root)
}

/// Runs `gh --version` and `gh auth status --json hosts`. A broken login
/// gives an account with `state: error`. Without `gh`: `installed: false`.
#[tauri::command]
async fn gh_status(window: Window, state: Shared<'_>) -> Result<GhStatus> {
    run_job(&window, &state, None, |gh, job| gh.status(job)).await
}

#[tauri::command]
async fn gh_switch(window: Window, state: Shared<'_>, host: String, login: String) -> Result<()> {
    run_job(&window, &state, None, move |gh, job| gh.switch(&host, &login, job)).await
}

#[tauri::command]
async fn gh_logout(window: Window, state: Shared<'_>, host: String, login: String) -> Result<()> {
    run_job(&window, &state, None, move |gh, job| gh.logout(&host, &login, job)).await
}

/// A REST call. Returns the parsed JSON (`null` for an empty answer).
#[tauri::command]
async fn gh_api(window: Window, state: Shared<'_>, id: u64, request: ApiRequest) -> Result<Value> {
    run_job(&window, &state, Some(id), move |gh, job| gh.api(&request, job)).await
}

/// A GraphQL call. Returns `data`.
#[tauri::command]
async fn gh_graphql(window: Window, state: Shared<'_>, id: u64, host: String, query: String, variables: Value) -> Result<Value> {
    run_job(&window, &state, Some(id), move |gh, job| gh.graphql(&host, &query, &variables, job)).await
}

/// The text of a file at a commit.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn gh_file_text(
    window: Window,
    state: Shared<'_>,
    id: u64,
    host: String,
    owner: String,
    repo: String,
    path: String,
    r#ref: String,
) -> Result<String> {
    run_job(&window, &state, Some(id), move |gh, job| gh.file_text(&host, &owner, &repo, &path, &r#ref, job)).await
}

/// Stops a running call of this window. It then fails with `cancelled`.
#[tauri::command]
fn gh_cancel(window: Window, state: Shared<'_>, id: u64) {
    let job = state.running.lock().get(&(window.label().to_string(), id)).cloned();
    if let Some(job) = job {
        job.cancel();
    }
}

/// The GitHub repository of a folder, from its git remotes.
#[tauri::command]
async fn gh_repo_of(window: Window, state: Shared<'_>, root: String) -> Result<Option<RepoRef>> {
    run_job(&window, &state, None, move |gh, job| gh.repo_of(&folder(&root), job)).await
}

/// `gh pr checkout <number>` in the folder. Returns what `gh` printed.
#[tauri::command]
async fn gh_pr_checkout(window: Window, state: Shared<'_>, root: String, number: u64) -> Result<String> {
    run_job(&window, &state, None, move |gh, job| gh.pr_checkout(&folder(&root), number, job)).await
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        gh_status,
        gh_switch,
        gh_logout,
        gh_api,
        gh_graphql,
        gh_file_text,
        gh_cancel,
        gh_repo_of,
        gh_pr_checkout
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(GhState::default());
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(st) = app.try_state::<GhState>() {
        for ((l, _), job) in st.running.lock().iter() {
            if l == label {
                job.cancel();
            }
        }
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(st) = app.try_state::<GhState>() {
        for job in st.running.lock().values() {
            job.cancel();
        }
    }
}
