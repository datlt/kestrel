//! One index per root, shared by the windows that use the root. Same pattern
//! as `CodeManager` in `kestrel-code`: owners by window label, build once,
//! callers wait while it builds, changes during a build are applied after it.

use crate::index::{abs_path, build_index, update_index, Index};
use crate::resolve::{dir_of, Item, Outcome};
use crate::scan::{clean_dest, split_wiki};
use crate::types::{IndexState, NoteGraph, NoteIndexStatus, NoteNodeKind, ResolvedLink};
use kestrel_common::paths::{normalize, relative_slash};
use kestrel_common::{Error, Result};
use parking_lot::{Condvar, Mutex};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(PartialEq, Eq, Clone, Copy)]
enum Phase {
    None,
    Building,
    Ready,
}

struct State {
    phase: Phase,
    index: Option<Arc<Index>>,
    /// Changes that arrived while the index was building.
    pending: Vec<PathBuf>,
    pending_rescan: bool,
}

struct Root {
    path: PathBuf,
    owners: Mutex<HashSet<String>>,
    state: Mutex<State>,
    cv: Condvar,
    /// Serializes updates.
    update_lock: Mutex<()>,
}

/// Shared by all windows. Cloning gives another handle to the same state.
#[derive(Clone, Default)]
pub struct NoteManager {
    roots: Arc<Mutex<HashMap<PathBuf, Arc<Root>>>>,
}

fn root_path(root: &str) -> Result<PathBuf> {
    let p = normalize(&PathBuf::from(root));
    if !p.is_dir() {
        return Err(Error::not_found(format!("not a folder: {root}")));
    }
    Ok(p)
}

impl NoteManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn acquire(&self, owner: &str, root: &str) -> Result<Arc<Root>> {
        let path = root_path(root)?;
        let mut roots = self.roots.lock();
        let r = roots
            .entry(path.clone())
            .or_insert_with(|| {
                Arc::new(Root {
                    path,
                    owners: Mutex::new(HashSet::new()),
                    state: Mutex::new(State { phase: Phase::None, index: None, pending: vec![], pending_rescan: false }),
                    cv: Condvar::new(),
                    update_lock: Mutex::new(()),
                })
            })
            .clone();
        r.owners.lock().insert(owner.to_owned());
        Ok(r)
    }

    /// Waits while another request builds, or builds the index itself.
    fn index_of(&self, root: &Arc<Root>, cancel: &AtomicBool) -> Result<Arc<Index>> {
        let mut st = root.state.lock();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::cancelled());
            }
            match st.phase {
                Phase::Ready => return Ok(st.index.clone().expect("ready index")),
                Phase::Building => {
                    root.cv.wait_for(&mut st, Duration::from_millis(50));
                }
                Phase::None => break,
            }
        }
        st.phase = Phase::Building;
        drop(st);
        let fail = |e: Error| {
            root.state.lock().phase = Phase::None;
            root.cv.notify_all();
            e
        };
        let mut result = build_index(&root.path, None, cancel).map_err(fail)?;
        // Apply the changes that arrived during the build.
        loop {
            let (paths, rescan) = {
                let mut st = root.state.lock();
                if st.pending.is_empty() && !st.pending_rescan {
                    let idx = Arc::new(result);
                    st.index = Some(idx.clone());
                    st.phase = Phase::Ready;
                    root.cv.notify_all();
                    return Ok(idx);
                }
                (std::mem::take(&mut st.pending), std::mem::take(&mut st.pending_rescan))
            };
            result = update_index(&result, &paths, rescan, cancel).map_err(fail)?;
        }
    }

    /// The status of an index. Never starts a build.
    pub fn status(&self, root: &str) -> NoteIndexStatus {
        let none = NoteIndexStatus { state: IndexState::None, notes: 0, files: 0, build_ms: 0 };
        let Ok(path) = root_path(root) else { return none };
        let Some(r) = self.roots.lock().get(&path).cloned() else { return none };
        let st = r.state.lock();
        match (st.phase, &st.index) {
            (Phase::Ready, Some(i)) => NoteIndexStatus {
                state: IndexState::Ready,
                notes: i.note_count(),
                files: i.file_count(),
                build_ms: i.build_ms(),
            },
            (Phase::Building, _) => NoteIndexStatus { state: IndexState::Building, ..none },
            _ => none,
        }
    }

    /// Applies file changes. Does nothing when the index was not built yet.
    pub fn update(&self, root: &str, paths: &[String], rescan: bool) -> Result<()> {
        let path = root_path(root)?;
        let Some(r) = self.roots.lock().get(&path).cloned() else { return Ok(()) };
        let list: Vec<PathBuf> = paths.iter().map(|p| normalize(&PathBuf::from(p))).collect();
        let _guard = r.update_lock.lock();
        let old = {
            let mut st = r.state.lock();
            match st.phase {
                Phase::None => return Ok(()),
                Phase::Building => {
                    st.pending.extend(list);
                    st.pending_rescan |= rescan;
                    return Ok(());
                }
                Phase::Ready => st.index.clone().expect("ready index"),
            }
        };
        let new = update_index(&old, &list, rescan, &AtomicBool::new(false))?;
        r.state.lock().index = Some(Arc::new(new));
        Ok(())
    }

    /// The window `owner` does not use `root` any more. The index is freed with no owners.
    pub fn drop_root(&self, owner: &str, root: &str) {
        let path = normalize(&PathBuf::from(root));
        let mut roots = self.roots.lock();
        if let Some(r) = roots.get(&path) {
            let empty = {
                let mut o = r.owners.lock();
                o.remove(owner);
                o.is_empty()
            };
            if empty {
                roots.remove(&path);
            }
        }
    }

    /// Removes the window from all roots.
    pub fn window_destroyed(&self, owner: &str) {
        self.roots.lock().retain(|_, r| {
            let mut o = r.owners.lock();
            o.remove(owner);
            !o.is_empty()
        });
    }

    /// Number of roots with an index (for tests).
    pub fn root_count(&self) -> usize {
        self.roots.lock().len()
    }

    /// The whole graph of the root. Builds the index on the first call and
    /// waits while it builds.
    pub fn graph(&self, owner: &str, root: &str, cancel: &AtomicBool) -> Result<NoteGraph> {
        let start = Instant::now();
        let r = self.acquire(owner, root)?;
        let index = self.index_of(&r, cancel)?;
        let data = index.graph(cancel)?;
        Ok(NoteGraph { data, elapsed_ms: start.elapsed().as_millis() as u64 })
    }

    /// Resolves one link of the note `from` like the graph does.
    pub fn resolve(&self, owner: &str, root: &str, from: &str, target: &str, wiki: bool) -> Result<Option<ResolvedLink>> {
        let r = self.acquire(owner, root)?;
        let index = self.index_of(&r, &AtomicBool::new(false))?;
        Ok(resolve_link(&index, &normalize(&PathBuf::from(from)), target, wiki))
    }
}

/// The rules of `notes_resolve` on one index.
pub fn resolve_link(index: &Index, from: &std::path::Path, target: &str, wiki: bool) -> Option<ResolvedLink> {
    let (path, fragment) = if wiki {
        let (t, h) = split_wiki(target);
        (t.to_owned(), h.map(str::to_owned))
    } else {
        let c = clean_dest(target)?;
        (c.target, c.fragment)
    };
    if path.trim().is_empty() {
        return None;
    }
    let (heading, block) = match fragment.as_deref().map(str::trim) {
        Some(h) if !h.is_empty() => match h.strip_prefix('^') {
            Some(b) => (Some(b.to_owned()), true),
            None => (Some(h.to_owned()), false),
        },
        _ => (None, false),
    };
    let from_rel = relative_slash(index.root(), from).unwrap_or_default();
    let from_dir = dir_of(&from_rel);
    let resolver = index.resolver();
    match resolver.resolve(index, from_dir, &path, wiki) {
        Outcome::Found(it) => {
            let rel = index.rel_of(it);
            let kind = if matches!(it, Item::Note(_)) { NoteNodeKind::Note } else { NoteNodeKind::Attachment };
            Some(ResolvedLink {
                path: abs_path(index.root(), rel).to_string_lossy().into_owned(),
                exists: true,
                kind,
                heading,
                block,
            })
        }
        Outcome::Missing { rel, .. } => {
            Some(ResolvedLink {
                path: abs_path(index.root(), &rel).to_string_lossy().into_owned(),
                exists: false,
                kind: NoteNodeKind::Missing,
                heading,
                block,
            })
        }
        Outcome::Ignore => None,
    }
}
