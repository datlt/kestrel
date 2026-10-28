//! Swift parser. Reads declarations and finds uses of a name.
//! `lex.rs` makes tokens, `parse.rs` reads types and members,
//! `idents.rs` finds identifiers.

mod idents;
mod lex;
mod parse;

use crate::model::{FileModel, IdentHit};

pub(crate) fn parse(text: &str) -> FileModel {
    let toks = lex::lex(text);
    parse::Parser::new(text, &toks, true).parse_file()
}

pub(crate) fn find_identifiers(text: &str, name: &str) -> Vec<IdentHit> {
    idents::find(text, name)
}
