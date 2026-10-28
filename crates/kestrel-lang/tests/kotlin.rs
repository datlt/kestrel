//! Kotlin parser tests with small hand-written snippets.

use kestrel_lang::{find_identifiers, parse, FileModel, Lang, MemberKind, SuperKind, TypeKind, UsageKind, Visibility};
use UsageKind::*;

fn p(src: &str) -> FileModel {
    parse(Lang::Kotlin, src)
}

/// Hits of `name` as (kind, qualifier).
fn hits(src: &str, name: &str) -> Vec<(UsageKind, String)> {
    find_identifiers(Lang::Kotlin, src, name).into_iter().map(|h| (h.kind, h.qualifier)).collect()
}

fn k(kind: UsageKind) -> (UsageKind, String) {
    (kind, String::new())
}

fn kq(kind: UsageKind, q: &str) -> (UsageKind, String) {
    (kind, q.to_string())
}

#[test]
fn package_and_imports() {
    let m = p("package a.b.c\n\nimport x.y.Foo\nimport x.z.*\nimport x.w.Bar as Baz\nimport `a`.`in`.Thing\n");
    assert_eq!(m.package, "a.b.c");
    assert_eq!(m.imports.len(), 4);
    assert_eq!(m.imports[0].path, "x.y.Foo");
    assert!(!m.imports[0].wildcard);
    assert_eq!(m.imports[0].line, 3);
    assert_eq!(m.imports[1].path, "x.z");
    assert!(m.imports[1].wildcard);
    assert_eq!(m.imports[2].path, "x.w.Bar");
    assert_eq!(m.imports[2].alias.as_deref(), Some("Baz"));
    assert_eq!(m.imports[3].path, "a.in.Thing");
}

#[test]
fn file_annotation_before_package() {
    let m = p("@file:JvmName(\"X\")\npackage p.q\nclass A");
    assert_eq!(m.package, "p.q");
    assert_eq!(m.types.len(), 1);
}

#[test]
fn class_kinds_and_modifiers() {
    let m = p("open class A\nabstract class B\nsealed interface C\ndata class D(val x: Int)\nenum class E { X }\nannotation class F\nobject G\ndata object H\nvalue class I(val v: Int)\nfun interface J { fun f() }\ninner class K\nexpect class L\nactual class M\n");
    let kinds: Vec<_> = m.types.iter().map(|t| (t.name.as_str(), t.kind)).collect();
    assert_eq!(
        kinds,
        vec![
            ("A", TypeKind::Class),
            ("B", TypeKind::Class),
            ("C", TypeKind::Interface),
            ("D", TypeKind::Class),
            ("E", TypeKind::Enum),
            ("F", TypeKind::Annotation),
            ("G", TypeKind::Object),
            ("H", TypeKind::Object),
            ("I", TypeKind::Class),
            ("J", TypeKind::Interface),
            ("K", TypeKind::Class),
            ("L", TypeKind::Class),
            ("M", TypeKind::Class),
        ]
    );
    assert_eq!(m.types[0].modifiers, vec!["open"]);
    assert_eq!(m.types[2].modifiers, vec!["sealed"]);
    assert_eq!(m.types[3].modifiers, vec!["data"]);
    assert_eq!(m.types[8].modifiers, vec!["value"]);
    assert_eq!(m.types[9].modifiers, vec!["fun"]);
    assert_eq!(m.types[11].modifiers, vec!["expect"]);
}

#[test]
fn positions() {
    let m = p("package a\n\n@Foo\n@Bar(1)\npublic class Name(val a: Int) {\n    fun f() {}\n}\n\nclass Short\n");
    let t = &m.types[0];
    assert_eq!((t.line, t.column), (5, 14));
    assert_eq!(t.start_line, 3);
    assert_eq!(t.end_line, 7);
    let s = &m.types[1];
    assert_eq!(s.start_line, 9);
    assert_eq!(s.end_line, 9);
    assert_eq!(t.methods[1].line, 6);
    assert_eq!(t.methods[1].column, 9);
}

#[test]
fn annotations_names_only() {
    let m = p("@Entity @Table(name = \"t\", x = [1, 2]) @field:Json(name = \"x\") @get:JvmName(\"y\") @a.b.Full\nclass A");
    assert_eq!(m.types[0].annotations, vec!["Entity", "Table", "Json", "JvmName", "Full"]);
}

#[test]
fn type_params_and_where() {
    let m = p("class Box<T : Any, out R, in S>(val t: T) where T : Comparable<T>, R : Any\ninterface Foo<A, B>");
    assert_eq!(m.types[0].type_params, vec!["T", "R", "S"]);
    assert_eq!(m.types[1].type_params, vec!["A", "B"]);
}

#[test]
fn supertypes() {
    let m = p("class A(b: B) : Base(1, 2), I1, I2<String> by b, I3 {}");
    let s = &m.types[0].supertypes;
    assert_eq!(s.len(), 4);
    assert_eq!(s[0].ty.name, "Base");
    assert_eq!(s[0].kind, SuperKind::Extends);
    assert_eq!(s[1].ty.name, "I1");
    assert_eq!(s[1].kind, SuperKind::Unknown);
    assert!(!s[1].delegated);
    assert_eq!(s[2].ty.text, "I2<String>");
    assert_eq!(s[2].ty.args[0].name, "String");
    assert!(s[2].delegated);
    assert_eq!(s[3].ty.name, "I3");
    assert!(!s[3].delegated);
}

#[test]
fn primary_constructor_properties() {
    let m = p("class A(val a: Int, var b: String?, c: Long, private val d: List<Foo> = emptyList(), @Inject val e: E)");
    let t = &m.types[0];
    let f: Vec<_> = t.fields.iter().map(|f| (f.name.as_str(), f.mutable, f.visibility)).collect();
    assert_eq!(
        f,
        vec![
            ("a", false, Visibility::Public),
            ("b", true, Visibility::Public),
            ("d", false, Visibility::Private),
            ("e", false, Visibility::Public),
        ]
    );
    assert_eq!(t.fields[1].ty.as_ref().unwrap().nullable, true);
    assert_eq!(t.fields[1].ty.as_ref().unwrap().name, "String");
    assert_eq!(t.fields[2].ty.as_ref().unwrap().args[0].name, "Foo");
    let c = &t.methods[0];
    assert_eq!(c.kind, MemberKind::Constructor);
    assert_eq!(c.name, "A");
    assert_eq!(c.params.len(), 5);
    assert_eq!(c.params[2].name, "c");
}

#[test]
fn private_constructor_and_annotated() {
    let m = p("class A @Inject constructor(val x: Int)\nclass B private constructor(val y: Int)");
    assert_eq!(m.types[0].methods[0].params.len(), 1);
    assert_eq!(m.types[1].methods[0].visibility, Visibility::Private);
}

#[test]
fn secondary_constructor() {
    let m = p("class A(val a: Int) {\n  constructor(s: String) : this(s.length)\n  protected constructor() : this(0) { init() }\n}");
    let t = &m.types[0];
    assert_eq!(t.methods.len(), 3);
    assert_eq!(t.methods[1].params[0].name, "s");
    assert_eq!(t.methods[2].visibility, Visibility::Protected);
}

#[test]
fn functions_and_visibility() {
    let m = p("class A {\n fun a() {}\n private fun b(x: Int, y: String = \"d\"): Boolean = true\n protected open fun c() {}\n internal fun d() {}\n suspend fun e(): List<Int> { return listOf() }\n abstract fun f()\n}\n");
    let ms = &m.types[0].methods;
    let v: Vec<_> = ms.iter().map(|f| (f.name.as_str(), f.visibility, f.is_abstract)).collect();
    assert_eq!(
        v,
        vec![
            ("a", Visibility::Public, false),
            ("b", Visibility::Private, false),
            ("c", Visibility::Protected, false),
            ("d", Visibility::Internal, false),
            ("e", Visibility::Public, false),
            ("f", Visibility::Public, true),
        ]
    );
    assert_eq!(ms[1].params.len(), 2);
    assert_eq!(ms[1].ty.as_ref().unwrap().name, "Boolean");
    assert_eq!(ms[4].ty.as_ref().unwrap().text, "List<Int>");
}

#[test]
fn interface_methods_are_abstract_without_body() {
    let m = p("interface I {\n fun a()\n fun b() {}\n fun c() = 1\n val p: Int\n val q: Int get() = 1\n}");
    let t = &m.types[0];
    assert!(t.methods[0].is_abstract);
    assert!(!t.methods[1].is_abstract);
    assert!(!t.methods[2].is_abstract);
    assert!(t.fields[0].is_abstract);
    assert!(!t.fields[1].is_abstract);
}

#[test]
fn extension_functions_and_properties() {
    let m = p("fun String.shout(): String = uppercase()\nfun <T> List<T>.second(): T = this[1]\nval Foo.bar: Int get() = 1\nfun a.b.Foo.baz() {}\nfun plain() {}\n");
    assert_eq!(m.top_level.len(), 5);
    assert_eq!(m.top_level[0].receiver.as_ref().unwrap().name, "String");
    assert_eq!(m.top_level[1].receiver.as_ref().unwrap().text, "List<T>");
    assert_eq!(m.top_level[1].name, "second");
    assert_eq!(m.top_level[2].receiver.as_ref().unwrap().name, "Foo");
    assert_eq!(m.top_level[2].name, "bar");
    assert_eq!(m.top_level[3].receiver.as_ref().unwrap().name, "a.b.Foo");
    assert_eq!(m.top_level[3].name, "baz");
    assert!(m.top_level[4].receiver.is_none());
}

#[test]
fn properties_and_inferred_types() {
    let m = p("class A {\n val a = Foo()\n val b = Foo.Bar(1)\n val c = foo()\n val d: Int = 3\n var e = a.b.Baz<String>()\n val f by lazy { Foo() }\n lateinit var g: Svc\n const val H = 1\n val i = \"s\"\n val j = 1 + Foo(2).x\n}");
    let f = &m.types[0].fields;
    assert_eq!(f[0].ty.as_ref().unwrap().name, "Foo");
    assert_eq!(f[1].ty.as_ref().unwrap().name, "Foo.Bar");
    assert!(f[2].ty.is_none());
    assert_eq!(f[3].ty.as_ref().unwrap().name, "Int");
    assert_eq!(f[4].ty.as_ref().unwrap().name, "a.b.Baz");
    assert_eq!(f[4].ty.as_ref().unwrap().args[0].name, "String");
    assert!(f[4].mutable);
    assert!(f[5].ty.is_none());
    assert_eq!(f[6].ty.as_ref().unwrap().name, "Svc");
    assert!(f[6].mutable);
    assert!(f[8].ty.is_none());
    assert!(f[9].ty.is_none());
    assert_eq!(f.len(), 10);
}

#[test]
fn property_accessors_do_not_break_the_next_member() {
    let m = p("class A {\n var x: Int = 0\n   get() = field\n   private set(v) { field = v }\n val y: Int\n   get() {\n     return 1\n   }\n fun after() {}\n}");
    let t = &m.types[0];
    assert_eq!(t.fields.len(), 2);
    assert_eq!(t.methods.len(), 1);
    assert_eq!(t.methods[0].name, "after");
}

#[test]
fn companion_objects() {
    let m = p("class A {\n companion object {\n  val X = 1\n }\n}\nclass B {\n companion object Factory : Base() {\n  fun make() = B()\n }\n}");
    assert_eq!(m.types[1].name, "Companion");
    assert_eq!(m.types[1].kind, TypeKind::Object);
    assert_eq!(m.types[1].outer, Some(0));
    assert_eq!(m.types[1].modifiers, vec!["companion"]);
    assert_eq!(m.types[3].name, "Factory");
    assert_eq!(m.types[3].supertypes[0].kind, SuperKind::Extends);
    assert_eq!(m.types[3].outer, Some(2));
    assert!(m.types[3].used_types.contains(&"B".to_string()));
}

#[test]
fn nested_types_have_outer() {
    let m = p("class A {\n class B {\n  class C\n }\n interface D\n}\nclass E");
    let o: Vec<_> = m.types.iter().map(|t| (t.name.as_str(), t.outer)).collect();
    assert_eq!(o, vec![("A", None), ("B", Some(0)), ("C", Some(1)), ("D", Some(0)), ("E", None)]);
}

#[test]
fn enum_entries() {
    let m = p("enum class Color(val rgb: Int) : Base {\n RED(1),\n GREEN(2) { override fun f() = Foo() },\n @Deprecated BLUE(3);\n fun g() = 1\n}\nenum class Empty\nenum class Plain { A, B, C }");
    let t = &m.types[0];
    let cases: Vec<_> = t.fields.iter().filter(|f| f.kind == MemberKind::EnumCase).map(|f| f.name.as_str()).collect();
    assert_eq!(cases, vec!["RED", "GREEN", "BLUE"]);
    assert!(t.methods.iter().any(|f| f.name == "g"));
    assert!(t.fields.iter().any(|f| f.name == "rgb" && f.kind == MemberKind::Property));
    assert!(t.used_types.contains(&"Foo".to_string()));
    assert_eq!(t.supertypes.len(), 1);
    assert_eq!(m.types[2].fields.len(), 3);
}

#[test]
fn typealias() {
    let m = p("typealias Handler = (Event, Int) -> Unit\ntypealias Names<T> = Map<String, List<T>>\nclass A { typealias In = Foo }");
    assert_eq!(m.types[0].kind, TypeKind::TypeAlias);
    assert_eq!(m.types[0].aliased.as_ref().unwrap().text, "(Event, Int) -> Unit");
    assert_eq!(m.types[1].aliased.as_ref().unwrap().name, "Map");
    assert_eq!(m.types[1].type_params, vec!["T"]);
    assert_eq!(m.types[2].name, "A");
    assert_eq!(m.types[3].outer, Some(2));
}

#[test]
fn function_types_and_nullable_types() {
    let m = p("class A(val a: (Int) -> String, val b: suspend (A, B) -> Unit, val c: Foo.(Int) -> Unit, val d: ((X) -> Y)?, val e: Map<String, List<Foo?>>?)");
    let f = &m.types[0].fields;
    assert_eq!(f[0].ty.as_ref().unwrap().name, "");
    assert_eq!(f[0].ty.as_ref().unwrap().args.len(), 2);
    assert_eq!(f[1].ty.as_ref().unwrap().args.len(), 3);
    assert_eq!(f[2].ty.as_ref().unwrap().args.len(), 3);
    assert!(f[3].ty.as_ref().unwrap().nullable);
    let e = f[4].ty.as_ref().unwrap();
    assert_eq!(e.text, "Map<String, List<Foo?>>?");
    assert!(e.nullable);
    assert_eq!(e.args[1].args[0].name, "Foo");
}

#[test]
fn generics_with_double_close() {
    let m = p("class A { val x: Map<String, List<Map<Int, Foo>>> = mapOf()\n val y: Int = 1 }");
    assert_eq!(m.types[0].fields.len(), 2);
    assert_eq!(m.types[0].fields[0].ty.as_ref().unwrap().text, "Map<String, List<Map<Int, Foo>>>");
}

#[test]
fn star_projection_is_left_out() {
    let m = p("class A(val x: List<*>, val y: Map<*, Foo>)");
    let f = &m.types[0].fields;
    assert_eq!(f[0].ty.as_ref().unwrap().args.len(), 0);
    assert_eq!(f[1].ty.as_ref().unwrap().args.len(), 1);
}

#[test]
fn used_types_in_bodies() {
    let src = "class A {\n fun f(): Int {\n  val x = Foo(1)\n  val y: Bar<Baz> = Qux.create()\n  val z = a.b.Deep.go()\n  println(Const.MAX_SIZE)\n  val k = Foo::class\n  if (x is Other) {}\n  val m = x as? Cast\n  Foo(2)\n  return Outer.Inner.make()\n }\n}";
    let m = p(src);
    assert_eq!(m.types[0].used_types, vec!["Foo", "Bar", "Baz", "Qux", "a.b.Deep", "Const", "Other", "Cast", "Outer.Inner"]);
}

#[test]
fn used_types_not_from_signatures() {
    let m = p("class A(val x: Sig) : Parent() {\n val f: Field = make()\n fun g(p: Param): Ret = body()\n}");
    assert!(m.types[0].used_types.is_empty(), "{:?}", m.types[0].used_types);
}

#[test]
fn used_types_not_from_nested_types() {
    let m = p("class A {\n val a = One()\n class B {\n  val b = Two()\n }\n fun f() = Three()\n}");
    assert_eq!(m.types[0].used_types, vec!["One", "Three"]);
    assert_eq!(m.types[1].used_types, vec!["Two"]);
}

#[test]
fn used_types_in_string_templates() {
    let m = p("class A { fun f() = \"x ${Foo.name} $y ${Bar(1)}\" }");
    assert_eq!(m.types[0].used_types, vec!["Foo", "Bar"]);
}

#[test]
fn object_expressions_are_not_types() {
    let m = p("class A {\n fun f() = object : Runnable, Other() { override fun run() {} }\n}");
    assert_eq!(m.types.len(), 1);
    assert_eq!(m.types[0].used_types, vec!["Runnable", "Other"]);
}

#[test]
fn local_classes_are_not_types() {
    let m = p("class A {\n fun f() {\n  class Local(val x: Foo)\n  val o = Local(Bar())\n }\n}");
    assert_eq!(m.types.len(), 1);
    assert!(m.types[0].used_types.contains(&"Bar".to_string()));
}

#[test]
fn comments_and_strings_do_not_make_declarations() {
    let src = "/* class Fake1 {} /* nested class Fake2 {} */ class Fake3 {} */\n// class Fake4\n/** class Fake5 */\nval s = \"class Fake6\"\nval r = \"\"\"\nclass Fake7 {\n\"\"\"\nclass Real\n";
    let m = p(src);
    assert_eq!(m.types.len(), 1);
    assert_eq!(m.types[0].name, "Real");
    assert_eq!(m.types[0].line, 8);
}

#[test]
fn char_literals_with_quotes() {
    let m = p("val a = '\\''\nval b = '\"'\nclass A\nval c = '{'\nclass B");
    assert_eq!(m.types.len(), 2);
}

#[test]
fn backtick_names() {
    let m = p("class `My Class`\nfun `is ok`() {}\nval `val` = 1\n");
    assert_eq!(m.types[0].name, "My Class");
    assert_eq!(m.top_level[0].name, "is ok");
    assert_eq!(m.top_level[1].name, "val");
}

#[test]
fn raw_strings_with_templates() {
    let src = "val a = \"\"\"\n  ${Foo.x} \"quoted\" ${ \"nested ${Bar.y}\" }\n\"\"\"\nclass After";
    let m = p(src);
    assert_eq!(m.types.len(), 1);
    assert_eq!(m.types[0].name, "After");
    assert_eq!(hits(src, "Foo"), vec![k(Reference)]);
    assert_eq!(hits(src, "Bar"), vec![k(Reference)]);
}

#[test]
fn kts_script_top_level_code() {
    let src = "plugins {\n    id(\"java\")\n    kotlin(\"jvm\") version \"1.9\"\n}\nval x = Foo()\nrepositories { mavenCentral() }\ntasks.register<Copy>(\"c\") {\n  from(\"a\")\n}\nclass InScript\n";
    let m = p(src);
    assert_eq!(m.types.len(), 1);
    assert_eq!(m.types[0].name, "InScript");
    assert_eq!(m.top_level.len(), 1);
    assert_eq!(m.top_level[0].name, "x");
    assert_eq!(hits(src, "Copy"), vec![k(Type)]);
    assert_eq!(hits(src, "id"), vec![k(Call)]);
}

#[test]
fn expression_bodies_end_at_the_right_line() {
    let m = p("class A {\n fun a() = foo()\n   .bar()\n   .baz()\n fun b() = 1 +\n   2\n fun c() = if (x) 1 else 2\n val d = 3\n}");
    let t = &m.types[0];
    assert_eq!(t.methods.len(), 3);
    assert_eq!(t.fields.len(), 1);
}

#[test]
fn use_site_targets_and_arguments() {
    let m = p("data class A(\n @field:Json(name = \"a\") val a: Int,\n @get:JvmName(\"gg\") @param:Foo val b: Int,\n)");
    assert_eq!(m.types[0].fields.len(), 2);
    assert_eq!(hits("@field:Json(name = \"a\") val a = 1", "Json"), vec![k(Type)]);
    assert_eq!(hits("@field:Json(name = \"a\") val a = 1", "field"), vec![]);
}

#[test]
fn sealed_hierarchy() {
    let m = p("sealed class Result<out T> {\n data class Ok<T>(val v: T) : Result<T>()\n object Fail : Result<Nothing>()\n}");
    assert_eq!(m.types.len(), 3);
    assert_eq!(m.types[1].supertypes[0].ty.name, "Result");
    assert_eq!(m.types[1].supertypes[0].kind, SuperKind::Extends);
    assert_eq!(m.types[2].supertypes[0].ty.args[0].name, "Nothing");
}

#[test]
fn broken_code_gives_partial_results() {
    for src in [
        "class A {",
        "class A(val x: ",
        "fun f(",
        "val x = \"unclosed",
        "/* unclosed",
        "class A { fun f() { if (x) { } ",
        "import",
        "package",
        "class",
        "class A : ",
        "@",
        "@Foo(",
        "fun <T",
        "val (a, b",
        "enum class E { A(1",
        "class A<T : ",
        "typealias X =",
        "val x = \"${",
        "val x = \"\"\"${ foo",
        "}}}}",
        "class A { class B { class C {",
        "\u{feff}class Bom",
    ] {
        let m = p(src);
        let _ = find_identifiers(Lang::Kotlin, src, "A");
        if src.starts_with('\u{feff}') {
            assert_eq!(m.types[0].name, "Bom");
        }
    }
}

#[test]
fn non_ascii_text_is_safe() {
    let src = "// \u{65e5}\u{672c}\u{8a9e}\nclass \u{30af}\u{30e9}\u{30b9} { val s = \"\u{1f600}\u{1f600}\"; fun \u{3042}() = '\u{3042}' }\nclass B";
    let m = p(src);
    assert_eq!(m.types.len(), 2);
    assert_eq!(m.types[0].name, "\u{30af}\u{30e9}\u{30b9}");
    let h = find_identifiers(Lang::Kotlin, src, "B");
    assert_eq!(h.len(), 1);
    assert_eq!(&src[h[0].start..h[0].end], "B");
}

#[test]
fn crlf_lines() {
    let m = p("package a\r\n\r\nclass A {\r\n  fun f() {}\r\n}\r\n");
    assert_eq!(m.types[0].line, 3);
    assert_eq!(m.types[0].end_line, 5);
    assert_eq!(m.types[0].methods[0].line, 4);
}

#[test]
fn empty_input() {
    assert_eq!(p(""), FileModel::default());
    assert!(find_identifiers(Lang::Kotlin, "", "A").is_empty());
}

// ---- find_identifiers

#[test]
fn ident_ignores_comments_and_strings() {
    let src = "// Foo\n/* Foo /* Foo */ Foo */\nval s = \"Foo\"\nval r = \"\"\"Foo\"\"\"\nval c = 'F'\nval x = Foo\n";
    let h = find_identifiers(Lang::Kotlin, src, "Foo");
    assert_eq!(h.len(), 1);
    assert_eq!(&src[h[0].start..h[0].end], "Foo");
    assert!(src[..h[0].start].ends_with("val x = "));
}

#[test]
fn ident_in_templates() {
    let src = "val a = \"hi $Foo and ${Foo.bar()} and \\$Foo\"\n";
    let h = hits(src, "Foo");
    assert_eq!(h.len(), 2);
    assert_eq!(h[0], k(Reference));
    assert_eq!(hits(src, "bar"), vec![kq(Call, "Foo")]);
}

#[test]
fn ident_kinds() {
    let src = "import a.b.Foo\nclass Foo : Base(), Foo2<Foo>\nclass X(val f: Foo, g: List<Foo>) : Foo()\nfun m(p: Foo): Foo { val l: Foo = Foo(); val c = x as Foo; if (y is Foo) {}; return Foo.CONST }\nval k = Foo::class\nval q = Foo::bar\nfun use() { Foo { } ; foo<Foo>() }\n";
    let h = find_identifiers(Lang::Kotlin, src, "Foo");
    let kinds: Vec<_> = h.iter().map(|x| x.kind).collect();
    assert_eq!(
        kinds,
        vec![
            Import,      // import a.b.Foo
            Declaration, // class Foo
            Type,        // Foo2<Foo>
            Type,        // val f: Foo
            Type,        // List<Foo>
            Supertype,   // : Foo()
            Type,        // p: Foo
            Type,        // : Foo
            Type,        // l: Foo
            Call,        // Foo()
            Type,        // as Foo
            Type,        // is Foo
            Reference,   // Foo.CONST
            Type,        // Foo::class
            Reference,   // Foo::bar
            Call,        // Foo { }
            Type,        // foo<Foo>
        ]
    );
}

#[test]
fn ident_qualifiers() {
    let src = "val a = x.b.Foo()\nval b = repo.save(1)\nval c = this.x\nval d = foo().bar\nval e = Foo::class\nval f = a?.b\nimport p.q.Foo\nval g = Foo::bar\n";
    assert_eq!(hits(src, "Foo"), vec![kq(Call, "x.b"), kq(Type, ""), kq(Import, "p.q"), kq(Reference, "")]);
    assert_eq!(hits(src, "save"), vec![kq(Call, "repo")]);
    assert_eq!(hits(src, "x"), vec![kq(Reference, ""), kq(Reference, "this")]);
    assert_eq!(hits(src, "bar"), vec![kq(Reference, ""), kq(Reference, "Foo")]);
    assert_eq!(hits(src, "b"), vec![kq(Reference, "x"), kq(Declaration, ""), kq(Reference, "a")]);
}

#[test]
fn ident_declarations() {
    let src = "class Foo\nobject Bar\ninterface Baz\nfun qux() {}\nval name = 1\nvar mut = 2\ntypealias Ali = Int\nenum class E { ENTRY }\nfun f(param: Int) { val local = 1 }\n";
    for (n, expect) in [
        ("Foo", Declaration),
        ("Bar", Declaration),
        ("Baz", Declaration),
        ("qux", Declaration),
        ("name", Declaration),
        ("mut", Declaration),
        ("Ali", Declaration),
        ("ENTRY", Declaration),
        ("param", Declaration),
        ("local", Declaration),
    ] {
        let h = hits(src, n);
        assert_eq!(h.len(), 1, "{n}");
        assert_eq!(h[0].0, expect, "{n}");
    }
}

#[test]
fn ident_backticks_use_inner_range() {
    let src = "fun `my test`() {}\nval x = `my test`()";
    let h = find_identifiers(Lang::Kotlin, src, "my test");
    assert_eq!(h.len(), 2);
    assert_eq!(&src[h[0].start..h[0].end], "my test");
    assert_eq!(h[0].kind, Declaration);
    assert_eq!(h[1].kind, Call);
}

#[test]
fn ident_extension_receiver_and_generics() {
    let src = "fun Foo.ext(): Foo = this\nfun <T : Foo> gen(x: List<out Foo>) {}\nclass A<T> where T : Foo\n";
    let h = hits(src, "Foo");
    assert!(h.iter().all(|x| x.0 == Type), "{h:?}");
    assert_eq!(h.len(), 5);
}

#[test]
fn ident_labels_and_annotations_in_code() {
    let src = "fun f() {\n  list.forEach { return@forEach }\n  this@Outer.x\n  @Suppress(\"x\") val a = 1\n}";
    assert_eq!(hits(src, "forEach").len(), 2);
    assert_eq!(hits(src, "Outer"), vec![k(Reference)]);
    assert_eq!(hits(src, "Suppress"), vec![k(Type)]);
}

#[test]
fn ident_trailing_lambda_is_call() {
    let src = "fun f() { run { 1 }\n  apply\n  withContext(io) { 2 } }";
    assert_eq!(hits(src, "run"), vec![k(Call)]);
    assert_eq!(hits(src, "apply"), vec![k(Reference)]);
    assert_eq!(hits(src, "withContext"), vec![k(Call)]);
}

#[test]
fn function_type_parts_are_in_args() {
    let m = p("class A(val a: (Foo, Bar) -> Baz, val b: suspend (X) -> Unit, val c: Recv.(P) -> R, val d: () -> Q)");
    let names = |i: usize| -> Vec<String> {
        let t = m.types[0].fields[i].ty.as_ref().unwrap();
        assert_eq!(t.name, "");
        t.args.iter().map(|a| a.name.clone()).collect()
    };
    assert_eq!(names(0), vec!["Foo", "Bar", "Baz"]);
    assert_eq!(names(1), vec!["X", "Unit"]);
    assert_eq!(names(2), vec!["Recv", "P", "R"]);
    assert_eq!(names(3), vec!["Q"]);
}
