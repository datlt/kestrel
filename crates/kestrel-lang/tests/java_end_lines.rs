//! `Member::end_line` for Java.

use kestrel_lang::{parse, Lang, Member};

fn span(src: &str, name: &str) -> (u32, u32) {
    let m = parse(Lang::Java, src);
    let all: Vec<&Member> = m.types.iter().flat_map(|t| t.fields.iter().chain(t.methods.iter())).collect();
    let f = all.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no member {name}"));
    (f.line, f.end_line)
}

#[test]
fn methods_and_constructors() {
    let s = "class A {\n  A() {\n  }\n  void f() {\n    if (x) {\n    }\n  }\n  abstract int g();\n  void h(\n    int a\n  ) throws IOException {}\n}";
    assert_eq!(span(s, "A"), (2, 3));
    assert_eq!(span(s, "f"), (4, 7));
    assert_eq!(span(s, "g"), (8, 8));
    assert_eq!(span(s, "h"), (9, 11));
}

#[test]
fn fields() {
    let s = "class A {\n  int a;\n  int b = foo(\n    1,\n    2);\n  int c,\n      d;\n  String e =\n    \"x\";\n  List<A> f = new ArrayList<>() {{\n    add(null);\n  }};\n}";
    assert_eq!(span(s, "a"), (2, 2));
    assert_eq!(span(s, "b"), (3, 5));
    assert_eq!(span(s, "c"), (6, 6));
    assert_eq!(span(s, "d"), (7, 7));
    assert_eq!(span(s, "e"), (8, 9));
    assert_eq!(span(s, "f"), (10, 12));
}

#[test]
fn multi_line_declarators_on_one_line() {
    let s = "class A {\n  int a, b;\n  int c;\n}";
    assert_eq!(span(s, "a"), (2, 2));
    assert_eq!(span(s, "b"), (2, 2));
}

#[test]
fn annotations_on_their_own_line() {
    let s = "class A {\n  @Foo\n  @Bar(1)\n  void f() {\n    x();\n  }\n  @Baz\n  int v = 2;\n}";
    assert_eq!(span(s, "f"), (4, 6));
    assert_eq!(span(s, "v"), (8, 8));
}

#[test]
fn interface_members() {
    let s = "interface I {\n  void a();\n  default void b() {\n  }\n  int K =\n    1;\n}";
    assert_eq!(span(s, "a"), (2, 2));
    assert_eq!(span(s, "b"), (3, 4));
    assert_eq!(span(s, "K"), (5, 6));
}

#[test]
fn enum_constants_and_records() {
    let s = "enum E {\n  A,\n  B(2) {\n    void f() {}\n  },\n  C(\n    3);\n  void g() {}\n}\nrecord R(\n  int x,\n  String y) {}";
    assert_eq!(span(s, "A"), (2, 2));
    assert_eq!(span(s, "B"), (3, 5));
    assert_eq!(span(s, "C"), (6, 7));
    assert_eq!(span(s, "g"), (8, 8));
    assert_eq!(span(s, "x"), (11, 11));
    assert_eq!(span(s, "y"), (12, 12));
}

#[test]
fn lambdas_anonymous_and_nested_classes_inside_bodies() {
    let s = "class A {\n  void f() {\n    Runnable r = () -> {\n      go();\n    };\n    Object o = new Foo() {\n      void x() {\n      }\n    };\n    class Local {\n    }\n  }\n  void after() {}\n  static class N {\n    void n() {\n    }\n  }\n}";
    assert_eq!(span(s, "f"), (2, 12));
    assert_eq!(span(s, "after"), (13, 13));
    assert_eq!(span(s, "n"), (15, 16));
    let m = parse(Lang::Java, s);
    assert_eq!(m.types[0].end_line, 18);
    assert_eq!(m.types[1].end_line, 17);
}

#[test]
fn annotation_element_with_default() {
    let s = "@interface Ann {\n  String value()\n    default \"x\";\n  int n();\n}";
    assert_eq!(span(s, "value"), (2, 3));
    assert_eq!(span(s, "n"), (4, 4));
}

#[test]
fn broken_code_has_an_end_line() {
    let m = parse(Lang::Java, "class A {\n  void f() {\n    if (x) {\n");
    let f = &m.types[0].methods[0];
    assert!(f.end_line >= 3, "{}", f.end_line);
    assert!(m.types[0].end_line >= f.end_line);
    let m = parse(Lang::Java, "class A {\n  int x = foo(\n");
    assert!(m.types[0].fields[0].end_line >= 2);
    let m = parse(Lang::Java, "class A {\n  void f() {\n    x();\n  void g() {}\n}");
    for f in &m.types[0].methods {
        assert!(f.end_line >= f.line && f.end_line > 0);
    }
}
