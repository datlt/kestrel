//! Callers of a method, constructor, function or property (one level).
//! They are the usages of the target that are calls, mapped to the member
//! whose lines hold the call.

use crate::cmodel::{CMember, CModel, CType};
use crate::derived::{TypeId, View};
use crate::diagram::params_text;
use crate::index::{innermost_type, Index};
use crate::textutil::line_starts;
use crate::types::*;
use crate::usages::{classify_at, collect, member_subject, read_text, top_subject, type_subject, Found, Subject};
use kestrel_common::{Error, Result};
use kestrel_lang::{Lang, MemberKind, UsageKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

const TEST_DIRS: &[&str] = &["test", "tests", "testByKotest", "testFixtures", "androidTest", "integrationTest", "Tests"];
const TEST_SUFFIXES: &[&str] = &["Test", "Tests", "Spec"];

/// Test code: a file in a test folder, or with a test-like file name.
pub fn is_test_path(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    if let Some(dir) = rel.parent() {
        for c in dir.components() {
            let c = c.as_os_str().to_string_lossy();
            if TEST_DIRS.contains(&c.as_ref()) || c.ends_with("Tests") {
                return true;
            }
        }
    }
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { return false };
    if TEST_SUFFIXES.iter().any(|s| stem.ends_with(s)) {
        return true;
    }
    // `FooIT`: the letter before `IT` is not an upper-case one.
    stem.strip_suffix("IT").is_some_and(|h| h.chars().last().is_some_and(|c| !c.is_uppercase()))
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { Err(Error::cancelled()) } else { Ok(()) }
}

fn call_kind(k: MemberKind) -> CallKind {
    match k {
        MemberKind::Method => CallKind::Method,
        MemberKind::Constructor => CallKind::Constructor,
        _ => CallKind::Property,
    }
}

/// The last line of a member. When the parser gives no end line, the line
/// before the next member (or the end of the type) is the limit.
fn member_end(m: &CMember, siblings: &[&CMember], limit: u32, ctor_line: Option<u32>) -> u32 {
    // The next member starts after this one ends. In broken code the parser's
    // end line can go past it, so the next member's line caps the end.
    let next = siblings.iter().map(|x| x.line).filter(|&l| l > m.line).min().map_or(limit, |l| l - 1).max(m.line);
    if m.end_line >= m.line && m.end_line > 0 {
        return m.end_line.min(next);
    }
    if m.kind == MemberKind::Constructor && ctor_line == Some(m.line) {
        // A primary constructor in the header does not hold the body.
        return m.line;
    }
    next
}

pub(crate) struct Located<'a> {
    pub(crate) kind: CallKind,
    pub(crate) name: String,
    pub(crate) owner: String,
    pub(crate) params: String,
    pub(crate) line: u32,
    pub(crate) column: u32,
    /// Key to group the call sites.
    pub(crate) key: (u8, u32, String),
    pub(crate) _m: Option<&'a CMember>,
}

/// The method, property or initializer that holds a line.
pub(crate) fn locate<'a>(v: &View, fid: u32, model: &'a CModel, lang: Lang, file_name: &str, line: u32) -> Located<'a> {
    if let Some(ti) = innermost_type(model, line) {
        let td: &CType = &model.types[ti as usize];
        let owner = match v.d.file_types[fid as usize].get(ti as usize).copied().flatten() {
            Some(n) => v.node(n).qname.clone(),
            None => td.name.to_owned(),
        };
        let all: Vec<&CMember> = td.methods.iter().chain(td.fields.iter()).collect();
        let hold = all
            .iter()
            .filter(|m| m.line <= line && line <= member_end(m, &all, td.end_line, Some(td.line)))
            .max_by_key(|m| m.line);
        return match hold {
            Some(m) => Located {
                kind: call_kind(m.kind),
                name: m.name.to_owned(),
                owner,
                params: params_text(m, lang),
                line: m.line,
                column: m.column,
                key: (1, m.line, m.name.to_owned()),
                _m: Some(m),
            },
            None => Located {
                kind: CallKind::Initializer,
                name: td.name.to_owned(),
                owner,
                params: String::new(),
                line: td.line,
                column: td.column,
                key: (0, td.line, td.name.to_owned()),
                _m: None,
            },
        };
    }
    // Top-level code.
    let all: Vec<&CMember> = model.top_level.iter().collect();
    let next_type = model.types.iter().filter(|t| t.outer.is_none()).map(|t| t.start_line);
    let hold = all
        .iter()
        .filter(|m| {
            let mut limit = u32::MAX;
            for l in next_type.clone().filter(|&l| l > m.line) {
                limit = limit.min(l - 1);
            }
            m.line <= line && line <= member_end(m, &all, limit, None)
        })
        .max_by_key(|m| m.line);
    match hold {
        Some(m) => Located {
            kind: if m.kind == MemberKind::Method { CallKind::Function } else { CallKind::Property },
            name: m.name.to_owned(),
            owner: String::new(),
            params: params_text(m, lang),
            line: m.line,
            column: m.column,
            key: (1, m.line, m.name.to_owned()),
            _m: Some(m),
        },
        None => Located {
            kind: CallKind::Initializer,
            name: file_name.to_owned(),
            owner: String::new(),
            params: String::new(),
            line: 1,
            column: 1,
            key: (0, 0, String::new()),
            _m: None,
        },
    }
}

struct Resolved {
    target: CallTarget,
    subj: Subject,
    name: String,
    lang: Lang,
    fid: u32,
    path: PathBuf,
    text: String,
    index: Arc<Index>,
    property: bool,
    owner_known: bool,
    /// An initializer has no callers.
    no_callers: bool,
}

fn target_of(v: &View, owner: Option<TypeId>, file: u32, m: &CMember, lang: Lang) -> CallTarget {
    CallTarget {
        owner: owner.map(|o| v.node(o).qname.clone()).unwrap_or_default(),
        name: m.name.to_owned(),
        kind: if owner.is_none() && m.kind == MemberKind::Method {
            CallKind::Function
        } else {
            call_kind(m.kind)
        },
        params: params_text(m, lang),
        path: v.files[file as usize].path.to_string_lossy().into_owned(),
        line: m.line,
        column: m.column,
        lang: lang.into(),
    }
}

fn declared_in<'a>(v: &View<'a>, owner: TypeId, name: &str, line: Option<u32>) -> Option<(u32, &'a CMember)> {
    let mut first = None;
    for (f, i) in v.parts(owner) {
        for m in v.files[f as usize].model.types[i as usize].fields.iter().chain(v.files[f as usize].model.types[i as usize].methods.iter()) {
            if m.name == name {
                if line.is_none() || line == Some(m.line) {
                    return Some((f, m));
                }
                first.get_or_insert((f, m));
            }
        }
    }
    first
}

fn from_position(index: &Arc<Index>, at: &CallAt, cancel: &AtomicBool) -> Result<Option<Resolved>> {
    let path = PathBuf::from(&at.path);
    let text = match &at.text {
        Some(t) => t.clone(),
        None => read_text(&path).ok_or_else(|| Error::not_found(format!("cannot read {}", at.path)))?,
    };
    let Some(c) = classify_at(index, &path, &text, at.text.is_some(), at.line, at.column, cancel)? else { return Ok(None) };
    let index = c.index.clone();
    let v = index.view();
    let (subj, target, property, owner_known) = match c.subj.kind {
        Some(SymbolKind::Member) => {
            let Some(&owner) = c.subj.owners.first() else { return Ok(None) };
            let line = c.subj.sym.as_ref().and_then(|s| s.declaration.as_ref()).map(|d| d.line);
            let Some((f, m)) = declared_in(&v, owner, &c.name, line) else { return Ok(None) };
            let t = target_of(&v, Some(owner), f, m, c.lang);
            if m.kind == MemberKind::Constructor {
                (type_subject(&v, owner, &c.name), t, false, true)
            } else {
                let found = Found { owner, file: f, m };
                (member_subject(&v, vec![owner], Some(found), &c.name, c.lang), t, t_is_property(m), true)
            }
        }
        Some(SymbolKind::TopLevel) => {
            let (f, i) = c.subj.top[0];
            let m = &v.files[f as usize].model.top_level[i as usize];
            let t = target_of(&v, None, f, m, c.lang);
            (top_subject(&v, vec![(f, i)], &c.name, c.lang), t, t_is_property(m), false)
        }
        Some(SymbolKind::Type) if matches!(c.hit_kind, UsageKind::Call | UsageKind::Instantiation) => {
            let Some(ty) = c.subj.ty else { return Ok(None) };
            let d = v.decl(ty);
            let fe = v.file_of(ty);
            let ctor = v.parts(ty).into_iter().find_map(|(f, i)| {
                v.files[f as usize].model.types[i as usize].methods.iter().find(|m| m.kind == MemberKind::Constructor).map(|m| (f, m))
            });
            let t = match ctor {
                Some((f, m)) => target_of(&v, Some(ty), f, m, c.lang),
                None => CallTarget {
                    owner: v.node(ty).qname.clone(),
                    name: d.name.to_owned(),
                    kind: CallKind::Constructor,
                    params: String::new(),
                    path: fe.path.to_string_lossy().into_owned(),
                    line: d.line,
                    column: d.column,
                    lang: fe.lang.into(),
                },
            };
            (type_subject(&v, ty, &c.name), t, false, true)
        }
        _ => return Ok(None),
    };
    drop(v);
    Ok(Some(Resolved {
        target,
        subj,
        name: c.name,
        lang: c.lang,
        fid: c.fid,
        path,
        text,
        index,
        property,
        owner_known,
        no_callers: false,
    }))
}

fn t_is_property(m: &CMember) -> bool {
    !matches!(m.kind, MemberKind::Method | MemberKind::Constructor)
}

/// Finds an earlier answer again. When the file changed, owner, name and params decide.
fn from_target(index: &Arc<Index>, t: &CallTarget) -> Result<Option<Resolved>> {
    let path = PathBuf::from(&t.path);
    let Some(fid) = index.file_id(&path) else { return Ok(None) };
    let v = index.view();
    let lang = index.file(fid).lang;
    let text = read_text(&path).unwrap_or_default();
    let mk = |subj: Subject, target: CallTarget, property: bool, known: bool, no_callers: bool| Resolved {
        target,
        subj,
        name: t.name.clone(),
        lang,
        fid,
        path: path.clone(),
        text: text.clone(),
        index: index.clone(),
        property,
        owner_known: known,
        no_callers,
    };
    if t.kind == CallKind::Initializer {
        return Ok(Some(mk(Subject::default(), t.clone(), false, false, true)));
    }
    let pick = |cands: Vec<(u32, &CMember)>| -> Option<(u32, usize)> {
        let by_line = cands.iter().position(|(f, m)| v.files[*f as usize].path == path && m.line == t.line);
        let by_params = || cands.iter().position(|(f, m)| params_text(m, v.files[*f as usize].lang) == t.params);
        let idx = by_line.or_else(by_params).or(if cands.len() == 1 { Some(0) } else { None })?;
        Some((cands[idx].0, idx))
    };
    if t.owner.is_empty() {
        let Some(list) = v.d.top_by_name.get(t.name.as_str()) else { return Ok(None) };
        let cands: Vec<(u32, &CMember)> = list.iter().map(|&(f, i)| (f, &v.files[f as usize].model.top_level[i as usize])).collect();
        let Some((_, idx)) = pick(cands.clone()) else { return Ok(None) };
        let (f, m) = cands[idx];
        let i = list[idx].1;
        let target = target_of(&v, None, f, m, lang);
        return Ok(Some(mk(top_subject(&v, vec![(f, i)], &t.name, lang), target, t_is_property(m), false, false)));
    }
    let Some(owners) = v.d.by_qname.get(&t.owner) else { return Ok(None) };
    let owner = owners.iter().copied().find(|&o| v.file_of(o).path == path).unwrap_or(owners[0]);
    if t.kind == CallKind::Constructor {
        let ctor: Vec<(u32, &CMember)> = v
            .parts(owner)
            .into_iter()
            .flat_map(|(f, i)| v.files[f as usize].model.types[i as usize].methods.iter().filter(|m| m.kind == MemberKind::Constructor).map(move |m| (f, m)).collect::<Vec<_>>())
            .collect();
        let target = match pick(ctor.clone()) {
            Some((_, idx)) => target_of(&v, Some(owner), ctor[idx].0, ctor[idx].1, lang),
            None => CallTarget { line: v.decl(owner).line, column: v.decl(owner).column, ..t.clone() },
        };
        return Ok(Some(mk(type_subject(&v, owner, &t.name), target, false, true, false)));
    }
    let mut cands: Vec<(u32, &CMember)> = Vec::new();
    for (f, i) in v.parts(owner) {
        let d = &v.files[f as usize].model.types[i as usize];
        cands.extend(d.fields.iter().chain(d.methods.iter()).filter(|m| m.name == t.name).map(|m| (f, m)));
    }
    let Some((_, idx)) = pick(cands.clone()) else { return Ok(None) };
    let (f, m) = cands[idx];
    let target = target_of(&v, Some(owner), f, m, lang);
    let found = Found { owner, file: f, m };
    Ok(Some(mk(member_subject(&v, vec![owner], Some(found), &t.name, lang), target, t_is_property(m), true, false)))
}

pub fn run(index: &Arc<Index>, req: &CallersRequest, cancel: &AtomicBool) -> Result<CallersResult> {
    let t0 = Instant::now();
    let none = |t0: Instant| CallersResult { target: None, callers: vec![], exact: false, truncated: false, elapsed_ms: t0.elapsed().as_millis() as u64 };
    let resolved = match (&req.at, &req.target) {
        (_, Some(t)) => from_target(index, t)?,
        (Some(at), None) => from_position(index, at, cancel)?,
        _ => return Err(Error::invalid("callers: give `at` or `target`")),
    };
    let Some(r) = resolved else { return Ok(none(t0)) };
    if r.no_callers {
        return Ok(CallersResult { target: Some(r.target), callers: vec![], exact: true, truncated: false, elapsed_ms: t0.elapsed().as_millis() as u64 });
    }
    check(cancel)?;
    let max = req.max_results.max(1);
    let found = collect(&r.index, &r.subj, &r.name, r.lang, r.fid, &r.path, &r.text, false, max, Some(r.property), cancel)?;
    check(cancel)?;
    let index = &r.index;
    let v = index.view();
    let root = PathBuf::from(&req.root);
    let mut callers: Vec<CallerNode> = Vec::new();
    let mut slot: HashMap<(u32, (u8, u32, String)), usize> = HashMap::new();
    for fh in &found.files {
        let fe = index.file(fh.file);
        let text = if fe.path == r.path { r.text.clone() } else { read_text(&fe.path).unwrap_or_default() };
        let starts = line_starts(&text);
        let matches = crate::usages::matches_of(&text, &fh.hits);
        let file_name = fe.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let test = is_test_path(&root, &fe.path);
        for (hit, m) in fh.hits.iter().zip(matches) {
            let line = starts.partition_point(|&s| s <= hit.0) as u32;
            let loc = locate(&v, fh.file, &fe.model, fe.lang, &file_name, line);
            let site = CallSite { line: m.line, column: m.column, text: m.text, range: m.range };
            let key = (fh.file, loc.key.clone());
            match slot.get(&key) {
                Some(&i) => callers[i].sites.push(site),
                None => {
                    slot.insert(key, callers.len());
                    callers.push(CallerNode {
                        caller: CallTarget {
                            owner: loc.owner,
                            name: loc.name,
                            kind: loc.kind,
                            params: loc.params,
                            path: fe.path.to_string_lossy().into_owned(),
                            line: loc.line,
                            column: loc.column,
                            lang: fe.lang.into(),
                        },
                        sites: vec![site],
                        likely: fh.likely,
                        test,
                    });
                }
            }
        }
    }
    callers.sort_by(|a, b| (&a.caller.path, a.caller.line).cmp(&(&b.caller.path, b.caller.line)));
    for c in &mut callers {
        c.sites.sort_by_key(|s| (s.line, s.column));
    }
    let exact = r.target.kind == CallKind::Constructor || (r.owner_known && callers.iter().all(|c| c.likely));
    Ok(CallersResult { target: Some(r.target), callers, exact, truncated: found.truncated, elapsed_ms: t0.elapsed().as_millis() as u64 })
}
