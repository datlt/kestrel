//! Fuzzy file name search over a `Store`, with nucleo.

use crate::index::IndexState;
use crate::store::Store;
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;
use serde::Serialize;

/// Stores smaller than this are scored on one thread.
const PARALLEL_MIN: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
pub struct FileHit {
    /// Path relative to the root, with `/` separators.
    pub path: String,
    /// Positions of the matched characters in `path`, as UTF-16 code unit
    /// indexes (the indexes of a JavaScript string). Sorted, no duplicates.
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub items: Vec<FileHit>,
    pub state: IndexState,
    /// Number of files in the index (or found so far while it builds).
    pub count: usize,
}

fn name_start(path: &str) -> usize {
    path.rfind('/').map_or(0, |i| i + 1)
}

/// Score of one path. A match inside the file name gets a bonus, so
/// `main` ranks `src/main.rs` above `main_dir/other.rs`.
fn score_path(pattern: &Pattern, m: &mut Matcher, buf: &mut Vec<char>, path: &str) -> Option<u32> {
    let full = pattern.score(Utf32Str::new(path, buf), m)?;
    let ns = name_start(path);
    if ns > 0 {
        if let Some(n) = pattern.score(Utf32Str::new(&path[ns..], buf), m) {
            return Some(full + n + 60);
        }
    }
    Some(full)
}

/// Keeps the best `limit` items. It compacts when the list grows to 4x.
struct TopK {
    limit: usize,
    items: Vec<(u32, u32)>, // (score, index)
}

impl TopK {
    fn new(limit: usize) -> Self {
        TopK { limit, items: Vec::new() }
    }

    fn push(&mut self, score: u32, idx: u32) {
        self.items.push((score, idx));
        if self.items.len() >= self.limit * 4 + 64 {
            self.compact();
        }
    }

    fn compact(&mut self) {
        if self.items.len() > self.limit {
            // Higher score first. Same score: lower index first.
            self.items.select_nth_unstable_by(self.limit, |a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            self.items.truncate(self.limit);
        }
    }

    fn merge(mut self, other: TopK) -> TopK {
        self.items.extend(other.items);
        self.compact();
        self
    }
}

fn new_matcher() -> Matcher {
    Matcher::new(Config::DEFAULT.match_paths())
}

fn score_range(store: &Store, pattern: &Pattern, limit: usize, range: std::ops::Range<usize>) -> TopK {
    let mut m = new_matcher();
    let mut buf = Vec::new();
    let mut top = TopK::new(limit);
    for i in range {
        if let Some(s) = score_path(pattern, &mut m, &mut buf, store.get(i)) {
            top.push(s, i as u32);
        }
    }
    top
}

pub fn search(store: &Store, query: &str, limit: usize) -> Vec<FileHit> {
    let limit = limit.max(1);
    let pattern = Pattern::new(query, CaseMatching::Smart, Normalization::Smart, AtomKind::Fuzzy);
    let n = store.len();
    if pattern.atoms.is_empty() {
        return store.iter().take(limit).map(|p| FileHit { path: p.to_owned(), indices: Vec::new() }).collect();
    }

    let top = if n < PARALLEL_MIN {
        score_range(store, &pattern, limit, 0..n)
    } else {
        let chunks = (rayon::current_num_threads() * 4).max(1);
        let size = n.div_ceil(chunks);
        (0..chunks)
            .into_par_iter()
            .map(|c| score_range(store, &pattern, limit, (c * size).min(n)..((c + 1) * size).min(n)))
            .reduce(|| TopK::new(limit), TopK::merge)
    };

    let mut best = top.items;
    best.sort_unstable_by(|a, b| {
        b.0.cmp(&a.0)
            .then(store.get(a.1 as usize).len().cmp(&store.get(b.1 as usize).len()))
            .then(a.1.cmp(&b.1))
    });
    best.truncate(limit);

    let mut m = new_matcher();
    let mut buf = Vec::new();
    best.into_iter()
        .map(|(_, i)| {
            let path = store.get(i as usize);
            FileHit { path: path.to_owned(), indices: match_indices(&pattern, &mut m, &mut buf, path) }
        })
        .collect()
}

/// UTF-16 indexes of the matched characters. When the whole pattern matches
/// the file name, the indexes are inside the file name (same as the score).
fn match_indices(pattern: &Pattern, m: &mut Matcher, buf: &mut Vec<char>, path: &str) -> Vec<u32> {
    let ns = name_start(path);
    let mut chars: Vec<u32> = Vec::new();
    let mut base = 0usize; // byte offset of the part we matched
    let in_name = ns > 0 && pattern.indices(Utf32Str::new(&path[ns..], buf), m, &mut chars).is_some();
    if in_name {
        base = ns;
    } else {
        chars.clear();
        pattern.indices(Utf32Str::new(path, buf), m, &mut chars);
    }
    chars.sort_unstable();
    chars.dedup();
    // Char index in the part -> UTF-16 index in the full path.
    let prefix16: u32 = path[..base].encode_utf16().count() as u32;
    let mut out = Vec::with_capacity(chars.len());
    let mut want = chars.iter().peekable();
    let mut pos16 = prefix16;
    for (ci, ch) in path[base..].chars().enumerate() {
        match want.peek() {
            Some(&&w) if w as usize == ci => {
                out.push(pos16);
                want.next();
            }
            None => break,
            _ => {}
        }
        pos16 += ch.len_utf16() as u32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(paths: &[&str]) -> Store {
        let mut v: Vec<&str> = paths.to_vec();
        v.sort();
        Store::from_sorted(v.into_iter())
    }

    #[test]
    fn file_name_match_ranks_first() {
        let s = store(&["main_dir/other.rs", "src/main.rs", "docs/maintenance/notes.txt"]);
        let r = search(&s, "main", 10);
        assert_eq!(r[0].path, "src/main.rs");
        assert_eq!(r[0].indices, vec![4, 5, 6, 7]);
    }

    #[test]
    fn indices_for_scattered_match() {
        let s = store(&["src/search/index.ts"]);
        let r = search(&s, "ssi", 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].indices.len(), 3);
        for i in &r[0].indices {
            assert!("src/search/index.ts".is_char_boundary(*i as usize));
        }
    }

    #[test]
    fn smart_case() {
        let s = store(&["readme.md", "README.md", "Readme.txt"]);
        let lower = search(&s, "readme", 10);
        assert_eq!(lower.len(), 3);
        let upper = search(&s, "README", 10);
        assert_eq!(upper.len(), 1);
        assert_eq!(upper[0].path, "README.md");
    }

    #[test]
    fn non_matching_and_empty() {
        let s = store(&["a.txt", "b.txt"]);
        assert!(search(&s, "zzz", 10).is_empty());
        let all = search(&s, "", 1);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "a.txt");
        assert!(search(&Store::new(), "a", 10).is_empty());
    }

    #[test]
    fn utf16_indexes_with_astral_characters() {
        // The emoji is one char but two UTF-16 units.
        let s = store(&["😀/foo.txt"]);
        let r = search(&s, "foo", 10);
        assert_eq!(r[0].indices, vec![3, 4, 5]);
    }

    #[test]
    fn limit_and_order_are_stable() {
        let names: Vec<String> = (0..500).map(|i| format!("dir/file{i:04}.rs")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let s = store(&refs);
        let r = search(&s, "file", 20);
        assert_eq!(r.len(), 20);
        let again = search(&s, "file", 20);
        assert_eq!(r.iter().map(|h| &h.path).collect::<Vec<_>>(), again.iter().map(|h| &h.path).collect::<Vec<_>>());
    }

    #[test]
    fn parallel_path_matches_sequential() {
        let names: Vec<String> = (0..30_000).map(|i| format!("p{}/src/mod{}/file{}.rs", i % 97, i % 13, i)).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let s = store(&refs);
        let par = search(&s, "mod3 file1", 15);
        let pattern = Pattern::new("mod3 file1", CaseMatching::Smart, Normalization::Smart, AtomKind::Fuzzy);
        let seq = score_range(&s, &pattern, 15, 0..s.len());
        let mut seq_items = seq.items;
        seq_items.sort_unstable_by(|a, b| {
            b.0.cmp(&a.0)
                .then(s.get(a.1 as usize).len().cmp(&s.get(b.1 as usize).len()))
                .then(a.1.cmp(&b.1))
        });
        let seq_paths: Vec<&str> = seq_items.iter().take(15).map(|(_, i)| s.get(*i as usize)).collect();
        let par_paths: Vec<&str> = par.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(par_paths, seq_paths);
    }

    /// Run: cargo test -p kestrel-search --release -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_300k_paths() {
        use std::time::Instant;
        let dirs = ["src", "lib", "crates", "packages", "app", "core", "ui", "test", "docs", "tools"];
        let exts = ["rs", "ts", "kt", "java", "md", "json"];
        let mut names: Vec<String> = Vec::with_capacity(300_000);
        for i in 0..300_000usize {
            names.push(format!(
                "{}/{}/module{}/{}/component_{}_{}.{}",
                dirs[i % 10],
                dirs[(i / 10) % 10],
                (i / 100) % 50,
                dirs[(i / 7) % 10],
                i % 977,
                i,
                exts[i % 6]
            ));
        }
        names.sort();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let t = Instant::now();
        let s = Store::from_sorted(refs.into_iter());
        println!("store build: {:?}, {} paths, {} MB text", t.elapsed(), s.len(), s.bytes() / 1_000_000);
        for q in ["c", "comp", "cmp12", "module7 comp_5", "kt", "zzzz", "Component_9"] {
            // Warm up once, then time five runs and print the median.
            search(&s, q, 100);
            let mut times: Vec<_> = (0..5)
                .map(|_| {
                    let t = Instant::now();
                    let r = search(&s, q, 100);
                    std::hint::black_box(&r);
                    t.elapsed()
                })
                .collect();
            times.sort();
            println!("query {q:?}: median {:?}", times[2]);
        }
    }
}
