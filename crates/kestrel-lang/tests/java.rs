//! Java parser tests with small hand-written snippets.

use kestrel_lang::{find_identifiers, parse, FileModel, Lang, MemberKind, SuperKind, TypeKind, UsageKind, Visibility};
use UsageKind::*;

fn p(src: &str) -> FileModel {
    parse(Lang::Java, src)
}

fn hits(src: &str, name: &str) -> Vec<(UsageKind, String)> {
    find_identifiers(Lang::Java, src, name).into_iter().map(|h| (h.kind, h.qualifier)).collect()
}

fn k(kind: UsageKind) -> (UsageKind, String) {
    (kind, String::new())
}

fn kq(kind: UsageKind, q: &str) -> (UsageKind, String) {
    (kind, q.to_string())
}

#[test]
fn package_and_imports() {
    let m = p("package a.b.c;\n\nimport x.y.Foo;\nimport x.z.*;\nimport static x.w.Bar.baz;\nimport static x.w.Bar.*;\n");
    assert_eq!(m.package, "a.b.c");
    assert_eq!(m.imports.len(), 4);
    assert_eq!(m.imports[0].path, "x.y.Foo");
    assert_eq!(m.imports[0].line, 3);
    assert!(!m.imports[0].is_static);
    assert_eq!(m.imports[1].path, "x.z");
    assert!(m.imports[1].wildcard);
    assert_eq!(m.imports[2].path, "x.w.Bar.baz");
    assert!(m.imports[2].is_static);
    assert_eq!(m.imports[3].path, "x.w.Bar");
    assert!(m.imports[3].is_static && m.imports[3].wildcard);
}

#[test]
fn class_kinds() {
    let m = p("class A {}\ninterface B {}\nenum C { X }\nrecord D(int x) {}\n@interface E {}\npublic abstract class F {}\nfinal class G {}\nsealed interface H permits I {}\nnon-sealed class I implements H {}\n");
    let kinds: Vec<_> = m.types.iter().map(|t| t.kind).collect();
    assert_eq!(
        kinds,
        vec![
            TypeKind::Class,
            TypeKind::Interface,
            TypeKind::Enum,
            TypeKind::Record,
            TypeKind::Annotation,
            TypeKind::Class,
            TypeKind::Class,
            TypeKind::Interface,
            TypeKind::Class
        ]
    );
    assert_eq!(m.types[5].modifiers, vec!["public", "abstract"]);
    assert_eq!(m.types[7].modifiers, vec!["sealed"]);
    assert_eq!(m.types[8].modifiers, vec!["non-sealed"]);
    assert!(m.types[7].supertypes.is_empty());
}

#[test]
fn positions() {
    let m = p("package a;\n\n@Foo\n@Bar(1)\npublic class Name {\n    void f() {}\n}\n\nclass Short {}\n");
    let t = &m.types[0];
    assert_eq!((t.line, t.column), (5, 14));
    assert_eq!(t.start_line, 3);
    assert_eq!(t.end_line, 7);
    assert_eq!(m.types[1].start_line, 9);
    assert_eq!((t.methods[0].line, t.methods[0].column), (6, 10));
}

#[test]
fn annotations_names_only() {
    let m = p("@Entity @Table(name = \"t\", x = {1, 2}) @a.b.Full\nclass A {}");
    assert_eq!(m.types[0].annotations, vec!["Entity", "Table", "Full"]);
}

#[test]
fn type_params_and_supertypes() {
    let m = p("class Box<T extends Comparable<T> & Serializable, R> extends Base<T> implements I1, I2<R> {}\ninterface Foo<A> extends I1, I2<A> {}");
    let a = &m.types[0];
    assert_eq!(a.type_params, vec!["T", "R"]);
    assert_eq!(a.supertypes.len(), 3);
    assert_eq!(a.supertypes[0].kind, SuperKind::Extends);
    assert_eq!(a.supertypes[0].ty.name, "Base");
    assert_eq!(a.supertypes[0].ty.args[0].name, "T");
    assert_eq!(a.supertypes[1].kind, SuperKind::Implements);
    assert_eq!(a.supertypes[2].ty.text, "I2<R>");
    let b = &m.types[1];
    assert!(b.supertypes.iter().all(|s| s.kind == SuperKind::Implements));
    assert_eq!(b.supertypes.len(), 2);
}

#[test]
fn fields() {
    let m = p("class A {\n private static final int MAX = 10;\n protected List<Map<String, Foo>> items = new ArrayList<>(), more = null;\n int a, b[];\n public String name;\n volatile boolean flag;\n}");
    let f = &m.types[0].fields;
    assert_eq!(f.len(), 7);
    assert_eq!((f[0].visibility, f[0].is_static, f[0].mutable), (Visibility::Private, true, false));
    assert_eq!(f[1].name, "items");
    assert_eq!(f[1].visibility, Visibility::Protected);
    assert_eq!(f[1].ty.as_ref().unwrap().text, "List<Map<String, Foo>>");
    assert_eq!(f[2].name, "more");
    assert_eq!(f[2].ty.as_ref().unwrap().name, "List");
    assert_eq!(f[3].visibility, Visibility::Package);
    assert!(f[3].mutable);
    assert!(f[4].ty.as_ref().unwrap().array);
    assert_eq!(f[4].ty.as_ref().unwrap().name, "int");
    assert_eq!(f[5].visibility, Visibility::Public);
    assert!(f[6].mutable);
}

#[test]
fn arrays_and_varargs() {
    let m = p("class A {\n int[] a;\n String b[];\n int[][] c;\n void f(int[] x, String y[], Foo... rest) {}\n}");
    let t = &m.types[0];
    assert!(t.fields[0].ty.as_ref().unwrap().array);
    assert!(t.fields[1].ty.as_ref().unwrap().array);
    assert!(t.fields[2].ty.as_ref().unwrap().array);
    let ps = &t.methods[0].params;
    assert_eq!(ps.len(), 3);
    assert!(ps[0].ty.as_ref().unwrap().array);
    assert!(ps[1].ty.as_ref().unwrap().array);
    assert!(ps[2].ty.as_ref().unwrap().array);
    assert_eq!(ps[2].ty.as_ref().unwrap().name, "Foo");
}

#[test]
fn methods_and_constructors() {
    let m = p("class A {\n A() { super(); }\n protected A(int x, final String s) throws IOException {}\n public <T> T gen(Class<T> c) { return null; }\n static void s() {}\n abstract int abs();\n public final synchronized void sync() {}\n @Override public String toString() { return \"\"; }\n}");
    let ms = &m.types[0].methods;
    assert_eq!(ms.len(), 7);
    assert_eq!(ms[0].kind, MemberKind::Constructor);
    assert_eq!(ms[0].name, "A");
    assert_eq!(ms[0].visibility, Visibility::Package);
    assert_eq!(ms[1].visibility, Visibility::Protected);
    assert_eq!(ms[1].params.len(), 2);
    assert_eq!(ms[1].params[1].ty.as_ref().unwrap().name, "String");
    assert_eq!(ms[2].name, "gen");
    assert_eq!(ms[2].ty.as_ref().unwrap().name, "T");
    assert!(ms[3].is_static);
    assert!(ms[4].is_abstract);
    assert!(!ms[5].is_abstract);
    assert_eq!(ms[6].name, "toString");
}

#[test]
fn interface_members() {
    let m = p("interface I {\n void a();\n default void b() {}\n static void c() {}\n private void d() {}\n int K = 1;\n}");
    let t = &m.types[0];
    let ms = &t.methods;
    assert_eq!((ms[0].visibility, ms[0].is_abstract), (Visibility::Public, true));
    assert_eq!((ms[1].visibility, ms[1].is_abstract), (Visibility::Public, false));
    assert_eq!((ms[2].visibility, ms[2].is_static), (Visibility::Public, true));
    assert_eq!(ms[3].visibility, Visibility::Private);
    assert_eq!((t.fields[0].visibility, t.fields[0].is_static, t.fields[0].mutable), (Visibility::Public, true, false));
}

#[test]
fn nested_and_static_nested_classes() {
    let m = p("class A {\n static class B {\n  class C {}\n }\n interface D {}\n enum E { X }\n}\nclass F {}");
    let o: Vec<_> = m.types.iter().map(|t| (t.name.as_str(), t.outer)).collect();
    assert_eq!(o, vec![("A", None), ("B", Some(0)), ("C", Some(1)), ("D", Some(0)), ("E", Some(0)), ("F", None)]);
    assert_eq!(m.types[1].modifiers, vec!["static"]);
}

#[test]
fn enum_constants_with_bodies_and_arguments() {
    let m = p("enum Kind implements I {\n A,\n B(2) { void f() { Foo.go(); } },\n @Deprecated C(3, \"x\");\n private final int v;\n Kind() {}\n Kind(int v) { this.v = v; }\n void g() {}\n}\nenum Plain { X, Y, Z }\nenum Empty { ; void h() {} }");
    let t = &m.types[0];
    let cases: Vec<_> = t.fields.iter().filter(|f| f.kind == MemberKind::EnumCase).map(|f| f.name.as_str()).collect();
    assert_eq!(cases, vec!["A", "B", "C"]);
    assert_eq!(t.fields.iter().filter(|f| f.kind == MemberKind::Field).count(), 1);
    assert_eq!(t.methods.len(), 3);
    assert_eq!(m.types.len(), 3);
    assert!(t.used_types.contains(&"Foo".to_string()));
    assert_eq!(t.supertypes[0].ty.name, "I");
    assert_eq!(m.types[1].fields.len(), 3);
    assert_eq!(m.types[2].methods.len(), 1);
}

#[test]
fn records() {
    let m = p("public record Point(int x, List<Foo> ys, @NotNull String... rest) implements Shape {\n Point { }\n static Point origin() { return new Point(0, null); }\n}");
    let t = &m.types[0];
    assert_eq!(t.kind, TypeKind::Record);
    let names: Vec<_> = t.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, vec!["x", "ys", "rest"]);
    assert_eq!(t.fields[1].ty.as_ref().unwrap().args[0].name, "Foo");
    assert!(t.fields[2].ty.as_ref().unwrap().array);
    assert_eq!(t.supertypes[0].kind, SuperKind::Implements);
    assert!(t.methods.iter().any(|m| m.name == "origin" && m.is_static));
}

#[test]
fn annotation_declaration() {
    let m = p("@Retention(RetentionPolicy.RUNTIME)\n@interface Ann {\n String value() default \"x\";\n int[] nums() default {1, 2};\n}\nclass After {}");
    assert_eq!(m.types[0].kind, TypeKind::Annotation);
    assert_eq!(m.types[0].name, "Ann");
    assert_eq!(m.types[0].methods.len(), 2);
    assert_eq!(m.types[1].name, "After");
}

#[test]
fn used_types_in_bodies() {
    let src = "class A {\n void f() {\n  Foo foo = new Foo();\n  var bar = (Bar) obj;\n  Runnable r = new Runnable() { public void run() { Helper.go(); } };\n  for (Entry<String, Baz> e : map.entrySet()) {}\n  if (o instanceof Qux) {}\n  Class<?> c = Cls.class;\n  list.stream().map(Mapper::new).collect(Collectors.toList());\n  System.out.println(Consts.MAX_SIZE);\n  x = a.b.Deep.go();\n }\n}";
    let m = p(src);
    assert_eq!(m.types.len(), 1);
    assert_eq!(
        m.types[0].used_types,
        vec!["Foo", "Bar", "Runnable", "Helper", "Entry", "String", "Baz", "Qux", "Class", "Cls", "Mapper", "Collectors", "System", "Consts", "a.b.Deep"]
    );
}

#[test]
fn used_types_not_from_signatures() {
    let m = p("class A extends P implements Q {\n private Field f = make();\n Ret g(Param p) throws Oops { return body(); }\n}");
    assert!(m.types[0].used_types.is_empty(), "{:?}", m.types[0].used_types);
}

#[test]
fn used_types_not_from_nested_types() {
    let m = p("class A {\n Object a = new One();\n static class B {\n  Object b = new Two();\n }\n void f() { new Three(); }\n}");
    assert_eq!(m.types[0].used_types, vec!["One", "Three"]);
    assert_eq!(m.types[1].used_types, vec!["Two"]);
}

#[test]
fn anonymous_classes_are_not_types() {
    let m = p("class A {\n Object o = new Foo() { int x; void f() {} };\n void g() { class Local {} new Bar<>() {}; }\n}");
    assert_eq!(m.types.len(), 1);
    assert!(m.types[0].used_types.contains(&"Foo".to_string()));
    assert!(m.types[0].used_types.contains(&"Bar".to_string()));
}

#[test]
fn lambdas_and_generics_do_not_confuse() {
    let m = p("class A {\n Function<Integer, Integer> f = x -> x + 1;\n BiFunction<A, B, C> g = (a, b) -> { return new C(a, b); };\n int h(int a, int b) { return a < b ? a : b; }\n boolean i(int a, int b) { return a < b && b > a; }\n void j() {}\n}");
    let t = &m.types[0];
    assert_eq!(t.fields.len(), 2);
    assert_eq!(t.methods.len(), 3);
    assert_eq!(t.methods[2].name, "j");
}

#[test]
fn text_blocks_and_strings() {
    let src = "class A {\n String t = \"\"\"\n   class Fake { }\n   \"quoted\" \\\"\"\" more\n   \"\"\";\n String u = \"class Fake2 {\";\n char c = '\\'';\n char d = '\"';\n}\nclass After {}";
    let m = p(src);
    assert_eq!(m.types.len(), 2);
    assert_eq!(m.types[0].fields.len(), 4);
    assert_eq!(m.types[1].name, "After");
}

#[test]
fn comments_do_not_make_declarations() {
    let m = p("/* class Fake1 {} */\n// class Fake2 {}\n/** class Fake3 */\nclass Real {}");
    assert_eq!(m.types.len(), 1);
    assert_eq!(m.types[0].name, "Real");
}

#[test]
fn initializer_blocks_and_stray_semicolons() {
    let m = p("class A {\n static { init(); }\n { x = 1; }\n ;\n int f;\n}");
    assert_eq!(m.types[0].fields.len(), 1);
}

#[test]
fn generic_field_initializer_with_commas() {
    let m = p("class A {\n Map<String, List<Foo>> a = new HashMap<String, List<Foo>>(), b = new HashMap<>();\n int c = f(1, 2), d = 3;\n}");
    let f: Vec<_> = m.types[0].fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(f, vec!["a", "b", "c", "d"]);
}

#[test]
fn broken_code_gives_partial_results() {
    for src in [
        "class A {",
        "class A { void f(",
        "class A { int x = ",
        "class A { String s = \"unclosed",
        "/* unclosed",
        "class A { void f() { if (x) { } ",
        "import",
        "package",
        "class",
        "class A extends",
        "@",
        "@Foo(",
        "enum E { A(1",
        "class A<T extends",
        "record R(",
        "}}}}",
        "class A { class B { class C {",
        "class A { String t = \"\"\"abc",
        "\u{feff}class Bom {}",
    ] {
        let m = p(src);
        let _ = find_identifiers(Lang::Java, src, "A");
        if src.starts_with('\u{feff}') {
            assert_eq!(m.types[0].name, "Bom");
        }
    }
}

#[test]
fn non_ascii_text_is_safe() {
    let src = "// \u{65e5}\u{672c}\u{8a9e}\nclass \u{30af}\u{30e9}\u{30b9} { String s = \"\u{1f600}\u{1f600}\"; void \u{3042}() { char c = '\u{3042}'; } }\nclass B {}";
    let m = p(src);
    assert_eq!(m.types.len(), 2);
    let h = find_identifiers(Lang::Java, src, "B");
    assert_eq!(h.len(), 1);
    assert_eq!(&src[h[0].start..h[0].end], "B");
}

#[test]
fn crlf_lines() {
    let m = p("package a;\r\n\r\nclass A {\r\n  void f() {}\r\n}\r\n");
    assert_eq!(m.types[0].line, 3);
    assert_eq!(m.types[0].end_line, 5);
    assert_eq!(m.types[0].methods[0].line, 4);
}

#[test]
fn empty_input() {
    assert_eq!(p(""), FileModel::default());
    assert!(find_identifiers(Lang::Java, "", "A").is_empty());
}

// ---- find_identifiers

#[test]
fn ident_ignores_comments_and_strings() {
    let src = "// Foo\n/* Foo */\nclass A { String s = \"Foo\"; String t = \"\"\"\nFoo\n\"\"\"; char c = 'F'; Object x = Foo; }\n";
    let h = find_identifiers(Lang::Java, src, "Foo");
    assert_eq!(h.len(), 1);
    assert!(src[..h[0].start].ends_with("Object x = "));
}

#[test]
fn ident_kinds() {
    let src = "import a.b.Foo;\nclass Foo extends Base implements Foo2<Foo> {\n Foo f;\n List<Foo> g;\n Foo make(Foo p) throws Foo { return new Foo(); }\n void m() {\n  Foo l = Foo.CONST;\n  Object c = (Foo) x;\n  if (y instanceof Foo) {}\n  Class<?> k = Foo.class;\n  Supplier<Foo> s = Foo::new;\n  Foo.call();\n  foo(Foo.bar);\n  Object o = new a.b.Foo[3];\n }\n}\n";
    let h = find_identifiers(Lang::Java, src, "Foo");
    let kinds: Vec<_> = h.iter().map(|x| x.kind).collect();
    assert_eq!(
        kinds,
        vec![
            Import,        // import
            Declaration,   // class Foo
            Type,          // Foo2<Foo>
            Type,          // Foo f
            Type,          // List<Foo>
            Type,          // return type
            Type,          // param
            Type,          // throws
            Instantiation, // new Foo()
            Type,          // Foo l
            Reference,     // Foo.CONST
            Type,          // (Foo)
            Type,          // instanceof
            Type,          // Foo.class
            Type,          // Supplier<Foo>
            Reference,     // Foo::new
            Reference,     // Foo.call()
            Reference,     // Foo.bar
            Type,          // new a.b.Foo[3]
        ]
    );
}

#[test]
fn ident_new_and_qualifiers() {
    let src = "class A {\n void f() {\n  Object a = new Foo(1);\n  Object b = new x.y.Foo();\n  repo.save(a);\n  this.x = 1;\n  Object c = foo().bar;\n  Object d = Outer.Inner.make();\n  new Foo() { };\n }\n}";
    assert_eq!(hits(src, "Foo"), vec![kq(Instantiation, ""), kq(Instantiation, "x.y"), kq(Instantiation, "")]);
    assert_eq!(hits(src, "save"), vec![kq(Call, "repo")]);
    assert_eq!(hits(src, "x"), vec![kq(Type, ""), kq(Reference, "this")]);
    assert_eq!(hits(src, "bar"), vec![kq(Reference, "")]);
    assert_eq!(hits(src, "make"), vec![kq(Call, "Outer.Inner")]);
    assert_eq!(hits(src, "Inner"), vec![kq(Reference, "Outer")]);
}

#[test]
fn ident_declarations() {
    let src = "class Foo {\n int count;\n void run(String arg) { int local = 1; Foo other = null; for (String s : xs) {} }\n}\nenum E { ENTRY }\ninterface I { void m(); }\nrecord R(int comp) {}\n";
    for n in ["Foo", "count", "run", "arg", "local", "other", "s", "ENTRY", "I", "m", "R", "comp"] {
        let h = hits(src, n);
        assert!(h.iter().any(|x| x.0 == Declaration), "{n}: {h:?}");
    }
}

#[test]
fn ident_annotations() {
    let src = "@Foo class A {\n @Foo(x = 1) int f;\n @Foo void g(@Foo int p) { @Foo int l = 1; }\n}";
    let h = hits(src, "Foo");
    assert_eq!(h.len(), 5);
    assert!(h.iter().all(|x| x.0 == Type));
}

#[test]
fn ident_generic_method_calls() {
    let src = "class A { void f() { List<Foo> a = Collections.<Foo>emptyList(); } }";
    let h = hits(src, "Foo");
    assert_eq!(h, vec![k(Type), k(Type)]);
    assert_eq!(hits(src, "emptyList"), vec![kq(Call, "Collections")]);
}

#[test]
fn ident_casts_are_not_confused_with_parentheses() {
    let src = "class A { void f(int done) { if (done) return; int y = (done) + 1; Object z = (Done) x; call(done); } }";
    let h = hits(src, "done");
    assert!(h.iter().all(|x| x.0 != Type), "{h:?}");
    assert_eq!(hits(src, "Done"), vec![k(Type)]);
}
