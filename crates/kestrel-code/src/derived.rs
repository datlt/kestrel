//! Tables built from all file models: the type nodes, name resolution and
//! the relations between types.

use crate::index::FileEntry;
use crate::types::RelationKind;
use crate::cmodel::{CRef, CSuper};
use kestrel_lang::{Lang, TypeKind};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, OnceLock};

pub type TypeId = u32;

pub struct TypeNode {
    pub qname: String,
    /// 0 for the first type with this qualified name, 1 for `#2` ...
    pub dup: u32,
    pub file: u32,
    /// Index in `FileModel::types`.
    pub idx: u32,
    /// Swift extensions merged into this type: (file, index).
    pub exts: Vec<(u32, u32)>,
    pub outer: Option<TypeId>,
    pub children: Vec<TypeId>,
}

impl TypeNode {
    pub fn id(&self) -> String {
        if self.dup == 0 { self.qname.clone() } else { format!("{}#{}", self.qname, self.dup + 1) }
    }
}

/// Reverse edges, grouped by the target type.
pub struct Csr {
    start: Vec<u32>,
    edges: Vec<(TypeId, RelationKind)>,
}

impl Csr {
    pub fn incoming(&self, to: TypeId) -> &[(TypeId, RelationKind)] {
        let i = to as usize;
        &self.edges[self.start[i] as usize..self.start[i + 1] as usize]
    }
}

pub struct Derived {
    pub nodes: Vec<TypeNode>,
    /// Per file and per index in `FileModel::types`: the node. An extension
    /// gives the node of the type it extends (`None` when that is not in the project).
    pub file_types: Vec<Vec<Option<TypeId>>>,
    pub by_qname: HashMap<String, Vec<TypeId>>,
    /// Swift types by simple name.
    pub by_simple: HashMap<&'static str, Vec<TypeId>>,
    /// Top-level functions and properties by name: (file, index in `top_level`).
    pub top_by_name: HashMap<&'static str, Vec<(u32, u32)>>,
    inherit_rev: OnceLock<Csr>,
    full_rev: OnceLock<Csr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Res {
    Project(TypeId),
    /// Not in the project. The name as written.
    External(String),
    /// A basic type (`String`, `Int`, `List` ...).
    Basic,
    TypeParam,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Target {
    Type(TypeId),
    Ext(String),
}

#[derive(Debug, Clone)]
pub struct OutEdge {
    pub to: Target,
    pub kind: RelationKind,
    pub labels: Vec<String>,
    pub all_nullable: bool,
    pub delegated: bool,
}

// --- Name lists ---------------------------------------------------------------

const BASIC: &[&str] = &[
    "String", "Int", "Long", "Short", "Byte", "Char", "Float", "Double", "Boolean", "Number", "Any", "Object", "Unit",
    "Void", "Nothing", "Integer", "Character", "UInt", "ULong", "UByte", "UShort", "ByteArray", "IntArray", "LongArray",
    "DoubleArray", "FloatArray", "BooleanArray", "CharArray", "ShortArray", "Array", "List", "MutableList", "ArrayList",
    "LinkedList", "Set", "MutableSet", "HashSet", "LinkedHashSet", "TreeSet", "SortedSet", "Map", "MutableMap",
    "HashMap", "LinkedHashMap", "TreeMap", "SortedMap", "ConcurrentHashMap", "Collection", "MutableCollection",
    "Iterable", "MutableIterable", "Iterator", "Sequence", "Pair", "Triple", "Comparable", "CharSequence", "Throwable",
    "Exception", "RuntimeException", "Error", "Class", "KClass", "Optional", "Lazy", "Function", "Serializable",
    "Cloneable", "Enum", "Annotation", "Bool", "Dictionary", "Character", "Int8", "Int16", "Int32", "Int64", "UInt8",
    "UInt16", "UInt32", "UInt64", "Never", "AnyObject", "AnyHashable", "Hashable", "Equatable", "Codable", "Encodable",
    "Decodable", "Sendable", "Identifiable", "CustomStringConvertible", "RawRepresentable", "CaseIterable", "Void",
    "ContiguousArray", "ArraySlice", "Result", "Runnable", "Deque", "Queue", "ArrayDeque", "Stack", "Vector",
];

const COLLECTIONS: &[&str] = &[
    "List", "MutableList", "ArrayList", "LinkedList", "Set", "MutableSet", "HashSet", "LinkedHashSet", "TreeSet",
    "SortedSet", "Collection", "MutableCollection", "Iterable", "MutableIterable", "Iterator", "Sequence", "Array",
    "ArrayDeque", "Deque", "Queue", "Stack", "Vector", "Map", "MutableMap", "HashMap", "LinkedHashMap", "TreeMap",
    "SortedMap", "ConcurrentHashMap", "ConcurrentMap", "EnumMap", "Dictionary", "ContiguousArray", "ArraySlice",
    "Flow", "StateFlow", "MutableStateFlow", "SharedFlow", "MutableSharedFlow", "Flux", "Stream", "ImmutableList",
    "ImmutableSet", "ImmutableMap", "PersistentList", "PersistentSet", "PersistentMap", "OrderedSet", "Page",
    "CopyOnWriteArrayList", "ConcurrentLinkedQueue", "BlockingQueue", "LinkedBlockingQueue", "PriorityQueue",
];

/// Types that wrap one part: the part is still held once.
const WRAPPERS: &[&str] = &[
    "Optional", "Option", "Lazy", "Provider", "Supplier", "AtomicReference", "WeakReference", "SoftReference", "Weak",
    "Unmanaged", "Mono", "Deferred", "Future", "CompletableFuture", "Single", "Maybe", "ObjectProvider", "Result",
    "ThreadLocal", "LiveData", "MutableLiveData", "Ref", "Box", "Published", "Property", "Atomic", "Volatile",
];

const OPTIONAL_WRAPPERS: &[&str] = &["Optional", "Option", "Maybe"];

const KOTLIN_DEFAULTS: &[&str] = &[
    "kotlin", "kotlin.annotation", "kotlin.collections", "kotlin.comparisons", "kotlin.io", "kotlin.ranges",
    "kotlin.sequences", "kotlin.text", "kotlin.jvm", "java.lang",
];

fn set(list: &'static [&'static str], cell: &'static OnceLock<HashSet<&'static str>>) -> &'static HashSet<&'static str> {
    cell.get_or_init(|| list.iter().copied().collect())
}

pub fn last_seg(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

pub fn is_basic(name: &str) -> bool {
    static C: OnceLock<HashSet<&'static str>> = OnceLock::new();
    set(BASIC, &C).contains(last_seg(name))
}

pub fn is_collection(name: &str) -> bool {
    static C: OnceLock<HashSet<&'static str>> = OnceLock::new();
    set(COLLECTIONS, &C).contains(last_seg(name))
}

pub fn is_wrapper(name: &str) -> bool {
    static C: OnceLock<HashSet<&'static str>> = OnceLock::new();
    set(WRAPPERS, &C).contains(last_seg(name))
}

fn is_iface(k: TypeKind) -> bool {
    matches!(k, TypeKind::Interface | TypeKind::Protocol)
}

/// One or two upper-case letters: most likely a type parameter of a method.
fn looks_like_type_param(name: &str) -> bool {
    let n = name.chars().count();
    n <= 2 && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) && !name.is_empty()
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() { name.to_owned() } else { format!("{prefix}.{name}") }
}

// --- Build --------------------------------------------------------------------

impl Derived {
    pub fn build(files: &[Arc<FileEntry>]) -> Derived {
        let mut nodes: Vec<TypeNode> = Vec::new();
        let mut file_types: Vec<Vec<Option<TypeId>>> = Vec::with_capacity(files.len());
        let mut by_qname: HashMap<String, Vec<TypeId>> = HashMap::new();
        let mut by_simple: HashMap<&'static str, Vec<TypeId>> = HashMap::new();
        let mut top_by_name: HashMap<&'static str, Vec<(u32, u32)>> = HashMap::new();
        for (fi, f) in files.iter().enumerate() {
            let m = &f.model;
            let mut ft: Vec<Option<TypeId>> = vec![None; m.types.len()];
            let mut qn: Vec<String> = Vec::with_capacity(m.types.len());
            for (i, t) in m.types.iter().enumerate() {
                let q = match t.outer {
                    Some(o) if o < i => format!("{}.{}", qn[o], t.name),
                    _ => join(&m.package, &t.name),
                };
                if t.kind != TypeKind::Extension {
                    let id = nodes.len() as TypeId;
                    let list = by_qname.entry(q.clone()).or_default();
                    let dup = list.len() as u32;
                    list.push(id);
                    if f.lang == Lang::Swift && t.outer.is_none() {
                        by_simple.entry(t.name).or_default().push(id);
                    }
                    nodes.push(TypeNode {
                        qname: q.clone(),
                        dup,
                        file: fi as u32,
                        idx: i as u32,
                        exts: Vec::new(),
                        outer: None,
                        children: Vec::new(),
                    });
                    ft[i] = Some(id);
                }
                qn.push(q);
            }
            for (i, m) in m.top_level.iter().enumerate() {
                top_by_name.entry(m.name).or_default().push((fi as u32, i as u32));
            }
            file_types.push(ft);
        }
        let mut d = Derived {
            nodes,
            file_types,
            by_qname,
            by_simple,
            top_by_name,
            inherit_rev: OnceLock::new(),
            full_rev: OnceLock::new(),
        };
        // Swift extensions: merge into the extended type.
        let mut merges: Vec<(u32, u32, TypeId)> = Vec::new();
        for (fi, f) in files.iter().enumerate() {
            for (i, t) in f.model.types.iter().enumerate() {
                if t.kind == TypeKind::Extension {
                    if let Res::Project(target) = resolve_in(files, &d, fi as u32, None, &t.name) {
                        merges.push((fi as u32, i as u32, target));
                    }
                }
            }
        }
        for (fi, i, target) in merges {
            d.nodes[target as usize].exts.push((fi, i));
            d.file_types[fi as usize][i as usize] = Some(target);
        }
        // Outer and nested links.
        let mut links: Vec<(TypeId, TypeId)> = Vec::new();
        for (id, n) in d.nodes.iter().enumerate() {
            let t = &files[n.file as usize].model.types[n.idx as usize];
            if let Some(o) = t.outer {
                if let Some(Some(parent)) = d.file_types[n.file as usize].get(o) {
                    if *parent as usize != id {
                        links.push((id as TypeId, *parent));
                    }
                }
            }
        }
        for (child, parent) in links {
            d.nodes[child as usize].outer = Some(parent);
            d.nodes[parent as usize].children.push(child);
        }
        d
    }
}

// --- Name resolution ----------------------------------------------------------

fn same_family(files: &[Arc<FileEntry>], d: &Derived, id: TypeId, lang: Lang) -> bool {
    files[d.nodes[id as usize].file as usize].lang.is_jvm() == lang.is_jvm()
}

fn pick(files: &[Arc<FileEntry>], d: &Derived, q: &str, file: u32, lang: Lang) -> Option<TypeId> {
    let list = d.by_qname.get(q)?;
    let mut first = None;
    for &t in list {
        if !same_family(files, d, t, lang) {
            continue;
        }
        if d.nodes[t as usize].file == file {
            return Some(t);
        }
        first.get_or_insert(t);
    }
    first
}

fn common_len(a: &Path, b: &Path) -> usize {
    a.components().zip(b.components()).take_while(|(x, y)| x == y).count()
}

/// Resolves a type name that is written in `file`. `ctx` is the index of the
/// type (in `FileModel::types`) that holds the code.
pub fn resolve_in(files: &[Arc<FileEntry>], d: &Derived, file: u32, ctx: Option<u32>, name: &str) -> Res {
    if name.is_empty() {
        return Res::Skip;
    }
    let fe = &files[file as usize];
    let model = &fe.model;
    let lang = fe.lang;
    // 1. Type parameters of the type and of its outer types.
    let first = name.split('.').next().unwrap_or(name);
    let mut chain: Vec<usize> = Vec::new();
    let mut cur = ctx.map(|c| c as usize);
    while let Some(c) = cur {
        if chain.len() > 16 || c >= model.types.len() {
            break;
        }
        chain.push(c);
        cur = model.types[c].outer;
    }
    for &c in &chain {
        if model.types[c].type_params.iter().any(|p| *p == first) {
            return Res::TypeParam;
        }
    }
    if name.contains('.') {
        // Dotted: resolve the first part, then go down the nested types.
        if let Res::Project(t) = resolve_in(files, d, file, ctx, first) {
            let rest = &name[first.len() + 1..];
            let q = format!("{}.{}", d.nodes[t as usize].qname, rest);
            if let Some(n) = pick(files, d, &q, file, lang) {
                return Res::Project(n);
            }
        }
        if let Some(n) = pick(files, d, name, file, lang) {
            return Res::Project(n);
        }
        if is_basic(name) {
            return Res::Basic;
        }
        return Res::External(name.to_owned());
    }
    // 2. Nested types of the current type and its outer types.
    for &c in &chain {
        let base = match d.file_types[file as usize].get(c) {
            Some(Some(t)) => Some(d.nodes[*t as usize].qname.clone()),
            // An extension of a type outside the project still names its nested types.
            _ if model.types[c].kind == TypeKind::Extension => Some(join(&model.package, model.types[c].name)),
            _ => None,
        };
        if let Some(b) = base {
            if let Some(n) = pick(files, d, &format!("{b}.{name}"), file, lang) {
                return Res::Project(n);
            }
        }
    }
    // 3. Types of the same file.
    for (i, t) in model.types.iter().enumerate() {
        // Nested types are found through their outer type only.
        if t.name == name && t.kind != TypeKind::Extension && t.outer.is_none() {
            if let Some(Some(n)) = d.file_types[file as usize].get(i) {
                return Res::Project(*n);
            }
        }
    }
    if lang.is_jvm() {
        // 4. Explicit imports and aliases.
        for imp in &model.imports {
            if imp.wildcard || imp.is_static {
                continue;
            }
            let last = last_seg(&imp.path);
            let local = imp.alias.as_deref().unwrap_or(last);
            if local == name {
                return match pick(files, d, &imp.path, file, lang) {
                    Some(t) => Res::Project(t),
                    None if is_basic(last) => Res::Basic,
                    None => Res::External(last.to_owned()),
                };
            }
        }
        // 5. Same package.
        if let Some(t) = pick(files, d, &join(&model.package, name), file, lang) {
            return Res::Project(t);
        }
        // 6. Wildcard imports.
        for imp in &model.imports {
            if imp.wildcard && !imp.is_static {
                if let Some(t) = pick(files, d, &format!("{}.{}", imp.path, name), file, lang) {
                    return Res::Project(t);
                }
            }
        }
        // 7. Default imports.
        if lang == Lang::Kotlin {
            for p in KOTLIN_DEFAULTS {
                if let Some(t) = pick(files, d, &format!("{p}.{name}"), file, lang) {
                    return Res::Project(t);
                }
            }
        } else if let Some(t) = pick(files, d, &format!("java.lang.{name}"), file, lang) {
            return Res::Project(t);
        }
    } else if let Some(c) = d.by_simple.get(name) {
        // 8. Swift: a unique simple name, else the longest common path.
        if c.len() == 1 {
            return Res::Project(c[0]);
        }
        let dir = fe.path.parent().unwrap_or(Path::new(""));
        let mut best = (0usize, c[0]);
        let mut found = false;
        for &t in c {
            let p = files[d.nodes[t as usize].file as usize].path.parent().unwrap_or(Path::new(""));
            let n = common_len(dir, p);
            if !found || n > best.0 {
                best = (n, t);
                found = true;
            }
        }
        return Res::Project(best.1);
    }
    if is_basic(name) {
        Res::Basic
    } else if looks_like_type_param(name) {
        Res::TypeParam
    } else {
        Res::External(name.to_owned())
    }
}

// --- Relations ----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    One,
    Many,
    Weak,
}

struct Part<'a> {
    name: &'a str,
    mode: Mode,
    nullable: bool,
}

/// The types that a type text holds. Collections make the parts `Many`,
/// wrappers (`Optional`, `Lazy` ...) are transparent, type arguments of other
/// generic types are `Weak`.
fn collect_parts<'a>(t: &'a CRef, many: bool, nullable: bool, weak: bool, out: &mut Vec<Part<'a>>, depth: u32) {
    if depth > 8 {
        return;
    }
    let nullable = nullable || t.nullable;
    if t.name.is_empty() {
        for a in &t.args {
            collect_parts(a, false, false, true, out, depth + 1);
        }
        return;
    }
    let many = many || t.array;
    if is_wrapper(&t.name) {
        let nullable = nullable || set_contains_optional(&t.name);
        for a in &t.args {
            collect_parts(a, many, nullable, weak, out, depth + 1);
        }
        return;
    }
    if is_collection(&t.name) {
        for a in &t.args {
            collect_parts(a, true, nullable, weak, out, depth + 1);
        }
        return;
    }
    let mode = if weak { Mode::Weak } else if many { Mode::Many } else { Mode::One };
    out.push(Part { name: &t.name, mode, nullable });
    for a in &t.args {
        collect_parts(a, false, false, true, out, depth + 1);
    }
}

fn set_contains_optional(name: &str) -> bool {
    OPTIONAL_WRAPPERS.contains(&last_seg(name))
}

#[derive(Default)]
struct Acc {
    edges: Vec<OutEdge>,
}

impl Acc {
    fn add(&mut self, to: Target, kind: RelationKind, label: Option<&str>, nullable: bool, delegated: bool) {
        if let Some(e) = self.edges.iter_mut().find(|e| e.kind == kind && e.to == to) {
            if let Some(l) = label {
                if !e.labels.iter().any(|x| x == l) {
                    e.labels.push(l.to_owned());
                }
            }
            e.all_nullable &= nullable;
            e.delegated |= delegated;
            return;
        }
        self.edges.push(OutEdge {
            to,
            kind,
            labels: label.map(|l| vec![l.to_owned()]).unwrap_or_default(),
            all_nullable: nullable,
            delegated,
        });
    }

    fn has_target(&self, to: &Target) -> bool {
        self.edges.iter().any(|e| &e.to == to)
    }
}

/// Which relations `out_edges` computes. Supertypes are always computed.
#[derive(Clone, Copy)]
pub struct Want {
    pub parts: bool,
    pub deps: bool,
}

pub const INHERIT_ONLY: Want = Want { parts: false, deps: false };
pub const ALL: Want = Want { parts: true, deps: true };

pub struct View<'a> {
    pub files: &'a [Arc<FileEntry>],
    pub d: &'a Derived,
}

impl<'a> View<'a> {
    pub fn resolve(&self, file: u32, ctx: Option<u32>, name: &str) -> Res {
        resolve_in(self.files, self.d, file, ctx, name)
    }

    pub fn node(&self, id: TypeId) -> &'a TypeNode {
        &self.d.nodes[id as usize]
    }

    pub fn decl(&self, id: TypeId) -> &'a crate::cmodel::CType {
        let n = self.node(id);
        &self.files[n.file as usize].model.types[n.idx as usize]
    }

    pub fn file_of(&self, id: TypeId) -> &'a FileEntry {
        &self.files[self.node(id).file as usize]
    }

    /// Parts of a type: the declaration and its extensions.
    pub fn parts(&self, id: TypeId) -> Vec<(u32, u32)> {
        let n = self.node(id);
        let mut v = vec![(n.file, n.idx)];
        v.extend(n.exts.iter().copied());
        v
    }

    fn super_kind(&self, node_kind: TypeKind, lang: Lang, st: &CSuper, first_own: bool, target: Option<TypeKind>, name: &str) -> RelationKind {
        use kestrel_lang::SuperKind;
        match st.kind {
            SuperKind::Extends => RelationKind::Extends,
            SuperKind::Implements => RelationKind::Implements,
            SuperKind::Unknown => match target {
                Some(k) if is_iface(k) => {
                    if is_iface(node_kind) { RelationKind::Extends } else { RelationKind::Implements }
                }
                Some(_) => RelationKind::Extends,
                None => {
                    let l = last_seg(name);
                    let suffix = ["Protocol", "Delegate", "DataSource", "able", "ible"].iter().any(|s| l.ends_with(s));
                    if is_iface(node_kind) {
                        RelationKind::Extends
                    } else if lang == Lang::Swift && node_kind == TypeKind::Class && first_own && !suffix {
                        RelationKind::Extends
                    } else {
                        RelationKind::Implements
                    }
                }
            },
        }
    }

    /// The edges that start at a type. External targets are included.
    pub fn out_edges(&self, id: TypeId, want: Want) -> Vec<OutEdge> {
        let node = self.node(id);
        let own_kind = self.decl(id).kind;
        let mut acc = Acc::default();
        let mut deps: Vec<Target> = Vec::new();
        let add_dep = |deps: &mut Vec<Target>, t: Target| {
            if !deps.contains(&t) {
                deps.push(t);
            }
        };
        for (pi, (f, i)) in self.parts(id).into_iter().enumerate() {
            let fe = &self.files[f as usize];
            let decl = &fe.model.types[i as usize];
            for (k, st) in decl.supertypes.iter().enumerate() {
                match self.resolve(f, Some(i), &st.ty.name) {
                    Res::Project(t) if t != id => {
                        let tk = self.decl(t).kind;
                        let kind = self.super_kind(own_kind, fe.lang, st, pi == 0 && k == 0, Some(tk), &st.ty.name);
                        acc.add(Target::Type(t), kind, None, false, st.delegated);
                    }
                    Res::External(n) => {
                        let kind = self.super_kind(own_kind, fe.lang, st, pi == 0 && k == 0, None, &n);
                        acc.add(Target::Ext(n), kind, None, false, st.delegated);
                    }
                    _ => {}
                }
            }
            if !(want.parts || want.deps) {
                continue;
            }
            let mut parts: Vec<Part> = Vec::new();
            for fld in &decl.fields {
                let Some(ty) = &fld.ty else { continue };
                parts.clear();
                collect_parts(ty, false, false, false, &mut parts, 0);
                for p in &parts {
                    let target = match self.resolve(f, Some(i), p.name) {
                        Res::Project(t) if t != id || p.mode != Mode::Weak => Target::Type(t),
                        Res::External(n) => Target::Ext(n),
                        _ => continue,
                    };
                    match p.mode {
                        _ if fld.is_static || p.mode == Mode::Weak => add_dep(&mut deps, target),
                        Mode::One => acc.add(target, RelationKind::Composition, Some(&fld.name), p.nullable, false),
                        Mode::Many => acc.add(target, RelationKind::Aggregation, Some(&fld.name), false, false),
                        Mode::Weak => unreachable!(),
                    }
                }
            }
            if !want.deps {
                continue;
            }
            let mut refs: Vec<&CRef> = Vec::new();
            for m in &decl.methods {
                refs.extend(m.params.iter().filter_map(|p| p.ty.as_ref()));
                refs.extend(m.ty.as_ref());
                refs.extend(m.receiver.as_deref());
            }
            for m in &decl.fields {
                refs.extend(m.receiver.as_deref());
                // Swift enum cases keep their associated values in `params`.
                refs.extend(m.params.iter().filter_map(|p| p.ty.as_ref()));
            }
            refs.extend(decl.aliased.as_ref());
            for r in refs {
                parts.clear();
                collect_parts(r, false, false, true, &mut parts, 0);
                for p in &parts {
                    match self.resolve(f, Some(i), p.name) {
                        Res::Project(t) => add_dep(&mut deps, Target::Type(t)),
                        Res::External(n) => add_dep(&mut deps, Target::Ext(n)),
                        _ => {}
                    }
                }
            }
            for u in &decl.used_types {
                match self.resolve(f, Some(i), u) {
                    Res::Project(t) => add_dep(&mut deps, Target::Type(t)),
                    Res::External(n) => add_dep(&mut deps, Target::Ext(n)),
                    _ => {}
                }
            }
        }
        if want.parts || want.deps {
            for &c in &node.children {
                acc.add(Target::Type(c), RelationKind::Nested, None, false, false);
            }
        }
        if want.deps {
            for t in deps {
                if let Target::Type(x) = &t {
                    if *x == id || node.outer == Some(*x) || node.children.contains(x) {
                        continue;
                    }
                }
                if acc.has_target(&t) {
                    continue;
                }
                acc.add(t, RelationKind::Dependency, None, false, false);
            }
        }
        acc.edges
    }

    /// Reverse edges of all types. `inherit` builds only `extends` and `implements`.
    pub fn reverse(&self, full: bool) -> &'a Csr {
        let cell = if full { &self.d.full_rev } else { &self.d.inherit_rev };
        cell.get_or_init(|| {
            let want = if full { ALL } else { INHERIT_ONLY };
            let n = self.d.nodes.len();
            let mut all: Vec<(TypeId, TypeId, RelationKind)> = (0..n as TypeId)
                .into_par_iter()
                .flat_map_iter(|id| {
                    self.out_edges(id, want)
                        .into_iter()
                        .filter_map(move |e| match e.to {
                            Target::Type(t) => Some((t, id, e.kind)),
                            Target::Ext(_) => None,
                        })
                        .collect::<Vec<_>>()
                })
                .collect();
            all.par_sort_unstable_by_key(|&(to, from, k)| (to, from, k as u8));
            let mut start = vec![0u32; n + 1];
            for &(to, _, _) in &all {
                start[to as usize + 1] += 1;
            }
            for i in 0..n {
                start[i + 1] += start[i];
            }
            let edges = all.into_iter().map(|(_, from, k)| (from, k)).collect();
            Csr { start, edges }
        })
    }

    /// Project types that this type extends or implements (direct).
    pub fn supertype_ids(&self, id: TypeId) -> Vec<TypeId> {
        self.out_edges(id, INHERIT_ONLY)
            .into_iter()
            .filter_map(|e| match e.to {
                Target::Type(t) if matches!(e.kind, RelationKind::Extends | RelationKind::Implements) => Some(t),
                _ => None,
            })
            .collect()
    }

    /// The type and all its supertypes (breadth first, no duplicates).
    pub fn ancestors(&self, id: TypeId) -> Vec<TypeId> {
        let mut seen = vec![id];
        let mut i = 0;
        while i < seen.len() && seen.len() < 200 {
            for s in self.supertype_ids(seen[i]) {
                if !seen.contains(&s) {
                    seen.push(s);
                }
            }
            i += 1;
        }
        seen
    }

    /// The type and all its subtypes (direct and indirect).
    pub fn descendants(&self, id: TypeId) -> Vec<TypeId> {
        let rev = self.reverse(false);
        let mut seen = vec![id];
        let mut i = 0;
        while i < seen.len() {
            for &(from, k) in rev.incoming(seen[i]) {
                if matches!(k, RelationKind::Extends | RelationKind::Implements) && !seen.contains(&from) {
                    seen.push(from);
                }
            }
            i += 1;
        }
        seen
    }
}
