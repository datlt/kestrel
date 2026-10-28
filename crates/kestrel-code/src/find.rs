//! Go to Class and Go to Symbol: IntelliJ-like matching of names (camel
//! humps, words, wildcards, qualifiers) over the types and members of the index.

use crate::callers::is_test_path;
use crate::cmodel::CMember;
use crate::derived::{TypeId, View};
use crate::diagram::params_text;
use crate::index::Index;
use crate::types::*;
use kestrel_common::{Error, Result};
use kestrel_lang::{Lang, MemberKind, TypeKind, Visibility};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as Ord_;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub const DEFAULT_LIMIT: usize = 100;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub root: String,
    pub query: String,
    pub limit: Option<usize>,
    #[serde(default)]
    pub exclude_tests: bool,
    #[serde(default)]
    pub langs: Vec<CodeLang>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeHit {
    pub name: String,
    pub qualified: String,
    pub container: String,
    pub kind: TypeKind,
    pub lang: CodeLang,
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub name_matches: Vec<u32>,
    pub container_matches: Vec<u32>,
    pub test: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKindOut {
    Method,
    Constructor,
    Field,
    Property,
    EnumCase,
    Function,
    Variable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub name: String,
    pub kind: SymbolKindOut,
    pub owner: String,
    pub owner_name: String,
    pub params: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub visibility: Visibility,
    pub lang: CodeLang,
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub name_matches: Vec<u32>,
    pub test: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult<T> {
    pub items: Vec<T>,
    pub truncated: bool,
    pub index: CodeIndexStatus,
    pub elapsed_ms: u64,
}

// --- The matcher ----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Start {
    /// The first letter of the pattern or of a word: at a hump of the name.
    Hump,
    /// The first letter after `*`: anywhere.
    Anywhere,
    /// Any other letter: next to the one before, or (upper case) at a later hump.
    Next,
}

#[derive(Clone, Debug)]
struct Item {
    c: char,
    lc: char,
    upper: bool,
    start: Start,
}

/// A compiled name pattern.
#[derive(Clone, Debug, Default)]
pub struct Pattern {
    items: Vec<Item>,
    /// The name must end where the pattern ends (trailing space).
    ends_exact: bool,
    /// The pattern has no space and no wildcard: the text of it.
    literal: Option<Vec<char>>,
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

impl Pattern {
    pub fn new(text: &str, ends_exact: bool) -> Pattern {
        let mut items = Vec::new();
        let mut start = Start::Hump;
        let mut plain = true;
        let mut pending_break = false;
        let mut wild_tail = false;
        for c in text.chars() {
            match c {
                '*' => {
                    start = Start::Anywhere;
                    plain = false;
                    wild_tail = true;
                    pending_break = false;
                }
                ' ' => {
                    if !items.is_empty() && start != Start::Anywhere {
                        pending_break = true;
                        plain = false;
                    }
                }
                _ => {
                    let s = if pending_break { Start::Hump } else { start };
                    items.push(Item { c, lc: lower(c), upper: c.is_uppercase(), start: s });
                    start = Start::Next;
                    pending_break = false;
                    wild_tail = false;
                }
            }
        }
        let literal = plain.then(|| items.iter().map(|i| i.c).collect());
        Pattern { items, ends_exact: ends_exact && !wild_tail, literal }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

fn hump_flags(name: &[char], out: &mut Vec<bool>) {
    out.clear();
    for i in 0..name.len() {
        let c = name[i];
        let h = if i == 0 {
            true
        } else if !c.is_alphanumeric() {
            false
        } else {
            let p = name[i - 1];
            !p.is_alphanumeric()
                || (c.is_uppercase() && !p.is_uppercase())
                || (c.is_uppercase() && p.is_uppercase() && name.get(i + 1).is_some_and(|n| n.is_lowercase()))
        };
        out.push(h);
    }
}

const INF: u32 = u32::MAX / 2;
/// Extra cost of a lower-case letter that jumps to a later hump (`nabs`).
const LOWER_JUMP_PENALTY: u32 = 8;

/// Buffers that the matcher reuses.
#[derive(Default)]
pub struct Scratch {
    name: Vec<char>,
    lc: Vec<char>,
    hump: Vec<bool>,
    dp: Vec<u32>,
    pred: Vec<u16>,
}

pub struct Matched {
    /// Skipped characters in the name.
    pub cost: u32,
    /// Indexes (chars) of the matched characters.
    pub idx: Vec<u16>,
}

/// Matches a pattern against a name. The best match has the fewest skipped characters.
pub fn match_name(p: &Pattern, name: &str, s: &mut Scratch) -> Option<Matched> {
    let m = p.items.len();
    if m == 0 {
        return Some(Matched { cost: 0, idx: vec![] });
    }
    s.name.clear();
    s.name.extend(name.chars());
    let n = s.name.len();
    if n < m || n > u16::MAX as usize {
        return None;
    }
    s.lc.clear();
    s.lc.extend(s.name.iter().map(|&c| lower(c)));
    let name_ref = std::mem::take(&mut s.name);
    hump_flags(&name_ref, &mut s.hump);
    s.name = name_ref;
    s.dp.clear();
    s.dp.resize(m * n, INF);
    s.pred.clear();
    s.pred.resize(m * n, 0);
    for pi in 0..m {
        let it = &p.items[pi];
        // Best previous cell: by cost, and by cost minus position (for jumps).
        let mut best_plain: (u32, u16) = (INF, 0);
        let mut best_jump: (i64, u16) = (i64::MAX, 0);
        for i in 0..n {
            // Add the cell (pi-1, i-1) to the candidates before looking at i.
            if pi > 0 && i > 0 {
                let j = i - 1;
                let v = s.dp[(pi - 1) * n + j];
                if v < INF {
                    if v < best_plain.0 {
                        best_plain = (v, j as u16);
                    }
                    let k = v as i64 - j as i64;
                    if k < best_jump.0 {
                        best_jump = (k, j as u16);
                    }
                }
            }
            if s.lc[i] != it.lc || (it.upper && !s.name[i].is_uppercase()) {
                continue;
            }
            let (cost, from) = if pi == 0 {
                match it.start {
                    Start::Hump if s.hump[i] => (i as u32, 0),
                    Start::Anywhere => (0, 0),
                    _ => continue,
                }
            } else {
                match it.start {
                    Start::Hump => {
                        if !s.hump[i] || best_jump.0 == i64::MAX {
                            continue;
                        }
                        ((best_jump.0 + i as i64 - 1) as u32, best_jump.1)
                    }
                    Start::Anywhere => {
                        if best_plain.0 >= INF {
                            continue;
                        }
                        (best_plain.0, best_plain.1)
                    }
                    Start::Next => {
                        let prev = s.dp[(pi - 1) * n + i - 1.min(i)];
                        let contiguous = if i > 0 && prev < INF { Some((prev, (i - 1) as u16)) } else { None };
                        // A letter may also jump to a later hump. A lower-case letter
                        // pays a penalty, so exact-case humps rank before it.
                        let jump = if s.hump[i] && best_jump.0 != i64::MAX {
                            let pen = if it.upper { 0 } else { LOWER_JUMP_PENALTY as i64 };
                            Some(((best_jump.0 + i as i64 - 1 + pen) as u32, best_jump.1))
                        } else {
                            None
                        };
                        match (contiguous, jump) {
                            (Some(a), Some(b)) => if a.0 <= b.0 { a } else { b },
                            (Some(a), None) => a,
                            (None, Some(b)) => b,
                            (None, None) => continue,
                        }
                    }
                }
            };
            s.dp[pi * n + i] = cost;
            s.pred[pi * n + i] = from;
        }
    }
    // The best end.
    let last = (m - 1) * n;
    let mut best: Option<(u32, usize)> = None;
    for i in 0..n {
        let v = s.dp[last + i];
        if v >= INF || (p.ends_exact && i != n - 1) {
            continue;
        }
        if best.is_none_or(|(b, _)| v < b) {
            best = Some((v, i));
        }
    }
    let (cost, mut i) = best?;
    let mut idx = vec![0u16; m];
    for pi in (0..m).rev() {
        idx[pi] = i as u16;
        i = s.pred[pi * n + i] as usize;
    }
    Some(Matched { cost, idx })
}

/// Group of a match, best first: 0 exact, 1 exact ignoring case, 2 prefix,
/// 3 starts at the name start (humps), 4 other.
fn group(p: &Pattern, name: &str, m: &Matched) -> u8 {
    if p.items.is_empty() {
        return 4;
    }
    if let Some(lit) = &p.literal {
        let n: Vec<char> = name.chars().collect();
        if n.len() == lit.len() {
            if n == *lit {
                return 0;
            }
            if n.iter().zip(lit).all(|(a, b)| lower(*a) == lower(*b)) {
                return 1;
            }
        }
    }
    if m.idx[0] == 0 {
        if m.cost == 0 && m.idx.iter().enumerate().all(|(k, &i)| i as usize == k) { 2 } else { 3 }
    } else {
        4
    }
}

/// UTF-16 offset of each char of a text.
fn utf16_offsets(chars: &[char]) -> Vec<u32> {
    let mut v = Vec::with_capacity(chars.len() + 1);
    let mut o = 0u32;
    for c in chars {
        v.push(o);
        o += c.len_utf16() as u32;
    }
    v.push(o);
    v
}

fn to_utf16(name: &str, idx: &[u16]) -> Vec<u32> {
    if name.is_ascii() {
        return idx.iter().map(|&i| i as u32).collect();
    }
    let chars: Vec<char> = name.chars().collect();
    let off = utf16_offsets(&chars);
    let mut out = Vec::new();
    for &i in idx {
        let start = off[i as usize];
        for k in 0..chars[i as usize].len_utf16() as u32 {
            out.push(start + k);
        }
    }
    out
}

// --- The query ------------------------------------------------------------------

pub struct Query {
    pub name: Pattern,
    /// Qualifier parts, in order.
    pub qual: Vec<Pattern>,
    /// The separator before the name was `#` or `.`: `Type.method`.
    pub has_qual: bool,
}

impl Query {
    pub fn parse(raw: &str, symbols: bool) -> Query {
        let ends = raw.ends_with(' ') && !raw.trim().is_empty();
        let q = raw.trim();
        let cut = q.rfind(|c| c == '.' || (symbols && c == '#'));
        let (qual_text, name_text) = match cut {
            Some(i) => (&q[..i], &q[i + 1..]),
            None => ("", q),
        };
        let qual = qual_text
            .split(['.', '#'])
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| Pattern::new(s, false))
            .collect();
        Query { name: Pattern::new(name_text, ends), qual, has_qual: cut.is_some() }
    }
}

/// A cheap check on the bytes of the lowered text: do all letters of the
/// pattern occur in order? It never rejects a name that matches.
fn may_match(p: &Pattern, name: &str) -> bool {
    let mut it = name.chars().map(lower);
    p.items.iter().all(|x| it.by_ref().any(|c| c == x.lc))
}

fn may_match_ascii(lcs: &[u8], name: &str) -> bool {
    let b = name.as_bytes();
    let mut j = 0;
    for &q in lcs {
        loop {
            if j >= b.len() {
                return false;
            }
            let c = b[j].to_ascii_lowercase();
            j += 1;
            if c == q {
                break;
            }
        }
    }
    true
}

/// Matches qualifier parts against segments in order. Returns the matched
/// chars as UTF-16 offsets in the container (`seg_off` is where each segment starts).
fn match_segments(parts: &[Pattern], segs: &[(&str, u32)], last_is_final: bool, s: &mut Scratch) -> Option<Vec<u32>> {
    let mut out = Vec::new();
    let mut next = 0usize;
    let n = parts.len();
    for (k, part) in parts.iter().enumerate() {
        let hit = if last_is_final && k == n - 1 {
            // `Type.method`: the last part is the owner itself.
            let (seg, off) = *segs.last()?;
            if segs.len() <= next {
                return None;
            }
            match_name(part, seg, s).map(|m| (segs.len() - 1, off, seg, m))
        } else {
            let end = if last_is_final { segs.len().saturating_sub(1) } else { segs.len() };
            (next..end).find_map(|i| match_name(part, segs[i].0, s).map(|m| (i, segs[i].1, segs[i].0, m)))
        };
        let (i, off, seg, m) = hit?;
        next = i + 1;
        for u in to_utf16(seg, &m.idx) {
            out.push(off + u);
        }
    }
    Some(out)
}

fn segments(text: &str, seps: &[char]) -> Vec<(String, u32)> {
    let mut v = Vec::new();
    let mut off = 0u32;
    for part in text.split(|c| seps.contains(&c)) {
        v.push((part.to_owned(), off));
        off += part.encode_utf16().count() as u32 + 1;
    }
    v
}

// --- The search ------------------------------------------------------------------

struct Cand {
    group: u8,
    vis: u8,
    cost: u32,
    len: u32,
    test: bool,
    id: u64,
}

fn vis_rank(v: Visibility) -> u8 {
    match v {
        Visibility::Public => 0,
        Visibility::Protected | Visibility::Internal | Visibility::Package => 1,
        Visibility::Private => 2,
    }
}

fn key(c: &Cand) -> (u8, u8, u32, u32, bool) {
    (c.group, c.vis, c.cost, c.len, c.test)
}

struct Filters<'a> {
    langs: &'a [CodeLang],
    exclude_tests: bool,
    root: &'a Path,
}

fn ok_lang(f: &Filters, lang: Lang) -> bool {
    f.langs.is_empty() || f.langs.contains(&lang.into())
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { Err(Error::cancelled()) } else { Ok(()) }
}

/// Cache of the test flag for each file.
struct TestFlags(Vec<u8>);

impl TestFlags {
    fn new(n: usize) -> Self {
        TestFlags(vec![0; n])
    }
    fn get(&mut self, index: &Index, f: u32) -> bool {
        let c = &mut self.0[f as usize];
        if *c == 0 {
            *c = if is_test_path(&index.root, &index.file(f).path) { 2 } else { 1 };
        }
        *c == 2
    }
}

fn container_of(v: &View, root: &Path, t: TypeId) -> String {
    let fe = v.file_of(t);
    if fe.lang == Lang::Swift {
        fe.path.parent().and_then(|p| kestrel_common::paths::relative_slash(root, p)).unwrap_or_default()
    } else {
        v.node(t).qname.rsplit_once('.').map(|(h, _)| h.to_owned()).unwrap_or_default()
    }
}

pub fn find_types(index: &Arc<Index>, req: &FindRequest, status: CodeIndexStatus, cancel: &AtomicBool) -> Result<FindResult<TypeHit>> {
    let t0 = Instant::now();
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 1000);
    let q = Query::parse(&req.query, false);
    let done = |items, truncated| FindResult { items, truncated, index: status, elapsed_ms: t0.elapsed().as_millis() as u64 };
    if q.name.is_empty() && q.qual.is_empty() {
        return Ok(done(vec![], false));
    }
    let v = index.view();
    let f = Filters { langs: &req.langs, exclude_tests: req.exclude_tests, root: &index.root };
    let mut s = Scratch::default();
    let mut tests = TestFlags::new(index.files.len());
    let ascii_q: Option<Vec<u8>> =
        q.name.items.iter().all(|i| i.lc.is_ascii()).then(|| q.name.items.iter().map(|i| i.lc as u8).collect());
    let mut cands: Vec<Cand> = Vec::new();
    for (id, node) in v.d.nodes.iter().enumerate() {
        if id % 2048 == 0 {
            check(cancel)?;
        }
        let decl = v.decl(id as TypeId);
        let name = decl.name;
        let pre = match &ascii_q {
            Some(b) => may_match_ascii(b, name),
            None => may_match(&q.name, name),
        };
        if !pre {
            continue;
        }
        let lang = v.files[node.file as usize].lang;
        if !ok_lang(&f, lang) {
            continue;
        }
        let Some(m) = match_name(&q.name, name, &mut s) else { continue };
        let test = tests.get(index, node.file);
        if f.exclude_tests && test {
            continue;
        }
        if !q.qual.is_empty() {
            let container = container_of(&v, f.root, id as TypeId);
            let mut segs = segments(&container, &['.', '/']);
            if lang == Lang::Swift {
                // Outer types count too, as segments without positions in the folder text.
                let q2 = node.qname.rsplit_once('.').map(|(h, _)| h).unwrap_or("");
                segs.extend(segments(q2, &['.']).into_iter().map(|(t, _)| (t, u32::MAX / 2)));
            }
            let refs: Vec<(&str, u32)> = segs.iter().map(|(t, o)| (t.as_str(), *o)).collect();
            if match_segments(&q.qual, &refs, false, &mut s).is_none() {
                continue;
            }
        }
        cands.push(Cand {
            group: group(&q.name, name, &m),
            vis: 0,
            cost: m.cost,
            len: name.chars().count() as u32,
            test,
            id: id as u64,
        });
    }
    check(cancel)?;
    let total = cands.len();
    let order = |a: &Cand, b: &Cand| -> Ord_ {
        key(a).cmp(&key(b)).then_with(|| v.node(a.id as TypeId).qname.cmp(&v.node(b.id as TypeId).qname))
    };
    if total > limit {
        cands.select_nth_unstable_by(limit - 1, order);
        cands.truncate(limit);
    }
    cands.sort_by(order);
    let mut items = Vec::with_capacity(cands.len());
    for c in cands {
        let id = c.id as TypeId;
        let node = v.node(id);
        let decl = v.decl(id);
        let fe = v.file_of(id);
        let container = container_of(&v, f.root, id);
        let m = match_name(&q.name, decl.name, &mut s);
        let name_matches = m.map(|m| to_utf16(decl.name, &m.idx)).unwrap_or_default();
        let mut container_matches = Vec::new();
        if !q.qual.is_empty() {
            let segs = segments(&container, &['.', '/']);
            let refs: Vec<(&str, u32)> = segs.iter().map(|(t, o)| (t.as_str(), *o)).collect();
            container_matches = match_segments(&q.qual, &refs, false, &mut s).unwrap_or_default();
        }
        items.push(TypeHit {
            name: decl.name.to_owned(),
            qualified: node.qname.clone(),
            container,
            kind: decl.kind,
            lang: fe.lang.into(),
            path: fe.path.to_string_lossy().into_owned(),
            line: decl.line,
            column: decl.column,
            name_matches,
            container_matches,
            test: c.test,
        });
    }
    Ok(done(items, total > limit))
}

/// A member found by the search: where it is.
#[derive(Clone, Copy)]
struct SymRef {
    file: u32,
    /// Index of the type in the file, or `u32::MAX` for top-level members.
    ty: u32,
    /// Fields first, then methods. For top-level: the index in `top_level`.
    member: u32,
}

fn member_of<'a>(v: &View<'a>, r: SymRef) -> &'a CMember {
    let model = &v.files[r.file as usize].model;
    if r.ty == u32::MAX {
        return &model.top_level[r.member as usize];
    }
    let t = &model.types[r.ty as usize];
    let m = r.member as usize;
    if m < t.fields.len() { &t.fields[m] } else { &t.methods[m - t.fields.len()] }
}

fn pack(r: SymRef, i: usize) -> u64 {
    let _ = i;
    ((r.file as u64) << 40) | (((r.ty & 0xFFFFF) as u64) << 20) | (r.member as u64 & 0xFFFFF)
}

fn unpack(x: u64) -> SymRef {
    let ty = ((x >> 20) & 0xFFFFF) as u32;
    SymRef { file: (x >> 40) as u32, ty: if ty == 0xFFFFF { u32::MAX } else { ty }, member: (x & 0xFFFFF) as u32 }
}

/// Owner name and the segments used by `Type.method`.
fn owner_of(v: &View, r: SymRef) -> (String, String) {
    let fe = &v.files[r.file as usize];
    if r.ty == u32::MAX {
        let stem = fe.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return (String::new(), stem);
    }
    let t = &fe.model.types[r.ty as usize];
    match v.d.file_types[r.file as usize].get(r.ty as usize).copied().flatten() {
        Some(n) => (v.node(n).qname.clone(), v.decl(n).name.to_owned()),
        None => (t.name.to_owned(), t.name.to_owned()),
    }
}

fn kind_out(m: &CMember, top: bool) -> SymbolKindOut {
    match (m.kind, top) {
        (MemberKind::Method, true) => SymbolKindOut::Function,
        (MemberKind::Method, false) => SymbolKindOut::Method,
        (MemberKind::Constructor, _) => SymbolKindOut::Constructor,
        (MemberKind::EnumCase, _) => SymbolKindOut::EnumCase,
        (MemberKind::Property, false) => SymbolKindOut::Property,
        (MemberKind::Field, false) => SymbolKindOut::Field,
        (_, true) => SymbolKindOut::Variable,
    }
}

pub fn find_symbols(index: &Arc<Index>, req: &FindRequest, status: CodeIndexStatus, cancel: &AtomicBool) -> Result<FindResult<SymbolHit>> {
    let t0 = Instant::now();
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 1000);
    let q = Query::parse(&req.query, true);
    let done = |items, truncated| FindResult { items, truncated, index: status, elapsed_ms: t0.elapsed().as_millis() as u64 };
    if q.name.is_empty() && q.qual.is_empty() {
        return Ok(done(vec![], false));
    }
    let v = index.view();
    let f = Filters { langs: &req.langs, exclude_tests: req.exclude_tests, root: &index.root };
    let mut s = Scratch::default();
    let mut tests = TestFlags::new(index.files.len());
    let ascii_q: Option<Vec<u8>> =
        q.name.items.iter().all(|i| i.lc.is_ascii()).then(|| q.name.items.iter().map(|i| i.lc as u8).collect());
    let mut cands: Vec<Cand> = Vec::new();
    let mut seen_owner: Option<(u32, u32, bool, Vec<String>)> = None;
    for (fi, fe) in index.files.iter().enumerate() {
        check(cancel)?;
        if !ok_lang(&f, fe.lang) {
            continue;
        }
        let model = &fe.model;
        let visit = |r: SymRef, m: &CMember, type_name: &str, cands: &mut Vec<Cand>, s: &mut Scratch, tests: &mut TestFlags, seen: &mut Option<(u32, u32, bool, Vec<String>)>| {
            let name: &str = if m.kind == MemberKind::Constructor { type_name } else { m.name };
            let pre = match &ascii_q {
                Some(b) => may_match_ascii(b, name),
                None => may_match(&q.name, name),
            };
            if !pre {
                return;
            }
            let Some(mm) = match_name(&q.name, name, s) else { return };
            let test = tests.get(index, fi as u32);
            if f.exclude_tests && test {
                return;
            }
            if q.has_qual && !q.qual.is_empty() {
                // `Type.method`: the owner's qualified name by parts. The last part is the owner.
                let key = (r.file, r.ty, true, Vec::<String>::new());
                let owner_segs = match seen {
                    Some(k) if k.0 == key.0 && k.1 == key.1 => k.3.clone(),
                    _ => {
                        let (qn, nm) = owner_of(&v, r);
                        let mut segs: Vec<String> = if qn.is_empty() { model.package.split('.').filter(|x| !x.is_empty()).map(|x| x.to_owned()).collect() } else { qn.split('.').map(|x| x.to_owned()).collect() };
                        if qn.is_empty() {
                            segs.push(nm);
                        }
                        *seen = Some((r.file, r.ty, true, segs.clone()));
                        segs
                    }
                };
                let refs: Vec<(&str, u32)> = owner_segs.iter().map(|t| (t.as_str(), 0)).collect();
                if match_segments(&q.qual, &refs, true, s).is_none() {
                    return;
                }
            }
            cands.push(Cand {
                group: group(&q.name, name, &mm),
                vis: vis_rank(m.visibility),
                cost: mm.cost,
                len: name.chars().count() as u32,
                test,
                id: pack(r, 0),
            });
        };
        for (ti, t) in model.types.iter().enumerate() {
            let nf = t.fields.len();
            for (mi, m) in t.fields.iter().chain(t.methods.iter()).enumerate() {
                let _ = nf;
                visit(SymRef { file: fi as u32, ty: ti as u32, member: mi as u32 }, m, t.name, &mut cands, &mut s, &mut tests, &mut seen_owner);
            }
        }
        for (mi, m) in model.top_level.iter().enumerate() {
            visit(SymRef { file: fi as u32, ty: u32::MAX, member: mi as u32 }, m, "", &mut cands, &mut s, &mut tests, &mut seen_owner);
        }
    }
    check(cancel)?;
    let total = cands.len();
    let order = |a: &Cand, b: &Cand| -> Ord_ {
        key(a).cmp(&key(b)).then_with(|| {
            let (ra, rb) = (unpack(a.id), unpack(b.id));
            let qa = (owner_of(&v, ra).0, member_of(&v, ra).name, ra.file, member_of(&v, ra).line);
            let qb = (owner_of(&v, rb).0, member_of(&v, rb).name, rb.file, member_of(&v, rb).line);
            qa.cmp(&qb)
        })
    };
    if total > limit {
        cands.select_nth_unstable_by(limit - 1, order);
        cands.truncate(limit);
    }
    cands.sort_by(order);
    let mut items = Vec::with_capacity(cands.len());
    for c in cands {
        let r = unpack(c.id);
        let m = member_of(&v, r);
        let fe = &v.files[r.file as usize];
        let (owner, owner_name) = owner_of(&v, r);
        let top = r.ty == u32::MAX;
        let type_name = if top { "" } else { fe.model.types[r.ty as usize].name };
        let name = if m.kind == MemberKind::Constructor && !top { type_name } else { m.name };
        let name_matches = match_name(&q.name, name, &mut s).map(|mm| to_utf16(name, &mm.idx)).unwrap_or_default();
        let callable = matches!(m.kind, MemberKind::Method | MemberKind::Constructor);
        items.push(SymbolHit {
            name: name.to_owned(),
            kind: kind_out(m, top),
            owner,
            owner_name,
            params: if callable { params_text(m, fe.lang) } else { String::new() },
            ty: m.ty.as_ref().map(|t| t.text.to_string()).unwrap_or_default(),
            visibility: m.visibility,
            lang: fe.lang.into(),
            path: fe.path.to_string_lossy().into_owned(),
            line: m.line,
            column: m.column,
            name_matches,
            test: c.test,
        });
    }
    Ok(done(items, total > limit))
}
