//! Corpus test: parses every Kotlin and Java file under `KESTREL_LANG_CORPUS`.
//! It skips itself when the variable is not set. Run it in release mode:
//! `KESTREL_LANG_CORPUS=/path cargo test --release -p kestrel-lang --test jvm_corpus -- --nocapture`
//! The name for `find_identifiers` comes from `KESTREL_LANG_CORPUS_NAME` (default `String`).

use kestrel_lang::{find_identifiers, parse, regions, Lang};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if matches!(name.as_ref(), "build" | ".gradle" | ".git" | "node_modules") {
                continue;
            }
            walk(&path, out);
        } else if ft.is_file() {
            if let Some(ext) = path.extension().and_then(|x| x.to_str()) {
                if Lang::from_extension(ext).is_some_and(|l| l.is_jvm()) {
                    out.push(path);
                }
            }
        }
    }
}

#[test]
fn corpus() {
    let Ok(root) = std::env::var("KESTREL_LANG_CORPUS") else {
        eprintln!("KESTREL_LANG_CORPUS is not set, skipping");
        return;
    };
    let name = std::env::var("KESTREL_LANG_CORPUS_NAME").unwrap_or_else(|_| "String".to_string());
    let mut paths = Vec::new();
    walk(Path::new(&root), &mut paths);
    paths.sort();

    // Read first, so the timing does not include disk reads.
    let mut files: Vec<(PathBuf, Lang, String)> = Vec::new();
    let mut bytes = 0usize;
    for p in paths {
        let Some(lang) = p.extension().and_then(|x| x.to_str()).and_then(Lang::from_extension) else { continue };
        let Ok(raw) = std::fs::read(&p) else { continue };
        let text = String::from_utf8_lossy(&raw).into_owned();
        bytes += text.len();
        files.push((p, lang, text));
    }

    let mut types = 0usize;
    let mut members = 0usize;
    let mut bad_lines = 0usize;
    let mut slow: Vec<(f64, usize, PathBuf)> = Vec::new();
    let t0 = Instant::now();
    for (p, lang, text) in &files {
        let t = Instant::now();
        let m = parse(*lang, text);
        let dt = t.elapsed().as_secs_f64();
        for t in &m.types {
            for f in t.fields.iter().chain(t.methods.iter()) {
                if f.end_line < f.line || f.line < t.start_line || f.end_line > t.end_line {
                    bad_lines += 1;
                    if bad_lines <= 5 {
                        println!("  bad end_line {} {}..{} in type {} {}..{}: {}", f.name, f.line, f.end_line, t.name, t.start_line, t.end_line, p.display());
                    }
                }
            }
        }
        types += m.types.len();
        members += m.top_level.len() + m.types.iter().map(|t| t.fields.len() + t.methods.len()).sum::<usize>();
        slow.push((dt, text.len(), p.clone()));
    }
    let secs = t0.elapsed().as_secs_f64();

    let mut hits = 0usize;
    let t1 = Instant::now();
    for (_, lang, text) in &files {
        hits += find_identifiers(*lang, text, &name).len();
    }
    let secs_find = t1.elapsed().as_secs_f64();

    // Regions: speed and checks.
    let mut region_count = 0usize;
    let t2 = Instant::now();
    let all: Vec<_> = files.iter().map(|(_, lang, text)| regions(*lang, text)).collect();
    let secs_regions = t2.elapsed().as_secs_f64();
    let mut bad_regions = 0usize;
    for ((p, lang, text), rs) in files.iter().zip(&all) {
        region_count += rs.len();
        let mut last = 0usize;
        for r in rs {
            if r.start < last || r.end <= r.start || r.end > text.len() || !text.is_char_boundary(r.start) || !text.is_char_boundary(r.end) {
                bad_regions += 1;
            }
            last = r.end;
        }
        // No hit of a common name may lie inside a region.
        for h in find_identifiers(*lang, text, &name) {
            let k = rs.partition_point(|r| r.end <= h.start);
            if rs.get(k).is_some_and(|r| r.start < h.end) {
                bad_regions += 1;
                if bad_regions <= 5 {
                    println!("  hit inside region: {}", p.display());
                }
            }
        }
    }

    let mb = bytes as f64 / 1_000_000.0;
    println!("files: {}", files.len());
    println!("size: {mb:.1} MB");
    println!("parse: {secs:.3} s, {:.0} MB/s", mb / secs.max(1e-9));
    println!("find_identifiers({name}): {secs_find:.3} s, {:.0} MB/s, {hits} hits", mb / secs_find.max(1e-9));
    println!("regions: {secs_regions:.3} s, {:.0} MB/s, {region_count} regions, {bad_regions} problems", mb / secs_regions.max(1e-9));
    assert_eq!(bad_regions, 0);
    println!("types: {types}");
    println!("members with a bad end_line: {bad_lines}");
    assert_eq!(bad_lines, 0);
    println!("members: {members}");
    slow.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    println!("slowest files:");
    for (dt, len, p) in slow.iter().take(5) {
        println!("  {:.2} ms  {} KB  {}", dt * 1000.0, len / 1000, p.display());
    }
}
