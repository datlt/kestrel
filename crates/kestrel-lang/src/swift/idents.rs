//! `find_identifiers` for Swift. One pass over the tokens. It keeps a small
//! state (brackets, type regions, inheritance lists) to tell the usage kinds.

use super::lex::*;
use super::parse::{class_is_modifier, Parser};
use crate::model::{IdentHit, UsageKind};

const F_BRACE: u8 = 0;
const F_ENUM: u8 = 1;
const F_PAREN: u8 = 2;
const F_PARAMS: u8 = 3;
const F_PATTERN: u8 = 4;
const F_BRACKET: u8 = 5;

fn is_paren_frame(f: u8) -> bool {
    matches!(f, F_PAREN | F_PARAMS | F_PATTERN | F_BRACKET)
}

/// Index of the `>` that closes the `<` at `lt`. It gives up at `{`, `;`, `}`.
fn match_angle(p: &Parser, lt: usize) -> Option<usize> {
    let mut depth = 0i32;
    let end = (lt + 300).min(p.t.len());
    for j in lt..end {
        let t = &p.t[j];
        if t.kind == PUNCT {
            match t.c {
                b'<' => depth += 1,
                b'>' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(j);
                    }
                }
                b'{' | b'}' | b';' => return None,
                _ => {}
            }
        }
    }
    None
}

/// Index of the `)` that closes the `(` at `open`.
fn match_paren(p: &Parser, open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let end = (open + 400).min(p.t.len());
    for j in open..end {
        let t = &p.t[j];
        if t.kind == PUNCT {
            match t.c {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(j);
                    }
                }
                b'{' | b'}' | b';' if j > open => return None,
                _ => {}
            }
        }
    }
    None
}

/// True when the `:` at `colon` follows the name of a `let` or `var` pattern.
fn let_before_colon(p: &Parser, colon: usize) -> bool {
    let mut depth = 0i32;
    let mut k = colon;
    let mut steps = 0;
    while k > 0 && steps < 60 {
        k -= 1;
        steps += 1;
        let t = &p.t[k];
        match t.kind {
            PUNCT => match t.c {
                b')' => depth += 1,
                b'(' => depth -= 1,
                b';' | b'{' | b'}' if depth <= 0 => return false,
                b'=' if depth <= 0 => return false,
                _ => {}
            },
            IDENT if depth <= 0 => {
                if p.text(k) == "let" || p.text(k) == "var" {
                    return true;
                }
            }
            _ => {}
        }
        if t.nl && depth <= 0 {
            return false;
        }
    }
    false
}

/// The plain dotted name before token `k`: `a.b` for `a.b.k`. Empty when
/// the part before is not a plain name.
fn qualifier(p: &Parser, k: usize) -> String {
    let mut segs: Vec<usize> = Vec::new();
    let mut j = k;
    while j >= 1 && p.punct(j - 1, b'.') {
        if j < 2 || p.punct(j - 2, b'.') {
            return String::new();
        }
        let mut q = j - 2;
        while q > 0 && (p.punct(q, b'?') || p.punct(q, b'!')) {
            q -= 1;
        }
        if !p.is_id(q) {
            return String::new();
        }
        segs.push(q);
        j = q;
    }
    if segs.is_empty() {
        return String::new();
    }
    segs.reverse();
    let head = segs[0];
    let last = *segs.last().unwrap_or(&head);
    let mut plain = true;
    for k2 in head + 1..=last {
        if !p.adj(k2) {
            plain = false;
            break;
        }
    }
    if plain {
        let slice = p.src.get(p.t[head].start as usize..p.t[last].end as usize).unwrap_or("");
        if !slice.contains(['?', '!', '`']) {
            return slice.to_string();
        }
    }
    let mut s = String::new();
    for (n, q) in segs.iter().enumerate() {
        if n > 0 {
            s.push('.');
        }
        s.push_str(p.text(*q));
    }
    s
}

pub(super) fn find(src: &str, name: &str) -> Vec<IdentHit> {
    let toks = lex(src);
    let nb = name.as_bytes();
    let n = toks.len();
    let mut p = Parser::new(src, &toks, false);
    let mut hits: Vec<IdentHit> = Vec::new();

    let mut frames: Vec<u8> = Vec::new();
    let mut type_end = 0usize;
    let mut import_until = 0usize;
    let mut generic_end = 0usize;
    let mut colon_hdr = usize::MAX;
    let mut inherit = false;
    let mut angle = 0i32;
    let mut where_active = false;
    let mut hdr_active = false;
    let mut params_pending: Option<usize> = None;
    let mut enum_pending = false;
    let mut in_case = false;
    let mut cond_depth: Option<usize> = None;
    let mut in_default = false;

    for i in 0..n {
        let t = toks[i];
        if t.nl && i > 0 {
            if (inherit || where_active) && !p.cont_prev(i - 1) && !p.cont_next(i) {
                inherit = false;
                where_active = false;
                hdr_active = false;
            }
            if in_case && frames.last() == Some(&F_ENUM) && !p.cont_prev(i - 1) {
                in_case = false;
            }
        }
        match t.kind {
            IDENT | BTICK => {
                let txt = p.text(i);
                let prev_dot = i > 0 && p.punct(i - 1, b'.');
                if t.kind == IDENT && !prev_dot {
                    match txt {
                        "func" | "init" | "subscript" => {
                            params_pending = Some(frames.len());
                            hdr_active = true;
                            let mut j = i + 1;
                            if txt == "func" {
                                j += 1;
                            } else if (p.punct(j, b'?') || p.punct(j, b'!')) && p.adj(j) {
                                j += 1;
                            }
                            if p.punct(j, b'<') {
                                if let Some(m) = match_angle(&p, j) {
                                    generic_end = m;
                                }
                            }
                        }
                        "class" | "struct" | "enum" | "protocol" | "actor" | "typealias" | "associatedtype"
                        | "extension" => {
                            let nx = p.text(i + 1);
                            let is_decl = match txt {
                                "class" => !(p.kind(i + 1) == IDENT && class_is_modifier(nx)),
                                "actor" => p.is_id(i + 1) && !p.t[i + 1].nl,
                                _ => true,
                            };
                            if is_decl {
                                hdr_active = true;
                                if txt == "enum" {
                                    enum_pending = true;
                                }
                                let mut j;
                                if txt == "extension" {
                                    p.i = i + 1;
                                    p.parse_type();
                                    type_end = type_end.max(p.i);
                                    j = p.i;
                                } else {
                                    j = i + 2;
                                    if p.punct(j, b'<') && p.adj(j) {
                                        if let Some(m) = match_angle(&p, j) {
                                            generic_end = m;
                                            j = m + 1;
                                        }
                                    }
                                }
                                if p.punct(j, b':') {
                                    colon_hdr = j;
                                } else if txt == "typealias" && p.punct(j, b'=') {
                                    p.i = j + 1;
                                    p.parse_type();
                                    type_end = type_end.max(p.i);
                                }
                            }
                        }
                        "where" => {
                            if hdr_active {
                                where_active = true;
                            }
                        }
                        "as" | "is" => {
                            let mut j = i + 1;
                            if txt == "as" && (p.punct(j, b'?') || p.punct(j, b'!')) && p.adj(j) {
                                j += 1;
                            }
                            if p.is_id(j) || p.punct(j, b'[') || p.punct(j, b'(') {
                                p.i = j;
                                p.parse_type();
                                type_end = type_end.max(p.i);
                            }
                        }
                        "if" | "guard" | "while" | "switch" | "for" => {
                            cond_depth = Some(frames.len());
                        }
                        "case" => {
                            if frames.last() == Some(&F_ENUM) {
                                in_case = true;
                                params_pending = Some(frames.len());
                            }
                        }
                        "import" => {
                            let mut j = i + 1;
                            if p.kind(j) == IDENT
                                && matches!(
                                    p.text(j),
                                    "typealias" | "struct" | "class" | "enum" | "protocol" | "let" | "var" | "func"
                                )
                                && p.is_id(j + 1)
                            {
                                j += 1;
                            }
                            while p.is_id(j) {
                                j += 1;
                                if p.punct(j, b'.') && p.is_id(j + 1) {
                                    j += 1;
                                } else {
                                    break;
                                }
                            }
                            import_until = j;
                        }
                        _ => {}
                    }
                }
                // Is this the name we look for?
                if (t.end - t.start) as usize != nb.len() || txt.as_bytes() != nb {
                    continue;
                }
                let next = i + 1;
                let top = frames.last().copied();
                let kind = 'k: {
                    if i < import_until {
                        break 'k UsageKind::Import;
                    }
                    if !prev_dot && i > 0 && toks[i - 1].kind == IDENT {
                        match p.text(i - 1) {
                            "func" | "var" | "let" | "typealias" | "associatedtype" | "protocol" | "struct"
                            | "actor" | "for" | "enum" => break 'k UsageKind::Declaration,
                            "class" if !class_is_modifier(txt) => break 'k UsageKind::Declaration,
                            "case" if top == Some(F_ENUM) => break 'k UsageKind::Declaration,
                            _ => {}
                        }
                    }
                    if i > 0 && p.punct(i - 1, b',') && in_case && top == Some(F_ENUM) {
                        break 'k UsageKind::Declaration;
                    }
                    if i >= type_end {
                        if top == Some(F_PARAMS)
                            && !in_default
                            && (p.punct(next, b':') || (p.is_id(next) && p.punct(next + 1, b':')))
                        {
                            break 'k UsageKind::Declaration;
                        }
                        if top == Some(F_PATTERN) && (p.punct(next, b',') || p.punct(next, b')')) {
                            break 'k UsageKind::Declaration;
                        }
                    }
                    if i < type_end || where_active {
                        break 'k UsageKind::Type;
                    }
                    if inherit {
                        break 'k if angle == 0 { UsageKind::Supertype } else { UsageKind::Type };
                    }
                    if i > 0 && p.punct(i - 1, b'@') {
                        break 'k UsageKind::Type;
                    }
                    if p.punct(next, b'.')
                        && p.kind(next + 1) == IDENT
                        && matches!(p.text(next + 1), "self" | "Type" | "Protocol")
                    {
                        break 'k UsageKind::Type;
                    }
                    if p.punct(next, b'(') {
                        break 'k UsageKind::Call;
                    }
                    if p.punct(next, b'{') && !p.t[next].nl && cond_depth != Some(frames.len()) {
                        break 'k UsageKind::Call;
                    }
                    if p.punct(next, b'<') && p.adj(next) && t.c.is_ascii_uppercase() {
                        p.i = i;
                        p.parse_type();
                        if p.i > next + 1 && p.punct(p.i - 1, b'>') && p.punct(p.i, b'(') {
                            break 'k UsageKind::Call;
                        }
                    }
                    UsageKind::Reference
                };
                hits.push(IdentHit {
                    start: t.start as usize,
                    end: t.end as usize,
                    kind,
                    qualifier: qualifier(&p, i),
                });
            }
            PUNCT => match t.c {
                b'{' => {
                    if cond_depth == Some(frames.len()) {
                        cond_depth = None;
                    }
                    frames.push(if enum_pending { F_ENUM } else { F_BRACE });
                    enum_pending = false;
                    inherit = false;
                    where_active = false;
                    hdr_active = false;
                    params_pending = None;
                    in_default = false;
                }
                b'}' => {
                    while let Some(&f) = frames.last() {
                        frames.pop();
                        if f == F_BRACE || f == F_ENUM {
                            break;
                        }
                    }
                    if let Some(c) = cond_depth {
                        if c > frames.len() {
                            cond_depth = None;
                        }
                    }
                    in_case = false;
                    params_pending = None;
                    in_default = false;
                    inherit = false;
                    where_active = false;
                    hdr_active = false;
                }
                b'(' => {
                    let prev_kw = if i > 0 && toks[i - 1].kind == IDENT {
                        p.text(i - 1)
                    } else {
                        ""
                    };
                    if params_pending == Some(frames.len()) {
                        params_pending = None;
                        frames.push(F_PARAMS);
                    } else if matches!(prev_kw, "let" | "var" | "for") {
                        frames.push(F_PATTERN);
                    } else if i > 0 && (p.punct(i - 1, b'{') || p.punct(i - 1, b']')) {
                        let mut f = F_PAREN;
                        if let Some(m) = match_paren(&p, i) {
                            if p.kind(m + 1) == ARROW
                                || p.kw(m + 1, "in")
                                || p.kw(m + 1, "throws")
                                || p.kw(m + 1, "async")
                            {
                                f = F_PARAMS;
                            }
                        }
                        frames.push(f);
                    } else {
                        frames.push(F_PAREN);
                    }
                    in_default = false;
                }
                b')' | b']' => {
                    while let Some(&f) = frames.last() {
                        if !is_paren_frame(f) {
                            break;
                        }
                        frames.pop();
                        if (t.c == b')' && f != F_BRACKET) || (t.c == b']' && f == F_BRACKET) {
                            break;
                        }
                    }
                    in_default = false;
                }
                b'[' => {
                    frames.push(F_BRACKET);
                    let after_operand = i > 0
                        && p.adj(i)
                        && (matches!(toks[i - 1].kind, IDENT | BTICK)
                            || (toks[i - 1].kind == PUNCT && matches!(toks[i - 1].c, b')' | b']' | b'?' | b'!')));
                    if !after_operand && i >= type_end && (p.kind(i + 1) == IDENT || p.punct(i + 1, b'[')) {
                        p.i = i;
                        p.parse_type();
                        if p.i > i + 2
                            && p.punct(p.i - 1, b']')
                            && (p.punct(p.i, b'(') || (p.punct(p.i, b'.') && p.kw(p.i + 1, "self")))
                        {
                            type_end = type_end.max(p.i);
                        }
                    }
                }
                b':' => {
                    if i == colon_hdr {
                        inherit = true;
                        angle = 0;
                    } else if i >= type_end {
                        let top = frames.last().copied();
                        let is_type = i < generic_end
                            || (top == Some(F_PARAMS) && !in_default)
                            || (matches!(top, Some(F_BRACE) | Some(F_ENUM) | None) && let_before_colon(&p, i));
                        if is_type {
                            p.i = i + 1;
                            p.parse_type();
                            type_end = type_end.max(p.i);
                        }
                    }
                }
                b'=' => {
                    if frames.last() == Some(&F_PARAMS) {
                        in_default = true;
                    }
                }
                b',' => {
                    if frames.last() == Some(&F_PARAMS) {
                        in_default = false;
                    }
                    if in_case && frames.last() == Some(&F_ENUM) {
                        params_pending = Some(frames.len());
                    }
                }
                b'<' => {
                    if inherit {
                        angle += 1;
                    } else if i > 0
                        && p.adj(i)
                        && toks[i - 1].kind == IDENT
                        && toks[i - 1].c.is_ascii_uppercase()
                        && i >= type_end
                    {
                        p.i = i - 1;
                        p.parse_type();
                        if p.i > i + 1 && p.punct(p.i - 1, b'>') && (p.punct(p.i, b'(') || p.punct(p.i, b'.')) {
                            type_end = type_end.max(p.i);
                        }
                    }
                }
                b'>' => {
                    if inherit && angle > 0 {
                        angle -= 1;
                    }
                }
                b';' => {
                    inherit = false;
                    where_active = false;
                    hdr_active = false;
                    in_case = false;
                }
                _ => {}
            },
            ARROW => {
                if i >= type_end {
                    p.i = i + 1;
                    p.parse_type();
                    type_end = type_end.max(p.i);
                }
            }
            _ => {}
        }
    }
    hits
}
