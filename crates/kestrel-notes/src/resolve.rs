//! Resolving the target of a link to a file of the index (DESIGN.md 14.2).
//!
//! The order for a link of note `N`:
//! 1. Markdown links: the path relative to the folder of `N` (a leading `/`
//!    means the root).
//! 2. Wiki links: the path relative to the folder of `N`, then from the root.
//!    Each is tried exact, then case-insensitive, with `.md` added when the
//!    target has no markdown extension.
//! 3. By name: a file whose path is the target or ends with `/target`, then
//!    a note with the target as front matter alias. With several candidates
//!    the one in the folder of `N` wins, then the longest common folder
//!    prefix, then the shortest path, then the first by path.
//! 4. Nothing found: a missing node.

use crate::index::{abs_path, Index};
use crate::walk::is_md_ext;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

/// A file of the index: a position in `Index::notes` or `Index::files`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub enum Item {
    Note(u32),
    File(u32),
}

/// The result of resolving one link.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Found(Item),
    /// The target does not exist. `key` merges missing nodes: the lower-case
    /// path, or `\0bare:` and the lower-case name for a bare wiki link.
    /// `rel` is the path where the note would be created.
    Missing { key: String, rel: String },
    /// Outside the root, a folder, or empty.
    Ignore,
}

/// Lookup tables over the names of the files. Built once per set of paths and
/// aliases, and shared by the answers of one index.
pub struct Resolver {
    /// Normalized lower-case file name to the files with this name.
    by_name: HashMap<String, Vec<Item>>,
    /// Normalized lower-case alias to the notes with this alias.
    aliases: HashMap<String, Vec<u32>>,
}

/// Comparison key of a name: Unicode NFC (macOS can store names decomposed)
/// and lower case.
pub fn key(s: &str) -> String {
    if s.is_ascii() { s.to_ascii_lowercase() } else { s.nfc().collect::<String>().to_lowercase() }
}

pub fn last_comp(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

/// The extension of the last part of the path, when it has one.
fn ext_of(s: &str) -> Option<&str> {
    let name = last_comp(s);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => Some(ext),
        _ => None,
    }
}

pub fn has_ext(s: &str) -> bool {
    ext_of(s).is_some()
}

pub fn md_ext(s: &str) -> bool {
    ext_of(s).is_some_and(is_md_ext)
}

const ATTACHMENT_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "ico", "pdf", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "mov", "webm",
    "mkv", "zip", "csv", "txt", "json", "yaml", "yml", "xlsx", "docx", "pptx", "canvas", "base", "excalidraw",
];

/// Adds `.md` to the name of a new note, except when it is a markdown file
/// or looks like an attachment.
fn with_note_ext(s: &str) -> String {
    match ext_of(s) {
        Some(e) if is_md_ext(e) || ATTACHMENT_EXTS.iter().any(|a| a.eq_ignore_ascii_case(e)) => s.to_owned(),
        _ => format!("{s}.md"),
    }
}

/// The name of a node: the file name without the markdown extension.
pub fn name_of(rel: &str) -> &str {
    let n = last_comp(rel);
    match n.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && is_md_ext(ext) => stem,
        _ => n,
    }
}

/// The folder part of a relative path (`""` for the root).
pub fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(d, _)| d)
}

fn has_dotdot(t: &str) -> bool {
    t.split('/').any(|c| c == "..")
}

/// Joins `t` to the folder `base` and removes `.` and `..`. `None` when the
/// result leaves the root.
pub fn join_norm(base: &str, t: &str) -> Option<String> {
    let mut parts: Vec<&str> = base.split('/').filter(|c| !c.is_empty()).collect();
    for c in t.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            c => parts.push(c),
        }
    }
    Some(parts.join("/"))
}

impl Index {
    pub(crate) fn rel_of(&self, it: Item) -> &str {
        match it {
            Item::Note(i) => &self.notes[i as usize].rel,
            Item::File(i) => &self.files[i as usize],
        }
    }
}

/// The names to look for: the target itself when it has an extension (a
/// file, or a note when the extension is markdown), and the target with
/// `.md`, `.markdown` or `.mdx` added.
fn variants(p: &str) -> Vec<String> {
    if md_ext(p) {
        vec![p.to_owned()]
    } else if has_ext(p) {
        vec![p.to_owned(), format!("{p}.md"), format!("{p}.markdown"), format!("{p}.mdx")]
    } else {
        vec![format!("{p}.md"), format!("{p}.markdown"), format!("{p}.mdx")]
    }
}

impl Resolver {
    /// Builds the tables for an index.
    pub fn build(idx: &Index) -> Resolver {
        let mut by_name: HashMap<String, Vec<Item>> = HashMap::with_capacity(idx.notes.len() + idx.files.len() / 4);
        let mut aliases: HashMap<String, Vec<u32>> = HashMap::new();
        for (i, n) in idx.notes.iter().enumerate() {
            by_name.entry(key(last_comp(&n.rel))).or_default().push(Item::Note(i as u32));
            for a in &n.aliases {
                aliases.entry(key(a)).or_default().push(i as u32);
            }
        }
        for (i, f) in idx.files.iter().enumerate() {
            by_name.entry(key(last_comp(f))).or_default().push(Item::File(i as u32));
        }
        Resolver { by_name, aliases }
    }

    /// A path from the root: exact, then case-insensitive.
    fn find_path(&self, idx: &Index, p: &str) -> Option<Item> {
        let names = variants(p);
        for name in &names {
            if md_ext(name) {
                if let Ok(i) = idx.notes.binary_search_by(|n| n.rel.as_str().cmp(name)) {
                    return Some(Item::Note(i as u32));
                }
            } else if let Ok(i) = idx.files.binary_search_by(|f| (**f).cmp(name.as_str())) {
                return Some(Item::File(i as u32));
            }
        }
        for name in &names {
            let want = key(name);
            let Some(list) = self.by_name.get(&key(last_comp(name))) else { continue };
            if let Some(it) = list.iter().find(|it| key(idx.rel_of(**it)) == want) {
                return Some(*it);
            }
        }
        None
    }

    /// By name (rule 3), with the tie rules.
    fn find_by_name(&self, idx: &Index, from_dir: &str, t: &str) -> Option<Item> {
        for name in variants(t) {
            let want = key(&name);
            let suffix = format!("/{want}");
            let Some(list) = self.by_name.get(&key(last_comp(&name))) else { continue };
            let cands: Vec<Item> = list
                .iter()
                .copied()
                .filter(|it| {
                    let k = key(idx.rel_of(*it));
                    k == want || k.ends_with(&suffix)
                })
                .collect();
            if let Some(best) = best_of(idx, from_dir, &cands) {
                return Some(best);
            }
        }
        let a = key(t.trim());
        let a2 = key(t.trim().trim_end_matches(".md"));
        let list = self.aliases.get(&a).or_else(|| self.aliases.get(&a2))?;
        let cands: Vec<Item> = list.iter().map(|i| Item::Note(*i)).collect();
        best_of(idx, from_dir, &cands)
    }

    /// Resolves the target `target` of a link in a note of the folder
    /// `from_dir` (relative to the root, `""` for the root itself).
    pub fn resolve(&self, idx: &Index, from_dir: &str, target: &str, wiki: bool) -> Outcome {
        let t = target.trim();
        let rooted = t.starts_with('/');
        let t = t.trim_start_matches('/');
        if t.is_empty() || t == "." || t == ".." {
            return Outcome::Ignore;
        }
        let bases: &[&str] = if rooted {
            &[""]
        } else if wiki && !from_dir.is_empty() {
            &[from_dir, ""]
        } else if wiki {
            &[""]
        } else {
            &[from_dir]
        };
        let mut inside = false;
        for base in bases {
            match join_norm(base, t) {
                Some(p) if !p.is_empty() => {
                    inside = true;
                    if let Some(it) = self.find_path(idx, &p) {
                        return Outcome::Found(it);
                    }
                }
                _ => {}
            }
        }
        if !inside {
            return Outcome::Ignore;
        }
        if !has_dotdot(t) {
            if let Some(it) = self.find_by_name(idx, from_dir, t) {
                return Outcome::Found(it);
            }
        }
        if t.ends_with('/') {
            return Outcome::Ignore;
        }
        let is_dir = |rel: &str| abs_path(&idx.root, rel).is_dir();
        if wiki && !t.contains('/') {
            let Some(rel) = join_norm(from_dir, &with_note_ext(t)) else { return Outcome::Ignore };
            let dir_here = join_norm(from_dir, t).unwrap_or_default();
            if is_dir(&dir_here) || is_dir(t) {
                return Outcome::Ignore;
            }
            return Outcome::Missing { key: format!("\0bare:{}", key(&with_note_ext(t))), rel };
        }
        let base = if wiki || rooted { "" } else { from_dir };
        let Some(p) = join_norm(base, t) else { return Outcome::Ignore };
        if p.is_empty() || is_dir(&p) {
            return Outcome::Ignore;
        }
        let rel = if wiki {
            with_note_ext(&p)
        } else if has_ext(&p) {
            p
        } else {
            format!("{p}.md")
        };
        Outcome::Missing { key: key(&rel), rel }
    }
}

/// The best of several candidates for a link in the folder `from_dir`.
fn best_of(idx: &Index, from_dir: &str, cands: &[Item]) -> Option<Item> {
    let from: Vec<&str> = from_dir.split('/').filter(|c| !c.is_empty()).collect();
    cands.iter().copied().min_by_key(|it| {
        let rel = idx.rel_of(*it);
        let dir = dir_of(rel);
        let comps: Vec<&str> = dir.split('/').filter(|c| !c.is_empty()).collect();
        let common = comps.iter().zip(from.iter()).take_while(|(a, b)| a == b).count();
        let same = comps.len() == from.len() && common == from.len();
        (!same, std::cmp::Reverse(common), rel.len(), *it)
    })
}
