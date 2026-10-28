//! The compact form of a `FileModel` that the index keeps. Names are
//! interned: each distinct text is stored once for the whole process and the
//! models point to it. Lists are boxed slices without spare capacity. This
//! cuts the memory of the index to about a third of the parser's models.
//!
//! The interned texts are never freed. They are the distinct identifiers of
//! the projects that were opened: some megabytes, not growing with the file count.

use kestrel_lang::{FileModel, Member, MemberKind, SuperKind, SuperType, TypeDecl, TypeKind, TypeRef, Visibility};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

pub type S = &'static str;

const SHARDS: usize = 64;

fn shards() -> &'static [Mutex<HashSet<&'static str>>; SHARDS] {
    static CELL: OnceLock<[Mutex<HashSet<&'static str>>; SHARDS]> = OnceLock::new();
    CELL.get_or_init(|| std::array::from_fn(|_| Mutex::new(HashSet::new())))
}

/// One shared copy of a text.
pub fn intern(s: &str) -> S {
    if s.is_empty() {
        return "";
    }
    // FNV hash to pick a shard.
    let mut h: u32 = 2166136261;
    for b in s.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    let mut set = shards()[h as usize % SHARDS].lock().unwrap_or_else(|e| e.into_inner());
    if let Some(x) = set.get(s) {
        return x;
    }
    let leaked: &'static str = Box::leak(s.to_owned().into_boxed_str());
    set.insert(leaked);
    leaked
}

fn strs(v: &[String]) -> Box<[S]> {
    v.iter().map(|s| intern(s)).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CRef {
    /// The type as written. The same text as `name` when there is nothing more.
    pub text: S,
    pub name: S,
    pub args: Box<[CRef]>,
    pub nullable: bool,
    pub array: bool,
}

impl CRef {
    fn from(t: &TypeRef) -> CRef {
        CRef {
            text: intern(&t.text),
            name: intern(&t.name),
            args: t.args.iter().map(CRef::from).collect(),
            nullable: t.nullable,
            array: t.array,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CParam {
    pub name: S,
    pub ty: Option<CRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CMember {
    pub name: S,
    pub kind: MemberKind,
    pub visibility: Visibility,
    pub is_static: bool,
    pub is_abstract: bool,
    pub mutable: bool,
    pub ty: Option<CRef>,
    pub params: Box<[CParam]>,
    pub receiver: Option<Box<CRef>>,
    pub line: u32,
    pub column: u32,
}

impl CMember {
    fn from(m: &Member) -> CMember {
        CMember {
            name: intern(&m.name),
            kind: m.kind,
            visibility: m.visibility,
            is_static: m.is_static,
            is_abstract: m.is_abstract,
            mutable: m.mutable,
            ty: m.ty.as_ref().map(CRef::from),
            params: m.params.iter().map(|p| CParam { name: intern(&p.name), ty: p.ty.as_ref().map(CRef::from) }).collect(),
            receiver: m.receiver.as_ref().map(|r| Box::new(CRef::from(r))),
            line: m.line,
            column: m.column,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CSuper {
    pub ty: CRef,
    pub kind: SuperKind,
    pub delegated: bool,
}

impl CSuper {
    fn from(s: &SuperType) -> CSuper {
        CSuper { ty: CRef::from(&s.ty), kind: s.kind, delegated: s.delegated }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CImport {
    pub path: S,
    pub wildcard: bool,
    pub alias: Option<S>,
    pub is_static: bool,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CType {
    pub name: S,
    pub kind: TypeKind,
    pub outer: Option<usize>,
    pub modifiers: Box<[S]>,
    pub annotations: Box<[S]>,
    pub type_params: Box<[S]>,
    pub supertypes: Box<[CSuper]>,
    pub aliased: Option<CRef>,
    pub fields: Box<[CMember]>,
    pub methods: Box<[CMember]>,
    pub used_types: Box<[S]>,
    pub line: u32,
    pub column: u32,
    pub start_line: u32,
    pub end_line: u32,
}

impl CType {
    fn from(t: &TypeDecl) -> CType {
        CType {
            name: intern(&t.name),
            kind: t.kind,
            outer: t.outer,
            modifiers: strs(&t.modifiers),
            annotations: strs(&t.annotations),
            type_params: strs(&t.type_params),
            supertypes: t.supertypes.iter().map(CSuper::from).collect(),
            aliased: t.aliased.as_ref().map(CRef::from),
            fields: t.fields.iter().map(CMember::from).collect(),
            methods: t.methods.iter().map(CMember::from).collect(),
            used_types: strs(&t.used_types),
            line: t.line,
            column: t.column,
            start_line: t.start_line,
            end_line: t.end_line,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CModel {
    pub package: S,
    pub imports: Box<[CImport]>,
    pub types: Box<[CType]>,
    pub top_level: Box<[CMember]>,
}

impl CModel {
    pub fn from_model(m: &FileModel) -> CModel {
        CModel {
            package: intern(&m.package),
            imports: m
                .imports
                .iter()
                .map(|i| CImport {
                    path: intern(&i.path),
                    wildcard: i.wildcard,
                    alias: i.alias.as_deref().map(intern),
                    is_static: i.is_static,
                    line: i.line,
                })
                .collect(),
            types: m.types.iter().map(CType::from).collect(),
            top_level: m.top_level.iter().map(CMember::from).collect(),
        }
    }

    /// A rough size in bytes, without the shared texts (for measurements).
    pub fn bytes(&self) -> usize {
        fn r(t: &CRef) -> usize {
            std::mem::size_of::<CRef>() + t.args.iter().map(r).sum::<usize>()
        }
        fn m(x: &CMember) -> usize {
            std::mem::size_of::<CMember>()
                + x.ty.as_ref().map_or(0, |t| r(t) - std::mem::size_of::<CRef>())
                + x.params.len() * std::mem::size_of::<CParam>()
                + x.params.iter().map(|p| p.ty.as_ref().map_or(0, |t| r(t) - std::mem::size_of::<CRef>())).sum::<usize>()
                + x.receiver.as_ref().map_or(0, |t| r(t))
        }
        let mut n = std::mem::size_of::<CModel>() + self.imports.len() * std::mem::size_of::<CImport>();
        for t in self.types.iter() {
            n += std::mem::size_of::<CType>();
            n += (t.modifiers.len() + t.annotations.len() + t.type_params.len() + t.used_types.len()) * std::mem::size_of::<S>();
            n += t.supertypes.iter().map(|s| std::mem::size_of::<CSuper>() + r(&s.ty) - std::mem::size_of::<CRef>()).sum::<usize>();
            n += t.fields.iter().chain(t.methods.iter()).map(m).sum::<usize>();
        }
        n + self.top_level.iter().map(m).sum::<usize>()
    }
}
