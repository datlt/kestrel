//! Making the graph: resolves the raw links of all notes and builds the
//! nodes and the links of `src/ipc/notes.ts`.

use crate::index::{abs_path, Index};
use crate::resolve::{dir_of, name_of, Item, Outcome};
use crate::scan::LinkKind;
use crate::types::{GraphData, NoteLink, NoteNode, NoteNodeKind};
use kestrel_common::{Error, Result};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

/// What a link points to, with a missing target still by its key.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Target {
    Item(Item),
    Missing(String),
}

/// All links of one note to one target.
struct Agg {
    target: Target,
    /// The path where a missing target would be created.
    rel: String,
    count: u32,
    embeds: u32,
    line: u32,
}

/// Resolves the links of one note and joins those with the same target.
fn note_links(idx: &Index, i: usize) -> Vec<Agg> {
    let note = &idx.notes[i];
    let resolver = idx.resolver();
    let from_dir = dir_of(&note.rel);
    let mut out: Vec<Agg> = Vec::new();
    let mut at: HashMap<Target, usize> = HashMap::new();
    // Links to the same text resolve the same way.
    let mut memo: HashMap<(&str, bool), Outcome> = HashMap::new();
    for l in &note.links {
        let wiki = l.kind == LinkKind::Wiki;
        let o = memo.entry((l.target.as_str(), wiki)).or_insert_with(|| resolver.resolve(idx, from_dir, &l.target, wiki));
        let (target, rel) = match o {
            Outcome::Found(Item::Note(n)) if *n as usize == i => continue,
            Outcome::Found(it) => (Target::Item(*it), String::new()),
            Outcome::Missing { key, rel } => (Target::Missing(key.clone()), rel.clone()),
            Outcome::Ignore => continue,
        };
        match at.get(&target) {
            Some(&k) => {
                let a = &mut out[k];
                a.count += 1;
                a.embeds += l.embed as u32;
                a.line = a.line.min(l.line);
            }
            None => {
                at.insert(target.clone(), out.len());
                out.push(Agg { target, rel, count: 1, embeds: l.embed as u32, line: l.line });
            }
        }
    }
    out
}

/// Where a link of the first pass points in the final node list.
enum To {
    Note(u32),
    File(u32),
    Missing(usize),
}

fn stat(root: &Path, rel: &str) -> (u64, u64) {
    match fs::metadata(abs_path(root, rel)) {
        Ok(md) => {
            let ms = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            (md.len(), ms)
        }
        Err(_) => (0, 0),
    }
}

/// Builds the whole graph of an index.
pub fn build_graph(idx: &Index, cancel: &AtomicBool) -> Result<GraphData> {
    // Make the tables once before the parallel work.
    idx.resolver();
    let per_note: Vec<Option<Vec<Agg>>> = (0..idx.notes.len())
        .into_par_iter()
        .map(|i| if cancel.load(Ordering::Relaxed) { None } else { Some(note_links(idx, i)) })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::cancelled());
    }

    // Join the missing targets of all notes. The first note by path decides the path.
    let mut missing_at: HashMap<String, usize> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();
    let mut used_file = vec![false; idx.files.len()];
    let mut raw: Vec<(u32, To, u32, u32, u32)> = Vec::new();
    for (from, aggs) in per_note.into_iter().enumerate() {
        for a in aggs.unwrap_or_default() {
            let to = match a.target {
                Target::Item(Item::Note(n)) => To::Note(n),
                Target::Item(Item::File(f)) => {
                    used_file[f as usize] = true;
                    To::File(f)
                }
                Target::Missing(key) => {
                    let k = *missing_at.entry(key).or_insert_with(|| {
                        missing.push(a.rel.clone());
                        missing.len() - 1
                    });
                    To::Missing(k)
                }
            };
            raw.push((from as u32, to, a.count, a.embeds, a.line));
        }
    }

    let n_notes = idx.notes.len();
    let mut nodes: Vec<NoteNode> = Vec::with_capacity(n_notes + 16);
    for n in &idx.notes {
        nodes.push(NoteNode {
            kind: NoteNodeKind::Note,
            path: abs_path(&idx.root, &n.rel).to_string_lossy().into_owned(),
            rel: n.rel.clone(),
            name: name_of(&n.rel).to_owned(),
            title: n.title.clone(),
            tags: n.tags.clone(),
            aliases: n.aliases.clone(),
            size: n.size,
            mtime_ms: n.mtime_ms,
        });
    }

    // Attachments in path order.
    let used: Vec<usize> = (0..idx.files.len()).filter(|f| used_file[*f]).collect();
    let stats: Vec<(u64, u64)> = used.par_iter().map(|f| stat(&idx.root, &idx.files[*f])).collect();
    let mut file_node = vec![0u32; idx.files.len()];
    for (k, f) in used.iter().enumerate() {
        file_node[*f] = (n_notes + k) as u32;
        let rel = &idx.files[*f];
        nodes.push(NoteNode {
            kind: NoteNodeKind::Attachment,
            path: abs_path(&idx.root, rel).to_string_lossy().into_owned(),
            rel: rel.to_string(),
            name: name_of(rel).to_owned(),
            title: None,
            tags: vec![],
            aliases: vec![],
            size: stats[k].0,
            mtime_ms: stats[k].1,
        });
    }

    // Missing nodes in path order.
    let mut order: Vec<usize> = (0..missing.len()).collect();
    order.sort_by(|a, b| missing[*a].cmp(&missing[*b]));
    let mut missing_node = vec![0u32; missing.len()];
    let base = nodes.len();
    for (k, m) in order.iter().enumerate() {
        missing_node[*m] = (base + k) as u32;
        let rel = &missing[*m];
        nodes.push(NoteNode {
            kind: NoteNodeKind::Missing,
            path: abs_path(&idx.root, rel).to_string_lossy().into_owned(),
            rel: rel.clone(),
            name: name_of(rel).to_owned(),
            title: None,
            tags: vec![],
            aliases: vec![],
            size: 0,
            mtime_ms: 0,
        });
    }

    let mut links: Vec<NoteLink> = raw
        .into_iter()
        .map(|(from, to, count, embeds, line)| {
            let to = match to {
                To::Note(n) => n,
                To::File(f) => file_node[f as usize],
                To::Missing(m) => missing_node[m],
            };
            NoteLink { from, to, count, embeds, line }
        })
        .collect();
    links.sort_unstable_by_key(|l| (l.from, l.to));
    Ok(GraphData { root: idx.root.to_string_lossy().into_owned(), nodes, links, truncated: idx.truncated })
}
