//! Java parser. It reads declarations and skips the inside of bodies, but
//! it still looks at every body token to find type names and the use of
//! identifiers. See `jvm_lex.rs` for the tokens.

use crate::jvm_lex::*;
use crate::model::*;

pub(crate) fn parse(text: &str) -> FileModel {
    let mut p = P::new(text, true);
    p.members(None, None);
    p.finish();
    p.m
}

pub(crate) fn find_identifiers(text: &str, name: &str) -> Vec<IdentHit> {
    let mut p = P::new(text, false);
    p.members(None, None);
    collect_hits(&p.s, &p.roles, name)
}

const MAX_DEPTH: u32 = 64;

fn is_primitive(s: &str) -> bool {
    matches!(s, "int" | "long" | "short" | "byte" | "char" | "boolean" | "float" | "double" | "void" | "var")
}

/// Words that are never a type or a call in code.
fn is_kw(s: &str) -> bool {
    is_primitive(s)
        || matches!(
            s,
            "abstract"
                | "assert"
                | "break"
                | "case"
                | "catch"
                | "class"
                | "const"
                | "continue"
                | "default"
                | "do"
                | "else"
                | "enum"
                | "extends"
                | "final"
                | "finally"
                | "for"
                | "goto"
                | "if"
                | "implements"
                | "import"
                | "instanceof"
                | "interface"
                | "native"
                | "new"
                | "package"
                | "private"
                | "protected"
                | "public"
                | "return"
                | "static"
                | "strictfp"
                | "super"
                | "switch"
                | "synchronized"
                | "this"
                | "throw"
                | "throws"
                | "transient"
                | "try"
                | "volatile"
                | "while"
                | "true"
                | "false"
                | "null"
                | "yield"
                | "permits"
        )
}

#[derive(Default)]
struct Mods<'a> {
    list: Vec<&'a str>,
    annos: Vec<&'a str>,
    vis: Option<Visibility>,
    is_static: bool,
    is_abstract: bool,
    is_final: bool,
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
    collect: bool,
    body_owner: Option<usize>,
    scratch: String,
}

impl<'a> P<'a> {
    fn new(text: &'a str, build: bool) -> P<'a> {
        let s = Src::new(text, false, build);
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

    /// Makes the end lines consistent after parsing.
    fn finish(&mut self) {
        for t in self.m.types.iter_mut() {
            for f in t.fields.iter_mut().chain(t.methods.iter_mut()) {
                f.end_line = f.end_line.max(f.line);
                t.end_line = t.end_line.max(f.end_line);
            }
        }
        for f in self.m.top_level.iter_mut() {
            f.end_line = f.end_line.max(f.line);
        }
        for i in (0..self.m.types.len()).rev() {
            let (e, o) = (self.m.types[i].end_line, self.m.types[i].outer);
            if let Some(o) = o.and_then(|o| self.m.types.get_mut(o)) {
                o.end_line = o.end_line.max(e);
            }
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

    /// A plain name that is not a keyword.
    fn name_at(&self, i: usize) -> bool {
        self.s.is_id(i) && !is_kw(self.s.tx(i))
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
        if last == 0 && matches!(self.s.tx(segs[0]), "this" | "super") {
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
    // Declarations

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
                if self.kw(i + 1, "interface") || !self.s.is_word(i + 1) {
                    break;
                }
                self.annotation(&mut m);
                continue;
            }
            if !self.s.is_id(i) {
                break;
            }
            let t = self.s.tx(i);
            let mut text = t;
            let mut width = 1;
            let is_mod = match t {
                "public" | "private" | "protected" | "static" | "final" | "abstract" | "native" | "synchronized"
                | "transient" | "volatile" | "strictfp" => !(t == "synchronized" && self.p(i + 1, b'(')),
                "default" => self.s.is_word(i + 1) || self.p(i + 1, b'<'),
                "sealed" => self.s.is_word(i + 1),
                "non" => {
                    if self.p(i + 1, b'-') && self.kw(i + 2, "sealed") && self.s.adj(i) && self.s.adj(i + 1) {
                        text = "non-sealed";
                        width = 3;
                        true
                    } else {
                        false
                    }
                }
                _ => false,
            };
            if !is_mod {
                break;
            }
            for k in 0..width {
                self.set(i + k, R_SKIP);
            }
            match t {
                "public" => m.vis = Some(Visibility::Public),
                "private" => m.vis = Some(Visibility::Private),
                "protected" => m.vis = Some(Visibility::Protected),
                "static" => m.is_static = true,
                "final" => m.is_final = true,
                "abstract" => m.is_abstract = true,
                _ => {}
            }
            if self.build {
                m.list.push(text);
            }
            self.pos += width;
        }
        m
    }

    /// `@Name` or `@a.b.Name(args)`. The cursor is on the `@`.
    fn annotation(&mut self, m: &mut Mods<'a>) {
        let n = self.n();
        self.pos += 1;
        let mut last = self.pos;
        loop {
            self.set(self.pos, R_TYPE);
            last = last.max(self.pos);
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
        if self.p(self.pos, b'(') {
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
        if self.p(i, b'{') {
            let end = self.s.match_brace(i);
            self.scan_range(i + 1, end, owner);
            self.pos = (end + 1).min(n);
            return;
        }
        if self.p(i, b'@') && self.kw(i + 1, "interface") {
            self.type_decl(owner, &mods);
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
                "class" | "interface" => {
                    self.type_decl(owner, &mods);
                    return;
                }
                "enum" if self.s.is_word(i + 1) => {
                    self.type_decl(owner, &mods);
                    return;
                }
                "record" if self.s.is_word(i + 1) && (self.p(i + 2, b'(') || self.p(i + 2, b'<')) => {
                    self.type_decl(owner, &mods);
                    return;
                }
                _ => {}
            }
        }
        if owner.is_none() {
            // Not a declaration at file level: skip it.
            let e = self.stmt_end(i);
            self.scan_range(i, e, None);
            self.pos = e.max(i + 1);
            return;
        }
        self.member(owner, kind, &mods);
    }

    fn package(&mut self) {
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        let mut path = String::new();
        while self.s.is_word(self.pos) {
            self.set(self.pos, R_SKIP);
            path.push_str(self.s.tx(self.pos));
            self.pos += 1;
            if self.p(self.pos, b'.') {
                path.push('.');
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.build {
            self.m.package = path;
        }
    }

    fn import(&mut self) {
        let line = self.s.line(self.pos);
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        let mut is_static = false;
        if self.kw(self.pos, "static") {
            is_static = true;
            self.set(self.pos, R_SKIP);
            self.pos += 1;
        }
        let mut path = String::new();
        let mut wildcard = false;
        while self.s.is_word(self.pos) {
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
                if self.build {
                    path.push('.');
                }
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.build && !path.is_empty() {
            self.m.imports.push(Import { path, wildcard, alias: None, is_static, line });
        }
    }

    fn type_decl(&mut self, owner: Option<usize>, mods: &Mods<'a>) {
        let n = self.n();
        if self.p(self.pos, b'@') {
            self.pos += 1;
        }
        let kwt = self.s.tx(self.pos);
        let kind = match kwt {
            "interface" if self.pos > 0 && self.p(self.pos - 1, b'@') => TypeKind::Annotation,
            "interface" => TypeKind::Interface,
            "enum" => TypeKind::Enum,
            "record" => TypeKind::Record,
            _ => TypeKind::Class,
        };
        self.set(self.pos, R_SKIP);
        self.pos += 1;
        let (name, name_tok) = if self.s.is_word(self.pos) {
            let t = self.pos;
            self.set(t, R_DECL);
            self.pos += 1;
            (self.s.tx(t), t)
        } else {
            ("", self.pos.saturating_sub(1))
        };
        let idx = self.m.types.len();
        if self.build {
            let (line, column) = self.s.lc(name_tok);
            self.m.types.push(TypeDecl {
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
                start_line: self.s.line(mods.start),
                end_line: line,
            });
        }
        let idx_o = Some(idx);
        if self.p(self.pos, b'<') {
            self.type_params(idx_o);
        }
        if kind == TypeKind::Record && self.p(self.pos, b'(') {
            self.record_components(idx);
        }
        let is_iface = matches!(kind, TypeKind::Interface | TypeKind::Annotation);
        loop {
            if self.kw(self.pos, "extends") || self.kw(self.pos, "implements") {
                let ext = self.kw(self.pos, "extends");
                self.set(self.pos, R_SKIP);
                self.pos += 1;
                loop {
                    let before = self.pos;
                    let mut dummy = Mods::default();
                    while self.p(self.pos, b'@') && self.s.is_word(self.pos + 1) {
                        self.annotation(&mut dummy);
                    }
                    let Some(ty) = self.parse_type(R_SUPER, n, self.build) else {
                        break;
                    };
                    let sk = if ext && !is_iface { SuperKind::Extends } else { SuperKind::Implements };
                    if let Some(td) = self.td(idx_o) {
                        td.supertypes.push(SuperType { ty, kind: sk, delegated: false });
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
            } else if self.kw(self.pos, "permits") {
                self.set(self.pos, R_SKIP);
                self.pos += 1;
                loop {
                    if self.parse_type(R_TYPE, n, false).is_none() {
                        break;
                    }
                    if self.p(self.pos, b',') {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
            } else {
                break;
            }
        }
        if self.p(self.pos, b'{') {
            if self.depth >= MAX_DEPTH {
                let end = self.s.match_brace(self.pos);
                self.pos = (end + 1).min(n);
                return;
            }
            self.depth += 1;
            self.pos += 1;
            if kind == TypeKind::Enum {
                self.enum_constants(idx);
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
            } else {
                // Unclosed body: the type ends where the file ends.
                let l = self.s.last_line(self.n());
                if let Some(td) = self.td(idx_o) {
                    td.end_line = td.end_line.max(l);
                }
            }
        }
    }

    /// `<T extends A & B, U>`. The cursor is on `<`.
    fn type_params(&mut self, idx: Option<usize>) {
        let n = self.n();
        self.pos += 1;
        loop {
            if self.pos >= n || self.p(self.pos, b'>') {
                break;
            }
            let before = self.pos;
            let mut dummy = Mods::default();
            while self.p(self.pos, b'@') && self.s.is_word(self.pos + 1) {
                self.annotation(&mut dummy);
            }
            if self.s.is_word(self.pos) {
                let t = self.pos;
                self.set(t, R_DECL);
                let name = if self.build { self.s.tx(t).to_string() } else { String::new() };
                if let Some(td) = self.td(idx) {
                    td.type_params.push(name);
                }
                self.pos += 1;
                if self.kw(self.pos, "extends") {
                    self.set(self.pos, R_SKIP);
                    self.pos += 1;
                    let _ = self.parse_type(R_TYPE, n, false);
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
                if self.p(self.pos, b'{') || self.p(self.pos, b'(') || self.p(self.pos, b';') {
                    return;
                }
            }
        }
        if self.p(self.pos, b'>') {
            self.pos += 1;
        }
    }

    fn record_components(&mut self, idx: usize) {
        let n = self.n();
        let end = self.s.match_paren(self.pos);
        self.pos += 1;
        while self.pos < end.min(n) {
            let before = self.pos;
            let mut mods = Mods::default();
            while self.p(self.pos, b'@') && self.s.is_word(self.pos + 1) {
                self.annotation(&mut mods);
            }
            let mut ty = self.parse_type(R_TYPE, end, self.build);
            if self.varargs() {
                if let Some(t) = ty.as_mut() {
                    t.array = true;
                    t.text.push_str("...");
                }
            }
            if self.s.is_word(self.pos) && self.pos < end {
                let t = self.pos;
                self.set(t, R_DECL);
                if self.build {
                    let (line, column) = self.s.lc(t);
                    let f = Member {
                        name: self.s.tx(t).to_string(),
                        kind: MemberKind::Field,
                        visibility: Visibility::Private,
                        is_static: false,
                        is_abstract: false,
                        ty,
                        params: Vec::new(),
                        mutable: false,
                        receiver: None,
                        line,
                        column,
                        end_line: line,
                    };
                    if let Some(td) = self.m.types.get_mut(idx) {
                        td.fields.push(f);
                    }
                }
                self.pos += 1;
            }
            if self.p(self.pos, b',') || self.pos == before || self.pos < end {
                self.pos += 1;
            }
        }
        self.pos = (end + 1).min(n);
    }

    /// `...` after a type. Moves the cursor.
    fn varargs(&mut self) -> bool {
        if self.p(self.pos, b'.') && self.p(self.pos + 1, b'.') && self.p(self.pos + 2, b'.') {
            self.pos += 3;
            true
        } else {
            false
        }
    }

    fn enum_constants(&mut self, idx: usize) {
        let n = self.n();
        let idx_o = Some(idx);
        loop {
            let mut dummy = Mods::default();
            while self.p(self.pos, b'@') && self.s.is_word(self.pos + 1) {
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
            // `A, B` and `A;` are constants. `private int x;` is a member.
            let follow_ok = self.p(t + 1, b',') || self.p(t + 1, b';') || self.p(t + 1, b'(') || self.p(t + 1, b'{') || self.p(t + 1, b'}');
            if !follow_ok {
                return;
            }
            self.set(t, R_DECL);
            self.pos += 1;
            if self.p(self.pos, b'(') {
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
                    name: self.s.tx(t).to_string(),
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
                    end_line: self.s.last_line(self.pos),
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

    fn vis_of(&self, mods: &Mods, kind: Option<TypeKind>) -> Visibility {
        match mods.vis {
            Some(v) => v,
            None if matches!(kind, Some(TypeKind::Interface | TypeKind::Annotation)) => Visibility::Public,
            None => Visibility::Package,
        }
    }

    fn push_member(&mut self, owner: Option<usize>, m: Member, method: bool) {
        if let Some(td) = owner.and_then(|o| self.m.types.get_mut(o)) {
            if method {
                td.methods.push(m)
            } else {
                td.fields.push(m)
            }
        }
    }

    /// A field, method or constructor.
    fn member(&mut self, owner: Option<usize>, kind: Option<TypeKind>, mods: &Mods<'a>) {
        let n = self.n();
        let start = self.pos;
        if self.p(self.pos, b'<') {
            self.type_params(None);
        }
        let is_iface = matches!(kind, Some(TypeKind::Interface | TypeKind::Annotation));
        // Constructor: a name and `(`. Compact record constructor: a name and `{`.
        if self.s.is_word(self.pos) && (self.p(self.pos + 1, b'(') || (kind == Some(TypeKind::Record) && self.p(self.pos + 1, b'{'))) {
            let t = self.pos;
            self.set(t, R_DECL);
            self.pos += 1;
            let params = if self.p(self.pos, b'(') { self.params(owner) } else { Vec::new() };
            self.throws_clause();
            if self.p(self.pos, b'{') {
                let end = self.s.match_brace(self.pos);
                self.scan_range(self.pos + 1, end, owner);
                self.pos = (end + 1).min(n);
            }
            if self.build {
                let (line, column) = self.s.lc(t);
                let m = Member {
                    name: self.s.tx(t).to_string(),
                    kind: MemberKind::Constructor,
                    visibility: self.vis_of(mods, kind),
                    is_static: false,
                    is_abstract: false,
                    ty: None,
                    params,
                    mutable: false,
                    receiver: None,
                    line,
                    column,
                    end_line: self.s.last_line(self.pos),
                };
                self.push_member(owner, m, true);
            }
            return;
        }
        let ty = self.parse_type(R_TYPE, n, self.build);
        if ty.is_none() || !self.s.is_word(self.pos) {
            // Junk: skip to the end of the statement.
            let from = self.pos.max(start);
            let e = self.stmt_end(from);
            self.scan_range(from, e, owner);
            self.pos = e.max(start + 1);
            return;
        }
        let name_tok = self.pos;
        if self.p(name_tok + 1, b'(') {
            // Method.
            self.set(name_tok, R_DECL);
            self.pos += 1;
            let params = self.params(owner);
            while self.p(self.pos, b'[') && self.p(self.pos + 1, b']') {
                self.pos += 2;
            }
            self.throws_clause();
            let mut has_body = false;
            if self.kw(self.pos, "default") {
                self.set(self.pos, R_SKIP);
                self.pos += 1;
                let e = self.stmt_end(self.pos);
                self.scan_range(self.pos, e, owner);
                self.pos = e;
            } else if self.p(self.pos, b'{') {
                let end = self.s.match_brace(self.pos);
                self.scan_range(self.pos + 1, end, owner);
                self.pos = (end + 1).min(n);
                has_body = true;
            } else if self.p(self.pos, b';') {
                self.pos += 1;
            }
            if self.build {
                let (line, column) = self.s.lc(name_tok);
                let m = Member {
                    name: self.s.tx(name_tok).to_string(),
                    kind: MemberKind::Method,
                    visibility: self.vis_of(mods, kind),
                    is_static: mods.is_static,
                    is_abstract: mods.is_abstract || (is_iface && !has_body && !mods.is_static && !mods.list.contains(&"default")),
                    ty,
                    params,
                    mutable: false,
                    receiver: None,
                    line,
                    column,
                    end_line: self.s.last_line(self.pos),
                };
                self.push_member(owner, m, true);
            }
            return;
        }
        // Fields: `int a, b[] = {1}, c;`.
        loop {
            let t = self.pos;
            if !self.s.is_word(t) {
                break;
            }
            self.set(t, R_DECL);
            self.pos += 1;
            let mut fty = if self.build { ty.clone() } else { None };
            while self.p(self.pos, b'[') && self.p(self.pos + 1, b']') {
                self.pos += 2;
                if let Some(x) = fty.as_mut() {
                    x.array = true;
                    x.text.push_str("[]");
                }
            }
            if self.p(self.pos, b'=') {
                self.pos += 1;
                let e = self.init_end(self.pos);
                self.scan_range(self.pos, e, owner);
                self.pos = e;
            }
            if self.build {
                let (line, column) = self.s.lc(t);
                let m = Member {
                    name: self.s.tx(t).to_string(),
                    kind: MemberKind::Field,
                    visibility: self.vis_of(mods, kind),
                    is_static: mods.is_static || is_iface,
                    is_abstract: false,
                    ty: fty,
                    params: Vec::new(),
                    mutable: !(mods.is_final || is_iface),
                    receiver: None,
                    line,
                    column,
                    end_line: if self.p(self.pos, b',') || self.p(self.pos, b';') { self.s.line(self.pos) } else { self.s.last_line(self.pos) },
                };
                self.push_member(owner, m, false);
            }
            if self.p(self.pos, b',') {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.p(self.pos, b';') {
            self.pos += 1;
        } else if self.pos < n && !self.p(self.pos, b'}') {
            // Not the end of a field: skip the rest of the statement.
            let e = self.stmt_end(self.pos);
            self.scan_range(self.pos, e, owner);
            self.pos = e;
        }
    }

    fn throws_clause(&mut self) {
        let n = self.n();
        if self.kw(self.pos, "throws") {
            self.set(self.pos, R_SKIP);
            self.pos += 1;
            loop {
                if self.parse_type(R_TYPE, n, false).is_none() {
                    break;
                }
                if self.p(self.pos, b',') {
                    self.pos += 1;
                } else {
                    break;
                }
            }
        }
    }

    /// Method parameters. The cursor is on `(`.
    fn params(&mut self, owner: Option<usize>) -> Vec<Param> {
        let n = self.n();
        let end = self.s.match_paren(self.pos);
        self.pos += 1;
        let mut out = Vec::new();
        while self.pos < end.min(n) {
            let before = self.pos;
            let _ = owner;
            let _mods = self.modifiers();
            let mut ty = self.parse_type(R_TYPE, end, self.build);
            let va = self.varargs();
            if let (true, Some(t)) = (va, ty.as_mut()) {
                t.array = true;
                t.text.push_str("...");
            }
            if self.s.is_word(self.pos) && self.pos < end {
                let t = self.pos;
                self.set(t, R_DECL);
                self.pos += 1;
                while self.p(self.pos, b'[') && self.p(self.pos + 1, b']') {
                    self.pos += 2;
                    if let Some(x) = ty.as_mut() {
                        x.array = true;
                        x.text.push_str("[]");
                    }
                }
                if self.build {
                    out.push(Param { name: self.s.tx(t).to_string(), ty });
                }
            }
            if self.p(self.pos, b',') || self.pos == before || self.pos < end {
                self.pos += 1;
            }
        }
        self.pos = (end + 1).min(n);
        out
    }

    /// End of an initializer: the next `,` or `;` at depth 0.
    fn init_end(&self, from: usize) -> usize {
        let n = self.n();
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
                    b',' | b';' if depth == 0 => return j,
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

    /// Index after the statement that starts at `from`: after the next `;`
    /// at depth 0, after a `{...}` block, or in front of a `}`.
    fn stmt_end(&self, from: usize) -> usize {
        let n = self.n();
        let mut depth = 0i32;
        let mut j = from;
        while j < n {
            let t = &self.s.toks[j];
            if t.kind == K::P {
                match t.ch {
                    b'(' | b'[' => depth += 1,
                    b')' | b']' => depth -= 1,
                    b'{' if depth <= 0 => return (self.s.match_brace(j) + 1).min(n),
                    b'}' if depth <= 0 => return j,
                    b';' if depth <= 0 => return j + 1,
                    _ => {}
                }
            }
            j += 1;
        }
        n
    }

    // ---------------------------------------------------------------
    // Types

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
        while self.p(self.pos, b'@') && self.s.is_word(self.pos + 1) && self.pos < lim && !self.kw(self.pos + 1, "interface") {
            self.annotation(&mut dummy);
        }
        if self.pos >= lim || !self.s.is_word(self.pos) {
            return None;
        }
        let first = self.pos;
        let mut name = String::new();
        let mut args: Vec<TypeRef> = Vec::new();
        let mut k = 0usize;
        let mut primitive = false;
        if !(self.s.is_id(first) && is_primitive(self.s.tx(first))) {
            self.note_chain(first);
        }
        loop {
            let t = self.pos;
            if !self.s.is_word(t) || t >= lim {
                break;
            }
            let text = self.s.tx(t);
            if k == 0 && self.s.is_id(t) && is_primitive(text) {
                primitive = true;
                self.set(t, R_SKIP);
            } else if self.s.is_id(t) && is_kw(text) {
                // A keyword such as `extends` ends the type.
                break;
            } else if role != R_NONE {
                self.set(t, role);
            }
            if want {
                if !name.is_empty() {
                    name.push('.');
                }
                name.push_str(text);
            }
            k += 1;
            self.pos += 1;
            if primitive {
                break;
            }
            if self.p(self.pos, b'<') && self.pos < lim {
                let a = self.type_args(R_TYPE, lim, want);
                if want {
                    args = a;
                }
            }
            if self.p(self.pos, b'.') && self.pos + 1 < lim && self.s.is_word(self.pos + 1) && !(self.s.is_id(self.pos + 1) && is_kw(self.s.tx(self.pos + 1))) {
                self.pos += 1;
                continue;
            }
            break;
        }
        if k == 0 {
            return None;
        }
        let mut array = false;
        while self.p(self.pos, b'[') && self.p(self.pos + 1, b']') && self.pos + 1 < lim {
            array = true;
            self.pos += 2;
        }
        if !want {
            return Some(TypeRef::default());
        }
        let last = self.pos.saturating_sub(1).max(first);
        let text = self.s.span_text(first, last);
        Some(TypeRef { text, name, args, nullable: false, array })
    }

    /// `<A, ? extends B, ?>`. The cursor is on `<`.
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
            if self.p(self.pos, b'?') {
                self.pos += 1;
                if self.kw(self.pos, "extends") || self.kw(self.pos, "super") {
                    self.set(self.pos, R_SKIP);
                    self.pos += 1;
                    if let Some(t) = self.parse_type(role, lim, want) {
                        out.push(t);
                    }
                }
            } else if let Some(t) = self.parse_type(role, lim, want) {
                out.push(t);
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
                    b'@' => self.scan_annotation(i),
                    b'<' if i > 0 && self.p(i - 1, b'.') => match self.s.try_type_args(i) {
                        Some(e) => {
                            self.pos = i;
                            let _ = self.type_args(R_TYPE, e, false);
                            e
                        }
                        None => i + 1,
                    },
                    b'(' => self.scan_cast(i, hi),
                    _ => i + 1,
                },
                K::Ident => self.scan_word(i, hi),
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

    fn scan_annotation(&mut self, i: usize) -> usize {
        let mut j = i + 1;
        if !self.s.is_word(j) || self.kw(j, "interface") {
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
        j
    }

    /// `(Foo) x`: a cast. Marks the type and returns the index after `)`.
    fn scan_cast(&mut self, i: usize, hi: usize) -> usize {
        let prev_ok = if i == 0 {
            true
        } else if self.s.is_word(i - 1) {
            matches!(self.s.tx(i - 1), "return" | "else" | "case" | "throw" | "yield" | "assert")
        } else {
            !matches!(self.s.toks[i - 1].ch, b')' | b']' | b'.') || self.s.toks[i - 1].kind != K::P
        };
        if !prev_ok || !self.s.is_word(i + 1) {
            return i + 1;
        }
        let mut j = i + 1;
        let mut last_seg;
        loop {
            if !self.s.is_word(j) {
                return i + 1;
            }
            last_seg = j;
            j += 1;
            if self.p(j, b'<') {
                match self.s.try_type_args(j) {
                    Some(e) => j = e,
                    None => return i + 1,
                }
            }
            if self.p(j, b'.') && self.s.is_word(j + 1) {
                j += 1;
            } else {
                break;
            }
        }
        while self.p(j, b'[') && self.p(j + 1, b']') {
            j += 2;
        }
        while self.p(j, b'&') {
            // Intersection cast: `(A & B) x`.
            j += 1;
            if !self.s.is_word(j) {
                return i + 1;
            }
            j += 1;
        }
        if !self.p(j, b')') || !is_upper_start(self.s.tx(last_seg)) || self.s.is_id(last_seg) && is_kw(self.s.tx(last_seg)) {
            return i + 1;
        }
        let k = j + 1;
        let next_ok = match self.s.toks.get(k) {
            None => false,
            Some(t) => match t.kind {
                K::Ident => !matches!(self.s.tx(k), "instanceof"),
                K::Tick | K::Str | K::Num | K::Char => true,
                K::P => matches!(t.ch, b'(' | b'!' | b'~'),
            },
        };
        if !next_ok {
            return i + 1;
        }
        self.mark_type_at(i + 1, hi, R_TYPE);
        k
    }

    /// `Type name` in code: the index of `name`, when it looks like a declaration.
    fn decl_lookahead(&self, i: usize) -> Option<usize> {
        let mut j = i;
        loop {
            if !self.s.is_word(j) {
                return None;
            }
            j += 1;
            if self.p(j, b'<') {
                j = self.s.try_type_args(j)?;
            }
            if self.p(j, b'.') && self.s.is_word(j + 1) {
                j += 1;
            } else {
                break;
            }
        }
        while self.p(j, b'[') && self.p(j + 1, b']') {
            j += 2;
        }
        if self.name_at(j) && self.s.tx(j) != "record" {
            Some(j)
        } else {
            None
        }
    }

    fn scan_word(&mut self, i: usize, hi: usize) -> usize {
        let t = self.s.tx(i);
        if is_kw(t) {
            return self.scan_keyword(i, t, hi);
        }
        let prev_member = i > 0 && (self.p(i - 1, b'.') || (i > 1 && self.s.dcolon(i - 2)));
        if !prev_member {
            self.note_chain(i);
        }
        if self.roles[i] != R_NONE {
            return i + 1;
        }
        if !prev_member {
            if let Some(name) = self.decl_lookahead(i) {
                if t != "record" || !self.p(name + 1, b'(') {
                    self.pos = i;
                    let _ = self.parse_type(R_TYPE, hi, false);
                    if self.pos <= name {
                        self.set(name, R_DECL);
                        return name + 1;
                    }
                }
            }
        }
        let nx = i + 1;
        if self.p(nx, b'(') {
            self.set(i, R_CALL);
            return nx;
        }
        if self.p(nx, b'.') && self.kw(nx + 1, "class") {
            self.set(i, R_TYPE);
        }
        nx
    }

    fn scan_keyword(&mut self, i: usize, t: &str, hi: usize) -> usize {
        match t {
            "new" => self.scan_new(i, hi),
            "instanceof" => {
                let mut j = i + 1;
                if self.kw(j, "final") {
                    j += 1;
                }
                let e = self.mark_type_at(j, hi, R_TYPE);
                if self.name_at(e) {
                    self.set(e, R_DECL);
                    return e + 1;
                }
                e
            }
            "class" | "interface" | "enum" => {
                if self.s.is_word(i + 1) {
                    self.set(i + 1, R_DECL);
                    return i + 2;
                }
                i + 1
            }
            _ if is_primitive(t) => {
                // `int x`, `int[] a`, `void run()`, `var x`.
                let mut j = i + 1;
                while self.p(j, b'[') && self.p(j + 1, b']') {
                    j += 2;
                }
                if self.name_at(j) {
                    self.set(j, R_DECL);
                    return j + 1;
                }
                i + 1
            }
            _ => i + 1,
        }
    }

    /// `new Foo<>(...)`, `new a.b.Foo[3]`. The name gets `R_INST` when `(` follows.
    fn scan_new(&mut self, i: usize, hi: usize) -> usize {
        let mut j = i + 1;
        while self.p(j, b'@') && self.s.is_word(j + 1) {
            j += 2;
        }
        if !self.s.is_word(j) {
            return i + 1;
        }
        // The last name of the dotted path is the class.
        let mut last = j;
        let mut k = j;
        while self.p(k + 1, b'.') && self.s.is_word(k + 2) {
            k += 2;
            last = k;
        }
        self.pos = j;
        let _ = self.parse_type(R_TYPE, hi, false);
        let e = self.pos.max(j + 1);
        if self.p(e, b'(') && !(self.s.is_id(last) && is_kw(self.s.tx(last))) {
            if let Some(r) = self.roles.get_mut(last) {
                *r = R_INST;
            }
        }
        e
    }
}
