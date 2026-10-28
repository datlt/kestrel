//! Parsers for git output. They read the bytes once and copy only the strings
//! they keep.

use crate::{BranchInfo, DiffEntry, EntryKind, StatusEntry};
use std::borrow::Cow;

fn text(b: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(b)
}

/// Parses `git status --porcelain=v2 -z --branch`.
pub fn parse_status(buf: &[u8]) -> (BranchInfo, Vec<StatusEntry>) {
    let mut branch = BranchInfo::default();
    let mut entries = Vec::new();
    let mut it = buf.split(|&b| b == 0);
    while let Some(tok) = it.next() {
        let Some(&first) = tok.first() else { continue };
        match first {
            b'#' => parse_header(&text(tok), &mut branch),
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let s = text(tok);
                let mut f = s.splitn(9, ' ');
                let Some(xy) = f.nth(1) else { continue };
                let Some(path) = f.nth(6) else { continue };
                entries.push(entry(path, None, EntryKind::Ordinary, xy, None));
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
                let s = text(tok);
                let mut f = s.splitn(10, ' ');
                let Some(xy) = f.nth(1) else { continue };
                let Some(score) = f.nth(6) else { continue };
                let Some(path) = f.next() else { continue };
                let orig = it.next().map(|o| text(o).into_owned());
                let kind = if score.starts_with('C') { EntryKind::Copied } else { EntryKind::Renamed };
                let score = score.get(1..).and_then(|n| n.parse().ok());
                entries.push(entry(path, orig, kind, xy, score));
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let s = text(tok);
                let mut f = s.splitn(11, ' ');
                let Some(xy) = f.nth(1) else { continue };
                let Some(path) = f.nth(8) else { continue };
                entries.push(entry(path, None, EntryKind::Unmerged, xy, None));
            }
            b'?' => {
                if let Some(path) = text(tok).get(2..) {
                    entries.push(entry(path, None, EntryKind::Untracked, "??", None));
                }
            }
            _ => {}
        }
    }
    (branch, entries)
}

fn entry(path: &str, orig: Option<String>, kind: EntryKind, xy: &str, score: Option<u32>) -> StatusEntry {
    let mut c = xy.chars();
    let index = c.next().unwrap_or('.');
    let worktree = c.next().unwrap_or('.');
    let tracked = matches!(kind, EntryKind::Ordinary | EntryKind::Renamed | EntryKind::Copied);
    StatusEntry {
        path: path.to_string(),
        orig_path: orig,
        kind,
        index,
        worktree,
        score,
        staged: tracked && index != '.',
        unstaged: tracked && worktree != '.',
    }
}

fn parse_header(line: &str, b: &mut BranchInfo) {
    let Some(rest) = line.strip_prefix("# ") else { return };
    let Some((key, value)) = rest.split_once(' ') else { return };
    match key {
        "branch.oid" => b.head = if value == "(initial)" { None } else { Some(value.to_string()) },
        "branch.head" => {
            if value == "(detached)" {
                b.detached = true;
            } else {
                b.branch = Some(value.to_string());
            }
        }
        "branch.upstream" => b.upstream = Some(value.to_string()),
        "branch.ab" => {
            // +ahead -behind
            let mut f = value.split(' ');
            b.ahead = f.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            b.behind = f.next().and_then(|a| a.trim_start_matches('-').parse().ok()).unwrap_or(0);
        }
        _ => {}
    }
}

/// Parses `git diff --name-status -z -M`.
pub fn parse_name_status(buf: &[u8]) -> Vec<DiffEntry> {
    let mut out = Vec::new();
    let mut it = buf.split(|&b| b == 0);
    while let Some(st) = it.next() {
        let Some(&c) = st.first() else { continue };
        let status = c as char;
        let score = std::str::from_utf8(&st[1..]).ok().and_then(|n| n.parse().ok());
        if matches!(status, 'R' | 'C') {
            let (Some(old), Some(new)) = (it.next(), it.next()) else { break };
            out.push(DiffEntry {
                status,
                score,
                path: text(new).into_owned(),
                orig_path: Some(text(old).into_owned()),
            });
        } else {
            let Some(path) = it.next() else { break };
            out.push(DiffEntry { status, score, path: text(path).into_owned(), orig_path: None });
        }
    }
    out
}

/// Reads `%(upstream:track)`: `[ahead 2, behind 1]`, `[ahead 2]`, `[behind 1]`,
/// `[gone]` or an empty text. Gives (ahead, behind, gone).
pub fn parse_track(s: &str) -> (u32, u32, bool) {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    if s == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in s.split(',') {
        let mut w = part.split_whitespace();
        match (w.next(), w.next().and_then(|n| n.parse::<u32>().ok())) {
            (Some("ahead"), Some(n)) => ahead = n,
            (Some("behind"), Some(n)) => behind = n,
            _ => {}
        }
    }
    (ahead, behind, false)
}
