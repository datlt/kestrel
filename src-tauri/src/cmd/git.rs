//! Tauri commands for the `git` feature. All work runs in `spawn_blocking`.
//!
//! `git_show` returns raw bytes: the first byte is 1 when the file exists at
//! that revision and 0 when it does not (then no more bytes follow). The file
//! content follows the flag byte.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result};
use kestrel_git::{
    BlameRange, Branch, BranchList, DiffEntry, Git, LogEntry, NameCheck, RepoInfo, StashResult, Status, SwitchOptions,
};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{App, AppHandle, Manager, State, Window};

type Shared<'a> = State<'a, Arc<Git>>;

async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::internal(format!("git task failed: {e}")))?
}

/// Status jobs are keyed by window and root: a newer request of the same
/// window and root cancels the older one.
fn job_key(label: &str, root: &str) -> String {
    format!("{label}\u{0}{root}")
}

/// Fetch jobs start with the window label too, so closing a window stops them.
fn fetch_key(label: &str, root: &str) -> String {
    format!("{label}\u{0}fetch\u{0}{root}")
}

#[tauri::command]
async fn git_repo_info(root: String) -> Result<RepoInfo> {
    blocking(move || kestrel_git::repo_info(&PathBuf::from(root))).await
}

#[tauri::command]
async fn git_status(window: Window, git: Shared<'_>, root: String) -> Result<Status> {
    let git = git.inner().clone();
    let key = job_key(window.label(), &root);
    blocking(move || git.status(&key, &PathBuf::from(root))).await
}

#[tauri::command]
async fn git_show(root: String, rev: String, path: String) -> Result<Response> {
    let bytes = blocking(move || kestrel_git::show(&PathBuf::from(root), &rev, &path)).await?;
    Ok(match bytes {
        Some(mut b) => {
            // One flag byte in front. The insert moves the bytes once.
            b.insert(0, 1);
            Response::new(b)
        }
        None => Response::new(vec![0u8]),
    })
}

#[tauri::command]
async fn git_diff_names(root: String, base: String, target: Option<String>) -> Result<Vec<DiffEntry>> {
    blocking(move || kestrel_git::diff_names(&PathBuf::from(root), &base, target.as_deref())).await
}

#[tauri::command]
async fn git_merge_base(root: String, a: String, b: String) -> Result<String> {
    blocking(move || kestrel_git::merge_base(&PathBuf::from(root), &a, &b)).await
}

#[tauri::command]
async fn git_branches(root: String) -> Result<Vec<Branch>> {
    blocking(move || kestrel_git::branches(&PathBuf::from(root))).await
}

#[tauri::command]
async fn git_log(root: String, path: String, limit: u32, skip: u32) -> Result<Vec<LogEntry>> {
    blocking(move || kestrel_git::log(&PathBuf::from(root), &path, limit, skip)).await
}

#[tauri::command]
async fn git_commit_info(root: String, sha: String) -> Result<LogEntry> {
    blocking(move || kestrel_git::commit_info(&PathBuf::from(root), &sha)).await
}

#[tauri::command]
async fn git_blame(root: String, path: String, contents: Option<String>) -> Result<Vec<BlameRange>> {
    blocking(move || kestrel_git::blame(&PathBuf::from(root), &path, contents.as_deref())).await
}

#[tauri::command]
async fn git_branch_list(root: String) -> Result<BranchList> {
    blocking(move || kestrel_git::branch_list(&PathBuf::from(root))).await
}

/// Fails with the code `conflict` and git's message when local changes block the switch.
#[tauri::command]
async fn git_switch(root: String, branch: String, options: Option<SwitchOptions>) -> Result<()> {
    blocking(move || kestrel_git::switch(&PathBuf::from(root), &branch, &options.unwrap_or_default())).await
}

#[tauri::command]
async fn git_stash_push(root: String, message: String) -> Result<StashResult> {
    blocking(move || kestrel_git::stash_push(&PathBuf::from(root), &message)).await
}

/// Applies and removes the newest stash that Kestrel made before a switch.
#[tauri::command]
async fn git_stash_pop(root: String) -> Result<()> {
    blocking(move || kestrel_git::stash_pop(&PathBuf::from(root))).await
}

/// `git fetch --prune --all`. Stops after 120 s. `git_fetch_cancel` stops it earlier.
#[tauri::command]
async fn git_fetch(window: Window, git: Shared<'_>, root: String) -> Result<()> {
    let git = git.inner().clone();
    let key = fetch_key(window.label(), &root);
    blocking(move || git.fetch(&key, &PathBuf::from(root))).await
}

#[tauri::command]
fn git_fetch_cancel(window: Window, git: Shared<'_>, root: String) {
    git.cancel(&fetch_key(window.label(), &root));
}

#[tauri::command]
async fn git_validate_branch_name(root: String, name: String) -> Result<NameCheck> {
    blocking(move || kestrel_git::validate_branch_name(&PathBuf::from(root), &name)).await
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        git_repo_info,
        git_status,
        git_show,
        git_diff_names,
        git_merge_base,
        git_branches,
        git_log,
        git_commit_info,
        git_blame,
        git_branch_list,
        git_switch,
        git_stash_push,
        git_stash_pop,
        git_fetch,
        git_fetch_cancel,
        git_validate_branch_name
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(Arc::new(Git::new()));
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(git) = app.try_state::<Arc<Git>>() {
        git.cancel_prefix(&format!("{label}\u{0}"));
    }
}

pub fn on_exit(app: &AppHandle) {
    if let Some(git) = app.try_state::<Arc<Git>>() {
        git.cancel_prefix("");
    }
}
