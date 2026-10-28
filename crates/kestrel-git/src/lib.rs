//! kestrel-git: a thin wrapper around the `git` program.
//!
//! Every call starts a `git` child process (`kestrel_common::process::command`)
//! with `-c core.quotepath=off` and uses `-z` output, so any file name works.
//! Paths in results are relative to the repository top level and use `/`.
//!
//! `Git::status` can be cancelled: a newer status request for the same root
//! kills the older git process.

mod branch;
mod history;
mod parse;
mod run;
#[cfg(test)]
mod tests;

use kestrel_common::error::codes;
use kestrel_common::{paths, Error, Result};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

pub use branch::{
    branch_list, stash_pop, stash_push, switch, validate_branch_name, BranchList, LocalBranch, NameCheck, RemoteBranch,
    StashResult, SwitchOptions, FETCH_TIMEOUT, STASH_PREFIX,
};
pub use history::{blame, commit_info, log, BlameRange, LogEntry};
pub use run::Job;
use run::{failure, run, run_ok};

/// Hash of the empty tree. It stands for "HEAD" in a repo without commits.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Branch name. `None` when HEAD is detached.
    pub branch: Option<String>,
    pub detached: bool,
    /// Commit hash of HEAD. `None` in a repo without commits.
    pub head: Option<String>,
    /// For example `origin/main`.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute native path of the repository top level.
    pub top_level: String,
    #[serde(flatten)]
    pub branch: BranchInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Ordinary,
    Renamed,
    Copied,
    Unmerged,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// Relative to the top level, with `/`.
    pub path: String,
    /// Old path of a rename or copy.
    pub orig_path: Option<String>,
    pub kind: EntryKind,
    /// Status letter in the index (`M`, `A`, `D`, `R`, `C`, `T`, `U`) or `.` for none.
    pub index: char,
    /// Status letter in the working tree, or `.` for none.
    pub worktree: char,
    /// Similarity of a rename or copy, 0 to 100.
    pub score: Option<u32>,
    /// The index differs from HEAD for this path.
    pub staged: bool,
    /// The working tree differs from the index for this path.
    pub unstaged: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub top_level: String,
    #[serde(flatten)]
    pub branch: BranchInfo,
    pub entries: Vec<StatusEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    /// `A`, `M`, `D`, `R`, `C` or `T`.
    pub status: char,
    pub score: Option<u32>,
    pub path: String,
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name, for example `main` or `origin/main`.
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub sha: String,
}

/// Holds the running status job of each root.
#[derive(Default)]
pub struct Git {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Git {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a new job under `key` and cancels the older job with the same key.
    pub fn begin(&self, key: &str) -> Arc<Job> {
        let job = Arc::new(Job::default());
        if let Some(old) = self.jobs.lock().insert(key.to_string(), job.clone()) {
            old.cancel();
        }
        job
    }

    fn finish(&self, key: &str, job: &Arc<Job>) {
        let mut jobs = self.jobs.lock();
        if jobs.get(key).is_some_and(|j| Arc::ptr_eq(j, job)) {
            jobs.remove(key);
        }
    }

    /// Cancels the running job with this key, if any.
    pub fn cancel(&self, key: &str) {
        if let Some(job) = self.jobs.lock().remove(key) {
            job.cancel();
        }
    }

    /// Cancels all running jobs whose key starts with `prefix`.
    pub fn cancel_prefix(&self, prefix: &str) {
        self.jobs.lock().retain(|k, job| {
            let hit = k.starts_with(prefix);
            if hit {
                job.cancel();
            }
            !hit
        });
    }

    /// Full status of the repository that contains `root`.
    /// A newer request with the same `key` kills this one: it then fails with
    /// `cancelled`. Use one key per window and root.
    pub fn status(&self, key: &str, root: &Path) -> Result<Status> {
        let job = self.begin(key);
        let result = status_with_job(root, &job);
        self.finish(key, &job);
        result
    }
}

fn status_with_job(root: &Path, job: &Job) -> Result<Status> {
    let top_level = top_level(root, job)?;
    let buf = run_ok(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
        ],
        job,
    )?;
    let (branch, entries) = parse::parse_status(&buf);
    Ok(Status { top_level, branch, entries })
}

fn top_level(root: &Path, job: &Job) -> Result<String> {
    let out = run_ok(root, &["rev-parse", "--show-toplevel"], job)?;
    let s = String::from_utf8_lossy(&out);
    let s = s.trim_end_matches(['\n', '\r']);
    Ok(paths::normalize(Path::new(s)).to_string_lossy().into_owned())
}

/// Cheap repo information: it does not look at the working tree.
pub fn repo_info(root: &Path) -> Result<RepoInfo> {
    let job = Job::default();
    let top_level = top_level(root, &job)?;
    let mut branch = BranchInfo::default();

    let out = run(root, &["symbolic-ref", "-q", "--short", "HEAD"], &job)?;
    if out.ok() {
        branch.branch = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
    } else {
        branch.detached = true;
    }
    let out = run(root, &["rev-parse", "-q", "--verify", "HEAD"], &job)?;
    if out.ok() {
        branch.head = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
    } else {
        // No commits yet: this is a new branch, not a detached HEAD.
        branch.detached = false;
    }
    if branch.branch.is_some() {
        let out = run(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], &job)?;
        if out.ok() {
            branch.upstream = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
            let out = run(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], &job)?;
            if out.ok() {
                let s = String::from_utf8_lossy(&out.stdout);
                let mut n = s.split_whitespace().map(|v| v.parse::<u32>().unwrap_or(0));
                branch.ahead = n.next().unwrap_or(0);
                branch.behind = n.next().unwrap_or(0);
            }
        }
    }
    Ok(RepoInfo { top_level, branch })
}

fn check_rev(rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains('\0') {
        return Err(Error::invalid(format!("bad revision: {rev:?}")));
    }
    Ok(())
}

/// Content of a file at a revision. `rev` is `HEAD`, a branch, a commit,
/// or `:0` for the index. `path` is relative to the top level.
/// Returns `None` when the file does not exist there (this is not an error).
pub fn show(root: &Path, rev: &str, path: &str) -> Result<Option<Vec<u8>>> {
    check_rev(rev)?;
    let job = Job::default();
    let spec = format!("{rev}:{path}");
    let out = run(root, &["cat-file", "blob", &spec], &job)?;
    if out.ok() {
        return Ok(Some(out.stdout));
    }
    if out.stderr.contains("not a git repository") {
        return Err(failure(&out));
    }
    if rev.starts_with(':') {
        return Ok(None);
    }
    // The revision may be the problem, or only the path.
    let tree = format!("{rev}^{{tree}}");
    let check = run(root, &["rev-parse", "-q", "--verify", &tree], &job)?;
    if check.ok() || rev == "HEAD" {
        Ok(None)
    } else {
        Err(Error::invalid(format!("unknown revision: {rev}")))
    }
}

/// Changed files between `base` and `target`. Without `target`, between
/// `base` and the working tree (tracked files only; use `status` for untracked).
pub fn diff_names(root: &Path, base: &str, target: Option<&str>) -> Result<Vec<DiffEntry>> {
    check_rev(base)?;
    if let Some(t) = target {
        check_rev(t)?;
    }
    let job = Job::default();
    let base = if base == "HEAD" && !has_head(root, &job)? { EMPTY_TREE } else { base };
    let mut args = vec!["diff", "--name-status", "-z", "-M", "--no-color", "--no-ext-diff", base];
    if let Some(t) = target {
        args.push(t);
    }
    args.push("--");
    let buf = run_ok(root, &args, &job)?;
    Ok(parse::parse_name_status(&buf))
}

fn has_head(root: &Path, job: &Job) -> Result<bool> {
    Ok(run(root, &["rev-parse", "-q", "--verify", "HEAD"], job)?.ok())
}

/// Best common ancestor of two revisions. Fails with `not_found` when there is none.
pub fn merge_base(root: &Path, a: &str, b: &str) -> Result<String> {
    check_rev(a)?;
    check_rev(b)?;
    let job = Job::default();
    let out = run(root, &["merge-base", a, b], &job)?;
    if out.ok() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    if out.code == Some(1) && out.stderr.trim().is_empty() {
        return Err(Error::new(codes::NOT_FOUND, format!("no common ancestor of {a} and {b}")));
    }
    Err(failure(&out))
}

/// Local and remote branches. The current branch comes first, then local
/// branches, then remote branches, each group sorted by name.
pub fn branches(root: &Path) -> Result<Vec<Branch>> {
    let job = Job::default();
    let buf = run_ok(
        root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(refname)%00%(objectname:short)",
            "refs/heads",
            "refs/remotes",
        ],
        &job,
    )?;
    let mut list = Vec::new();
    for line in String::from_utf8_lossy(&buf).lines() {
        let mut f = line.split('\0');
        let (Some(head), Some(full), Some(sha)) = (f.next(), f.next(), f.next()) else { continue };
        let (name, remote) = if let Some(n) = full.strip_prefix("refs/heads/") {
            (n, false)
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            // `origin/HEAD` only points to another branch.
            if n.ends_with("/HEAD") {
                continue;
            }
            (n, true)
        } else {
            continue;
        };
        list.push(Branch { name: name.to_string(), remote, current: head == "*", sha: sha.to_string() });
    }
    list.sort_by(|a, b| b.current.cmp(&a.current).then(a.remote.cmp(&b.remote)).then_with(|| a.name.cmp(&b.name)));
    Ok(list)
}
