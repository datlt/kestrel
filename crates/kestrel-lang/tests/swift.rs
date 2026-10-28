use kestrel_lang::*;

fn p(text: &str) -> FileModel {
    parse(Lang::Swift, text)
}

fn ty<'a>(m: &'a FileModel, name: &str) -> &'a TypeDecl {
    m.types.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("no type {name}: {:?}", m.types.iter().map(|t| &t.name).collect::<Vec<_>>()))
}

fn field<'a>(t: &'a TypeDecl, name: &str) -> &'a Member {
    t.fields.iter().find(|m| m.name == name).unwrap_or_else(|| panic!("no field {name}"))
}

fn method<'a>(t: &'a TypeDecl, name: &str) -> &'a Member {
    t.methods.iter().find(|m| m.name == name).unwrap_or_else(|| panic!("no method {name}"))
}

fn sup(t: &TypeDecl) -> Vec<&str> {
    t.supertypes.iter().map(|s| s.ty.name.as_str()).collect()
}

/// Hits as (text, kind, qualifier).
fn ids(text: &str, name: &str) -> Vec<(UsageKind, String)> {
    find_identifiers(Lang::Swift, text, name)
        .into_iter()
        .map(|h| {
            assert_eq!(&text[h.start..h.end], name);
            (h.kind, h.qualifier)
        })
        .collect()
}

fn kinds(text: &str, name: &str) -> Vec<UsageKind> {
    ids(text, name).into_iter().map(|h| h.0).collect()
}

use UsageKind::*;

// ---------- parse: imports and types ----------

#[test]
fn imports() {
    let m = p("import UIKit\n@testable import App\nimport struct Foo.Bar\n@_exported import Foundation\nimport func Darwin.sin\n");
    let paths: Vec<_> = m.imports.iter().map(|i| i.path.as_str()).collect();
    assert_eq!(paths, ["UIKit", "App", "Foo.Bar", "Foundation", "Darwin.sin"]);
    assert_eq!(m.imports[0].line, 1);
    assert_eq!(m.imports[2].line, 3);
    assert_eq!(m.package, "");
}

#[test]
fn type_kinds() {
    let m = p("class A {}\nfinal class B {}\nopen class C {}\nstruct D {}\nenum E {}\nindirect enum F {}\nprotocol G {}\nactor H {}\nextension A {}\ntypealias I = Int\n");
    let kinds: Vec<_> = m.types.iter().map(|t| (t.name.as_str(), t.kind)).collect();
    assert_eq!(
        kinds,
        [
            ("A", TypeKind::Class),
            ("B", TypeKind::Class),
            ("C", TypeKind::Class),
            ("D", TypeKind::Struct),
            ("E", TypeKind::Enum),
            ("F", TypeKind::Enum),
            ("G", TypeKind::Protocol),
            ("H", TypeKind::Actor),
            ("A", TypeKind::Extension),
            ("I", TypeKind::TypeAlias),
        ]
    );
    assert_eq!(ty(&m, "B").modifiers, ["final"]);
    assert_eq!(ty(&m, "C").modifiers, ["open"]);
    assert_eq!(ty(&m, "F").modifiers, ["indirect"]);
}

#[test]
fn positions() {
    let src = "import UIKit\n\n@MainActor\npublic final class Foo: Bar {\n    var x = 1\n}\n\nstruct S {}";
    let m = p(src);
    let f = ty(&m, "Foo");
    assert_eq!(f.line, 4);
    assert_eq!(f.column, 20);
    assert_eq!(f.start_line, 3);
    assert_eq!(f.end_line, 6);
    assert_eq!(f.annotations, ["MainActor"]);
    assert_eq!(f.modifiers, ["public", "final"]);
    let s = ty(&m, "S");
    assert_eq!((s.line, s.start_line, s.end_line), (8, 8, 8));
    let x = field(f, "x");
    assert_eq!((x.line, x.column), (5, 9));
}

#[test]
fn inheritance_and_generics() {
    let m = p("class Box<T: Equatable, U>: Base, Proto, Other<T> where T: Hashable {\n}\nprotocol P: AnyObject, Q {}\nenum E: String, Codable { case a }\nstruct S: @unchecked Sendable {}");
    let b = ty(&m, "Box");
    assert_eq!(b.type_params, ["T", "U"]);
    assert_eq!(sup(b), ["Base", "Proto", "Other"]);
    assert!(b.supertypes.iter().all(|s| s.kind == SuperKind::Unknown && !s.delegated));
    assert_eq!(b.supertypes[2].ty.args[0].name, "T");
    assert_eq!(sup(ty(&m, "P")), ["AnyObject", "Q"]);
    assert_eq!(sup(ty(&m, "E")), ["String", "Codable"]);
    assert_eq!(sup(ty(&m, "S")), ["Sendable"]);
}

#[test]
fn extensions() {
    let m = p("extension Foo: Bar, Baz { func a() {} }\nextension Outer.Inner { var x: Int { 1 } }\nextension Array where Element: Equatable {}\nextension Foo<Int> {}");
    let e: Vec<_> = m.types.iter().filter(|t| t.kind == TypeKind::Extension).collect();
    assert_eq!(e[0].name, "Foo");
    assert_eq!(sup(e[0]), ["Bar", "Baz"]);
    assert_eq!(e[0].methods.len(), 1);
    assert_eq!(e[1].name, "Outer.Inner");
    assert_eq!(e[1].fields[0].name, "x");
    assert_eq!(e[2].name, "Array");
    assert_eq!(e[3].name, "Foo");
}

#[test]
fn nested_types() {
    let m = p("struct A {\n  enum B { case x }\n  class C { struct D {} }\n  var v = 1\n}\nstruct E {}");
    assert_eq!(m.types.len(), 5);
    assert_eq!(m.types[0].name, "A");
    assert_eq!(m.types[1].outer, Some(0));
    assert_eq!(m.types[2].outer, Some(0));
    assert_eq!(m.types[3].name, "D");
    assert_eq!(m.types[3].outer, Some(2));
    assert_eq!(m.types[4].outer, None);
    assert_eq!(m.types[0].fields.len(), 1);
    assert_eq!(m.types[0].end_line, 5);
}

#[test]
fn typealias() {
    let m = p("typealias Handler = (Int, String) -> Void\ntypealias Pair<T> = (T, T)\ntypealias Names = [String]");
    let h = ty(&m, "Handler");
    assert_eq!(h.kind, TypeKind::TypeAlias);
    let a = h.aliased.as_ref().unwrap();
    assert_eq!(a.name, "");
    assert_eq!(a.text, "(Int, String) -> Void");
    assert_eq!(ty(&m, "Pair").type_params, ["T"]);
    assert_eq!(ty(&m, "Names").aliased.as_ref().unwrap().name, "Array");
}

#[test]
fn attributes() {
    let m = p("@objc(MyClass) @available(iOS 13, *) public class A {\n @Published var x = 1\n @IBOutlet weak var l: UILabel!\n @objc func f() {}\n}");
    let a = ty(&m, "A");
    assert_eq!(a.annotations, ["objc", "available"]);
    assert_eq!(a.modifiers, ["public"]);
    let l = field(a, "l");
    assert_eq!(l.ty.as_ref().unwrap().name, "UILabel");
    assert!(l.ty.as_ref().unwrap().nullable);
    assert_eq!(a.used_types, ["Published", "IBOutlet"]);
    assert_eq!(a.methods.len(), 1);
}

// ---------- parse: members ----------

#[test]
fn properties() {
    let m = p(r#"
class A {
    var x: Int { get set }
    let y = Foo()
    var z: [String: Foo] = [:]
    private(set) var w: Int = 0
    static let shared = A()
    class var kind: String { "a" }
    lazy var l: Foo = { Foo() }()
    var a, b: Int
    var obs: Int = 0 {
        didSet { print(Bar.x) }
    }
    fileprivate var fp = 1
    open var o = 2
    var computed: some View { Text("a") }
}
"#);
    let a = ty(&m, "A");
    assert_eq!(field(a, "x").ty.as_ref().unwrap().name, "Int");
    assert!(field(a, "x").mutable);
    assert_eq!(field(a, "y").ty.as_ref().unwrap().name, "Foo");
    assert!(!field(a, "y").mutable);
    let z = field(a, "z").ty.as_ref().unwrap();
    assert_eq!((z.name.as_str(), z.args.len()), ("Dictionary", 2));
    assert_eq!(z.text, "[String: Foo]");
    assert_eq!(field(a, "w").visibility, Visibility::Internal);
    assert!(field(a, "shared").is_static);
    assert_eq!(field(a, "shared").ty.as_ref().unwrap().name, "A");
    assert!(field(a, "kind").is_static);
    assert_eq!(field(a, "a").ty.as_ref().unwrap().name, "Int");
    assert_eq!(field(a, "b").ty.as_ref().unwrap().name, "Int");
    assert!(a.fields.iter().any(|f| f.name == "obs"));
    assert_eq!(field(a, "fp").visibility, Visibility::Private);
    assert_eq!(field(a, "o").visibility, Visibility::Public);
    assert_eq!(field(a, "computed").ty.as_ref().unwrap().name, "View");
    assert_eq!(field(a, "computed").ty.as_ref().unwrap().text, "some View");
    assert!(a.used_types.contains(&"Foo".to_string()));
    assert!(a.used_types.contains(&"Bar".to_string()));
    assert!(a.used_types.contains(&"Text".to_string()));
    assert_eq!(a.used_types.iter().filter(|s| *s == "Foo").count(), 1);
    assert_eq!(a.fields.len(), 13);
}

#[test]
fn functions() {
    let m = p(r#"
class A {
    func f(label param: Int, _ other: String = "x", third: Foo? = nil) async throws -> Result<Int, Error> {
        let b = Bar()
    }
    static func make() -> A { A() }
    class func cm() {}
    private func p() {}
    func noret()
    override func over(_ x: Int...) {}
    func gen<T: Equatable>(_ a: T, cb: @escaping (Int) -> Void) -> [T] { [] }
    func (op: Int) {}
}
func global(a: Int) {}
var globalVar = 1
let other: Foo = Foo()
"#);
    let a = ty(&m, "A");
    let f = method(a, "f");
    assert_eq!(f.params.len(), 3);
    assert_eq!(f.params[0].name, "param");
    assert_eq!(f.params[1].name, "other");
    assert_eq!(f.params[1].ty.as_ref().unwrap().name, "String");
    assert_eq!(f.params[2].ty.as_ref().unwrap().name, "Foo");
    assert!(f.params[2].ty.as_ref().unwrap().nullable);
    let r = f.ty.as_ref().unwrap();
    assert_eq!(r.name, "Result");
    assert_eq!(r.args.len(), 2);
    assert_eq!(r.text, "Result<Int, Error>");
    assert!(a.used_types.contains(&"Bar".to_string()));
    assert!(method(a, "make").is_static);
    assert!(method(a, "cm").is_static);
    assert_eq!(method(a, "p").visibility, Visibility::Private);
    assert_eq!(method(a, "noret").ty, None);
    assert!(method(a, "over").params[0].ty.as_ref().unwrap().array);
    let g = method(a, "gen");
    assert_eq!(g.params[1].ty.as_ref().unwrap().name, "");
    assert_eq!(g.params[1].ty.as_ref().unwrap().text, "(Int) -> Void");
    assert_eq!(g.ty.as_ref().unwrap().name, "Array");
    assert_eq!(m.top_level.len(), 3);
    assert_eq!(m.top_level[0].name, "global");
    assert_eq!(m.top_level[1].name, "globalVar");
    assert_eq!(m.top_level[2].ty.as_ref().unwrap().name, "Foo");
}

#[test]
fn operators() {
    let m = p("struct V {\n static func == (l: V, r: V) -> Bool { true }\n static func + (l: V, r: V) -> V { l }\n}");
    let v = ty(&m, "V");
    assert_eq!(v.methods[0].name, "==");
    assert_eq!(v.methods[1].name, "+");
    assert_eq!(v.methods[1].params.len(), 2);
}

#[test]
fn inits_subscripts() {
    let m = p(r#"
class A {
    init() {}
    init?(x: Int) { return nil }
    convenience init(_ s: String) throws { self.init() }
    required init!(coder: Foo) {}
    deinit { Bar.cleanup() }
    subscript(index: Int) -> Element { get { 1 } set { } }
    static subscript(key: String) -> Int { 0 }
}
"#);
    let a = ty(&m, "A");
    let inits: Vec<_> = a.methods.iter().filter(|m| m.kind == MemberKind::Constructor).collect();
    assert_eq!(inits.len(), 4);
    assert!(inits.iter().all(|m| m.name == "init" && m.ty.is_none()));
    assert_eq!(inits[1].params[0].name, "x");
    let subs: Vec<_> = a.methods.iter().filter(|m| m.name == "subscript").collect();
    assert_eq!(subs.len(), 2);
    assert_eq!(subs[0].ty.as_ref().unwrap().name, "Element");
    assert!(subs[1].is_static);
    assert!(a.used_types.contains(&"Bar".to_string()));
    assert!(!a.methods.iter().any(|m| m.name == "deinit"));
}

#[test]
fn enum_cases() {
    let m = p("enum E: Int {\n case a, b(Int), c = 3\n indirect case d(x: E, String)\n case `default`\n func f() {}\n}");
    let e = ty(&m, "E");
    let names: Vec<_> = e.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["a", "b", "c", "d", "default"]);
    assert!(e.fields.iter().all(|f| f.kind == MemberKind::EnumCase));
    assert_eq!(e.fields[1].params[0].ty.as_ref().unwrap().name, "Int");
    assert_eq!(e.fields[3].params[0].name, "x");
    assert_eq!(e.fields[3].params[0].ty.as_ref().unwrap().name, "E");
    assert_eq!(e.methods.len(), 1);
    assert_eq!(e.fields[1].line, 2);
}

#[test]
fn protocols() {
    let m = p("protocol P {\n var x: Int { get set }\n func f() -> String\n static func g()\n init(a: Int)\n associatedtype Item\n subscript(i: Int) -> Int { get }\n}\nextension P { func h() {} }");
    let pr = ty(&m, "P");
    assert!(pr.fields.iter().all(|f| f.is_abstract));
    assert!(pr.methods.iter().all(|f| f.is_abstract));
    assert_eq!(pr.methods.len(), 4);
    let ex = m.types.iter().find(|t| t.kind == TypeKind::Extension).unwrap();
    assert!(!ex.methods[0].is_abstract);
}

#[test]
fn visibility_defaults() {
    let m = p("public protocol P { func f() }\nprivate enum E { case a }\nclass C { func f() {} }\npublic extension C { func g() {} }\nprivate extension C { func h() {} }\nfileprivate class D { var x = 1 }");
    assert_eq!(method(ty(&m, "P"), "f").visibility, Visibility::Public);
    assert_eq!(ty(&m, "E").fields[0].visibility, Visibility::Private);
    assert_eq!(method(ty(&m, "C"), "f").visibility, Visibility::Internal);
    let exts: Vec<_> = m.types.iter().filter(|t| t.kind == TypeKind::Extension).collect();
    assert_eq!(exts[0].methods[0].visibility, Visibility::Public);
    assert_eq!(exts[1].methods[0].visibility, Visibility::Private);
    assert_eq!(field(ty(&m, "D"), "x").visibility, Visibility::Private);
}

#[test]
fn type_refs() {
    let m = p(r#"
struct S {
    var a: [Foo]
    var b: Foo?
    var c: Foo!
    var d: Foo.Bar
    var e: any P
    var f: (Int, String)
    var g: (Int) -> Foo
    var h: [Foo]?
    var i: Dictionary<String, [Int]>
    var j: A & B
    var k: (a: Int, b: String)?
    var l: Outer.Inner<Int>.Deep
    var m: Foo.Type
    var n: ((Int) -> Void)?
    var o: Array<Foo>
}
"#);
    let s = ty(&m, "S");
    let t = |n: &str| field(s, n).ty.clone().unwrap();
    assert_eq!((t("a").name.as_str(), t("a").args[0].name.as_str()), ("Array", "Foo"));
    assert!(t("b").nullable && t("b").name == "Foo");
    assert!(t("c").nullable);
    assert_eq!(t("d").name, "Foo.Bar");
    assert_eq!(t("e").name, "P");
    assert_eq!(t("e").text, "any P");
    assert_eq!(t("f").name, "");
    assert_eq!(t("f").args.len(), 2);
    assert_eq!(t("g").name, "");
    assert_eq!(t("g").text, "(Int) -> Foo");
    assert!(t("g").args.iter().any(|a| a.name == "Foo"));
    assert!(t("h").nullable && t("h").name == "Array");
    assert_eq!(t("i").name, "Dictionary");
    assert_eq!(t("i").args[1].name, "Array");
    assert_eq!(t("j").name, "");
    assert_eq!(t("j").args.len(), 2);
    assert_eq!(t("k").args.len(), 2);
    assert!(t("k").nullable);
    assert_eq!(t("l").name, "Outer.Inner.Deep");
    assert_eq!(t("m").name, "Foo");
    assert!(t("n").nullable);
    assert_eq!(t("o").args[0].name, "Foo");
}

#[test]
fn used_types_rules() {
    let m = p(r#"
class A<T> {
    var x: Int = Foo.default
    var y = Bar<Int>.make()
    func f(a: Int = Baz.zero) -> Sig {
        let q: Local = Local()
        if x is Cast { }
        let t: T? = nil
        print(self.Lower, .Member, Outer.Inner.make(), String(describing: x), Self.self)
    }
    struct Nested { func g() { Hidden() } }
    @StateObject var vm = VM()
}
"#);
    let a = ty(&m, "A");
    for n in ["Foo", "Bar", "Baz", "Local", "Cast", "Outer.Inner", "String", "StateObject", "VM"] {
        assert!(a.used_types.contains(&n.to_string()), "missing {n}: {:?}", a.used_types);
    }
    for n in ["Sig", "T", "Hidden", "Self", "Lower", "Member"] {
        assert!(!a.used_types.contains(&n.to_string()), "unexpected {n}: {:?}", a.used_types);
    }
    assert_eq!(ty(&m, "Nested").used_types, ["Hidden"]);
}

#[test]
fn multi_line_initializers() {
    let m = p("struct S {\n var a = Foo()\n    .bar()\n    .baz\n var b = 1 +\n   2\n var c: Int\n let d = [\n  Item(),\n ]\n func f() {}\n}");
    let s = ty(&m, "S");
    let names: Vec<_> = s.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["a", "b", "c", "d"]);
    assert_eq!(s.methods.len(), 1);
    assert!(s.used_types.contains(&"Item".to_string()));
}

#[test]
fn swiftui_view() {
    let m = p(r#"
import SwiftUI

struct ContentView: View {
    @State private var count = 0
    @Binding var name: String
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack {
            Text("Hello \(name)")
            Button("Go") { count += 1 }
        }
    }
}

#Preview {
    ContentView()
}
"#);
    let c = ty(&m, "ContentView");
    assert_eq!(sup(c), ["View"]);
    assert_eq!(c.fields.len(), 4);
    assert_eq!(field(c, "count").visibility, Visibility::Private);
    assert!(field(c, "count").mutable);
    assert!(c.used_types.contains(&"VStack".to_string()));
    assert!(c.used_types.contains(&"State".to_string()));
    assert_eq!(m.types.len(), 1);
}

// ---------- robustness ----------

#[test]
fn strings_and_comments_do_not_confuse_the_parser() {
    let m = p(r##"
// class Fake {}
/* nested /* class Fake2 {} */ still comment */
class Real {
    let s = "class Fake3 { \(foo + "}") }"
    let r = #"raw "quoted" \#(x) } "#
    let t = """
        multi } {
        \(Interp.value)
        """
    func after() {}
}
"##);
    assert_eq!(m.types.len(), 1);
    let r = ty(&m, "Real");
    assert_eq!(r.fields.len(), 3);
    assert_eq!(r.methods.len(), 1);
    assert!(r.used_types.contains(&"Interp".to_string()));
    assert_eq!(r.end_line, 12);
}

#[test]
fn if_branches_are_both_code() {
    let m = p("#if os(iOS)\nimport UIKit\nclass A {}\n#else\nimport AppKit\nclass B {}\n#endif\nclass C {\n#if DEBUG\n var d = 1\n#endif\n var e = 2\n}\n");
    assert_eq!(m.imports.len(), 2);
    assert_eq!(m.types.len(), 3);
    assert_eq!(ty(&m, "C").fields.len(), 2);
}

#[test]
fn broken_input_never_panics() {
    let samples = [
        "",
        "class",
        "class A",
        "class A {",
        "class A { func f( {",
        "class A { var x: [Foo",
        "struct S<T: { }",
        "enum E { case a(",
        "\"unclosed",
        "\"\"\" never closed",
        "#\"raw never closed",
        "/* never closed",
        "let a = \"\\(",
        "let a = \"\\(foo(\"",
        "extension",
        "extension : {",
        "func",
        "func <",
        "@",
        "@objc(",
        "import",
        "import struct",
        "typealias A =",
        "class A: {}",
        "class A: B, {}",
        "}}}}",
        "((((((",
        "\u{feff}class A {}",
        "let r = /abc",
        "let r = #/abc",
        "protocol P { var x: }",
        "class A { var a: (Int, ",
        "class A { subscript( }",
        "let x = [Foo: ",
        "日本語 class A { var 名前: Int }",
    ];
    for s in samples {
        let _ = p(s);
        let _ = find_identifiers(Lang::Swift, s, "A");
        let _ = find_identifiers(Lang::Swift, s, "Foo");
    }
    let m = p("日本語\nclass A { var 名前: Int }");
    assert!(m.types.iter().any(|t| t.name == "A"));
}

#[test]
fn deep_nesting_does_not_overflow() {
    let mut s = String::new();
    for _ in 0..5000 {
        s.push_str("class A { ");
    }
    let _ = p(&s);
    let mut s = String::from("var x: ");
    for _ in 0..5000 {
        s.push('[');
    }
    let _ = p(&s);
    let mut s = String::from("var x: ");
    for _ in 0..5000 {
        s.push('(');
    }
    let _ = p(&s);
    let _ = find_identifiers(Lang::Swift, &s, "x");
    let s = "(".repeat(100_000);
    let _ = p(&s);
    let _ = find_identifiers(Lang::Swift, &s, "x");
}

#[test]
fn regex_literals() {
    let m = p("class A {\n let r = /ab+c\\/}/\n let s = #/x{/#\n func f() { let q = 4 / 2 / 1 }\n}\nclass B {}");
    assert_eq!(m.types.len(), 2);
    assert_eq!(ty(&m, "A").fields.len(), 2);
    assert_eq!(ty(&m, "A").methods.len(), 1);
}

#[test]
fn crlf_and_columns() {
    let m = p("class A {\r\n    var x = 1\r\n    func f() {}\r\n}\r\n");
    let a = ty(&m, "A");
    assert_eq!(field(a, "x").line, 2);
    assert_eq!(method(a, "f").line, 3);
    assert_eq!(a.end_line, 4);
    // Non-ASCII text before a name: columns count bytes.
    let m = p("let é = 1; var x = 2");
    assert_eq!(m.top_level[1].column, 17);
}

#[test]
fn large_file_is_fast_enough() {
    let mut s = String::new();
    for i in 0..60_000 {
        s.push_str(&format!("class C{i}: Base {{\n    var a: Int = {i}\n    func f(x: Int) -> String {{ return \"v \\(x)\" }}\n}}\n"));
    }
    assert!(s.len() > 3_000_000);
    let m = p(&s);
    assert_eq!(m.types.len(), 60_000);
}

// ---------- find_identifiers ----------

#[test]
fn ids_skip_comments_and_strings() {
    let src = r##"
// Foo in comment
/* Foo /* Foo */ Foo */
let a = "Foo"
let b = "x \(Foo.shared) y"
let c = #"Foo \#(Foo) \(Foo)"#
let d = """
  Foo
  \(Foo)
  """
let e = Foo
let f = `Foo`
"##;
    let hits = find_identifiers(Lang::Swift, src, "Foo");
    // b interpolation, c raw interpolation, d interpolation, e, f
    assert_eq!(hits.len(), 5, "{hits:?}");
    for h in &hits {
        assert_eq!(&src[h.start..h.end], "Foo");
    }
}

#[test]
fn ids_kinds() {
    let src = r#"
import Foo
import struct Mod.Foo
class Foo: Base, Foo {}
extension Foo: Foo {}
struct S {
    var a: Foo
    var b: [Foo]
    var c: Dictionary<String, Foo>
    func f(x: Foo) -> Foo { Foo.shared; Foo(); x as? Foo; x is Foo; Foo.self; foo(Foo.bar) }
    func g() { let v = Foo; let [Foo]() ; Foo { } }
}
"#;
    let k = kinds(src, "Foo");
    assert_eq!(
        k,
        vec![
            Import, Import, Declaration, Supertype, Type, Supertype, Type, Type, Type, Type, Type, Reference, Call,
            Type, Type, Type, Reference, Reference, Type, Call
        ]
    );
}

#[test]
fn ids_declarations() {
    let src = "func foo(label foo: Int, foo2: Int) { let foo = 1; var (a, foo) = (1, 2); for foo in list {}; if let foo = foo { foo() } }\nenum E { case foo, bar(foo: Int), baz }\ntypealias foo = Int\nprotocol foo {}";
    let k = ids(src, "foo");
    let kk: Vec<_> = k.iter().map(|x| x.0).collect();
    assert_eq!(
        kk,
        vec![Declaration, Declaration, Declaration, Declaration, Declaration, Declaration, Reference, Call, Declaration, Declaration, Declaration, Declaration]
    );
}

#[test]
fn ids_qualifiers() {
    let src = "self.x = vm.load()\nFoo.shared.x\nlet y = a.b.c.x\nfoo().x\n.x\nvm?.x\nfoo[0].x\na ... x\nx";
    let q: Vec<_> = ids(src, "x").into_iter().map(|h| h.1).collect();
    assert_eq!(q, ["self", "Foo.shared", "a.b.c", "", "", "vm", "", "", ""]);
    let q: Vec<_> = ids(src, "load").into_iter().map(|h| (h.0, h.1)).collect();
    assert_eq!(q, [(Call, "vm".to_string())]);
    let q: Vec<_> = ids(src, "shared").into_iter().map(|h| h.1).collect();
    assert_eq!(q, ["Foo"]);
}

#[test]
fn ids_implicit_members_and_closures() {
    let src = "let a: Foo = .make()\nlet b = Foo.make { }\nview.set { }\nif foo {\n}\nswitch foo {\ncase .a: break\n}\nfoo {\n}\nguard let x = foo else { return }";
    let k = ids(src, "make");
    assert_eq!(k, vec![(Call, String::new()), (Call, "Foo".to_string())]);
    let k = kinds(src, "foo");
    assert_eq!(k, vec![Reference, Reference, Call, Reference]);
    assert_eq!(kinds(src, "set"), vec![Call]);
}

#[test]
fn ids_attributes_and_generics() {
    let src = "@Foo var x = 1\n@Foo(1) var y = 2\nlet z = Foo<Int>()\nlet w = Array<Foo>()\nfunc f<T: Foo>(a: T) where T: Foo {}\nlet q = [Foo]()\nlet r = Foo.Type.self";
    let k = kinds(src, "Foo");
    assert_eq!(k, vec![Type, Type, Call, Type, Type, Type, Type, Type]);
}

#[test]
fn ids_backticks() {
    let src = "let `class` = 1\nprint(`class`)\nlet class2 = `class`";
    let h = find_identifiers(Lang::Swift, src, "class");
    assert_eq!(h.len(), 3);
    assert_eq!(&src[h[0].start..h[0].end], "class");
    assert_eq!(h[0].kind, Declaration);
}

#[test]
fn ids_empty_and_unknown() {
    assert!(find_identifiers(Lang::Swift, "let a = 1", "").is_empty());
    assert!(find_identifiers(Lang::Swift, "let a = 1", "zzz").is_empty());
    assert_eq!(kinds("let a = 1", "a"), vec![Declaration]);
}

#[test]
fn ids_enum_case_patterns() {
    let src = "enum E { case a, b\n case c(Int) }\nswitch x { case a: break\n case .b: break }";
    assert_eq!(kinds(src, "a"), vec![Declaration, Reference]);
    assert_eq!(kinds(src, "c"), vec![Declaration]);
}

#[test]
fn ids_in_multiline_interpolation() {
    let src = "let s = \"a \\(foo(\"inner \\(Bar)\")) b\"\nlet t = Bar()";
    assert_eq!(kinds(src, "Bar"), vec![Reference, Call]);
    assert_eq!(kinds(src, "foo"), vec![Call]);
}

#[test]
fn swift6_nonisolated_conformance_and_generic_initializers() {
    let m = p("final class VM: nonisolated ObservableObject {\n private let s = CurrentValueSubject<[Entity], Never>([])\n private var c = Set<AnyCancellable>()\n var n = 1\n}");
    let v = ty(&m, "VM");
    assert_eq!(sup(v), ["ObservableObject"]);
    let names: Vec<_> = v.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["s", "c", "n"]);
    let c = field(v, "c").ty.as_ref().unwrap();
    assert_eq!(c.name, "Set");
    assert_eq!(c.args[0].name, "AnyCancellable");
    assert_eq!(field(v, "s").ty.as_ref().unwrap().args.len(), 2);
}

#[test]
fn every_prefix_of_a_sample_is_safe() {
    let sample = r##"import UIKit
@MainActor
public final class Vc<T: Equatable>: UIViewController, Delegate where T: Hashable {
    @Published private(set) var items: [String: [Int]] = [:]
    let s = #"raw \#(x)"# + "a \(b("c \(d)")) e" + """
        multi
        """
    func f(_ a: Int = 1, b: (Int) -> Void) async throws -> Result<Int, Error> {
        if case .a(let x) = y, let z = w as? Foo { /* c /* n */ */ }
        let r = /a[/]b/; return 日本語
    }
    enum E: Int { case a = 1, b(Int), c }
    subscript(i: Int) -> Int { get { 1 } set { } }
}
extension Vc: P { var x: some View { Text("a") } }
"##;
    let mut ends: Vec<usize> = sample.char_indices().map(|(i, _)| i).collect();
    ends.push(sample.len());
    for e in ends {
        let part = &sample[..e];
        let _ = p(part);
        let _ = find_identifiers(Lang::Swift, part, "x");
        let _ = find_identifiers(Lang::Swift, part, "Foo");
    }
    let full = p(sample);
    assert_eq!(full.types.len(), 3);
}

// ---------- Member::end_line ----------

fn ends(text: &str, ty_name: &str) -> Vec<(String, u32, u32)> {
    let m = p(text);
    let t = ty(&m, ty_name);
    let mut v: Vec<_> = t.fields.iter().chain(&t.methods).map(|x| (x.name.clone(), x.line, x.end_line)).collect();
    v.sort_by_key(|x| x.1);
    v
}

#[test]
fn member_end_lines() {
    let src = "class A {\n    var a = 1\n    var b: Int\n    @Published\n    var c: Int {\n        get {\n            1\n        }\n        set { }\n    }\n    let d: Foo = {\n        let f = Foo()\n        return f\n    }()\n    func f(\n        x: Int\n    ) -> Int {\n        let s = \"\"\"\n        a\n        \"\"\"\n        #if DEBUG\n        print(1)\n        #endif\n        class Local {\n        }\n        return 1\n    }\n    init() {\n    }\n    subscript(i: Int) -> Int {\n        0\n    }\n    var o: Int = 0 {\n        didSet {\n        }\n    }\n    let arr = [\n        1,\n        2,\n    ]\n    struct N {\n        func g() {\n        }\n    }\n    func h()\n}\n";
    let e: std::collections::HashMap<_, _> = ends(src, "A").into_iter().map(|(n, l, e)| (n, (l, e))).collect();
    assert_eq!(e["a"], (2, 2));
    assert_eq!(e["b"], (3, 3));
    assert_eq!(e["c"].1, 10);
    assert_eq!(e["d"], (11, 14));
    assert_eq!(e["f"], (15, 27));
    assert_eq!(e["init"], (28, 29));
    assert_eq!(e["subscript"], (30, 32));
    assert_eq!(e["o"], (33, 36));
    assert_eq!(e["arr"], (37, 40));
    assert_eq!(e["h"], (45, 45));
    let m = p(src);
    assert_eq!(ty(&m, "N").methods[0].end_line, 43);
}

#[test]
fn enum_and_protocol_end_lines() {
    let src = "enum E {\n    case a, b\n    case c(\n        Int,\n        String\n    )\n    case d = 3\n}\nprotocol P {\n    var x: Int { get set }\n    func f()\n}\nfunc g() {\n}\nlet t = 1\n";
    let m = p(src);
    let e = ty(&m, "E");
    let v: Vec<_> = e.fields.iter().map(|f| (f.name.as_str(), f.line, f.end_line)).collect();
    assert_eq!(v, [("a", 2, 2), ("b", 2, 2), ("c", 3, 6), ("d", 7, 7)]);
    let pr = ty(&m, "P");
    assert_eq!(pr.fields[0].end_line, 10);
    assert_eq!(pr.methods[0].end_line, 11);
    assert_eq!((m.top_level[0].line, m.top_level[0].end_line), (13, 14));
    assert_eq!(m.top_level[1].end_line, 15);
}

#[test]
fn unclosed_body_end_lines() {
    let m = p("class A {\n    func f() {\n        let x = 1\n    var y = 2\n");
    let a = ty(&m, "A");
    assert!(a.methods[0].end_line >= a.methods[0].line);
    assert_ne!(a.methods[0].end_line, 0);
    let m = p("class A {\n    var x = Foo(\n");
    assert_eq!(ty(&m, "A").fields[0].end_line, 2);
    let m = p("class A {\n    func f(\n");
    assert_eq!(ty(&m, "A").methods[0].end_line, 2);
}

// ---------- regions ----------

fn regs(text: &str) -> Vec<(RegionKind, String)> {
    let r = regions(Lang::Swift, text);
    let mut last = 0;
    for x in &r {
        assert!(x.start >= last && x.end > x.start && x.end <= text.len(), "{r:?}");
        last = x.end;
    }
    r.iter().map(|x| (x.kind, text[x.start..x.end].to_string())).collect()
}

#[test]
fn regions_comments() {
    use RegionKind::*;
    let r = regs("a // x\nb /* y /* z */ w */ c /// doc\n/** d */");
    assert_eq!(
        r,
        vec![
            (Comment, "// x".into()),
            (Comment, "/* y /* z */ w */".into()),
            (Comment, "/// doc".into()),
            (Comment, "/** d */".into())
        ]
    );
    assert_eq!(regs("x /* never"), vec![(Comment, "/* never".into())]);
}

#[test]
fn regions_strings() {
    use RegionKind::*;
    assert_eq!(regs("let a = \"x\\\"y\" + b"), vec![(String, "\"x\\\"y\"".into())]);
    assert_eq!(regs("let a = \"\"\"\n  a \"q\" // not\n  \"\"\""), vec![(String, "\"\"\"\n  a \"q\" // not\n  \"\"\"".into())]);
    assert_eq!(regs("#\"a \"b\" \\n\"#"), vec![(String, "#\"a \"b\" \\n\"#".into())]);
    assert_eq!(regs("##\"a\"#b\"##"), vec![(String, "##\"a\"#b\"##".into())]);
    assert_eq!(regs("let r = /a+b/"), vec![(String, "/a+b/".into())]);
    assert_eq!(regs("let a = \"open"), vec![(String, "\"open".into())]);
    assert_eq!(regs("let a = \"\"\"\nopen"), vec![(String, "\"\"\"\nopen".into())]);
}

#[test]
fn regions_interpolation() {
    use RegionKind::*;
    let r = regs("\"a \\(b + \"c\") d\" // e");
    assert_eq!(
        r,
        vec![
            (String, "\"a ".into()),
            (String, "\"c\"".into()),
            (String, " d\"".into()),
            (Comment, "// e".into())
        ]
    );
    let r = regs("#\"a \\#(x /* c */) \\(y)\"#");
    assert_eq!(r, vec![(String, "#\"a ".into()), (Comment, "/* c */".into()), (String, " \\(y)\"#".into())]);
}
