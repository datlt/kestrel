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

/// Comments and string literals (see `crate::regions`). Strings are the
/// string pieces and regex literals of the lexer, so the code in `\(...)`
/// stays outside.
pub(crate) fn regions(text: &str) -> Vec<crate::model::Region> {
    use crate::model::{Region, RegionKind};
    let (toks, comments) = lex::lex_with_comments(text);
    let mut out: Vec<Region> = Vec::with_capacity(comments.len() + toks.len() / 8);
    let mut ci = 0;
    for t in &toks {
        if t.kind != lex::STR && t.kind != lex::REGEX {
            continue;
        }
        let (s, e) = (t.start as usize, t.end as usize);
        while ci < comments.len() && (comments[ci].0 as usize) < s {
            out.push(Region {
                start: comments[ci].0 as usize,
                end: comments[ci].1 as usize,
                kind: RegionKind::Comment,
            });
            ci += 1;
        }
        if e > s {
            out.push(Region {
                start: s,
                end: e,
                kind: RegionKind::String,
            });
        }
    }
    for c in &comments[ci..] {
        out.push(Region {
            start: c.0 as usize,
            end: c.1 as usize,
            kind: RegionKind::Comment,
        });
    }
    out
}
