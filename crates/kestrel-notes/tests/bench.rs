//! Speed check. Run it in release mode on a big vault:
//!
//!   KESTREL_NOTES_BENCH_ROOT=/path/to/vault cargo test -p kestrel-notes --release --test bench -- --ignored --nocapture
//!
//! It only prints numbers and counts. The vault is read, never written,
//! except for the update test, which touches one note of a copy (see below).

use kestrel_notes::{build_index, update_index, NoteManager, NoteNodeKind};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[test]
#[ignore]
fn bench_vault() {
    let Ok(root) = std::env::var("KESTREL_NOTES_BENCH_ROOT") else { return };
    let root = kestrel_common::paths::normalize(&PathBuf::from(root));
    let cancel = AtomicBool::new(false);

    let t = Instant::now();
    let idx = build_index(&root, None, &cancel).unwrap();
    println!("build: {} ms ({} notes, {} other files)", t.elapsed().as_millis(), idx.note_count(), idx.file_count());

    let m = NoteManager::new();
    let r = root.to_str().unwrap();
    let t = Instant::now();
    let g = m.graph("bench", r, &cancel).unwrap();
    println!("first graph (build + resolve): {} ms", t.elapsed().as_millis());
    let count = |k: NoteNodeKind| g.data.nodes.iter().filter(|n| n.kind == k).count();
    println!(
        "nodes: {} notes, {} attachments, {} missing; links: {}; truncated: {}",
        count(NoteNodeKind::Note),
        count(NoteNodeKind::Attachment),
        count(NoteNodeKind::Missing),
        g.data.links.len(),
        g.data.truncated
    );

    // Counts of missing and attachment nodes by extension, to judge the result.
    for kind in [NoteNodeKind::Missing, NoteNodeKind::Attachment] {
        let mut by_ext: std::collections::BTreeMap<String, usize> = Default::default();
        for n in g.data.nodes.iter().filter(|n| n.kind == kind) {
            let ext = n.rel.rsplit_once('.').map(|(_, e)| e.to_lowercase()).filter(|e| e.len() <= 6 && !e.contains('/')).unwrap_or_default();
            *by_ext.entry(ext).or_default() += 1;
        }
        let mut v: Vec<_> = by_ext.into_iter().collect();
        v.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        v.truncate(8);
        println!("{kind:?} by extension: {v:?}");
    }

    // A second index only to time the resolving of all links without the build.
    let t = Instant::now();
    let idx2 = build_index(&root, Some(&idx), &cancel).unwrap();
    println!("rescan with unchanged files: {} ms", t.elapsed().as_millis());
    let t = Instant::now();
    let g2 = idx2.graph_for_bench(&cancel).unwrap();
    println!("resolve and make graph (tables included): {} ms", t.elapsed().as_millis());
    let t = Instant::now();
    let _ = idx2.graph_for_bench(&cancel).unwrap();
    println!("cached graph: {} ms", t.elapsed().as_millis());
    assert_eq!(g2.links.len(), g.data.links.len());

    let t = Instant::now();
    let json = serde_json::to_vec(&g).unwrap();
    println!("graph JSON: {} bytes, serialized in {} ms", json.len(), t.elapsed().as_millis());

    // Update of one changed note (the first one): same file again.
    if let Some(n) = g.data.nodes.iter().find(|n| n.kind == NoteNodeKind::Note) {
        let p = PathBuf::from(&n.path);
        let mut total = 0u128;
        for _ in 0..10 {
            let t = Instant::now();
            let _ = update_index(&idx2, &[p.clone()], false, &cancel).unwrap();
            total += t.elapsed().as_micros();
        }
        println!("update of one note: {} us on average", total / 10);
        let new = update_index(&idx2, &[p], false, &cancel).unwrap();
        let t = Instant::now();
        let _ = new.graph_for_bench(&cancel).unwrap();
        println!("graph after the update (resolver tables reused): {} ms", t.elapsed().as_millis());
    }
}
