//! The index of one root: the `FileModel` of each file (never the text), and
//! the tables that are derived from the models.

use crate::derived::Derived;
use crate::textutil::{decode, fix_columns, word_hashes};
use crate::walk::{self, Ignorer, MAX_FILE_BYTES};
use kestrel_common::{Error, Result};
use crate::cmodel::CModel;
use kestrel_lang::Lang;
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Instant, UNIX_EPOCH};

pub struct FileEntry {
    pub path: PathBuf,
    pub lang: Lang,
    /// Modification time in milliseconds since 1970 (0 when unknown).
    pub mtime_ms: u64,
    pub size: u64,
    /// Sorted hashes of the words in the file text. Empty: unknown.
    pub words: Box<[u32]>,
    /// Columns are UTF-16 units (the parser's byte columns are converted).
    pub model: CModel,
}

pub struct Index {
    pub root: PathBuf,
    /// Sorted by path.
    pub files: Vec<Arc<FileEntry>>,
    pub build_ms: u64,
    pub type_count: usize,
    by_path: HashMap<PathBuf, u32>,
    derived: OnceLock<Derived>,
}

impl Index {
    pub fn new(root: PathBuf, mut files: Vec<Arc<FileEntry>>, build_ms: u64) -> Index {
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let by_path = files.iter().enumerate().map(|(i, f)| (f.path.clone(), i as u32)).collect();
        let type_count = files
            .iter()
            .map(|f| f.model.types.iter().filter(|t| t.kind != kestrel_lang::TypeKind::Extension).count())
            .sum();
        Index { root, files, build_ms, type_count, by_path, derived: OnceLock::new() }
    }

    /// The tables built from all models. Built on first use.
    pub fn derived(&self) -> &Derived {
        self.derived.get_or_init(|| Derived::build(&self.files))
    }

    pub fn file_id(&self, path: &Path) -> Option<u32> {
        self.by_path.get(path).copied()
    }

    pub fn file(&self, id: u32) -> &FileEntry {
        &self.files[id as usize]
    }

    /// A new index where one file has another model (the text of an editor
    /// with unsaved changes). The tables are built again for the new index.
    pub fn with_model(&self, path: &Path, lang: Lang, model: CModel) -> Index {
        let mut files = self.files.clone();
        let entry = Arc::new(FileEntry { path: path.to_path_buf(), lang, mtime_ms: 0, size: 0, words: Box::new([]), model });
        match self.file_id(path) {
            Some(i) => files[i as usize] = entry,
            None => files.push(entry),
        }
        Index::new(self.root.clone(), files, self.build_ms)
    }
}

/// Parses text into a model with UTF-16 columns.
pub fn parse_text(lang: Lang, text: &str) -> CModel {
    let mut model = kestrel_lang::parse(lang, text);
    fix_columns(&mut model, text);
    CModel::from_model(&model)
}

/// Reads and parses one file. `None` when it is too big or not readable.
pub fn parse_file(path: &Path, lang: Lang) -> Option<FileEntry> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let text = decode(bytes);
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    let words = word_hashes(text.as_bytes());
    Some(FileEntry { path: path.to_path_buf(), lang, mtime_ms, size: meta.len(), words, model: parse_text(lang, &text) })
}

pub fn build_index(root: &Path, cancel: &AtomicBool) -> Result<Index> {
    let t0 = Instant::now();
    let list = walk::list_family_files(root, cancel);
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::cancelled());
    }
    let files: Vec<Arc<FileEntry>> = list
        .par_iter()
        .filter_map(|f| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            parse_file(&f.path, f.lang).map(Arc::new)
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::cancelled());
    }
    Ok(Index::new(root.to_path_buf(), files, t0.elapsed().as_millis() as u64))
}

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let m = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map_or(0, |d| d.as_millis() as u64);
    Some((m, meta.len()))
}

/// A new index that has the changes. Only changed files are parsed again.
/// `rescan` reads the folder again: new files are added, deleted files go.
pub fn update_index(old: &Index, changed: &[PathBuf], rescan: bool, cancel: &AtomicBool) -> Result<Index> {
    let root = &old.root;
    let mut map: HashMap<PathBuf, Arc<FileEntry>> = old.files.iter().map(|f| (f.path.clone(), f.clone())).collect();
    if rescan {
        let list = walk::list_family_files(root, cancel);
        let keep: std::collections::HashSet<&PathBuf> = list.iter().map(|f| &f.path).collect();
        map.retain(|p, _| keep.contains(p));
        let fresh: Vec<Arc<FileEntry>> = list
            .par_iter()
            .filter_map(|f| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                if let (Some(e), Some((m, s))) = (map.get(&f.path), stamp(&f.path)) {
                    if e.mtime_ms == m && e.size == s {
                        return None;
                    }
                }
                parse_file(&f.path, f.lang).map(Arc::new)
            })
            .collect();
        for e in fresh {
            map.insert(e.path.clone(), e);
        }
    } else {
        let mut ignorer = Ignorer::new(root);
        for p in changed {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::cancelled());
            }
            if !p.starts_with(root) {
                continue;
            }
            match walk::lang_of(p) {
                Some(lang) => match stamp(p) {
                    Some((m, s)) => {
                        if let Some(e) = map.get(p) {
                            if e.mtime_ms == m && e.size == s {
                                continue;
                            }
                        } else if ignorer.is_ignored(p) {
                            continue;
                        }
                        match parse_file(p, lang) {
                            Some(e) => {
                                map.insert(p.clone(), Arc::new(e));
                            }
                            None => {
                                map.remove(p);
                            }
                        }
                    }
                    None => {
                        map.remove(p);
                    }
                },
                None => {
                    // A folder: it can be new, moved or deleted.
                    if p.is_dir() {
                        if ignorer.is_ignored(&p.join("x")) {
                            continue;
                        }
                        for f in walk::list_family_files(p, cancel) {
                            if !map.contains_key(&f.path) {
                                if let Some(e) = parse_file(&f.path, f.lang) {
                                    map.insert(f.path.clone(), Arc::new(e));
                                }
                            }
                        }
                    } else {
                        map.retain(|k, _| !k.starts_with(p));
                    }
                }
            }
        }
    }
    let files: Vec<Arc<FileEntry>> = map.into_values().collect();
    Ok(Index::new(root.clone(), files, old.build_ms))
}

/// The innermost type (index in `FileModel::types`) whose lines hold `line`.
pub fn innermost_type(model: &CModel, line: u32) -> Option<u32> {
    let mut best: Option<(u32, u32)> = None;
    for (i, t) in model.types.iter().enumerate() {
        if t.start_line <= line && line <= t.end_line {
            if best.is_none_or(|(s, _)| t.start_line >= s) {
                best = Some((t.start_line, i as u32));
            }
        }
    }
    best.map(|(_, i)| i)
}

impl Index {
    pub fn view(&self) -> crate::derived::View<'_> {
        crate::derived::View { files: &self.files, d: self.derived() }
    }
}
