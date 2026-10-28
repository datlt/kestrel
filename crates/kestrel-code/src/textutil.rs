//! Text helpers: UTF-16 columns and cut line text (like `kestrel-search`).

use kestrel_lang::FileModel;

/// A line is cut to this many characters around the match.
pub const MAX_LINE_CHARS: usize = 300;
/// How many characters before the match stay when a line is cut.
pub const CONTEXT_BEFORE: usize = 40;

pub fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() { s.len() as u32 } else { s.encode_utf16().count() as u32 }
}

/// Reads a file as text. Invalid UTF-8 is replaced. A BOM at the start is removed,
/// so the columns match the ones in the editor.
pub fn decode(bytes: Vec<u8>) -> String {
    let mut s = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    if s.starts_with('\u{feff}') {
        s.drain(..'\u{feff}'.len_utf8());
    }
    s
}

/// Byte offsets of the start of each line.
pub fn line_starts(text: &str) -> Vec<usize> {
    let mut v = vec![0];
    v.extend(memchr::memchr_iter(b'\n', text.as_bytes()).map(|i| i + 1));
    v
}

/// The text of line `line` (1-based) without the line break.
pub fn line_text(text: &str, line: u32) -> Option<&str> {
    let mut start = 0usize;
    for _ in 1..line {
        let i = memchr::memchr(b'\n', &text.as_bytes()[start..])?;
        start += i + 1;
    }
    let rest = &text[start..];
    let end = memchr::memchr(b'\n', rest.as_bytes()).unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches('\r'))
}

/// Byte offset in `line` of a 1-based UTF-16 column. Clamped to the line length.
pub fn byte_of_col16(line: &str, col: u32) -> usize {
    if line.is_ascii() {
        return ((col.max(1) - 1) as usize).min(line.len());
    }
    let mut units = 0u32;
    let want = col.max(1) - 1;
    for (i, c) in line.char_indices() {
        if units >= want {
            return i;
        }
        units += c.len_utf16() as u32;
    }
    line.len()
}

/// 1-based UTF-16 column of a byte offset in a line.
pub fn col16_of_byte(line: &str, byte: usize) -> u32 {
    let mut b = byte.min(line.len());
    while !line.is_char_boundary(b) {
        b -= 1;
    }
    utf16_len(&line[..b]) + 1
}

/// The parsers count columns in bytes. This changes them to UTF-16 units.
/// Files with only ASCII need no change.
pub fn fix_columns(model: &mut FileModel, text: &str) {
    if text.is_ascii() {
        return;
    }
    let starts = line_starts(text);
    let fix = |line: u32, col: &mut u32| {
        let Some(&s) = starts.get((line as usize).wrapping_sub(1)) else { return };
        let e = starts.get(line as usize).copied().unwrap_or(text.len());
        let l = &text[s..e];
        *col = col16_of_byte(l, (*col as usize).saturating_sub(1));
    };
    for t in &mut model.types {
        fix(t.line, &mut t.column);
        for m in t.fields.iter_mut().chain(t.methods.iter_mut()) {
            fix(m.line, &mut m.column);
        }
    }
    for m in &mut model.top_level {
        fix(m.line, &mut m.column);
    }
}

/// Where a match is: the 1-based line, the shown text, the range in it and the
/// UTF-16 units that were cut from the start of the line.
pub struct Shown {
    pub line: u32,
    pub text: String,
    pub range: [u32; 2],
    pub offset: u32,
}

/// Cuts the line around the match like `kestrel-search`: no leading white
/// space, at most 300 characters, 40 characters before the match.
/// `line_no` is the 1-based line of `line_start`. `start`/`end` are byte
/// offsets in `text`.
pub fn show_match(text: &str, line_no: u32, line_start: usize, start: usize, end: usize) -> Shown {
    let rest = &text[line_start..];
    let le = memchr::memchr(b'\n', rest.as_bytes()).unwrap_or(rest.len());
    let line = rest[..le].trim_end_matches('\r');
    let first = (start - line_start).min(line.len());
    let last = (end - line_start).min(line.len()).max(first);
    let lead = (line.len() - line.trim_start().len()).min(first);
    let mut begin = lead;
    let mut stop = line.len();
    if line.len() - lead > MAX_LINE_CHARS && line[lead..].chars().count() > MAX_LINE_CHARS {
        begin = line[lead..first]
            .char_indices()
            .rev()
            .nth(CONTEXT_BEFORE - 1)
            .map_or(lead, |(i, _)| lead + i);
        stop = line[begin..].char_indices().nth(MAX_LINE_CHARS).map_or(line.len(), |(i, _)| begin + i);
    }
    let offset = utf16_len(&line[..begin]);
    let s16 = utf16_len(&line[begin..first]);
    let e16 = s16 + utf16_len(&line[first..last.min(stop)]);
    Shown { line: line_no, text: line[begin..stop].to_owned(), range: [s16, e16], offset }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

/// FNV-1a hash of one word.
pub fn word_hash(word: &[u8]) -> u32 {
    let mut h: u32 = 2166136261;
    for &b in word {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    h
}

/// Sorted, unique hashes of all words in the bytes (comments and strings
/// included). The search uses it to skip files that cannot hold a name.
pub fn word_hashes(bytes: &[u8]) -> Box<[u32]> {
    let mut v: Vec<u32> = Vec::with_capacity(bytes.len() / 16);
    let mut i = 0;
    while i < bytes.len() {
        if is_word_byte(bytes[i]) {
            let s = i;
            let mut h: u32 = 2166136261;
            while i < bytes.len() && is_word_byte(bytes[i]) {
                h = (h ^ bytes[i] as u32).wrapping_mul(16777619);
                i += 1;
            }
            // One-letter words and numbers are never searched for names we index.
            if i - s > 1 {
                v.push(h);
            }
        } else {
            i += 1;
        }
    }
    v.sort_unstable();
    v.dedup();
    v.into_boxed_slice()
}

/// May a file with these word hashes hold `name`? An empty list means unknown.
pub fn may_hold(words: &[u32], name: &str) -> bool {
    words.is_empty() || name.len() < 2 || words.binary_search(&word_hash(name.as_bytes())).is_ok()
}

pub fn is_ident_char(c: char) -> bool {
    c == '_' || c == '$' || c.is_alphanumeric()
}

/// The identifier around a 1-based UTF-16 column: byte range in the line.
/// A cursor right after the name counts too.
pub fn ident_range(line: &str, col: u32) -> Option<(usize, usize)> {
    let b = byte_of_col16(line, col);
    let is_at = |i: usize| line[i..].chars().next().is_some_and(is_ident_char);
    let pos = if b < line.len() && is_at(b) {
        b
    } else {
        let (p, c) = line[..b].char_indices().last()?;
        if !is_ident_char(c) {
            return None;
        }
        p
    };
    let mut s = pos;
    while let Some((p, c)) = line[..s].char_indices().last() {
        if is_ident_char(c) { s = p } else { break }
    }
    let mut e = pos;
    while let Some(c) = line[e..].chars().next() {
        if is_ident_char(c) { e += c.len_utf8() } else { break }
    }
    Some((s, e))
}

/// The dotted name before `start` (`a.b` for `a.b.Foo`), without the last dot.
pub fn qualifier_before(line: &str, start: usize) -> &str {
    let head = &line[..start];
    if !head.ends_with('.') {
        return "";
    }
    let head = &head[..head.len() - 1];
    let mut s = head.len();
    while let Some((p, c)) = head[..s].char_indices().last() {
        if is_ident_char(c) || c == '.' { s = p } else { break }
    }
    head[s..].trim_start_matches('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_columns() {
        let l = "a😀b";
        assert_eq!(col16_of_byte(l, 5), 4);
        assert_eq!(byte_of_col16(l, 4), 5);
        assert_eq!(byte_of_col16(l, 3), 5);
    }

    #[test]
    fn cut_long_line() {
        let long = format!("    {}Foo{}", "x ".repeat(200), "y ".repeat(200));
        let start = long.find("Foo").unwrap();
        let s = show_match(&long, 1, 0, start, start + 3);
        assert!(s.text.chars().count() <= MAX_LINE_CHARS);
        assert_eq!(&s.text[s.range[0] as usize..s.range[1] as usize], "Foo");
        assert_eq!(s.range[0] as usize, CONTEXT_BEFORE);
        assert_eq!(s.offset as usize + s.range[0] as usize + 1, start + 1);
    }

    #[test]
    fn leading_space_removed() {
        let t = "x\n    foo bar\r\n";
        let s = show_match(t, 2, 2, 6, 9);
        assert_eq!(s.text, "foo bar");
        assert_eq!(s.range, [0, 3]);
        assert_eq!(s.offset, 4);
    }
}

#[cfg(test)]
mod ident_tests {
    use super::*;

    #[test]
    fn word_hashes_are_sorted_unique_and_match_names() {
        let w = word_hashes("class Foo { val fooBar = Foo(); // Foo\n é 日本 x $y }".as_bytes());
        assert!(w.windows(2).all(|p| p[0] < p[1]));
        assert!(may_hold(&w, "Foo") && may_hold(&w, "fooBar") && may_hold(&w, "$y") && may_hold(&w, "日本"));
        assert!(!may_hold(&w, "Bar"));
        assert!(may_hold(&w, "x"), "short names are never skipped");
        assert!(may_hold(&[], "Anything"), "an empty list means unknown");
    }

    #[test]
    fn finds_identifier_and_qualifier() {
        let l = "    repo.save(x)";
        let (s, e) = ident_range(l, 11).unwrap();
        assert_eq!(&l[s..e], "save");
        assert_eq!(qualifier_before(l, s), "repo");
        let (s, e) = ident_range(l, 14).unwrap();
        assert_eq!(&l[s..e], "save");
        assert!(ident_range(l, 10).map(|(s, e)| &l[s..e] == "repo" || &l[s..e] == "save").unwrap());
        assert!(ident_range("a  b", 3).is_none());
        let l = "val x = a.b.Foo()";
        let (s, _) = ident_range(l, 14).unwrap();
        assert_eq!(qualifier_before(l, s), "a.b");
    }
}
