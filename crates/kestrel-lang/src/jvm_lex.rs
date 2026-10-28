//! Lexer and token helpers shared by the Kotlin and Java parsers.
//!
//! The lexer reads the whole file once and makes a flat list of small tokens.
//! It skips comments and white space. Strings become one `Str` token, except
//! Kotlin templates: the code inside `${...}` and the name in `$name` become
//! normal tokens between two `Str` tokens, so the parsers see that code.
//! Positions are byte offsets. Every token starts and ends at a char boundary.

use crate::model::{IdentHit, UsageKind};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum K {
    /// Identifier or keyword.
    Ident,
    /// Kotlin name in backticks. The range does not include the backticks.
    Tick,
    Num,
    Str,
    Char,
    /// One punctuation byte, see `Tok::ch`.
    P,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Tok {
    pub start: u32,
    pub end: u32,
    pub kind: K,
    pub ch: u8,
    /// A line break comes between the previous token and this one.
    pub nl: bool,
}

// What a parser knows about the use of one identifier token.
pub(crate) const R_NONE: u8 = 0;
pub(crate) const R_DECL: u8 = 1;
pub(crate) const R_IMPORT: u8 = 2;
pub(crate) const R_SUPER: u8 = 3;
pub(crate) const R_INST: u8 = 4;
pub(crate) const R_TYPE: u8 = 5;
pub(crate) const R_CALL: u8 = 6;
pub(crate) const R_REF: u8 = 7;
/// Not a use of a name: modifiers, keywords, package names.
pub(crate) const R_SKIP: u8 = 8;

#[inline]
fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$' || c >= 0x80
}

#[inline]
fn is_ident_cont(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

const F_TRIPLE: u8 = 1;
const F_ESC: u8 = 2;

struct Lx<'a> {
    b: &'a [u8],
    toks: Vec<Tok>,
    nl: bool,
    kotlin: bool,
    depth: u32,
    /// Open `${` templates: brace depth before the `{`, and the string flags.
    tmpl: Vec<(u32, u8)>,
}

impl Lx<'_> {
    #[inline]
    fn push(&mut self, kind: K, s: usize, e: usize, ch: u8) {
        self.toks.push(Tok { start: s as u32, end: e as u32, kind, ch, nl: self.nl });
        self.nl = false;
    }

    /// Reads string text from `i` until the end of the string or a template.
    /// `seg` is where the current `Str` segment started.
    fn string_body(&mut self, mut i: usize, flags: u8, mut seg: usize) -> usize {
        let b = self.b;
        let n = b.len();
        let triple = flags & F_TRIPLE != 0;
        let esc = flags & F_ESC != 0;
        loop {
            if i >= n {
                self.push_seg(seg, n);
                return n;
            }
            match b[i] {
                b'\\' if esc => i += 2,
                b'"' => {
                    if triple {
                        if i + 2 < n && b[i + 1] == b'"' && b[i + 2] == b'"' {
                            i += 3;
                            if !esc {
                                // Kotlin raw string: extra quotes belong to the text.
                                while i < n && b[i] == b'"' {
                                    i += 1;
                                }
                            }
                            self.push_seg(seg, i);
                            return i;
                        }
                        i += 1;
                    } else {
                        i += 1;
                        self.push_seg(seg, i);
                        return i;
                    }
                }
                b'\n' if !triple => {
                    self.push_seg(seg, i);
                    return i;
                }
                b'$' if self.kotlin => {
                    if i + 1 < n && (b[i + 1].is_ascii_alphabetic() || b[i + 1] == b'_') {
                        self.push_seg(seg, i);
                        let mut j = i + 2;
                        while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                            j += 1;
                        }
                        self.push(K::Ident, i + 1, j, 0);
                        seg = j;
                        i = j;
                    } else if i + 1 < n && b[i + 1] == b'{' {
                        self.push_seg(seg, i);
                        self.tmpl.push((self.depth, flags));
                        self.depth += 1;
                        self.push(K::P, i + 1, i + 2, b'{');
                        return i + 2;
                    } else {
                        i += 1;
                    }
                }
                _ => i += 1,
            }
        }
    }

    fn push_seg(&mut self, s: usize, e: usize) {
        let e = e.min(self.b.len());
        if e > s {
            self.push(K::Str, s, e, 0);
        }
    }
}

/// Splits `text` into tokens.
pub(crate) fn lex(text: &str, kotlin: bool) -> Vec<Tok> {
    let full = text.as_bytes();
    // Token offsets are u32. Longer input is cut at a char boundary.
    let cut = if full.len() > (1 << 31) {
        let mut c = 1usize << 31;
        while c > 0 && (full[c] & 0xC0) == 0x80 {
            c -= 1;
        }
        c
    } else {
        full.len()
    };
    let b = &full[..cut];
    let n = b.len();
    let mut lx = Lx {
        b,
        toks: Vec::with_capacity(n / 5 + 16),
        nl: false,
        kotlin,
        depth: 0,
        tmpl: Vec::new(),
    };
    let mut i = 0usize;
    if b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        i = 3;
    }
    if kotlin && b[i..].starts_with(b"#!") {
        while i < n && b[i] != b'\n' {
            i += 1;
        }
    }
    while i < n {
        let c = b[i];
        match c {
            b'\n' => {
                lx.nl = true;
                i += 1;
            }
            b' ' | b'\t' | b'\r' | 0x0c => i += 1,
            b'/' => {
                let d = if i + 1 < n { b[i + 1] } else { 0 };
                if d == b'/' {
                    i += 2;
                    while i < n && b[i] != b'\n' {
                        i += 1;
                    }
                } else if d == b'*' {
                    i += 2;
                    let mut nest = 1u32;
                    while i < n {
                        let e = b[i];
                        if e == b'*' && i + 1 < n && b[i + 1] == b'/' {
                            i += 2;
                            nest -= 1;
                            if nest == 0 {
                                break;
                            }
                        } else if kotlin && e == b'/' && i + 1 < n && b[i + 1] == b'*' {
                            i += 2;
                            nest += 1;
                        } else {
                            if e == b'\n' {
                                lx.nl = true;
                            }
                            i += 1;
                        }
                    }
                } else {
                    lx.push(K::P, i, i + 1, c);
                    i += 1;
                }
            }
            b'"' => {
                let triple = i + 2 < n && b[i + 1] == b'"' && b[i + 2] == b'"';
                let start = i;
                // `""` is an empty string, not the start of a raw string.
                if triple {
                    let flags = F_TRIPLE | if kotlin { 0 } else { F_ESC };
                    i = lx.string_body(i + 3, flags, start);
                } else {
                    i = lx.string_body(i + 1, F_ESC, start);
                }
            }
            b'\'' => {
                let start = i;
                let mut j = i + 1;
                if j < n && b[j] == b'\\' {
                    j += 2;
                } else if j < n {
                    j += 1;
                    while j < n && (b[j] & 0xC0) == 0x80 {
                        j += 1;
                    }
                }
                let lim = (j + 10).min(n);
                while j < lim && b[j] != b'\'' && b[j] != b'\n' {
                    j += 1;
                }
                if j < n && b[j] == b'\'' {
                    j += 1;
                }
                let j = j.min(n);
                lx.push(K::Char, start, j, 0);
                i = j;
            }
            b'`' if kotlin => {
                let mut j = i + 1;
                while j < n && b[j] != b'`' && b[j] != b'\n' {
                    j += 1;
                }
                lx.push(K::Tick, i + 1, j, 0);
                i = if j < n && b[j] == b'`' { j + 1 } else { j };
            }
            b'{' => {
                lx.depth += 1;
                lx.push(K::P, i, i + 1, c);
                i += 1;
            }
            b'}' => {
                let closes = matches!(lx.tmpl.last(), Some(&(d, _)) if d + 1 == lx.depth);
                lx.depth = lx.depth.saturating_sub(1);
                lx.push(K::P, i, i + 1, c);
                i += 1;
                if closes {
                    let flags = lx.tmpl.pop().map(|t| t.1).unwrap_or(F_ESC);
                    i = lx.string_body(i, flags, i);
                }
            }
            c if is_ident_start(c) => {
                let mut j = i + 1;
                while j < n && is_ident_cont(b[j]) {
                    j += 1;
                }
                lx.push(K::Ident, i, j, 0);
                i = j;
            }
            b'0'..=b'9' => {
                let mut j = i + 1;
                loop {
                    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                        j += 1;
                    }
                    if j + 1 < n && b[j] == b'.' && b[j + 1].is_ascii_digit() {
                        j += 1;
                    } else {
                        break;
                    }
                }
                lx.push(K::Num, i, j, 0);
                i = j;
            }
            _ => {
                lx.push(K::P, i, i + 1, c);
                i += 1;
            }
        }
    }
    lx.toks
}

/// The tokens of one file with helpers to look at them.
pub(crate) struct Src<'a> {
    pub text: &'a str,
    pub b: &'a [u8],
    pub toks: Vec<Tok>,
    line_starts: Vec<u32>,
}

impl<'a> Src<'a> {
    pub fn new(text: &'a str, kotlin: bool, want_lines: bool) -> Src<'a> {
        let toks = lex(text, kotlin);
        let mut line_starts = Vec::new();
        if want_lines {
            line_starts.push(0u32);
            for (i, &c) in text.as_bytes().iter().enumerate() {
                if c == b'\n' && i < u32::MAX as usize {
                    line_starts.push(i as u32 + 1);
                }
            }
        }
        Src { text, b: text.as_bytes(), toks, line_starts }
    }

    #[inline]
    pub fn n(&self) -> usize {
        self.toks.len()
    }

    /// Text of token `i`. Empty when `i` is out of range.
    pub fn tx(&self, i: usize) -> &'a str {
        let text: &'a str = self.text;
        match self.toks.get(i) {
            Some(t) => text.get(t.start as usize..t.end as usize).unwrap_or(""),
            None => "",
        }
    }

    #[inline]
    pub fn is_word(&self, i: usize) -> bool {
        matches!(self.toks.get(i), Some(t) if t.kind == K::Ident || t.kind == K::Tick)
    }

    #[inline]
    pub fn is_id(&self, i: usize) -> bool {
        matches!(self.toks.get(i), Some(t) if t.kind == K::Ident)
    }

    #[inline]
    pub fn is_p(&self, i: usize, c: u8) -> bool {
        matches!(self.toks.get(i), Some(t) if t.kind == K::P && t.ch == c)
    }

    /// An identifier (not in backticks) with this text.
    #[inline]
    pub fn id_is(&self, i: usize, s: &str) -> bool {
        self.is_id(i) && self.tx(i) == s
    }

    #[inline]
    pub fn nl(&self, i: usize) -> bool {
        matches!(self.toks.get(i), Some(t) if t.nl)
    }

    /// Token `i` and `i + 1` touch each other.
    #[inline]
    pub fn adj(&self, i: usize) -> bool {
        match (self.toks.get(i), self.toks.get(i + 1)) {
            (Some(a), Some(b)) => a.end == b.start,
            _ => false,
        }
    }

    /// `->` at `i`.
    pub fn arrow(&self, i: usize) -> bool {
        self.is_p(i, b'-') && self.is_p(i + 1, b'>') && self.adj(i)
    }

    /// `::` at `i`.
    pub fn dcolon(&self, i: usize) -> bool {
        self.is_p(i, b':') && self.is_p(i + 1, b':') && self.adj(i)
    }

    /// A single `:` at `i` (not part of `::`).
    pub fn colon1(&self, i: usize) -> bool {
        self.is_p(i, b':') && !self.dcolon(i) && !(i > 0 && self.dcolon(i - 1))
    }

    fn match_pair(&self, open: usize, o: u8, c: u8) -> usize {
        let mut depth = 0i64;
        let mut j = open;
        let n = self.toks.len();
        while j < n {
            let t = &self.toks[j];
            if t.kind == K::P {
                if t.ch == o {
                    depth += 1;
                } else if t.ch == c {
                    depth -= 1;
                    if depth <= 0 {
                        return j;
                    }
                }
            }
            j += 1;
        }
        n
    }

    /// Index of the `}` that closes the `{` at `open`, or the token count.
    pub fn match_brace(&self, open: usize) -> usize {
        self.match_pair(open, b'{', b'}')
    }

    pub fn match_paren(&self, open: usize) -> usize {
        self.match_pair(open, b'(', b')')
    }

    pub fn match_bracket(&self, open: usize) -> usize {
        self.match_pair(open, b'[', b']')
    }

    /// `<` at `i` may open type arguments. Returns the index after the
    /// matching `>`. Only names, dots, commas, `?`, `*`, brackets and nested
    /// `<>` are allowed, so a comparison like `a < b && c > d` does not match.
    pub fn try_type_args(&self, i: usize) -> Option<usize> {
        if !self.is_p(i, b'<') {
            return None;
        }
        let n = self.toks.len();
        let mut depth = 0i32;
        let mut j = i;
        while j < n && j - i < 80 {
            let t = &self.toks[j];
            match t.kind {
                K::Ident | K::Tick => {}
                K::P => match t.ch {
                    b'<' => depth += 1,
                    b'>' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    b',' | b'.' | b'?' | b'*' | b'[' | b']' => {}
                    _ => return None,
                },
                _ => return None,
            }
            j += 1;
        }
        None
    }

    /// Line and column (both 1-based, column in bytes) of a byte offset.
    pub fn lc_off(&self, off: usize) -> (u32, u32) {
        if self.line_starts.is_empty() {
            return (0, 0);
        }
        let off = off.min(u32::MAX as usize) as u32;
        let idx = self.line_starts.partition_point(|&s| s <= off);
        let line = idx.max(1);
        let start = self.line_starts[line - 1];
        (line as u32, off - start + 1)
    }

    pub fn lc(&self, tok: usize) -> (u32, u32) {
        match self.toks.get(tok) {
            Some(t) => self.lc_off(t.start as usize),
            None => (0, 0),
        }
    }

    /// Line where token `pos - 1` ends: the last line that a declaration has
    /// read when the cursor is at `pos`.
    pub fn last_line(&self, pos: usize) -> u32 {
        match pos.checked_sub(1).and_then(|i| self.toks.get(i)) {
            Some(t) => self.lc_off((t.end as usize).saturating_sub(1)).0,
            None => 0,
        }
    }

    pub fn line(&self, tok: usize) -> u32 {
        self.lc(tok).0
    }

    /// Text from the start of token `a` to the end of token `b` (inclusive),
    /// with white space made single.
    pub fn span_text(&self, a: usize, b: usize) -> String {
        match (self.toks.get(a), self.toks.get(b)) {
            (Some(x), Some(y)) if y.end >= x.start => {
                let s = self.text.get(x.start as usize..y.end as usize).unwrap_or("");
                norm_ws(s)
            }
            _ => String::new(),
        }
    }

    /// `>` at `gt` closes type arguments that follow a `.`. Returns that `.`.
    fn generic_dot(&self, gt: usize) -> Option<usize> {
        let mut depth = 0i32;
        let mut j = gt;
        let lo = gt.saturating_sub(60);
        loop {
            if self.is_p(j, b'>') {
                depth += 1;
            } else if self.is_p(j, b'<') {
                depth -= 1;
                if depth == 0 {
                    return if j >= 1 && self.is_p(j - 1, b'.') { Some(j - 1) } else { None };
                }
            }
            if j == lo {
                return None;
            }
            j -= 1;
        }
    }

    /// The dotted name in front of token `i`: `a.b` for `a.b.Foo`. Empty when
    /// nothing comes before or when the part before is not a plain name.
    fn qualifier(&self, i: usize) -> String {
        let mut words: [usize; 12] = [0; 12];
        let mut cnt = 0usize;
        let mut j = i;
        loop {
            // Find the separator in front of token j.
            let sep = if j >= 1 && self.is_p(j - 1, b'.') {
                Some(j - 1)
            } else if j >= 1 && self.is_p(j - 1, b'>') {
                // Explicit type arguments: `Collections.<Foo>emptyList()`.
                self.generic_dot(j - 1)
            } else if j >= 2 && self.dcolon(j - 2) {
                Some(j - 2)
            } else {
                None
            };
            let Some(k) = sep else { break };
            let mut m = k;
            // Safe call `?.`.
            if self.is_p(k, b'.') && m >= 1 && self.is_p(m - 1, b'?') && self.adj(m - 1) {
                m -= 1;
            }
            if m >= 1 && self.is_word(m - 1) {
                if cnt < words.len() {
                    words[cnt] = m - 1;
                    cnt += 1;
                } else {
                    break;
                }
                j = m - 1;
            } else {
                return String::new();
            }
        }
        let mut out = String::new();
        for w in words[..cnt].iter().rev() {
            if !out.is_empty() {
                out.push('.');
            }
            out.push_str(self.tx(*w));
        }
        out
    }
}

/// Makes every run of white space one space.
pub(crate) fn norm_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut sp = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            sp = true;
        } else {
            if sp && !out.is_empty() {
                out.push(' ');
            }
            sp = false;
            out.push(ch);
        }
    }
    out
}

#[inline]
pub(crate) fn is_upper_start(s: &str) -> bool {
    matches!(s.chars().next(), Some(c) if c.is_uppercase())
}

/// `MAX_SIZE`: only upper-case letters, digits and underscores, two or more.
pub(crate) fn is_const_name(s: &str) -> bool {
    s.len() >= 2 && s.chars().all(|c| c.is_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Makes the hit list for one name from the roles that a parser set.
pub(crate) fn collect_hits(src: &Src, roles: &[u8], name: &str) -> Vec<IdentHit> {
    let nb = name.as_bytes();
    let mut out = Vec::new();
    for (i, t) in src.toks.iter().enumerate() {
        if (t.kind != K::Ident && t.kind != K::Tick) || (t.end - t.start) as usize != nb.len() {
            continue;
        }
        if src.b.get(t.start as usize..t.end as usize) != Some(nb) {
            continue;
        }
        let r = roles.get(i).copied().unwrap_or(R_NONE);
        let kind = match r {
            R_SKIP => continue,
            R_DECL => UsageKind::Declaration,
            R_IMPORT => UsageKind::Import,
            R_SUPER => UsageKind::Supertype,
            R_INST => UsageKind::Instantiation,
            R_TYPE => UsageKind::Type,
            R_CALL => UsageKind::Call,
            _ => UsageKind::Reference,
        };
        out.push(IdentHit {
            start: t.start as usize,
            end: t.end as usize,
            kind,
            qualifier: src.qualifier(i),
        });
    }
    out
}
