//! Branch list, branch switch, stash and fetch.
//!
//! The list uses one `git for-each-ref` call, so it stays fast with
//! thousands of branches. Switching never uses `--force` or
//! `--discard-changes`: when git refuses, the caller gets the code `conflict`
//! and git's own message.

use crate::run::{failure, run, Job, Output};
use crate::Git;
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

/// Time limit of `git fetch`.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// Start of the message of the stash that Kestrel makes before a switch.
pub const STASH_PREFIX: &str = "Kestrel: before switching to";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub current: bool,
    /// Short hash of the last commit.
    pub sha: String,
    /// Commit time of the last commit, in seconds since the Unix epoch.
    pub time: i64,
    /// First line of the message of the last commit.
    pub subject: String,
    /// For example `origin/main`.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream branch was deleted on the remote.
    pub gone: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// Full short name, for example `origin/feature/x`.
    pub name: String,
    /// Name of the remote, for example `origin`.
    pub remote: String,
    pub sha: String,
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    /// Name of the current branch. `None` when HEAD is detached.
    pub current: Option<String>,
    pub detached: bool,
    /// Short hash of HEAD. `None` in a repo without commits.
    pub head: Option<String>,
    /// Newest commit first.
    pub local: Vec<LocalBranch>,
    /// Newest commit first.
    pub remote: Vec<RemoteBranch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SwitchOptions {
    /// A remote branch such as `origin/feature`. Git makes a local branch that tracks it.
    pub track: Option<String>,
    /// Make a new branch with the name `branch`.
    pub create: bool,
    /// Commit or branch where a new branch starts.
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashResult {
    /// False when there was nothing to stash.
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameCheck {
    pub valid: bool,
    /// Plain text that says what is wrong. `None` when the name is fine.
    pub message: Option<String>,
}

const FORMAT: &str = "--format=%(HEAD)%00%(refname)%00%(objectname:short)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track)%00%(contents:subject)";

/// Local and remote branches with commit time, subject, upstream and
/// ahead/behind counts. Newest commit first.
pub fn branch_list(root: &Path) -> Result<BranchList> {
    let job = Job::default();
    let out = run(
        root,
        &["for-each-ref", "--sort=-committerdate", FORMAT, "refs/heads", "refs/remotes"],
        &job,
    )?;
    if !out.ok() {
        return Err(failure(&out));
    }
    let (mut local, remote) = parse_refs(&String::from_utf8_lossy(&out.stdout));

    let sym = run(root, &["symbolic-ref", "-q", "--short", "HEAD"], &job)?;
    let current = if sym.ok() { Some(String::from_utf8_lossy(&sym.stdout).trim().to_string()) } else { None };
    let head_out = run(root, &["rev-parse", "-q", "--verify", "--short", "HEAD"], &job)?;
    let head = if head_out.ok() { Some(String::from_utf8_lossy(&head_out.stdout).trim().to_string()) } else { None };
    // The `%(HEAD)` mark is already set by git. This keeps both in line.
    for b in &mut local {
        b.current = current.as_deref() == Some(b.name.as_str());
    }
    let detached = current.is_none() && head.is_some();
    Ok(BranchList { current, detached, head, local, remote })
}

fn parse_refs(text: &str) -> (Vec<LocalBranch>, Vec<RemoteBranch>) {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() < 7 {
            continue;
        }
        let (head, full, sha, time, upstream, track, subject) = (f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
        let time = time.parse::<i64>().unwrap_or(0);
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = crate::parse::parse_track(track);
            local.push(LocalBranch {
                name: name.to_string(),
                current: head == "*",
                sha: sha.to_string(),
                time,
                subject: subject.to_string(),
                upstream: if upstream.is_empty() { None } else { Some(upstream.to_string()) },
                ahead,
                behind,
                gone,
            });
        } else if let Some(name) = full.strip_prefix("refs/remotes/") {
            // `origin/HEAD` only points to another branch.
            if name.ends_with("/HEAD") || !name.contains('/') {
                continue;
            }
            let remote_name = name.split('/').next().unwrap_or("").to_string();
            remote.push(RemoteBranch {
                name: name.to_string(),
                remote: remote_name,
                sha: sha.to_string(),
                time,
                subject: subject.to_string(),
            });
        }
    }
    (local, remote)
}

fn check_name(s: &str, what: &str) -> Result<()> {
    if s.is_empty() || s.starts_with('-') || s.contains('\0') || s.contains('\n') {
        return Err(Error::invalid(format!("bad {what}: {s:?}")));
    }
    Ok(())
}

fn text(out: &Output) -> String {
    let mut s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let e = out.stderr.trim();
    if !e.is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(e);
    }
    s
}

/// True when git refused because local changes or files are in the way.
fn is_blocked_by_changes(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("would be overwritten")
        || m.contains("commit your changes or stash")
        || m.contains("you have unmerged paths")
        || m.contains("resolve your current index first")
        || m.contains("needs merge")
}

fn switch_failure(out: &Output) -> Error {
    let msg = text(out);
    let low = msg.to_lowercase();
    if is_blocked_by_changes(&msg) {
        return Error::new(codes::CONFLICT, msg);
    }
    if low.contains("already exists") {
        return Error::new(codes::ALREADY_EXISTS, msg);
    }
    if low.contains("invalid reference")
        || low.contains("invalid starting point")
        || low.contains("not a commit")
        || low.contains("unknown revision")
        || low.contains("a branch is expected")
    {
        return Error::not_found(msg);
    }
    failure(out)
}

/// Switches the working tree to a branch.
///
/// * plain: `git switch <branch>`
/// * `track`: `git switch --track [-c <branch>] <remote>/<name>`
/// * `create`: `git switch -c <branch> [<start_point>]`
///
/// Fails with `conflict` (git's message) when local changes block the switch.
pub fn switch(root: &Path, branch: &str, opts: &SwitchOptions) -> Result<()> {
    let job = Job::default();
    let mut args: Vec<&str> = vec!["switch"];
    if let Some(track) = opts.track.as_deref() {
        check_name(track, "remote branch")?;
        args.push("--track");
        if !branch.is_empty() {
            check_name(branch, "branch name")?;
            args.push("-c");
            args.push(branch);
        }
        args.push(track);
    } else if opts.create {
        check_name(branch, "branch name")?;
        args.push("-c");
        args.push(branch);
        if let Some(start) = opts.start_point.as_deref() {
            check_name(start, "start point")?;
            args.push(start);
        }
    } else {
        check_name(branch, "branch name")?;
        args.push(branch);
    }
    let out = run(root, &args, &job)?;
    if out.ok() { Ok(()) } else { Err(switch_failure(&out)) }
}

/// Stashes tracked changes and untracked files with a message.
pub fn stash_push(root: &Path, message: &str) -> Result<StashResult> {
    if message.contains('\0') {
        return Err(Error::invalid("bad stash message"));
    }
    let job = Job::default();
    let out = run(root, &["stash", "push", "-u", "-m", message], &job)?;
    if !out.ok() {
        return Err(failure(&out));
    }
    let created = !String::from_utf8_lossy(&out.stdout).contains("No local changes to save");
    Ok(StashResult { created })
}

/// Applies the newest stash that Kestrel made before a switch and removes it.
/// Fails with `not_found` when there is none. Fails with `conflict` and git's
/// message when the stash does not apply cleanly (git then keeps the stash).
pub fn stash_pop(root: &Path) -> Result<()> {
    let job = Job::default();
    let out = run(root, &["stash", "list", "--format=%gd%x00%gs"], &job)?;
    if !out.ok() {
        return Err(failure(&out));
    }
    let list = String::from_utf8_lossy(&out.stdout).into_owned();
    let found = list.lines().find_map(|l| {
        let (name, subject) = l.split_once('\0')?;
        subject.contains(STASH_PREFIX).then(|| name.to_string())
    });
    let Some(name) = found else {
        return Err(Error::not_found("there is no stash made by Kestrel"));
    };
    let out = run(root, &["stash", "pop", &name], &job)?;
    if out.ok() {
        return Ok(());
    }
    let msg = text(&out);
    if is_blocked_by_changes(&msg) || msg.contains("CONFLICT") || msg.to_lowercase().contains("conflict") {
        return Err(Error::new(codes::CONFLICT, msg));
    }
    Err(failure(&out))
}

/// Checks a new branch name with `git check-ref-format --branch`, and checks
/// that no branch has this name yet.
pub fn validate_branch_name(root: &Path, name: &str) -> Result<NameCheck> {
    let bad = |m: String| Ok(NameCheck { valid: false, message: Some(m) });
    if name.trim().is_empty() {
        return bad("Enter a branch name.".into());
    }
    if name.starts_with('-') || name.contains('\0') || name.contains("@{") || name == "HEAD" {
        return bad(format!("'{name}' is not a valid branch name."));
    }
    let job = Job::default();
    let out = run(root, &["check-ref-format", "--branch", name], &job)?;
    if !out.ok() {
        if out.stderr.contains("not a git repository") {
            return Err(failure(&out));
        }
        return bad(format!("'{name}' is not a valid branch name."));
    }
    let refname = format!("refs/heads/{name}");
    let exists = run(root, &["show-ref", "--verify", "--quiet", &refname], &job)?;
    if exists.ok() {
        return bad(format!("A branch named '{name}' already exists."));
    }
    Ok(NameCheck { valid: true, message: None })
}

impl Git {
    /// `git fetch --prune --all` with a time limit of 120 seconds.
    /// A newer call with the same key, or `cancel(key)`, stops it with `cancelled`.
    pub fn fetch(&self, key: &str, root: &Path) -> Result<()> {
        self.fetch_with_timeout(key, root, FETCH_TIMEOUT)
    }

    pub(crate) fn fetch_with_timeout(&self, key: &str, root: &Path, limit: Duration) -> Result<()> {
        let job = self.begin(key);
        let timed_out = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = channel::<()>();
        let watcher = {
            let job = job.clone();
            let timed_out = timed_out.clone();
            std::thread::spawn(move || {
                // Ends at once when `done_tx` is dropped.
                if let Err(RecvTimeoutError::Timeout) = done_rx.recv_timeout(limit) {
                    timed_out.store(true, Ordering::SeqCst);
                    job.cancel();
                }
            })
        };
        let result = run(root, &["fetch", "--prune", "--all"], &job);
        drop(done_tx);
        let _ = watcher.join();
        self.finish(key, &job);
        match result {
            Ok(out) if out.ok() => Ok(()),
            Ok(out) => Err(failure(&out)),
            Err(e) if e.code() == codes::CANCELLED && timed_out.load(Ordering::SeqCst) => Err(Error::new(
                codes::IO,
                format!("git fetch took longer than {} seconds and was stopped.", limit.as_secs().max(1)),
            )),
            Err(e) => Err(e),
        }
    }
}
