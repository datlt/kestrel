//! Text search over a folder (find in files), with the ripgrep crates.

use crate::walk::walker;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::WalkState;
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Lines longer than this are cut around the first match.
const MAX_LINE_CHARS: usize = 300;
/// Characters kept before the first match when a line is cut.
const CONTEXT_BEFORE: usize = 40;
/// Files bigger than this are skipped (bundles, dumps).
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Results go to the callback at least this often.
const BATCH_INTERVAL: Duration = Duration::from_millis(50);
const BATCH_MAX_LINES: usize = 400;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextOptions {
    pub query: String,
    /// The query is a regular expression. Otherwise it is plain text.
    pub regex: bool,
    pub match_case: bool,
    pub whole_word: bool,
    /// Glob patterns, for example `*.ts` or `src/features`. Empty: all files.
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    /// Stop after this many matching lines. 0 means no limit.
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based line number.
    pub line: u64,
    /// The line without leading white space and line break. Cut to about
    /// 300 characters around the first match when it is longer.
    pub text: String,
    /// Match ranges as `[start, end)` in UTF-16 code units of `text`.
    pub ranges: Vec<[u32; 2]>,
    /// UTF-16 units that were removed from the start of the real line
    /// (white space or a cut). Column in the file = `offset + ranges[i][0] + 1`.
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    /// Absolute path.
    pub path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSummary {
    pub total_matches: usize,
    pub files_with_matches: usize,
    pub truncated: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

fn glob_list(globs: &[String], negate: bool) -> Vec<String> {
    let mut out = Vec::new();
    for g in globs {
        let g = g.trim().trim_start_matches("./").trim_end_matches('/');
        if g.is_empty() {
            continue;
        }
        let bang = if negate { "!" } else { "" };
        out.push(format!("{bang}{g}"));
        // A folder name also matches everything inside it.
        if !g.ends_with("/**") {
            out.push(format!("{bang}{g}/**"));
        }
    }
    out
}

fn build_matcher(opts: &TextOptions) -> Result<RegexMatcher> {
    RegexMatcherBuilder::new()
        .case_insensitive(!opts.match_case)
        .word(opts.whole_word)
        .fixed_strings(!opts.regex)
        .build(&opts.query)
        .map_err(|e| Error::invalid(format!("invalid pattern: {e}")))
}

/// Collects results from all threads and sends them in batches.
struct Batcher<'a> {
    state: Mutex<(Vec<FileMatches>, usize, Instant)>,
    emit: &'a (dyn Fn(Vec<FileMatches>) + Sync),
}

impl Batcher<'_> {
    fn add(&self, file: FileMatches) {
        let ready = {
            let mut s = self.state.lock();
            s.1 += file.matches.len();
            s.0.push(file);
            if s.1 >= BATCH_MAX_LINES || s.2.elapsed() >= BATCH_INTERVAL {
                s.1 = 0;
                s.2 = Instant::now();
                Some(std::mem::take(&mut s.0))
            } else {
                None
            }
        };
        if let Some(batch) = ready {
            (self.emit)(batch);
        }
    }

    fn flush(&self) {
        let batch = {
            let mut s = self.state.lock();
            s.1 = 0;
            std::mem::take(&mut s.0)
        };
        if !batch.is_empty() {
            (self.emit)(batch);
        }
    }
}

/// Searches `root`. Blocks until done, cancelled or the limit is reached.
/// `emit` gets batches of results while the search runs (from any thread).
/// Set `cancel` to true to stop it.
pub fn search_text(
    root: &Path,
    opts: &TextOptions,
    cancel: &AtomicBool,
    emit: &(dyn Fn(Vec<FileMatches>) + Sync),
) -> Result<TextSummary> {
    let started = Instant::now();
    if opts.query.is_empty() {
        return Ok(TextSummary::default());
    }
    let matcher = build_matcher(opts)?;

    let mut walk = walker(root);
    walk.max_filesize(Some(MAX_FILE_BYTES));
    let mut ob = OverrideBuilder::new(root);
    for g in glob_list(&opts.include, false).into_iter().chain(glob_list(&opts.exclude, true)) {
        ob.add(&g).map_err(|e| Error::invalid(format!("invalid glob: {e}")))?;
    }
    walk.overrides(ob.build().map_err(|e| Error::invalid(format!("invalid glob: {e}")))?);

    let limit = if opts.max_results == 0 { usize::MAX } else { opts.max_results };
    let total = AtomicUsize::new(0);
    let files = AtomicUsize::new(0);
    let limit_hit = AtomicBool::new(false);
    let batcher = Batcher { state: Mutex::new((Vec::new(), 0, Instant::now())), emit };
    let stopped = || cancel.load(Ordering::Relaxed) || limit_hit.load(Ordering::Relaxed);

    walk.build_parallel().run(|| {
        let mut searcher: Searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .line_number(true)
            .build();
        let matcher = &matcher;
        let (total, files, limit_hit, batcher, stopped) = (&total, &files, &limit_hit, &batcher, &stopped);
        Box::new(move |res| {
            if stopped() {
                return WalkState::Quit;
            }
            let Ok(entry) = res else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let mut sink = LineSink {
                matcher,
                lines: Vec::new(),
                binary: false,
                total,
                limit,
                limit_hit,
                cancel,
            };
            // Read errors (permissions, files removed while we search) skip the file.
            let _ = searcher.search_path(matcher, entry.path(), &mut sink);
            if sink.binary {
                total.fetch_sub(sink.lines.len(), Ordering::Relaxed);
                sink.lines.clear();
            }
            if !sink.lines.is_empty() {
                files.fetch_add(1, Ordering::Relaxed);
                batcher.add(FileMatches {
                    path: entry.path().to_string_lossy().into_owned(),
                    matches: sink.lines,
                });
            }
            if stopped() { WalkState::Quit } else { WalkState::Continue }
        })
    });
    batcher.flush();

    Ok(TextSummary {
        total_matches: total.load(Ordering::Relaxed).min(limit),
        files_with_matches: files.load(Ordering::Relaxed),
        truncated: limit_hit.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

struct LineSink<'a> {
    matcher: &'a RegexMatcher,
    lines: Vec<LineMatch>,
    binary: bool,
    total: &'a AtomicUsize,
    limit: usize,
    limit_hit: &'a AtomicBool,
    cancel: &'a AtomicBool,
}

impl Sink for LineSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, m: &SinkMatch<'_>) -> std::result::Result<bool, Self::Error> {
        if self.cancel.load(Ordering::Relaxed) || self.limit_hit.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let line = String::from_utf8_lossy(m.bytes());
        if let Some(found) = make_line_match(self.matcher, m.line_number().unwrap_or(0), &line) {
            if self.total.fetch_add(1, Ordering::Relaxed) >= self.limit {
                self.limit_hit.store(true, Ordering::Relaxed);
                return Ok(false);
            }
            self.lines.push(found);
            if self.total.load(Ordering::Relaxed) >= self.limit {
                self.limit_hit.store(true, Ordering::Relaxed);
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn finish(&mut self, _: &Searcher, f: &SinkFinish) -> std::result::Result<(), Self::Error> {
        self.binary = f.binary_byte_offset().is_some();
        Ok(())
    }
}

/// Finds the ranges in one line and prepares the text for the frontend.
/// Returns `None` when the line has no non-empty match.
fn make_line_match(matcher: &RegexMatcher, line_no: u64, raw: &str) -> Option<LineMatch> {
    let text = raw.trim_end_matches(['\n', '\r']);
    let mut found: Vec<(usize, usize)> = Vec::new();
    let _ = matcher.find_iter(text.as_bytes(), |m| {
        if m.end() > m.start() {
            found.push((m.start(), m.end()));
        }
        true
    });
    let first = found.first()?.0;

    // Drop leading white space, but never past the first match.
    let lead = (text.len() - text.trim_start().len()).min(first);
    let mut begin = lead;
    let mut end = text.len();

    // Quick check on bytes first: a line with fewer bytes has fewer characters.
    if text.len() - lead > MAX_LINE_CHARS && text[lead..].chars().count() > MAX_LINE_CHARS {
        begin = text[lead..first]
            .char_indices()
            .rev()
            .nth(CONTEXT_BEFORE - 1)
            .map_or(lead, |(i, _)| lead + i);
        end = text[begin..]
            .char_indices()
            .nth(MAX_LINE_CHARS)
            .map_or(text.len(), |(i, _)| begin + i);
    }

    let offset = utf16_len(&text[..begin]);
    let shown = &text[begin..end];
    let mut ranges = Vec::with_capacity(found.len());
    let mut pos_byte = begin;
    let mut pos16 = 0u32;
    for (s, e) in found {
        let (s, e) = (s.max(begin), e.min(end));
        if s >= e || s < pos_byte {
            continue;
        }
        pos16 += utf16_len(&text[pos_byte..s]);
        let len16 = utf16_len(&text[s..e]);
        ranges.push([pos16, pos16 + len16]);
        pos16 += len16;
        pos_byte = e;
    }
    if ranges.is_empty() {
        return None;
    }
    Some(LineMatch { line: line_no, text: shown.to_owned(), ranges, offset })
}

fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() { s.len() as u32 } else { s.encode_utf16().count() as u32 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn opts(q: &str) -> TextOptions {
        TextOptions { query: q.into(), ..Default::default() }
    }

    fn run(root: &Path, o: &TextOptions) -> (Vec<FileMatches>, TextSummary) {
        let cancel = AtomicBool::new(false);
        run_with(root, o, &cancel)
    }

    fn run_with(root: &Path, o: &TextOptions, cancel: &AtomicBool) -> (Vec<FileMatches>, TextSummary) {
        let out = Mutex::new(Vec::new());
        let sum = search_text(root, o, cancel, &|b| out.lock().extend(b)).unwrap();
        let mut v = out.into_inner();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        (v, sum)
    }

    fn names(root: &Path, r: &[FileMatches]) -> Vec<String> {
        r.iter().map(|f| crate::walk::rel_slash(root, Path::new(&f.path)).unwrap()).collect()
    }

    #[test]
    fn literal_and_regex() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "hello world\nfoo.bar\nfooxbar\n");
        let (r, s) = run(d.path(), &opts("foo.bar"));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].matches.len(), 1); // literal: the dot is a dot
        assert_eq!(r[0].matches[0].line, 2);
        assert_eq!(s.total_matches, 1);

        let mut o = opts("foo.bar");
        o.regex = true;
        let (r, _) = run(d.path(), &o);
        assert_eq!(r[0].matches.len(), 2);
    }

    #[test]
    fn invalid_regex_is_an_error() {
        let d = tempfile::tempdir().unwrap();
        let mut o = opts("(");
        o.regex = true;
        let err = search_text(d.path(), &o, &AtomicBool::new(false), &|_| {}).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }

    #[test]
    fn match_case_and_whole_word() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "Foo foo FOO foobar\n");
        let (r, _) = run(d.path(), &opts("foo"));
        assert_eq!(r[0].matches[0].ranges.len(), 4);
        let mut o = opts("foo");
        o.match_case = true;
        assert_eq!(run(d.path(), &o).0[0].matches[0].ranges, vec![[4, 7], [12, 15]]);
        o.whole_word = true;
        assert_eq!(run(d.path(), &o).0[0].matches[0].ranges, vec![[4, 7]]);
    }

    #[test]
    fn utf16_offsets_for_non_ascii_and_emoji() {
        let d = tempfile::tempdir().unwrap();
        // "日本語" are 3 UTF-16 units (9 bytes). The emoji is 2 units (4 bytes).
        write(d.path(), "u.txt", "日本語 😀 foo 日本\n");
        let (r, _) = run(d.path(), &opts("foo"));
        let m = &r[0].matches[0];
        assert_eq!(m.text, "日本語 😀 foo 日本");
        assert_eq!(m.ranges, vec![[7, 10]]);
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[7..10]).unwrap(), "foo");

        // Searching for non-ASCII text.
        let (r, _) = run(d.path(), &opts("本"));
        assert_eq!(r[0].matches[0].ranges, vec![[1, 2], [12, 13]]);
    }

    #[test]
    fn leading_white_space_is_removed_into_offset() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "    \tlet x = 1;\r\nnext\r\n");
        let (r, _) = run(d.path(), &opts("let"));
        let m = &r[0].matches[0];
        assert_eq!(m.text, "let x = 1;");
        assert_eq!(m.offset, 5);
        assert_eq!(m.ranges, vec![[0, 3]]);
    }

    #[test]
    fn long_lines_are_cut_around_the_match() {
        let d = tempfile::tempdir().unwrap();
        let line = format!("{}NEEDLE{}", "日".repeat(1000), "x".repeat(1000));
        write(d.path(), "long.txt", &format!("{line}\n"));
        let (r, _) = run(d.path(), &opts("NEEDLE"));
        let m = &r[0].matches[0];
        assert_eq!(m.text.chars().count(), MAX_LINE_CHARS);
        assert_eq!(m.offset as usize, 1000 - CONTEXT_BEFORE);
        let [s, e] = m.ranges[0];
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[s as usize..e as usize]).unwrap(), "NEEDLE");
        assert_eq!((m.offset + s) as usize, 1000); // real column - 1
    }

    #[test]
    fn gitignore_hidden_and_git_folder() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "ignored/\n");
        write(r, "src/a.txt", "needle\n");
        write(r, ".hidden/b.txt", "needle\n");
        write(r, "ignored/c.txt", "needle\n");
        write(r, ".git/config", "needle\n");
        write(r, "名前/ファイル.txt", "needle\n");
        let (res, _) = run(r, &opts("needle"));
        assert_eq!(names(r, &res), vec![".hidden/b.txt", "src/a.txt", "名前/ファイル.txt"]);
    }

    #[test]
    fn include_and_exclude_globs() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "src/a.ts", "needle\n");
        write(r, "src/b.js", "needle\n");
        write(r, "src/deep/c.ts", "needle\n");
        write(r, "test/d.ts", "needle\n");
        write(r, "vendor/e.ts", "needle\n");

        let mut o = opts("needle");
        o.include = vec!["*.ts".into()];
        assert_eq!(names(r, &run(r, &o).0), vec!["src/a.ts", "src/deep/c.ts", "test/d.ts", "vendor/e.ts"]);

        o.exclude = vec!["vendor".into(), "test/".into()];
        assert_eq!(names(r, &run(r, &o).0), vec!["src/a.ts", "src/deep/c.ts"]);

        let mut o = opts("needle");
        o.include = vec!["src".into()];
        assert_eq!(names(r, &run(r, &o).0), vec!["src/a.ts", "src/b.js", "src/deep/c.ts"]);

        let mut o = opts("needle");
        o.include = vec!["src/*.js".into(), "test/**".into()];
        assert_eq!(names(r, &run(r, &o).0), vec!["src/b.js", "test/d.ts"]);

        let mut o = opts("needle");
        o.exclude = vec!["*.js".into(), "  ".into()];
        assert_eq!(run(r, &o).1.files_with_matches, 4);
    }

    #[test]
    fn binary_files_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "text.txt", "needle\n");
        fs::write(d.path().join("bin.dat"), b"needle\n\0\0\x01needle\n").unwrap();
        // The NUL comes late: matches before it must not show up either.
        let mut late = b"needle\n".repeat(20000);
        late.push(0);
        fs::write(d.path().join("late.dat"), late).unwrap();
        let (r, s) = run(d.path(), &opts("needle"));
        assert_eq!(names(d.path(), &r), vec!["text.txt"]);
        assert_eq!(s.total_matches, 1);
    }

    #[test]
    fn invalid_utf8_does_not_break_offsets() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("l.txt"), b"caf\xe9 needle\n").unwrap();
        let (r, _) = run(d.path(), &opts("needle"));
        let m = &r[0].matches[0];
        assert_eq!(m.text, "caf\u{fffd} needle");
        assert_eq!(m.ranges, vec![[5, 11]]);
    }

    #[test]
    fn empty_files_and_empty_query() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "empty.txt", "");
        let (r, s) = run(d.path(), &opts("x"));
        assert!(r.is_empty());
        assert_eq!(s.total_matches, 0);
        let (r, s) = run(d.path(), &opts(""));
        assert!(r.is_empty() && !s.cancelled);
    }

    #[test]
    fn max_results_truncates() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..20 {
            write(d.path(), &format!("f{i}.txt"), &"needle\n".repeat(50));
        }
        let mut o = opts("needle");
        o.max_results = 100;
        let (r, s) = run(d.path(), &o);
        let lines: usize = r.iter().map(|f| f.matches.len()).sum();
        assert!(s.truncated);
        assert_eq!(s.total_matches, 100);
        assert_eq!(lines, 100);
    }

    #[test]
    fn cancel_stops_the_search() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..50 {
            write(d.path(), &format!("f{i}.txt"), "needle\n");
        }
        let cancel = AtomicBool::new(true);
        let (r, s) = run_with(d.path(), &opts("needle"), &cancel);
        assert!(s.cancelled);
        assert!(r.is_empty());
    }

    #[test]
    fn cancel_during_search_from_the_callback() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..200 {
            write(d.path(), &format!("f{i}.txt"), &"needle\n".repeat(500));
        }
        let cancel = AtomicBool::new(false);
        let seen = AtomicUsize::new(0);
        let s = search_text(d.path(), &opts("needle"), &cancel, &|b| {
            seen.fetch_add(b.iter().map(|f| f.matches.len()).sum::<usize>(), Ordering::SeqCst);
            cancel.store(true, Ordering::SeqCst);
        })
        .unwrap();
        assert!(s.cancelled);
        assert!(seen.load(Ordering::SeqCst) < 200 * 500);
    }

    #[test]
    fn results_arrive_in_batches() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..30 {
            write(d.path(), &format!("f{i}.txt"), &"needle\n".repeat(100));
        }
        let batches = AtomicUsize::new(0);
        let total = AtomicUsize::new(0);
        search_text(d.path(), &opts("needle"), &AtomicBool::new(false), &|b| {
            batches.fetch_add(1, Ordering::SeqCst);
            total.fetch_add(b.iter().map(|f| f.matches.len()).sum::<usize>(), Ordering::SeqCst);
        })
        .unwrap();
        assert!(batches.load(Ordering::SeqCst) > 1);
        assert_eq!(total.load(Ordering::SeqCst), 3000);
    }

    #[test]
    fn spaces_in_paths_and_crlf() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "my dir/a b.txt", "one\r\ntwo needle\r\n");
        let (r, _) = run(d.path(), &opts("needle"));
        assert_eq!(r[0].matches[0].line, 2);
        assert_eq!(r[0].matches[0].text, "two needle");
    }

    #[test]
    fn empty_regex_matches_are_not_results() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "abc\n\nxyz\n");
        let mut o = opts("^");
        o.regex = true;
        assert!(run(d.path(), &o).0.is_empty());
    }
}
