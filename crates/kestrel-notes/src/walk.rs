//! Finding the files of a notes folder (DESIGN.md 14.2). The walk follows
//! `.gitignore`, never enters a folder whose name starts with a dot, skips
//! some tool folders, and skips `build`, `out` and `target` folders that sit
//! next to a build file.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{Match, WalkBuilder};
use kestrel_common::paths::relative_slash;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// At most this many notes are kept. The first ones by path win.
pub const MAX_NOTES: usize = 20_000;
/// At most this many other files are kept.
pub const MAX_FILES: usize = 200_000;

const SKIP_DIRS: &[&str] = &["node_modules", "Pods", "Carthage", "DerivedData"];
const BUILD_DIRS: &[&str] = &["build", "out", "target"];
const BUILD_FILES: &[&str] = &["build.gradle", "build.gradle.kts", "pom.xml", "Package.swift", "Cargo.toml", "package.json"];

/// True when a folder with this name and parent must be skipped.
pub fn skip_dir(name: &str, parent: &Path) -> bool {
    if name.starts_with('.') || SKIP_DIRS.contains(&name) {
        return true;
    }
    BUILD_DIRS.contains(&name) && BUILD_FILES.iter().any(|f| parent.join(f).is_file())
}

/// True for `.md`, `.markdown` and `.mdx` (any case).
pub fn is_note_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) => !stem.is_empty() && is_md_ext(ext),
        None => false,
    }
}

pub fn is_md_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") || ext.eq_ignore_ascii_case("mdx")
}

/// Relative paths found by a walk, both sorted.
#[derive(Default)]
pub struct Walked {
    pub notes: Vec<String>,
    pub files: Vec<String>,
    /// More notes were found than `MAX_NOTES`.
    pub truncated: bool,
}

/// Walks `base` (the root, or a folder inside it) and lists the files.
pub fn walk(root: &Path, base: &Path, cancel: &AtomicBool) -> Walked {
    let mut b = WalkBuilder::new(base);
    b.hidden(false).require_git(false).follow_links(false).filter_entry(|e| {
        if e.depth() == 0 || !e.file_type().is_some_and(|t| t.is_dir()) {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        match e.path().parent() {
            Some(parent) => !skip_dir(&name, parent),
            None => true,
        }
    });
    let mut out = Walked::default();
    for entry in b.build().flatten() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let note = is_note_name(&name);
        if !note && name.starts_with('.') {
            continue;
        }
        let Some(rel) = relative_slash(root, entry.path()) else { continue };
        if note {
            out.notes.push(rel);
        } else {
            out.files.push(rel);
        }
    }
    out.notes.sort_unstable();
    out.files.sort_unstable();
    if out.notes.len() > MAX_NOTES {
        out.notes.truncate(MAX_NOTES);
        out.truncated = true;
    }
    out.files.truncate(MAX_FILES);
    out
}

/// Checks single paths (from the file watcher) against the same rules.
pub struct Ignorer {
    root: PathBuf,
    cache: HashMap<PathBuf, Option<Gitignore>>,
}

impl Ignorer {
    pub fn new(root: &Path) -> Self {
        Ignorer { root: root.to_path_buf(), cache: HashMap::new() }
    }

    fn level(&mut self, dir: &Path) -> Option<&Gitignore> {
        if !self.cache.contains_key(dir) {
            let mut b = GitignoreBuilder::new(dir);
            b.add(dir.join(".gitignore"));
            b.add(dir.join(".ignore"));
            let gi = b.build().ok().filter(|g| !g.is_empty());
            self.cache.insert(dir.to_path_buf(), gi);
        }
        self.cache.get(dir).and_then(|g| g.as_ref())
    }

    /// True when the path must not be in the index: it is outside the root,
    /// in a skipped folder, or an ignore file lists it. `is_dir` tells what
    /// the path itself is.
    pub fn is_ignored(&mut self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else { return true };
        let comps: Vec<_> = rel.components().collect();
        if comps.is_empty() {
            return false;
        }
        let mut cur = self.root.clone();
        let mut levels = vec![self.root.clone()];
        for (i, c) in comps.iter().enumerate() {
            let last = i + 1 == comps.len();
            let dir_here = !last || is_dir;
            let parent = cur.clone();
            let name = c.as_os_str().to_string_lossy();
            cur.push(c);
            if dir_here && skip_dir(&name, &parent) {
                return true;
            }
            if last && !is_dir && name.starts_with('.') && !is_note_name(&name) {
                return true;
            }
            for d in levels.iter().rev() {
                if let Some(gi) = self.level(d) {
                    match gi.matched(&cur, dir_here) {
                        Match::Ignore(_) => return true,
                        Match::Whitelist(_) => break,
                        Match::None => {}
                    }
                }
            }
            if !last {
                levels.push(cur.clone());
            }
        }
        false
    }
}
