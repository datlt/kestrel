//! Folder watcher. Events are debounced and sent as one batch (docs/DESIGN.md, 5.2).

use kestrel_common::{Error, Result};
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::Duration;

pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// More paths than this in one batch: send `rescan` instead.
pub const MAX_PATHS: usize = 5000;

/// One batch of changes. Same shape as `FsChangeEvent` in `src/core/types.ts`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub root: String,
    pub paths: Vec<String>,
    pub git_changed: bool,
    pub rescan: bool,
}

/// Is this a path inside a `.git` folder that can change `git status`?
/// Returns `None` when the path is not inside `.git`.
fn git_path_kind(path: &Path) -> Option<bool> {
    let mut comps = path.components().peekable();
    while let Some(c) = comps.next() {
        if matches!(c, Component::Normal(n) if n == ".git") {
            let rest: Vec<String> = comps.map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            let relevant = match rest.first().map(String::as_str) {
                Some("HEAD" | "index" | "packed-refs" | "MERGE_HEAD") => rest.len() == 1,
                Some("refs") => rest.len() > 1,
                _ => false,
            };
            return Some(relevant);
        }
    }
    None
}

/// Turns raw events into one batch. Returns `None` when nothing is worth reporting.
pub fn build_change(root: &Path, events: &[DebouncedEvent]) -> Option<FsChange> {
    let mut paths = BTreeSet::new();
    let mut git_changed = false;
    for ev in events {
        if matches!(ev.kind, EventKind::Access(_)) {
            continue;
        }
        for p in &ev.paths {
            match git_path_kind(p) {
                Some(relevant) => git_changed |= relevant,
                None => {
                    paths.insert(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    if paths.is_empty() && !git_changed {
        return None;
    }
    let root = root.to_string_lossy().into_owned();
    if paths.len() > MAX_PATHS {
        return Some(FsChange { root, paths: Vec::new(), git_changed, rescan: true });
    }
    Some(FsChange { root, paths: paths.into_iter().collect(), git_changed, rescan: false })
}

/// Watches a folder tree until it is dropped.
pub struct Watcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, NoCache>,
}

impl Watcher {
    /// Starts watching `root`. `on_change` runs on the watcher thread.
    pub fn start(root: &Path, on_change: Arc<dyn Fn(FsChange) + Send + Sync>) -> Result<Watcher> {
        Self::start_with(root, DEBOUNCE, on_change)
    }

    pub fn start_with(root: &Path, debounce: Duration, on_change: Arc<dyn Fn(FsChange) + Send + Sync>) -> Result<Watcher> {
        let root_buf = root.to_path_buf();
        let handler = {
            let root = root_buf.clone();
            move |res: DebounceEventResult| match res {
                Ok(events) => {
                    if let Some(change) = build_change(&root, &events) {
                        on_change(change);
                    }
                }
                // The watcher lost events (for example an overflow). Everything must be read again.
                Err(errors) => {
                    log::warn!("watcher errors: {errors:?}");
                    on_change(FsChange {
                        root: root.to_string_lossy().into_owned(),
                        paths: Vec::new(),
                        git_changed: true,
                        rescan: true,
                    });
                }
            }
        };
        // NoCache: the default cache reads the file ids of every file, which is slow in big folders.
        let mut deb: Debouncer<notify::RecommendedWatcher, NoCache> =
            new_debouncer_opt(debounce, None, handler, NoCache::new(), notify::Config::default())
                .map_err(|e| Error::internal(format!("watcher: {e}")))?;
        deb.watch(&root_buf, RecursiveMode::Recursive)
            .map_err(|e| Error::internal(format!("watch {}: {e}", root_buf.display())))?;
        Ok(Watcher { _debouncer: deb })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::Event;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::mpsc;

    fn ev(kind: EventKind, p: &str) -> DebouncedEvent {
        DebouncedEvent::new(Event::new(kind).add_path(PathBuf::from(p)), std::time::Instant::now())
    }
    const MODIFY: EventKind = EventKind::Modify(notify::event::ModifyKind::Any);

    #[test]
    fn git_paths() {
        let root = Path::new("/r");
        let c = build_change(root, &[ev(MODIFY, "/r/.git/HEAD")]).unwrap();
        assert!(c.git_changed && c.paths.is_empty() && !c.rescan);
        for p in ["/r/.git/index", "/r/.git/refs/heads/main", "/r/.git/packed-refs", "/r/.git/MERGE_HEAD"] {
            assert!(build_change(root, &[ev(MODIFY, p)]).unwrap().git_changed, "{p}");
        }
        for p in ["/r/.git/index.lock", "/r/.git/objects/ab/cdef", "/r/.git/refs", "/r/.git/logs/HEAD", "/r/.git"] {
            assert!(build_change(root, &[ev(MODIFY, p)]).is_none(), "{p}");
        }
        // Mixed batch: the source file is listed, the .git path is not.
        let c = build_change(root, &[ev(MODIFY, "/r/a.rs"), ev(MODIFY, "/r/.git/index")]).unwrap();
        assert_eq!(c.paths, ["/r/a.rs"]);
        assert!(c.git_changed);
    }

    #[test]
    fn access_events_are_skipped_and_paths_deduplicated() {
        let root = Path::new("/r");
        let access = EventKind::Access(notify::event::AccessKind::Any);
        assert!(build_change(root, &[ev(access, "/r/a")]).is_none());
        let c = build_change(root, &[ev(MODIFY, "/r/b"), ev(MODIFY, "/r/a"), ev(MODIFY, "/r/b")]).unwrap();
        assert_eq!(c.paths, ["/r/a", "/r/b"]);
    }

    #[test]
    fn too_many_paths_means_rescan() {
        let events: Vec<_> = (0..MAX_PATHS + 1).map(|i| ev(MODIFY, &format!("/r/f{i}"))).collect();
        let c = build_change(Path::new("/r"), &events).unwrap();
        assert!(c.rescan && c.paths.is_empty());
        let events: Vec<_> = (0..MAX_PATHS).map(|i| ev(MODIFY, &format!("/r/f{i}"))).collect();
        let c = build_change(Path::new("/r"), &events).unwrap();
        assert!(!c.rescan && c.paths.len() == MAX_PATHS);
    }

    #[test]
    fn real_folder_batches_changes() {
        let d = tempfile::tempdir().unwrap();
        let root = kestrel_common::paths::normalize(d.path());
        fs::create_dir(root.join(".git")).unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let w = Watcher::start_with(
            &root,
            Duration::from_millis(150),
            Arc::new(move |c| {
                let _ = tx.lock().unwrap().send(c);
            }),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        for i in 0..10 {
            fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

        // Collect batches until nothing arrives for a while.
        let mut batches = Vec::new();
        while let Ok(c) = rx.recv_timeout(Duration::from_secs(2)) {
            batches.push(c);
        }
        drop(w);
        let all: BTreeSet<String> = batches.iter().flat_map(|b| b.paths.clone()).collect();
        for i in 0..10 {
            let p = root.join(format!("f{i}.txt")).to_string_lossy().into_owned();
            assert!(all.contains(&p), "missing {p} in {all:?}");
        }
        assert!(batches.iter().any(|b| b.git_changed));
        assert!(all.iter().all(|p| !p.contains(".git")));
        // 10 writes in a burst must not make 10 batches.
        assert!(batches.len() <= 3, "too many batches: {}", batches.len());
    }
}
