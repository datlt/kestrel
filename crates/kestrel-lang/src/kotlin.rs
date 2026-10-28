//! Kotlin parser. It reads declarations and skips the inside of bodies, but
//! it still looks at every body token to find type names and the use of
//! identifiers. See `jvm_lex.rs` for the tokens.

use crate::jvm_lex::*;
use crate::model::*;

pub(crate) fn parse(text: &str) -> FileModel {
    let mut p = P::new(text, true);
    p.members(None, None);
    p.m
}

pub(crate) fn find_identifiers(text: &str, name: &str) -> Vec<IdentHit> {
    let mut p = P::new(text, false);
    p.members(None, None);
    collect_hits(&p.s, &p.roles, name)
}

const MAX_DEPTH: u32 = 64;

/// Words that are never a call or a name in code.
fn is_hard_kw(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "when"
            | "while"
            | "for"
            | "do"
            | "try"
            | "catch"
            | "finally"
            | "return"
            | "throw"
            | "break"
            | "continue"
            | "in"
            | "is"
            | "as"
            | "this"
            | "super"
            | "null"
            | "true"
            | "false"
            | "class"
            | "object"
            | "interface"
            | "fun"
            | "val"
            | "var"
            | "typealias"
            | "package"
            | "import"
    )
}

fn is_modifier(s: &str) -> bool {
    matches!(
        s,
        "public"
            | "private"
            | "protected"
            | "internal"
            | "abstract"
            | "open"
            | "final"
            | "sealed"
            | "data"
            | "inner"
            | "value"
            | "enum"
            | "annotation"
            | "companion"
            | "override"
            | "lateinit"
            | "const"
            | "suspend"
            | "inline"
            | "noinline"
            | "crossinline"
            | "tailrec"
            | "operator"
            | "infix"
            | "external"
            | "expect"
            | "actual"
            | "vararg"
    )
}

#[derive(Default)]
struct Mods<'a> {
    list: Vec<&'a str>,
    annos: Vec<&'a str>,
    vis: Option<Visibility>,
    is_abstract: bool,
    is_enum: bool,
    is_annotation: bool,
    is_companion: bool,
    /// Index of the first token (annotation or modifier).
    start: usize,
}

struct P<'a> {
    s: Src<'a>,
    pos: usize,
    roles: Vec<u8>,
    build: bool,
    m: FileModel,
    depth: u32,
    tdepth: u32,
    /// Collect used types for `body_owner` while scanning code.
    collect: bool,
    body_owner: Option<usize>,
    scratch: String,
}

impl<'a> P<'a> {
    fn new(text: &'a str, build: bool) -> P<'a> {
        let s = Src::new(text, true, build);
        let n = s.n();
        P {
            s,
            pos: 0,
            roles: vec![R_NONE; n],
            build,
            m: FileModel::default(),
            depth: 0,
            tdepth: 0,
            collect: false,
            body_owner: None,
            scratch: String::new(),
        }
    }

    #[inline]
    fn n(&self) -> usize {
        self.s.n()
    }

    #[inline]
    fn set(&mut self, i: usize, r: u8) {
        if let Some(x) = self.roles.get_mut(i) {
            if *x == R_NONE {
                *x = r;
            }
        }
    }

    #[inline]
    fn p(&self, i: usize, c: u8) -> bool {
        self.s.is_p(i, c)
    }

    #[inline]
    fn kw(&self, i: usize, s: &str) -> bool {
        self.s.id_is(i, s)
    }

    fn mk(&self, s: &str) -> String {
        if self.build { s.to_string() } else { String::new() }
    }

    fn td(&mut self, idx: Option<usize>) -> Option<&mut TypeDecl> {
        if !self.build {
            return None;
        }
        let i = idx?;
        self.m.types.get_mut(i)
    }

    fn add_used_name(&mut self, owner: usize, name: &str) {
        if let Some(td) = self.m.types.get_mut(owner) {
            if !td.used_types.iter().any(|u| u == name) {
                td.used_types.push(name.to_string());
            }
        }
    }

    /// Records a dotted name for the used types of the current body.
    fn add_used(&mut self, segs: &[usize]) {
        let Some(owner) = self.body_owner else { return };
        if !self.collect || segs.is_empty() {
            return;
        }
        let mut last: Option<usize> = None;
        let mut seen_upper = false;
        for (idx, &t) in segs.iter().enumerate() {
            let s = self.s.tx(t);
            if is_upper_start(s) {
                if idx > 0 && is_const_name(s) {
                    break;
                }
                last = Some(idx);
                seen_upper = true;
            } else if seen_upper {
                break;
            }
        }
        let Some(last) = last else { return };
        if last == 0 && matches!(self.s.tx(segs[0]), "this" | "super" | "it") {
            return;
        }
        let mut name = std::mem::take(&mut self.scratch);
        name.clear();
        for (k, &t) in segs[..=last].iter().enumerate() {
            if k > 0 {
                name.push('.');
            }
            name.push_str(self.s.tx(t));
        }
        self.add_used_name(owner, &name);
        self.scratch = name;
    }

    /// Used types of a dotted chain that starts at token `i`.
    fn note_chain(&mut self, i: usize) {
        if !self.collect {
            return;
        }
        let mut segs = [0usize; 8];
        let mut k = 0;
        let mut j = i;
        while self.s.is_word(j) {
            if k < 8 {
                segs[k] = j;
                k += 1;
            }
            if self.p(j + 1, b'.') && self.s.is_word(j + 2) {
                j += 2;
            } else {
                break;
            }
        }
        self.add_used(&segs[..k]);
    }

    // ---------------------------------------------------------------
    // Members and declarations

    /// Reads declarations until the `}` of the body (left in place) or the end.
    fn members(&mut self, owner: Option<usize>, kind: Option<TypeKind>) {
        let n = self.n();
        loop {
            if self.pos >= n {
                return;
            }
            let before = self.pos;
            if self.p(self.pos, b';') {
                self.pos += 1;
                continue;
            }
            if self.p(self.pos, b'}') {
                if owner.is_some() {
                    return;
                }
                self.pos += 1;
                continue;
            }
            self.declaration(owner, kind);
            if self.pos <= before {
                self.pos = before + 1;
            }
        }
    }

    fn modifiers(&mut self) -> Mods<'a> {
        let mut m = Mods { start: self.pos, ..Mods::default() };
        loop {
            let i = self.pos;
            if self.p(i, b'@') {
                self.annotation(&mut m);
                continue;
            }
            if !self.s.is_id(i) {
                break;
            }
            let t = self.s.tx(i);
            let next_ok = self.s.is_word(i + 1) || self.p(i + 1, b'@');
            let is_mod = if t == "fun" {
                self.kw(i + 1, "interface")
            } else {
                is_modifier(t) && next_ok
            };
            if !is_mod {
                break;
            }
            self.set(i, R_SKIP);
            match t {
                "public" => m.vis = Some(Visibility::Public),
                "private" => m.vis = Some(Visibility::Private),
                "protected" => m.vis = Some(Visibility::Protected),
                "internal" => m.vis = Some(Visibility::Internal),
                "abstract" => m.is_abstract = true,
                "enum" => m.is_enum = true,
                "annotation" => m.is_annotation = true,
                "companion" => m.is_companion = true,
                _ => {}
            }
            if self.build {
                m.list.push(t);
            }
            self.pos += 1;
        }
        m
    }

    /// `@Name`, `@field:Name(args)`, `@[A B]`. The cursor is on the `@`.
    fn annotation(&mut self, m: &mut Mods<'a>) {
        let n = self.n();
        self.pos += 1;
        if self.p(self.pos, b'[') {
            let end = self.s.match_bracket(self.pos);
            self.pos += 1;
            while self.pos < end.min(n) {
                if self.s.is_word(self.pos) {
                    self.annotation_path(m);
                } else {
                    self.pos += 1;
                }
            }
            self.pos = (end + 1).min(n);
            return;
        }
        if self.s.is_word(self.pos)
            && self.s.colon1(self.pos + 1)
            && matches!(
                self.s.tx(self.pos),
                "file" | "field" | "get" | "set" | "param" | "property" | "receiver" | "setparam" | "delegate"
            )
        {
            self.set(self.pos, R_SKIP);
            self.pos += 2;
        }
        if self.s.is_word(self.pos) {
            self.annotation_path(m);
        }
    }

    fn annotation_path(&mut self, m: &mut Mods<'a>) {
        let n = self.n();
        let mut last;
        loop {
            self.set(self.pos, R_TYPE);
            last = self.pos;
            self.pos += 1;
            if self.p(self.pos, b'.') && self.s.is_word(self.pos + 1) {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.build {
            m.annos.push(self.s.tx(last));
        }
        if self.p(self.pos, b'<') {
            let _ = self.type_args(R_TYPE, n, false);
        }
        if self.p(self.pos, b'(') && !self.s.nl(self.pos) {
            let end = self.s.match_paren(self.pos);
            self.scan_range(self.pos + 1, end, None);
            self.pos = (end + 1).min(n);
        }
    }

    fn declaration(&mut self, owner: Option<usize>, kind: Option<TypeKind>) {
        let n = self.n();
        let mods = self.modifiers();
        let i = self.pos;
        if i >= n {
            return;
        }
        if self.s.is_id(i) {
            match self.s.tx(i) {
                "package" => {
                    self.package();
                    return;
                }
                "import" => {
                    self.import();
                    return;
                }
                "class" | "interface" | "object" => {
                    self.type_decl(owner, &mods);
                    return;
                }
                "typealias" => {
                    self.type_alias(owner, &mods);
                    return;
                }
                "fun" => {
                    self.function(owner, kind, &mods);
                    return;
                }
                "val" | "var" => {
                    self.property(owner, kind, &mods);
                    return;
                }
                "constructor" if owner.is_some() && self.p(i + 1, b'(') => {
                    self.secondary_ctor(owner, &mods);
                    return;
                }
                "init" if self.p(i + 1, b'{') => {
                    let end = self.s.match_brace(i + 1);
                    self.set(i, R_SKIP);
                    self.scan_range(i + 2, end, owner);
                    self.pos = (end + 1).min(n);
                    return;
                }
                _ => {}
            }
        }
        // Anything else: code of a script or junk. Scan it as one statement.
        let start = self.pos;
        let e = self.expr_end(start).max(start + 1);
        self.scan_range(start, e, owner);
        self.pos = e;
    }

    fn package(&mut self) {
        let n = self.n();
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        let mut path = String::new();
        loop {
            if self.s.is_word(self.pos) {
                self.set(self.pos, R_SKIP);
                if self.build {
                    path.push_str(self.s.tx(self.pos));
                }
                self.pos += 1;
                if self.p(self.pos, b'.') && self.s.is_word(self.pos + 1) {
                    if self.build {
                        path.push('.');
                    }
                    self.pos += 1;
                    continue;
                }
            }
            break;
        }
        if self.build {
            self.m.package = path;
        }
        self.pos = self.pos.min(n);
    }

    fn import(&mut self) {
        let line = self.s.line(self.pos);
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        let mut path = String::new();
        let mut wildcard = false;
        let mut alias = None;
        loop {
            if self.s.is_word(self.pos) {
                self.set(self.pos, R_IMPORT);
                if self.build {
                    path.push_str(self.s.tx(self.pos));
                }
                self.pos += 1;
                if self.p(self.pos, b'.') {
                    if self.p(self.pos + 1, b'*') {
                        wildcard = true;
                        self.pos += 2;
                        break;
                    }
                    if self.s.is_word(self.pos + 1) {
                        if self.build {
                            path.push('.');
                        }
                        self.pos += 1;
                        continue;
                    }
                }
            }
            break;
        }
        if self.kw(self.pos, "as") && self.s.is_word(self.pos + 1) {
            self.set(self.pos, R_SKIP);
            self.set(self.pos + 1, R_IMPORT);
            alias = Some(self.mk(self.s.tx(self.pos + 1)));
            self.pos += 2;
        }
        if self.build && !path.is_empty() {
            self.m.imports.push(Import { path, wildcard, alias, is_static: false, line });
        }
    }

    fn vis_of(&self, m: &Mods) -> Visibility {
        m.vis.unwrap_or(Visibility::Public)
    }

    fn type_alias(&mut self, owner: Option<usize>, mods: &Mods<'a>) {
        let n = self.n();
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        if !self.s.is_word(self.pos) {
            return;
        }
        let name_tok = self.pos;
        self.set(name_tok, R_DECL);
        self.pos += 1;
        let idx = self.m.types.len();
        if self.build {
            let (line, column) = self.s.lc(name_tok);
            let mut td = new_type(self.s.tx(name_tok), TypeKind::TypeAlias, owner, mods, line, column, self.s.line(mods.start));
            td.end_line = line;
            self.m.types.push(td);
        }
        if self.p(self.pos, b'<') {
            self.type_params(Some(idx));
        }
        if self.p(self.pos, b'=') {
            self.pos += 1;
            let t = self.parse_type(R_TYPE, n, self.build);
            if let Some(td) = self.td(Some(idx)) {
                td.aliased = t;
            }
        }
    }

    fn type_decl(&mut self, owner: Option<usize>, mods: &Mods<'a>) {
        let n = self.n();
        let kwt = self.s.tx(self.pos);
        let kind = match kwt {
            "interface" => TypeKind::Interface,
            "object" => TypeKind::Object,
            _ if mods.is_enum => TypeKind::Enum,
            _ if mods.is_annotation => TypeKind::Annotation,
            _ => TypeKind::Class,
        };
        let kw_tok = self.pos;
        self.set(kw_tok, R_SKIP);
        self.pos += 1;
        let (name, name_tok) = if self.s.is_word(self.pos) && !self.kw(self.pos, "where") {
            let t = self.pos;
            self.set(t, R_DECL);
            self.pos += 1;
            (self.s.tx(t), t)
        } else if kind == TypeKind::Object && mods.is_companion {
            ("Companion", kw_tok)
        } else {
            ("", kw_tok)
        };
        let idx = self.m.types.len();
        if self.build {
            let (line, column) = self.s.lc(name_tok);
            let mut td = new_type(name, kind, owner, mods, line, column, self.s.line(mods.start));
            td.end_line = line;
            self.m.types.push(td);
        }
        let idx_o = Some(idx);
        if self.p(self.pos, b'<') {
            self.type_params(idx_o);
        }
        self.primary_ctor(idx, name, name_tok);
        if self.colon1(self.pos) {
            self.pos += 1;
            self.supertypes(idx_o);
        }
        if self.kw(self.pos, "where") {
            self.where_clause();
        }
        if self.p(self.pos, b'{') {
            let open = self.pos;
            if self.depth >= MAX_DEPTH {
                let end = self.s.match_brace(open);
                self.pos = (end + 1).min(n);
                return;
            }
            self.depth += 1;
            self.pos += 1;
            if kind == TypeKind::Enum {
                self.enum_entries(idx);
            }
            self.members(idx_o, Some(kind));
            self.depth -= 1;
            let close = self.pos;
            if self.p(close, b'}') {
                let l = self.s.line(close);
                if let Some(td) = self.td(idx_o) {
                    td.end_line = l;
                }
                self.pos += 1;
            }
        }
    }

    fn colon1(&self, i: usize) -> bool {
        self.s.colon1(i)
    }

    /// `<T : Bound, out R>`. The cursor is on `<`.
    fn type_params(&mut self, idx: Option<usize>) {
        let n = self.n();
        self.pos += 1;
        loop {
            if self.pos >= n || self.p(self.pos, b'>') {
                break;
            }
            let before = self.pos;
            let mut dummy = Mods::default();
            while self.p(self.pos, b'@') {
                self.annotation(&mut dummy);
            }
            while (self.kw(self.pos, "in") || self.kw(self.pos, "out") || self.kw(self.pos, "reified"))
                && self.s.is_word(self.pos + 1)
            {
                self.set(self.pos, R_SKIP);
                self.pos += 1;
            }
            if self.s.is_word(self.pos) {
                let t = self.pos;
                self.set(t, R_DECL);
                let name = self.mk(self.s.tx(t));
                if let Some(td) = self.td(idx) {
                    td.type_params.push(name);
                }
                self.pos += 1;
                if self.colon1(self.pos) {
                    self.pos += 1;
                    let _ = self.parse_type(R_TYPE, n, false);
                    // Several bounds are not allowed here, but be tolerant.
                    while self.p(self.pos, b'&') {
                        self.pos += 1;
                        let _ = self.parse_type(R_TYPE, n, false);
                    }
                }
            }
            if self.p(self.pos, b',') {
                self.pos += 1;
            } else if !self.p(self.pos, b'>') {
                if self.pos == before {
                    self.pos += 1;
                }
                if self.p(self.pos, b'{') || self.p(self.pos, b'(') || self.p(self.pos, b'=') {
                    return;
                }
            }
        }
        if self.p(self.pos, b'>') {
            self.pos += 1;
        }
    }

    fn primary_ctor(&mut self, idx: usize, name: &str, name_tok: usize) {
        let n = self.n();
        let save = self.pos;
        let mut vis = Visibility::Public;
        let mut dummy = Mods::default();
        loop {
            if self.p(self.pos, b'@') {
                self.annotation(&mut dummy);
            } else if self.s.is_id(self.pos)
                && matches!(self.s.tx(self.pos), "private" | "protected" | "internal" | "public")
                && self.kw(self.pos + 1, "constructor")
            {
                vis = match self.s.tx(self.pos) {
                    "private" => Visibility::Private,
                    "protected" => Visibility::Protected,
                    "internal" => Visibility::Internal,
                    _ => Visibility::Public,
                };
                self.set(self.pos, R_SKIP);
                self.pos += 1;
            } else if self.kw(self.pos, "constructor") && self.p(self.pos + 1, b'(') {
                self.set(self.pos, R_SKIP);
                self.pos += 1;
                break;
            } else {
                break;
            }
        }
        if !self.p(self.pos, b'(') || self.pos >= n {
            self.pos = save;
            return;
        }
        let params = self.params(Some(idx), true);
        if self.build {
            let (line, column) = self.s.lc(name_tok);
            let member = Member {
                name: name.to_string(),
                kind: MemberKind::Constructor,
                visibility: vis,
                is_static: false,
                is_abstract: false,
                ty: None,
                params,
                mutable: false,
                receiver: None,
                line,
                column,
            };
            if let Some(td) = self.m.types.get_mut(idx) {
                td.methods.push(member);
            }
        }
    }

    /// Parameter list. The cursor is on `(`. For a primary constructor
    /// (`ctor_of` is set) `val` and `var` parameters become properties.
    fn params(&mut self, owner: Option<usize>, primary: bool) -> Vec<Param> {
        let n = self.n();
        let ctor_of = if primary { owner } else { None };
        let end = self.s.match_paren(self.pos);
        self.pos += 1;
        let mut out = Vec::new();
        while self.pos < end.min(n) {
            let before = self.pos;
            let mods = self.modifiers();
            let mut is_val = false;
            let mut is_var = false;
            if self.kw(self.pos, "val") || self.kw(self.pos, "var") {
                is_var = self.kw(self.pos, "var");
                is_val = !is_var;
                self.set(self.pos, R_SKIP);
                self.pos += 1;
            }
            if self.s.is_word(self.pos) && self.pos < end {
                let t = self.pos;
                self.set(t, R_DECL);
                self.pos += 1;
                let mut ty = None;
                if self.colon1(self.pos) {
                    self.pos += 1;
                    ty = self.parse_type(R_TYPE, end, self.build);
                }
                if self.p(self.pos, b'=') {
                    self.pos += 1;
                    let e = self.arg_end(self.pos, end);
                    self.scan_range(self.pos, e, owner);
                    self.pos = e;
                }
                if self.build {
                    let name = self.s.tx(t).to_string();
                    if ctor_of.is_some() && (is_val || is_var) {
                        let (line, column) = self.s.lc(t);
                        let vis = mods.vis.unwrap_or(Visibility::Public);
                        let f = Member {
                            name: name.clone(),
                            kind: MemberKind::Property,
                            visibility: vis,
                            is_static: false,
                            is_abstract: false,
                            ty: ty.clone(),
                            params: Vec::new(),
                            mutable: is_var,
                            receiver: None,
                            line,
                            column,
                        };
                        if let Some(td) = ctor_of.and_then(|o| self.m.types.get_mut(o)) {
                            td.fields.push(f);
                        }
                    }
                    out.push(Param { name, ty });
                }
            }
            if self.p(self.pos, b',') || self.pos == before || self.pos < end {
                // A comma, or junk in the list: skip one token.
                self.pos += 1;
            }
        }
        self.pos = (end + 1).min(n);
        out
    }

    /// End of a default value or an argument: the next `,` or the closer at depth 0.
    fn arg_end(&self, from: usize, limit: usize) -> usize {
        let n = self.n().min(limit);
        let mut depth = 0i32;
        let mut j = from;
        while j < n {
            let t = &self.s.toks[j];
            if t.kind == K::P {
                match t.ch {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => {
                        if depth == 0 {
                            return j;
                        }
                        depth -= 1;
                    }
                    b',' if depth == 0 => return j,
                    b'<' if j > 0 && self.s.is_word(j - 1) && self.s.adj(j - 1) => {
                        if let Some(e) = self.s.try_type_args(j) {
                            j = e;
                            continue;
                        }
                    }
                    _ => {}
                }
            }
            j += 1;
        }
        n
    }

    fn supertypes(&mut self, idx: Option<usize>) {
        let n = self.n();
        loop {
            let before = self.pos;
            let mut dummy = Mods::default();
            while self.p(self.pos, b'@') {
                self.annotation(&mut dummy);
            }
            let Some(ty) = self.parse_type(R_SUPER, n, self.build) else {
                break;
            };
            let mut kind = SuperKind::Unknown;
            let mut delegated = false;
            if self.p(self.pos, b'(') && !self.s.nl(self.pos) {
                let end = self.s.match_paren(self.pos);
                self.scan_range(self.pos + 1, end, idx);
                self.pos = (end + 1).min(n);
                kind = SuperKind::Extends;
            } else if self.kw(self.pos, "by") {
                self.set(self.pos, R_SKIP);
                self.pos += 1;
                delegated = true;
                let e = self.delegate_end(self.pos);
                self.scan_range(self.pos, e, idx);
                self.pos = e;
            }
            if let Some(td) = self.td(idx) {
                td.supertypes.push(SuperType { ty, kind, delegated });
            }
            if self.p(self.pos, b',') {
                self.pos += 1;
            } else {
                break;
            }
            if self.pos == before {
                break;
            }
        }
    }

    /// The expression after `by` in a supertype list ends at `,` or `{`.
    fn delegate_end(&self, from: usize) -> usize {
        let n = self.n();
        let mut depth = 0i32;
        let mut j = from;
        while j < n {
            let t = &self.s.toks[j];
            if t.kind == K::P {
                match t.ch {
                    b'(' | b'[' => depth += 1,
                    b')' | b']' => depth -= 1,
                    b',' | b'{' if depth <= 0 => return j,
                    b'}' if depth <= 0 => return j,
                    _ => {}
                }
            }
            if j > from && t.nl && depth <= 0 {
                return j;
            }
            j += 1;
        }
        n
    }

    fn where_clause(&mut self) {
        let n = self.n();
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        loop {
            if self.s.is_word(self.pos) && self.colon1(self.pos + 1) {
                self.set(self.pos, R_TYPE);
                self.pos += 2;
                let _ = self.parse_type(R_TYPE, n, false);
                if self.p(self.pos, b',') {
                    self.pos += 1;
                    continue;
                }
            }
            break;
        }
    }

    fn enum_entries(&mut self, idx: usize) {
        let n = self.n();
        let idx_o = Some(idx);
        loop {
            let mut dummy = Mods::default();
            while self.p(self.pos, b'@') {
                self.annotation(&mut dummy);
            }
            if self.pos >= n || self.p(self.pos, b'}') {
                return;
            }
            if self.p(self.pos, b';') {
                self.pos += 1;
                return;
            }
            if !self.s.is_word(self.pos) {
                return;
            }
            let t = self.pos;
            let text = self.s.tx(t);
            if self.s.is_id(t) && (is_modifier(text) || matches!(text, "fun" | "val" | "var" | "class" | "object" | "interface" | "init" | "constructor" | "typealias"))
                && !self.p(t + 1, b',')
                && !self.p(t + 1, b';')
                && !self.p(t + 1, b'}')
            {
                return;
            }
            self.set(t, R_DECL);
            self.pos += 1;
            if self.p(self.pos, b'(') && !self.s.nl(self.pos) {
                let end = self.s.match_paren(self.pos);
                self.scan_range(self.pos + 1, end, idx_o);
                self.pos = (end + 1).min(n);
            }
            if self.p(self.pos, b'{') {
                let end = self.s.match_brace(self.pos);
                self.scan_range(self.pos + 1, end, idx_o);
                self.pos = (end + 1).min(n);
            }
            if self.build {
                let (line, column) = self.s.lc(t);
                let m = Member {
                    name: text.to_string(),
                    kind: MemberKind::EnumCase,
                    visibility: Visibility::Public,
                    is_static: true,
                    is_abstract: false,
                    ty: None,
                    params: Vec::new(),
                    mutable: false,
                    receiver: None,
                    line,
                    column,
                };
                if let Some(td) = self.td(idx_o) {
                    td.fields.push(m);
                }
            }
            if self.p(self.pos, b',') {
                self.pos += 1;
            } else if !(self.p(self.pos, b';') || self.p(self.pos, b'}')) {
                return;
            }
        }
    }

    /// Index of the function name: the word in front of the `(` of the
    /// parameter list. The receiver type can come before it.
    fn find_fun_name(&self, from: usize) -> Option<usize> {
        let n = self.n().min(from + 600);
        let mut j = from;
        while j < n {
            let t = &self.s.toks[j];
            if t.kind == K::P {
                match t.ch {
                    b'<' => {
                        if let Some(e) = self.s.try_type_args(j) {
                            j = e;
                            continue;
                        }
                    }
                    b'(' => {
                        if j > from && self.s.is_word(j - 1) {
                            return Some(j - 1);
                        }
                        j = self.s.match_paren(j) + 1;
                        continue;
                    }
                    b'{' | b'=' | b';' | b'}' => return None,
                    _ => {}
                }
            }
            j += 1;
        }
        None
    }

    fn function(&mut self, owner: Option<usize>, kind: Option<TypeKind>, mods: &Mods<'a>) {
        let n = self.n();
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        if self.p(self.pos, b'<') {
            self.type_params(None);
        }
        let start = self.pos;
        let Some(name_idx) = self.find_fun_name(start) else {
            return;
        };
        let mut receiver = None;
        if name_idx > start + 1 && self.p(name_idx - 1, b'.') {
            self.pos = start;
            receiver = self.parse_type(R_TYPE, name_idx - 1, self.build);
        }
        self.set(name_idx, R_DECL);
        self.pos = name_idx + 1;
        let params = self.params(owner, false);
        let mut ret = None;
        if self.colon1(self.pos) {
            self.pos += 1;
            ret = self.parse_type(R_TYPE, n, self.build);
        }
        if self.kw(self.pos, "where") {
            self.where_clause();
        }
        let mut has_body = false;
        if self.p(self.pos, b'{') {
            let end = self.s.match_brace(self.pos);
            self.scan_range(self.pos + 1, end, owner);
            self.pos = (end + 1).min(n);
            has_body = true;
        } else if self.p(self.pos, b'=') {
            self.pos += 1;
            let e = self.expr_end(self.pos);
            self.scan_range(self.pos, e, owner);
            self.pos = e;
            has_body = true;
        }
        if self.build {
            let (line, column) = self.s.lc(name_idx);
            let in_iface = kind == Some(TypeKind::Interface);
            let m = Member {
                name: self.s.tx(name_idx).to_string(),
                kind: MemberKind::Method,
                visibility: self.vis_of(mods),
                is_static: false,
                is_abstract: mods.is_abstract || (in_iface && !has_body),
                ty: ret,
                params,
                mutable: false,
                receiver,
                line,
                column,
            };
            self.push_member(owner, m, true);
        }
    }

    fn push_member(&mut self, owner: Option<usize>, m: Member, method: bool) {
        match owner.and_then(|o| self.m.types.get_mut(o)) {
            Some(td) => {
                if method {
                    td.methods.push(m)
                } else {
                    td.fields.push(m)
                }
            }
            None => self.m.top_level.push(m),
        }
    }

    fn secondary_ctor(&mut self, owner: Option<usize>, mods: &Mods<'a>) {
        let n = self.n();
        let kw_tok = self.pos;
        self.set(kw_tok, R_SKIP);
        self.pos += 1;
        let params = self.params(owner, false);
        if self.colon1(self.pos) {
            self.pos += 1;
            if (self.kw(self.pos, "this") || self.kw(self.pos, "super")) && self.p(self.pos + 1, b'(') {
                let end = self.s.match_paren(self.pos + 1);
                self.scan_range(self.pos + 2, end, owner);
                self.pos = (end + 1).min(n);
            }
        }
        if self.p(self.pos, b'{') {
            let end = self.s.match_brace(self.pos);
            self.scan_range(self.pos + 1, end, owner);
            self.pos = (end + 1).min(n);
        }
        if self.build {
            let (line, column) = self.s.lc(kw_tok);
            let name = owner
                .and_then(|o| self.m.types.get(o))
                .map(|t| t.name.clone())
                .unwrap_or_default();
            let m = Member {
                name,
                kind: MemberKind::Constructor,
                visibility: self.vis_of(mods),
                is_static: false,
                is_abstract: false,
                ty: None,
                params,
                mutable: false,
                receiver: None,
                line,
                column,
            };
            self.push_member(owner, m, true);
        }
    }

    fn property(&mut self, owner: Option<usize>, kind: Option<TypeKind>, mods: &Mods<'a>) {
        let n = self.n();
        let mutable = self.kw(self.pos, "var");
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        if self.p(self.pos, b'<') {
            self.type_params(None);
        }
        let start = self.pos;
        if self.p(start, b'(') {
            // Destructuring: `val (a, b) = pair`.
            let end = self.s.match_paren(start);
            for j in start + 1..end.min(n) {
                if self.s.is_word(j) {
                    self.set(j, R_DECL);
                }
            }
            self.pos = (end + 1).min(n);
            if self.colon1(self.pos) {
                self.pos += 1;
                let _ = self.parse_type(R_TYPE, n, false);
            }
            if self.p(self.pos, b'=') {
                self.pos += 1;
                let e = self.expr_end(self.pos);
                self.scan_range(self.pos, e, owner);
                self.pos = e;
            }
            return;
        }
        let mut name_idx = None;
        let mut j = start;
        while self.s.is_word(j) {
            name_idx = Some(j);
            j += 1;
            if self.p(j, b'<') {
                match self.s.try_type_args(j) {
                    Some(e) => j = e,
                    None => break,
                }
            }
            if self.p(j, b'.') && (self.s.is_word(j + 1) || self.p(j + 1, b'(')) {
                j += 1;
                continue;
            }
            break;
        }
        let Some(name_idx) = name_idx else {
            return;
        };
        let mut receiver = None;
        if name_idx > start + 1 && self.p(name_idx - 1, b'.') {
            self.pos = start;
            receiver = self.parse_type(R_TYPE, name_idx - 1, self.build);
        }
        self.set(name_idx, R_DECL);
        self.pos = name_idx + 1;
        let mut ty = None;
        if self.colon1(self.pos) {
            self.pos += 1;
            ty = self.parse_type(R_TYPE, n, self.build);
        }
        if self.kw(self.pos, "where") {
            self.where_clause();
        }
        let mut has_init = false;
        if self.p(self.pos, b'=') {
            self.pos += 1;
            let e = self.expr_end(self.pos);
            if self.build && ty.is_none() {
                ty = self.infer_ctor(self.pos, e);
            }
            self.scan_range(self.pos, e, owner);
            self.pos = e;
            has_init = true;
        } else if self.kw(self.pos, "by") {
            self.set(self.pos, R_SKIP);
            self.pos += 1;
            let e = self.expr_end(self.pos);
            self.scan_range(self.pos, e, owner);
            self.pos = e;
            has_init = true;
        }
        // Getter and setter.
        loop {
            let mut j = self.pos;
            while self.s.is_id(j)
                && matches!(self.s.tx(j), "private" | "protected" | "internal" | "public" | "inline" | "external")
            {
                j += 1;
            }
            let acc = self.kw(j, "get") || self.kw(j, "set");
            let looks = acc && (self.p(j + 1, b'(') || self.p(j + 1, b'{') || self.p(j + 1, b'='));
            if !looks {
                break;
            }
            has_init = true;
            for k in self.pos..j {
                self.set(k, R_SKIP);
            }
            self.set(j, R_SKIP);
            self.pos = j + 1;
            if self.p(self.pos, b'(') {
                let end = self.s.match_paren(self.pos);
                for k in self.pos + 1..end.min(n) {
                    if self.s.is_word(k) && self.roles[k] == R_NONE {
                        self.roles[k] = R_DECL;
                    }
                }
                self.pos = (end + 1).min(n);
            }
            if self.colon1(self.pos) {
                self.pos += 1;
                let _ = self.parse_type(R_TYPE, n, false);
            }
            if self.p(self.pos, b'{') {
                let end = self.s.match_brace(self.pos);
                self.scan_range(self.pos + 1, end, owner);
                self.pos = (end + 1).min(n);
            } else if self.p(self.pos, b'=') {
                self.pos += 1;
                let e = self.expr_end(self.pos);
                self.scan_range(self.pos, e, owner);
                self.pos = e;
            }
        }
        if self.build {
            let (line, column) = self.s.lc(name_idx);
            let in_iface = kind == Some(TypeKind::Interface);
            let m = Member {
                name: self.s.tx(name_idx).to_string(),
                kind: MemberKind::Property,
                visibility: self.vis_of(mods),
                is_static: false,
                is_abstract: mods.is_abstract || (in_iface && !has_init),
                ty,
                params: Vec::new(),
                mutable,
                receiver,
                line,
                column,
            };
            self.push_member(owner, m, false);
        }
    }

    /// `val x = Foo(...)`: the type `Foo`.
    fn infer_ctor(&mut self, from: usize, end: usize) -> Option<TypeRef> {
        if !self.s.is_word(from) {
            return None;
        }
        let save = self.pos;
        self.pos = from;
        let t = self.parse_type(R_NONE, end, true);
        let ok = self.p(self.pos, b'(') && self.pos < end;
        self.pos = save;
        let t = t?;
        if !ok || t.name.is_empty() {
            return None;
        }
        let last = t.name.rsplit('.').next().unwrap_or("");
        if is_upper_start(last) { Some(t) } else { None }
    }

    /// End of an expression or statement that starts at `from`.
    fn expr_end(&self, from: usize) -> usize {
        let n = self.n();
        let mut depth = 0i32;
        let mut j = from;
        while j < n {
            let t = &self.s.toks[j];
            if depth == 0 && j > from && t.nl && !self.continues(j) {
                return j;
            }
            if t.kind == K::P {
                match t.ch {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => {
                        if depth == 0 {
                            return j;
                        }
                        depth -= 1;
                    }
                    b';' if depth == 0 => return j,
                    _ => {}
                }
            }
            j += 1;
        }
        n
    }

    /// The token `j` starts a new line. Does the expression go on?
    fn continues(&self, j: usize) -> bool {
        let t = &self.s.toks[j];
        if t.kind == K::P {
            match t.ch {
                b'.' => return true,
                b'?' => return true,
                b'&' | b'|' => return true,
                b':' => return self.s.dcolon(j),
                b'-' if self.s.is_p(j + 1, b'>') && self.s.adj(j) => return true,
                _ => {}
            }
        }
        if t.kind == K::Ident && matches!(self.s.tx(j), "else" | "catch" | "finally" | "as" | "is" | "in" | "by") {
            return true;
        }
        // The line before ends with an operator.
        if j >= 1 {
            let p = &self.s.toks[j - 1];
            if p.kind == K::P {
                return match p.ch {
                    b'=' | b'*' | b'/' | b'%' | b'&' | b'|' | b',' | b'.' | b':' | b'(' | b'[' | b'{' => true,
                    b'+' | b'-' => !(j >= 2 && self.s.is_p(j - 2, p.ch) && self.s.adj(j - 2)),
                    b'>' => j >= 2 && self.s.is_p(j - 2, b'-') && self.s.adj(j - 2),
                    _ => false,
                };
            }
            if p.kind == K::Ident && matches!(self.s.tx(j - 1), "in" | "is" | "as" | "by" | "else" | "return" | "throw") {
                return true;
            }
        }
        false
    }

    // ---------------------------------------------------------------
    // Types

    /// Reads a type at the cursor. Marks the names with `role` (not when
    /// `role` is `R_NONE`). Builds the `TypeRef` only when `want` is set.
    fn parse_type(&mut self, role: u8, lim: usize, want: bool) -> Option<TypeRef> {
        if self.tdepth >= 40 {
            return None;
        }
        self.tdepth += 1;
        let r = self.parse_type_inner(role, lim.min(self.n()), want);
        self.tdepth -= 1;
        r
    }

    fn parse_type_inner(&mut self, role: u8, lim: usize, want: bool) -> Option<TypeRef> {
        let mut dummy = Mods::default();
        loop {
            if self.p(self.pos, b'@') && self.s.is_word(self.pos + 1) && self.pos < lim {
                self.annotation(&mut dummy);
            } else if self.kw(self.pos, "suspend") && self.pos + 1 < lim && (self.p(self.pos + 1, b'(') || self.s.is_word(self.pos + 1)) {
                self.set(self.pos, R_SKIP);
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos >= lim {
            return None;
        }
        let first = self.pos;
        let mut name = String::new();
        let mut args: Vec<TypeRef> = Vec::new();
        let mut nullable = false;
        if self.p(first, b'(') {
            let close = self.s.match_paren(first).min(lim);
            self.pos += 1;
            let mut inner: Vec<TypeRef> = Vec::new();
            while self.pos < close {
                let before = self.pos;
                if self.s.is_word(self.pos) && self.colon1(self.pos + 1) {
                    self.pos += 2;
                }
                if let Some(t) = self.parse_type(R_TYPE, close, want) {
                    inner.push(t);
                }
                if self.p(self.pos, b',') {
                    self.pos += 1;
                } else if self.pos == before || self.pos < close {
                    if self.pos == before {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
            }
            self.pos = (close + 1).min(self.n());
            if self.s.arrow(self.pos) && self.pos < lim {
                self.pos += 2;
                let ret = self.parse_type(R_TYPE, lim, want);
                args = inner;
                if let Some(r) = ret {
                    args.push(r);
                }
            } else if inner.len() == 1 {
                // A type in parentheses.
                let t = inner.pop().unwrap_or_default();
                name = t.name;
                args = t.args;
            }
        } else if self.s.is_word(first) {
            self.note_chain(first);
            loop {
                let t = self.pos;
                if !self.s.is_word(t) || t >= lim {
                    break;
                }
                if role != R_NONE {
                    self.set(t, role);
                }
                if want {
                    if !name.is_empty() {
                        name.push('.');
                    }
                    name.push_str(self.s.tx(t));
                }
                self.pos += 1;
                if self.p(self.pos, b'<') && self.pos < lim {
                    let a = self.type_args(R_TYPE, lim, want);
                    if want {
                        args = a;
                    }
                }
                if self.p(self.pos, b'.') && self.pos + 1 < lim {
                    if self.s.is_word(self.pos + 1) {
                        self.pos += 1;
                        continue;
                    }
                    if self.p(self.pos + 1, b'(') {
                        // Function type with a receiver: `A.(B) -> C`.
                        let recv = TypeRef { text: name.clone(), name: name.clone(), args: std::mem::take(&mut args), nullable: false, array: false };
                        self.pos += 1;
                        let f = self.parse_type(R_TYPE, lim, want);
                        name.clear();
                        if want {
                            args.push(recv);
                            if let Some(f) = f {
                                args.extend(f.args);
                            }
                        }
                    }
                }
                break;
            }
        } else {
            return None;
        }
        // `?` after the type. `?:` and `?.` belong to the code.
        while self.p(self.pos, b'?') && self.pos < lim && !((self.p(self.pos + 1, b':') || self.p(self.pos + 1, b'.')) && self.s.adj(self.pos)) {
            nullable = true;
            self.pos += 1;
        }
        if !want {
            return Some(TypeRef::default());
        }
        let last = self.pos.saturating_sub(1).max(first);
        let text = self.s.span_text(first, last);
        Some(TypeRef { text, name, args, nullable, array: false })
    }

    /// `<A, out B, *>`. The cursor is on `<`.
    fn type_args(&mut self, role: u8, lim: usize, want: bool) -> Vec<TypeRef> {
        let mut out = Vec::new();
        self.pos += 1;
        loop {
            if self.pos >= lim {
                break;
            }
            if self.p(self.pos, b'>') {
                self.pos += 1;
                break;
            }
            let before = self.pos;
            if self.p(self.pos, b'*') {
                self.pos += 1;
            } else {
                while (self.kw(self.pos, "in") || self.kw(self.pos, "out")) && (self.s.is_word(self.pos + 1) || self.p(self.pos + 1, b'(')) {
                    self.set(self.pos, R_SKIP);
                    self.pos += 1;
                }
                if let Some(t) = self.parse_type(role, lim, want) {
                    out.push(t);
                }
            }
            if self.p(self.pos, b',') {
                self.pos += 1;
            } else if !self.p(self.pos, b'>') {
                if self.pos == before {
                    self.pos += 1;
                }
                if matches!(self.s.toks.get(self.pos), Some(t) if t.kind == K::P && matches!(t.ch, b';' | b'{' | b'}' | b'=' | b'(' | b')')) {
                    break;
                }
            }
        }
        out
    }

    // ---------------------------------------------------------------
    // Code scanning

    /// Looks at the code tokens in `lo..hi`: marks how names are used and
    /// collects the types for `owner`.
    fn scan_range(&mut self, lo: usize, hi: usize, owner: Option<usize>) {
        let hi = hi.min(self.n());
        let saved = (self.collect, self.body_owner, self.pos);
        self.collect = self.build && owner.is_some();
        self.body_owner = owner;
        let mut i = lo;
        while i < hi {
            let t = self.s.toks[i];
            let next = match t.kind {
                K::P => match t.ch {
                    b'@' => self.scan_annotation(i, hi),
                    b':' => self.scan_colon(i, hi),
                    _ => i + 1,
                },
                K::Ident | K::Tick => self.scan_word(i, hi),
                _ => i + 1,
            };
            i = next.max(i + 1);
        }
        self.collect = saved.0;
        self.body_owner = saved.1;
        self.pos = saved.2;
    }

    fn mark_type_at(&mut self, j: usize, hi: usize, role: u8) -> usize {
        self.pos = j;
        let _ = self.parse_type(role, hi, false);
        self.pos.max(j)
    }

    fn scan_colon(&mut self, i: usize, hi: usize) -> usize {
        if self.s.dcolon(i) {
            return i + 2;
        }
        if i > 0 && self.s.dcolon(i - 1) {
            return i + 1;
        }
        let role = if i > 0 && self.kw(i - 1, "object") { R_SUPER } else { R_TYPE };
        if i > 0 && self.s.is_word(i - 1) && !(self.s.is_id(i - 1) && is_hard_kw(self.s.tx(i - 1))) {
            self.set(i - 1, R_DECL);
        }
        let mut j = i + 1;
        loop {
            let e = self.mark_type_at(j, hi, role);
            // Supertype lists: `object : A(), B { }`.
            if role == R_SUPER {
                let mut e2 = e;
                if self.p(e2, b'(') {
                    e2 = self.s.match_paren(e2) + 1;
                }
                if self.p(e2, b',') {
                    j = e2 + 1;
                    continue;
                }
            }
            return e;
        }
    }

    fn scan_annotation(&mut self, i: usize, hi: usize) -> usize {
        // `return@label` and `this@Foo` are labels.
        if i > 0 && self.s.adj(i - 1) && self.s.is_word(i - 1) {
            if self.s.is_word(i + 1) && self.s.adj(i) {
                self.set(i + 1, R_REF);
                return i + 2;
            }
            return i + 1;
        }
        let mut j = i + 1;
        if self.s.is_word(j) && self.colon1(j + 1) && matches!(self.s.tx(j), "file" | "field" | "get" | "set" | "param" | "property" | "receiver" | "setparam" | "delegate") {
            self.set(j, R_SKIP);
            j += 2;
        }
        if !self.s.is_word(j) {
            return i + 1;
        }
        self.note_chain(j);
        while self.s.is_word(j) {
            self.set(j, R_TYPE);
            if self.p(j + 1, b'.') && self.s.is_word(j + 2) {
                j += 2;
            } else {
                j += 1;
                break;
            }
        }
        let _ = hi;
        j
    }

    fn scan_word(&mut self, i: usize, hi: usize) -> usize {
        if self.s.is_id(i) {
            let t = self.s.tx(i);
            if is_hard_kw(t) {
                return self.scan_keyword(i, t, hi);
            }
        }
        let prev_member = i > 0 && (self.p(i - 1, b'.') || (i > 1 && self.s.dcolon(i - 2)));
        if !prev_member {
            self.note_chain(i);
        }
        if self.roles[i] != R_NONE {
            return i + 1;
        }
        let nx = i + 1;
        if self.p(nx, b'(') {
            self.set(i, R_CALL);
            return nx;
        }
        if self.p(nx, b'{') && !self.s.nl(nx) {
            let prev_decl = i > 0 && self.s.is_id(i - 1) && matches!(self.s.tx(i - 1), "class" | "object" | "interface" | "fun");
            if !prev_decl && !matches!(self.s.tx(i), "init" | "get" | "set") {
                self.set(i, R_CALL);
            }
            return nx;
        }
        if self.p(nx, b'<') && self.s.adj(i) {
            if let Some(e) = self.s.try_type_args(nx) {
                self.pos = nx;
                let _ = self.type_args(R_TYPE, e, false);
                if self.p(e, b'(') || (self.p(e, b'{') && !self.s.nl(e)) {
                    self.set(i, R_CALL);
                }
                return e;
            }
        }
        if self.s.dcolon(nx) && self.kw(nx + 2, "class") {
            self.set(i, R_TYPE);
            return nx;
        }
        nx
    }

    fn scan_keyword(&mut self, i: usize, t: &str, hi: usize) -> usize {
        match t {
            "is" | "as" => {
                self.set(i, R_SKIP);
                let mut j = i + 1;
                if t == "as" && self.p(j, b'?') && self.s.adj(i) {
                    j += 1;
                }
                self.mark_type_at(j, hi, R_TYPE)
            }
            "class" | "interface" | "typealias" => {
                self.set(i, R_SKIP);
                if self.s.is_word(i + 1) {
                    self.set(i + 1, R_DECL);
                    return i + 2;
                }
                i + 1
            }
            "object" => {
                self.set(i, R_SKIP);
                if self.s.is_word(i + 1) && !self.colon1(i + 1) {
                    self.set(i + 1, R_DECL);
                    return i + 2;
                }
                i + 1
            }
            "fun" => {
                self.set(i, R_SKIP);
                if self.s.is_word(i + 1) && self.p(i + 2, b'(') {
                    self.set(i + 1, R_DECL);
                    return i + 2;
                }
                i + 1
            }
            "val" | "var" => {
                self.set(i, R_SKIP);
                if self.s.is_word(i + 1) {
                    self.set(i + 1, R_DECL);
                    return i + 2;
                }
                if self.p(i + 1, b'(') {
                    let end = self.s.match_paren(i + 1).min(hi);
                    for j in i + 2..end {
                        if self.s.is_word(j) {
                            self.set(j, R_DECL);
                        }
                    }
                    return end + 1;
                }
                i + 1
            }
            _ => i + 1,
        }
    }
}

fn new_type(name: &str, kind: TypeKind, owner: Option<usize>, mods: &Mods, line: u32, column: u32, start_line: u32) -> TypeDecl {
    TypeDecl {
        name: name.to_string(),
        kind,
        outer: owner,
        modifiers: mods.list.iter().map(|s| s.to_string()).collect(),
        annotations: mods.annos.iter().map(|s| s.to_string()).collect(),
        type_params: Vec::new(),
        supertypes: Vec::new(),
        aliased: None,
        fields: Vec::new(),
        methods: Vec::new(),
        used_types: Vec::new(),
        line,
        column,
        start_line,
        end_line: line,
    }
}
