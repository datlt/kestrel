//! Finding the source files of a project. Rules (DESIGN.md 11.3): follow
//! `.gitignore`, see hidden files, never enter `.git`, always skip some
//! tool folders, skip `build`, `out` and `target` folders that sit next to a
//! build file, skip files bigger than 5 MB.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{Match, WalkBuilder};
use kestrel_lang::Lang;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

const SKIP_DIRS: &[&str] =
    &[".git", ".gradle", ".idea", "node_modules", "Pods", "Carthage", "DerivedData", ".build", ".swiftpm"];
const BUILD_DIRS: &[&str] = &["build", "out", "target"];
const BUILD_FILES: &[&str] = &["build.gradle", "build.gradle.kts", "pom.xml", "Package.swift"];

/// True when a folder with this name and parent must be skipped.
pub fn skip_dir(name: &str, parent: &Path) -> bool {
    if SKIP_DIRS.contains(&name) {
        return true;
    }
    BUILD_DIRS.contains(&name) && BUILD_FILES.iter().any(|f| parent.join(f).is_file())
}

pub fn lang_of(path: &Path) -> Option<Lang> {
    Lang::from_extension(path.extension()?.to_str()?)
}

pub struct Found {
    pub path: PathBuf,
    pub lang: Lang,
}

fn builder(base: &Path) -> WalkBuilder {
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
    b
}

/// Kotlin, Java and Swift files under `base`. Sorted by path.
pub fn list_family_files(base: &Path, cancel: &AtomicBool) -> Vec<Found> {
    let mut out = Vec::new();
    for entry in builder(base).build().flatten() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Some(lang) = lang_of(entry.path()) {
            out.push(Found { path: entry.into_path(), lang });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Files with one extension (any case) under `base`, for the search in other languages.
pub fn list_by_extension(base: &Path, ext: &str, cancel: &AtomicBool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in builder(base).build().flatten() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let same = entry.path().extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext));
        if same {
            out.push(entry.into_path());
        }
    }
    out.sort();
    out
}

/// Checks single paths (from the file watcher) against the ignore files.
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

    /// True when the file must not be in the index: it is in a skipped
    /// folder or an ignore file lists it.
    pub fn is_ignored(&mut self, path: &Path) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else { return true };
        let comps: Vec<_> = rel.components().collect();
        let mut cur = self.root.clone();
        let mut levels = vec![self.root.clone()];
        for (i, c) in comps.iter().enumerate() {
            let last = i + 1 == comps.len();
            let parent = cur.clone();
            cur.push(c);
            if !last && skip_dir(&c.as_os_str().to_string_lossy(), &parent) {
                return true;
            }
            for d in levels.iter().rev() {
                if let Some(gi) = self.level(d) {
                    match gi.matched(&cur, !last) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    #[test]
    fn skips_tool_folders_and_build_output() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        touch(r, "build.gradle.kts");
        touch(r, "src/A.kt");
        touch(r, "build/B.kt");
        touch(r, "Pods/C.swift");
        touch(r, ".idea/D.java");
        touch(r, "sub/build/E.kt");
        touch(r, "node_modules/x/F.java");
        touch(r, ".hidden/G.kt");
        touch(r, "notes.txt");
        let list = list_family_files(r, &AtomicBool::new(false));
        let names: Vec<_> = list.iter().map(|f| f.path.strip_prefix(r).unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(names, vec![".hidden/G.kt", "build.gradle.kts", "src/A.kt", "sub/build/E.kt"]);
    }

    #[test]
    fn follows_gitignore_without_git_repo() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::write(r.join(".gitignore"), "gen/\n").unwrap();
        touch(r, "gen/A.kt");
        touch(r, "src/B.kt");
        let list = list_family_files(r, &AtomicBool::new(false));
        assert_eq!(list.len(), 1);
        let mut ig = Ignorer::new(r);
        assert!(ig.is_ignored(&r.join("gen/A.kt")));
        assert!(!ig.is_ignored(&r.join("src/B.kt")));
        assert!(ig.is_ignored(&r.join("Pods/x.swift")));
    }
}
