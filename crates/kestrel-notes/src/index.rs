//! The index of one root: the notes with what the scanner found, and the
//! paths of the other files. It keeps no text. Resolved links are computed
//! from it when the graph is asked for, and cached until the next change.

use crate::graph::build_graph;
use crate::resolve::Resolver;
use crate::scan::{scan, RawLink, MAX_NOTE_BYTES};
use crate::types::GraphData;
use crate::walk::{walk, Ignorer, MAX_NOTES};
use kestrel_common::paths::to_slash;
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

/// One markdown file.
#[derive(Debug)]
pub struct NoteEntry {
    /// Path relative to the root, with `/`.
    pub rel: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub links: Vec<RawLink>,
}

/// The index of one root. It never changes after it is made: an update makes
/// a new one that shares the unchanged entries.
pub struct Index {
    pub(crate) root: PathBuf,
    /// Sorted by `rel`.
    pub(crate) notes: Vec<Arc<NoteEntry>>,
    /// Paths of the other files, sorted.
    pub(crate) files: Vec<Arc<str>>,
    pub(crate) truncated: bool,
    pub(crate) build_ms: u64,
    pub(crate) resolver: Mutex<Option<Arc<Resolver>>>,
    pub(crate) graph: Mutex<Option<Arc<GraphData>>>,
}

impl Index {
    /// Number of notes.
    pub fn note_count(&self) -> usize {
        self.notes.len()
    }

    /// Number of other files.
    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    /// Time of the last full build.
    pub fn build_ms(&self) -> u64 {
        self.build_ms
    }

    /// The root folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn resolver(&self) -> Arc<Resolver> {
        let mut g = self.resolver.lock();
        if let Some(r) = g.as_ref() {
            return r.clone();
        }
        let r = Arc::new(Resolver::build(self));
        *g = Some(r.clone());
        r
    }

    /// The graph of this index. It is made once and cached.
    pub(crate) fn graph(&self, cancel: &AtomicBool) -> Result<Arc<GraphData>> {
        let mut g = self.graph.lock();
        if let Some(d) = g.as_ref() {
            return Ok(d.clone());
        }
        let d = Arc::new(build_graph(self, cancel)?);
        *g = Some(d.clone());
        Ok(d)
    }

    /// The cached graph data. Public for the speed test.
    #[doc(hidden)]
    pub fn graph_for_bench(&self, cancel: &AtomicBool) -> Result<Arc<GraphData>> {
        self.graph(cancel)
    }

    pub(crate) fn find_note(&self, rel: &str) -> Option<&Arc<NoteEntry>> {
        self.notes.binary_search_by(|n| n.rel.as_str().cmp(rel)).ok().map(|i| &self.notes[i])
    }
}

/// The absolute path of a relative path with `/`.
pub fn abs_path(root: &Path, rel: &str) -> PathBuf {
    if cfg!(windows) { root.join(rel.replace('/', "\\")) } else { root.join(rel) }
}

fn mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// Reads one note. With `reuse`, an old entry with the same size and time is
/// returned without reading the file. `None` when the file is gone.
fn read_note(root: &Path, rel: &str, old: Option<&Arc<NoteEntry>>, reuse: bool) -> Option<Arc<NoteEntry>> {
    let path = abs_path(root, rel);
    let md = fs::metadata(&path).ok()?;
    if !md.is_file() {
        return None;
    }
    let (size, mtime) = (md.len(), mtime_ms(&md));
    if reuse {
        if let Some(o) = old.filter(|o| o.size == size && o.mtime_ms == mtime) {
            return Some(o.clone());
        }
    }
    let scanned = if size > MAX_NOTE_BYTES {
        Default::default()
    } else {
        let bytes = fs::read(&path).ok()?;
        scan(&String::from_utf8_lossy(&bytes))
    };
    Some(Arc::new(NoteEntry {
        rel: rel.to_owned(),
        size,
        mtime_ms: mtime,
        title: scanned.title,
        tags: scanned.tags,
        aliases: scanned.aliases,
        links: scanned.links,
    }))
}

fn new_index(root: &Path, notes: Vec<Arc<NoteEntry>>, files: Vec<Arc<str>>, truncated: bool, build_ms: u64) -> Index {
    Index { root: root.to_path_buf(), notes, files, truncated, build_ms, resolver: Mutex::new(None), graph: Mutex::new(None) }
}

/// Walks the root and reads all notes in parallel. With `old`, notes with the
/// same size and time are not read again.
pub fn build_index(root: &Path, old: Option<&Index>, cancel: &AtomicBool) -> Result<Index> {
    let start = Instant::now();
    let walked = walk(root, root, cancel);
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::cancelled());
    }
    let notes: Vec<Option<Arc<NoteEntry>>> = walked
        .notes
        .par_iter()
        .map(|rel| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            read_note(root, rel, old.and_then(|i| i.find_note(rel)), true)
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::cancelled());
    }
    let notes: Vec<Arc<NoteEntry>> = notes.into_iter().flatten().collect();
    let files: Vec<Arc<str>> = walked.files.into_iter().map(Arc::from).collect();
    Ok(new_index(root, notes, files, walked.truncated, start.elapsed().as_millis() as u64))
}

/// The lists of an index while an update changes them.
struct Edit<'a> {
    root: &'a Path,
    notes: Vec<Arc<NoteEntry>>,
    files: Vec<Arc<str>>,
    /// A path was added or removed.
    members_changed: bool,
    /// The aliases of a note changed.
    aliases_changed: bool,
}

impl Edit<'_> {
    fn note_pos(&self, rel: &str) -> std::result::Result<usize, usize> {
        self.notes.binary_search_by(|n| n.rel.as_str().cmp(rel))
    }

    fn file_pos(&self, rel: &str) -> std::result::Result<usize, usize> {
        self.files.binary_search_by(|f| (**f).cmp(rel))
    }

    fn upsert_note(&mut self, rel: &str, reuse: bool) {
        let pos = self.note_pos(rel);
        let old = pos.ok().map(|i| self.notes[i].clone());
        match (read_note(self.root, rel, old.as_ref(), reuse), pos) {
            (Some(e), Ok(i)) => {
                if self.notes[i].aliases != e.aliases {
                    self.aliases_changed = true;
                }
                self.notes[i] = e;
            }
            (Some(e), Err(i)) => {
                self.notes.insert(i, e);
                self.members_changed = true;
            }
            (None, Ok(i)) => {
                self.notes.remove(i);
                self.members_changed = true;
            }
            (None, Err(_)) => {}
        }
    }

    fn upsert_file(&mut self, rel: &str) {
        if let Err(i) = self.file_pos(rel) {
            self.files.insert(i, Arc::from(rel));
            self.members_changed = true;
        }
    }

    fn remove_exact(&mut self, rel: &str) {
        if let Ok(i) = self.note_pos(rel) {
            self.notes.remove(i);
            self.members_changed = true;
        }
        if let Ok(i) = self.file_pos(rel) {
            self.files.remove(i);
            self.members_changed = true;
        }
    }

    /// Removes everything below the folder `rel`, except the paths in `keep`.
    fn remove_below(&mut self, rel: &str, keep_notes: &[String], keep_files: &[String]) {
        let prefix = format!("{rel}/");
        let lo = self.notes.partition_point(|n| n.rel.as_str() < prefix.as_str());
        let hi = lo + self.notes[lo..].partition_point(|n| n.rel.starts_with(&prefix));
        let before = self.notes.len();
        let mut k = lo;
        let mut idx = lo;
        while idx < hi {
            if keep_notes.binary_search(&self.notes[idx].rel).is_ok() {
                self.notes.swap(k, idx);
                k += 1;
            }
            idx += 1;
        }
        self.notes.drain(k..hi);
        let lo = self.files.partition_point(|f| &**f < prefix.as_str());
        let hi = lo + self.files[lo..].partition_point(|f| f.starts_with(&prefix));
        let mut k = lo;
        let mut idx = lo;
        let files_before = self.files.len();
        while idx < hi {
            if keep_files.binary_search_by(|x| x.as_str().cmp(&self.files[idx])).is_ok() {
                self.files.swap(k, idx);
                k += 1;
            }
            idx += 1;
        }
        self.files.drain(k..hi);
        if self.notes.len() != before || self.files.len() != files_before {
            self.members_changed = true;
        }
    }
}

/// Makes a new index from `old` after the files in `paths` changed (absolute
/// paths, any type). `rescan` reads the whole folder again, but reuses the
/// notes whose size and time did not change.
pub fn update_index(old: &Index, paths: &[PathBuf], rescan: bool, cancel: &AtomicBool) -> Result<Index> {
    let root = old.root.as_path();
    if rescan {
        return build_index(root, Some(old), cancel);
    }
    let mut ed = Edit { root, notes: old.notes.clone(), files: old.files.clone(), members_changed: false, aliases_changed: false };
    let mut ignorer = Ignorer::new(root);
    for p in paths {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::cancelled());
        }
        let Ok(rel_path) = p.strip_prefix(root) else { continue };
        if rel_path.as_os_str().is_empty() {
            return build_index(root, Some(old), cancel);
        }
        let rel = to_slash(rel_path);
        match fs::symlink_metadata(p) {
            Ok(md) if md.is_dir() => {
                if ignorer.is_ignored(p, true) {
                    ed.remove_below(&rel, &[], &[]);
                } else {
                    let w = walk(root, p, cancel);
                    for n in &w.notes {
                        ed.upsert_note(n, true);
                    }
                    for f in &w.files {
                        ed.upsert_file(f);
                    }
                    ed.remove_below(&rel, &w.notes, &w.files);
                }
            }
            Ok(md) if md.is_file() => {
                if ignorer.is_ignored(p, false) {
                    ed.remove_exact(&rel);
                } else if crate::walk::is_note_name(&rel) {
                    ed.upsert_note(&rel, false);
                } else {
                    ed.upsert_file(&rel);
                }
            }
            _ => {
                ed.remove_exact(&rel);
                ed.remove_below(&rel, &[], &[]);
            }
        }
    }
    let mut truncated = old.truncated;
    if ed.notes.len() > MAX_NOTES {
        ed.notes.truncate(MAX_NOTES);
        truncated = true;
        ed.members_changed = true;
    }
    let keep_resolver = !ed.members_changed && !ed.aliases_changed;
    let idx = new_index(root, ed.notes, ed.files, truncated, old.build_ms);
    if keep_resolver {
        *idx.resolver.lock() = old.resolver.lock().clone();
    }
    Ok(idx)
}
