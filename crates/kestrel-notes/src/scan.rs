//! The scanner of one markdown file. It reads the text in one pass, line by
//! line, without regular expressions, and finds the front matter, the title,
//! the tags and the links (DESIGN.md 14.2).
//!
//! Code blocks, inline code, comments, math and backslash escapes hide links
//! and tags. A line is never longer than the work we do on it: every search
//! stays inside the line, so a file of 5 MB on one line stays fast.

use memchr::{memchr, memchr2, memchr3, memmem};
use std::collections::HashSet;

/// Notes bigger than this are not read.
pub const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

/// Longest link destination we accept, in bytes.
const MAX_DEST: usize = 2048;
/// Longest tag we accept, in bytes.
const MAX_TAG: usize = 255;

/// How a link was written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LinkKind {
    /// `[[target]]`
    Wiki,
    /// `[text](dest)`, `![alt](dest)` or `[id]: dest`
    Markdown,
}

/// A link as found in the text, before it is resolved.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RawLink {
    /// Wiki links: the text before `#` and `|`. Markdown links: the
    /// destination without `#fragment` and `?query`, percent-decoded.
    pub target: String,
    pub kind: LinkKind,
    /// `![[x]]` or `![alt](x)`.
    pub embed: bool,
    /// 1-based line.
    pub line: u32,
}

/// What the scanner found in one file.
#[derive(Default, Debug)]
pub struct Scanned {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub links: Vec<RawLink>,
}

/// Scans the text of one markdown file. A leading BOM is ignored.
pub fn scan(text: &str) -> Scanned {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut s = Scan::default();
    let body_start = s.front_matter(text);
    let (mut pos, mut line_no) = body_start;
    let len = text.len();
    while pos < len {
        let end = memchr(b'\n', &text.as_bytes()[pos..]).map_or(len, |i| pos + i);
        let line = &text[pos..end];
        let line = line.strip_suffix('\r').unwrap_or(line);
        line_no += 1;
        s.line(line, line_no);
        pos = end + 1;
    }
    s.out
}

/// Result of cleaning a markdown link destination.
#[derive(Debug, PartialEq, Eq)]
pub struct CleanDest {
    /// Path part, percent-decoded.
    pub target: String,
    /// The part after `#`, percent-decoded, when there is one.
    pub fragment: Option<String>,
}

/// Cleans the destination of a markdown link. Returns `None` for external
/// URLs (any scheme), for `#anchor` only and for an empty destination.
pub fn clean_dest(dest: &str) -> Option<CleanDest> {
    let mut d = dest.trim();
    if let Some(inner) = d.strip_prefix('<') {
        d = inner.strip_suffix('>').unwrap_or(inner).trim();
    }
    if d.is_empty() || d.starts_with('#') || d.starts_with("//") || has_scheme(d) {
        return None;
    }
    let (path, fragment) = match d.find('#') {
        Some(i) => (&d[..i], Some(&d[i + 1..])),
        None => (d, None),
    };
    let path = path.split('?').next().unwrap_or("");
    let target = percent_decode(path);
    if target.trim().is_empty() {
        return None;
    }
    Some(CleanDest { target, fragment: fragment.map(percent_decode) })
}

/// True when the text starts with `[A-Za-z][A-Za-z0-9+.-]*:`.
fn has_scheme(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return false;
    }
    for &c in &b[1..] {
        if c == b':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'.' || c == b'-') {
            return false;
        }
    }
    false
}

/// Decodes `%XX` sequences. A bad sequence stays as it is.
pub fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() {
            out.push(hex(b[i + 1]).unwrap() * 16 + hex(b[i + 2]).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Splits the text inside `[[ ]]` into the target, the heading (the part
/// after `#`) and drops the alias (after `|`). `\|` counts as a pipe.
pub fn split_wiki(content: &str) -> (&str, Option<&str>) {
    let mut target = content;
    if let Some(i) = content.find('|') {
        target = &content[..i];
        target = target.strip_suffix('\\').unwrap_or(target);
    }
    match target.find('#') {
        Some(i) => (target[..i].trim(), Some(target[i + 1..].trim())),
        None => (target.trim(), None),
    }
}

// --- Scanner state -------------------------------------------------------------

#[derive(Default)]
struct Scan {
    out: Scanned,
    seen_tags: HashSet<String>,
    /// Open fenced code block: the fence character and its length.
    fence: Option<(u8, usize)>,
    html_comment: bool,
    percent: bool,
    math: bool,
    prev_blank: bool,
    in_list: bool,
    in_indented_code: bool,
    started: bool,
}

/// Work data of one line.
struct Ctx<'a> {
    text: &'a str,
    bytes: &'a [u8],
    no: u32,
    /// Pairs (open, close) of matching square brackets, sorted by `open`.
    /// Built on the first use.
    brackets: Option<Vec<(u32, u32)>>,
    /// No `]]` is left in this line.
    no_wiki_close: bool,
}

impl Ctx<'_> {
    fn close_of(&mut self, open: usize) -> Option<usize> {
        if self.brackets.is_none() {
            let b = self.bytes;
            let mut stack: Vec<u32> = Vec::new();
            let mut pairs: Vec<(u32, u32)> = Vec::new();
            let mut i = 0;
            while i < b.len() {
                let Some(off) = memchr3(b'[', b']', b'\\', &b[i..]) else { break };
                i += off;
                match b[i] {
                    b'\\' => i += 1,
                    b'[' => stack.push(i as u32),
                    _ => {
                        if let Some(o) = stack.pop() {
                            pairs.push((o, i as u32));
                        }
                    }
                }
                i += 1;
            }
            pairs.sort_unstable();
            self.brackets = Some(pairs);
        }
        let pairs = self.brackets.as_ref()?;
        pairs.binary_search_by_key(&(open as u32), |p| p.0).ok().map(|k| pairs[k].1 as usize)
    }
}

impl Scan {
    // --- Front matter ------------------------------------------------------------

    /// Reads the front matter when there is one. Returns the byte position and
    /// the line count after it.
    fn front_matter(&mut self, text: &str) -> (usize, u32) {
        self.prev_blank = true;
        let first_end = memchr(b'\n', text.as_bytes()).unwrap_or(text.len());
        let first = text[..first_end].trim_end();
        if first != "---" {
            return (0, 0);
        }
        let mut lines: Vec<&str> = Vec::new();
        let mut pos = first_end + 1;
        let mut count = 1u32;
        while pos <= text.len() && lines.len() < 2000 {
            if pos == text.len() {
                return (0, 0);
            }
            let end = memchr(b'\n', &text.as_bytes()[pos..]).map_or(text.len(), |i| pos + i);
            let line = text[pos..end].trim_end_matches('\r');
            count += 1;
            if line.trim_end() == "---" || line.trim_end() == "..." {
                if !looks_like_yaml(&lines) {
                    return (0, 0);
                }
                self.parse_yaml(&lines);
                return ((end + 1).min(text.len()), count);
            }
            lines.push(line);
            pos = end + 1;
        }
        (0, 0)
    }

    fn parse_yaml(&mut self, lines: &[&str]) {
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            i += 1;
            let first = line.chars().next();
            if matches!(first, None | Some(' ') | Some('\t') | Some('#') | Some('-')) {
                continue;
            }
            let Some((key, rest)) = line.split_once(':') else { continue };
            let key = unquote(key.trim()).to_ascii_lowercase();
            let rest = strip_yaml_comment(rest.trim());
            let kind = match key.as_str() {
                "title" => 0,
                "tags" | "tag" => 1,
                "aliases" | "alias" => 2,
                _ => continue,
            };
            let mut items: Vec<String> = Vec::new();
            if rest.starts_with('[') {
                // Inline list. It can go over several lines.
                let mut joined = rest.to_owned();
                while !joined.contains(']') && i < lines.len() {
                    joined.push(' ');
                    joined.push_str(lines[i].trim());
                    i += 1;
                }
                let inner = joined.trim_start_matches('[');
                let inner = inner.split(']').next().unwrap_or("");
                items = split_inline_list(inner);
            } else if rest.is_empty() {
                while i < lines.len() {
                    let l = lines[i];
                    let t = l.trim_start();
                    if t.is_empty() || t.starts_with('#') {
                        i += 1;
                        continue;
                    }
                    if t == "-" || t.starts_with("- ") {
                        let v = strip_yaml_comment(t[1..].trim());
                        items.push(unquote(v).to_owned());
                        i += 1;
                    } else {
                        break;
                    }
                }
            } else if rest == "|" || rest == ">" || rest == "|-" || rest == ">-" {
                // A block scalar: skip its lines.
                while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t') || lines[i].is_empty()) {
                    i += 1;
                }
            } else {
                let v = unquote(rest);
                if kind == 1 {
                    items = v.split(|c: char| c == ',' || c.is_whitespace()).map(str::to_owned).collect();
                } else {
                    items.push(v.to_owned());
                }
            }
            match kind {
                0 => {
                    if self.out.title.is_none() {
                        if let Some(t) = items.into_iter().next().filter(|t| !t.trim().is_empty()) {
                            self.out.title = Some(t.trim().to_owned());
                        }
                    }
                }
                1 => {
                    for t in items {
                        self.add_tag(t.trim().trim_start_matches('#').trim());
                    }
                }
                _ => {
                    for a in items {
                        let a = a.trim();
                        if !a.is_empty() && !self.out.aliases.iter().any(|x| x == a) {
                            self.out.aliases.push(a.to_owned());
                        }
                    }
                }
            }
        }
    }

    fn add_tag(&mut self, tag: &str) {
        if tag.is_empty() {
            return;
        }
        if self.seen_tags.insert(tag.to_lowercase()) {
            self.out.tags.push(tag.to_owned());
        }
    }

    // --- Lines -------------------------------------------------------------------

    fn line(&mut self, line: &str, no: u32) {
        if !self.started {
            self.started = true;
        }
        let b = line.as_bytes();
        if let Some((ch, n)) = self.fence {
            if is_fence_close(b, ch, n) {
                self.fence = None;
            }
            self.prev_blank = false;
            return;
        }
        let mut cx = Ctx { text: line, bytes: b, no, brackets: None, no_wiki_close: false };
        if self.html_comment || self.percent || self.math {
            self.scan_range(&mut cx, 0, b.len(), true);
            self.prev_blank = false;
            return;
        }
        if line.trim().is_empty() {
            self.prev_blank = true;
            return;
        }
        let indent = indent_of(b);
        if self.in_indented_code {
            if indent >= 4 {
                self.prev_blank = false;
                return;
            }
            self.in_indented_code = false;
        }
        if self.prev_blank && !self.in_list && indent >= 4 {
            self.in_indented_code = true;
            self.prev_blank = false;
            return;
        }
        // Skip the indent and the `>` marks of block quotes.
        let (content_start, quoted) = content_start(b);
        let content = &line[content_start..];
        if indent <= 3 || self.in_list || quoted {
            if let Some((ch, n)) = fence_open(content.as_bytes()) {
                self.fence = Some((ch, n));
                self.prev_blank = false;
                return;
            }
        }
        if indent <= 3 && !quoted {
            if self.reference_definition(content, no) {
                self.prev_blank = false;
                return;
            }
            if self.out.title.is_none() {
                if let Some(t) = heading1(content) {
                    self.out.title = Some(t.to_owned());
                }
            }
        }
        if is_list_marker(content.as_bytes()) {
            self.in_list = true;
        } else if indent == 0 && !quoted {
            self.in_list = false;
        }
        self.scan_range(&mut cx, 0, b.len(), true);
        self.prev_blank = false;
    }

    /// `[id]: dest` at the start of a line. Returns true when the line is one.
    fn reference_definition(&mut self, content: &str, no: u32) -> bool {
        let b = content.as_bytes();
        if b.len() < 4 || b[0] != b'[' || b[1] == b'[' || b[1] == b'^' {
            return false;
        }
        let Some(close) = memchr(b']', b) else { return false };
        if b.get(close + 1) != Some(&b':') {
            return false;
        }
        let mut j = close + 2;
        while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
            j += 1;
        }
        let dest = if j < b.len() && b[j] == b'<' {
            match memchr(b'>', &b[j..]) {
                Some(k) => &content[j..j + k + 1],
                None => return false,
            }
        } else {
            let e = b[j..].iter().position(|c| *c == b' ' || *c == b'\t').map_or(b.len(), |k| j + k);
            &content[j..e]
        };
        if dest.is_empty() {
            return false;
        }
        if let Some(c) = clean_dest(dest) {
            self.out.links.push(RawLink { target: c.target, kind: LinkKind::Markdown, embed: false, line: no });
        }
        true
    }

    // --- Inline ------------------------------------------------------------------

    /// Scans `[i, end)` of the line. `tags` is false inside a link text.
    fn scan_range(&mut self, cx: &mut Ctx, mut i: usize, end: usize, tags: bool) {
        let b = cx.bytes;
        while i < end {
            if self.html_comment {
                match find(b, b"-->", i, end) {
                    Some(p) => {
                        self.html_comment = false;
                        i = p + 3;
                    }
                    None => return,
                }
                continue;
            }
            if self.percent {
                match find(b, b"%%", i, end) {
                    Some(p) => {
                        self.percent = false;
                        i = p + 2;
                    }
                    None => return,
                }
                continue;
            }
            if self.math {
                match find(b, b"$$", i, end) {
                    Some(p) => {
                        self.math = false;
                        i = p + 2;
                    }
                    None => return,
                }
                continue;
            }
            match b[i] {
                b'\\' => i += 2,
                b'`' => i = skip_code_span(b, i, end),
                b'<' => {
                    if b[i..end].starts_with(b"<!--") {
                        match find(b, b"-->", i + 4, end) {
                            Some(p) => i = p + 3,
                            None => {
                                self.html_comment = true;
                                return;
                            }
                        }
                    } else {
                        i += 1;
                    }
                }
                b'%' => {
                    if i + 1 < end && b[i + 1] == b'%' {
                        match find(b, b"%%", i + 2, end) {
                            Some(p) => i = p + 2,
                            None => {
                                self.percent = true;
                                return;
                            }
                        }
                    } else {
                        i += 1;
                    }
                }
                b'$' => {
                    if i + 1 < end && b[i + 1] == b'$' {
                        match find(b, b"$$", i + 2, end) {
                            Some(p) => i = p + 2,
                            None => {
                                self.math = true;
                                return;
                            }
                        }
                    } else {
                        i = skip_inline_math(b, i, end);
                    }
                }
                b'!' => {
                    if i + 1 < end && b[i + 1] == b'[' {
                        i = self.bracket(cx, i + 1, end, true);
                    } else {
                        i += 1;
                    }
                }
                b'[' => i = self.bracket(cx, i, end, false),
                b'#' if tags => i = self.tag(cx.text, i),
                _ => i += 1,
            }
        }
    }

    /// Handles `[` at `i`: a wiki link, a markdown link or plain text.
    /// Returns the next position.
    fn bracket(&mut self, cx: &mut Ctx, i: usize, end: usize, embed: bool) -> usize {
        let b = cx.bytes;
        if i + 1 < end && b[i + 1] == b'[' {
            if !cx.no_wiki_close {
                match memmem::find(&b[i + 2..end], b"]]") {
                    Some(p) => {
                        let stop = i + 2 + p;
                        let mut start = i + 2;
                        if let Some(q) = memmem::rfind(&b[start..stop], b"[[") {
                            start += q + 2;
                        }
                        let (target, _) = split_wiki(&cx.text[start..stop]);
                        if !target.is_empty() && target.len() <= 1024 {
                            self.out.links.push(RawLink {
                                target: target.to_owned(),
                                kind: LinkKind::Wiki,
                                embed,
                                line: cx.no,
                            });
                        }
                        return stop + 2;
                    }
                    None => cx.no_wiki_close = true,
                }
            }
            return i + 1;
        }
        let Some(close) = cx.close_of(i) else { return i + 1 };
        if close >= end || close + 1 >= end || b[close + 1] != b'(' {
            return i + 1;
        }
        let Some((ds, de, after)) = parse_dest(b, close + 2, end) else { return i + 1 };
        if let Some(c) = clean_dest(&cx.text[ds..de]) {
            self.out.links.push(RawLink { target: c.target, kind: LinkKind::Markdown, embed, line: cx.no });
        }
        // The text can hold an image or a wiki link: `[![alt](a.png)](b)`.
        if memchr(b'[', &b[i + 1..close]).is_some() {
            self.scan_range(cx, i + 1, close, false);
        }
        after
    }

    /// Handles `#` at `i`. Returns the next position.
    fn tag(&mut self, text: &str, i: usize) -> usize {
        let b = text.as_bytes();
        if i > 0 && b[i - 1] != b' ' && b[i - 1] != b'\t' {
            return i + 1;
        }
        let rest = &text[i + 1..];
        let mut used = 0;
        let mut named = false;
        for (k, c) in rest.char_indices() {
            if is_tag_char(c) {
                used = k + c.len_utf8();
                if c.is_alphabetic() || c == '_' || is_mark(c) {
                    named = true;
                }
            } else {
                break;
            }
        }
        if used == 0 {
            return i + 1;
        }
        let tag = rest[..used].trim_end_matches('/');
        if named && !tag.is_empty() && tag.len() <= MAX_TAG {
            let tag = tag.to_owned();
            self.add_tag(&tag);
        }
        i + 1 + used
    }
}

// --- Helpers ---------------------------------------------------------------------

fn find(b: &[u8], needle: &[u8], from: usize, end: usize) -> Option<usize> {
    if from >= end {
        return None;
    }
    memmem::find(&b[from..end], needle).map(|p| from + p)
}

/// Skips a code span that starts at `i` (a run of backticks). A run without
/// a closing run of the same length is plain text.
fn skip_code_span(b: &[u8], i: usize, end: usize) -> usize {
    let mut n = 0;
    while i + n < end && b[i + n] == b'`' {
        n += 1;
    }
    let mut j = i + n;
    while j < end {
        let Some(off) = memchr(b'`', &b[j..end]) else { return i + n };
        j += off;
        let mut m = 0;
        while j + m < end && b[j + m] == b'`' {
            m += 1;
        }
        if m == n {
            return j + m;
        }
        j += m;
    }
    i + n
}

/// Skips inline math `$x$`. The opening `$` is not followed by a space, the
/// closing one is not after a space and not followed by a digit.
fn skip_inline_math(b: &[u8], i: usize, end: usize) -> usize {
    if i + 1 >= end || b[i + 1] == b' ' || b[i + 1] == b'\t' {
        return i + 1;
    }
    let mut j = i + 1;
    while j < end {
        let Some(off) = memchr2(b'$', b'\\', &b[j..end]) else { return i + 1 };
        j += off;
        if b[j] == b'\\' {
            j += 2;
            continue;
        }
        if b[j - 1] == b' ' || b[j - 1] == b'\t' {
            return i + 1;
        }
        if j + 1 < end && b[j + 1].is_ascii_digit() {
            j += 1;
            continue;
        }
        return j + 1;
    }
    i + 1
}

/// Parses `dest "title")` after `(`. Returns the byte range of the
/// destination and the position after `)`.
fn parse_dest(b: &[u8], start: usize, end: usize) -> Option<(usize, usize, usize)> {
    let mut j = start;
    while j < end && (b[j] == b' ' || b[j] == b'\t') {
        j += 1;
    }
    let (ds, de);
    if j < end && b[j] == b'<' {
        let limit = end.min(j + 1 + MAX_DEST);
        let k = memchr(b'>', &b[j + 1..limit])?;
        ds = j;
        de = j + 1 + k + 1;
        j = de;
    } else {
        ds = j;
        // A destination without a closing parenthesis near it is no link. This
        // check is one fast search and keeps lines full of `[x](` linear.
        memchr(b')', &b[j..end.min(j + MAX_DEST)])?;
        let mut depth = 0usize;
        while j < end {
            match b[j] {
                b'\\' => j += 1,
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b' ' | b'\t' => break,
                _ => {}
            }
            j += 1;
            if j - ds > MAX_DEST {
                return None;
            }
        }
        j = j.min(end);
        de = j;
    }
    while j < end && (b[j] == b' ' || b[j] == b'\t') {
        j += 1;
    }
    if j < end && b[j] == b')' {
        return Some((ds, de, j + 1));
    }
    if j < end && j > de && matches!(b[j], b'"' | b'\'' | b'(') {
        let closer = if b[j] == b'(' { b')' } else { b[j] };
        let mut k = j + 1;
        while k < end && k - j <= MAX_DEST {
            if b[k] == b'\\' {
                k += 2;
                continue;
            }
            if b[k] == closer {
                break;
            }
            k += 1;
        }
        if k >= end || b[k] != closer {
            return None;
        }
        k += 1;
        while k < end && (b[k] == b' ' || b[k] == b'\t') {
            k += 1;
        }
        if k < end && b[k] == b')' {
            return Some((ds, de, k + 1));
        }
    }
    None
}

/// Spaces before the first character. A tab counts as 4.
fn indent_of(b: &[u8]) -> usize {
    let mut n = 0;
    for &c in b {
        match c {
            b' ' => n += 1,
            b'\t' => n += 4,
            _ => break,
        }
    }
    n
}

/// Position after the indent and the `>` marks. The flag tells if there was a `>`.
fn content_start(b: &[u8]) -> (usize, bool) {
    let mut i = 0;
    let mut quoted = false;
    loop {
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        if i < b.len() && b[i] == b'>' {
            quoted = true;
            i += 1;
        } else {
            return (i, quoted);
        }
    }
}

/// An opening code fence: three or more backticks or tildes. For backticks
/// the rest of the line has no backtick.
fn fence_open(b: &[u8]) -> Option<(u8, usize)> {
    let ch = *b.first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let n = b.iter().take_while(|c| **c == ch).count();
    if n < 3 {
        return None;
    }
    if ch == b'`' && memchr(b'`', &b[n..]).is_some() {
        return None;
    }
    Some((ch, n))
}

fn is_fence_close(b: &[u8], ch: u8, n: usize) -> bool {
    let (start, _) = content_start(b);
    let rest = &b[start..];
    let run = rest.iter().take_while(|c| **c == ch).count();
    run >= n && rest[run..].iter().all(|c| *c == b' ' || *c == b'\t')
}

/// `- `, `* `, `+ ` or `1. ` / `1) ` at the start.
fn is_list_marker(b: &[u8]) -> bool {
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    let rest = &b[i..];
    match rest.first() {
        Some(b'-') | Some(b'*') | Some(b'+') => matches!(rest.get(1), Some(b' ') | Some(b'\t') | None),
        Some(c) if c.is_ascii_digit() => {
            let d = rest.iter().take_while(|c| c.is_ascii_digit()).count();
            d <= 9 && matches!(rest.get(d), Some(b'.') | Some(b')')) && matches!(rest.get(d + 1), Some(b' ') | Some(b'\t') | None)
        }
        _ => false,
    }
}

/// The text of a level 1 heading `# Title`.
fn heading1(content: &str) -> Option<&str> {
    let rest = content.strip_prefix('#')?;
    if !(rest.starts_with(' ') || rest.starts_with('\t')) {
        return None;
    }
    let mut t = rest.trim();
    // Closing hashes: `# Title ##`.
    let stripped = t.trim_end_matches('#');
    if stripped.len() != t.len() && (stripped.is_empty() || stripped.ends_with(' ') || stripped.ends_with('\t')) {
        t = stripped.trim_end();
    }
    if t.is_empty() { None } else { Some(t) }
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/' || is_mark(c)
}

/// Combining marks (decomposed Vietnamese and Japanese text).
fn is_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x3099..=0x309A | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF)
}

// --- YAML helpers ------------------------------------------------------------------

/// Every line is a `key: value` line, indented, a list item or a comment.
fn looks_like_yaml(lines: &[&str]) -> bool {
    lines.iter().all(|l| {
        let t = l.trim();
        t.is_empty() || t.starts_with('#') || t.starts_with('-') || l.starts_with(' ') || l.starts_with('\t') || t.contains(':')
    })
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() >= 2 && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\'')) {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Cuts ` # comment` from a value that is not quoted.
fn strip_yaml_comment(s: &str) -> &str {
    if s.starts_with('"') || s.starts_with('\'') {
        return s;
    }
    match s.find(" #") {
        Some(i) => s[..i].trim_end(),
        None => s,
    }
}

/// Splits `a, "b, c", d` at the commas that are not quoted.
fn split_inline_list(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                ',' => {
                    out.push(std::mem::take(&mut cur));
                }
                _ => cur.push(c),
            },
        }
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect()
}
