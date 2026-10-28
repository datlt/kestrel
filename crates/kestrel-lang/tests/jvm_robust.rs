//! Robustness tests: broken input must never panic or hang.

use kestrel_lang::{find_identifiers, parse, Lang};
use std::time::{Duration, Instant};

const KT: &str = include_str!("fixtures/kotlin/Sample.kt");
const JAVA: &str = include_str!("fixtures/java/Sample.java");

fn run_both(src: &str) {
    for lang in [Lang::Kotlin, Lang::Java] {
        let _ = parse(lang, src);
        let _ = find_identifiers(lang, src, "Foo");
        let _ = find_identifiers(lang, src, "a");
    }
}

fn timed(label: &str, src: &str, limit: Duration) {
    let t = Instant::now();
    run_both(src);
    let dt = t.elapsed();
    assert!(dt < limit, "{label} took {dt:?}");
}

/// Small deterministic random numbers.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

#[test]
fn every_prefix_of_the_fixtures() {
    for (lang, src) in [(Lang::Kotlin, KT), (Lang::Java, JAVA)] {
        for (i, _) in src.char_indices() {
            let cut = &src[..i];
            let _ = parse(lang, cut);
            let _ = find_identifiers(lang, cut, "Foo");
        }
    }
}

#[test]
fn every_suffix_of_the_fixtures() {
    for (lang, src) in [(Lang::Kotlin, KT), (Lang::Java, JAVA)] {
        for (i, _) in src.char_indices() {
            let cut = &src[i..];
            let _ = parse(lang, cut);
            let _ = find_identifiers(lang, cut, "Foo");
        }
    }
}

#[test]
fn random_edits_of_the_fixtures() {
    let junk: Vec<char> = "{}()[]<>\"'`$@:;,.=-/*\\\n \u{3042}#!?&|".chars().collect();
    let mut rng = Rng(12345);
    for (lang, src) in [(Lang::Kotlin, KT), (Lang::Java, JAVA)] {
        let chars: Vec<char> = src.chars().collect();
        for _ in 0..1500 {
            let mut c = chars.clone();
            for _ in 0..(1 + rng.next() % 4) {
                let at = (rng.next() as usize) % c.len();
                match rng.next() % 3 {
                    0 => {
                        let len = 1 + (rng.next() as usize) % 20;
                        let end = (at + len).min(c.len());
                        c.drain(at..end);
                    }
                    1 => c.insert(at, junk[(rng.next() as usize) % junk.len()]),
                    _ => c[at] = junk[(rng.next() as usize) % junk.len()],
                }
                if c.is_empty() {
                    c.push('x');
                }
            }
            let s: String = c.into_iter().collect();
            let _ = parse(lang, &s);
            let _ = find_identifiers(lang, &s, "Foo");
        }
    }
}

#[test]
fn pathological_input_is_fast() {
    let limit = Duration::from_secs(20);
    let n = 200_000;
    for (label, unit) in [
        ("fun", "fun a "),
        ("class", "class A "),
        ("parens", "("),
        ("braces", "{"),
        ("angles", "a<"),
        ("generic class", "class A<"),
        ("annotation args", "@A("),
        ("template", "\"${"),
        ("raw template", "\"\"\"${"),
        ("block comment", "/*"),
        ("quotes", "\""),
        ("tick", "`"),
        ("val", "val x = "),
        ("val list", "val a: A<B>, "),
        ("cast", "(A)(A)(A)"),
        ("lambda", "x -> "),
        ("dots", "a.b.c."),
        ("enum", "enum class E { A("),
        ("java enum", "enum E { A("),
        ("java record", "record R("),
        ("new", "new A<"),
        ("colons", ": A<"),
        ("where", "where T : "),
        ("package", "package a."),
        ("import", "import a."),
    ] {
        let src = unit.repeat(n / unit.len().max(1));
        timed(label, &src, limit);
    }
}

#[test]
fn deep_nesting() {
    let limit = Duration::from_secs(10);
    timed("kotlin classes", &"class A {".repeat(5000), limit);
    timed("java classes", &"class A {".repeat(5000), limit);
    timed("generics", &format!("val x: {}Int{}", "A<".repeat(5000), ">".repeat(5000)), limit);
    timed("function types", &format!("val x: {}Int{}", "(".repeat(5000), ") -> A".repeat(5000)), limit);
    timed("object expressions", &"val x = object : A { val y = object : B { ".repeat(3000), limit);
}

#[test]
fn big_file_of_5_mb() {
    let mut src = String::new();
    while src.len() < 5_000_000 {
        src.push_str(KT);
    }
    timed("big kotlin", &src, Duration::from_secs(20));
    let mut src = String::new();
    while src.len() < 5_000_000 {
        src.push_str(JAVA);
    }
    timed("big java", &src, Duration::from_secs(20));
}
