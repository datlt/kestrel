//! The class diagram: start types from the scope, a breadth first walk
//! over the chosen relations, and the nodes and edges for the frontend.

use crate::derived::{last_seg, Target, TypeId, View, Want};
use crate::index::{innermost_type, parse_text, Index};
use crate::textutil::{ident_range, line_text, qualifier_before};
use crate::types::*;
use crate::walk::lang_of;
use kestrel_common::{Error, Result};
use crate::cmodel::CMember as Member;
use kestrel_lang::{Lang, MemberKind, TypeKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const MAX_MEMBERS: usize = 60;
/// A node with more neighbors than this in one direction is not expanded.
pub const MAX_FAN: usize = 20;

fn kind_rank(k: RelationKind) -> u8 {
    match k {
        RelationKind::Extends => 0,
        RelationKind::Implements => 1,
        RelationKind::Composition => 2,
        RelationKind::Aggregation => 3,
        RelationKind::Dependency => 4,
        RelationKind::Nested => 5,
    }
}

fn target_name(v: &View, t: &Target) -> String {
    match t {
        Target::Type(x) => v.node(*x).id(),
        Target::Ext(n) => n.clone(),
    }
}

/// Parses `text` for the file and returns an index that uses it. The same
/// index when the model does not differ from the stored one.
pub fn overlay(index: &Arc<Index>, path: &Path, text: &str) -> Arc<Index> {
    let Some(lang) = lang_of(path) else { return index.clone() };
    let model = parse_text(lang, text);
    if let Some(id) = index.file_id(path) {
        if index.file(id).model == model {
            return index.clone();
        }
    }
    Arc::new(index.with_model(path, lang, model))
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { Err(Error::cancelled()) } else { Ok(()) }
}

pub fn find_by_id(v: &View, id: &str) -> Option<TypeId> {
    let (q, n) = match id.rsplit_once('#') {
        Some((q, n)) if n.parse::<usize>().is_ok() => (q, n.parse::<usize>().unwrap_or(1).max(1)),
        _ => (id, 1),
    };
    v.d.by_qname.get(q)?.get(n - 1).copied()
}

fn push_unique(v: &mut Vec<TypeId>, t: TypeId) {
    if !v.contains(&t) {
        v.push(t);
    }
}

fn start_types(v: &View, index: &Index, scope: &DiagramScope, text_of: &dyn Fn(&Path) -> Option<String>) -> Vec<TypeId> {
    let mut out = Vec::new();
    match scope {
        DiagramScope::Types { ids } => {
            for id in ids {
                if let Some(t) = find_by_id(v, id) {
                    push_unique(&mut out, t);
                }
            }
        }
        DiagramScope::File { path, .. } => {
            if let Some(f) = index.file_id(Path::new(path)) {
                for t in v.d.file_types[f as usize].iter().flatten() {
                    push_unique(&mut out, *t);
                }
            }
        }
        DiagramScope::Folder { path } => {
            let base = PathBuf::from(path);
            for (f, e) in index.files.iter().enumerate() {
                if e.path.starts_with(&base) {
                    for t in v.d.file_types[f].iter().flatten() {
                        push_unique(&mut out, *t);
                    }
                }
            }
        }
        DiagramScope::Cursor { path, line, column, .. } => {
            let p = Path::new(path);
            let Some(f) = index.file_id(p) else { return out };
            let model = &index.file(f).model;
            let ft = &v.d.file_types[f as usize];
            let ctx = innermost_type(model, *line);
            if let Some(text) = text_of(p) {
                if let Some(l) = line_text(&text, *line) {
                    if let Some((s, e)) = ident_range(l, *column) {
                        let ident = &l[s..e];
                        // A declaration of a type on this line.
                        for (i, t) in model.types.iter().enumerate() {
                            if t.line == *line && t.name == ident {
                                if let Some(Some(n)) = ft.get(i) {
                                    return vec![*n];
                                }
                            }
                        }
                        let qual = qualifier_before(l, s);
                        let mut names = Vec::new();
                        if !qual.is_empty() {
                            names.push(format!("{qual}.{ident}"));
                        }
                        names.push(ident.to_owned());
                        for n in names {
                            if let crate::derived::Res::Project(t) = v.resolve(f, ctx, &n) {
                                return vec![t];
                            }
                        }
                    }
                }
            }
            if let Some(i) = ctx {
                if let Some(Some(n)) = ft.get(i as usize) {
                    out.push(*n);
                }
            }
        }
    }
    out
}

fn want_for(rel: &[RelationKind]) -> Want {
    let deps = rel.contains(&RelationKind::Dependency);
    let parts = deps || rel.iter().any(|k| matches!(k, RelationKind::Composition | RelationKind::Aggregation | RelationKind::Nested));
    Want { parts, deps }
}

fn params_text(m: &Member, lang: Lang) -> String {
    let mut s = String::new();
    for (i, p) in m.params.iter().enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        match (&p.ty, lang) {
            (Some(t), Lang::Java) => {
                s.push_str(&t.text);
                s.push(' ');
                s.push_str(&p.name);
            }
            (Some(t), _) => {
                s.push_str(&p.name);
                s.push_str(": ");
                s.push_str(&t.text);
            }
            (None, _) => s.push_str(&p.name),
        }
    }
    s
}

fn member_out(m: &Member, lang: Lang) -> DiagramMember {
    DiagramMember {
        name: m.name.to_string(),
        kind: m.kind,
        visibility: m.visibility,
        is_static: m.is_static,
        is_abstract: m.is_abstract,
        ty: m.ty.as_ref().map(|t| t.text.to_string()).unwrap_or_default(),
        params: if m.kind == MemberKind::Method || m.kind == MemberKind::Constructor { params_text(m, lang) } else { String::new() },
        line: m.line,
        column: m.column,
    }
}

pub fn node_out(v: &View, root: &Path, t: TypeId) -> DiagramNode {
    let n = v.node(t);
    let decl = v.decl(t);
    let fe = v.file_of(t);
    let mut fields = Vec::new();
    let mut methods = Vec::new();
    let mut truncated = false;
    for (f, i) in v.parts(t) {
        let pf = &v.files[f as usize];
        let pd = &pf.model.types[i as usize];
        for m in &pd.fields {
            if fields.len() < MAX_MEMBERS { fields.push(member_out(m, pf.lang)) } else { truncated = true }
        }
        for m in &pd.methods {
            if methods.len() < MAX_MEMBERS { methods.push(member_out(m, pf.lang)) } else { truncated = true }
        }
    }
    let container = if fe.lang == Lang::Swift {
        fe.path.parent().and_then(|p| kestrel_common::paths::relative_slash(root, p)).unwrap_or_default()
    } else {
        n.qname.rsplit_once('.').map(|(h, _)| h.to_owned()).unwrap_or_default()
    };
    DiagramNode {
        id: n.id(),
        name: decl.name.to_string(),
        container,
        kind: decl.kind,
        lang: Some(fe.lang),
        path: Some(fe.path.to_string_lossy().into_owned()),
        line: decl.line,
        column: decl.column,
        modifiers: decl.modifiers.iter().map(|s| s.to_string()).collect(),
        annotations: decl.annotations.iter().map(|s| s.to_string()).collect(),
        type_params: decl.type_params.iter().map(|s| s.to_string()).collect(),
        fields,
        methods,
        members_truncated: truncated,
        external: false,
        hidden_in: 0,
        hidden_out: 0,
    }
}

fn ext_node(name: &str, kind: TypeKind) -> DiagramNode {
    DiagramNode {
        id: format!("ext:{name}"),
        name: last_seg(name).to_owned(),
        container: String::new(),
        kind,
        lang: None,
        path: None,
        line: 0,
        column: 0,
        modifiers: vec![],
        annotations: vec![],
        type_params: vec![],
        fields: vec![],
        methods: vec![],
        members_truncated: false,
        external: true,
        hidden_in: 0,
        hidden_out: 0,
    }
}

pub fn run(
    index: &Arc<Index>,
    req: &DiagramRequest,
    status: CodeIndexStatus,
    cancel: &AtomicBool,
) -> Result<DiagramResult> {
    // The editor text replaces the file on disk for this request.
    let (scope_path, scope_text) = match &req.scope {
        DiagramScope::Cursor { path, text, .. } => (Some(path), text.as_ref()),
        DiagramScope::File { path, text } => (Some(path), text.as_ref()),
        _ => (None, None),
    };
    let index = match (scope_path, scope_text) {
        (Some(p), Some(t)) => overlay(index, Path::new(p), t),
        _ => index.clone(),
    };
    let v = index.view();
    cancelled(cancel)?;
    let read = |p: &Path| -> Option<String> {
        if let Some(t) = scope_text {
            return Some(t.clone());
        }
        std::fs::read(p).ok().map(crate::textutil::decode)
    };
    let mut starts = start_types(&v, &index, &req.scope, &read);
    let max = req.max_nodes.max(1);
    let mut truncated = false;
    if starts.len() > max {
        starts.truncate(max);
        truncated = true;
    }
    let max_fan = req.max_fan.unwrap_or(MAX_FAN).clamp(1, 500);
    let rel = &req.relations;
    let want = want_for(rel);
    let mut order: Vec<Target> = starts.iter().map(|t| Target::Type(*t)).collect();
    let mut pos: HashMap<Target, usize> = order.iter().cloned().enumerate().map(|(i, t)| (t, i)).collect();
    let mut ext_kind: HashMap<String, RelationKind> = HashMap::new();
    let mut frontier: Vec<TypeId> = starts.clone();
    let mut hidden_in: HashMap<TypeId, usize> = HashMap::new();
    let mut hidden_out: HashMap<TypeId, usize> = HashMap::new();
    let full = rel.iter().any(|k| matches!(k, RelationKind::Composition | RelationKind::Aggregation | RelationKind::Dependency | RelationKind::Nested));
    let gather = |t: TypeId| -> Vec<(bool, Vec<(Target, RelationKind)>)> {
        let mut lists: Vec<(bool, Vec<(Target, RelationKind)>)> = Vec::new();
        if matches!(req.direction, Direction::Out | Direction::Both) {
            let mut l = Vec::new();
            for e in v.out_edges(t, want) {
                if rel.contains(&e.kind) && (req.include_external || matches!(e.to, Target::Type(_))) {
                    l.push((e.to, e.kind));
                }
            }
            lists.push((false, l));
        }
        if matches!(req.direction, Direction::In | Direction::Both) {
            let mut l = Vec::new();
            for &(from, k) in v.reverse(full).incoming(t) {
                if rel.contains(&k) {
                    l.push((Target::Type(from), k));
                }
            }
            lists.push((true, l));
        }
        lists
    };
    let mut ended_by_depth = true;
    'walk: for _ in 0..req.depth.min(5) {
        let mut next = Vec::new();
        for &t in &frontier {
            cancelled(cancel)?;
            let is_start = starts.contains(&t);
            let lists = gather(t);
            for (incoming, mut list) in lists {
                // One entry per neighbor, with its nearest kind.
                list.sort_by_key(|(_, k)| kind_rank(*k));
                let mut seen = std::collections::HashSet::new();
                list.retain(|(to, _)| seen.insert(to.clone()));
                if list.len() > max_fan {
                    if is_start {
                        list.sort_by_cached_key(|(to, k)| (kind_rank(*k), target_name(&v, to)));
                    }
                    let rest: Vec<_> = if is_start { list.split_off(max_fan) } else { std::mem::take(&mut list) };
                    let hidden = rest.iter().filter(|(to, _)| !pos.contains_key(to) && !list.iter().any(|(x, _)| x == to)).count();
                    if hidden > 0 {
                        let map = if incoming { &mut hidden_in } else { &mut hidden_out };
                        *map.entry(t).or_insert(0) += hidden;
                    }
                }
                for (to, k) in list {
                    if pos.contains_key(&to) {
                        continue;
                    }
                    if order.len() >= max {
                        truncated = true;
                        break 'walk;
                    }
                    if let Target::Ext(n) = &to {
                        ext_kind.entry(n.clone()).or_insert(k);
                    } else if let Target::Type(x) = &to {
                        next.push(*x);
                    }
                    pos.insert(to.clone(), order.len());
                    order.push(to);
                }
            }
        }
        frontier = next;
        if frontier.is_empty() {
            ended_by_depth = false;
            break;
        }
    }
    // Hubs at the depth limit are not expanded either. Count what is left out.
    if ended_by_depth {
        for &t in &frontier {
            for (incoming, list) in gather(t) {
                let mut seen = std::collections::HashSet::new();
                let list: Vec<_> = list.into_iter().filter(|(to, _)| seen.insert(to.clone())).collect();
                if list.len() > max_fan {
                    let hidden = list.iter().filter(|(to, _)| !pos.contains_key(to)).count();
                    if hidden > 0 {
                        let map = if incoming { &mut hidden_in } else { &mut hidden_out };
                        *map.entry(t).or_insert(0) += hidden;
                    }
                }
            }
        }
    }
    cancelled(cancel)?;
    // Every edge between the nodes, not only the walked ones.
    let mut edges = Vec::new();
    for t in order.clone() {
        let Target::Type(id) = t else { continue };
        let from = v.node(id).id();
        for e in v.out_edges(id, want) {
            if !rel.contains(&e.kind) || !pos.contains_key(&e.to) {
                continue;
            }
            let to = match &e.to {
                Target::Type(x) => v.node(*x).id(),
                Target::Ext(n) => format!("ext:{n}"),
            };
            let multiplicity = match e.kind {
                RelationKind::Aggregation => Some("*".to_owned()),
                RelationKind::Composition if e.all_nullable => Some("0..1".to_owned()),
                _ => None,
            };
            let label = matches!(e.kind, RelationKind::Composition | RelationKind::Aggregation)
                .then(|| e.labels.join(", "))
                .filter(|l| !l.is_empty());
            edges.push(DiagramEdge { from: from.clone(), to, kind: e.kind, label, multiplicity, delegated: e.delegated });
        }
    }
    let swift_ext = starts.first().is_some_and(|t| v.file_of(*t).lang == Lang::Swift);
    let nodes = order
        .iter()
        .map(|t| match t {
            Target::Type(id) => {
                let mut n = node_out(&v, &index.root, *id);
                n.hidden_in = hidden_in.get(id).copied().unwrap_or(0);
                n.hidden_out = hidden_out.get(id).copied().unwrap_or(0);
                n
            }
            Target::Ext(n) => {
                let k = match ext_kind.get(n) {
                    Some(RelationKind::Implements) if swift_ext => TypeKind::Protocol,
                    Some(RelationKind::Implements) => TypeKind::Interface,
                    _ => TypeKind::Class,
                };
                ext_node(n, k)
            }
        })
        .collect();
    let focus = starts.iter().map(|t| v.node(*t).id()).collect();
    Ok(DiagramResult { nodes, edges, focus, truncated, index: status })
}
