//! Swift declaration parser. It reads the token list from `lex.rs`.
//! It reads types and their members and skips the code inside bodies.
//! The type grammar (`parse_type`) is also used by `idents.rs`, with
//! `build` set to false, so that it does not allocate.

use super::lex::*;
use crate::model::*;
use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
pub(super) struct Fx(u64);

impl Hasher for Fx {
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

#[derive(Default)]
struct Used<'a> {
    set: HashSet<&'a str, BuildHasherDefault<Fx>>,
    order: Vec<&'a str>,
}

/// Where the items are: the owner type and the default visibility of its members.
#[derive(Clone, Copy)]
struct Ctx {
    owner: Option<usize>,
    kind: Option<TypeKind>,
    vis: Visibility,
    case_vis: Visibility,
}

const MAX_NEST: u32 = 100;

pub(super) struct Parser<'a> {
    pub src: &'a str,
    pub t: &'a [Tok],
    pub i: usize,
    /// False: do not build strings, only walk the tokens.
    pub build: bool,
    tdepth: u32,
    ndepth: u32,
    model: FileModel,
    used: Vec<Used<'a>>,
}

pub(super) fn is_modifier_word(s: &str) -> bool {
    matches!(
        s,
        "public"
            | "private"
            | "fileprivate"
            | "internal"
            | "open"
            | "package"
            | "final"
            | "static"
            | "override"
            | "mutating"
            | "nonmutating"
            | "lazy"
            | "weak"
            | "unowned"
            | "indirect"
            | "convenience"
            | "required"
            | "dynamic"
            | "optional"
            | "prefix"
            | "postfix"
            | "infix"
            | "nonisolated"
            | "isolated"
            | "distributed"
            | "consuming"
            | "borrowing"
    )
}

/// True when `class` is a modifier (`class func`) and not a declaration (`class Foo`).
pub(super) fn class_is_modifier(next: &str) -> bool {
    matches!(next, "func" | "var" | "let" | "subscript") || is_modifier_word(next)
}

fn vis_from(mods: &[String]) -> Option<Visibility> {
    let mut v = None;
    for m in mods {
        match m.as_str() {
            "public" | "open" => v = Some(Visibility::Public),
            "private" | "fileprivate" => v = Some(Visibility::Private),
            "internal" | "package" => v = Some(Visibility::Internal),
            _ => {}
        }
    }
    v
}

fn normalize_ws(s: &str) -> String {
    let b = s.as_bytes();
    let mut clean = true;
    let mut prev_space = false;
    for &c in b {
        if c == b' ' {
            if prev_space {
                clean = false;
                break;
            }
            prev_space = true;
        } else {
            if matches!(c, b'\n' | b'\t' | b'\r') {
                clean = false;
                break;
            }
            prev_space = false;
        }
    }
    if clean {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(ch);
        }
    }
    out
}

impl<'a> Parser<'a> {
    pub fn new(src: &'a str, t: &'a [Tok], build: bool) -> Self {
        Parser {
            src,
            t,
            i: 0,
            build,
            tdepth: 0,
            ndepth: 0,
            model: FileModel::default(),
            used: Vec::new(),
        }
    }

    // ---- token helpers ----

    #[inline]
    pub fn kind(&self, i: usize) -> u8 {
        self.t.get(i).map_or(EOF, |t| t.kind)
    }

    #[inline]
    pub fn text(&self, i: usize) -> &'a str {
        match self.t.get(i) {
            Some(t) => self.src.get(t.start as usize..t.end as usize).unwrap_or(""),
            None => "",
        }
    }

    #[inline]
    pub fn punct(&self, i: usize, c: u8) -> bool {
        self.t.get(i).is_some_and(|t| t.kind == PUNCT && t.c == c)
    }

    /// A plain word token (not in backticks) with this text.
    #[inline]
    pub fn kw(&self, i: usize, s: &str) -> bool {
        match self.t.get(i) {
            Some(t) => t.kind == IDENT && (t.end - t.start) as usize == s.len() && self.text(i) == s,
            None => false,
        }
    }

    #[inline]
    pub fn is_id(&self, i: usize) -> bool {
        matches!(self.kind(i), IDENT | BTICK)
    }

    /// Token `i` starts exactly where token `i - 1` ends.
    #[inline]
    pub fn adj(&self, i: usize) -> bool {
        i > 0
            && match (self.t.get(i - 1), self.t.get(i)) {
                (Some(a), Some(b)) => a.end == b.start,
                _ => false,
            }
    }

    #[inline]
    fn nl(&self, i: usize) -> bool {
        self.t.get(i).is_some_and(|t| t.nl)
    }

    fn line(&self, i: usize) -> u32 {
        self.t.get(i).map_or(0, |t| t.line)
    }

    fn col(&self, i: usize) -> u32 {
        self.t.get(i).map_or(0, |t| t.col)
    }

    /// Line where the last consumed token ends (a string can span lines).
    fn prev_end_line(&self) -> u32 {
        let Some(t) = self.i.checked_sub(1).and_then(|k| self.t.get(k)) else {
            return self.t.first().map_or(1, |t| t.line);
        };
        let mut line = t.line;
        if t.kind == STR || t.kind == REGEX {
            let s = self.src.as_bytes().get(t.start as usize..t.end as usize).unwrap_or(b"");
            line += s.iter().filter(|&&c| c == b'\n').count() as u32;
        }
        line
    }

    fn last_line(&self) -> u32 {
        self.t.last().map_or(1, |t| t.line)
    }

    fn slice(&self, a: usize, b: usize) -> &'a str {
        self.src.get(a..b).unwrap_or("")
    }

    /// Source text from the start of token `a` to the end of token `b`.
    fn span(&self, a: usize, b: usize) -> &'a str {
        match (self.t.get(a), self.t.get(b)) {
            (Some(x), Some(y)) => self.slice(x.start as usize, y.end as usize),
            _ => "",
        }
    }

    // ---- skipping ----

    /// Adds the type name at token `i` to the used types of type `sink`.
    #[inline]
    fn collect(&mut self, i: usize, sink: Option<usize>) {
        let Some(s) = sink else { return };
        let t = self.t[i];
        if t.kind != IDENT || !t.c.is_ascii_uppercase() {
            return;
        }
        if i > 0 && self.punct(i - 1, b'.') {
            return;
        }
        let mut j = i;
        while self.punct(j + 1, b'.')
            && self.kind(j + 2) == IDENT
            && self.t[j + 2].c.is_ascii_uppercase()
            && self.adj(j + 1)
            && self.adj(j + 2)
        {
            j += 2;
        }
        let name = self.slice(t.start as usize, self.t[j].end as usize);
        if name == "Self" || name == "Any" || name.is_empty() {
            return;
        }
        if let Some(td) = self.model.types.get(s) {
            if td.type_params.iter().any(|p| p == name) {
                return;
            }
        }
        if let Some(u) = self.used.get_mut(s) {
            if u.set.insert(name) {
                u.order.push(name);
            }
        }
    }

    /// `self.i` is at `(`, `[` or `{`. Moves after the matching closer.
    fn skip_balanced(&mut self, sink: Option<usize>) {
        let n = self.t.len();
        let mut depth = 0i64;
        let mut i = self.i;
        while i < n {
            let t = self.t[i];
            match t.kind {
                IDENT => {
                    if sink.is_some() {
                        self.collect(i, sink);
                    }
                }
                PUNCT => match t.c {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => {
                        depth -= 1;
                        if depth <= 0 {
                            i += 1;
                            break;
                        }
                    }
                    _ => {}
                },
                _ => {}
            }
            i += 1;
        }
        self.i = i;
    }

    /// The last token of a line says that the expression goes on.
    pub fn cont_prev(&self, i: usize) -> bool {
        match self.t.get(i) {
            Some(t) => match t.kind {
                PUNCT => matches!(
                    t.c,
                    b'=' | b'+' | b'-' | b'*' | b'/' | b'%' | b'<' | b'&' | b'|' | b'^' | b',' | b'.' | b':' | b'~'
                ),
                ARROW => true,
                IDENT => matches!(self.text(i), "as" | "is" | "try" | "await"),
                _ => false,
            },
            None => false,
        }
    }

    /// The first token of a line says that the expression goes on.
    pub fn cont_next(&self, i: usize) -> bool {
        match self.t.get(i) {
            Some(t) => match t.kind {
                PUNCT => matches!(
                    t.c,
                    b'.' | b'?' | b':' | b'&' | b'|' | b'+' | b'*' | b'/' | b'%' | b'=' | b'^'
                ),
                IDENT => matches!(self.text(i), "as" | "is"),
                _ => false,
            },
            None => false,
        }
    }

    /// Skips an expression or a statement. It stops at `;`, at a closing
    /// bracket, at a line break that does not continue the expression and
    /// (when asked) at `,` or at the `{` of property observers.
    fn skip_expr(&mut self, sink: Option<usize>, stop_comma: bool, accessor_ok: bool) {
        let n = self.t.len();
        let start = self.i;
        let mut i = start;
        while i < n {
            let t = self.t[i];
            if i > start && t.nl && !self.cont_prev(i - 1) && !self.cont_next(i) {
                break;
            }
            match t.kind {
                PUNCT => match t.c {
                    b';' | b'}' | b')' | b']' => break,
                    b',' => {
                        if stop_comma {
                            break;
                        }
                        i += 1;
                    }
                    b'(' | b'[' => {
                        self.i = i;
                        self.skip_balanced(sink);
                        i = self.i;
                    }
                    b'{' => {
                        if accessor_ok
                            && self.kind(i + 1) == IDENT
                            && matches!(self.text(i + 1), "willSet" | "didSet" | "get" | "set")
                        {
                            break;
                        }
                        self.i = i;
                        self.skip_balanced(sink);
                        i = self.i;
                    }
                    _ => i += 1,
                },
                IDENT => {
                    if sink.is_some() {
                        self.collect(i, sink);
                    }
                    i += 1;
                    if stop_comma && self.punct(i, b'<') && self.adj(i) {
                        if let Some(e) = self.generic_args_end(i) {
                            if sink.is_some() {
                                for k in i..e {
                                    if self.kind(k) == IDENT {
                                        self.collect(k, sink);
                                    }
                                }
                            }
                            i = e;
                        }
                    }
                }
                _ => i += 1,
            }
        }
        self.i = i;
    }

    /// For `<` at `lt` that looks like generic arguments (`<[Entity], Never>`):
    /// gives the index after the closing `>`.
    fn generic_args_end(&self, lt: usize) -> Option<usize> {
        let first = self.t.get(lt + 1)?;
        let starts_like_type = (first.kind == IDENT && first.c.is_ascii_uppercase()) || first.c == b'[' || first.c == b'(';
        if !starts_like_type {
            return None;
        }
        let mut depth = 0i32;
        let end = (lt + 120).min(self.t.len());
        for j in lt..end {
            let t = &self.t[j];
            match t.kind {
                PUNCT => match t.c {
                    b'<' => depth += 1,
                    b'>' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    b',' | b'.' | b'[' | b']' | b'?' | b'!' | b':' | b'(' | b')' | b'&' => {}
                    _ => return None,
                },
                IDENT | BTICK | ARROW => {}
                _ => return None,
            }
            if j > lt && t.nl {
                return None;
            }
        }
        None
    }

    fn skip_stmt(&mut self, sink: Option<usize>) {
        let start = self.i;
        self.skip_expr(sink, false, false);
        if self.i == start {
            self.i += 1;
        }
    }

    pub fn skip_where(&mut self) {
        if !self.kw(self.i, "where") {
            return;
        }
        let start = self.i;
        let n = self.t.len();
        let mut i = start + 1;
        while i < n {
            let t = self.t[i];
            if t.nl && !self.cont_prev(i - 1) && !self.cont_next(i) {
                break;
            }
            if t.kind == PUNCT {
                match t.c {
                    b';' | b'{' | b'}' => break,
                    b'(' | b'[' => {
                        self.i = i;
                        self.skip_balanced(None);
                        i = self.i;
                        continue;
                    }
                    _ => {}
                }
            }
            i += 1;
        }
        self.i = i;
    }

    // ---- types ----

    /// Reads a type at `self.i`. When there is no type, it moves nothing and
    /// gives an empty `TypeRef`.
    pub fn parse_type(&mut self) -> TypeRef {
        if self.tdepth >= MAX_NEST {
            return TypeRef::default();
        }
        self.tdepth += 1;
        let r = self.parse_type_inner();
        self.tdepth -= 1;
        r
    }

    fn parse_type_inner(&mut self) -> TypeRef {
        let n = self.t.len();
        let begin = self.i;
        // Attributes and ownership words before the type.
        loop {
            if self.punct(self.i, b'@') && self.is_id(self.i + 1) {
                self.i += 2;
                while self.punct(self.i, b'.') && self.is_id(self.i + 1) {
                    self.i += 2;
                }
                if self.punct(self.i, b'(') && self.adj(self.i) {
                    self.skip_balanced(None);
                }
                continue;
            }
            if self.kind(self.i) == IDENT
                && matches!(
                    self.text(self.i),
                    "inout" | "borrowing" | "consuming" | "__shared" | "__owned" | "sending" | "nonisolated" | "isolated"
                )
                && (self.is_id(self.i + 1) || self.punct(self.i + 1, b'(') || self.punct(self.i + 1, b'['))
            {
                self.i += 1;
                continue;
            }
            if self.punct(self.i, b'~') {
                self.i += 1;
                continue;
            }
            break;
        }
        let core = self.i;
        if core >= n {
            return TypeRef::default();
        }
        while self.kind(self.i) == IDENT
            && matches!(self.text(self.i), "some" | "any" | "each" | "repeat")
            && (self.is_id(self.i + 1) || self.punct(self.i + 1, b'(') || self.punct(self.i + 1, b'['))
            && !self.nl(self.i + 1)
        {
            self.i += 1;
        }
        let base_start = self.i;
        let mut ty = TypeRef::default();
        let mut group: Option<Vec<TypeRef>> = None;
        let mut labeled = false;
        let mut progressed = true;
        if self.punct(self.i, b'(') {
            self.i += 1;
            let mut parts: Vec<TypeRef> = Vec::new();
            loop {
                if self.i >= n {
                    break;
                }
                if self.punct(self.i, b')') {
                    self.i += 1;
                    break;
                }
                let p0 = self.i;
                // Labels: `name: Type` and `_ name: Type`.
                if self.is_id(self.i) && self.punct(self.i + 1, b':') {
                    self.i += 2;
                    labeled = true;
                } else if self.is_id(self.i) && self.is_id(self.i + 1) && self.punct(self.i + 2, b':') {
                    self.i += 3;
                    labeled = true;
                }
                let mut p = self.parse_type();
                // Variadic `Int...`.
                if self.punct(self.i, b'.') && self.punct(self.i + 1, b'.') && self.punct(self.i + 2, b'.') {
                    self.i += 3;
                    p.array = true;
                }
                if self.punct(self.i, b'=') {
                    // A default value is not part of a type. Skip it.
                    self.i += 1;
                    self.skip_expr(None, true, false);
                }
                parts.push(p);
                if self.punct(self.i, b',') {
                    self.i += 1;
                } else if !self.punct(self.i, b')') {
                    // Not a type. Stop at the closing bracket if there is one near.
                    if self.i == p0 {
                        self.i += 1;
                    }
                    let mut depth = 1;
                    while self.i < n && depth > 0 {
                        if self.punct(self.i, b'(') {
                            depth += 1;
                        } else if self.punct(self.i, b')') {
                            depth -= 1;
                        } else if self.nl(self.i) {
                            break;
                        }
                        self.i += 1;
                    }
                    break;
                }
                if self.i == p0 {
                    self.i += 1;
                }
            }
            group = Some(parts);
        } else if self.punct(self.i, b'[') {
            self.i += 1;
            let k = self.parse_type();
            if self.punct(self.i, b':') {
                self.i += 1;
                let v = self.parse_type();
                ty.name = "Dictionary".to_string();
                ty.args = vec![k, v];
            } else {
                ty.name = "Array".to_string();
                ty.args = vec![k];
            }
            if self.punct(self.i, b']') {
                self.i += 1;
            }
        } else if self.is_id(self.i) {
            let mut name = String::new();
            loop {
                let seg = self.text(self.i);
                if self.build {
                    if !name.is_empty() {
                        name.push('.');
                    }
                    name.push_str(seg);
                }
                self.i += 1;
                if self.punct(self.i, b'<') && self.adj(self.i) {
                    self.i += 1;
                    let mut args = Vec::new();
                    loop {
                        let a0 = self.i;
                        let a = self.parse_type();
                        if self.i == a0 {
                            break;
                        }
                        args.push(a);
                        if self.punct(self.i, b',') {
                            self.i += 1;
                        } else {
                            break;
                        }
                    }
                    if self.punct(self.i, b'>') {
                        self.i += 1;
                    }
                    ty.args = args;
                }
                if self.punct(self.i, b'.') && !self.nl(self.i) && self.is_id(self.i + 1) {
                    let nx = self.text(self.i + 1);
                    if self.kind(self.i + 1) == IDENT && matches!(nx, "Type" | "Protocol") {
                        self.i += 2;
                        break;
                    }
                    self.i += 1;
                    continue;
                }
                break;
            }
            ty.name = name;
        } else {
            progressed = false;
        }
        if !progressed {
            self.i = begin;
            return TypeRef::default();
        }
        // Postfix `?` and `!`.
        let mut nullable = false;
        while (self.punct(self.i, b'?') || self.punct(self.i, b'!')) && !self.nl(self.i) {
            nullable = true;
            self.i += 1;
        }
        // `A & B`.
        let mut composed: Option<Vec<TypeRef>> = None;
        // Function type: `(A) -> B`, `A async throws -> B`.
        let mut j = self.i;
        while self.kind(j) == IDENT && matches!(self.text(j), "async" | "throws" | "rethrows") {
            j += 1;
            if self.punct(j, b'(') && self.kw(j - 1, "throws") {
                // `throws(Error)`.
                let save = self.i;
                self.i = j;
                self.skip_balanced(None);
                j = self.i;
                self.i = save;
            }
        }
        let mut result_group = group;
        if self.kind(j) == ARROW {
            self.i = j + 1;
            let ret = self.parse_type();
            let mut args = match result_group.take() {
                Some(p) => p,
                None => {
                    let mut single = std::mem::take(&mut ty);
                    single.nullable = nullable;
                    nullable = false;
                    vec![single]
                }
            };
            args.push(ret);
            ty = TypeRef::default();
            ty.args = args;
        } else if let Some(mut parts) = result_group.take() {
            if parts.len() == 1 && !labeled {
                ty = parts.remove(0);
            } else {
                ty = TypeRef::default();
                ty.args = parts;
            }
        }
        while self.punct(self.i, b'&') {
            let mut list = composed.take().unwrap_or_default();
            if list.is_empty() {
                let mut first = std::mem::take(&mut ty);
                first.nullable = false;
                list.push(first);
            }
            self.i += 1;
            let a0 = self.i;
            let next = self.parse_type();
            if self.i == a0 {
                break;
            }
            list.push(next);
            composed = Some(list);
        }
        if let Some(list) = composed {
            ty = TypeRef::default();
            ty.args = list;
        }
        if nullable {
            ty.nullable = true;
        }
        if self.build {
            let last = self.i.saturating_sub(1).max(core);
            ty.text = normalize_ws(self.span(core, last));
        }
        let _ = base_start;
        ty
    }

    /// `<T: Equatable, U>` gives `T`, `U`. `self.i` is at `<`.
    fn parse_generic_params(&mut self) -> Vec<String> {
        let n = self.t.len();
        let mut names = Vec::new();
        self.i += 1;
        let mut depth = 1;
        let mut want = true;
        while self.i < n && depth > 0 {
            let t = self.t[self.i];
            match t.kind {
                IDENT | BTICK => {
                    if want && depth == 1 {
                        let s = self.text(self.i);
                        if t.kind == IDENT && (s == "each" || s == "let") && self.is_id(self.i + 1) {
                            self.i += 1;
                        }
                        names.push(self.text(self.i).to_string());
                        want = false;
                    }
                }
                PUNCT => match t.c {
                    b'<' => depth += 1,
                    b'>' => depth -= 1,
                    b',' if depth == 1 => want = true,
                    b'{' | b'}' | b';' => break,
                    _ => {}
                },
                _ => {}
            }
            self.i += 1;
        }
        names
    }

    // ---- file and items ----

    pub fn parse_file(mut self) -> FileModel {
        let cx = Ctx {
            owner: None,
            kind: None,
            vis: Visibility::Internal,
            case_vis: Visibility::Internal,
        };
        self.parse_members(cx, true);
        let used = std::mem::take(&mut self.used);
        for (td, u) in self.model.types.iter_mut().zip(used) {
            td.used_types = u.order.iter().map(|s| s.to_string()).collect();
        }
        self.model
    }

    fn parse_members(&mut self, cx: Ctx, top: bool) {
        let n = self.t.len();
        while self.i < n {
            if self.punct(self.i, b'}') {
                if top {
                    self.i += 1;
                    continue;
                }
                break;
            }
            let before = self.i;
            self.parse_item(cx);
            if self.i == before {
                self.i += 1;
            }
        }
    }

    /// Length in tokens of a modifier at `i`, or 0.
    fn modifier_at(&self, i: usize) -> usize {
        if self.kind(i) != IDENT {
            return 0;
        }
        let s = self.text(i);
        if s == "class" {
            if self.kind(i + 1) == IDENT && class_is_modifier(self.text(i + 1)) {
                return 1;
            }
            return 0;
        }
        if !is_modifier_word(s) {
            return 0;
        }
        let nx = i + 1;
        if self.punct(nx, b'(')
            && self.adj(nx)
            && matches!(self.text(nx + 1), "set" | "unsafe" | "safe" | "unchecked")
            && self.punct(nx + 2, b')')
        {
            return 4;
        }
        if self.is_id(nx) || self.punct(nx, b'@') {
            return 1;
        }
        0
    }

    fn parse_item(&mut self, cx: Ctx) {
        let item_start = self.i;
        if self.punct(self.i, b';') {
            self.i += 1;
            return;
        }
        let mut attrs: Vec<String> = Vec::new();
        let mut mods: Vec<String> = Vec::new();
        let mut wrappers: Vec<&'a str> = Vec::new();
        loop {
            if self.punct(self.i, b'@') && self.is_id(self.i + 1) && self.adj(self.i + 1) {
                self.i += 1;
                let a0 = self.i;
                self.i += 1;
                while self.punct(self.i, b'.') && self.is_id(self.i + 1) {
                    self.i += 2;
                }
                let name = self.span(a0, self.i - 1);
                attrs.push(name.to_string());
                wrappers.push(name);
                if self.punct(self.i, b'(') && self.adj(self.i) {
                    let s = self.i;
                    self.skip_balanced(None);
                    for k in s..self.i {
                        if self.kind(k) == IDENT
                            && self.t[k].c.is_ascii_uppercase()
                            && !self.punct(k.wrapping_sub(1), b'.')
                        {
                            wrappers.push(self.text(k));
                        }
                    }
                }
                continue;
            }
            let m = self.modifier_at(self.i);
            if m == 0 {
                break;
            }
            if m == 4 {
                let s = format!("{}(set)", self.text(self.i));
                mods.push(s);
            } else {
                mods.push(self.text(self.i).to_string());
            }
            self.i += m;
        }
        let start_line = self.line(item_start);
        if self.kind(self.i) != IDENT {
            self.skip_stmt(cx.owner);
            return;
        }
        let word = self.text(self.i);
        match word {
            "import" => self.parse_import(),
            "class" => self.parse_type_decl(cx, TypeKind::Class, mods, attrs, start_line),
            "struct" => self.parse_type_decl(cx, TypeKind::Struct, mods, attrs, start_line),
            "enum" => self.parse_type_decl(cx, TypeKind::Enum, mods, attrs, start_line),
            "protocol" => self.parse_type_decl(cx, TypeKind::Protocol, mods, attrs, start_line),
            "extension" => self.parse_type_decl(cx, TypeKind::Extension, mods, attrs, start_line),
            "actor" if self.is_id(self.i + 1) && !self.nl(self.i + 1) => {
                self.parse_type_decl(cx, TypeKind::Actor, mods, attrs, start_line)
            }
            "typealias" => self.parse_typealias(cx, mods, attrs, start_line),
            "func" => self.parse_func(cx, &mods),
            "init" if cx.owner.is_some() => self.parse_init(cx, &mods),
            "deinit" => {
                self.i += 1;
                if self.punct(self.i, b'{') {
                    self.skip_balanced(cx.owner);
                }
            }
            "subscript" if cx.owner.is_some() => self.parse_subscript(cx, &mods),
            "var" | "let" => self.parse_var(cx, &mods, &wrappers),
            "case" if cx.kind == Some(TypeKind::Enum) => self.parse_enum_case(cx),
            _ => self.skip_stmt(cx.owner),
        }
    }

    fn parse_import(&mut self) {
        let line = self.line(self.i);
        self.i += 1;
        if self.kind(self.i) == IDENT
            && matches!(
                self.text(self.i),
                "typealias" | "struct" | "class" | "enum" | "protocol" | "let" | "var" | "func"
            )
            && self.is_id(self.i + 1)
            && !self.nl(self.i + 1)
        {
            self.i += 1;
        }
        let first = self.i;
        if !self.is_id(first) {
            return;
        }
        let mut last = first;
        self.i += 1;
        while self.punct(self.i, b'.') && self.is_id(self.i + 1) && !self.nl(self.i) {
            last = self.i + 1;
            self.i += 2;
        }
        let mut contiguous = true;
        for k in first + 1..=last {
            if !self.adj(k) {
                contiguous = false;
            }
        }
        let path = if contiguous {
            self.span(first, last).to_string()
        } else {
            let mut s = String::new();
            let mut k = first;
            while k <= last {
                if k > first {
                    s.push('.');
                }
                s.push_str(self.text(k));
                k += 2;
            }
            s
        };
        self.model.imports.push(Import {
            path,
            wildcard: false,
            alias: None,
            is_static: false,
            line,
        });
    }

    fn parse_type_decl(&mut self, cx: Ctx, kind: TypeKind, mods: Vec<String>, attrs: Vec<String>, start_line: u32) {
        if self.ndepth >= MAX_NEST {
            self.i += 1;
            self.skip_expr(None, false, false);
            return;
        }
        self.i += 1;
        let (name, line, col) = if kind == TypeKind::Extension {
            let (l, c) = (self.line(self.i), self.col(self.i));
            let ty = self.parse_type();
            let name = if ty.name.is_empty() { ty.text } else { ty.name };
            if name.is_empty() {
                self.skip_stmt(cx.owner);
                return;
            }
            (name, l, c)
        } else {
            if !self.is_id(self.i) {
                self.skip_stmt(cx.owner);
                return;
            }
            let r = (self.text(self.i).to_string(), self.line(self.i), self.col(self.i));
            self.i += 1;
            r
        };
        let type_params = if kind != TypeKind::Extension && self.punct(self.i, b'<') {
            self.parse_generic_params()
        } else {
            Vec::new()
        };
        let mut supertypes = Vec::new();
        if self.punct(self.i, b':') {
            self.i += 1;
            loop {
                let s = self.i;
                let ty = self.parse_type();
                if self.i == s {
                    break;
                }
                supertypes.push(SuperType {
                    ty,
                    kind: SuperKind::Unknown,
                    delegated: false,
                });
                if self.punct(self.i, b',') {
                    self.i += 1;
                } else {
                    break;
                }
            }
        }
        self.skip_where();
        let own = vis_from(&mods);
        let tv = own.unwrap_or(Visibility::Internal);
        let min_internal = |v: Visibility| {
            if v == Visibility::Private {
                Visibility::Private
            } else {
                Visibility::Internal
            }
        };
        let (default_vis, case_vis) = match kind {
            TypeKind::Extension => (tv, tv),
            TypeKind::Protocol => (tv, tv),
            _ => (min_internal(tv), tv),
        };
        let td = TypeDecl {
            name,
            kind,
            outer: cx.owner,
            modifiers: mods,
            annotations: attrs,
            type_params,
            supertypes,
            aliased: None,
            fields: Vec::new(),
            methods: Vec::new(),
            used_types: Vec::new(),
            line,
            column: col,
            start_line,
            end_line: line,
        };
        let idx = self.model.types.len();
        self.model.types.push(td);
        self.used.push(Used::default());
        if self.punct(self.i, b'{') {
            self.i += 1;
            self.ndepth += 1;
            let inner = Ctx {
                owner: Some(idx),
                kind: Some(kind),
                vis: default_vis,
                case_vis,
            };
            self.parse_members(inner, false);
            self.ndepth -= 1;
            let end = if self.punct(self.i, b'}') {
                let l = self.line(self.i);
                self.i += 1;
                l
            } else {
                self.last_line()
            };
            self.model.types[idx].end_line = end;
        }
    }

    fn parse_typealias(&mut self, cx: Ctx, mods: Vec<String>, attrs: Vec<String>, start_line: u32) {
        self.i += 1;
        if !self.is_id(self.i) {
            self.skip_stmt(cx.owner);
            return;
        }
        let name = self.text(self.i).to_string();
        let (line, col) = (self.line(self.i), self.col(self.i));
        self.i += 1;
        let type_params = if self.punct(self.i, b'<') {
            self.parse_generic_params()
        } else {
            Vec::new()
        };
        let mut aliased = None;
        if self.punct(self.i, b'=') {
            self.i += 1;
            let ty = self.parse_type();
            if !ty.text.is_empty() {
                aliased = Some(ty);
            }
        }
        self.skip_where();
        let end_line = self.t.get(self.i.saturating_sub(1)).map_or(line, |t| t.line).max(line);
        self.model.types.push(TypeDecl {
            name,
            kind: TypeKind::TypeAlias,
            outer: cx.owner,
            modifiers: mods,
            annotations: attrs,
            type_params,
            supertypes: Vec::new(),
            aliased,
            fields: Vec::new(),
            methods: Vec::new(),
            used_types: Vec::new(),
            line,
            column: col,
            start_line,
            end_line,
        });
        self.used.push(Used::default());
    }

    fn add_member(&mut self, cx: Ctx, m: Member) {
        match cx.owner.and_then(|o| self.model.types.get_mut(o)) {
            Some(td) => {
                if matches!(m.kind, MemberKind::Method | MemberKind::Constructor) {
                    td.methods.push(m);
                } else {
                    td.fields.push(m);
                }
            }
            None => {
                if cx.owner.is_none() {
                    self.model.top_level.push(m);
                }
            }
        }
    }

    /// Parameters. `self.i` is at `(`.
    fn parse_params(&mut self, sink: Option<usize>) -> Vec<Param> {
        let n = self.t.len();
        let mut out = Vec::new();
        self.i += 1;
        while self.i < n {
            if self.punct(self.i, b')') {
                self.i += 1;
                break;
            }
            let p0 = self.i;
            if self.is_id(self.i) {
                let mut name = self.text(self.i);
                if self.is_id(self.i + 1) {
                    name = self.text(self.i + 1);
                    self.i += 2;
                } else {
                    self.i += 1;
                }
                let name = name.to_string();
                let mut ty = None;
                if self.punct(self.i, b':') {
                    self.i += 1;
                    let mut t = self.parse_type();
                    if self.punct(self.i, b'.') && self.punct(self.i + 1, b'.') && self.punct(self.i + 2, b'.') {
                        self.i += 3;
                        t.array = true;
                    }
                    if !t.text.is_empty() {
                        ty = Some(t);
                    }
                }
                if self.punct(self.i, b'=') {
                    self.i += 1;
                    self.skip_expr(sink, true, false);
                }
                out.push(Param { name, ty });
            }
            if self.punct(self.i, b',') {
                self.i += 1;
            } else if !self.punct(self.i, b')') {
                // Unexpected tokens. Skip to the next `,` or `)`.
                while self.i < n && !self.punct(self.i, b',') && !self.punct(self.i, b')') {
                    if self.punct(self.i, b'(') || self.punct(self.i, b'[') || self.punct(self.i, b'{') {
                        self.skip_balanced(None);
                    } else {
                        self.i += 1;
                    }
                }
            }
            if self.i == p0 {
                self.i += 1;
            }
        }
        out
    }

    /// After the parameters: `async throws -> Ret where ...`. Gives the return type.
    fn parse_effects_and_return(&mut self) -> Option<TypeRef> {
        while self.kind(self.i) == IDENT && matches!(self.text(self.i), "async" | "throws" | "rethrows") {
            let was_throws = self.text(self.i) == "throws";
            self.i += 1;
            if was_throws && self.punct(self.i, b'(') && self.adj(self.i) {
                self.skip_balanced(None);
            }
        }
        let mut ret = None;
        if self.kind(self.i) == ARROW {
            self.i += 1;
            let ty = self.parse_type();
            if !ty.text.is_empty() {
                ret = Some(ty);
            }
        }
        self.skip_where();
        ret
    }

    fn is_static(mods: &[String]) -> bool {
        mods.iter().any(|m| m == "static" || m == "class")
    }

    fn parse_func(&mut self, cx: Ctx, mods: &[String]) {
        self.i += 1;
        let (line, col) = (self.line(self.i), self.col(self.i));
        let name: String;
        if self.is_id(self.i) {
            name = self.text(self.i).to_string();
            self.i += 1;
        } else if self.kind(self.i) == PUNCT && self.t[self.i].c != b'(' && self.t[self.i].c != b'{' {
            // Operator function: `==`, `+`, `<=>`.
            let first = self.i;
            self.i += 1;
            while self.kind(self.i) == PUNCT
                && self.adj(self.i)
                && !matches!(self.t[self.i].c, b'(' | b'{' | b')' | b',')
            {
                self.i += 1;
            }
            name = self.span(first, self.i - 1).to_string();
        } else {
            self.skip_stmt(cx.owner);
            return;
        }
        if self.punct(self.i, b'<') {
            self.parse_generic_params();
        }
        let params = if self.punct(self.i, b'(') {
            self.parse_params(cx.owner)
        } else {
            Vec::new()
        };
        let ty = self.parse_effects_and_return();
        if self.punct(self.i, b'{') {
            self.skip_balanced(cx.owner);
        }
        let vis = vis_from(mods).unwrap_or(cx.vis);
        self.add_member(
            cx,
            Member {
                name,
                kind: MemberKind::Method,
                visibility: vis,
                is_static: Self::is_static(mods),
                is_abstract: cx.kind == Some(TypeKind::Protocol),
                ty,
                params,
                mutable: false,
                receiver: None,
                line,
                column: col,
                end_line: self.prev_end_line(),
            },
        );
    }

    fn parse_init(&mut self, cx: Ctx, mods: &[String]) {
        let (line, col) = (self.line(self.i), self.col(self.i));
        self.i += 1;
        if (self.punct(self.i, b'?') || self.punct(self.i, b'!')) && self.adj(self.i) {
            self.i += 1;
        }
        if self.punct(self.i, b'<') {
            self.parse_generic_params();
        }
        let params = if self.punct(self.i, b'(') {
            self.parse_params(cx.owner)
        } else {
            Vec::new()
        };
        self.parse_effects_and_return();
        if self.punct(self.i, b'{') {
            self.skip_balanced(cx.owner);
        }
        let vis = vis_from(mods).unwrap_or(cx.vis);
        self.add_member(
            cx,
            Member {
                name: "init".to_string(),
                kind: MemberKind::Constructor,
                visibility: vis,
                is_static: false,
                is_abstract: cx.kind == Some(TypeKind::Protocol),
                ty: None,
                params,
                mutable: false,
                receiver: None,
                line,
                column: col,
                end_line: self.prev_end_line(),
            },
        );
    }

    fn parse_subscript(&mut self, cx: Ctx, mods: &[String]) {
        let (line, col) = (self.line(self.i), self.col(self.i));
        self.i += 1;
        if self.punct(self.i, b'<') {
            self.parse_generic_params();
        }
        let params = if self.punct(self.i, b'(') {
            self.parse_params(cx.owner)
        } else {
            Vec::new()
        };
        let ty = self.parse_effects_and_return();
        if self.punct(self.i, b'{') {
            self.skip_balanced(cx.owner);
        }
        let vis = vis_from(mods).unwrap_or(cx.vis);
        self.add_member(
            cx,
            Member {
                name: "subscript".to_string(),
                kind: MemberKind::Method,
                visibility: vis,
                is_static: Self::is_static(mods),
                is_abstract: cx.kind == Some(TypeKind::Protocol),
                ty,
                params,
                mutable: false,
                receiver: None,
                line,
                column: col,
                end_line: self.prev_end_line(),
            },
        );
    }

    /// `Foo(`, `Foo.Bar(`, `Foo<T>(`: gives the type and the index of the `(`.
    fn ctor_candidate(&mut self, i: usize) -> Option<(TypeRef, usize)> {
        let t = self.t.get(i)?;
        if t.kind != IDENT || !t.c.is_ascii_uppercase() {
            return None;
        }
        let mut j = i;
        while self.punct(j + 1, b'.')
            && self.kind(j + 2) == IDENT
            && self.t[j + 2].c.is_ascii_uppercase()
            && self.adj(j + 1)
            && self.adj(j + 2)
        {
            j += 2;
        }
        let name = self.span(i, j);
        let mut e = j + 1;
        if self.punct(e, b'<') && self.adj(e) {
            let mut depth = 0;
            while e < self.t.len() {
                if self.punct(e, b'<') {
                    depth += 1;
                } else if self.punct(e, b'>') {
                    depth -= 1;
                    if depth == 0 {
                        e += 1;
                        break;
                    }
                } else if self.nl(e) || self.punct(e, b'{') || self.punct(e, b'(') && depth == 0 {
                    return None;
                }
                e += 1;
            }
        }
        if !self.punct(e, b'(') {
            return None;
        }
        let _ = name;
        let save = self.i;
        self.i = i;
        let ty = self.parse_type();
        self.i = save;
        if ty.text.is_empty() {
            return None;
        }
        Some((ty, e))
    }

    fn parse_var(&mut self, cx: Ctx, mods: &[String], wrappers: &[&'a str]) {
        let is_var = self.text(self.i) == "var";
        self.i += 1;
        let vis = vis_from(mods).unwrap_or(cx.vis);
        let is_static = Self::is_static(mods);
        let in_protocol = cx.kind == Some(TypeKind::Protocol);
        if cx.owner.is_some() {
            for w in wrappers {
                if w.as_bytes().first().is_some_and(|c| c.is_ascii_uppercase()) {
                    self.add_used(cx.owner, w);
                }
            }
        }
        // Names that still wait for a type: `var a, b: Int`.
        let mut waiting: Vec<usize> = Vec::new();
        let mut made: Vec<Member> = Vec::new();
        loop {
            if !self.is_id(self.i) {
                if self.punct(self.i, b'(') {
                    // Tuple pattern: no members.
                    self.skip_balanced(None);
                } else {
                    break;
                }
                let mut ty = None;
                if self.punct(self.i, b':') {
                    self.i += 1;
                    ty = Some(self.parse_type());
                }
                let _ = ty;
                if self.punct(self.i, b'=') {
                    self.i += 1;
                    self.skip_expr(cx.owner, true, true);
                }
                if self.punct(self.i, b'{') {
                    self.skip_balanced(cx.owner);
                }
                if self.punct(self.i, b',') {
                    self.i += 1;
                    continue;
                }
                break;
            }
            let name = self.text(self.i).to_string();
            let (line, col) = (self.line(self.i), self.col(self.i));
            self.i += 1;
            let mut ty: Option<TypeRef> = None;
            let mut has_init = false;
            if self.punct(self.i, b':') {
                self.i += 1;
                let t = self.parse_type();
                if !t.text.is_empty() {
                    ty = Some(t);
                }
            }
            if self.punct(self.i, b'=') {
                self.i += 1;
                has_init = true;
                let cand = if ty.is_none() { self.ctor_candidate(self.i) } else { None };
                self.skip_expr(cx.owner, true, true);
                if let Some((tr, open)) = cand {
                    let save = self.i;
                    self.i = open;
                    self.skip_balanced(None);
                    let close_end = self.i;
                    self.i = save;
                    if save == close_end {
                        ty = Some(tr);
                    }
                }
            }
            let mut has_block = false;
            if self.punct(self.i, b'{') {
                has_block = true;
                self.skip_balanced(cx.owner);
            }
            let waits = ty.is_none() && !has_init && !has_block && self.punct(self.i, b',');
            if ty.is_some() && !waiting.is_empty() {
                for k in waiting.drain(..) {
                    if let Some(m) = made.get_mut(k) {
                        m.ty = ty.clone();
                    }
                }
            }
            if name != "_" {
                if waits {
                    waiting.push(made.len());
                }
                made.push(Member {
                    name,
                    kind: MemberKind::Property,
                    visibility: vis,
                    is_static,
                    is_abstract: in_protocol,
                    ty,
                    params: Vec::new(),
                    mutable: is_var,
                    receiver: None,
                    line,
                    column: col,
                    end_line: self.prev_end_line(),
                });
            }
            if self.punct(self.i, b',') {
                self.i += 1;
            } else {
                break;
            }
        }
        for m in made {
            self.add_member(cx, m);
        }
    }

    fn add_used(&mut self, owner: Option<usize>, name: &'a str) {
        let Some(s) = owner else { return };
        if name == "Self" || name == "Any" {
            return;
        }
        if let Some(u) = self.used.get_mut(s) {
            if u.set.insert(name) {
                u.order.push(name);
            }
        }
    }

    fn parse_enum_case(&mut self, cx: Ctx) {
        let n = self.t.len();
        self.i += 1;
        loop {
            if !self.is_id(self.i) {
                break;
            }
            let name = self.text(self.i).to_string();
            let (line, col) = (self.line(self.i), self.col(self.i));
            self.i += 1;
            let mut params = Vec::new();
            if self.punct(self.i, b'(') {
                self.i += 1;
                while self.i < n {
                    if self.punct(self.i, b')') {
                        self.i += 1;
                        break;
                    }
                    let p0 = self.i;
                    let mut label = String::new();
                    if self.is_id(self.i) && self.punct(self.i + 1, b':') {
                        label = self.text(self.i).to_string();
                        self.i += 2;
                    }
                    let ty = self.parse_type();
                    if self.punct(self.i, b'=') {
                        self.i += 1;
                        self.skip_expr(cx.owner, true, false);
                    }
                    params.push(Param {
                        name: label,
                        ty: if ty.text.is_empty() { None } else { Some(ty) },
                    });
                    if self.punct(self.i, b',') {
                        self.i += 1;
                    } else if !self.punct(self.i, b')') {
                        while self.i < n && !self.punct(self.i, b',') && !self.punct(self.i, b')') {
                            if self.punct(self.i, b'(') || self.punct(self.i, b'[') || self.punct(self.i, b'{') {
                                self.skip_balanced(None);
                            } else {
                                self.i += 1;
                            }
                        }
                    }
                    if self.i == p0 {
                        self.i += 1;
                    }
                }
            }
            if self.punct(self.i, b'=') {
                self.i += 1;
                self.skip_expr(cx.owner, true, false);
            }
            self.add_member(
                cx,
                Member {
                    name,
                    kind: MemberKind::EnumCase,
                    visibility: cx.case_vis,
                    is_static: false,
                    is_abstract: false,
                    ty: None,
                    params,
                    mutable: false,
                    receiver: None,
                    line,
                    column: col,
                    end_line: self.prev_end_line(),
                },
            );
            if self.punct(self.i, b',') {
                self.i += 1;
            } else {
                break;
            }
        }
    }
}
