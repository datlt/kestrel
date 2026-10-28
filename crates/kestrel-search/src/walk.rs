//! Shared folder walk settings and the ignore check for single paths.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{Match, WalkBuilder};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A walker that sees dotfiles, respects ignore files (also outside a git
/// repo) and never enters `.git`.
pub fn walker(path: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(path);
    b.hidden(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git");
    b
}

/// Relative path with `/` separators. `None` when it is not valid UTF-8.
pub fn rel_slash(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?.to_str()?;
    if cfg!(windows) { Some(rel.replace('\\', "/")) } else { Some(rel.to_owned()) }
}

/// Checks one path against the ignore files between the root and the path.
/// The walker does this while it walks. We need it for single paths that the
/// file watcher reports.
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
            if dir == self.root {
                b.add(dir.join(".git").join("info").join("exclude"));
            }
            let gi = b.build().ok().filter(|g| !g.is_empty());
            self.cache.insert(dir.to_path_buf(), gi);
        }
        self.cache.get(dir).and_then(|g| g.as_ref())
    }

    pub fn is_ignored(&mut self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else { return false };
        let comps: Vec<_> = rel.components().collect();
        let mut cur = self.root.clone();
        let mut levels = vec![self.root.clone()];
        for (i, c) in comps.iter().enumerate() {
            cur.push(c);
            let last = i + 1 == comps.len();
            let cur_is_dir = !last || is_dir;
            // The ignore file in the deepest folder wins.
            for d in levels.iter().rev() {
                if let Some(gi) = self.level(d) {
                    match gi.matched(&cur, cur_is_dir) {
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
