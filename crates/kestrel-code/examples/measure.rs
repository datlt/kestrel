//! Measurements on a real project (dev only):
//!   cargo run --release -p kestrel-code --example measure -- <root>
//! Prints the build time, the memory of the index and the time of a diagram
//! request and of usages requests.

use kestrel_code::internals::*;
use kestrel_code::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1024.0
}

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("root"));
    let cancel = AtomicBool::new(false);
    let r0 = rss_mb();
    let t = Instant::now();
    let index = Arc::new(build_index(&root, &cancel).unwrap());
    let build = t.elapsed();
    let r1 = rss_mb();
    let model_bytes: usize = index.files.iter().map(|f| f.model.bytes()).sum();
    let types: usize = index.type_count;
    let word_bytes: usize = index.files.iter().map(|f| f.words.len() * 4).sum();
    println!("word hashes: {:.1} MB ({} per file)", word_bytes as f64 / 1048576.0, word_bytes / 4 / index.files.len().max(1));
    println!("files {} types {} build {:?}", index.files.len(), types, build);
    println!("rss before {r0:.0} MB, after {r1:.0} MB (+{:.0}), models estimated {:.1} MB", r1 - r0, model_bytes as f64 / 1048576.0);
    let t = Instant::now();
    let v = index.view();
    let n = v.d.nodes.len();
    println!("derived tables: {n} nodes in {:?}", t.elapsed());
    let t = Instant::now();
    let rev = v.reverse(true);
    println!("full reverse table {:?}, rss {:.0} MB", t.elapsed(), rss_mb());
    // Biggest type and most used type.
    let big = (0..n as u32).max_by_key(|&i| { let d = v.decl(i); d.fields.len() + d.methods.len() + d.used_types.len() }).unwrap();
    let used = (0..n as u32).max_by_key(|&i| rev.incoming(i).len()).unwrap();
    println!("big type {} ({} members), most used {} ({} incoming)", v.node(big).qname, v.decl(big).methods.len() + v.decl(big).fields.len(), v.node(used).qname, rev.incoming(used).len());
    // Request with a fresh manager so the numbers include the index build.
    let m = CodeManager::new();
    let root_s = root.to_string_lossy().into_owned();
    let d = v.decl(big);
    let fe = v.file_of(big);
    for (dir, name) in [(Direction::Both, "both"), (Direction::Out, "out"), (Direction::In, "in")] {
        let req = DiagramRequest {
            root: root_s.clone(),
            scope: DiagramScope::Cursor { path: fe.path.to_string_lossy().into(), line: d.line, column: d.column, text: None },
            relations: vec![RelationKind::Extends, RelationKind::Implements, RelationKind::Composition, RelationKind::Aggregation, RelationKind::Dependency, RelationKind::Nested],
            depth: 2,
            direction: dir,
            include_external: true,
            max_nodes: 300,
        max_fan: None,
        };
        let t = Instant::now();
        let res = m.diagram("w", &req, &cancel).unwrap();
        println!("diagram depth 2 {name}: {:?} first (includes index build if first), nodes {}, edges {}, truncated {}", t.elapsed(), res.nodes.len(), res.edges.len(), res.truncated);
        let t = Instant::now();
        let res = m.diagram("w", &req, &cancel).unwrap();
        println!("diagram depth 2 {name}: {:?} again, json {} KB", t.elapsed(), serde_json::to_vec(&res).unwrap().len() / 1024);
    }
    if let Some(name) = std::env::args().nth(2) {
        let id = (0..n as u32).find(|&i| v.decl(i).name == name).expect("type not found");
        let d = v.decl(id);
        let req = DiagramRequest {
            root: root_s.clone(),
            scope: DiagramScope::Cursor { path: v.file_of(id).path.to_string_lossy().into(), line: d.line, column: d.column, text: None },
            relations: vec![RelationKind::Extends, RelationKind::Implements, RelationKind::Composition, RelationKind::Aggregation],
            depth: 2,
            direction: Direction::Both,
            include_external: false,
            max_nodes: 150,
        max_fan: None,
        };
        let res = m.diagram("w", &req, &cancel).unwrap();
        let hidden: Vec<_> = res.nodes.iter().filter(|n| n.hidden_in > 0 || n.hidden_out > 0).map(|n| (n.name.clone(), n.hidden_in, n.hidden_out)).collect();
        println!("{name}: nodes {} edges {} truncated {} hidden {:?}", res.nodes.len(), res.edges.len(), res.truncated, hidden);
    }
    let usage = |path: &std::path::Path, line: u32, col: u32, label: &str| {
        let req = UsagesRequest { root: root_s.clone(), path: path.to_string_lossy().into(), line, column: col, text: None, wide: false, max_results: 1000 };
        let t = Instant::now();
        let res = m.usages("w", &req, &cancel).unwrap();
        println!(
            "usages {label}: {:?}, symbol {:?}, files {} total {} truncated {} (likely files {})",
            t.elapsed(),
            res.symbol.as_ref().map(|s| (s.kind, s.owner.clone())),
            res.files.len(),
            res.total,
            res.truncated,
            res.files.iter().filter(|f| f.likely).count()
        );
    };
    let ud = v.decl(used);
    usage(&v.file_of(used).path, ud.line, ud.column, &format!("type {}", v.node(used).qname));
    usage(&v.file_of(used).path, ud.line, ud.column, "same type again");
    // The most common method name (not toString and so on).
    let mut count: HashMap<&str, usize> = HashMap::new();
    for f in &index.files {
        for t in &f.model.types {
            for mm in &t.methods {
                *count.entry(&mm.name).or_default() += 1;
            }
        }
    }
    let skip = ["toString", "equals", "hashCode", "init", "constructor", "copy"];
    let mut names: Vec<_> = count.into_iter().filter(|(n, _)| !skip.contains(n) && *n != "get" || true).collect();
    names.sort_by_key(|(n, c)| (std::cmp::Reverse(*c), n.to_string()));
    let common = names.iter().find(|(n, _)| !skip.contains(n)).map(|(n, c)| (n.to_string(), *c)).unwrap();
    'find: for f in &index.files {
        for t in &f.model.types {
            if let Some(mm) = t.methods.iter().find(|x| x.name == common.0) {
                usage(&f.path, mm.line, mm.column, &format!("method `{}` ({} declarations)", common.0, common.1));
                break 'find;
            }
        }
    }
    // Callers: the methods of the most used *Service type, then up two levels.
    let svc = (0..n as u32).filter(|&i| v.decl(i).name.ends_with("Service") && !v.decl(i).methods.is_empty()).max_by_key(|&i| rev.incoming(i).len());
    if let Some(svc) = svc {
        let d = v.decl(svc);
        let fe = v.file_of(svc);
        println!("callers: service {} ({} incoming)", v.node(svc).qname, rev.incoming(svc).len());
        let ask = |at: Option<CallAt>, target: Option<CallTarget>| {
            let req = CallersRequest { root: root_s.clone(), at, target, max_results: 1000 };
            let t = Instant::now();
            let res = m.callers("w", &req, &cancel).unwrap();
            (t.elapsed(), res)
        };
        let mut best: Option<(usize, CallersResult)> = None;
        let mut total = std::time::Duration::ZERO;
        for mm in d.methods.iter().filter(|x| x.kind == kestrel_lang::MemberKind::Method).take(12) {
            let (el, res) = ask(Some(CallAt { path: fe.path.to_string_lossy().into(), line: mm.line, column: mm.column, text: None }), None);
            total += el;
            let sites: usize = res.callers.iter().map(|c| c.sites.len()).sum();
            if best.as_ref().is_none_or(|b| sites > b.0) {
                best = Some((sites, res));
            }
        }
        println!("callers: 12 methods asked in {total:?}");
        if let Some((sites, res)) = best {
            println!("callers level 1 of {:?}: {} callers, {} sites, truncated {}, exact {}", res.target.as_ref().map(|t| t.name.clone()), res.callers.len(), sites, res.truncated, res.exact);
            let (el, again) = ask(None, res.target.clone());
            println!("callers level 1 again by target: {el:?} ({} callers)", again.callers.len());
            for c in res.callers.iter().take(5) {
                let (el, up) = ask(None, Some(c.caller.clone()));
                println!("  level 2 {}.{}: {el:?}, {} callers", c.caller.owner, c.caller.name, up.callers.len());
            }
        }
    }
    println!("rss at the end {:.0} MB", rss_mb());
}
