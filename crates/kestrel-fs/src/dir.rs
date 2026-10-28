//! Folder listing and file operations (create, rename, delete).

use crate::file::io_err;
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use kestrel_common::{Error, Result, error::codes};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Matched by a .gitignore rule (or inside an ignored folder).
    /// For a compact row this is the state of the deepest folder.
    pub ignored: bool,
    /// Compact folders: the names of the folders below this one that the row
    /// joins with it. Example: entry `src` with `["main", "java"]` is one row
    /// `src/main/java`. Missing when the folder is not joined with anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<Vec<String>>,
    /// How the row joins the names: `slash` or `dot` (folders inside a Java source root).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_style: Option<&'static str>,
}

/// Options of `list_dir_with`.
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    /// Join a folder with its only child folder, again and again.
    pub compact: bool,
    /// `files.exclude` globs. Excluded entries do not count when a folder is checked for joining.
    pub exclude: Vec<String>,
}

/// With more child folders than this, the look-ahead is skipped (it would read too many folders).
pub const MAX_COMPACT_DIRS: usize = 500;
/// A chain never gets longer than this.
const MAX_CHAIN: usize = 32;
/// Folder names that are source roots when they sit inside `src/<source set>/`.
const SOURCE_ROOTS: [&str; 5] = ["java", "kotlin", "scala", "groovy", "resources"];

/// A path like `src/main/java`: the last name is a source root, two levels up is `src`.
fn is_source_root(comps: &[String]) -> bool {
    let n = comps.len();
    n >= 3 && comps[n - 3] == "src" && SOURCE_ROOTS.contains(&comps[n - 1].as_str())
}

/// Is the last folder of `comps` a source root or inside one?
fn in_source_root(comps: &[String]) -> bool {
    (3..=comps.len()).any(|n| is_source_root(&comps[..n]))
}

/// Simple glob matcher for `files.exclude`. It follows `src/features/files/exclude.ts`:
/// `**` matches any number of folders, `*` and `?` work inside one name, `{a,b}` is a choice.
/// A pattern without a slash matches the name at any depth.
pub struct Excluder {
    patterns: Vec<Vec<String>>,
}

fn expand_braces(glob: &str) -> Vec<String> {
    let Some(open) = glob.find('{') else { return vec![glob.to_string()] };
    let mut depth = 0;
    let mut close = None;
    let mut commas = vec![];
    for (i, c) in glob[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + i);
                    break;
                }
            }
            ',' if depth == 1 => commas.push(open + i),
            _ => {}
        }
    }
    let Some(close) = close else { return vec![glob.to_string()] };
    let (head, tail) = (&glob[..open], &glob[close + 1..]);
    let mut starts = vec![open + 1];
    starts.extend(commas.iter().map(|c| c + 1));
    let mut ends = commas.clone();
    ends.push(close);
    let mut out = Vec::new();
    for (s, e) in starts.into_iter().zip(ends) {
        out.extend(expand_braces(&format!("{head}{}{tail}", &glob[s..e])));
    }
    out
}

fn match_name(pat: &[char], name: &[char]) -> bool {
    match pat.split_first() {
        None => name.is_empty(),
        Some((&'*', rest)) => (0..=name.len()).any(|i| match_name(rest, &name[i..])),
        Some((&'?', rest)) => !name.is_empty() && match_name(rest, &name[1..]),
        Some((c, rest)) => name.first() == Some(c) && match_name(rest, &name[1..]),
    }
}

fn match_segments(pat: &[String], path: &[&str]) -> bool {
    match pat.split_first() {
        None => path.is_empty(),
        Some((p, rest)) if p == "**" => (0..=path.len()).any(|i| match_segments(rest, &path[i..])),
        Some((p, rest)) => {
            !path.is_empty()
                && match_name(&p.chars().collect::<Vec<_>>(), &path[0].chars().collect::<Vec<_>>())
                && match_segments(rest, &path[1..])
        }
    }
}

impl Excluder {
    pub fn new(globs: &[String]) -> Excluder {
        let mut patterns = Vec::new();
        for glob in globs {
            let g = glob.replace('\\', "/");
            let g = g.trim_start_matches("./").trim_start_matches('/').trim_end_matches('/').to_string();
            if g.is_empty() {
                continue;
            }
            let g = if g.contains('/') { g } else { format!("**/{g}") };
            for one in expand_braces(&g) {
                patterns.push(one.split('/').map(str::to_string).collect());
            }
        }
        Excluder { patterns }
    }

    /// `rel` is the path relative to the workspace root, with `/` separators.
    pub fn is_excluded(&self, rel: &str) -> bool {
        if self.patterns.is_empty() {
            return false;
        }
        let segs: Vec<&str> = rel.split('/').collect();
        self.patterns.iter().any(|p| match_segments(p, &segs))
    }

    fn is_excluded_path(&self, root: &Path, path: &Path) -> bool {
        match path.strip_prefix(root) {
            Ok(rel) => {
                let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                self.is_excluded(&parts.join("/"))
            }
            Err(_) => false,
        }
    }
}

/// The only visible child of `dir`, when it is a real folder (not a link).
/// Returns `None` when the folder has no entry, a file, a link or more than one entry.
fn sole_subdir(dir: &Path, root: &Path, ex: &Excluder) -> Option<(String, PathBuf)> {
    let mut found: Option<(String, PathBuf)> = None;
    for e in fs::read_dir(dir).ok()?.flatten() {
        let path = e.path();
        if ex.is_excluded_path(root, &path) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        // `file_type` does not follow links, so a link to a folder is not a folder here.
        if !e.file_type().ok()?.is_dir() {
            return None;
        }
        found = Some((e.file_name().to_string_lossy().into_owned(), path));
    }
    found
}

/// Follows the chain of only-child folders below `start`.
/// `parent_comps` are the names from the root to the listed folder (the root name comes first).
/// Returns the names below `start`, the deepest path and the style.
fn follow_chain(start: &Path, parent_comps: &[String], root: &Path, ex: &Excluder) -> Option<(Vec<String>, PathBuf, &'static str)> {
    let dot = in_source_root(parent_comps);
    let mut comps = parent_comps.to_vec();
    comps.push(start.file_name()?.to_string_lossy().into_owned());
    // The chain stops after a source root, so a source root never joins with what is inside.
    if !dot && is_source_root(&comps) {
        return None;
    }
    let mut cur = start.to_path_buf();
    let mut names = Vec::new();
    while names.len() < MAX_CHAIN {
        let Some((name, path)) = sole_subdir(&cur, root, ex) else { break };
        comps.push(name.clone());
        names.push(name);
        cur = path;
        if !dot && is_source_root(&comps) {
            break;
        }
    }
    if names.is_empty() { None } else { Some((names, cur, if dot { "dot" } else { "slash" })) }
}

/// Case-insensitive order where digit groups compare as numbers: `a2` < `a10`.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
                // Same number: fewer leading zeros first.
                let ord = na.len().cmp(&nb.len());
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// The .gitignore files on the way from the root down to one folder.
struct IgnoreChain {
    /// Index 0 is the root folder, the last one is the listed folder.
    levels: Vec<Gitignore>,
    /// `.git/info/exclude` and the global ignore file.
    extra: Vec<Gitignore>,
}

impl IgnoreChain {
    fn build(root: &Path, dir: &Path) -> IgnoreChain {
        let mut dirs = vec![root.to_path_buf()];
        if let Ok(rel) = dir.strip_prefix(root) {
            let mut cur = root.to_path_buf();
            for c in rel.components() {
                cur.push(c);
                dirs.push(cur.clone());
            }
        }
        let levels = dirs
            .iter()
            .map(|d| {
                let mut b = GitignoreBuilder::new(d);
                let f = d.join(".gitignore");
                if f.is_file() {
                    let _ = b.add(f);
                }
                b.build().unwrap_or_else(|_| Gitignore::empty())
            })
            .collect();
        let mut extra = Vec::new();
        if root.join(".git").exists() {
            let mut b = GitignoreBuilder::new(root);
            let f = root.join(".git").join("info").join("exclude");
            if f.is_file() {
                let _ = b.add(f);
            }
            if let Ok(g) = b.build() {
                extra.push(g);
            }
            extra.push(Gitignore::global().0);
        }
        IgnoreChain { levels, extra }
    }

    /// Is `path` ignored, looking only at the first `depth` levels?
    fn check(&self, path: &Path, is_dir: bool, depth: usize) -> bool {
        for gi in self.levels[..depth.min(self.levels.len())].iter().rev().chain(self.extra.iter()) {
            match gi.matched(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }

    /// True when the listed folder or one of its parents (below the root) is ignored.
    fn dir_is_ignored(&self, root: &Path, dir: &Path) -> bool {
        let Ok(rel) = dir.strip_prefix(root) else { return false };
        let mut cur = root.to_path_buf();
        for (i, c) in rel.components().enumerate() {
            cur.push(c);
            if self.check(&cur, true, i + 1) {
                return true;
            }
        }
        false
    }
}

/// Lists one folder level. Folders come first, then files, in natural order.
/// `root` is the workspace root, used to find the .gitignore files.
pub fn list_dir(dir: &Path, root: &Path) -> Result<Vec<DirEntry>> {
    list_dir_with(dir, root, &ListOptions::default())
}

/// Like `list_dir`. With `opts.compact`, folders that hold only one folder
/// come back with the chain of folders below them.
pub fn list_dir_with(dir: &Path, root: &Path, opts: &ListOptions) -> Result<Vec<DirEntry>> {
    let rd = fs::read_dir(dir).map_err(|e| io_err(e, "read folder", dir))?;
    let chain = IgnoreChain::build(root, dir);
    let all_ignored = chain.dir_is_ignored(root, dir);
    let depth = chain.levels.len();

    let mut entries: Vec<DirEntry> = Vec::new();
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        let is_symlink = ft.is_symlink();
        // A link to a folder is shown as a folder. A broken link is a file.
        let is_dir = if is_symlink { fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) } else { ft.is_dir() };
        let ignored = all_ignored || chain.check(&path, is_dir, depth);
        entries.push(DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            ignored,
            compact: None,
            compact_style: None,
        });
    }
    if opts.compact {
        add_chains(&mut entries, dir, root, opts);
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// Fills `compact` for the folders of a listing.
fn add_chains(entries: &mut [DirEntry], dir: &Path, root: &Path, opts: &ListOptions) {
    // Many folders would mean many reads. The tree stays correct without joined rows.
    if entries.iter().filter(|e| e.is_dir).count() > MAX_COMPACT_DIRS {
        return;
    }
    let ex = Excluder::new(&opts.exclude);
    let mut parent_comps: Vec<String> = Vec::new();
    if let Some(n) = root.file_name() {
        parent_comps.push(n.to_string_lossy().into_owned());
    }
    if let Ok(rel) = dir.strip_prefix(root) {
        parent_comps.extend(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    }
    for e in entries.iter_mut().filter(|e| e.is_dir && !e.is_symlink) {
        if ex.is_excluded_path(root, Path::new(&e.path)) {
            continue;
        }
        let Some((names, deepest, style)) = follow_chain(Path::new(&e.path), &parent_comps, root, &ex) else { continue };
        if !e.ignored {
            if let Some(up) = deepest.parent() {
                let chain = IgnoreChain::build(root, up);
                e.ignored = chain.dir_is_ignored(root, up) || chain.check(&deepest, true, chain.levels.len());
            }
        }
        e.compact = Some(names);
        e.compact_style = Some(style);
    }
}

fn exists_no_follow(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// Creates an empty file. Missing parent folders are created. Fails when the path exists.
pub fn create_file(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(e, "create folder", parent))?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| io_err(e, "create", path))
}

/// Creates a folder and its parents. Fails when the path exists.
pub fn create_dir(path: &Path) -> Result<()> {
    if exists_no_follow(path) {
        return Err(Error::new(codes::ALREADY_EXISTS, format!("{} already exists", path.display())));
    }
    fs::create_dir_all(path).map_err(|e| io_err(e, "create folder", path))
}

/// Renames or moves. Fails when the target exists, except for a rename that
/// only changes letter case on a case-insensitive file system.
pub fn rename(from: &Path, to: &Path) -> Result<()> {
    if !exists_no_follow(from) {
        return Err(Error::not_found(format!("{} does not exist", from.display())));
    }
    if exists_no_follow(to) {
        let same = matches!((fs::canonicalize(from), fs::canonicalize(to)), (Ok(a), Ok(b)) if a == b);
        if !same {
            return Err(Error::new(codes::ALREADY_EXISTS, format!("{} already exists", to.display())));
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(e, "create folder", parent))?;
    }
    fs::rename(from, to).map_err(|e| io_err(e, "rename", from))
}

/// Moves to the trash, or deletes for good when `permanent` is true.
pub fn delete(path: &Path, permanent: bool) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| io_err(e, "delete", path))?;
    if permanent {
        let r = if meta.is_dir() {
            fs::remove_dir_all(path)
        } else {
            // On Windows a link to a folder is removed with `remove_dir`, not `remove_file`.
            // `remove_dir` on a link deletes only the link, never the folder behind it.
            fs::remove_file(path).or_else(|e| if meta.file_type().is_symlink() { fs::remove_dir(path) } else { Err(e) })
        };
        return r.map_err(|e| io_err(e, "delete", path));
    }
    trash::delete(PathBuf::from(path)).map_err(|e| Error::new(codes::IO, format!("cannot move {} to the trash: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn names(v: &[DirEntry]) -> Vec<&str> {
        v.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["file10", "File2", "file1", "a", "B", "file02", "ファイル2", "ファイル10"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["a", "B", "file1", "File2", "file02", "file10", "ファイル2", "ファイル10"]);
    }

    #[test]
    fn folders_first_sorted() {
        let d = tempdir().unwrap();
        for f in ["b.txt", "A.txt", "10.txt", "2.txt"] {
            fs::write(d.path().join(f), "").unwrap();
        }
        fs::create_dir(d.path().join("zdir")).unwrap();
        fs::create_dir(d.path().join("Adir")).unwrap();
        let l = list_dir(d.path(), d.path()).unwrap();
        assert_eq!(names(&l), ["Adir", "zdir", "2.txt", "10.txt", "A.txt", "b.txt"]);
        assert!(l[0].is_dir && !l[2].is_dir);
        assert!(l.iter().all(|e| !e.ignored));
    }

    #[test]
    fn gitignore_flags() {
        let d = tempdir().unwrap();
        let root = d.path();
        fs::write(root.join(".gitignore"), "build/\n*.log\n!keep.log\n").unwrap();
        fs::create_dir(root.join("build")).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("a.log"), "").unwrap();
        fs::write(root.join("keep.log"), "").unwrap();
        fs::write(root.join("main.rs"), "").unwrap();
        fs::write(root.join("build/out.o"), "").unwrap();
        fs::write(root.join("src/.gitignore"), "gen.rs\n").unwrap();
        fs::write(root.join("src/gen.rs"), "").unwrap();
        fs::write(root.join("src/lib.rs"), "").unwrap();
        fs::write(root.join("src/x.log"), "").unwrap();

        let l = list_dir(root, root).unwrap();
        let flag = |n: &str| l.iter().find(|e| e.name == n).unwrap().ignored;
        assert!(flag("build") && flag("a.log"));
        assert!(!flag("keep.log") && !flag("main.rs") && !flag("src"));

        let l = list_dir(&root.join("src"), root).unwrap();
        let flag = |n: &str| l.iter().find(|e| e.name == n).unwrap().ignored;
        assert!(flag("gen.rs") && flag("x.log") && !flag("lib.rs"));

        // Everything in an ignored folder is ignored.
        let l = list_dir(&root.join("build"), root).unwrap();
        assert!(l.iter().all(|e| e.ignored));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks() {
        let d = tempdir().unwrap();
        fs::create_dir(d.path().join("real")).unwrap();
        fs::write(d.path().join("f.txt"), "").unwrap();
        std::os::unix::fs::symlink(d.path().join("real"), d.path().join("link_dir")).unwrap();
        std::os::unix::fs::symlink(d.path().join("f.txt"), d.path().join("link_file")).unwrap();
        std::os::unix::fs::symlink(d.path().join("missing"), d.path().join("broken")).unwrap();
        let l = list_dir(d.path(), d.path()).unwrap();
        let get = |n: &str| l.iter().find(|e| e.name == n).unwrap();
        assert!(get("link_dir").is_dir && get("link_dir").is_symlink);
        assert!(!get("link_file").is_dir && get("link_file").is_symlink);
        assert!(!get("broken").is_dir && get("broken").is_symlink);
        assert!(!get("real").is_symlink);
    }

    #[cfg(unix)]
    #[test]
    fn permanent_delete_of_a_folder_link_keeps_the_folder() {
        let d = tempdir().unwrap();
        fs::create_dir(d.path().join("real")).unwrap();
        fs::write(d.path().join("real").join("keep.txt"), "x").unwrap();
        std::os::unix::fs::symlink(d.path().join("real"), d.path().join("link_dir")).unwrap();
        delete(&d.path().join("link_dir"), true).unwrap();
        assert!(fs::symlink_metadata(d.path().join("link_dir")).is_err());
        assert!(d.path().join("real").join("keep.txt").exists());
    }

    #[test]
    fn list_missing_dir() {
        let d = tempdir().unwrap();
        assert_eq!(list_dir(&d.path().join("no"), d.path()).unwrap_err().code(), "not_found");
    }

    #[test]
    fn create_rename_delete() {
        let d = tempdir().unwrap();
        let f = d.path().join("日本語/新しい ファイル.txt");
        create_file(&f).unwrap();
        assert!(f.is_file());
        assert_eq!(create_file(&f).unwrap_err().code(), "already_exists");

        let sub = d.path().join("a/b/c");
        create_dir(&sub).unwrap();
        assert_eq!(create_dir(&sub).unwrap_err().code(), "already_exists");

        let g = d.path().join("moved.txt");
        rename(&f, &g).unwrap();
        assert!(g.is_file() && !f.exists());
        fs::write(d.path().join("other.txt"), "").unwrap();
        assert_eq!(rename(&g, &d.path().join("other.txt")).unwrap_err().code(), "already_exists");
        assert_eq!(rename(&d.path().join("nope"), &g).unwrap_err().code(), "not_found");

        delete(&g, true).unwrap();
        assert!(!g.exists());
        delete(&d.path().join("a"), true).unwrap();
        assert!(!d.path().join("a").exists());
        assert_eq!(delete(&g, true).unwrap_err().code(), "not_found");
    }

    #[test]
    fn case_only_rename() {
        let d = tempdir().unwrap();
        let a = d.path().join("readme.md");
        fs::write(&a, "x").unwrap();
        rename(&a, &d.path().join("README.md")).unwrap();
        let l = list_dir(d.path(), d.path()).unwrap();
        assert_eq!(names(&l), ["README.md"]);
    }

    // --- Compact folders ---

    fn compact(dir: &Path, root: &Path, exclude: &[&str]) -> Vec<DirEntry> {
        let opts = ListOptions { compact: true, exclude: exclude.iter().map(|s| s.to_string()).collect() };
        list_dir_with(dir, root, &opts).unwrap()
    }

    fn mk(root: &Path, rel: &str) {
        fs::create_dir_all(root.join(rel)).unwrap();
    }

    fn chain(l: &[DirEntry], name: &str) -> Option<(Vec<String>, &'static str)> {
        let e = l.iter().find(|e| e.name == name).unwrap();
        e.compact.clone().map(|c| (c, e.compact_style.unwrap()))
    }

    #[test]
    fn compact_is_off_by_default() {
        let d = tempdir().unwrap();
        mk(d.path(), "a/b/c");
        let l = list_dir(d.path(), d.path()).unwrap();
        assert!(l[0].compact.is_none());
    }

    #[test]
    fn compact_joins_only_children() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "a/b/c");
        mk(r, "x/y");
        fs::write(r.join("x/y/f.txt"), "").unwrap();
        mk(r, "m/one");
        mk(r, "m/two");
        mk(r, "withfile");
        fs::write(r.join("withfile/f.txt"), "").unwrap();
        mk(r, "empty");
        let l = compact(r, r, &[]);
        assert_eq!(chain(&l, "a"), Some((vec!["b".into(), "c".into()], "slash")));
        // The chain ends at a folder that has a file.
        assert_eq!(chain(&l, "x"), Some((vec!["y".into()], "slash")));
        // Two child folders, a file, or no entry: no chain.
        assert_eq!(chain(&l, "m"), None);
        assert_eq!(chain(&l, "withfile"), None);
        assert_eq!(chain(&l, "empty"), None);
        // The entry keeps the path of the top folder.
        assert!(l.iter().find(|e| e.name == "a").unwrap().path.ends_with("a"));
    }

    #[test]
    fn compact_json_shape() {
        let d = tempdir().unwrap();
        mk(d.path(), "a/b");
        mk(d.path(), "z");
        let l = compact(d.path(), d.path(), &[]);
        let v = serde_json::to_value(&l).unwrap();
        assert_eq!(v[0]["compact"], serde_json::json!(["b"]));
        assert_eq!(v[0]["compactStyle"], "slash");
        assert!(v[1].get("compact").is_none());
    }

    #[test]
    fn compact_breaks_after_a_source_root() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "src/main/java/com/example/app");
        let l = compact(r, r, &[]);
        assert_eq!(chain(&l, "src"), Some((vec!["main".into(), "java".into()], "slash")));
        // The source root itself does not join with what is inside.
        let l = compact(&r.join("src/main"), r, &[]);
        assert_eq!(chain(&l, "java"), None);
    }

    #[test]
    fn compact_source_root_needs_src() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "lib/main/java/com");
        let l = compact(r, r, &[]);
        // `lib/main/java` is no source root: the chain goes on.
        assert_eq!(chain(&l, "lib"), Some((vec!["main".into(), "java".into(), "com".into()], "slash")));
    }

    #[test]
    fn compact_uses_dots_below_a_source_root() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "src/test/kotlin/com/example/app/ui");
        mk(r, "src/test/kotlin/com/example/app/data");
        mk(r, "src/test/kotlin/org");
        fs::write(r.join("src/test/kotlin/org/A.kt"), "").unwrap();
        let l = compact(&r.join("src/test/kotlin"), r, &[]);
        assert_eq!(chain(&l, "com"), Some((vec!["example".into(), "app".into()], "dot")));
        assert_eq!(chain(&l, "org"), None);
        // Deeper inside a package the style stays `dot`.
        let l = compact(&r.join("src/test/kotlin/com/example/app"), r, &[]);
        assert_eq!(chain(&l, "ui"), None);
        mk(r, "src/test/kotlin/pkg/a/b");
        let l = compact(&r.join("src/test/kotlin"), r, &[]);
        assert_eq!(chain(&l, "pkg"), Some((vec!["a".into(), "b".into()], "dot")));
    }

    #[test]
    fn compact_other_source_sets() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "src/androidTest/java");
        mk(r, "src/testFixtures/resources/x");
        let l = compact(&r.join("src"), r, &[]);
        assert_eq!(chain(&l, "androidTest"), Some((vec!["java".into()], "slash")));
        assert_eq!(chain(&l, "testFixtures"), Some((vec!["resources".into()], "slash")));
    }

    #[test]
    fn compact_skips_excluded_entries() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "a/b");
        fs::write(r.join("a/.DS_Store"), "").unwrap();
        mk(r, "a/b/.git");
        let l = compact(r, r, &[]);
        assert_eq!(chain(&l, "a"), None);
        let l = compact(r, r, &["**/.DS_Store", "**/.git"]);
        assert_eq!(chain(&l, "a"), Some((vec!["b".into()], "slash")));
        // An excluded folder gets no chain.
        mk(r, "hidden/inner");
        let l = compact(r, r, &["hidden"]);
        assert_eq!(chain(&l, "hidden"), None);
    }

    #[test]
    fn compact_ignored_entries_still_count() {
        let d = tempdir().unwrap();
        let r = d.path();
        fs::write(r.join(".gitignore"), "*.log\nbuild/\n").unwrap();
        mk(r, "a/b");
        fs::write(r.join("a/x.log"), "").unwrap();
        mk(r, "out/build");
        let l = compact(r, r, &[]);
        // `x.log` is ignored, but the list shows it, so the row is not joined.
        assert_eq!(chain(&l, "a"), None);
        // The row is ignored when its deepest folder is ignored.
        let e = l.iter().find(|e| e.name == "out").unwrap();
        assert_eq!(e.compact, Some(vec!["build".to_string()]));
        assert!(e.ignored);
    }

    #[test]
    fn compact_stops_at_too_many_folders() {
        let d = tempdir().unwrap();
        let r = d.path();
        for i in 0..MAX_COMPACT_DIRS {
            mk(r, &format!("d{i:04}/inner"));
        }
        let l = compact(r, r, &[]);
        assert_eq!(l.iter().filter(|e| e.compact.is_some()).count(), MAX_COMPACT_DIRS);
        mk(r, "one-more/inner");
        let l = compact(r, r, &[]);
        assert!(l.iter().all(|e| e.compact.is_none()));
    }

    #[test]
    fn compact_chain_has_a_length_limit() {
        let d = tempdir().unwrap();
        let r = d.path();
        let deep: Vec<String> = (0..50).map(|i| format!("n{i}")).collect();
        mk(r, &deep.join("/"));
        let l = compact(r, r, &[]);
        assert_eq!(l[0].compact.as_ref().unwrap().len(), MAX_CHAIN);
    }

    #[cfg(unix)]
    #[test]
    fn compact_does_not_follow_links() {
        let d = tempdir().unwrap();
        let r = d.path();
        mk(r, "real/inner");
        mk(r, "a");
        std::os::unix::fs::symlink(r.join("real"), r.join("a/link")).unwrap();
        mk(r, "b");
        std::os::unix::fs::symlink(r.join("real"), r.join("b/link")).unwrap();
        mk(r, "z/y");
        let l = compact(r, r, &[]);
        // The only child of `a` is a link. It is not joined.
        assert_eq!(chain(&l, "a"), None);
        assert_eq!(chain(&l, "z"), Some((vec!["y".into()], "slash")));
        // A link entry itself gets no chain.
        let l = compact(&r.join("a"), r, &[]);
        assert_eq!(chain(&l, "link"), None);
    }

    #[test]
    fn exclude_globs() {
        let ex = Excluder::new(&["**/.git".into(), "*.{log,tmp}".into(), "build/gen".into(), "a/**/z".into()]);
        assert!(ex.is_excluded(".git") && ex.is_excluded("x/y/.git"));
        assert!(ex.is_excluded("q/a.log") && ex.is_excluded("b.tmp") && !ex.is_excluded("b.txt"));
        assert!(ex.is_excluded("build/gen") && !ex.is_excluded("x/build/gen"));
        assert!(ex.is_excluded("a/z") && ex.is_excluded("a/b/c/z") && !ex.is_excluded("b/a/z"));
    }
}
