//! Input checks. Everything that goes into a `gh` command line passes here first.

use kestrel_common::{Error, Result};

pub const METHODS: [&str; 5] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

pub fn method(m: Option<&str>) -> Result<&'static str> {
    let m = m.unwrap_or("GET").trim().to_ascii_uppercase();
    METHODS
        .iter()
        .copied()
        .find(|x| *x == m)
        .ok_or_else(|| Error::invalid(format!("unsupported HTTP method: {m}")))
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@/%".contains(c)
}

fn is_query_char(c: char) -> bool {
    is_path_char(c) || c == '?' || c == '[' || c == ']'
}

/// True when the segment is `..` or `.`, also when it is written with `%2e`.
fn is_dot_segment(seg: &str) -> bool {
    let plain = seg.replace("%2e", ".").replace("%2E", ".");
    plain == ".." || plain == "."
}

/// A REST path like `repos/o/r/pulls/1?state=open`. It is relative, has no
/// scheme, no `..` and only URL path and query characters.
pub fn path(p: &str) -> Result<()> {
    if p.is_empty() {
        return Err(Error::invalid("the path is empty"));
    }
    if p.contains("://") {
        return Err(Error::invalid("the path must not be a full address"));
    }
    if p.starts_with('/') {
        return Err(Error::invalid("the path must not start with /"));
    }
    if p.starts_with('-') {
        return Err(Error::invalid("the path must not start with -"));
    }
    let (path_part, query) = match p.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (p, None),
    };
    if !path_part.chars().all(is_path_char) {
        return Err(Error::invalid("the path has a character that is not allowed"));
    }
    if let Some(q) = query {
        if !q.chars().all(is_query_char) {
            return Err(Error::invalid("the query has a character that is not allowed"));
        }
    }
    if path_part.split('/').any(is_dot_segment) {
        return Err(Error::invalid("the path must not have . or .. segments"));
    }
    Ok(())
}

/// A login name: letters, digits, `-`, `_` and `.`. It never starts with `-`.
pub fn login(l: &str) -> Result<()> {
    let ok = !l.is_empty()
        && !l.starts_with('-')
        && l.len() <= 100
        && l.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if ok { Ok(()) } else { Err(Error::invalid(format!("not a valid login: {l}"))) }
}

/// An owner or repository name.
pub fn name(n: &str) -> Result<()> {
    let ok = !n.is_empty()
        && n != "."
        && n != ".."
        && n.len() <= 200
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if ok { Ok(()) } else { Err(Error::invalid(format!("not a valid owner or repository name: {n}"))) }
}

/// Percent-encodes everything except the unreserved characters of RFC 3986.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
