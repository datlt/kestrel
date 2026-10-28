//! Runs the Swift parser over a folder of real code. Set `KESTREL_LANG_CORPUS`
//! to the folder. Without it the test does nothing.
//! Run in release mode and with `--nocapture` to see the numbers.

use kestrel_lang::*;
use std::path::{Path, PathBuf};
use std::time::Instant;

const SKIP: [&str; 4] = ["Pods", "Carthage", ".build", "DerivedData"];

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !SKIP.contains(&name.as_ref()) {
                walk(&path, out);
            }
        } else if path.extension().is_some_and(|x| x == "swift") {
            out.push(path);
        }
    }
}

#[test]
fn corpus() {
    let Ok(root) = std::env::var("KESTREL_LANG_CORPUS") else {
        eprintln!("KESTREL_LANG_CORPUS is not set: skipped");
        return;
    };
    let mut files = Vec::new();
    walk(Path::new(&root), &mut files);
    files.sort();
    let texts: Vec<(PathBuf, String)> = files
        .into_iter()
        .filter_map(|f| std::fs::read_to_string(&f).ok().map(|t| (f, t)))
        .collect();
    let bytes: usize = texts.iter().map(|t| t.1.len()).sum();
    let mut types = 0usize;
    let mut members = 0usize;
    let mut hits = 0usize;
    let mut times: Vec<(f64, usize, &Path)> = Vec::new();
    let start = Instant::now();
    for (path, text) in &texts {
        let t0 = Instant::now();
        let m = parse(Lang::Swift, text);
        types += m.types.len();
        members += m.top_level.len();
        for t in &m.types {
            members += t.fields.len() + t.methods.len();
        }
        hits += find_identifiers(Lang::Swift, text, "self").len();
        times.push((t0.elapsed().as_secs_f64(), text.len(), path));
    }
    let secs = start.elapsed().as_secs_f64();
    let mb = bytes as f64 / 1_000_000.0;
    println!("files: {}", texts.len());
    println!("MB: {mb:.2}");
    println!("seconds: {secs:.3} (parse and find_identifiers)");
    println!("MB/s: {:.1}", mb / secs);
    println!("types: {types}");
    println!("members: {members}");
    println!("hits for `self`: {hits}");
    times.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!("5 slowest files:");
    for (s, len, p) in times.iter().take(5) {
        println!("  {:.4}s {:>8} bytes {}", s, len, p.display());
    }
    // Broken input: cut every file at a few places and drop some bytes.
    let start = Instant::now();
    let mut runs = 0;
    for (k, (_, text)) in texts.iter().enumerate() {
        let len = text.len();
        for cut in [len / 7, len / 3, len / 2 + k % 97, len - len / 11] {
            let mut c = cut.min(len);
            while !text.is_char_boundary(c) {
                c -= 1;
            }
            let part = &text[..c];
            let _ = parse(Lang::Swift, part);
            let _ = find_identifiers(Lang::Swift, part, "self");
            runs += 1;
        }
        // Remove all `}` or all `"` from the file.
        for ch in ['}', '"', '(', '/'] {
            let mutated: String = text.chars().filter(|&c| c != ch).collect();
            let _ = parse(Lang::Swift, &mutated);
            let _ = find_identifiers(Lang::Swift, &mutated, "self");
            runs += 1;
        }
    }
    println!("broken input runs: {runs} in {:.2}s, no panic", start.elapsed().as_secs_f64());
    // One file of 5 MB.
    let mut big = String::new();
    'outer: loop {
        for (_, text) in &texts {
            big.push_str(text);
            if big.len() > 5_000_000 {
                break 'outer;
            }
        }
        if texts.is_empty() {
            break;
        }
    }
    let start = Instant::now();
    let m = parse(Lang::Swift, &big);
    let a = start.elapsed().as_secs_f64();
    let start = Instant::now();
    let h = find_identifiers(Lang::Swift, &big, "self");
    let b = start.elapsed().as_secs_f64();
    println!("5 MB file: parse {a:.3}s ({} types), find_identifiers {b:.3}s ({} hits)", m.types.len(), h.len());
    // Every member has end_line >= line and stays inside its type.
    let mut checked = 0usize;
    let mut bad = 0usize;
    for (path, text) in &texts {
        let m = parse(Lang::Swift, text);
        for t in &m.types {
            for x in t.fields.iter().chain(&t.methods) {
                checked += 1;
                if x.end_line < x.line || x.end_line < t.start_line || x.end_line > t.end_line.max(t.line) {
                    bad += 1;
                    if bad <= 10 {
                        println!("bad end_line: {}.{} {}..{} in type {}..{} {}", t.name, x.name, x.line, x.end_line, t.start_line, t.end_line, path.display());
                    }
                }
            }
        }
        for x in &m.top_level {
            checked += 1;
            if x.end_line < x.line {
                bad += 1;
            }
        }
    }
    println!("members checked for end_line: {checked}, bad: {bad}");
    assert_eq!(bad, 0);
    // Regions: sorted, inside the text, on char boundaries, no hit inside.
    let mut nregions = 0usize;
    for (path, text) in &texts {
        let r = regions(Lang::Swift, text);
        let mut last = 0;
        for x in &r {
            assert!(x.start >= last && x.end > x.start && x.end <= text.len(), "{}", path.display());
            assert!(text.is_char_boundary(x.start) && text.is_char_boundary(x.end), "{}", path.display());
            last = x.end;
        }
        nregions += r.len();
        for name in ["self", "String", "Foo", "id"] {
            for h in find_identifiers(Lang::Swift, text, name) {
                let k = r.partition_point(|x| x.end <= h.start);
                assert!(k >= r.len() || r[k].start >= h.end, "hit {name} in region: {}", path.display());
            }
        }
    }
    println!("regions: {nregions}, all checks passed");
    let start = Instant::now();
    for (_, text) in &texts {
        let _ = regions(Lang::Swift, text);
    }
    let secs = start.elapsed().as_secs_f64();
    println!("regions only: {secs:.3}s, {:.1} MB/s", mb / secs);
    // Parse only, for the speed of `parse` alone.
    let start = Instant::now();
    for (_, text) in &texts {
        let _ = parse(Lang::Swift, text);
    }
    let secs = start.elapsed().as_secs_f64();
    println!("parse only: {secs:.3}s, {:.1} MB/s", mb / secs);
    let start = Instant::now();
    for (_, text) in &texts {
        let _ = find_identifiers(Lang::Swift, text, "self");
    }
    let secs = start.elapsed().as_secs_f64();
    println!("find_identifiers only: {secs:.3}s, {:.1} MB/s", mb / secs);
}

fn tr(t: &TypeRef) -> String {
    let mut s = format!("{}", t.text);
    if !t.name.is_empty() {
        s.push_str(&format!(" [{}", t.name));
        if !t.args.is_empty() {
            s.push_str(&format!("<{}>", t.args.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(",")));
        }
        if t.nullable {
            s.push('?');
        }
        s.push(']');
    }
    s
}

fn mem(m: &Member) -> String {
    let ps: Vec<String> = m
        .params
        .iter()
        .map(|p| format!("{}:{}", p.name, p.ty.as_ref().map(tr).unwrap_or_default()))
        .collect();
    format!(
        "    {:?} {}{} {:?}{}{} ({}) -> {} @{}:{}",
        m.kind,
        m.name,
        if m.is_static { " static" } else { "" },
        m.visibility,
        if m.is_abstract { " abstract" } else { "" },
        if m.mutable { " var" } else { "" },
        ps.join(", "),
        m.ty.as_ref().map(tr).unwrap_or_default(),
        m.line,
        m.column
    )
}

/// Prints the parse result of the files in `KESTREL_SWIFT_DUMP` (paths split by `:`).
#[test]
#[ignore]
fn dump() {
    let Ok(list) = std::env::var("KESTREL_SWIFT_DUMP") else { return };
    for path in list.split(':') {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let m = parse(Lang::Swift, &text);
        println!("===== {path}");
        println!("imports: {:?}", m.imports.iter().map(|i| &i.path).collect::<Vec<_>>());
        for (i, t) in m.types.iter().enumerate() {
            println!(
                "#{i} {:?} {} outer={:?} mods={:?} attrs={:?} tp={:?} sup={:?} alias={:?} lines {}-{} name@{}:{}",
                t.kind, t.name, t.outer, t.modifiers, t.annotations, t.type_params,
                t.supertypes.iter().map(|s| tr(&s.ty)).collect::<Vec<_>>(),
                t.aliased.as_ref().map(tr), t.start_line, t.end_line, t.line, t.column
            );
            for f in &t.fields { println!("{}", mem(f)); }
            for f in &t.methods { println!("{}", mem(f)); }
            println!("    used: {:?}", t.used_types);
        }
        for f in &m.top_level { println!("top {}", mem(f)); }
    }
}

/// Lists things that look wrong in the parse of the corpus.
#[test]
#[ignore]
fn suspicious() {
    let Ok(root) = std::env::var("KESTREL_LANG_CORPUS") else { return };
    let mut files = Vec::new();
    walk(Path::new(&root), &mut files);
    files.sort();
    let mut shown = 0;
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let m = parse(Lang::Swift, &text);
        // Count declaration lines by a simple text check.
        let mut expect = 0;
        for l in text.lines() {
            let l = l.trim_start();
            for kw in ["class ", "struct ", "enum ", "protocol ", "extension ", "actor "] {
                let mut rest = l;
                // Skip modifiers.
                loop {
                    let mut moved = false;
                    for md in ["public ", "private ", "fileprivate ", "internal ", "open ", "final ", "indirect ", "@MainActor "] {
                        if let Some(r) = rest.strip_prefix(md) {
                            rest = r;
                            moved = true;
                        }
                    }
                    if !moved {
                        break;
                    }
                }
                if let Some(r) = rest.strip_prefix(kw) {
                    if r.starts_with(|c: char| c.is_alphabetic()) && !r.contains("func ") {
                        expect += 1;
                    }
                }
            }
        }
        let got = m.types.iter().filter(|t| t.kind != TypeKind::TypeAlias).count();
        let mut bad = Vec::new();
        for t in &m.types {
            for x in t.fields.iter().chain(&t.methods) {
                if x.kind == MemberKind::Property && x.name.starts_with(|c: char| c.is_uppercase()) {
                    bad.push(format!("{}.{} @{}", t.name, x.name, x.line));
                }
                if x.name.is_empty() {
                    bad.push(format!("{}.<empty> @{}", t.name, x.line));
                }
            }
        }
        if got < expect || !bad.is_empty() {
            shown += 1;
            if shown <= 40 {
                println!("{}: expect~{expect} got {got} {:?}", f.display(), bad);
            }
        }
    }
    println!("files with problems: {shown}");
}

/// Prints the hits of `find_identifiers` for `KESTREL_SWIFT_IDENT=path:name`.
#[test]
#[ignore]
fn ident_dump() {
    let Ok(spec) = std::env::var("KESTREL_SWIFT_IDENT") else { return };
    let (path, name) = spec.rsplit_once(':').unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    for h in find_identifiers(Lang::Swift, &text, name) {
        let ls = text[..h.start].rfind('\n').map_or(0, |x| x + 1);
        let le = text[h.start..].find('\n').map_or(text.len(), |x| h.start + x);
        println!("{:<12} q={:<14} | {}", format!("{:?}", h.kind), h.qualifier, text[ls..le].trim());
    }
}
