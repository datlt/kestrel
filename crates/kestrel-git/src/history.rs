//! File history (`git log --follow`) and blame (`git blame --porcelain`).
//!
//! Both commands run in the top level folder of the repo, so `path` is
//! relative to the top level and `--literal-pathspecs` stops git from reading
//! `*` or `[` in a file name as a pattern.

use crate::run::{failure, run, run_input, Job, Output};
use crate::{check_rev, top_level};
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author time in seconds since the Unix epoch.
    pub author_time: i64,
    pub subject: String,
    pub body: String,
    /// Path of the file in this commit (it differs from the asked path after a rename).
    pub path: String,
    /// Old path when this commit renamed or copied the file.
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameRange {
    /// First line of the range, 1-based, in the file as it is now.
    pub start_line: u32,
    pub line_count: u32,
    pub sha: String,
    pub author: String,
    pub author_email: String,
    /// Seconds since the Unix epoch. 0 for lines that are not committed.
    pub author_time: i64,
    pub summary: String,
    pub previous_sha: Option<String>,
    pub previous_path: Option<String>,
    /// The line is not in any commit yet (sha is all zeros).
    pub uncommitted: bool,
    /// The commit is a root of the history that git cut off (shallow clone).
    pub boundary: bool,
    /// Path of the file in that commit.
    pub path: String,
}

const FORMAT: &str = "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b";

fn clean_path(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\0') {
        return Err(Error::invalid(format!("bad path: {path:?}")));
    }
    Ok(())
}

fn no_commits(out: &Output) -> bool {
    out.stderr.contains("does not have any commits") || out.stderr.contains("unknown revision") && out.stderr.contains("HEAD")
}

fn parse_log(buf: &[u8], path: &str) -> Vec<LogEntry> {
    let text = String::from_utf8_lossy(buf);
    let mut list = Vec::new();
    // A merge commit has no changed paths with `--follow`: keep the last known path.
    let mut current = path.to_string();
    for rec in text.split('\x1e').skip(1) {
        let f: Vec<&str> = rec.split('\0').collect();
        if f.len() < 7 {
            continue;
        }
        // After the format fields come the status (`M`, `R050`, ...) and one or two paths.
        let rest: Vec<&str> = f[7..].iter().copied().filter(|s| !s.trim().is_empty()).collect();
        let mut orig_path = None;
        if let Some(p) = rest.last() {
            current = (*p).trim_matches('\n').to_string();
            let status = rest[0].trim_matches('\n');
            if rest.len() == 3 && (status.starts_with('R') || status.starts_with('C')) {
                orig_path = Some(rest[1].to_string());
            }
        }
        list.push(LogEntry {
            sha: f[0].to_string(),
            parents: f[1].split_whitespace().map(str::to_string).collect(),
            author_name: f[2].to_string(),
            author_email: f[3].to_string(),
            author_time: f[4].parse().unwrap_or(0),
            subject: f[5].to_string(),
            body: f[6].trim().to_string(),
            path: current.clone(),
            orig_path,
        });
    }
    list
}

/// Commits that changed `path`, newest first, following renames.
/// `skip` and `limit` page through the list.
pub fn log(root: &Path, path: &str, limit: u32, skip: u32) -> Result<Vec<LogEntry>> {
    clean_path(path)?;
    let job = Job::default();
    let top = top_level(root, &job)?;
    let (limit, skip) = (limit.clamp(1, 1000).to_string(), skip.to_string());
    let args = [
        "--literal-pathspecs", "log", "--follow", "-z", "--name-status", "-M", "--no-color", "--no-ext-diff",
        "--date-order", "-n", &limit, "--skip", &skip, FORMAT, "--", path,
    ];
    let out = run(Path::new(&top), &args, &job)?;
    if !out.ok() {
        return if no_commits(&out) { Ok(Vec::new()) } else { Err(failure(&out)) };
    }
    Ok(parse_log(&out.stdout, path))
}

/// One commit: the same fields as `log`. `path` is empty.
pub fn commit_info(root: &Path, sha: &str) -> Result<LogEntry> {
    check_rev(sha)?;
    let job = Job::default();
    let args = ["log", "-1", "--no-color", "-z", FORMAT, sha, "--"];
    let out = run(root, &args, &job)?;
    if !out.ok() {
        return Err(failure(&out));
    }
    parse_log(&out.stdout, "").into_iter().next().ok_or_else(|| Error::new(codes::NOT_FOUND, format!("unknown commit: {sha}")))
}

struct Meta {
    author: String,
    mail: String,
    time: i64,
    summary: String,
    previous: Option<(String, String)>,
    boundary: bool,
    path: String,
}

fn is_sha(s: &str) -> bool {
    s.len() >= 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_blame(buf: &[u8]) -> Vec<BlameRange> {
    let text = String::from_utf8_lossy(buf);
    let mut metas: std::collections::HashMap<String, Meta> = std::collections::HashMap::new();
    let mut ranges: Vec<BlameRange> = Vec::new();
    let mut cur: Option<(String, u32)> = None; // sha and final line of the current entry
    let blank = || Meta {
        author: String::new(),
        mail: String::new(),
        time: 0,
        summary: String::new(),
        previous: None,
        boundary: false,
        path: String::new(),
    };
    for line in text.split('\n') {
        if let Some((sha, final_line)) = cur.clone() {
            if line.starts_with('\t') {
                // The text line ends the entry.
                let m = metas.get(&sha);
                match ranges.last_mut() {
                    Some(r) if r.sha == sha && r.start_line + r.line_count == final_line => r.line_count += 1,
                    _ => {
                        let m = m.map(|m| (m.author.clone(), m.mail.clone(), m.time, m.summary.clone(), m.previous.clone(), m.boundary, m.path.clone()));
                        let (author, mail, time, summary, previous, boundary, path) = m.unwrap_or_default();
                        let uncommitted = sha.bytes().all(|b| b == b'0');
                        ranges.push(BlameRange {
                            start_line: final_line,
                            line_count: 1,
                            author,
                            author_email: mail.trim_matches(['<', '>']).to_string(),
                            author_time: time,
                            summary,
                            previous_sha: previous.as_ref().map(|p| p.0.clone()),
                            previous_path: previous.map(|p| p.1),
                            uncommitted,
                            boundary,
                            path,
                            sha,
                        });
                    }
                }
                cur = None;
                continue;
            }
            let meta = metas.entry(sha).or_insert_with(blank);
            let (key, val) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "author" => meta.author = val.to_string(),
                "author-mail" => meta.mail = val.to_string(),
                "author-time" => meta.time = val.parse().unwrap_or(0),
                "summary" => meta.summary = val.to_string(),
                "previous" => {
                    if let Some((s, p)) = val.split_once(' ') {
                        meta.previous = Some((s.to_string(), p.to_string()));
                    }
                }
                "boundary" => meta.boundary = true,
                "filename" => meta.path = val.to_string(),
                _ => {}
            }
        } else {
            // Header: <sha> <orig line> <final line> [<group size>]
            let mut f = line.split(' ');
            let (Some(sha), Some(_), Some(fin)) = (f.next(), f.next(), f.next()) else { continue };
            if is_sha(sha) {
                cur = Some((sha.to_string(), fin.parse().unwrap_or(0)));
            }
        }
    }
    ranges
}

/// Blame of `path`. With `contents`, git blames that text (the editor buffer)
/// instead of the file on disk, so unsaved edits show as not committed.
/// Fails with `not_found` when the file is not tracked.
pub fn blame(root: &Path, path: &str, contents: Option<&str>) -> Result<Vec<BlameRange>> {
    clean_path(path)?;
    let job = Job::default();
    let top = top_level(root, &job)?;
    let mut args = vec!["--literal-pathspecs", "blame", "--porcelain", "-M"];
    if contents.is_some() {
        args.extend(["--contents", "-"]);
    }
    args.extend(["--", path]);
    let out = run_input(Path::new(&top), &args, &job, contents.map(str::as_bytes))?;
    if !out.ok() {
        let e = &out.stderr;
        if e.contains("no such path") || e.contains("no such ref") || e.contains("does not have any commits") {
            return Err(Error::new(codes::NOT_FOUND, format!("not tracked by git: {path}")));
        }
        return Err(failure(&out));
    }
    Ok(parse_blame(&out.stdout))
}
