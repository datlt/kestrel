//! JSON files in the app data folder: recent folders, per-folder sessions, global state.

use kestrel_common::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_RECENT: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentFolder {
    pub path: String,
    pub name: String,
    pub last_opened_ms: i64,
}

pub struct Store {
    dir: PathBuf,
    // One lock for all files. The files are small and writes are rare.
    lock: Mutex<()>,
}

/// Stable 64-bit hash (FNV-1a) for session file names. `DefaultHasher` may change between Rust versions.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Reads a JSON file. A missing or broken file gives `None`.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("ignoring broken state file {}: {e}", path.display());
            None
        }
    }
}

/// Writes a temp file first, then renames it, so a crash never leaves half a file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Store {
        Store { dir: dir.into(), lock: Mutex::new(()) }
    }

    fn recent_file(&self) -> PathBuf {
        self.dir.join("recent.json")
    }
    fn global_file(&self) -> PathBuf {
        self.dir.join("state.json")
    }
    fn session_file(&self, root: &str) -> PathBuf {
        self.dir.join("sessions").join(format!("{:016x}.json", fnv1a(root)))
    }

    pub fn recent_list(&self) -> Vec<RecentFolder> {
        let _g = self.lock.lock();
        read_json(&self.recent_file()).unwrap_or_default()
    }

    /// Puts a folder at the top of the list.
    pub fn recent_add(&self, path: &str, name: &str) -> Result<()> {
        let _g = self.lock.lock();
        let mut list: Vec<RecentFolder> = read_json(&self.recent_file()).unwrap_or_default();
        list.retain(|r| r.path != path);
        list.insert(0, RecentFolder { path: path.into(), name: name.into(), last_opened_ms: now_ms() });
        list.truncate(MAX_RECENT);
        write_json(&self.recent_file(), &list)
    }

    pub fn recent_remove(&self, path: &str) -> Result<()> {
        let _g = self.lock.lock();
        let mut list: Vec<RecentFolder> = read_json(&self.recent_file()).unwrap_or_default();
        list.retain(|r| r.path != path);
        write_json(&self.recent_file(), &list)
    }

    /// The saved session of a folder: tabs and per-folder state. `Null` when there is none.
    pub fn session_load(&self, root: &str) -> Value {
        let _g = self.lock.lock();
        read_json(&self.session_file(root)).unwrap_or(Value::Null)
    }

    pub fn session_save(&self, root: &str, session: &Value) -> Result<()> {
        let _g = self.lock.lock();
        write_json(&self.session_file(root), session)
    }

    /// The global state as a JSON object.
    pub fn global_load(&self) -> Map<String, Value> {
        let _g = self.lock.lock();
        read_json(&self.global_file()).unwrap_or_default()
    }

    /// Merges keys into the global state. A `null` value removes the key.
    /// Windows save only the keys they changed, so they do not overwrite each other.
    pub fn global_patch(&self, patch: Map<String, Value>) -> Result<()> {
        let _g = self.lock.lock();
        let mut state: Map<String, Value> = read_json(&self.global_file()).unwrap_or_default();
        for (k, v) in patch {
            if v.is_null() {
                state.remove(&k);
            } else {
                state.insert(k, v);
            }
        }
        write_json(&self.global_file(), &state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn recent_order_dedupe_and_limit() {
        let d = tempdir().unwrap();
        let s = Store::new(d.path());
        assert!(s.recent_list().is_empty());
        s.recent_add("/a", "a").unwrap();
        s.recent_add("/b", "b").unwrap();
        s.recent_add("/a", "a").unwrap();
        let l = s.recent_list();
        assert_eq!(l.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), ["/a", "/b"]);
        s.recent_remove("/a").unwrap();
        assert_eq!(s.recent_list().len(), 1);
        for i in 0..40 {
            s.recent_add(&format!("/f{i}"), "x").unwrap();
        }
        let l = s.recent_list();
        assert_eq!(l.len(), MAX_RECENT);
        assert_eq!(l[0].path, "/f39");
    }

    #[test]
    fn sessions_are_per_folder() {
        let d = tempdir().unwrap();
        let s = Store::new(d.path());
        assert_eq!(s.session_load("/x"), Value::Null);
        s.session_save("/x", &json!({"tabs": {"activeId": "a"}})).unwrap();
        s.session_save("/日本語/y", &json!({"n": 2})).unwrap();
        assert_eq!(s.session_load("/x")["tabs"]["activeId"], "a");
        assert_eq!(s.session_load("/日本語/y")["n"], 2);
    }

    #[test]
    fn global_patch_merges_and_removes() {
        let d = tempdir().unwrap();
        let s = Store::new(d.path());
        let m = |v: Value| v.as_object().unwrap().clone();
        s.global_patch(m(json!({"a": 1, "b": 2}))).unwrap();
        s.global_patch(m(json!({"b": null, "c": [1]}))).unwrap();
        let g = s.global_load();
        assert_eq!(g.get("a"), Some(&json!(1)));
        assert!(g.get("b").is_none());
        assert_eq!(g.get("c"), Some(&json!([1])));
    }

    #[test]
    fn broken_file_is_ignored() {
        let d = tempdir().unwrap();
        fs::write(d.path().join("state.json"), "{ not json").unwrap();
        fs::write(d.path().join("recent.json"), "[1,").unwrap();
        let s = Store::new(d.path());
        assert!(s.global_load().is_empty());
        assert!(s.recent_list().is_empty());
        s.recent_add("/a", "a").unwrap();
        assert_eq!(s.recent_list().len(), 1);
    }
}
