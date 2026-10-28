//! Find usages without a language server: find the name at a position,
//! decide what it is, then search the files of the language family.

use crate::derived::{last_seg, Res, TypeId, View};
use crate::diagram::overlay;
use crate::index::{innermost_type, parse_text, Index};
use crate::textutil::*;
use crate::types::*;
use crate::walk::{self, lang_of, MAX_FILE_BYTES};
use kestrel_common::{Error, Result};
use crate::cmodel::{CMember as Member, CModel, CRef};
use kestrel_lang::{find_identifiers, IdentHit, Lang, MemberKind, TypeKind, UsageKind};
use memchr::memmem;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

const CHUNK: usize = 256;

pub fn type_kind_str(k: TypeKind) -> &'static str {
    match k {
        TypeKind::Class => "class",
        TypeKind::Interface => "interface",
        TypeKind::Enum => "enum",
        TypeKind::Record => "record",
        TypeKind::Annotation => "annotation",
        TypeKind::Object => "object",
        TypeKind::Struct => "struct",
        TypeKind::Protocol => "protocol",
        TypeKind::Actor => "actor",
        TypeKind::Extension => "extension",
        TypeKind::TypeAlias => "typeAlias",
    }
}

fn member_kind_str(k: MemberKind) -> &'static str {
    match k {
        MemberKind::Field => "field",
        MemberKind::Property => "property",
        MemberKind::Constructor => "constructor",
        MemberKind::Method => "method",
        MemberKind::EnumCase => "enumCase",
    }
}

/// What the name at the cursor is, with what the search needs.
#[derive(Default)]
pub(crate) struct Subject {
    pub(crate) sym: Option<UsageSymbol>,
    pub(crate) ty: Option<TypeId>,
    /// Types that declare (or are the receiver of) the member.
    pub(crate) owners: Vec<TypeId>,
    /// Top-level declarations: (file, index in `top_level`).
    pub(crate) top: Vec<(u32, u32)>,
    pub(crate) kind: Option<SymbolKind>,
}

pub(crate) struct Found<'a> {
    pub(crate) owner: TypeId,
    pub(crate) file: u32,
    pub(crate) m: &'a Member,
}

fn find_member<'a>(v: &View<'a>, ty: TypeId, name: &str) -> Option<Found<'a>> {
    for t in v.ancestors(ty) {
        for (f, i) in v.parts(t) {
            let d = &v.files[f as usize].model.types[i as usize];
            if let Some(m) = d.fields.iter().chain(d.methods.iter()).find(|m| m.name == name) {
                return Some(Found { owner: t, file: f, m });
            }
        }
    }
    None
}

fn decl_of(v: &View, file: u32, m: &Member) -> Declaration {
    Declaration { path: v.files[file as usize].path.to_string_lossy().into_owned(), line: m.line, column: m.column }
}

pub(crate) fn type_subject(v: &View, t: TypeId, name: &str) -> Subject {
    let d = v.decl(t);
    let fe = v.file_of(t);
    Subject {
        sym: Some(UsageSymbol {
            name: name.to_owned(),
            kind: SymbolKind::Type,
            detail: Some(type_kind_str(d.kind).to_owned()),
            owner: Some(v.node(t).qname.clone()),
            declaration: Some(Declaration { path: fe.path.to_string_lossy().into_owned(), line: d.line, column: d.column }),
            lang: Some(fe.lang),
        }),
        ty: Some(t),
        kind: Some(SymbolKind::Type),
        ..Default::default()
    }
}

pub(crate) fn member_subject(v: &View, owners: Vec<TypeId>, found: Option<Found>, name: &str, lang: Lang) -> Subject {
    let owner = found.as_ref().map(|f| f.owner).or(owners.first().copied());
    Subject {
        sym: Some(UsageSymbol {
            name: name.to_owned(),
            kind: SymbolKind::Member,
            detail: found.as_ref().map(|f| member_kind_str(f.m.kind).to_owned()),
            owner: owner.map(|o| v.node(o).qname.clone()),
            declaration: found.as_ref().map(|f| decl_of(v, f.file, f.m)),
            lang: Some(lang),
        }),
        owners: found.map(|f| vec![f.owner]).unwrap_or(owners),
        kind: Some(SymbolKind::Member),
        ..Default::default()
    }
}

pub(crate) fn top_subject(v: &View, top: Vec<(u32, u32)>, name: &str, lang: Lang) -> Subject {
    let (f, i) = top[0];
    let m = &v.files[f as usize].model.top_level[i as usize];
    Subject {
        sym: Some(UsageSymbol {
            name: name.to_owned(),
            kind: SymbolKind::TopLevel,
            detail: Some(if m.kind == MemberKind::Method { "function" } else { "variable" }.to_owned()),
            owner: None,
            declaration: Some(decl_of(v, f, m)),
            lang: Some(lang),
        }),
        top,
        kind: Some(SymbolKind::TopLevel),
        ..Default::default()
    }
}

fn local_subject(name: &str, detail: &str, lang: Lang) -> Subject {
    Subject {
        sym: Some(UsageSymbol {
            name: name.to_owned(),
            kind: SymbolKind::Local,
            detail: Some(detail.to_owned()),
            owner: None,
            declaration: None,
            lang: Some(lang),
        }),
        kind: Some(SymbolKind::Local),
        ..Default::default()
    }
}

fn unknown_subject(name: &str, lang: Option<Lang>) -> Subject {
    Subject {
        sym: Some(UsageSymbol { name: name.to_owned(), kind: SymbolKind::Unknown, detail: None, owner: None, declaration: None, lang }),
        kind: Some(SymbolKind::Unknown),
        ..Default::default()
    }
}

fn line_of(starts: &[usize], offset: usize) -> u32 {
    starts.partition_point(|&s| s <= offset) as u32
}

struct Cursor<'a> {
    v: &'a View<'a>,
    fid: u32,
    lang: Lang,
    name: &'a str,
    line: u32,
    ctx: Option<u32>,
    hit: &'a IdentHit,
    hits: &'a [IdentHit],
    starts: &'a [usize],
}

impl<'a> Cursor<'a> {
    fn model(&self) -> &'a CModel {
        &self.v.files[self.fid as usize].model
    }

    fn ctx_node(&self) -> Option<TypeId> {
        self.ctx.and_then(|c| self.v.d.file_types[self.fid as usize].get(c as usize).copied().flatten())
    }

    /// The method (or top-level function) that holds the cursor line, with
    /// the last line of its region.
    fn enclosing_method(&self) -> Option<(&'a Member, u32)> {
        let model = self.model();
        let (list, end): (Vec<&Member>, u32) = match self.ctx {
            Some(c) => {
                let d = &model.types[c as usize];
                (d.methods.iter().collect(), d.end_line)
            }
            None => (model.top_level.iter().collect(), u32::MAX),
        };
        let m = list.iter().filter(|m| m.line <= self.line).max_by_key(|m| m.line)?;
        let next = list.iter().map(|x| x.line).filter(|&l| l > m.line).min().unwrap_or(end);
        let next = if let Some(c) = self.ctx {
            // A field or nested type after the method also ends its region.
            let d = &model.types[c as usize];
            d.fields.iter().map(|f| f.line).chain(model.types.iter().filter(|t| t.outer == Some(c as usize)).map(|t| t.start_line)).filter(|&l| l > m.line).fold(next, u32::min)
        } else {
            next
        };
        if self.line >= next && next != u32::MAX && self.line != next { None } else { Some((m, next)) }
    }

    fn is_local(&self) -> Option<&'static str> {
        let (m, end) = self.enclosing_method()?;
        if m.params.iter().any(|p| p.name == self.name) {
            return Some("parameter");
        }
        let model = self.model();
        for h in self.hits {
            if h.kind != UsageKind::Declaration {
                continue;
            }
            let l = line_of(self.starts, h.start);
            if l < m.line || l > self.line || l >= end && end != u32::MAX {
                continue;
            }
            // A declaration of a type or member on that line is not a local.
            let is_decl = model.types.iter().any(|t| t.line == l && t.name == self.name)
                || model.types.iter().any(|t| t.fields.iter().chain(t.methods.iter()).any(|x| x.line == l && x.name == self.name))
                || model.top_level.iter().any(|x| x.line == l && x.name == self.name && l != m.line);
            if !is_decl || l > m.line {
                return Some("variable");
            }
        }
        None
    }

    /// The project type of a variable (field or parameter) by its name.
    fn var_type(&self, var: &str) -> Option<TypeId> {
        if let Some((m, _)) = self.enclosing_method() {
            if let Some(p) = m.params.iter().find(|p| p.name == var) {
                let t = p.ty.as_ref()?;
                return match self.v.resolve(self.fid, self.ctx, &t.name) {
                    Res::Project(x) => Some(x),
                    _ => None,
                };
            }
        }
        let mut node = self.ctx_node();
        while let Some(n) = node {
            if let Some(f) = find_member(self.v, n, var) {
                if let Some(t) = &f.m.ty {
                    // Resolve in the file that declares the field.
                    let (ff, fi) = self.v.parts(f.owner)[0];
                    if let Res::Project(x) = self.v.resolve(ff, Some(fi), &t.name) {
                        return Some(x);
                    }
                }
            }
            node = self.v.node(n).outer;
        }
        None
    }

    fn all_members_named(&self) -> Vec<TypeId> {
        (0..self.v.d.nodes.len() as TypeId)
            .filter(|&t| {
                self.v.parts(t).iter().any(|&(f, i)| {
                    let d = &self.v.files[f as usize].model.types[i as usize];
                    d.fields.iter().chain(d.methods.iter()).any(|m| m.name == self.name)
                })
            })
            .collect()
    }

    fn member_of(&self, ty: TypeId) -> Subject {
        let found = find_member(self.v, ty, self.name);
        member_subject(self.v, vec![ty], found, self.name, self.lang)
    }

    fn classify(&self) -> Subject {
        let v = self.v;
        let name = self.name;
        let model = self.model();
        let ft = &v.d.file_types[self.fid as usize];
        let qual = self.hit.qualifier.as_str();
        match self.hit.kind {
            UsageKind::Declaration => {
                for (i, t) in model.types.iter().enumerate() {
                    if t.line == self.line && t.name == name {
                        if let Some(Some(n)) = ft.get(i) {
                            return type_subject(v, *n, name);
                        }
                    }
                }
                for (i, t) in model.types.iter().enumerate() {
                    if let Some(m) = t.fields.iter().chain(t.methods.iter()).find(|m| m.line == self.line && m.name == name) {
                        let owner = ft.get(i).copied().flatten();
                        let f = owner.map(|o| Found { owner: o, file: self.fid, m });
                        return member_subject(v, owner.into_iter().collect(), f, name, self.lang);
                    }
                }
                if let Some(i) = model.top_level.iter().position(|m| m.line == self.line && m.name == name) {
                    return top_subject(v, vec![(self.fid, i as u32)], name, self.lang);
                }
                let detail = if model.types.iter().chain(std::iter::empty()).any(|t| t.methods.iter().any(|m| m.line == self.line && m.params.iter().any(|p| p.name == name)))
                    || model.top_level.iter().any(|m| m.line == self.line && m.params.iter().any(|p| p.name == name))
                {
                    "parameter"
                } else {
                    "variable"
                };
                local_subject(name, detail, self.lang)
            }
            UsageKind::Import => {
                let path = if qual.is_empty() { name.to_owned() } else { format!("{qual}.{name}") };
                if let Some(t) = v.d.by_qname.get(&path).and_then(|l| l.first()) {
                    return type_subject(v, *t, name);
                }
                if let Some(t) = v.d.by_qname.get(qual).and_then(|l| l.first()) {
                    return self.member_of(*t);
                }
                if let Some(c) = v.d.top_by_name.get(name) {
                    let top: Vec<_> = c.iter().copied().filter(|&(f, _)| v.files[f as usize].model.package == qual).collect();
                    if !top.is_empty() {
                        return top_subject(v, top, name, self.lang);
                    }
                }
                unknown_subject(name, Some(self.lang))
            }
            _ if !qual.is_empty() => {
                let full = format!("{qual}.{name}");
                if let Res::Project(t) = v.resolve(self.fid, self.ctx, &full) {
                    return type_subject(v, t, name);
                }
                let var = qual.strip_prefix("this.").unwrap_or(qual);
                let recv = if var == "this" || var == "self" {
                    self.ctx_node()
                } else if !var.contains('.') {
                    match v.resolve(self.fid, self.ctx, var) {
                        Res::Project(t) if var.chars().next().is_some_and(|c| c.is_uppercase()) => Some(t),
                        _ => self.var_type(var),
                    }
                } else {
                    None
                };
                if let Some(r) = recv {
                    return self.member_of(r);
                }
                let owners = self.all_members_named();
                if !owners.is_empty() {
                    return member_subject(v, owners, None, name, self.lang);
                }
                unknown_subject(name, Some(self.lang))
            }
            _ => {
                if let Some(detail) = self.is_local() {
                    return local_subject(name, detail, self.lang);
                }
                let upper = name.chars().next().is_some_and(|c| c.is_uppercase());
                let as_type = match v.resolve(self.fid, self.ctx, name) {
                    Res::Project(t) => Some(t),
                    _ => None,
                };
                if let (true, Some(t)) = (upper, as_type) {
                    return type_subject(v, t, name);
                }
                let mut node = self.ctx_node();
                while let Some(n) = node {
                    if let Some(f) = find_member(v, n, name) {
                        return member_subject(v, vec![n], Some(f), name, self.lang);
                    }
                    node = v.node(n).outer;
                }
                if let Some(t) = as_type {
                    return type_subject(v, t, name);
                }
                if let Some(c) = v.d.top_by_name.get(name) {
                    let pkg = &model.package;
                    let mut top: Vec<(u32, u32)> = c.clone();
                    top.sort_by_key(|&(f, _)| {
                        (f != self.fid, v.files[f as usize].model.package != *pkg, f)
                    });
                    return top_subject(v, top, name, self.lang);
                }
                unknown_subject(name, Some(self.lang))
            }
        }
    }
}

// --- The search -----------------------------------------------------------------

pub(crate) struct FileHits {
    pub(crate) file: u32,
    pub(crate) likely: bool,
    pub(crate) hits: Vec<(usize, usize, UsageKind)>,
}

fn type_names(t: &CRef, out: &mut Vec<String>) {
    if !t.name.is_empty() {
        out.push(t.name.to_owned());
    }
    for a in &t.args {
        type_names(a, out);
    }
}

/// Does the file name one of the related types?
fn file_mentions(v: &View, fid: u32, related: &HashSet<TypeId>, simple: &HashSet<String>) -> bool {
    if v.d.file_types[fid as usize].iter().flatten().any(|t| related.contains(t)) {
        return true;
    }
    let model = &v.files[fid as usize].model;
    for imp in &model.imports {
        if v.d.by_qname.get(imp.path).is_some_and(|l| l.iter().any(|t| related.contains(t))) {
            return true;
        }
    }
    let mut names: Vec<String> = Vec::new();
    for t in &model.types {
        for s in &t.supertypes {
            type_names(&s.ty, &mut names);
        }
        for m in t.fields.iter().chain(t.methods.iter()) {
            m.ty.iter().for_each(|x| type_names(x, &mut names));
            for p in &m.params {
                p.ty.iter().for_each(|x| type_names(x, &mut names));
            }
        }
        names.extend(t.used_types.iter().map(|s| s.to_string()));
    }
    for m in &model.top_level {
        m.ty.iter().for_each(|x| type_names(x, &mut names));
        for p in &m.params {
            p.ty.iter().for_each(|x| type_names(x, &mut names));
        }
    }
    names.sort_unstable();
    names.dedup();
    names.iter().filter(|n| simple.contains(last_seg(n))).any(|n| matches!(v.resolve(fid, None, n), Res::Project(t) if related.contains(&t)))
}

struct Search<'a> {
    v: &'a View<'a>,
    subj: &'a Subject,
    name: &'a str,
    related: HashSet<TypeId>,
    simple: HashSet<String>,
    member_decls: HashSet<(u32, u32)>,
    aliases: HashMap<u32, Vec<String>>,
    finder: memmem::Finder<'a>,
    /// Callers only: keep calls (and method references). `Some(true)`: a
    /// property, so reads count too.
    keep: Option<bool>,
}

impl Search<'_> {
    fn file(&self, fid: u32, text: &str) -> Option<FileHits> {
        let mut fh = self.file_raw(fid, text)?;
        if let Some(property) = self.keep {
            fh.hits.retain(|&(start, _, kind)| match kind {
                UsageKind::Call | UsageKind::Instantiation => true,
                UsageKind::Reference => property || text[..start].trim_end().ends_with("::"),
                _ => false,
            });
            if fh.hits.is_empty() {
                return None;
            }
        }
        Some(fh)
    }

    fn file_raw(&self, fid: u32, text: &str) -> Option<FileHits> {
        let fe = &self.v.files[fid as usize];
        let alias = self.aliases.get(&fid);
        let has_name = self.finder.find(text.as_bytes()).is_some();
        let has_alias = alias.is_some_and(|a| a.iter().any(|n| memmem::find(text.as_bytes(), n.as_bytes()).is_some()));
        if !has_name && !has_alias {
            return None;
        }
        let mut hits = if has_name { find_identifiers(fe.lang, text, self.name) } else { Vec::new() };
        if let Some(a) = alias {
            for n in a {
                hits.extend(find_identifiers(fe.lang, text, n));
            }
            hits.sort_by_key(|h| h.start);
        }
        if hits.is_empty() {
            return None;
        }
        let starts = line_starts(text);
        let model = &fe.model;
        let kind = self.subj.kind.unwrap_or(SymbolKind::Unknown);
        let mut out: Vec<(usize, usize, UsageKind)> = Vec::new();
        match kind {
            SymbolKind::Type => {
                let target = self.subj.ty?;
                let mut cache: HashMap<(Option<u32>, &str), bool> = HashMap::new();
                let mut other: Vec<(usize, usize, UsageKind)> = Vec::new();
                for h in &hits {
                    let line = line_of(&starts, h.start);
                    let ok = match h.kind {
                        UsageKind::Declaration => self.v.parts(target).iter().any(|&(f, i)| {
                            f == fid && model.types[i as usize].line == line && model.types[i as usize].name == self.name
                        }),
                        UsageKind::Import => {
                            fe.lang.is_jvm() && {
                                let p = if h.qualifier.is_empty() { self.name.to_owned() } else { format!("{}.{}", h.qualifier, self.name) };
                                self.v.d.by_qname.get(&p).is_some_and(|l| l.contains(&target))
                            }
                        }
                        _ => {
                            let ctx = innermost_type(model, line);
                            let key = (ctx, h.qualifier.as_str());
                            *cache.entry(key).or_insert_with(|| {
                                let text = &text[h.start..h.end];
                                let full = if h.qualifier.is_empty() { text.to_owned() } else { format!("{}.{}", h.qualifier, text) };
                                let r = self.v.resolve(fid, ctx, &full);
                                let r = if r == Res::Project(target) || h.qualifier.is_empty() || fe.lang != Lang::Swift { r } else { self.v.resolve(fid, ctx, text) };
                                r == Res::Project(target)
                            })
                        }
                    };
                    let k = if h.kind == UsageKind::Call { UsageKind::Instantiation } else { h.kind };
                    if ok {
                        out.push((h.start, h.end, k));
                    } else if h.kind != UsageKind::Declaration {
                        other.push((h.start, h.end, h.kind));
                    }
                }
                if out.is_empty() {
                    return if other.is_empty() { None } else { Some(FileHits { file: fid, likely: false, hits: other }) };
                }
                Some(FileHits { file: fid, likely: true, hits: out })
            }
            SymbolKind::Member => {
                let mentions = self.subj.owners.is_empty() || file_mentions(self.v, fid, &self.related, &self.simple);
                let all: Vec<(usize, usize, UsageKind)> = hits.iter().map(|h| (h.start, h.end, h.kind)).collect();
                for h in &hits {
                    let line = line_of(&starts, h.start);
                    if h.kind == UsageKind::Declaration {
                        if self.member_decls.contains(&(fid, line)) {
                            out.push((h.start, h.end, h.kind));
                        }
                        continue;
                    }
                    if h.kind == UsageKind::Import {
                        continue;
                    }
                    let q = h.qualifier.as_str();
                    if !q.is_empty() && !q.contains('.') && q.chars().next().is_some_and(|c| c.is_uppercase()) {
                        let ctx = innermost_type(model, line);
                        if let Res::Project(t) = self.v.resolve(fid, ctx, q) {
                            if !self.related.contains(&t) {
                                continue;
                            }
                        }
                    }
                    out.push((h.start, h.end, h.kind));
                }
                // Hits that do not fit stay in the result, in a file that is not likely.
                let own = self.v.d.file_types[fid as usize].iter().flatten().any(|t| self.related.contains(t));
                if out.is_empty() || !(mentions || own) {
                    return Some(FileHits { file: fid, likely: false, hits: all });
                }
                Some(FileHits { file: fid, likely: true, hits: out })
            }
            SymbolKind::TopLevel => {
                let decl_pos: HashSet<(u32, u32)> =
                    self.subj.top.iter().map(|&(f, i)| (f, self.v.files[f as usize].model.top_level[i as usize].line)).collect();
                for h in &hits {
                    let line = line_of(&starts, h.start);
                    if h.kind == UsageKind::Declaration && !decl_pos.contains(&(fid, line)) {
                        continue;
                    }
                    out.push((h.start, h.end, h.kind));
                }
                if out.is_empty() {
                    let all = hits.iter().map(|h| (h.start, h.end, h.kind)).collect();
                    return Some(FileHits { file: fid, likely: false, hits: all });
                }
                let likely = fe.lang == Lang::Swift
                    || self.subj.top.iter().any(|&(f, _)| {
                        let m = &self.v.files[f as usize].model;
                        f == fid
                            || (m.package == model.package)
                            || model.imports.iter().any(|i| i.path == m.package || i.path.strip_prefix(&m.package).is_some_and(|r| r.starts_with('.') && r[1..] == *self.name))
                    });
                Some(FileHits { file: fid, likely, hits: out })
            }
            SymbolKind::Local | SymbolKind::Unknown => {
                out.extend(hits.iter().map(|h| (h.start, h.end, h.kind)));
                Some(FileHits { file: fid, likely: true, hits: out })
            }
        }
    }
}

pub(crate) fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    Some(decode(std::fs::read(path).ok()?))
}

pub(crate) fn matches_of(text: &str, hits: &[(usize, usize, UsageKind)]) -> Vec<UsageMatch> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(hits.len());
    let mut line = 1u32;
    let mut pos = 0usize;
    for &(s, e, kind) in hits {
        line += memchr::memchr_iter(b'\n', &bytes[pos..s]).count() as u32;
        pos = s;
        let ls = memchr::memrchr(b'\n', &bytes[..s]).map_or(0, |i| i + 1);
        let shown = show_match(text, line, ls, s, e);
        out.push(UsageMatch { line, column: shown.offset + shown.range[0] + 1, text: shown.text, range: shown.range, kind });
    }
    out
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { Err(Error::cancelled()) } else { Ok(()) }
}

pub(crate) struct Collected {
    pub(crate) files: Vec<FileHits>,
    pub(crate) truncated: bool,
}

pub(crate) struct Classified {
    pub(crate) index: Arc<Index>,
    pub(crate) fid: u32,
    pub(crate) lang: Lang,
    pub(crate) name: String,
    pub(crate) subj: Subject,
    pub(crate) hit_kind: UsageKind,
}

/// Finds the name at a position (it must be a code hit, not a comment or
/// string) and decides what it is. `None` when there is no name.
pub(crate) fn classify_at(
    index: &Arc<Index>,
    path: &Path,
    text: &str,
    has_text: bool,
    line_no: u32,
    column: u32,
    cancel: &AtomicBool,
) -> Result<Option<Classified>> {
    let Some(lang) = lang_of(path) else { return Ok(None) };
    let Some(line) = line_text(text, line_no) else { return Ok(None) };
    let Some((s, e)) = ident_range(line, column) else { return Ok(None) };
    let name = line[s..e].to_owned();
    let starts = line_starts(text);
    let abs = starts[line_no as usize - 1] + s;
    let hits = find_identifiers(lang, text, &name);
    let Some(hit) = hits.iter().find(|h| h.start <= abs && abs < h.end) else { return Ok(None) };
    // The index with the editor text for this file.
    let index = if has_text {
        overlay(index, path, text)
    } else if index.file_id(path).is_none() {
        Arc::new(index.with_model(path, lang, parse_text(lang, text)))
    } else {
        index.clone()
    };
    check(cancel)?;
    let v = index.view();
    let fid = index.file_id(path).ok_or_else(|| Error::internal("file is not in the index"))?;
    let cur = Cursor {
        v: &v,
        fid,
        lang,
        name: &name,
        line: line_no,
        ctx: innermost_type(&index.file(fid).model, line_no),
        hit,
        hits: &hits,
        starts: &starts,
    };
    let subj = cur.classify();
    drop(v);
    let hit_kind = hit.kind;
    Ok(Some(Classified { index, fid, lang, name, subj, hit_kind }))
}

/// Searches the files for a subject. The result is sorted by path, likely
/// files first when the budget is short.
#[allow(clippy::too_many_arguments)]
pub(crate) fn collect(
    index: &Arc<Index>,
    subj: &Subject,
    name: &str,
    lang: Lang,
    fid: u32,
    path: &Path,
    text: &str,
    file_only: bool,
    max: usize,
    keep: Option<bool>,
    cancel: &AtomicBool,
) -> Result<Collected> {
    let v = index.view();
    let kind = subj.kind.unwrap_or(SymbolKind::Unknown);
    // Related types and declarations (members).
    let mut related: HashSet<TypeId> = HashSet::new();
    let mut member_decls: HashSet<(u32, u32)> = HashSet::new();
    if kind == SymbolKind::Member {
        // The owner and the ancestors that declare the member, with all their descendants.
        for &o in &subj.owners {
            for a in v.ancestors(o) {
                let declares = a == o
                    || v.parts(a).iter().any(|&(f, i)| {
                        let d = &v.files[f as usize].model.types[i as usize];
                        d.fields.iter().chain(d.methods.iter()).any(|m| m.name == name)
                    });
                if declares {
                    related.extend(v.descendants(a));
                }
            }
        }
        for &t in &related {
            for (f, i) in v.parts(t) {
                let d = &v.files[f as usize].model.types[i as usize];
                for m in d.fields.iter().chain(d.methods.iter()).filter(|m| m.name == name) {
                    member_decls.insert((f, m.line));
                }
            }
        }
    }
    let simple: HashSet<String> = related.iter().map(|&t| v.decl(t).name.to_owned()).collect();
    // Kotlin import aliases of the target type.
    let mut aliases: HashMap<u32, Vec<String>> = HashMap::new();
    if let (SymbolKind::Type, Some(t)) = (kind, subj.ty) {
        let q = &v.node(t).qname;
        for (fi, f) in index.files.iter().enumerate() {
            for imp in &f.model.imports {
                if let Some(a) = &imp.alias {
                    if &imp.path == q {
                        aliases.entry(fi as u32).or_default().push(a.to_string());
                    }
                }
            }
        }
    }
    let search = Search { v: &v, subj, name, related, simple, member_decls, aliases, finder: memmem::Finder::new(name.as_bytes()), keep };
    let jvm = lang.is_jvm();
    let candidates: Vec<u32> = if file_only {
        vec![fid]
    } else {
        (0..index.files.len() as u32)
            .filter(|&f| {
                let fe = index.file(f);
                fe.lang.is_jvm() == jvm
                    && (fe.path == path
                        || crate::textutil::may_hold(&fe.words, name)
                        || search.aliases.get(&f).is_some_and(|a| a.iter().any(|n| crate::textutil::may_hold(&fe.words, n))))
            })
            .collect()
    };
    let current = path;
    let mut results: Vec<FileHits> = Vec::new();
    let mut likely_total = 0usize;
    let mut truncated = false;
    'outer: for chunk in candidates.chunks(CHUNK) {
        check(cancel)?;
        let part: Vec<FileHits> = chunk
            .par_iter()
            .filter_map(|&f| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let fe = index.file(f);
                if fe.path == current {
                    return search.file(f, text);
                }
                let t = read_text(&fe.path)?;
                search.file(f, &t)
            })
            .collect();
        for fh in part {
            if fh.likely {
                likely_total += fh.hits.len();
            }
            results.push(fh);
        }
        if likely_total > max {
            truncated = true;
            break 'outer;
        }
    }
    check(cancel)?;
    // Likely files first, the others fill what is left. Then sort by path.
    let mut chosen: Vec<FileHits> = Vec::new();
    let mut budget = max;
    let (likely, unlikely): (Vec<FileHits>, Vec<FileHits>) = results.into_iter().partition(|f| f.likely);
    for group in [likely, unlikely] {
        for mut fh in group {
            if budget == 0 {
                truncated = true;
                break;
            }
            if fh.hits.len() > budget {
                fh.hits.truncate(budget);
                truncated = true;
            }
            budget -= fh.hits.len();
            chosen.push(fh);
        }
    }
    chosen.sort_by(|a, b| index.file(a.file).path.cmp(&index.file(b.file).path));
    Ok(Collected { files: chosen, truncated })
}

pub fn run(index: &Arc<Index>, req: &UsagesRequest, cancel: &AtomicBool) -> Result<UsagesResult> {
    let t0 = Instant::now();
    let path = PathBuf::from(&req.path);
    let text = match &req.text {
        Some(t) => t.clone(),
        None => read_text(&path).ok_or_else(|| Error::not_found(format!("cannot read {}", req.path)))?,
    };
    let empty = |symbol: Option<UsageSymbol>| UsagesResult {
        symbol,
        files: vec![],
        total: 0,
        truncated: false,
        exact: false,
        file_only: false,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    };
    let Some(line) = line_text(&text, req.line) else { return Ok(empty(None)) };
    let Some((s, e)) = ident_range(line, req.column) else { return Ok(empty(None)) };
    let name = line[s..e].to_owned();
    let max = req.max_results.max(1);
    let Some(lang) = lang_of(&path) else {
        return other_language(index, req, &path, &name, max, cancel, t0);
    };
    let Some(c) = classify_at(index, &path, &text, req.text.is_some(), req.line, req.column, cancel)? else { return Ok(empty(None)) };
    let (index, fid, subj) = (c.index, c.fid, c.subj);
    let kind = subj.kind.unwrap_or(SymbolKind::Unknown);
    let file_only = kind == SymbolKind::Local && !req.wide;
    let col = collect(&index, &subj, &name, lang, fid, &path, &text, file_only, max, None, cancel)?;
    let (chosen, truncated) = (col.files, col.truncated);
    let current = path.as_path();
    let mut files = Vec::with_capacity(chosen.len());
    let mut total = 0;
    for fh in chosen {
        let fe = index.file(fh.file);
        let ftext = if fe.path == current { text.clone() } else { read_text(&fe.path).unwrap_or_default() };
        let matches = matches_of(&ftext, &fh.hits);
        total += matches.len();
        files.push(UsageFile { path: fe.path.to_string_lossy().into_owned(), likely: fh.likely, matches });
    }
    Ok(UsagesResult {
        symbol: subj.sym,
        files,
        total,
        truncated,
        exact: matches!(kind, SymbolKind::Type | SymbolKind::Local),
        file_only,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

/// Other languages: a whole word search in files with the same extension.
fn other_language(
    index: &Index,
    req: &UsagesRequest,
    path: &Path,
    name: &str,
    max: usize,
    cancel: &AtomicBool,
    t0: Instant,
) -> Result<UsagesResult> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut files_list = if ext.is_empty() { vec![path.to_path_buf()] } else { walk::list_by_extension(Path::new(&req.root), ext, cancel) };
    if !files_list.iter().any(|p| p == path) {
        files_list.push(path.to_path_buf());
        files_list.sort();
    }
    let _ = index;
    check(cancel)?;
    let finder = memmem::Finder::new(name.as_bytes());
    let current = path;
    let results: Vec<(PathBuf, String, Vec<(usize, usize, UsageKind)>)> = files_list
        .par_iter()
        .filter_map(|p| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let text = if p == current { req.text.clone().or_else(|| read_text(p))? } else { read_text(p)? };
            let b = text.as_bytes();
            if b[..b.len().min(8192)].contains(&0) {
                return None;
            }
            let mut hits = Vec::new();
            for i in finder.find_iter(b) {
                let end = i + name.len();
                let before = text[..i].chars().next_back().is_some_and(is_ident_char);
                let after = text[end..].chars().next().is_some_and(is_ident_char);
                if !before && !after && text.is_char_boundary(i) && text.is_char_boundary(end) {
                    hits.push((i, end, UsageKind::Reference));
                }
            }
            if hits.is_empty() { None } else { Some((p.clone(), text, hits)) }
        })
        .collect();
    check(cancel)?;
    let mut files = Vec::new();
    let mut total = 0;
    let mut truncated = false;
    for (p, text, mut hits) in results {
        let left = max - total;
        if left == 0 {
            truncated = true;
            break;
        }
        if hits.len() > left {
            hits.truncate(left);
            truncated = true;
        }
        let matches = matches_of(&text, &hits);
        total += matches.len();
        files.push(UsageFile { path: p.to_string_lossy().into_owned(), likely: true, matches });
    }
    Ok(UsagesResult {
        symbol: Some(UsageSymbol { name: name.to_owned(), kind: SymbolKind::Unknown, detail: None, owner: None, declaration: None, lang: None }),
        files,
        total,
        truncated,
        exact: false,
        file_only: false,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}
