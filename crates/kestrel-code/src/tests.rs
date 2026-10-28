//! Unit tests with hand-built models, and tests with real files.

use crate::derived::{Res, Target};
use crate::index::{FileEntry, Index};
use crate::*;
use kestrel_lang::*;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

// --- Builders -------------------------------------------------------------------

fn tr(name: &str) -> TypeRef {
    TypeRef { text: name.into(), name: name.into(), ..Default::default() }
}

fn generic(name: &str, args: Vec<TypeRef>) -> TypeRef {
    let text = format!("{name}<{}>", args.iter().map(|a| a.text.clone()).collect::<Vec<_>>().join(", "));
    TypeRef { text, name: name.into(), args, ..Default::default() }
}

fn ty(name: &str, kind: TypeKind) -> TypeDecl {
    TypeDecl {
        name: name.into(),
        kind,
        outer: None,
        modifiers: vec![],
        annotations: vec![],
        type_params: vec![],
        supertypes: vec![],
        aliased: None,
        fields: vec![],
        methods: vec![],
        used_types: vec![],
        line: 1,
        column: 1,
        start_line: 1,
        end_line: 10,
    }
}

fn member(name: &str, kind: MemberKind, t: Option<TypeRef>) -> Member {
    Member {
        name: name.into(),
        kind,
        visibility: Visibility::Public,
        is_static: false,
        is_abstract: false,
        ty: t,
        params: vec![],
        mutable: false,
        receiver: None,
        line: 2,
        column: 5,
        end_line: 0,
    }
}

fn field(name: &str, t: TypeRef) -> Member {
    member(name, MemberKind::Property, Some(t))
}

fn method(name: &str, ret: Option<TypeRef>, params: Vec<(&str, TypeRef)>) -> Member {
    let mut m = member(name, MemberKind::Method, ret);
    m.params = params.into_iter().map(|(n, t)| Param { name: n.into(), ty: Some(t) }).collect();
    m
}

fn sup(name: &str, kind: SuperKind) -> SuperType {
    SuperType { ty: tr(name), kind, delegated: false }
}

fn imp(path: &str) -> Import {
    Import { path: path.into(), ..Default::default() }
}

fn file(path: &str, lang: Lang, package: &str, imports: Vec<Import>, types: Vec<TypeDecl>) -> Arc<FileEntry> {
    Arc::new(FileEntry {
        path: PathBuf::from(path),
        lang,
        mtime_ms: 0,
        size: 0,
        words: Box::new([]),
        model: crate::cmodel::CModel::from_model(&FileModel { package: package.into(), imports, types, top_level: vec![] }),
    })
}

fn index(files: Vec<Arc<FileEntry>>) -> Arc<Index> {
    Arc::new(Index::new(PathBuf::from("/p"), files, 0))
}

fn fid(i: &Index, path: &str) -> u32 {
    i.file_id(&PathBuf::from(path)).unwrap()
}

fn status() -> CodeIndexStatus {
    CodeIndexStatus { state: IndexState::Ready, files: 0, types: 0, build_ms: 0 }
}

fn request(scope: DiagramScope, rel: &[RelationKind], depth: u32, dir: Direction) -> DiagramRequest {
    DiagramRequest {
        root: "/p".into(),
        scope,
        relations: rel.to_vec(),
        depth,
        direction: dir,
        include_external: false,
        max_nodes: 100,
        max_fan: None,
    }
}

fn ids(r: &DiagramResult) -> Vec<String> {
    r.nodes.iter().map(|n| n.id.clone()).collect()
}

fn run(i: &Arc<Index>, req: &DiagramRequest) -> DiagramResult {
    crate::internals::run_diagram(i, req, status(), &AtomicBool::new(false)).unwrap()
}

fn types_scope(ids: &[&str]) -> DiagramScope {
    DiagramScope::Types { ids: ids.iter().map(|s| s.to_string()).collect() }
}

use RelationKind::*;

// --- Resolution -----------------------------------------------------------------

fn resolution_index() -> Arc<Index> {
    let mut outer = ty("Outer", TypeKind::Class);
    outer.type_params = vec!["T".into()];
    let mut inner = ty("Inner", TypeKind::Class);
    inner.outer = Some(1);
    index(vec![
        file("/p/a/Foo.kt", Lang::Kotlin, "a", vec![], vec![ty("Foo", TypeKind::Class), outer, inner]),
        file("/p/b/Foo.kt", Lang::Kotlin, "b", vec![], vec![ty("Foo", TypeKind::Class), ty("Local", TypeKind::Class)]),
        file("/p/c/User.kt", Lang::Kotlin, "c", vec![imp("a.Foo"), imp("lib.Remote")], vec![ty("User", TypeKind::Class)]),
        file(
            "/p/d/Wild.kt",
            Lang::Kotlin,
            "d",
            vec![Import { path: "a".into(), wildcard: true, ..Default::default() }],
            vec![ty("Wild", TypeKind::Class)],
        ),
        file(
            "/p/e/Alias.kt",
            Lang::Kotlin,
            "e",
            vec![Import { path: "a.Foo".into(), alias: Some("AF".into()), ..Default::default() }],
            vec![ty("Alias", TypeKind::Class)],
        ),
        file("/p/b/Other.kt", Lang::Kotlin, "b", vec![], vec![ty("Other", TypeKind::Class)]),
    ])
}

fn qname(i: &Index, r: Res) -> String {
    match r {
        Res::Project(t) => i.view().node(t).id(),
        other => format!("{other:?}"),
    }
}

#[test]
fn resolves_names_in_order() {
    let i = resolution_index();
    let v = i.view();
    let r = |path: &str, ctx: Option<u32>, name: &str| qname(&i, v.resolve(fid(&i, path), ctx, name));
    assert_eq!(r("/p/c/User.kt", Some(0), "Foo"), "a.Foo", "explicit import");
    assert_eq!(r("/p/b/Other.kt", Some(0), "Foo"), "b.Foo", "same package");
    assert_eq!(r("/p/b/Other.kt", Some(0), "Local"), "b.Local");
    assert_eq!(r("/p/d/Wild.kt", Some(0), "Foo"), "a.Foo", "wildcard import");
    assert_eq!(r("/p/e/Alias.kt", Some(0), "AF"), "a.Foo", "alias");
    assert_eq!(r("/p/e/Alias.kt", Some(0), "Foo"), "External(\"Foo\")", "alias hides nothing else");
    assert_eq!(r("/p/c/User.kt", Some(0), "Remote"), "External(\"Remote\")");
    assert_eq!(r("/p/c/User.kt", Some(0), "String"), "Basic");
    assert_eq!(r("/p/c/User.kt", Some(0), "kotlin.collections.List"), "Basic");
    assert_eq!(r("/p/c/User.kt", Some(0), "a.Foo"), "a.Foo", "dotted full name");
    assert_eq!(r("/p/d/Wild.kt", Some(0), "Outer.Inner"), "a.Outer.Inner", "dotted nested");
    assert_eq!(r("/p/a/Foo.kt", Some(1), "Inner"), "a.Outer.Inner", "nested of the current type");
    assert_eq!(r("/p/a/Foo.kt", Some(2), "Foo"), "a.Foo", "same file, from a nested type");
    assert_eq!(r("/p/a/Foo.kt", Some(1), "T"), "TypeParam");
    assert_eq!(r("/p/a/Foo.kt", Some(2), "T"), "TypeParam", "type parameter of the outer type");
}

#[test]
fn duplicate_names_get_numbers() {
    let i = index(vec![
        file("/p/a/A.kt", Lang::Kotlin, "x", vec![], vec![ty("Dup", TypeKind::Class)]),
        file("/p/b/B.kt", Lang::Kotlin, "x", vec![], vec![ty("Dup", TypeKind::Class)]),
    ]);
    let r = run(&i, &request(types_scope(&["x.Dup", "x.Dup#2", "x.Dup#3"]), &[Extends], 0, Direction::Out));
    assert_eq!(ids(&r), vec!["x.Dup", "x.Dup#2"]);
    assert_ne!(r.nodes[0].path, r.nodes[1].path);
}

#[test]
fn swift_resolution_unique_or_nearest_path() {
    let i = index(vec![
        file("/p/App/Feature/View.swift", Lang::Swift, "", vec![], vec![ty("View", TypeKind::Struct), ty("Cell", TypeKind::Class)]),
        file("/p/App/Other/Cell.swift", Lang::Swift, "", vec![], vec![ty("Cell", TypeKind::Class)]),
        file("/p/App/Other/Use.swift", Lang::Swift, "", vec![], vec![ty("Use", TypeKind::Class)]),
        file("/p/App/Feature/Sub/Use2.swift", Lang::Swift, "", vec![], vec![ty("Use2", TypeKind::Class)]),
        file("/p/Lib/Solo.swift", Lang::Swift, "", vec![], vec![ty("Solo", TypeKind::Class)]),
    ]);
    let v = i.view();
    let r = |path: &str, name: &str| qname(&i, v.resolve(fid(&i, path), Some(0), name));
    assert_eq!(r("/p/App/Other/Use.swift", "Solo"), "Solo", "unique name anywhere");
    let cell_near_use = r("/p/App/Other/Use.swift", "Cell");
    let node = v.d.by_qname["Cell"][1];
    assert_eq!(cell_near_use, v.node(node).id(), "longest common path wins");
    let cell_feature = r("/p/App/Feature/Sub/Use2.swift", "Cell");
    assert_eq!(cell_feature, "Cell");
}

#[test]
fn swift_extension_merges_into_type() {
    let mut ext = ty("Model", TypeKind::Extension);
    ext.supertypes = vec![sup("Printable", SuperKind::Unknown)];
    ext.methods = vec![method("describe", Some(tr("String")), vec![])];
    let i = index(vec![
        file("/p/Model.swift", Lang::Swift, "", vec![], vec![ty("Model", TypeKind::Struct)]),
        file("/p/Printable.swift", Lang::Swift, "", vec![], vec![ty("Printable", TypeKind::Protocol)]),
        file("/p/Model+Print.swift", Lang::Swift, "", vec![], vec![ext]),
    ]);
    let r = run(&i, &request(types_scope(&["Model"]), &[Implements, Extends], 1, Direction::Out));
    assert_eq!(ids(&r), vec!["Model", "Printable"]);
    assert_eq!(r.edges.len(), 1);
    assert_eq!(r.edges[0].kind, Implements);
    let model = &r.nodes[0];
    assert_eq!(model.methods.len(), 1);
    assert_eq!(model.methods[0].name, "describe");
    assert_eq!(model.container, "", "folder relative to the root");
    // The extension file as scope gives the merged type.
    let r = run(&i, &request(DiagramScope::File { path: "/p/Model+Print.swift".into(), text: None }, &[Extends], 0, Direction::Out));
    assert_eq!(r.focus, vec!["Model"]);
    // No separate node for the extension.
    assert_eq!(i.type_count, 2);
}

// --- Edges and walk -------------------------------------------------------------

fn graph_index() -> Arc<Index> {
    let mut repo = ty("Repo", TypeKind::Interface);
    repo.methods = vec![method("find", Some(tr("Entity")), vec![("id", tr("Long"))])];
    let mut base = ty("Base", TypeKind::Class);
    base.modifiers = vec!["abstract".into()];
    let mut service = ty("Service", TypeKind::Class);
    service.supertypes = vec![sup("Base", SuperKind::Extends), sup("Repo", SuperKind::Unknown), sup("JpaRepository", SuperKind::Unknown)];
    let mut f_repo = field("repo", tr("Repo"));
    f_repo.ty.as_mut().unwrap().nullable = true;
    service.fields = vec![
        f_repo,
        field("items", generic("List", vec![tr("Entity")])),
        field("lazyPart", generic("Lazy", vec![tr("Part")])),
        field("name", tr("String")),
    ];
    service.methods = vec![
        method("run", Some(tr("Result2")), vec![("w", tr("Widget")), ("x", tr("Int"))]),
        method("go", None, vec![("e", tr("Entity"))]),
    ];
    service.used_types = vec!["Helper".into(), "Part".into(), "Missing".into()];
    let mut ctrl = ty("Controller", TypeKind::Class);
    ctrl.fields = vec![field("service", tr("Service"))];
    let mut sub = ty("SubService", TypeKind::Class);
    sub.supertypes = vec![sup("Service", SuperKind::Extends)];
    let mut inner = ty("Inner", TypeKind::Class);
    inner.outer = Some(0);
    let mut holder = ty("Holder", TypeKind::Class);
    holder.used_types = vec!["Service".into()];
    index(vec![
        file("/p/k/Repo.kt", Lang::Kotlin, "k", vec![], vec![repo]),
        file("/p/k/Base.kt", Lang::Kotlin, "k", vec![], vec![base]),
        file("/p/k/Service.kt", Lang::Kotlin, "k", vec![imp("org.spring.JpaRepository")], vec![service]),
        file("/p/k/Controller.kt", Lang::Kotlin, "k", vec![], vec![ctrl, inner]),
        file("/p/k/SubService.kt", Lang::Kotlin, "k", vec![], vec![sub]),
        file("/p/k/Holder.kt", Lang::Kotlin, "k", vec![], vec![holder]),
        file("/p/k/Misc.kt", Lang::Kotlin, "k", vec![], vec![
            ty("Entity", TypeKind::Class), ty("Part", TypeKind::Class), ty("Widget", TypeKind::Class), ty("Helper", TypeKind::Class), ty("Result2", TypeKind::Class)]),
    ])
}

fn edge<'a>(r: &'a DiagramResult, from: &str, to: &str, kind: RelationKind) -> Option<&'a DiagramEdge> {
    r.edges.iter().find(|e| e.from == from && e.to == to && e.kind == kind)
}

const ALL: &[RelationKind] = &[Extends, Implements, Composition, Aggregation, Dependency, Nested];

#[test]
fn edge_kinds_of_a_class() {
    let i = graph_index();
    let r = run(&i, &request(types_scope(&["k.Service"]), ALL, 1, Direction::Out));
    assert!(edge(&r, "k.Service", "k.Base", Extends).is_some());
    assert!(edge(&r, "k.Service", "k.Repo", Implements).is_some(), "Unknown to an interface is implements");
    let comp = edge(&r, "k.Service", "k.Repo", Composition).unwrap();
    assert_eq!(comp.label.as_deref(), Some("repo"));
    assert_eq!(comp.multiplicity.as_deref(), Some("0..1"), "nullable field");
    let agg = edge(&r, "k.Service", "k.Misc.Entity", Aggregation);
    assert!(agg.is_none());
    let agg = edge(&r, "k.Service", "k.Entity", Aggregation).unwrap();
    assert_eq!(agg.multiplicity.as_deref(), Some("*"));
    assert_eq!(agg.label.as_deref(), Some("items"));
    assert!(edge(&r, "k.Service", "k.Part", Composition).is_some(), "Lazy wraps one part");
    assert!(edge(&r, "k.Service", "k.Widget", Dependency).is_some(), "parameter type");
    assert!(edge(&r, "k.Service", "k.Result2", Dependency).is_some(), "return type");
    assert!(edge(&r, "k.Service", "k.Helper", Dependency).is_some(), "used type");
    assert!(edge(&r, "k.Service", "k.Entity", Dependency).is_none(), "aggregation already joins them");
    assert!(edge(&r, "k.Service", "k.Part", Dependency).is_none());
    assert!(!ids(&r).iter().any(|n| n.starts_with("ext:")), "no external nodes by default");
    assert!(!ids(&r).iter().any(|n| n.contains("String") || n.contains("Int")));
}

#[test]
fn external_nodes_only_when_asked_and_never_basic() {
    let i = graph_index();
    let mut req = request(types_scope(&["k.Service"]), ALL, 3, Direction::Out);
    req.include_external = true;
    let r = run(&i, &req);
    let ext: Vec<_> = r.nodes.iter().filter(|n| n.external).collect();
    let names: Vec<_> = ext.iter().map(|n| n.id.as_str()).collect();
    assert!(names.contains(&"ext:JpaRepository"));
    assert!(names.contains(&"ext:Missing"));
    assert!(!names.iter().any(|n| *n == "ext:String" || *n == "ext:Int" || *n == "ext:List" || *n == "ext:Long"));
    let jpa = ext.iter().find(|n| n.id == "ext:JpaRepository").unwrap();
    assert!(jpa.path.is_none() && jpa.lang.is_none() && jpa.line == 0);
    assert!(edge(&r, "k.Service", "ext:JpaRepository", Implements).is_some());
    // The walk does not continue from an external node, and a node with an
    // external edge still shows it only when the flag is on.
    assert!(r.edges.iter().all(|e| !e.from.starts_with("ext:")));
}

#[test]
fn depth_direction_and_max_nodes() {
    let i = graph_index();
    let inh = &[Extends, Implements];
    let r = run(&i, &request(types_scope(&["k.Service"]), inh, 0, Direction::Both));
    assert_eq!(ids(&r), vec!["k.Service"]);
    let r = run(&i, &request(types_scope(&["k.Service"]), inh, 1, Direction::Out));
    let mut got = ids(&r);
    got.sort();
    assert_eq!(got, vec!["k.Base", "k.Repo", "k.Service"]);
    let r = run(&i, &request(types_scope(&["k.Service"]), inh, 1, Direction::In));
    assert_eq!(ids(&r), vec!["k.Service", "k.SubService"]);
    let r = run(&i, &request(types_scope(&["k.Service"]), inh, 1, Direction::Both));
    assert_eq!(r.nodes.len(), 4);
    // In direction with composition and dependency: users of Service.
    let r = run(&i, &request(types_scope(&["k.Service"]), &[Composition, Dependency], 1, Direction::In));
    let mut got = ids(&r);
    got.sort();
    assert_eq!(got, vec!["k.Controller", "k.Holder", "k.Service"]);
    assert!(edge(&r, "k.Controller", "k.Service", Composition).is_some());
    assert!(edge(&r, "k.Holder", "k.Service", Dependency).is_some());
    // Depth 2 from a subtype reaches the interface through Service.
    let r = run(&i, &request(types_scope(&["k.SubService"]), inh, 2, Direction::Out));
    assert!(ids(&r).contains(&"k.Repo".to_string()));
    let r = run(&i, &request(types_scope(&["k.SubService"]), inh, 1, Direction::Out));
    assert!(!ids(&r).contains(&"k.Repo".to_string()));
    // maxNodes keeps the nearest types.
    let mut req = request(types_scope(&["k.Service"]), inh, 2, Direction::Both);
    req.max_nodes = 2;
    let r = run(&i, &req);
    assert_eq!(r.nodes.len(), 2);
    assert!(r.truncated);
    assert_eq!(r.nodes[0].id, "k.Service");
}

#[test]
fn edges_between_all_result_nodes_are_included() {
    // Service -> Base and Service -> Repo were walked. Controller has an edge
    // to Service only. With depth 1 'in' for Base we get Service; the edge
    // Service -> Repo is not shown because Repo is not in the result.
    let i = graph_index();
    let r = run(&i, &request(types_scope(&["k.Service", "k.Repo"]), &[Implements, Composition], 0, Direction::Out));
    assert!(edge(&r, "k.Service", "k.Repo", Implements).is_some());
    assert!(edge(&r, "k.Service", "k.Repo", Composition).is_some());
    assert_eq!(r.edges.len(), 2);
}

#[test]
fn nested_edge_and_container() {
    let i = graph_index();
    let r = run(&i, &request(types_scope(&["k.Controller"]), &[Nested], 1, Direction::Out));
    assert!(edge(&r, "k.Controller", "k.Controller.Inner", Nested).is_some());
    let inner = r.nodes.iter().find(|n| n.id == "k.Controller.Inner").unwrap();
    assert_eq!(inner.container, "k.Controller");
    let r = run(&i, &request(types_scope(&["k.Controller.Inner"]), &[Nested], 1, Direction::In));
    assert!(ids(&r).contains(&"k.Controller".to_string()));
}

#[test]
fn members_are_cut_at_60() {
    let mut big = ty("Big", TypeKind::Class);
    big.fields = (0..70).map(|n| field(&format!("f{n}"), tr("Int"))).collect();
    big.methods = (0..3).map(|n| method(&format!("m{n}"), None, vec![("a", tr("Int")), ("b", tr("Foo"))])).collect();
    let mut jbig = ty("JBig", TypeKind::Class);
    jbig.methods = vec![method("m", None, vec![("a", tr("int")), ("b", tr("String"))])];
    let i = index(vec![
        file("/p/Big.kt", Lang::Kotlin, "", vec![], vec![big]),
        file("/p/JBig.java", Lang::Java, "", vec![], vec![jbig]),
    ]);
    let r = run(&i, &request(types_scope(&["Big", "JBig"]), &[Extends], 0, Direction::Out));
    assert_eq!(r.nodes[0].fields.len(), 60);
    assert!(r.nodes[0].members_truncated);
    assert_eq!(r.nodes[0].methods[0].params, "a: Int, b: Foo");
    assert_eq!(r.nodes[1].methods[0].params, "int a, String b");
    assert!(!r.nodes[1].members_truncated);
}

#[test]
fn cursor_scope_uses_type_under_cursor_then_innermost() {
    let mut a = ty("Alpha", TypeKind::Class);
    a.start_line = 1;
    a.end_line = 30;
    a.line = 1;
    a.column = 7;
    let mut inner = ty("Inner", TypeKind::Class);
    inner.outer = Some(0);
    inner.start_line = 10;
    inner.end_line = 20;
    inner.line = 10;
    inner.column = 11;
    let mut b = ty("Beta", TypeKind::Class);
    b.supertypes = vec![sup("Alpha", SuperKind::Extends)];
    b.line = 3;
    b.start_line = 3;
    b.end_line = 8;
    let i = index(vec![
        file("/p/a/Alpha.kt", Lang::Kotlin, "a", vec![], vec![a, inner]),
        file("/p/a/Beta.kt", Lang::Kotlin, "a", vec![], vec![ty("Pad", TypeKind::Class), b]),
    ]);
    if kestrel_lang::parse(Lang::Kotlin, "class A").types.is_empty() {
        return;
    }
    let src = "package a\nclass Alpha {\n    class Inner {\n        val x = 1\n\n    }\n}\n";
    let cur = |path: &str, line: u32, col: u32, text: Option<&str>| {
        let req = request(
            DiagramScope::Cursor { path: path.into(), line, column: col, text: text.map(|s| s.into()) },
            &[Extends],
            0,
            Direction::Out,
        );
        run(&i, &req).focus
    };
    // The cursor is on the declaration of Alpha.
    assert_eq!(cur("/p/a/Alpha.kt", 2, 8, Some(src)), vec!["a.Alpha"]);
    // The cursor is on the declaration of the nested type.
    assert_eq!(cur("/p/a/Alpha.kt", 3, 12, Some(src)), vec!["a.Alpha.Inner"]);
    // The cursor is in empty space inside Inner: the innermost type.
    assert_eq!(cur("/p/a/Alpha.kt", 5, 1, Some(src)), vec!["a.Alpha.Inner"]);
    // After the nested type, inside the outer one.
    assert_eq!(cur("/p/a/Alpha.kt", 7, 1, Some(src)), vec!["a.Alpha"]);
    // The cursor is on a use of a type name: Beta extends Alpha.
    let src2 = "package a\nclass Beta : Alpha()\n";
    assert_eq!(cur("/p/a/Beta.kt", 2, 16, Some(src2)), vec!["a.Alpha"]);
}

#[test]
fn unsaved_text_replaces_the_stored_model() {
    let i = index(vec![file("/p/a/A.kt", Lang::Kotlin, "a", vec![], vec![ty("Old", TypeKind::Class)])]);
    let req = request(DiagramScope::File { path: "/p/a/A.kt".into(), text: Some("package a\nclass New\n".into()) }, &[Extends], 0, Direction::Out);
    let r = crate::internals::run_diagram(&i, &req, status(), &AtomicBool::new(false)).unwrap();
    // With the parser of Kotlin ready the new type appears; with a placeholder parser nothing does.
    if kestrel_lang::parse(Lang::Kotlin, "class New").types.is_empty() {
        assert!(r.nodes.is_empty());
    } else {
        assert_eq!(ids(&r), vec!["a.New"]);
    }
}

#[test]
fn cancel_stops_a_request() {
    let i = graph_index();
    let req = request(types_scope(&["k.Service"]), ALL, 2, Direction::Both);
    let flag = AtomicBool::new(true);
    let err = crate::internals::run_diagram(&i, &req, status(), &flag).unwrap_err();
    assert_eq!(err.code(), "cancelled");
}

#[test]
fn reverse_table_is_consistent_with_out_edges() {
    let i = graph_index();
    let v = i.view();
    let service = v.d.by_qname["k.Service"][0];
    let rev = v.reverse(true);
    let from: Vec<_> = rev.incoming(service).iter().map(|(f, k)| (v.node(*f).qname.clone(), *k)).collect();
    assert!(from.contains(&("k.Controller".to_string(), Composition)));
    assert!(from.contains(&("k.SubService".to_string(), Extends)));
    let out = v.out_edges(service, crate::derived::ALL);
    assert!(out.iter().any(|e| matches!(e.to, Target::Ext(ref n) if n == "JpaRepository")));
}

#[test]
fn hubs_are_not_expanded() {
    // Hub is held by 30 owners. Root holds Hub and Mid.
    let mut files = vec![file("/p/h/Hub.kt", Lang::Kotlin, "h", vec![], vec![ty("Hub", TypeKind::Class)])];
    for n in 0..30 {
        let mut o = ty(&format!("Owner{n:02}"), TypeKind::Class);
        o.fields = vec![field("hub", tr("Hub"))];
        files.push(file(&format!("/p/h/Owner{n:02}.kt"), Lang::Kotlin, "h", vec![], vec![o]));
    }
    let mut mid = ty("Mid", TypeKind::Class);
    mid.fields = vec![field("hub", tr("Hub"))];
    files.push(file("/p/h/Mid.kt", Lang::Kotlin, "h", vec![], vec![mid]));
    let mut root = ty("Root", TypeKind::Class);
    root.fields = vec![field("mid", tr("Mid"))];
    files.push(file("/p/h/Root.kt", Lang::Kotlin, "h", vec![], vec![root]));
    // 30 subtypes of Base.
    files.push(file("/p/h/Base.kt", Lang::Kotlin, "h", vec![], vec![ty("Base", TypeKind::Class)]));
    for n in 0..30 {
        let mut s = ty(&format!("Sub{n:02}"), TypeKind::Class);
        s.supertypes = vec![sup("Base", SuperKind::Extends)];
        files.push(file(&format!("/p/h/Sub{n:02}.kt"), Lang::Kotlin, "h", vec![], vec![s]));
    }
    let i = index(files);
    let rel = &[Composition, Aggregation];
    let r = run(&i, &request(types_scope(&["h.Root"]), rel, 2, Direction::Both));
    assert_eq!(ids(&r), vec!["h.Root", "h.Mid", "h.Hub"]);
    let hub = r.nodes.iter().find(|n| n.id == "h.Hub").unwrap();
    assert_eq!(hub.hidden_in, 30, "30 owners; Mid is already in the result");
    assert_eq!(hub.hidden_out, 0);
    let j = serde_json::to_value(&r.nodes[0]).unwrap();
    assert!(j.get("hiddenIn").is_none());
    assert_eq!(serde_json::to_value(hub).unwrap()["hiddenIn"], 30);
    // The hub as start type gets its first 20 neighbors.
    let r = run(&i, &request(types_scope(&["h.Hub"]), rel, 1, Direction::In));
    assert_eq!(r.nodes.len(), 21);
    assert_eq!(r.nodes[0].hidden_in, 11);
    // A start type with 30 subtypes: 20 added, 10 hidden.
    let r = run(&i, &request(types_scope(&["h.Base"]), &[Extends], 2, Direction::Both));
    assert_eq!(r.nodes.len(), 21);
    assert_eq!(r.nodes[0].hidden_in, 10);
    assert!(r.edges.len() == 20);
}

#[test]
fn nested_types_are_not_found_by_simple_name_elsewhere() {
    // Swift: TestSupport.UserDefaults must not capture Foundation's UserDefaults.
    let mut support = ty("TestSupport", TypeKind::Enum);
    support.end_line = 20;
    let mut nested = ty("UserDefaults", TypeKind::Enum);
    nested.outer = Some(0);
    let mut ext = ty("UserDefaults", TypeKind::Extension);
    ext.methods = vec![method("removeAll", None, vec![])];
    let mut app_group = ty("AppGroup", TypeKind::Enum);
    app_group.outer = Some(1);
    let mut use_in_ext = ty("Helper", TypeKind::Enum);
    use_in_ext.outer = Some(1);
    let mut repo = ty("Repo", TypeKind::Class);
    repo.fields = vec![field("defaults", tr("UserDefaults"))];
    let i = index(vec![
        file("/p/T/TestSupport.swift", Lang::Swift, "", vec![], vec![support, nested]),
        file("/p/App/Repo.swift", Lang::Swift, "", vec![], vec![repo, ext, app_group, use_in_ext]),
    ]);
    let v = i.view();
    let repo_f = fid(&i, "/p/App/Repo.swift");
    let r = |ctx: Option<u32>, name: &str| qname(&i, v.resolve(repo_f, ctx, name));
    assert_eq!(r(Some(0), "UserDefaults"), "External(\"UserDefaults\")");
    assert_eq!(r(Some(0), "TestSupport.UserDefaults"), "TestSupport.UserDefaults", "dotted name");
    let tsf = fid(&i, "/p/T/TestSupport.swift");
    assert_eq!(qname(&i, v.resolve(tsf, Some(0), "UserDefaults")), "TestSupport.UserDefaults", "inside the outer type");
    // The extension is not merged into the nested enum.
    let nested_id = v.d.by_qname["TestSupport.UserDefaults"][0];
    assert!(v.node(nested_id).exts.is_empty());
    assert_eq!(v.d.file_types[repo_f as usize][1], None);
    // Types inside an unresolved extension are project types.
    assert!(v.d.by_qname.contains_key("UserDefaults.AppGroup"));
    // Code in the extension finds its nested type by simple name, not elsewhere.
    assert_eq!(r(Some(1), "AppGroup"), "UserDefaults.AppGroup");
    assert_eq!(r(Some(0), "AppGroup"), "External(\"AppGroup\")");
    // An extension of a top-level project type still merges.
    let r2 = run(&i, &request(types_scope(&["UserDefaults.AppGroup"]), &[Nested], 0, Direction::Out));
    assert_eq!(ids(&r2), vec!["UserDefaults.AppGroup"]);
}

#[test]
fn kotlin_and_java_nested_types_need_their_outer_type() {
    let mut a = ty("A", TypeKind::Class);
    a.end_line = 5;
    let mut inner = ty("Inner", TypeKind::Class);
    inner.outer = Some(0);
    let b = ty("B", TypeKind::Class);
    let i = index(vec![
        file("/p/k/A.kt", Lang::Kotlin, "k", vec![], vec![a, inner, b]),
        file("/p/k/C.kt", Lang::Kotlin, "k", vec![], vec![ty("C", TypeKind::Class)]),
        file("/p/j/D.java", Lang::Java, "k", vec![], vec![ty("D", TypeKind::Class)]),
    ]);
    let v = i.view();
    let r = |path: &str, ctx: u32, name: &str| qname(&i, v.resolve(fid(&i, path), Some(ctx), name));
    assert_eq!(r("/p/k/A.kt", 2, "Inner"), "External(\"Inner\")", "B is not inside A");
    assert_eq!(r("/p/k/A.kt", 0, "Inner"), "k.A.Inner");
    assert_eq!(r("/p/k/C.kt", 0, "Inner"), "External(\"Inner\")", "same package");
    assert_eq!(r("/p/j/D.java", 0, "Inner"), "External(\"Inner\")");
    assert_eq!(r("/p/j/D.java", 0, "A.Inner"), "k.A.Inner");
}

#[test]
fn max_fan_can_be_changed() {
    let mut files = vec![file("/p/h/Base.kt", Lang::Kotlin, "h", vec![], vec![ty("Base", TypeKind::Class)])];
    for n in 0..30 {
        let mut s = ty(&format!("Sub{n:02}"), TypeKind::Class);
        s.supertypes = vec![sup("Base", SuperKind::Extends)];
        files.push(file(&format!("/p/h/Sub{n:02}.kt"), Lang::Kotlin, "h", vec![], vec![s]));
    }
    let i = index(files);
    let mut req = request(types_scope(&["h.Base"]), &[Extends], 1, Direction::In);
    req.max_fan = Some(5);
    let r = run(&i, &req);
    assert_eq!((r.nodes.len(), r.nodes[0].hidden_in), (6, 25));
    req.max_fan = Some(1000);
    let r = run(&i, &req);
    assert_eq!((r.nodes.len(), r.nodes[0].hidden_in), (31, 0));
    req.max_fan = Some(0);
    assert_eq!(run(&i, &req).nodes.len(), 2, "kept at 1 or more");
    let j: DiagramRequest = serde_json::from_value(serde_json::json!({
        "root": "/p", "scope": { "kind": "file", "path": "/a" }, "relations": [], "depth": 1,
        "direction": "in", "includeExternal": false, "maxNodes": 5, "maxFan": 99 })).unwrap();
    assert_eq!(j.max_fan, Some(99));
}

// --- Go to class and go to symbol ------------------------------------------------

fn pm(pat: &str, name: &str) -> Option<Vec<u16>> {
    let ends = pat.ends_with(' ');
    let p = internals::Pattern::new(pat.trim_end(), ends);
    internals::match_name(&p, name, &mut internals::Scratch::default()).map(|m| m.idx)
}

#[test]
fn matcher_camel_humps_words_and_case() {
    let n = "NewArrivalBookService";
    assert_eq!(pm("NABS", n), Some(vec![0, 3, 10, 14]));
    assert_eq!(pm("NewArrBS", n), Some(vec![0, 1, 2, 3, 4, 5, 10, 14]));
    assert_eq!(pm("newArrival service", n), Some(vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18, 19, 20]));
    assert_eq!(pm("newarrival", n), Some((0..10).collect::<Vec<_>>()), "lower case letters match any case");
    assert_eq!(pm("service", n), Some((14..21).collect::<Vec<_>>()), "a word in the middle");
    assert_eq!(pm("nabs", n), Some(vec![0, 3, 10, 14]), "lower-case letters jump to humps too");
    assert_eq!(pm("npe", "NullPointerException"), Some(vec![0, 4, 11]));
    assert_eq!(pm("mserv", "MemberService"), Some(vec![0, 6, 7, 8, 9]));
    assert_eq!(pm("nax", n), None);
    assert_eq!(pm("bs", n), Some(vec![10, 14]), "the first letter is at a hump");
    assert_eq!(pm("NABX", n), None);
    assert_eq!(pm("Service", "Reservation"), None, "an upper-case letter must start a hump");
    assert_eq!(pm("ook", "Book"), None, "a name part starts at a hump");
    assert_eq!(pm("BOOK", "Book"), None, "upper-case letters need humps");
    assert_eq!(pm("HS", "HTTPServer"), Some(vec![0, 4]), "acronyms end at a hump");
    assert_eq!(pm("snake", "my_snake_case"), Some(vec![3, 4, 5, 6, 7]), "underscore starts a word");
    assert_eq!(pm("a b", "AbcBcd"), Some(vec![0, 3]));
}

#[test]
fn matcher_wildcard_and_trailing_space() {
    assert_eq!(pm("*Repository", "BookRepository"), Some((4..14).collect::<Vec<_>>()));
    assert!(pm("*Repository", "Repository").is_some());
    assert!(pm("Book*Mapper", "BookCommentMapper").is_some());
    assert!(pm("Book*Mapper", "BookMapper").is_some());
    assert!(pm("Book*Mapper", "BookCommentService").is_none());
    assert_eq!(pm("*ook", "Book"), Some(vec![1, 2, 3]), "after a wildcard any position works");
    assert!(pm("Book ", "Book").is_some());
    assert!(pm("Book ", "BookMapper").is_none(), "a trailing space ends the name");
    assert!(pm("Book* ", "BookMapper").is_some(), "a wildcard before the space frees the end");
}

#[test]
fn matcher_non_ascii_and_utf16() {
    assert_eq!(pm("éS", "ÉcoleService"), Some(vec![0, 5]));
    assert_eq!(pm("日本", "日本語Service"), Some(vec![0, 1]));
    assert_eq!(pm("本", "日本語Service"), None, "letters without case have no humps inside a word");
    assert_eq!(pm("日本語S", "日本語Service"), Some(vec![0, 1, 2, 3]));
    // Indexes in UTF-16 units: the emoji takes two.
    let i = index(vec![file("/p/E.kt", Lang::Kotlin, "p", vec![], vec![ty("A😀B", TypeKind::Class)])]);
    let r = crate::find::find_types(&i, &find_req("AB"), status(), &AtomicBool::new(false)).unwrap();
    assert_eq!(r.items[0].name_matches, vec![0, 3]);
    let r = crate::find::find_types(&i, &find_req("A😀"), status(), &AtomicBool::new(false)).unwrap();
    assert_eq!(r.items[0].name_matches, vec![0, 1, 2]);
}

fn find_req(q: &str) -> crate::FindRequest {
    crate::FindRequest { root: "/p".into(), query: q.into(), limit: None, exclude_tests: false, langs: vec![] }
}

fn names(r: &crate::FindResult<crate::TypeHit>) -> Vec<String> {
    r.items.iter().map(|h| h.qualified.clone()).collect()
}

fn find_index() -> Arc<Index> {
    let mut outer = ty("Outer", TypeKind::Class);
    outer.end_line = 10;
    let mut inner = ty("Inner", TypeKind::Class);
    inner.outer = Some(0);
    index(vec![
        file("/p/a/Book.kt", Lang::Kotlin, "a", vec![], vec![ty("Book", TypeKind::Class)]),
        file("/p/b/BOOK.kt", Lang::Kotlin, "b", vec![], vec![ty("BOOK", TypeKind::Class)]),
        file("/p/a/BookSelect.kt", Lang::Kotlin, "a", vec![], vec![ty("BookSelect", TypeKind::Class)]),
        file("/p/a/BookMapper.kt", Lang::Kotlin, "a", vec![], vec![ty("BookMapper", TypeKind::Class)]),
        file("/p/src/test/BookMapper.kt", Lang::Kotlin, "t", vec![], vec![ty("BookMapper", TypeKind::Class)]),
        file("/p/a/BigMap.kt", Lang::Kotlin, "a", vec![], vec![ty("BigMap", TypeKind::Class)]),
        file("/p/a/NewBook.kt", Lang::Kotlin, "a", vec![], vec![ty("NewBook", TypeKind::Class)]),
        file("/p/a/Other.kt", Lang::Kotlin, "jp.shop.cart", vec![], vec![ty("CartService", TypeKind::Class)]),
        file("/p/a/Other2.kt", Lang::Kotlin, "jp.shop.order", vec![], vec![ty("OrderService", TypeKind::Class)]),
        file("/p/a/Outer.kt", Lang::Kotlin, "x", vec![], vec![outer, inner]),
        file("/p/J.java", Lang::Java, "j", vec![], vec![ty("BookJava", TypeKind::Class)]),
    ])
}

#[test]
fn find_types_ranking_order() {
    let i = find_index();
    let c = AtomicBool::new(false);
    let r = crate::find::find_types(&i, &find_req("Book"), status(), &c).unwrap();
    assert_eq!(
        names(&r),
        vec!["a.Book", "b.BOOK", "j.BookJava", "a.BookMapper", "a.BookSelect", "t.BookMapper", "a.NewBook"],
        "exact, exact ignoring case, prefix (short names first, then tests last), then a hump in the middle"
    );
    assert!(r.items[5].test && !r.items[3].test);
    assert!(!r.truncated);
    // Humps: fewer skipped characters first.
    let r = crate::find::find_types(&i, &find_req("BM"), status(), &c).unwrap();
    assert_eq!(names(&r), vec!["a.BigMap", "a.BookMapper", "t.BookMapper"]);
    assert_eq!(r.items[0].name_matches, vec![0, 3]);
    // Limit and truncated.
    let mut req = find_req("Book");
    req.limit = Some(2);
    let r = crate::find::find_types(&i, &req, status(), &c).unwrap();
    assert_eq!(names(&r), vec!["a.Book", "b.BOOK"]);
    assert!(r.truncated);
    // Tests and languages.
    let mut req = find_req("BookMapper");
    req.exclude_tests = true;
    assert_eq!(names(&crate::find::find_types(&i, &req, status(), &c).unwrap()), vec!["a.BookMapper"]);
    let mut req = find_req("Book");
    req.langs = vec![CodeLang::Java];
    assert_eq!(names(&crate::find::find_types(&i, &req, status(), &c).unwrap()), vec!["j.BookJava"]);
    assert!(crate::find::find_types(&i, &find_req(""), status(), &c).unwrap().items.is_empty());
    assert!(crate::find::find_types(&i, &find_req("Zzz"), status(), &c).unwrap().items.is_empty());
    assert_eq!(names(&crate::find::find_types(&i, &find_req("Book "), status(), &c).unwrap()), vec!["a.Book", "b.BOOK", "a.NewBook"], "names that end in Book");
    let err = crate::find::find_types(&i, &find_req("Book"), status(), &AtomicBool::new(true));
    assert_eq!(err.unwrap_err().code(), "cancelled");
}

#[test]
fn lower_case_humps_rank_after_exact_case_and_contiguous() {
    let mk = |names: &[&str]| {
        index(names.iter().enumerate().map(|(k, n)| file(&format!("/p/f{k}.kt"), Lang::Kotlin, "p", vec![], vec![ty(n, TypeKind::Class)])).collect())
    };
    let i = mk(&["NewArrivalBookService", "NewAbsolute", "Nabstract", "NaBsX"]);
    let c = AtomicBool::new(false);
    let r = crate::find::find_types(&i, &find_req("nabs"), status(), &c).unwrap();
    // Contiguous letters first, then the name with fewer jumps, then the humps.
    assert_eq!(names(&r), vec!["p.NaBsX", "p.Nabstract", "p.NewAbsolute", "p.NewArrivalBookService"]);
    let r = crate::find::find_types(&i, &find_req("NABS"), status(), &c).unwrap();
    assert_eq!(names(&r), vec!["p.NewArrivalBookService"], "upper-case letters still need humps");
    assert!(crate::find::find_types(&i, &find_req("ook"), status(), &c).unwrap().items.is_empty());
}

#[test]
fn find_types_qualifier() {
    let i = find_index();
    let c = AtomicBool::new(false);
    let r = crate::find::find_types(&i, &find_req("cart.Service"), status(), &c).unwrap();
    assert_eq!(names(&r), vec!["jp.shop.cart.CartService"]);
    assert_eq!(r.items[0].container, "jp.shop.cart");
    assert_eq!(r.items[0].container_matches, vec![8, 9, 10, 11]);
    assert_eq!(names(&crate::find::find_types(&i, &find_req("shop.cart.CartSer"), status(), &c).unwrap()), vec!["jp.shop.cart.CartService"]);
    assert_eq!(names(&crate::find::find_types(&i, &find_req("order.Service"), status(), &c).unwrap()), vec!["jp.shop.order.OrderService"]);
    assert_eq!(names(&crate::find::find_types(&i, &find_req("Outer.Inner"), status(), &c).unwrap()), vec!["x.Outer.Inner"]);
    assert!(crate::find::find_types(&i, &find_req("nothing.Service"), status(), &c).unwrap().items.is_empty());
    assert_eq!(names(&crate::find::find_types(&i, &find_req("jp.Service"), status(), &c).unwrap()).len(), 2, "both packages are under jp");
    // Only a qualifier with a trailing dot: everything inside.
    assert_eq!(names(&crate::find::find_types(&i, &find_req("cart."), status(), &c).unwrap()), vec!["jp.shop.cart.CartService"]);
}

#[test]
fn find_symbols_kinds_owner_and_ranking() {
    let mut svc = ty("CartService", TypeKind::Class);
    let mut add = method("addItem", Some(tr("Unit")), vec![("id", tr("Long"))]);
    add.line = 3;
    let mut hidden = method("addItemInternal", None, vec![]);
    hidden.visibility = Visibility::Private;
    let mut ctor = member("CartService", MemberKind::Constructor, None);
    ctor.params = vec![Param { name: "repo".into(), ty: Some(tr("Repo")) }];
    svc.methods = vec![hidden, add, ctor];
    svc.fields = vec![field("items", generic("List", vec![tr("Item")]))];
    let mut color = ty("Color", TypeKind::Enum);
    color.fields = vec![member("RED", MemberKind::EnumCase, None)];
    let mut ext = ty("CartService", TypeKind::Extension);
    ext.methods = vec![method("addExtra", None, vec![])];
    let mut f = FileModel { package: "jp.cart".into(), imports: vec![], types: vec![svc], top_level: vec![] };
    f.top_level = vec![method("addAll", None, vec![]), member("addCount", MemberKind::Property, Some(tr("Int")))];
    let kt = Arc::new(FileEntry {
        path: PathBuf::from("/p/a/Cart.kt"),
        lang: Lang::Kotlin,
        mtime_ms: 0,
        size: 0,
        words: Box::new([]),
        model: crate::cmodel::CModel::from_model(&f),
    });
    let sw = file("/p/S/Color.swift", Lang::Swift, "", vec![], vec![color, ty("CartService", TypeKind::Struct), ext]);
    let i = index(vec![kt, sw]);
    let c = AtomicBool::new(false);
    let run = |q: &str| crate::find::find_symbols(&i, &find_req(q), status(), &c).unwrap();
    let r = run("addItem");
    let got: Vec<_> = r.items.iter().map(|h| (h.name.as_str(), h.kind)).collect();
    assert_eq!(got, vec![("addItem", crate::SymbolKindOut::Method), ("addItemInternal", crate::SymbolKindOut::Method)]);
    assert_eq!(r.items[0].owner, "jp.cart.CartService");
    assert_eq!(r.items[0].owner_name, "CartService");
    assert_eq!(r.items[0].params, "id: Long");
    assert_eq!(r.items[0].ty, "Unit");
    assert_eq!(r.items[0].line, 3);
    // Public first inside a group, then by length: addItem is a prefix of both.
    let r = run("add");
    let got: Vec<_> = r.items.iter().map(|h| h.name.as_str()).collect();
    assert_eq!(got, vec!["addAll", "addItem", "addCount", "addExtra", "addItemInternal"]);
    assert_eq!(r.items[0].kind, crate::SymbolKindOut::Function);
    assert_eq!(r.items[0].owner, "");
    assert_eq!(r.items[0].owner_name, "Cart.kt");
    assert_eq!(r.items.iter().find(|h| h.name == "addCount").unwrap().kind, crate::SymbolKindOut::Variable);
    // The extension method has the extended type as owner.
    let ex = r.items.iter().find(|h| h.name == "addExtra").unwrap();
    assert_eq!((ex.owner.as_str(), ex.lang), ("CartService", CodeLang::Swift));
    // Constructors have the name of the type. Fields and enum cases are found.
    let r = run("CartService");
    assert!(r.items.iter().any(|h| h.kind == crate::SymbolKindOut::Constructor && h.params == "repo: Repo"));
    assert_eq!(run("items").items[0].kind, crate::SymbolKindOut::Property);
    assert_eq!(run("RED").items[0].kind, crate::SymbolKindOut::EnumCase);
    // `Type.method`, `Type#method` and humps of the type.
    let q = |s: &str| run(s).items.iter().map(|h| (h.owner.clone(), h.name.clone())).collect::<Vec<_>>();
    assert_eq!(q("CartService.addItem"), vec![("jp.cart.CartService".to_string(), "addItem".to_string()), ("jp.cart.CartService".into(), "addItemInternal".into())]);
    assert_eq!(q("CS#addI").len(), 2);
    assert_eq!(q("cart.CartService.addItem").len(), 2, "package parts before the type");
    assert_eq!(q("Color.RED"), vec![("Color".to_string(), "RED".to_string())]);
    assert!(q("Cart.RED").is_empty());
    assert_eq!(q("Cart.addExtra"), vec![("CartService".to_string(), "addExtra".to_string())]);
    assert_eq!(q("Cart.addAll").len(), 1, "the file name is the owner of top-level symbols");
    assert_eq!(q("Nope.addAll").len(), 0);
    // The same filters as for types.
    let mut req = find_req("add");
    req.langs = vec![CodeLang::Swift];
    assert_eq!(crate::find::find_symbols(&i, &req, status(), &c).unwrap().items.len(), 1);
}

#[test]
fn find_json_shapes() {
    let i = find_index();
    let c = AtomicBool::new(false);
    let r = crate::find::find_types(&i, &find_req("cart.Service"), status(), &c).unwrap();
    let j = serde_json::to_value(&r).unwrap();
    assert_eq!(keys(&j), ["elapsedMs", "index", "items", "truncated"]);
    assert_eq!(keys(&j["items"][0]), ["column", "container", "containerMatches", "kind", "lang", "line", "name", "nameMatches", "path", "qualified", "test"]);
    assert_eq!(j["items"][0]["kind"], "class");
    assert_eq!(j["items"][0]["lang"], "kotlin");
    let mut m = member("f", MemberKind::Method, Some(tr("Int")));
    m.params = vec![];
    let mut t = ty("T", TypeKind::Class);
    t.methods = vec![m];
    let i = index(vec![file("/p/T.kt", Lang::Kotlin, "p", vec![], vec![t])]);
    let j = serde_json::to_value(crate::find::find_symbols(&i, &find_req("f"), status(), &c).unwrap()).unwrap();
    assert_eq!(keys(&j["items"][0]), ["column", "kind", "lang", "line", "name", "nameMatches", "owner", "ownerName", "params", "path", "test", "type", "visibility"]);
    assert_eq!(j["items"][0]["kind"], "method");
    assert_eq!(j["items"][0]["visibility"], "public");
    let req: crate::FindRequest = serde_json::from_value(serde_json::json!({ "root": "/p", "query": "x" })).unwrap();
    assert!(req.limit.is_none() && !req.exclude_tests && req.langs.is_empty());
    let req: crate::FindRequest =
        serde_json::from_value(serde_json::json!({ "root": "/p", "query": "x", "limit": 5, "excludeTests": true, "langs": ["swift", "java"] })).unwrap();
    assert_eq!((req.limit, req.exclude_tests, req.langs.len()), (Some(5), true, 2));
}

// --- JSON shapes ----------------------------------------------------------------

fn keys(v: &serde_json::Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn diagram_result_json_matches_code_ts() {
    let i = graph_index();
    let r = run(&i, &request(types_scope(&["k.Service"]), ALL, 1, Direction::Out));
    let j = serde_json::to_value(&r).unwrap();
    assert_eq!(keys(&j), ["edges", "focus", "index", "nodes", "truncated"]);
    assert_eq!(keys(&j["index"]), ["buildMs", "files", "state", "types"]);
    assert_eq!(j["index"]["state"], "ready");
    let n = j["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "k.Service").unwrap();
    assert_eq!(
        keys(n),
        ["annotations", "column", "container", "external", "fields", "id", "kind", "lang", "line", "membersTruncated", "methods", "modifiers", "name", "path", "typeParams"]
    );
    assert_eq!(n["kind"], "class");
    assert_eq!(n["lang"], "kotlin");
    let m = &n["methods"][0];
    assert_eq!(keys(m), ["abstract", "column", "kind", "line", "name", "params", "static", "type", "visibility"]);
    assert_eq!(n["fields"][0]["kind"], "property");
    let e = j["edges"].as_array().unwrap().iter().find(|e| e["kind"] == "composition").unwrap();
    assert_eq!(keys(e), ["from", "kind", "label", "multiplicity", "to"]);
    let plain = j["edges"].as_array().unwrap().iter().find(|e| e["kind"] == "extends").unwrap();
    assert_eq!(keys(plain), ["from", "kind", "to"]);
    // External node: lang and path are null.
    let mut req = request(types_scope(&["k.Service"]), ALL, 1, Direction::Out);
    req.include_external = true;
    let j = serde_json::to_value(run(&i, &req)).unwrap();
    let ext = j["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "ext:JpaRepository").unwrap();
    assert!(ext["lang"].is_null() && ext["path"].is_null());
    assert_eq!(ext["external"], true);
}

#[test]
fn request_json_from_the_frontend_parses() {
    let j = serde_json::json!({
        "root": "/p",
        "scope": { "kind": "cursor", "path": "/p/A.kt", "line": 3, "column": 4, "text": "x" },
        "relations": ["extends", "typeAlias_not_here"],
        "depth": 2, "direction": "in", "includeExternal": true, "maxNodes": 50
    });
    assert!(serde_json::from_value::<DiagramRequest>(j).is_err(), "unknown relation is refused");
    let j = serde_json::json!({
        "root": "/p",
        "scope": { "kind": "types", "ids": ["a.B"] },
        "relations": ["extends", "implements", "composition", "aggregation", "dependency", "nested"],
        "depth": 2, "direction": "both", "includeExternal": false, "maxNodes": 50
    });
    let r: DiagramRequest = serde_json::from_value(j).unwrap();
    assert_eq!(r.relations.len(), 6);
    for s in [
        serde_json::json!({ "kind": "file", "path": "/a" }),
        serde_json::json!({ "kind": "folder", "path": "/a" }),
        serde_json::json!({ "kind": "cursor", "path": "/a", "line": 1, "column": 1 }),
    ] {
        serde_json::from_value::<DiagramScope>(s).unwrap();
    }
    let u: UsagesRequest =
        serde_json::from_value(serde_json::json!({ "root": "/p", "path": "/p/A.kt", "line": 1, "column": 2, "maxResults": 10 })).unwrap();
    assert!(!u.wide && u.text.is_none());
}

#[test]
fn usages_result_json_matches_code_ts() {
    let r = UsagesResult {
        symbol: Some(UsageSymbol {
            name: "Foo".into(),
            kind: SymbolKind::TopLevel,
            detail: Some("function".into()),
            owner: Some("a.Foo".into()),
            declaration: Some(Declaration { path: "/p/A.kt".into(), line: 1, column: 2 }),
            lang: Some(Lang::Swift),
        }),
        files: vec![UsageFile {
            path: "/p/A.kt".into(),
            likely: true,
            matches: vec![UsageMatch { line: 1, column: 2, text: "x".into(), range: [0, 1], kind: UsageKind::Instantiation }],
        }],
        total: 1,
        truncated: false,
        exact: true,
        file_only: false,
        elapsed_ms: 3,
    };
    let j = serde_json::to_value(&r).unwrap();
    assert_eq!(keys(&j), ["elapsedMs", "exact", "fileOnly", "files", "symbol", "total", "truncated"]);
    assert_eq!(keys(&j["symbol"]), ["declaration", "detail", "kind", "lang", "name", "owner"]);
    assert_eq!(j["symbol"]["kind"], "topLevel");
    assert_eq!(j["symbol"]["lang"], "swift");
    assert_eq!(keys(&j["files"][0]), ["likely", "matches", "path"]);
    assert_eq!(keys(&j["files"][0]["matches"][0]), ["column", "kind", "line", "range", "text"]);
    assert_eq!(j["files"][0]["matches"][0]["kind"], "instantiation");
    assert_eq!(j["files"][0]["matches"][0]["range"], serde_json::json!([0, 1]));
    let none = UsagesResult { symbol: None, files: vec![], total: 0, truncated: false, exact: false, file_only: false, elapsed_ms: 0 };
    assert!(serde_json::to_value(&none).unwrap()["symbol"].is_null());
    let minimal = UsageSymbol { name: "x".into(), kind: SymbolKind::Unknown, detail: None, owner: None, declaration: None, lang: None };
    let j = serde_json::to_value(&minimal).unwrap();
    assert_eq!(keys(&j), ["kind", "lang", "name"]);
    assert!(j["lang"].is_null());
}

// --- Real files (parsers) -------------------------------------------------------

mod files {
    use super::*;
    use std::fs;
    use std::path::Path;
    use crate::internals;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn kotlin_ready() -> bool {
        !kestrel_lang::parse(Lang::Kotlin, "class A").types.is_empty()
    }

    fn java_ready() -> bool {
        !kestrel_lang::parse(Lang::Java, "class A {}").types.is_empty()
    }

    fn swift_ready() -> bool {
        !kestrel_lang::parse(Lang::Swift, "class A {}").types.is_empty()
    }

    fn usages(m: &CodeManager, root: &Path, rel: &str, line: u32, col: u32) -> UsagesResult {
        let req = UsagesRequest {
            root: root.to_string_lossy().into(),
            path: root.join(rel).to_string_lossy().into(),
            line,
            column: col,
            text: None,
            wide: false,
            max_results: 1000,
        };
        m.usages("w1", &req, &AtomicBool::new(false)).unwrap()
    }

    fn files_of(r: &UsagesResult, root: &Path, likely: bool) -> Vec<String> {
        r.files
            .iter()
            .filter(|f| f.likely == likely)
            .map(|f| Path::new(&f.path).strip_prefix(root.canonicalize().unwrap()).unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn kotlin_type_usages_check_the_package() {
        if !kotlin_ready() {
            eprintln!("skipped: Kotlin parser is not ready");
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "a/Foo.kt", "package a\n\nclass Foo(val n: Int) {\n    fun make(): Foo = Foo(1)\n}\n");
        write(r, "b/Foo.kt", "package b\n\nclass Foo\n");
        write(r, "b/UsesOwn.kt", "package b\n\nfun f() = Foo()\n");
        write(r, "c/UsesA.kt", "package c\n\nimport a.Foo\n\nclass UsesA(val foo: Foo) {\n    // Foo in a comment\n    val s = \"Foo\"\n    fun g() = Foo(2)\n}\n");
        write(r, "d/Alias.kt", "package d\n\nimport a.Foo as AF\n\nval x: AF? = null\n");
        write(r, "e/Wild.kt", "package e\n\nimport a.*\n\nclass W : Foo(3)\n");
        write(r, "f/NoImport.kt", "package f\n\nclass N(val foo: Foo)\n");
        let m = CodeManager::new();
        // Cursor on `Foo` in `class Foo` of a/Foo.kt (line 3, column 8).
        let res = usages(&m, r, "a/Foo.kt", 3, 8);
        let sym = res.symbol.clone().unwrap();
        assert_eq!(sym.kind, SymbolKind::Type);
        assert_eq!(sym.detail.as_deref(), Some("class"));
        assert_eq!(sym.owner.as_deref(), Some("a.Foo"));
        assert!(res.exact);
        let likely = files_of(&res, r, true);
        assert_eq!(likely, vec!["a/Foo.kt", "c/UsesA.kt", "d/Alias.kt", "e/Wild.kt"]);
        let unlikely = files_of(&res, r, false);
        assert!(unlikely.contains(&"f/NoImport.kt".to_string()) || !unlikely.contains(&"b/UsesOwn.kt".to_string()));
        assert!(!likely.contains(&"b/UsesOwn.kt".to_string()), "b.Foo is another type");
        assert!(!likely.contains(&"b/Foo.kt".to_string()));
        assert!(!likely.contains(&"f/NoImport.kt".to_string()), "no import and another package");
        // Comments and strings do not count. UsesA has: import, parameter type, call.
        let uses = res.files.iter().find(|f| f.path.ends_with("c/UsesA.kt")).unwrap();
        assert_eq!(uses.matches.len(), 3);
        assert_eq!(uses.matches[0].kind, UsageKind::Import);
        assert_eq!(uses.matches[1].kind, UsageKind::Type);
        assert_eq!(uses.matches[2].kind, UsageKind::Instantiation, "a call of a type name");
        assert_eq!(&uses.matches[2].text[uses.matches[2].range[0] as usize..uses.matches[2].range[1] as usize], "Foo");
        assert!(uses.matches.windows(2).all(|w| w[0].line <= w[1].line));
        let own = res.files.iter().find(|f| f.path.ends_with("a/Foo.kt")).unwrap();
        assert_eq!(own.matches[0].kind, UsageKind::Declaration);
        // The alias is found too.
        let alias = res.files.iter().find(|f| f.path.ends_with("d/Alias.kt")).unwrap();
        assert!(alias.matches.iter().any(|m| m.text.contains("AF?")));
        // Cursor on a use gives the same symbol.
        let res2 = usages(&m, r, "c/UsesA.kt", 8, 17);
        assert_eq!(res2.symbol.unwrap().owner.as_deref(), Some("a.Foo"));
        // A cursor in a comment finds no symbol.
        let res3 = usages(&m, r, "c/UsesA.kt", 6, 8);
        assert!(res3.symbol.is_none());
        // Max results.
        let mut req = UsagesRequest {
            root: r.to_string_lossy().into(),
            path: r.join("a/Foo.kt").to_string_lossy().into(),
            line: 3,
            column: 8,
            text: None,
            wide: false,
            max_results: 2,
        };
        let cut = m.usages("w1", &req, &AtomicBool::new(false)).unwrap();
        assert!(cut.truncated);
        assert_eq!(cut.total, 2);
        req.max_results = 1000;
        // Index lifecycle.
        assert_eq!(m.status(&r.to_string_lossy()).state, IndexState::Ready);
        m.drop_root("w1", &r.to_string_lossy());
        assert_eq!(m.status(&r.to_string_lossy()).state, IndexState::None);
        assert_eq!(m.root_count(), 0);
    }

    #[test]
    fn kotlin_member_and_local_usages() {
        if !kotlin_ready() {
            eprintln!("skipped: Kotlin parser is not ready");
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "Repo.kt", "package a\n\ninterface Repo {\n    fun save(x: Int)\n}\n");
        write(r, "RepoImpl.kt", "package a\n\nclass RepoImpl : Repo {\n    override fun save(x: Int) {\n        val tmp = x + 1\n        println(tmp)\n    }\n}\n");
        write(r, "Service.kt", "package a\n\nclass Service(private val repo: Repo) {\n    fun run() {\n        repo.save(1)\n    }\n}\n");
        write(r, "Other.kt", "package z\n\nclass Cache {\n    fun save(y: Int) {}\n}\nfun g(c: Cache) { c.save(2) }\n");
        let m = CodeManager::new();
        // Cursor on `save` in `repo.save(1)` where `repo` is a constructor property of type Repo.
        let res = usages(&m, r, "Service.kt", 5, 15);
        let sym = res.symbol.clone().unwrap();
        assert_eq!(sym.kind, SymbolKind::Member);
        assert_eq!(sym.owner.as_deref(), Some("a.Repo"));
        assert_eq!(sym.detail.as_deref(), Some("method"));
        let likely = files_of(&res, r, true);
        assert!(likely.contains(&"Repo.kt".to_string()));
        assert!(likely.contains(&"RepoImpl.kt".to_string()), "the override is a declaration in a subtype");
        assert!(likely.contains(&"Service.kt".to_string()));
        assert!(!likely.contains(&"Other.kt".to_string()), "Cache.save is not related");
        // A local variable stays in its file.
        let res = usages(&m, r, "RepoImpl.kt", 6, 17);
        let sym = res.symbol.unwrap();
        assert_eq!(sym.kind, SymbolKind::Local);
        assert!(res.file_only);
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].matches.len(), 2);
    }

    #[test]
    fn kotlin_member_usages_reach_sibling_implementations() {
        if !kotlin_ready() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "Port.kt", "package a\n\ninterface Port {\n    fun send(x: Int)\n}\n");
        write(r, "Real.kt", "package a\n\nclass Real : Port {\n    override fun send(x: Int) {}\n}\n");
        write(r, "Fake.kt", "package b\n\nimport a.Port\n\nclass Fake : Port {\n    override fun send(x: Int) {}\n}\n");
        write(r, "Caller.kt", "package c\n\nimport a.Port\n\nfun f(p: Port) { p.send(1) }\n");
        write(r, "Unrelated.kt", "package z\n\nclass Pigeon {\n    fun send(x: Int) {}\n}\n");
        let m = CodeManager::new();
        // Cursor on `send` in Real.kt.
        let res = usages(&m, r, "Real.kt", 4, 19);
        assert_eq!(res.symbol.as_ref().unwrap().kind, SymbolKind::Member);
        let likely = files_of(&res, r, true);
        assert_eq!(likely, vec!["Caller.kt", "Fake.kt", "Port.kt", "Real.kt"], "interface, sibling and caller");
        // The same name elsewhere is kept, in a file that is not likely.
        assert_eq!(files_of(&res, r, false), vec!["Unrelated.kt"]);
    }

    #[test]
    fn word_prefilter_skips_files_without_the_name() {
        if !kotlin_ready() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "Foo.kt", "package p\n\nclass Foo\n");
        write(r, "Use.kt", "package p\n\nval x: Foo? = null\n");
        write(r, "Comment.kt", "package p\n\n// Foo is mentioned here\nval s = \"Foo\"\n");
        write(r, "Other.kt", "package p\n\nclass Bar\n");
        write(r, "Alias.kt", "package q\n\nimport p.Foo as Baz\n\nval y: Baz? = null\n");
        let cancel = AtomicBool::new(false);
        let root = r.canonicalize().unwrap();
        let index = internals::build_index(&root, &cancel).unwrap();
        let words = |rel: &str| index.file(index.file_id(&root.join(rel)).unwrap()).words.clone();
        assert!(internals::may_hold(&words("Comment.kt"), "Foo"), "a comment is a candidate");
        assert!(internals::may_hold(&words("Use.kt"), "Foo"));
        assert!(!internals::may_hold(&words("Other.kt"), "Foo"));
        assert!(internals::may_hold(&words("Alias.kt"), "Baz"), "the alias is a word of the file");
        assert!(words("Foo.kt").windows(2).all(|w| w[0] < w[1]), "sorted and unique");
        // The search gives no match in the comment file.
        let m = CodeManager::new();
        let res = usages(&m, r, "Foo.kt", 3, 8);
        let names = files_of(&res, r, true);
        assert_eq!(names, vec!["Alias.kt", "Foo.kt", "Use.kt"]);
        assert!(!res.files.iter().any(|f| f.path.ends_with("Comment.kt") || f.path.ends_with("Other.kt")));
        // An update changes the list.
        write(r, "Other.kt", "package p\n\nclass Bar { val f: Foo? = null }\n");
        let p = root.join("Other.kt");
        let newer = internals::update_index(&index, &[p.clone()], false, &cancel).unwrap();
        let w = newer.file(newer.file_id(&p).unwrap()).words.clone();
        assert!(internals::may_hold(&w, "Foo"));
        assert!(w.len() > words("Other.kt").len());
        // And the search through the manager sees the change after `update`.
        m.update(&r.to_string_lossy(), &[p.to_string_lossy().into_owned()], false).unwrap();
        let res = usages(&m, r, "Foo.kt", 3, 8);
        assert!(files_of(&res, r, true).contains(&"Other.kt".to_string()));
    }

    // --- Callers ---

    fn cursor(root: &Path, rel: &str, needle: &str, delta: usize) -> (u32, u32) {
        let text = fs::read_to_string(root.join(rel)).unwrap();
        let i = text.find(needle).unwrap_or_else(|| panic!("{needle} not in {rel}"));
        let line = text[..i].matches('\n').count() as u32 + 1;
        let col = (i - text[..i].rfind('\n').map_or(0, |n| n + 1)) as u32 + 1 + delta as u32;
        (line, col)
    }

    fn callers_at(m: &CodeManager, root: &Path, rel: &str, needle: &str, delta: usize) -> CallersResult {
        let (line, column) = cursor(root, rel, needle, delta);
        let req = CallersRequest {
            root: root.to_string_lossy().into(),
            at: Some(CallAt { path: root.join(rel).to_string_lossy().into(), line, column, text: None }),
            target: None,
            max_results: 1000,
        };
        m.callers("w1", &req, &AtomicBool::new(false)).unwrap()
    }

    fn callers_of(m: &CodeManager, root: &Path, t: &CallTarget) -> CallersResult {
        let req = CallersRequest { root: root.to_string_lossy().into(), at: None, target: Some(t.clone()), max_results: 1000 };
        m.callers("w1", &req, &AtomicBool::new(false)).unwrap()
    }

    fn who(r: &CallersResult) -> Vec<String> {
        r.callers.iter().map(|c| format!("{}.{}({})/{:?}", c.caller.owner, c.caller.name, c.caller.params, c.caller.kind)).collect()
    }

    #[test]
    fn kotlin_call_chain_overloads_initializers_and_lambdas() {
        if !kotlin_ready() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "C.kt", "package p\n\nclass C {\n    fun c() {}\n}\n");
        write(r, "B.kt", "package p\n\nclass B(private val c: C) {\n    fun b() {\n        c.c()\n    }\n}\n");
        write(r, "A.kt", "package p\n\nclass A(private val b: B) {\n    fun a() {\n        b.b()\n    }\n}\n");
        write(
            r,
            "Ov.kt",
            "package p\n\nclass Ov {\n    fun go(x: Int) { C().c() }\n    fun go(s: String) { C().c() }\n    val prop = C().c()\n    init {\n        C().c()\n    }\n    fun lam() {\n        listOf(1).forEach {\n            C().c()\n        }\n    }\n}\n",
        );
        let m = CodeManager::new();
        // Callers of c: found from its declaration. A.a is not one of them.
        let res = callers_at(&m, r, "C.kt", "c() {}", 0);
        let t = res.target.clone().unwrap();
        assert_eq!((t.owner.as_str(), t.name.as_str(), t.kind), ("p.C", "c", CallKind::Method));
        let w = who(&res);
        assert!(w.contains(&"p.B.b()/Method".to_string()), "{w:?}");
        assert!(w.contains(&"p.Ov.go(x: Int)/Method".to_string()));
        assert!(w.contains(&"p.Ov.go(s: String)/Method".to_string()), "overloads are separate callers");
        assert!(w.contains(&"p.Ov.prop()/Property".to_string()), "a property initializer");
        assert!(w.contains(&"p.Ov.Ov()/Initializer".to_string()), "init block: {w:?}");
        assert!(w.contains(&"p.Ov.lam()/Method".to_string()), "a lambda belongs to its method");
        assert!(!w.iter().any(|x| x.contains("p.A.")));
        assert_eq!(res.callers.len(), 6 - 0 - 0 + 0 - 0, "{w:?}");
        assert!(res.callers.windows(2).all(|p| (&p[0].caller.path, p[0].caller.line) <= (&p[1].caller.path, p[1].caller.line)));
        let b = res.callers.iter().find(|c| c.caller.name == "b").unwrap();
        assert_eq!(b.sites.len(), 1);
        assert_eq!(b.sites[0].line, 5);
        assert!(b.likely && !b.test);
        // The next level: callers of b are a.
        let up = callers_of(&m, r, &b.caller);
        assert_eq!(who(&up), vec!["p.A.a()/Method"]);
        assert_eq!(up.target.as_ref().unwrap().name, "b");
        // Callers of a: none.
        let a = callers_of(&m, r, &up.callers[0].caller);
        assert!(a.callers.is_empty() && a.target.is_some());
        // Constructor: the cursor is on a call of the type name.
        let ctor = callers_at(&m, r, "Ov.kt", "C().c()", 0);
        let t = ctor.target.clone().unwrap();
        assert_eq!((t.kind, t.owner.as_str()), (CallKind::Constructor, "p.C"));
        assert!(ctor.exact);
        assert_eq!(ctor.callers.len(), 5, "{:?}", who(&ctor));
        // No method at the position.
        let none = callers_at(&m, r, "C.kt", "package", 2);
        assert!(none.target.is_none());
        // An initializer has no callers.
        let init = ctor.callers.iter().find(|c| c.caller.kind == CallKind::Initializer).unwrap();
        assert!(callers_of(&m, r, &init.caller).callers.is_empty());
    }

    #[test]
    fn interface_method_called_through_the_interface() {
        if !kotlin_ready() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "Port.kt", "package p\n\ninterface Port {\n    fun send()\n}\n");
        write(r, "Impl.kt", "package p\n\nclass Impl : Port {\n    override fun send() {}\n}\n");
        write(r, "User.kt", "package p\n\nclass User(private val port: Port) {\n    fun use() {\n        port.send()\n    }\n}\n");
        write(r, "src/test/kotlin/UserTest.kt", "package p\n\nclass UserTest {\n    fun t(p: Port) { p.send() }\n}\n");
        let m = CodeManager::new();
        let res = callers_at(&m, r, "Impl.kt", "send() {}", 0);
        let w = who(&res);
        assert_eq!(w, vec!["p.User.use()/Method", "p.UserTest.t(p: Port)/Method"], "{w:?}");
        assert!(res.callers.iter().all(|c| c.likely));
        assert!(res.callers[1].test && !res.callers[0].test);
    }

    #[test]
    fn java_static_block_and_swift_extension() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let m = CodeManager::new();
        if java_ready() {
            write(r, "p/C.java", "package p;\npublic class C {\n    public void c() {}\n}\n");
            write(r, "p/J.java", "package p;\npublic class J {\n    static { new C().c(); }\n    void m() { new C().c(); }\n}\n");
            let res = callers_at(&m, r, "p/C.java", "c() {}", 0);
            let w = who(&res);
            assert_eq!(w, vec!["p.J.J()/Initializer", "p.J.m()/Method"], "{w:?}");
        }
        if swift_ready() {
            write(r, "S/Model.swift", "struct Model {\n    func a() {}\n}\nextension Model {\n    func b() {\n        a()\n    }\n}\n");
            m.update(&r.to_string_lossy(), &[], true).unwrap();
            let res = callers_at(&m, r, "S/Model.swift", "a() {}", 0);
            assert_eq!(who(&res), vec!["Model.b()/Method"]);
        }
    }

    #[test]
    fn test_path_rule() {
        let root = Path::new("/r");
        let t = |p: &str| internals::is_test_path(root, Path::new(p));
        assert!(t("/r/src/test/kotlin/A.kt"));
        assert!(t("/r/app/androidTest/A.kt"));
        assert!(t("/r/AppTests/A.swift"));
        assert!(t("/r/src/main/FooTest.kt"));
        assert!(t("/r/src/main/FooSpec.kt"));
        assert!(t("/r/src/main/FooIT.java"));
        assert!(!t("/r/src/main/Foo.kt"));
        assert!(!t("/r/src/main/UNIT.kt"), "all upper case before IT is not a test");
        assert!(!internals::is_test_path(Path::new("/test"), Path::new("/test/src/main/Foo.kt")), "the root itself does not count");
    }

    #[test]
    fn members_without_end_line_use_the_next_member() {
        // Two methods without end lines in a type that ends on line 12.
        let mut t = ty("T", TypeKind::Class);
        t.end_line = 12;
        let mut m1 = method("one", None, vec![]);
        m1.line = 2;
        let mut m2 = method("two", None, vec![]);
        m2.line = 6;
        let mut f = field("prop", tr("Int"));
        f.line = 10;
        t.methods = vec![m1, m2];
        t.fields = vec![f];
        let i = index(vec![file("/p/T.kt", Lang::Kotlin, "p", vec![], vec![t])]);
        let v = i.view();
        let fe = i.file(0);
        let at = |line: u32| {
            let l = crate::callers::locate(&v, 0, &fe.model, Lang::Kotlin, "T.kt", line);
            (l.name, l.kind)
        };
        assert_eq!(at(4), ("one".into(), CallKind::Method));
        assert_eq!(at(5), ("one".into(), CallKind::Method));
        assert_eq!(at(6), ("two".into(), CallKind::Method));
        assert_eq!(at(9), ("two".into(), CallKind::Method));
        assert_eq!(at(11), ("prop".into(), CallKind::Property));
        // Before the first member: code of the type.
        assert_eq!(at(1), ("T".into(), CallKind::Initializer));
        // Outside every type: top-level code of the file.
        assert_eq!(at(20), ("T.kt".into(), CallKind::Initializer));
        // An end line that goes past the next member is cut there.
        let mut t = ty("U", TypeKind::Class);
        t.end_line = 12;
        let mut m1 = method("one", None, vec![]);
        m1.line = 2;
        m1.end_line = 11;
        let mut m2 = method("two", None, vec![]);
        m2.line = 6;
        m2.end_line = 8;
        t.methods = vec![m1, m2];
        let i = index(vec![file("/p/U.kt", Lang::Kotlin, "p", vec![], vec![t])]);
        let v = i.view();
        let l = crate::callers::locate(&v, 0, &i.file(0).model, Lang::Kotlin, "U.kt", 7);
        assert_eq!(l.name, "two");
        let l = crate::callers::locate(&v, 0, &i.file(0).model, Lang::Kotlin, "U.kt", 4);
        assert_eq!(l.name, "one");
        let l = crate::callers::locate(&v, 0, &i.file(0).model, Lang::Kotlin, "U.kt", 9);
        assert_eq!(l.kind, CallKind::Initializer, "after `two` ends and before the type end");
    }

    #[test]
    fn callers_json_matches_code_ts() {
        let t = CallTarget { owner: "a.B".into(), name: "f".into(), kind: CallKind::Constructor, params: "x: Int".into(), path: "/p".into(), line: 1, column: 2, lang: CodeLang::Swift };
        let r = CallersResult {
            target: Some(t.clone()),
            callers: vec![CallerNode { caller: t.clone(), sites: vec![CallSite { line: 1, column: 1, text: "x".into(), range: [0, 1] }], likely: true, test: false }],
            exact: true,
            truncated: false,
            elapsed_ms: 1,
        };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(keys(&j), ["callers", "elapsedMs", "exact", "target", "truncated"]);
        assert_eq!(keys(&j["target"]), ["column", "kind", "lang", "line", "name", "owner", "params", "path"]);
        assert_eq!(j["target"]["kind"], "constructor");
        assert_eq!(j["target"]["lang"], "swift");
        assert_eq!(keys(&j["callers"][0]), ["caller", "likely", "sites", "test"]);
        assert_eq!(keys(&j["callers"][0]["sites"][0]), ["column", "line", "range", "text"]);
        let req: CallersRequest = serde_json::from_value(serde_json::json!({ "root": "/p", "target": serde_json::to_value(&t).unwrap(), "maxResults": 5 })).unwrap();
        assert_eq!(req.target.unwrap(), t);
        let req: CallersRequest = serde_json::from_value(serde_json::json!({ "root": "/p", "at": { "path": "/a", "line": 1, "column": 2 }, "maxResults": 5 })).unwrap();
        assert!(req.at.is_some() && req.target.is_none());
    }

    #[test]
    fn other_languages_use_a_whole_word_search() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "a.py", "def hello():\n    hello()\n    hello_world()\n");
        write(r, "b.py", "# hello\nx = Hello\n");
        write(r, "c.txt", "hello\n");
        let m = CodeManager::new();
        let res = usages(&m, r, "a.py", 1, 6);
        let sym = res.symbol.unwrap();
        assert_eq!(sym.kind, SymbolKind::Unknown);
        assert!(sym.lang.is_none());
        assert!(!res.exact);
        assert_eq!(res.total, 3, "two in a.py, one in the comment of b.py; not hello_world, not Hello, not c.txt");
        assert!(res.files.iter().all(|f| f.matches.iter().all(|m| m.kind == UsageKind::Reference)));
    }

    #[test]
    fn index_updates_follow_file_changes() {
        if !kotlin_ready() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "A.kt", "package a\nclass A\n");
        let root = r.to_string_lossy().into_owned();
        let m = CodeManager::new();
        let mk = |ids: &[&str]| DiagramRequest {
            root: root.clone(),
            scope: types_scope(ids),
            relations: vec![Extends],
            depth: 0,
            direction: Direction::Out,
            include_external: false,
            max_nodes: 10,
        max_fan: None,
        };
        let c = AtomicBool::new(false);
        assert_eq!(m.status(&root).state, IndexState::None);
        assert_eq!(m.diagram("w", &mk(&["a.A"]), &c).unwrap().nodes.len(), 1);
        assert_eq!(m.status(&root).files, 1);
        write(r, "B.kt", "package a\nclass B : A()\n");
        let b = r.join("B.kt").to_string_lossy().into_owned();
        m.update(&root, &[b.clone()], false).unwrap();
        assert_eq!(m.status(&root).files, 2);
        assert_eq!(m.diagram("w", &mk(&["a.B"]), &c).unwrap().nodes.len(), 1);
        fs::remove_file(r.join("B.kt")).unwrap();
        m.update(&root, &[b], false).unwrap();
        assert_eq!(m.status(&root).files, 1);
        write(r, "C.kt", "package a\nclass C\n");
        m.update(&root, &[], true).unwrap();
        assert_eq!(m.status(&root).files, 2);
        // Two windows share one index. It stays until both let go.
        m.diagram("w2", &mk(&["a.A"]), &c).unwrap();
        m.drop_root("w", &root);
        assert_eq!(m.status(&root).state, IndexState::Ready);
        m.window_destroyed("w2");
        assert_eq!(m.status(&root).state, IndexState::None);
    }

    #[test]
    fn java_and_swift_end_to_end() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let m = CodeManager::new();
        if java_ready() {
            write(r, "j/Shape.java", "package j;\npublic interface Shape { double area(); }\n");
            write(r, "j/Circle.java", "package j;\npublic class Circle implements Shape {\n    public double area() { return 1.0; }\n    Shape twin() { return new Circle(); }\n}\n");
            let res = usages(&m, r, "j/Shape.java", 2, 22);
            assert_eq!(res.symbol.as_ref().unwrap().kind, SymbolKind::Type);
            let c = res.files.iter().find(|f| f.path.ends_with("Circle.java")).unwrap();
            assert!(c.matches.iter().any(|m| m.kind == UsageKind::Supertype));
        } else {
            eprintln!("skipped: Java parser is not ready");
        }
        if swift_ready() {
            write(r, "S/Model.swift", "struct Model {\n    var name: String\n}\nextension Model: Printable {\n    func describe() -> String { name }\n}\nprotocol Printable {}\n");
            write(r, "S/Use.swift", "class Use {\n    let m = Model(name: \"x\")\n    func f() { print(m.name) }\n}\n");
            m.update(&r.to_string_lossy(), &[], true).unwrap();
            let res = usages(&m, r, "S/Model.swift", 1, 9);
            assert_eq!(res.symbol.as_ref().unwrap().kind, SymbolKind::Type);
            assert!(res.files.iter().any(|f| f.path.ends_with("Use.swift") && f.likely));
        } else {
            eprintln!("skipped: Swift parser is not ready");
        }
    }
}
