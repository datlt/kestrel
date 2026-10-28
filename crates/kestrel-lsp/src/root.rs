//! Project root detection and a stable hash for root paths.

use std::path::{Path, PathBuf};

/// Finds the nearest folder (from the folder of `file` up to `workspace_root`)
/// that holds one of the `markers` (file or folder names).
/// It never looks above `workspace_root`. Returns `None` when `file` is not
/// inside `workspace_root` or no folder has a marker.
pub fn find_root(file: &Path, markers: &[String], workspace_root: &Path) -> Option<PathBuf> {
    let file = kestrel_common::paths::normalize(file);
    let top = kestrel_common::paths::normalize(workspace_root);
    if !file.starts_with(&top) {
        return None;
    }
    let mut dir = if file.is_dir() { Some(file.as_path()) } else { file.parent() };
    while let Some(d) = dir {
        if !d.starts_with(&top) {
            break;
        }
        if markers.iter().any(|m| !m.is_empty() && d.join(m).exists()) {
            return Some(d.to_path_buf());
        }
        if d == top {
            break;
        }
        dir = d.parent();
    }
    None
}

/// FNV-1a 64 bit hash of a path, as 16 hex digits. It stays the same between
/// runs and Rust versions, so it is safe to use in folder names on disk.
pub fn root_hash(root: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in root.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn markers(m: &[&str]) -> Vec<String> {
        m.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_nearest_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let module = ws.join("app").join("my module");
        let src = module.join("src").join("main");
        fs::create_dir_all(&src).unwrap();
        fs::write(ws.join("settings.gradle"), "").unwrap();
        fs::write(module.join("build.gradle"), "").unwrap();
        let file = src.join("日本語.kt");
        fs::write(&file, "").unwrap();
        let m = markers(&["settings.gradle", "build.gradle"]);
        let root = find_root(&file, &m, ws).unwrap();
        assert_eq!(root, kestrel_common::paths::normalize(&module));
    }

    #[test]
    fn stops_at_workspace_root() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path();
        let ws = outer.join("ws");
        fs::create_dir_all(ws.join("src")).unwrap();
        // The marker is above the workspace root: it must be ignored.
        fs::write(outer.join("pom.xml"), "").unwrap();
        let file = ws.join("src").join("A.java");
        fs::write(&file, "").unwrap();
        assert_eq!(find_root(&file, &markers(&["pom.xml"]), &ws), None);
        fs::write(ws.join("pom.xml"), "").unwrap();
        assert_eq!(find_root(&file, &markers(&["pom.xml"]), &ws), Some(kestrel_common::paths::normalize(&ws)));
    }

    #[test]
    fn file_outside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let other = tmp.path().join("other");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("pom.xml"), "").unwrap();
        let file = other.join("A.java");
        fs::write(&file, "").unwrap();
        assert_eq!(find_root(&file, &markers(&["pom.xml"]), &ws), None);
    }

    #[test]
    fn hash_is_stable() {
        assert_eq!(root_hash(""), "cbf29ce484222325");
        assert_eq!(root_hash("/a/b"), root_hash("/a/b"));
        assert_ne!(root_hash("/a/b"), root_hash("/a/c"));
    }
}
