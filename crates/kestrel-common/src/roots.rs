//! Folders that the `preview://` protocol may serve files from.
//!
//! The files feature adds a workspace root when a window opens it and removes
//! it when the window closes it. It also adds the parent folder of every file
//! that the editor reads. The preview protocol refuses all other paths, so a
//! web page in the preview cannot read random files on the disk.

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn table() -> &'static RwLock<HashMap<PathBuf, usize>> {
    static ROOTS: OnceLock<RwLock<HashMap<PathBuf, usize>>> = OnceLock::new();
    ROOTS.get_or_init(Default::default)
}

/// Allows a folder. Calls are counted: two windows can open the same folder.
pub fn allow(dir: &Path) {
    let dir = crate::paths::normalize(dir);
    *table().write().entry(dir).or_insert(0) += 1;
}

/// Undoes one `allow` call for this folder.
pub fn disallow(dir: &Path) {
    let dir = crate::paths::normalize(dir);
    let mut t = table().write();
    if let Some(n) = t.get_mut(&dir) {
        *n -= 1;
        if *n == 0 {
            t.remove(&dir);
        }
    }
}

/// True when `path` is inside one of the allowed folders.
pub fn is_allowed(path: &Path) -> bool {
    let path = crate::paths::normalize(path);
    table().read().keys().any(|root| path.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_is_counted() {
        let dir = std::env::temp_dir().join("kestrel-roots-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        allow(&dir);
        allow(&dir);
        assert!(is_allowed(&file));
        disallow(&dir);
        assert!(is_allowed(&file));
        disallow(&dir);
        assert!(!is_allowed(&file));
    }
}
