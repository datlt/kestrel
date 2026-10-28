//! Swift lexer. One pass over the bytes. It gives a flat list of tokens.
//!
//! Comments and white space are dropped. Strings are one token per piece:
//! a string with `\(...)` gives a `STR` token, then the tokens of the code
//! inside, then the next `STR` token. So code in a string is real code.
//! Every token boundary is a UTF-8 boundary: bytes of 0x80 and above are
//! treated as part of a name.

pub(super) const IDENT: u8 = 0;
/// A name in backticks. The token range is the name without the backticks.
pub(super) const BTICK: u8 = 1;
pub(super) const NUM: u8 = 2;
/// A piece of a string literal.
pub(super) const STR: u8 = 3;
/// One punctuation or operator byte. `->` is `ARROW` instead.
pub(super) const PUNCT: u8 = 4;
pub(super) const ARROW: u8 = 5;
pub(super) const REGEX: u8 = 6;
pub(super) const EOF: u8 = 255;

#[derive(Clone, Copy, Debug)]
pub(super) struct Tok {
    pub kind: u8,
    /// A line break comes between the previous token and this one.
    pub nl: bool,
    /// First byte of the token.
    pub c: u8,
    pub start: u32,
    pub end: u32,
    pub line: u32,
    /// 1-based column in bytes.
    pub col: u32,
}

const fn make_table() -> [u8; 256] {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let c = i as u8;
        let start = c.is_ascii_alphabetic() || c == b'_' || c == b'$' || c >= 0x80;
        let cont = start || c.is_ascii_digit();
        t[i] = (start as u8) | ((cont as u8) << 1);
        i += 1;
    }
    t
}

static TABLE: [u8; 256] = make_table();

#[inline]
fn ident_start(c: u8) -> bool {
    TABLE[c as usize] & 1 != 0
}

#[inline]
fn ident_cont(c: u8) -> bool {
    TABLE[c as usize] & 2 != 0
}

struct Interp {
    hashes: usize,
    multi: bool,
    depth: u32,
}

struct Lx<'a> {
    b: &'a [u8],
    n: usize,
    i: usize,
    line: u32,
    /// Byte index where the current line starts.
    ls: usize,
    nl: bool,
    out: Vec<Tok>,
    stack: Vec<Interp>,
    /// Comment ranges. Only filled when `want` is set.
    comments: Vec<(u32, u32)>,
    want: bool,
}

pub(super) fn lex(src: &str) -> Vec<Tok> {
    lex_all(src, false).0
}

/// Like `lex`, and also gives the byte ranges of all comments.
pub(super) fn lex_with_comments(src: &str) -> (Vec<Tok>, Vec<(u32, u32)>) {
    lex_all(src, true)
}

fn lex_all(src: &str, want: bool) -> (Vec<Tok>, Vec<(u32, u32)>) {
    let b = src.as_bytes();
    // Positions are u32 in tokens. Longer input is cut.
    let n = b.len().min(u32::MAX as usize - 1);
    let mut lx = Lx {
        b,
        n,
        i: 0,
        line: 1,
        ls: 0,
        nl: false,
        out: Vec::with_capacity(n / 5 + 16),
        stack: Vec::new(),
        comments: Vec::new(),
        want,
    };
    lx.run();
    (lx.out, lx.comments)
}

impl<'a> Lx<'a> {
    #[inline]
    fn push(&mut self, kind: u8, start: usize, end: usize, line: u32, col: u32) {
        let c = self.b.get(start).copied().unwrap_or(0);
        self.out.push(Tok {
            kind,
            nl: self.nl,
            c,
            start: start as u32,
            end: end as u32,
            line,
            col,
        });
        self.nl = false;
    }

    #[inline]
    fn col_at(&self, pos: usize) -> u32 {
        (pos.saturating_sub(self.ls) + 1) as u32
    }

    fn run(&mut self) {
        let b = self.b;
        let n = self.n;
        if b.starts_with(&[0xEF, 0xBB, 0xBF]) {
            self.i = 3;
            self.ls = 3;
        }
        if b[self.i.min(n)..n].starts_with(b"#!") {
            while self.i < n && b[self.i] != b'\n' {
                self.i += 1;
            }
        }
        while self.i < n {
            let c = b[self.i];
            match c {
                b'\n' => {
                    self.i += 1;
                    self.line += 1;
                    self.ls = self.i;
                    self.nl = true;
                }
                b' ' | b'\t' | b'\r' | 0x0b | 0x0c | 0 => self.i += 1,
                b'/' => self.slash(),
                b'"' => self.string_start(self.i, self.i, 0),
                b'#' => self.hash(),
                b'`' => self.backtick(),
                b'0'..=b'9' => self.number(),
                b'-' if self.i + 1 < n && b[self.i + 1] == b'>' => {
                    let (l, c) = (self.line, self.col_at(self.i));
                    self.push(ARROW, self.i, self.i + 2, l, c);
                    self.i += 2;
                }
                b'(' => {
                    if let Some(t) = self.stack.last_mut() {
                        t.depth += 1;
                    }
                    self.punct();
                }
                b')' => {
                    let mut resume = None;
                    if let Some(t) = self.stack.last_mut() {
                        if t.depth == 0 {
                            resume = Some((t.hashes, t.multi));
                        } else {
                            t.depth -= 1;
                        }
                    }
                    if let Some((h, m)) = resume {
                        self.stack.pop();
                        self.i += 1;
                        let (l, c) = (self.line, self.col_at(self.i));
                        self.string_body(h, m, self.i, l, c);
                    } else {
                        self.punct();
                    }
                }
                _ if ident_start(c) => self.ident(),
                _ => self.punct(),
            }
        }
    }

    #[inline]
    fn punct(&mut self) {
        let (l, c) = (self.line, self.col_at(self.i));
        self.push(PUNCT, self.i, self.i + 1, l, c);
        self.i += 1;
    }

    fn ident(&mut self) {
        let b = self.b;
        let start = self.i;
        let mut j = start + 1;
        while j < self.n && ident_cont(b[j]) {
            j += 1;
        }
        let (l, c) = (self.line, self.col_at(start));
        self.push(IDENT, start, j, l, c);
        self.i = j;
    }

    fn backtick(&mut self) {
        let b = self.b;
        let start = self.i;
        let mut j = start + 1;
        while j < self.n && ident_cont(b[j]) {
            j += 1;
        }
        if j < self.n && b[j] == b'`' && j > start + 1 {
            let (l, c) = (self.line, self.col_at(start + 1));
            self.push(BTICK, start + 1, j, l, c);
            self.i = j + 1;
        } else {
            self.punct();
        }
    }

    fn number(&mut self) {
        let b = self.b;
        let n = self.n;
        let start = self.i;
        let hex = b[start] == b'0' && matches!(b.get(start + 1), Some(b'x') | Some(b'X'));
        let mut j = start + 1;
        while j < n {
            let c = b[j];
            if c.is_ascii_alphanumeric() || c == b'_' {
                if (c == b'e' || c == b'E')
                    && !hex
                    && matches!(b.get(j + 1), Some(b'+') | Some(b'-'))
                    && b.get(j + 2).is_some_and(|x| x.is_ascii_digit())
                {
                    j += 2;
                } else {
                    j += 1;
                }
            } else if c == b'.' && b.get(j + 1).is_some_and(|x| x.is_ascii_digit()) {
                j += 1;
            } else {
                break;
            }
        }
        let (l, c) = (self.line, self.col_at(start));
        self.push(NUM, start, j, l, c);
        self.i = j;
    }

    fn slash(&mut self) {
        let b = self.b;
        let n = self.n;
        let i = self.i;
        match b.get(i + 1) {
            Some(b'/') => {
                let mut j = i + 2;
                while j < n && b[j] != b'\n' {
                    j += 1;
                }
                if self.want {
                    self.comments.push((i as u32, j as u32));
                }
                self.i = j;
            }
            Some(b'*') => {
                let mut depth = 1u32;
                let mut j = i + 2;
                while j < n {
                    match b[j] {
                        b'/' if b.get(j + 1) == Some(&b'*') => {
                            depth += 1;
                            j += 2;
                        }
                        b'*' if b.get(j + 1) == Some(&b'/') => {
                            depth -= 1;
                            j += 2;
                            if depth == 0 {
                                break;
                            }
                        }
                        b'\n' => {
                            self.line += 1;
                            self.ls = j + 1;
                            self.nl = true;
                            j += 1;
                        }
                        _ => j += 1,
                    }
                }
                self.i = j.min(n);
                if self.want {
                    self.comments.push((i as u32, self.i as u32));
                }
            }
            _ => {
                if self.regex_allowed() {
                    if let Some(end) = self.find_slash_regex(i) {
                        let (l, c) = (self.line, self.col_at(i));
                        self.push(REGEX, i, end, l, c);
                        self.i = end;
                        return;
                    }
                }
                self.punct();
            }
        }
    }

    /// A `/` can start a regex literal when the last token cannot end an operand.
    fn regex_allowed(&self) -> bool {
        let Some(p) = self.out.last() else {
            return true;
        };
        match p.kind {
            IDENT => {
                let s = self.b.get(p.start as usize..p.end as usize).unwrap_or(b"");
                matches!(s, b"return" | b"in" | b"case" | b"where" | b"try" | b"await")
            }
            PUNCT => !matches!(p.c, b')' | b']' | b'}' | b'?' | b'!' | b'>' | b'.'),
            ARROW => true,
            _ => false,
        }
    }

    /// Looks for the closing `/` of a one line regex that starts at `i`.
    fn find_slash_regex(&self, i: usize) -> Option<usize> {
        let b = self.b;
        let first = *b.get(i + 1)?;
        if matches!(first, b' ' | b'\t' | b'\n' | b'\r' | b'=') {
            return None;
        }
        let mut j = i + 1;
        let mut class = false;
        while j < self.n {
            match b[j] {
                b'\n' => return None,
                b'\\' => j += 1,
                b'[' => class = true,
                b']' => class = false,
                b'/' if !class => {
                    if j > i + 1 {
                        return Some(j + 1);
                    }
                    return None;
                }
                _ => {}
            }
            j += 1;
        }
        None
    }

    fn hash(&mut self) {
        let b = self.b;
        let n = self.n;
        let i = self.i;
        let mut k = i;
        while k < n && b[k] == b'#' {
            k += 1;
        }
        let h = k - i;
        if k < n && b[k] == b'"' {
            self.string_start(i, k, h);
            return;
        }
        if k < n && b[k] == b'/' {
            if let Some(end) = self.find_ext_regex(k, h) {
                let (l, c) = (self.line, self.col_at(i));
                // Count the lines inside, for a multi line regex.
                let mut j = i;
                let mut ls = self.ls;
                let mut line = self.line;
                while j < end {
                    if b[j] == b'\n' {
                        line += 1;
                        ls = j + 1;
                    }
                    j += 1;
                }
                self.push(REGEX, i, end, l, c);
                self.line = line;
                self.ls = ls;
                self.i = end;
                return;
            }
        }
        if h == 1 && k < n && ident_start(b[k]) {
            let mut e = k;
            while e < n && ident_cont(b[e]) {
                e += 1;
            }
            if matches!(
                &b[k..e],
                b"if" | b"elseif" | b"else" | b"endif" | b"warning" | b"error" | b"sourceLocation"
            ) {
                // Both branches of `#if` are code. The condition is skipped.
                while e < n && b[e] != b'\n' {
                    e += 1;
                }
                self.i = e;
                return;
            }
        }
        self.punct();
    }

    /// `#/ ... /#`. It ends on the same line, unless the text after `#/` is a line break.
    fn find_ext_regex(&self, slash: usize, h: usize) -> Option<usize> {
        let b = self.b;
        let n = self.n;
        let multi = matches!(b.get(slash + 1), Some(b'\n') | Some(b'\r'));
        let mut j = slash + 1;
        while j < n {
            let c = b[j];
            if c == b'\n' && !multi {
                return None;
            }
            if c == b'\\' {
                j += 2;
                continue;
            }
            if c == b'/' {
                let mut m = 0;
                while m < h && b.get(j + 1 + m) == Some(&b'#') {
                    m += 1;
                }
                if m == h {
                    return Some(j + 1 + h);
                }
            }
            j += 1;
        }
        None
    }

    /// `start` is the first `#` (or the quote), `q` is the index of the first quote.
    fn string_start(&mut self, start: usize, q: usize, hashes: usize) {
        let b = self.b;
        let multi = b.get(q..q + 3) == Some(&b"\"\"\""[..]);
        let body = if multi { q + 3 } else { q + 1 };
        let (l, c) = (self.line, self.col_at(start));
        self.i = body.min(self.n);
        self.string_body(hashes, multi, start, l, c);
    }

    /// Scans a string from `self.i` to its end or to the next `\(`.
    /// Pushes one `STR` token for the piece.
    fn string_body(&mut self, hashes: usize, multi: bool, pstart: usize, pl: u32, pc: u32) {
        let b = self.b;
        let n = self.n;
        let mut i = self.i;
        loop {
            if i >= n {
                self.i = n;
                self.push(STR, pstart, n, pl, pc);
                return;
            }
            match b[i] {
                b'\n' => {
                    if !multi {
                        // An unclosed one line string ends at the line break.
                        self.i = i;
                        self.push(STR, pstart, i, pl, pc);
                        return;
                    }
                    i += 1;
                    self.line += 1;
                    self.ls = i;
                }
                b'\\' => {
                    let mut k = i + 1;
                    let mut h = 0;
                    while h < hashes && k < n && b[k] == b'#' {
                        k += 1;
                        h += 1;
                    }
                    if h == hashes {
                        if k < n && b[k] == b'(' {
                            self.push(STR, pstart, i, pl, pc);
                            self.stack.push(Interp {
                                hashes,
                                multi,
                                depth: 0,
                            });
                            self.i = k + 1;
                            return;
                        }
                        if k < n {
                            if b[k] == b'\n' {
                                self.line += 1;
                                self.ls = k + 1;
                            }
                            i = k + 1;
                        } else {
                            i = k;
                        }
                    } else {
                        i = k;
                    }
                }
                b'"' => {
                    let q = if multi { 3 } else { 1 };
                    let mut ok = true;
                    for m in 0..q {
                        if b.get(i + m) != Some(&b'"') {
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        for m in 0..hashes {
                            if b.get(i + q + m) != Some(&b'#') {
                                ok = false;
                                break;
                            }
                        }
                    }
                    if ok {
                        let end = i + q + hashes;
                        self.i = end;
                        self.push(STR, pstart, end, pl, pc);
                        return;
                    }
                    i += 1;
                }
                _ => i += 1,
            }
        }
    }
}
