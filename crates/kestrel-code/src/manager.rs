//! One index per root, shared by the windows that use the root.

use crate::diagram;
use crate::find::{FindRequest, FindResult, SymbolHit, TypeHit};
use crate::index::{build_index, update_index, Index};
use crate::types::*;
use crate::usages;
use kestrel_common::paths::normalize;
use kestrel_common::{Error, Result};
use parking_lot::{Condvar, Mutex};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
    dropped: AtomicBool,
}

/// Shared by all windows. Cloning gives another handle to the same state.
#[derive(Clone, Default)]
pub struct CodeManager {
    roots: Arc<Mutex<HashMap<PathBuf, Arc<Root>>>>,
}

fn status_of(index: &Index) -> CodeIndexStatus {
    CodeIndexStatus { state: IndexState::Ready, files: index.files.len(), types: index.type_count, build_ms: index.build_ms }
}

fn root_path(root: &str) -> Result<PathBuf> {
    let p = normalize(&PathBuf::from(root));
    if !p.is_dir() {
        return Err(Error::not_found(format!("not a folder: {root}")));
    }
    Ok(p)
}

fn norm_str(p: &str) -> String {
    normalize(&PathBuf::from(p)).to_string_lossy().into_owned()
}

impl CodeManager {
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
                    dropped: AtomicBool::new(false),
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
        let built = build_index(&root.path, cancel);
        let mut result = match built {
            Ok(i) => i,
            Err(e) => {
                root.state.lock().phase = Phase::None;
                root.cv.notify_all();
                return Err(e);
            }
        };
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
            match update_index(&result, &paths, rescan, cancel) {
                Ok(i) => result = i,
                Err(e) => {
                    root.state.lock().phase = Phase::None;
                    root.cv.notify_all();
                    return Err(e);
                }
            }
        }
    }

    /// The status of an index. Never starts a build.
    pub fn status(&self, root: &str) -> CodeIndexStatus {
        let none = CodeIndexStatus { state: IndexState::None, files: 0, types: 0, build_ms: 0 };
        let Ok(path) = root_path(root) else { return none };
        let Some(r) = self.roots.lock().get(&path).cloned() else { return none };
        let st = r.state.lock();
        match (st.phase, &st.index) {
            (Phase::Ready, Some(i)) => status_of(i),
            (Phase::Building, _) => CodeIndexStatus { state: IndexState::Building, ..none },
            _ => none,
        }
    }

    /// Applies file changes. Does nothing when the index was not built yet.
    pub fn update(&self, root: &str, paths: &[String], rescan: bool) -> Result<()> {
        let path = root_path(root)?;
        let Some(r) = self.roots.lock().get(&path).cloned() else { return Ok(()) };
        let list: Vec<PathBuf> = paths.iter().map(|p| PathBuf::from(norm_str(p))).collect();
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
        let mut st = r.state.lock();
        st.index = Some(Arc::new(new));
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
                r.dropped.store(true, Ordering::Relaxed);
                roots.remove(&path);
            }
        }
    }

    /// Removes the window from all roots.
    pub fn window_destroyed(&self, owner: &str) {
        let mut roots = self.roots.lock();
        roots.retain(|_, r| {
            let mut o = r.owners.lock();
            o.remove(owner);
            if o.is_empty() {
                r.dropped.store(true, Ordering::Relaxed);
                false
            } else {
                true
            }
        });
    }

    pub fn root_count(&self) -> usize {
        self.roots.lock().len()
    }

    pub fn diagram(&self, owner: &str, req: &DiagramRequest, cancel: &AtomicBool) -> Result<DiagramResult> {
        let r = self.acquire(owner, &req.root)?;
        let index = self.index_of(&r, cancel)?;
        let mut req = req.clone();
        req.scope = match req.scope {
            DiagramScope::Cursor { path, line, column, text } => DiagramScope::Cursor { path: norm_str(&path), line, column, text },
            DiagramScope::File { path, text } => DiagramScope::File { path: norm_str(&path), text },
            DiagramScope::Folder { path } => DiagramScope::Folder { path: norm_str(&path) },
            s => s,
        };
        diagram::run(&index, &req, status_of(&index), cancel)
    }

    pub fn usages(&self, owner: &str, req: &UsagesRequest, cancel: &AtomicBool) -> Result<UsagesResult> {
        let r = self.acquire(owner, &req.root)?;
        let index = self.index_of(&r, cancel)?;
        let mut req = req.clone();
        req.path = norm_str(&req.path);
        req.root = r.path.to_string_lossy().into_owned();
        usages::run(&index, &req, cancel)
    }

    pub fn callers(&self, owner: &str, req: &CallersRequest, cancel: &AtomicBool) -> Result<CallersResult> {
        let r = self.acquire(owner, &req.root)?;
        let index = self.index_of(&r, cancel)?;
        let mut req = req.clone();
        req.root = r.path.to_string_lossy().into_owned();
        if let Some(at) = &mut req.at {
            at.path = norm_str(&at.path);
        }
        if let Some(t) = &mut req.target {
            t.path = norm_str(&t.path);
        }
        crate::callers::run(&index, &req, cancel)
    }

    pub fn find_types(&self, owner: &str, req: &FindRequest, cancel: &AtomicBool) -> Result<FindResult<TypeHit>> {
        let r = self.acquire(owner, &req.root)?;
        let index = self.index_of(&r, cancel)?;
        crate::find::find_types(&index, req, status_of(&index), cancel)
    }

    pub fn find_symbols(&self, owner: &str, req: &FindRequest, cancel: &AtomicBool) -> Result<FindResult<SymbolHit>> {
        let r = self.acquire(owner, &req.root)?;
        let index = self.index_of(&r, cancel)?;
        crate::find::find_symbols(&index, req, status_of(&index), cancel)
    }
}
