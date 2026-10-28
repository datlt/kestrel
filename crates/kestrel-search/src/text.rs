//! Text search over a folder (find in files), with the ripgrep crates.

use crate::walk::walker;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::WalkState;
use kestrel_common::{Error, Result};
use kestrel_lang::{Lang, Region, RegionKind};
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
    /// Search only these files (absolute paths), in this order. The folder
    /// walk is skipped. Include and exclude globs still apply. Empty: walk
    /// the root.
    pub paths: Vec<String>,
    /// Where a match may be. Only Kotlin, Java and Swift files know about
    /// comments and strings.
    pub context: SearchContext,
}

/// Which matches to keep, by what is around them in the file.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SearchContext {
    #[default]
    Anywhere,
    InComments,
    InStrings,
    ExceptComments,
    ExceptStrings,
    ExceptCommentsAndStrings,
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

    let mut ob = OverrideBuilder::new(root);
    for g in glob_list(&opts.include, false).into_iter().chain(glob_list(&opts.exclude, true)) {
        ob.add(&g).map_err(|e| Error::invalid(format!("invalid glob: {e}")))?;
    }
    let overrides = ob.build().map_err(|e| Error::invalid(format!("invalid glob: {e}")))?;

    let limit = if opts.max_results == 0 { usize::MAX } else { opts.max_results };
    let total = AtomicUsize::new(0);
    let files = AtomicUsize::new(0);
    let limit_hit = AtomicBool::new(false);
    let batcher = Batcher { state: Mutex::new((Vec::new(), 0, Instant::now())), emit };
    let shared = Shared {
        matcher: &matcher,
        context: opts.context,
        total: &total,
        files: &files,
        limit,
        limit_hit: &limit_hit,
        cancel,
        batcher: &batcher,
    };

    if opts.paths.is_empty() {
        let mut walk = walker(root);
        walk.max_filesize(Some(MAX_FILE_BYTES));
        walk.overrides(overrides);
        walk.build_parallel().run(|| {
            let mut searcher = new_searcher();
            let shared = &shared;
            Box::new(move |res| {
                if shared.stopped() {
                    return WalkState::Quit;
                }
                let Ok(entry) = res else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                shared.process(&mut searcher, entry.path());
                if shared.stopped() { WalkState::Quit } else { WalkState::Continue }
            })
        });
    } else {
        // One file after the other, so the results keep the order of the paths.
        let mut searcher = new_searcher();
        for p in &opts.paths {
            if shared.stopped() {
                break;
            }
            let path = Path::new(p);
            let Ok(meta) = std::fs::metadata(path) else { continue };
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(path);
            if overrides.matched(rel, false).is_ignore() {
                continue;
            }
            shared.process(&mut searcher, path);
        }
    }
    batcher.flush();

    Ok(TextSummary {
        total_matches: total.load(Ordering::Relaxed).min(limit),
        files_with_matches: files.load(Ordering::Relaxed),
        truncated: limit_hit.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn new_searcher() -> Searcher {
    SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build()
}

/// What all worker threads share during one search.
struct Shared<'a> {
    matcher: &'a RegexMatcher,
    context: SearchContext,
    total: &'a AtomicUsize,
    files: &'a AtomicUsize,
    limit: usize,
    limit_hit: &'a AtomicBool,
    cancel: &'a AtomicBool,
    batcher: &'a Batcher<'a>,
}

impl Shared<'_> {
    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.limit_hit.load(Ordering::Relaxed)
    }

    /// Searches one file and hands the result to the batcher.
    fn process(&self, searcher: &mut Searcher, path: &Path) {
        let lang = path.extension().and_then(|e| e.to_str()).and_then(Lang::from_extension);
        // These hold the file when a context filter needs the text.
        let bytes: Vec<u8>;
        let text: std::borrow::Cow<'_, str>;
        let mut sink = LineSink {
            matcher: self.matcher,
            lines: Vec::new(),
            binary: false,
            total: self.total,
            limit: self.limit,
            limit_hit: self.limit_hit,
            cancel: self.cancel,
            filter: None,
        };
        match lang {
            // Other files have no comments or strings that we know of.
            None if matches!(self.context, SearchContext::InComments | SearchContext::InStrings) => return,
            Some(lang) if self.context != SearchContext::Anywhere => {
                // Read the file once. Search and filter work on the same text.
                let Ok(read) = std::fs::read(path) else { return };
                if read.len() as u64 > MAX_FILE_BYTES || read.contains(&0) {
                    return;
                }
                bytes = read;
                text = String::from_utf8_lossy(&bytes);
                sink.filter = Some(CtxFilter { context: self.context, lang, text: &text, regions: None });
                let _ = searcher.search_slice(self.matcher, text.as_bytes(), &mut sink);
            }
            // Read errors (permissions, files removed while we search) skip the file.
            _ => {
                let _ = searcher.search_path(self.matcher, path, &mut sink);
            }
        }
        if sink.binary {
            self.total.fetch_sub(sink.lines.len(), Ordering::Relaxed);
            sink.lines.clear();
        }
        if !sink.lines.is_empty() {
            self.files.fetch_add(1, Ordering::Relaxed);
            self.batcher.add(FileMatches {
                path: path.to_string_lossy().into_owned(),
                matches: sink.lines,
            });
        }
    }
}

/// Decides for one match if it fits the context. The regions of the file
/// are computed when the first match asks.
struct CtxFilter<'a> {
    context: SearchContext,
    lang: Lang,
    text: &'a str,
    regions: Option<Vec<Region>>,
}

impl CtxFilter<'_> {
    fn keep(&mut self, start: usize, end: usize) -> bool {
        let (lang, text) = (self.lang, self.text);
        let regions = self.regions.get_or_insert_with(|| kestrel_lang::regions(lang, text));
        keep_range(self.context, regions, start, end)
    }
}

/// `regions` are sorted and do not overlap. A match is "in" a region when it
/// fits completely. It "touches" a region when they share at least one byte.
fn keep_range(context: SearchContext, regions: &[Region], start: usize, end: usize) -> bool {
    let first = regions.partition_point(|r| r.end <= start);
    let (mut in_comment, mut in_string, mut touch_comment, mut touch_string) = (false, false, false, false);
    for r in &regions[first..] {
        if r.start >= end {
            break;
        }
        let inside = r.start <= start && end <= r.end;
        match r.kind {
            RegionKind::Comment => {
                touch_comment = true;
                in_comment |= inside;
            }
            RegionKind::String => {
                touch_string = true;
                in_string |= inside;
            }
        }
    }
    match context {
        SearchContext::Anywhere => true,
        SearchContext::InComments => in_comment,
        SearchContext::InStrings => in_string,
        SearchContext::ExceptComments => !touch_comment,
        SearchContext::ExceptStrings => !touch_string,
        SearchContext::ExceptCommentsAndStrings => !touch_comment && !touch_string,
    }
}

struct LineSink<'a> {
    matcher: &'a RegexMatcher,
    lines: Vec<LineMatch>,
    binary: bool,
    total: &'a AtomicUsize,
    limit: usize,
    limit_hit: &'a AtomicBool,
    cancel: &'a AtomicBool,
    filter: Option<CtxFilter<'a>>,
}

impl Sink for LineSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, m: &SinkMatch<'_>) -> std::result::Result<bool, Self::Error> {
        if self.cancel.load(Ordering::Relaxed) || self.limit_hit.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let line = String::from_utf8_lossy(m.bytes());
        let base = m.absolute_byte_offset() as usize;
        let filter = &mut self.filter;
        let mut keep = |s: usize, e: usize| filter.as_mut().is_none_or(|f| f.keep(base + s, base + e));
        if let Some(found) = make_line_match(self.matcher, m.line_number().unwrap_or(0), &line, &mut keep) {
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
/// `keep` gets the byte range of each match in the line and says if the match counts.
fn make_line_match(
    matcher: &RegexMatcher,
    line_no: u64,
    raw: &str,
    keep: &mut dyn FnMut(usize, usize) -> bool,
) -> Option<LineMatch> {
    let text = raw.trim_end_matches(['\n', '\r']);
    let mut found: Vec<(usize, usize)> = Vec::new();
    let _ = matcher.find_iter(text.as_bytes(), |m| {
        if m.end() > m.start() && keep(m.start(), m.end()) {
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

    // --- paths ---

    fn run_ordered(root: &Path, o: &TextOptions) -> (Vec<FileMatches>, TextSummary) {
        let out = Mutex::new(Vec::new());
        let sum = search_text(root, o, &AtomicBool::new(false), &|b| out.lock().extend(b)).unwrap();
        (out.into_inner(), sum)
    }

    fn abs(root: &Path, rel: &str) -> String {
        root.join(rel).to_string_lossy().into_owned()
    }

    #[test]
    fn paths_keep_their_order_and_skip_bad_entries() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "a.txt", "needle a\n");
        write(r, "b.txt", "needle b\n");
        write(r, "sub/c.txt", "needle c\n");
        write(r, "sub/other.txt", "needle other\n");
        fs::write(r.join("bin.dat"), b"needle\0\x01\n").unwrap();
        let mut o = opts("needle");
        o.paths = vec![
            abs(r, "sub/c.txt"),
            abs(r, "missing.txt"),
            abs(r, "a.txt"),
            abs(r, "sub"),
            abs(r, "bin.dat"),
            abs(r, "b.txt"),
        ];
        let (res, s) = run_ordered(r, &o);
        assert_eq!(names(r, &res), vec!["sub/c.txt", "a.txt", "b.txt"]);
        assert_eq!(s.total_matches, 3);
        assert_eq!(s.files_with_matches, 3);
    }

    #[test]
    fn paths_do_not_walk_and_ignore_gitignore() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "ignored/\n");
        write(r, "ignored/x.txt", "needle\n");
        write(r, "other.txt", "needle\n");
        let mut o = opts("needle");
        o.paths = vec![abs(r, "ignored/x.txt")];
        // The caller named the file, so it is searched, and no other file is.
        assert_eq!(names(r, &run_ordered(r, &o).0), vec!["ignored/x.txt"]);
    }

    #[test]
    fn paths_still_use_include_and_exclude() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "src/a.ts", "needle\n");
        write(r, "src/b.js", "needle\n");
        write(r, "vendor/c.ts", "needle\n");
        let all = vec![abs(r, "vendor/c.ts"), abs(r, "src/b.js"), abs(r, "src/a.ts")];
        let mut o = opts("needle");
        o.paths = all.clone();
        o.include = vec!["*.ts".into()];
        assert_eq!(names(r, &run_ordered(r, &o).0), vec!["vendor/c.ts", "src/a.ts"]);
        o.exclude = vec!["vendor".into()];
        assert_eq!(names(r, &run_ordered(r, &o).0), vec!["src/a.ts"]);
        let mut o = opts("needle");
        o.paths = all;
        o.exclude = vec!["*.js".into()];
        assert_eq!(names(r, &run_ordered(r, &o).0), vec!["vendor/c.ts", "src/a.ts"]);
    }

    #[test]
    fn paths_stop_at_the_limit() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "a.txt", &"needle\n".repeat(10));
        write(r, "b.txt", &"needle\n".repeat(10));
        let mut o = opts("needle");
        o.paths = vec![abs(r, "a.txt"), abs(r, "b.txt")];
        o.max_results = 15;
        let (res, s) = run_ordered(r, &o);
        assert!(s.truncated);
        assert_eq!(s.total_matches, 15);
        assert_eq!(res.iter().map(|f| f.matches.len()).sum::<usize>(), 15);
    }

    #[test]
    fn sub_folder_root_uses_ignore_files_above_it() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "*.log\n/mod/gen/\nbuild/\n");
        write(r, "mod/.gitignore", "local.txt\n");
        write(r, "mod/a.txt", "needle\n");
        write(r, "mod/b.log", "needle\n");
        write(r, "mod/gen/x.txt", "needle\n");
        write(r, "mod/src/build/y.txt", "needle\n");
        write(r, "mod/local.txt", "needle\n");
        write(r, "mod/src/z.txt", "needle\n");
        write(r, "top.txt", "needle\n");
        fs::create_dir_all(r.join(".git")).unwrap();
        let sub = r.join("mod");
        let (res, _) = run(&sub, &opts("needle"));
        assert_eq!(names(&sub, &res), vec!["a.txt", "src/z.txt"]);
    }

    // --- context ---

    const KOTLIN: &str = "val code = NEEDLE\n// NEEDLE comment\nval s = \"NEEDLE string\"\nval t = \"s\" + x\n/* c */ val b = 1\nval e = \"a ${NEEDLE} b\"\n";
    const JAVA: &str = "int code = NEEDLE;\n// NEEDLE comment\nString s = \"NEEDLE string\";\nString t = \"s\" + x;\n/* c */ int b = 1;\nint e = foo(NEEDLE);\n";
    const SWIFT: &str = "let code = NEEDLE\n// NEEDLE comment\nlet s = \"NEEDLE string\"\nlet t = \"s\" + x\n/* c */ let b = 1\nlet e = \"a \\(NEEDLE) b\"\n";
    const PLAIN: &str = "NEEDLE\n// NEEDLE comment\n\"NEEDLE string\"\n\"s\" + x\n/* c */ let b = 1\n";

    const ALL_CONTEXTS: [SearchContext; 6] = [
        SearchContext::Anywhere,
        SearchContext::InComments,
        SearchContext::InStrings,
        SearchContext::ExceptComments,
        SearchContext::ExceptStrings,
        SearchContext::ExceptCommentsAndStrings,
    ];

    /// The line numbers that match `query` in the one file `name`.
    fn lines_for(name: &str, text: &str, query: &str, context: SearchContext) -> Vec<u64> {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), name, text);
        let mut o = opts(query);
        o.context = context;
        let (r, s) = run(d.path(), &o);
        let lines: Vec<u64> = r.iter().flat_map(|f| f.matches.iter().map(|m| m.line)).collect();
        assert_eq!(s.total_matches, lines.len(), "total counts the kept matches ({name}, {context:?})");
        assert_eq!(s.files_with_matches, r.len());
        lines
    }

    #[test]
    fn context_filters_jvm_and_swift_files() {
        for (name, text) in [("A.kt", KOTLIN), ("A.java", JAVA), ("A.swift", SWIFT)] {
            // Matches in code (1, 6), comment (2), string (3).
            let expect: [&[u64]; 6] = [&[1, 2, 3, 6], &[2], &[3], &[1, 3, 6], &[1, 2, 6], &[1, 6]];
            for (ctx, want) in ALL_CONTEXTS.iter().zip(expect) {
                assert_eq!(lines_for(name, text, "NEEDLE", *ctx), want, "{name} {ctx:?}");
            }
            // The match `" +` starts in the string and ends in code.
            let expect: [&[u64]; 6] = [&[4], &[], &[], &[4], &[], &[]];
            for (ctx, want) in ALL_CONTEXTS.iter().zip(expect) {
                assert_eq!(lines_for(name, text, "\" +", *ctx), want, "{name} border string {ctx:?}");
            }
            // The match `*/ l` or `*/ i` starts in the comment and ends in code.
            let q = if name == "A.java" { "*/ int" } else { "*/ " };
            let expect: [&[u64]; 6] = [&[5], &[], &[], &[], &[5], &[]];
            for (ctx, want) in ALL_CONTEXTS.iter().zip(expect) {
                assert_eq!(lines_for(name, text, q, *ctx), want, "{name} border comment {ctx:?}");
            }
        }
    }

    #[test]
    fn context_ignores_other_files_except_in_filters() {
        for ctx in ALL_CONTEXTS {
            let got = lines_for("notes.txt", PLAIN, "NEEDLE", ctx);
            match ctx {
                SearchContext::InComments | SearchContext::InStrings => assert!(got.is_empty(), "{ctx:?}"),
                _ => assert_eq!(got, vec![1, 2, 3], "{ctx:?}"),
            }
        }
    }

    #[test]
    fn context_counts_after_the_filter_and_skips_binary() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "A.kt", "// NEEDLE NEEDLE\nval x = NEEDLE\nval y = NEEDLE\n");
        write(r, "B.kt", "// NEEDLE only a comment\n");
        fs::write(r.join("C.kt"), b"val x = NEEDLE\0\n").unwrap();
        let mut o = opts("NEEDLE");
        o.context = SearchContext::ExceptComments;
        let (res, s) = run(r, &o);
        assert_eq!(names(r, &res), vec!["A.kt"]);
        assert_eq!(s.total_matches, 2);
        assert_eq!(s.files_with_matches, 1);
        o.context = SearchContext::InComments;
        let (res, s) = run(r, &o);
        assert_eq!(names(r, &res), vec!["A.kt", "B.kt"]);
        assert_eq!(res[0].matches[0].ranges.len(), 2);
        assert_eq!(s.total_matches, 2);
    }

    #[test]
    fn context_works_with_paths_and_ranges_after_non_ascii() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        // The byte offsets of the regions are not the character offsets here.
        write(r, "J.java", "String a = \"日本語 😀\"; // 日本 NEEDLE\nint NEEDLE = 1; // 😀\n");
        let mut o = opts("NEEDLE");
        o.paths = vec![abs(r, "J.java")];
        o.context = SearchContext::InComments;
        let (res, _) = run_ordered(r, &o);
        assert_eq!(res[0].matches.len(), 1);
        assert_eq!(res[0].matches[0].line, 1);
        o.context = SearchContext::ExceptComments;
        let (res, _) = run_ordered(r, &o);
        assert_eq!(res[0].matches.len(), 1);
        assert_eq!(res[0].matches[0].line, 2);
    }

    /// Run by hand: `KESTREL_BENCH_ROOT=/some/repo cargo test -p kestrel-search --release bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_context_and_modules() {
        let Ok(root) = std::env::var("KESTREL_BENCH_ROOT") else { return };
        let root = Path::new(&root);
        let query = std::env::var("KESTREL_BENCH_QUERY").unwrap_or_else(|_| "user".into());
        for round in 0..2 {
            for ctx in ALL_CONTEXTS {
                let mut o = opts(&query);
                o.context = ctx;
                let s = search_text(root, &o, &AtomicBool::new(false), &|_| {}).unwrap();
                println!("round {round} {ctx:?}: {} ms, {} matches in {} files", s.elapsed_ms, s.total_matches, s.files_with_matches);
            }
            let t = Instant::now();
            let m = crate::search_modules(root).unwrap();
            println!("round {round} modules: {} ms, {} found", t.elapsed().as_millis(), m.len());
        }
    }
}
