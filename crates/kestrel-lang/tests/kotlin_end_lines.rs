//! `Member::end_line` for Kotlin.

use kestrel_lang::{parse, Lang, Member};

/// (line, end_line) of the member called `name` (fields, methods, top level).
fn span(src: &str, name: &str) -> (u32, u32) {
    let m = parse(Lang::Kotlin, src);
    let all: Vec<&Member> = m.types.iter().flat_map(|t| t.fields.iter().chain(t.methods.iter())).chain(m.top_level.iter()).collect();
    let f = all.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no member {name}"));
    (f.line, f.end_line)
}

#[test]
fn block_body() {
    let s = "class A {\n  fun f() {\n    if (x) {\n    }\n  }\n  fun g() {}\n}";
    assert_eq!(span(s, "f"), (2, 5));
    assert_eq!(span(s, "g"), (6, 6));
}

#[test]
fn expression_body() {
    let s = "class A {\n  fun f() = foo()\n    .bar()\n    .baz()\n  fun g() = 1 +\n    2\n  fun h() = 3\n}";
    assert_eq!(span(s, "f"), (2, 4));
    assert_eq!(span(s, "g"), (5, 6));
    assert_eq!(span(s, "h"), (7, 7));
}

#[test]
fn properties() {
    let s = "class A {\n  val a = 1\n  val b = listOf(\n    1,\n    2,\n  )\n  val c: Int\n    get() {\n      return 1\n    }\n  var d: Int = 0\n    get() = field\n    private set(v) {\n      field = v\n    }\n  val e by lazy {\n    Foo()\n  }\n  lateinit var f: Foo\n}";
    assert_eq!(span(s, "a"), (2, 2));
    assert_eq!(span(s, "b"), (3, 6));
    assert_eq!(span(s, "c"), (7, 10));
    assert_eq!(span(s, "d"), (11, 15));
    assert_eq!(span(s, "e"), (16, 18));
    assert_eq!(span(s, "f"), (19, 19));
}

#[test]
fn no_body() {
    let s = "interface I {\n  fun a()\n  fun b(\n    x: Int,\n  ): Int\n  val p: Int\n}\nabstract class B {\n  abstract fun c()\n}";
    assert_eq!(span(s, "a"), (2, 2));
    assert_eq!(span(s, "b"), (3, 5));
    assert_eq!(span(s, "p"), (6, 6));
    assert_eq!(span(s, "c"), (9, 9));
}

#[test]
fn annotations_on_their_own_line() {
    let s = "class A {\n  @Foo\n  @Bar(1)\n  fun f() {\n    x()\n  }\n  @Baz\n  val v = 2\n}";
    assert_eq!(span(s, "f"), (4, 6));
    assert_eq!(span(s, "v"), (8, 8));
}

#[test]
fn enum_entries() {
    let s = "enum class E(val x: Int) {\n  A(1),\n  B(2) {\n    override fun f() = 1\n  },\n  C(\n    3\n  );\n  fun g() {}\n}";
    assert_eq!(span(s, "A"), (2, 2));
    assert_eq!(span(s, "B"), (3, 5));
    assert_eq!(span(s, "C"), (6, 8));
    assert_eq!(span(s, "g"), (9, 9));
}

#[test]
fn primary_constructor_and_its_parameters() {
    let s = "class A(\n  val a: Int,\n  var b: String =\n    \"x\",\n  c: Long,\n) : Base() {\n  fun f() {}\n}";
    let m = parse(Lang::Kotlin, s);
    let t = &m.types[0];
    let ctor = &t.methods[0];
    assert_eq!((ctor.line, ctor.end_line), (1, 6));
    assert_eq!((t.fields[0].line, t.fields[0].end_line), (2, 2));
    assert_eq!((t.fields[1].line, t.fields[1].end_line), (3, 4));
}

#[test]
fn secondary_constructor() {
    let s = "class A {\n  constructor(a: Int) : this(a,\n    1) {\n    init()\n  }\n  constructor() : this(0)\n}";
    let m = parse(Lang::Kotlin, s);
    let ms = &m.types[0].methods;
    assert_eq!((ms[0].line, ms[0].end_line), (2, 5));
    assert_eq!((ms[1].line, ms[1].end_line), (6, 6));
}

#[test]
fn lambdas_and_nested_classes_inside_bodies() {
    let s = "class A {\n  fun f() {\n    list.forEach {\n      it.go()\n    }\n    class Local {\n      fun x() {}\n    }\n    val o = object : Runnable {\n      override fun run() {}\n    }\n  }\n  fun after() {}\n  class N {\n    fun n() {\n    }\n  }\n}";
    assert_eq!(span(s, "f"), (2, 12));
    assert_eq!(span(s, "after"), (13, 13));
    assert_eq!(span(s, "n"), (15, 16));
    let m = parse(Lang::Kotlin, s);
    assert_eq!(m.types[0].end_line, 18);
    assert_eq!(m.types[1].end_line, 17);
}

#[test]
fn top_level_members() {
    let s = "fun a() {\n}\nval b = 1\nfun c() =\n  2\nval d by lazy {\n  1\n}";
    assert_eq!(span(s, "a"), (1, 2));
    assert_eq!(span(s, "b"), (3, 3));
    assert_eq!(span(s, "c"), (4, 5));
    assert_eq!(span(s, "d"), (6, 8));
}

#[test]
fn broken_code_has_an_end_line() {
    let s = "class A {\n  fun f() {\n    if (x) {\n";
    let m = parse(Lang::Kotlin, s);
    let f = &m.types[0].methods[0];
    assert_eq!(f.line, 2);
    assert!(f.end_line >= 3, "{}", f.end_line);
    assert!(m.types[0].end_line >= f.end_line);
    let s = "class A {\n  fun f() {\n    x()\n  fun g() {}\n}";
    let m = parse(Lang::Kotlin, s);
    for f in &m.types[0].methods {
        assert!(f.end_line >= f.line && f.end_line > 0);
    }
    let m = parse(Lang::Kotlin, "class A {\n  val x = foo(\n");
    assert!(m.types[0].fields[0].end_line >= 2);
}
