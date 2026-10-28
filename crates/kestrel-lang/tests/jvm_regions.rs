//! `regions` for Kotlin and Java.

use kestrel_lang::{regions, Lang, RegionKind};

/// The regions as (kind, text).
fn r(lang: Lang, src: &str) -> Vec<(RegionKind, std::string::String)> {
    regions(lang, src).into_iter().map(|g| (g.kind, src[g.start..g.end].to_string())).collect()
}

fn kt(src: &str) -> Vec<(RegionKind, std::string::String)> {
    r(Lang::Kotlin, src)
}

fn jv(src: &str) -> Vec<(RegionKind, std::string::String)> {
    r(Lang::Java, src)
}

fn c(s: &str) -> (RegionKind, std::string::String) {
    (RegionKind::Comment, s.to_string())
}

fn s(x: &str) -> (RegionKind, std::string::String) {
    (RegionKind::String, x.to_string())
}

#[test]
fn line_and_block_comments() {
    for lang in [Lang::Kotlin, Lang::Java] {
        let src = "a // one\nb /* two\nlines */ c /** doc */ d";
        assert_eq!(r(lang, src), vec![c("// one"), c("/* two\nlines */"), c("/** doc */")]);
    }
}

#[test]
fn kotlin_nested_comments_java_not_nested() {
    assert_eq!(kt("a /* x /* y */ z */ b"), vec![c("/* x /* y */ z */")]);
    assert_eq!(jv("a /* x /* y */ z */ b"), vec![c("/* x /* y */")]);
}

#[test]
fn comment_markers_inside_strings_and_vice_versa() {
    assert_eq!(kt("val a = \"// not\" // yes \"x\"\n"), vec![s("\"// not\""), c("// yes \"x\"")]);
    assert_eq!(jv("String a = \"/* not */\"; /* \"x\" */"), vec![s("\"/* not */\""), c("/* \"x\" */")]);
}

#[test]
fn strings_and_escapes() {
    for lang in [Lang::Kotlin, Lang::Java] {
        assert_eq!(r(lang, "a = \"x\\\"y\" + \"\" + b"), vec![s("\"x\\\"y\""), s("\"\"")]);
    }
}

#[test]
fn char_literals() {
    for lang in [Lang::Kotlin, Lang::Java] {
        assert_eq!(r(lang, "a = '\\'' + '\"' + 'x' + '\\u0041' + '\\\\';"), vec![s("'\\''"), s("'\"'"), s("'x'"), s("'\\u0041'"), s("'\\\\'")]);
    }
}

#[test]
fn kotlin_raw_strings() {
    assert_eq!(kt("a = \"\"\"x \"q\" \\ y\"\"\" + 1"), vec![s("\"\"\"x \"q\" \\ y\"\"\"")]);
    assert_eq!(kt("a = \"\"\"x\"\"\"\" + 1"), vec![s("\"\"\"x\"\"\"\"")]);
    assert_eq!(kt("a = \"\"\"\nline 1\nline 2\n\"\"\"\nb"), vec![s("\"\"\"\nline 1\nline 2\n\"\"\"")]);
}

#[test]
fn java_text_blocks() {
    assert_eq!(jv("a = \"\"\"\n  x \"q\" \\\"\"\" y\n  \"\"\"; b"), vec![s("\"\"\"\n  x \"q\" \\\"\"\" y\n  \"\"\"")]);
}

#[test]
fn kotlin_templates_split_the_string() {
    assert_eq!(kt("\"a${b}c\""), vec![s("\"a"), s("c\"")]);
    assert_eq!(kt("\"a$b c\""), vec![s("\"a"), s(" c\"")]);
    assert_eq!(kt("\"$a$b\""), vec![s("\""), s("\"")]);
    assert_eq!(kt("\"cost: $5 and \\$x\""), vec![s("\"cost: $5 and \\$x\"")]);
    assert_eq!(kt("\"${a}\""), vec![s("\"")].into_iter().chain([s("\"")]).collect::<Vec<_>>());
}

#[test]
fn kotlin_templates_with_code_inside() {
    assert_eq!(
        kt("\"x ${f(\"in ${g}\", 'c') /* k */} y\""),
        vec![s("\"x "), s("\"in "), s("\""), s("'c'"), c("/* k */"), s(" y\"")]
    );
    assert_eq!(kt("\"\"\"a ${ if (x) { 1 } else { 2 } } b\"\"\""), vec![s("\"\"\"a "), s(" b\"\"\"")]);
}

#[test]
fn java_has_no_templates() {
    assert_eq!(jv("\"a${b}c $d\""), vec![s("\"a${b}c $d\"")]);
}

#[test]
fn kotlin_backticks_hide_quotes() {
    assert_eq!(kt("fun `a \" // b`() { \"x\" }"), vec![s("\"x\"")]);
}

#[test]
fn unclosed_things_end_at_the_end() {
    assert_eq!(kt("a /* open\nstill"), vec![c("/* open\nstill")]);
    assert_eq!(jv("a // open"), vec![c("// open")]);
    assert_eq!(kt("a = \"\"\"open\nstill"), vec![s("\"\"\"open\nstill")]);
    assert_eq!(jv("a = \"\"\"open\nstill"), vec![s("\"\"\"open\nstill")]);
    assert_eq!(kt("a = \"open"), vec![s("\"open")]);
    assert_eq!(kt("a = \"${ open"), vec![s("\"")]);
    assert_eq!(kt("a = 'x"), vec![s("'x")]);
}

#[test]
fn unclosed_single_line_string_ends_at_the_line_end() {
    assert_eq!(jv("a = \"open\nb = 1\n"), vec![s("\"open")]);
}

#[test]
fn shebang_line_is_not_a_region() {
    assert!(kt("#!/usr/bin/env kotlin\nval a = 1").is_empty());
}

#[test]
fn non_ascii_text() {
    let src = "// \u{65e5}\u{672c}\nval a = \"\u{1f600}x\" + '\u{3042}' + '\\\u{3042}'\n";
    let g = regions(Lang::Kotlin, src);
    assert_eq!(g.len(), 4);
    for x in g {
        assert!(src.is_char_boundary(x.start) && src.is_char_boundary(x.end));
    }
}

#[test]
fn sorted_and_without_overlaps_on_broken_input() {
    for src in ["\"${\"${\"${", "/*/*/*", "'\\", "\"\"\"${\"\"\"${", "`\"", "}}\"$", "\"${}}\"${"] {
        for lang in [Lang::Kotlin, Lang::Java] {
            let g = regions(lang, src);
            let mut last = 0;
            for x in g {
                assert!(x.start >= last && x.end > x.start && x.end <= src.len(), "{src:?}");
                assert!(src.is_char_boundary(x.start) && src.is_char_boundary(x.end));
                last = x.end;
            }
        }
    }
}

#[test]
fn empty_text() {
    assert!(kt("").is_empty());
    assert!(jv("").is_empty());
}
