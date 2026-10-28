//! kestrel-lang: small and tolerant parsers that read the structure of
//! Kotlin, Java and Swift files: the package, the imports, the types, their
//! supertypes and their members. They do not build a full syntax tree and
//! they skip the inside of function bodies, except for the type names that
//! the bodies use. See docs/DESIGN.md, section 11.
//!
//! `kestrel-code` uses this crate for the project index, the class diagram
//! and "find usages". This crate has no I/O: it only reads text.

mod java;
mod jvm_lex;
mod kotlin;
pub mod model;
mod swift;

pub use model::*;

/// Reads the structure of one file. It never fails: broken code gives a partial result.
pub fn parse(lang: Lang, text: &str) -> FileModel {
    match lang {
        Lang::Kotlin => kotlin::parse(text),
        Lang::Java => java::parse(text),
        Lang::Swift => swift::parse(text),
    }
}

/// Every place where the code uses the identifier `name`, in the order of the
/// text. Comments and string literals are skipped (but the code inside Kotlin
/// `${...}` and Swift `\(...)` templates counts). `name` is a plain name
/// without dots.
pub fn find_identifiers(lang: Lang, text: &str, name: &str) -> Vec<IdentHit> {
    if name.is_empty() {
        return Vec::new();
    }
    match lang {
        Lang::Kotlin => kotlin::find_identifiers(text, name),
        Lang::Java => java::find_identifiers(text, name),
        Lang::Swift => swift::find_identifiers(text, name),
    }
}
