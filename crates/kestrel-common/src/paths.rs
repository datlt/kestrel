use std::path::{Path, PathBuf};

/// Makes a path absolute and resolves symlinks.
/// When the path does not exist, it resolves the nearest existing parent and
/// adds the rest (on macOS `/var` is a symlink to `/private/var`, so both
/// forms must give the same result).
/// On Windows it avoids the `\\?\` prefix (via `dunce`), so paths stay readable.
pub fn normalize(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|d| d.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut rest = Vec::new();
    let mut cur = abs.as_path();
    loop {
        if let Ok(p) = dunce::canonicalize(cur) {
            return rest.iter().rev().fold(p, |acc, part| acc.join(part));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return abs,
        }
    }
}

/// Path as a string with `/` separators. The frontend always uses this form
/// for paths relative to a workspace root.
pub fn to_slash(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() }
}

/// `path` relative to `root`, with `/` separators. Returns `None` when `path`
/// is not inside `root`.
pub fn relative_slash(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(to_slash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_uses_forward_slashes() {
        let root = Path::new("/a/b");
        let p = root.join("c").join("d.txt");
        assert_eq!(relative_slash(root, &p).as_deref(), Some("c/d.txt"));
        assert_eq!(relative_slash(root, Path::new("/x")), None);
    }
}
