//! The file index of one root and the manager that keeps the last 8 roots.

use crate::fuzzy::{self, QueryResult};
use crate::store::Store;
use crate::walk::{rel_slash, walker, Ignorer};
use ignore::WalkState;
use parking_lot::{Mutex, RwLock};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_ROOTS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    Building,
    Ready,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct IndexStatus {
    pub state: IndexState,
    /// Files in the index. While the first build runs: files found so far.
    pub count: usize,
}

/// Called when a build finishes. Arguments: root and file count.
pub type ReadyListener = Arc<dyn Fn(&Path, usize) + Send + Sync>;

const BUILDING: u8 = 0;
const READY: u8 = 1;

pub struct FileIndex {
    root: PathBuf,
    store: RwLock<Arc<Store>>,
    state: AtomicU8,
    /// Files found by the build that runs now.
    found: AtomicUsize,
    /// Each build gets a number. A build with an old number stops.
    generation: AtomicU64,
    /// Set when changes arrive during a build. The build runs once more.
    again: AtomicBool,
    /// Held while the state changes between building and ready.
    lifecycle: Mutex<()>,
    /// Only one incremental update runs at a time.
    update_lock: Mutex<()>,
    listener: Option<ReadyListener>,
}

impl FileIndex {
    fn new(root: PathBuf, listener: Option<ReadyListener>) -> Arc<Self> {
        Arc::new(FileIndex {
            root,
            store: RwLock::new(Arc::new(Store::new())),
            state: AtomicU8::new(BUILDING),
            found: AtomicUsize::new(0),
            generation: AtomicU64::new(0),
            again: AtomicBool::new(false),
            lifecycle: Mutex::new(()),
            update_lock: Mutex::new(()),
            listener,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> IndexStatus {
        if self.state.load(Ordering::SeqCst) == READY {
            IndexStatus { state: IndexState::Ready, count: self.store.read().len() }
        } else {
            IndexStatus { state: IndexState::Building, count: self.found.load(Ordering::Relaxed) }
        }
    }

    /// Fuzzy search. While the first build runs the result is empty.
    pub fn query(&self, query: &str, limit: usize) -> QueryResult {
        let store = self.store.read().clone();
        let status = self.status();
        QueryResult { items: fuzzy::search(&store, query, limit), state: status.state, count: status.count }
    }

    /// Stops a running build. It is used when the manager drops this index.
    fn stop_build(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Starts a full build in a background thread. A running build stops.
    pub fn rebuild(self: &Arc<Self>) {
        let _g = self.lifecycle.lock();
        self.start_build();
    }

    fn start_build(self: &Arc<Self>) {
        let build_no = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.state.store(BUILDING, Ordering::SeqCst);
        self.found.store(0, Ordering::Relaxed);
        let me = self.clone();
        let spawned = std::thread::Builder::new()
            .name("kestrel-index".into())
            .spawn(move || me.run_build(build_no));
        if let Err(e) = spawned {
            log::error!("cannot start index thread: {e}");
            self.state.store(READY, Ordering::SeqCst);
        }
    }

    fn run_build(self: Arc<Self>, build_no: u64) {
        let started = Instant::now();
        let stale = || self.generation.load(Ordering::SeqCst) != build_no;
        let store = build_store(&self.root, &self.found, &stale);
        if stale() {
            return;
        }
        let count = store.len();
        log::info!("indexed {count} files in {:?} ({})", started.elapsed(), self.root.display());
        {
            let _u = self.update_lock.lock();
            *self.store.write() = Arc::new(store);
        }
        {
            let _g = self.lifecycle.lock();
            if stale() {
                return;
            }
            if self.again.swap(false, Ordering::SeqCst) {
                self.start_build();
                return;
            }
            self.state.store(READY, Ordering::SeqCst);
        }
        if let Some(l) = &self.listener {
            l(&self.root, count);
        }
    }

    /// Applies changes reported by the file watcher. `paths` are absolute.
    /// This blocks while it works (a few milliseconds for normal batches).
    pub fn update(self: &Arc<Self>, paths: &[PathBuf]) {
        {
            let _g = self.lifecycle.lock();
            if self.state.load(Ordering::SeqCst) == BUILDING {
                // The running build may have missed these changes.
                self.again.store(true, Ordering::SeqCst);
                return;
            }
        }
        let _u = self.update_lock.lock();
        let build_no = self.generation.load(Ordering::SeqCst);
        let old = self.store.read().clone();
        if let Some(new) = apply_changes(&self.root, &old, paths) {
            if self.generation.load(Ordering::SeqCst) == build_no {
                *self.store.write() = Arc::new(new);
            }
        }
    }

    /// Waits until the index is ready. Used by tests.
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if self.state.load(Ordering::SeqCst) == READY {
                return true;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.state.load(Ordering::SeqCst) == READY
    }

    /// Replaces the content. Used by tests and benchmarks.
    #[doc(hidden)]
    pub fn set_store_for_test(&self, store: Store) {
        *self.store.write() = Arc::new(store);
        self.state.store(READY, Ordering::SeqCst);
    }
}

impl Drop for FileIndex {
    fn drop(&mut self) {
        // Stops a running build of an index that nobody uses.
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// Keeps the indexes of the last 8 roots.
pub struct IndexManager {
    indexes: Mutex<Vec<Arc<FileIndex>>>,
    listener: Option<ReadyListener>,
}

impl IndexManager {
    pub fn new(listener: Option<ReadyListener>) -> Self {
        IndexManager { indexes: Mutex::new(Vec::new()), listener }
    }

    /// Returns the index of `root`. Starts the first build when it is new.
    pub fn get_or_start(&self, root: &Path) -> Arc<FileIndex> {
        let mut list = self.indexes.lock();
        if let Some(pos) = list.iter().position(|i| i.root == root) {
            let idx = list.remove(pos);
            list.push(idx.clone());
            return idx;
        }
        let idx = FileIndex::new(root.to_path_buf(), self.listener.clone());
        idx.rebuild();
        list.push(idx.clone());
        while list.len() > MAX_ROOTS {
            // The build thread holds its own Arc, so a drop alone would not stop it.
            list.remove(0).stop_build();
        }
        idx
    }

    pub fn get(&self, root: &Path) -> Option<Arc<FileIndex>> {
        self.indexes.lock().iter().find(|i| i.root == root).cloned()
    }

    pub fn len(&self) -> usize {
        self.indexes.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Per-thread buffer for the parallel walk. It hands its content over when
/// the walk thread ends.
struct Local<'a> {
    store: Store,
    unflushed: usize,
    found: &'a AtomicUsize,
    out: &'a Mutex<Vec<Store>>,
}

impl Local<'_> {
    fn push(&mut self, rel: &str) {
        self.store.push(rel);
        self.unflushed += 1;
        if self.unflushed >= 512 {
            self.found.fetch_add(self.unflushed, Ordering::Relaxed);
            self.unflushed = 0;
        }
    }
}

impl Drop for Local<'_> {
    fn drop(&mut self) {
        self.found.fetch_add(self.unflushed, Ordering::Relaxed);
        let store = std::mem::take(&mut self.store);
        self.out.lock().push(store);
    }
}

fn is_file_entry(e: &ignore::DirEntry) -> bool {
    match e.file_type() {
        Some(ft) if ft.is_file() => true,
        Some(ft) if ft.is_symlink() => e.path().is_file(),
        _ => false,
    }
}

fn build_store(root: &Path, found: &AtomicUsize, stale: &(dyn Fn() -> bool + Sync)) -> Store {
    let out: Mutex<Vec<Store>> = Mutex::new(Vec::new());
    walker(root).build_parallel().run(|| {
        let mut local = Local { store: Store::new(), unflushed: 0, found, out: &out };
        Box::new(move |res| {
            if stale() {
                return WalkState::Quit;
            }
            if let Ok(e) = res {
                if is_file_entry(&e) {
                    if let Some(rel) = rel_slash(root, e.path()) {
                        local.push(&rel);
                    }
                }
            }
            WalkState::Continue
        })
    });
    if stale() {
        return Store::new();
    }
    let parts = std::mem::take(&mut *out.lock());
    merge_sorted(parts)
}

/// Joins the per-thread stores into one sorted store.
fn merge_sorted(parts: Vec<Store>) -> Store {
    let total: usize = parts.iter().map(|p| p.len()).sum();
    let bytes: usize = parts.iter().map(|p| p.bytes()).sum();
    let mut all: Vec<&str> = Vec::with_capacity(total);
    for p in &parts {
        all.extend(p.iter());
    }
    all.par_sort_unstable();
    all.dedup();
    let mut s = Store::with_capacity(all.len(), bytes);
    for p in all {
        s.push(p);
    }
    s
}

/// Builds a new store from `old` and the changed paths. Returns `None` when
/// nothing changes.
fn apply_changes(root: &Path, old: &Store, paths: &[PathBuf]) -> Option<Store> {
    let mut ign = Ignorer::new(root);
    // Paths to drop from the old store (exact match).
    let mut drop_exact: HashSet<String> = HashSet::new();
    // Folder prefixes (`dir/`) to drop.
    let mut drop_prefix: Vec<String> = Vec::new();
    let mut added: Vec<String> = Vec::new();

    for p in paths {
        let Some(rel) = rel_slash(root, p) else { continue };
        if rel.is_empty() || rel.split('/').any(|c| c == ".git") {
            continue;
        }
        match std::fs::symlink_metadata(p) {
            Err(_) => {
                // Removed. It can be a file or a whole folder.
                let prefix = format!("{rel}/");
                if old.has_prefix(&prefix) {
                    drop_prefix.push(prefix);
                }
                drop_exact.insert(rel);
            }
            Ok(md) if md.is_dir() => {
                // Files inside a known folder report their own changes.
                // A folder without entries is new (or renamed): walk it.
                if !old.has_prefix(&format!("{rel}/")) && !ign.is_ignored(p, true) {
                    for entry in walker(p).build().flatten() {
                        if is_file_entry(&entry) {
                            if let Some(r) = rel_slash(root, entry.path()) {
                                added.push(r);
                            }
                        }
                    }
                }
            }
            Ok(md) => {
                let is_file = md.is_file() || (md.file_type().is_symlink() && p.is_file());
                drop_exact.insert(rel.clone());
                if is_file && !ign.is_ignored(p, false) {
                    added.push(rel);
                }
            }
        }
    }
    if drop_exact.is_empty() && drop_prefix.is_empty() && added.is_empty() {
        return None;
    }

    added.sort_unstable();
    added.dedup();
    // Sorted prefixes without nested ones allow one binary search per path.
    drop_prefix.sort_unstable();
    let mut prefixes: Vec<String> = Vec::new();
    for p in drop_prefix {
        if !prefixes.last().is_some_and(|last| p.starts_with(last.as_str())) {
            prefixes.push(p);
        }
    }
    let dropped = |path: &str| -> bool {
        if drop_exact.contains(path) {
            return true;
        }
        let i = prefixes.partition_point(|p| p.as_str() <= path);
        i > 0 && path.starts_with(prefixes[i - 1].as_str())
    };

    let mut out = Store::with_capacity(old.len() + added.len(), old.bytes());
    let mut a = added.iter().peekable();
    for existing in old.iter() {
        while let Some(next) = a.peek() {
            if next.as_str() < existing {
                out.push(next);
                a.next();
            } else {
                break;
            }
        }
        if !dropped(existing) {
            out.push(existing);
        }
    }
    for rest in a {
        out.push(rest);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn all(idx: &FileIndex) -> Vec<String> {
        idx.store.read().iter().map(String::from).collect()
    }

    fn built(root: &Path) -> Arc<FileIndex> {
        let mgr = IndexManager::new(None);
        let idx = mgr.get_or_start(root);
        assert!(idx.wait_ready(Duration::from_secs(10)));
        idx
    }

    #[test]
    fn build_respects_gitignore_and_skips_git() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "target/\n*.log\n");
        write(r, "src/main.rs", "");
        write(r, "src/.hidden", "");
        write(r, "target/out.bin", "");
        write(r, "a.log", "");
        write(r, ".git/config", "");
        write(r, "docs/日本語 ファイル.md", "");
        let idx = built(r);
        assert_eq!(
            all(&idx),
            vec![".gitignore", "docs/日本語 ファイル.md", "src/.hidden", "src/main.rs"]
        );
        assert_eq!(idx.status().count, 4);
        assert_eq!(idx.status().state, IndexState::Ready);
    }

    #[test]
    fn query_finds_non_ascii_names() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "docs/日本語.md", "");
        write(d.path(), "src/other.rs", "");
        let idx = built(d.path());
        let res = idx.query("日本", 10);
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].path, "docs/日本語.md");
        assert_eq!(res.items[0].indices, vec![5, 6]);
    }

    #[test]
    fn update_adds_removes_and_handles_folders() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "build/\n");
        write(r, "a/one.txt", "");
        write(r, "a/two.txt", "");
        write(r, "b/three.txt", "");
        let idx = built(r);

        write(r, "a/new.txt", "");
        write(r, "build/skip.txt", "");
        fs::remove_file(r.join("a/one.txt")).unwrap();
        idx.update(&[r.join("a/new.txt"), r.join("build/skip.txt"), r.join("a/one.txt")]);
        assert_eq!(all(&idx), vec![".gitignore", "a/new.txt", "a/two.txt", "b/three.txt"]);

        // A removed folder drops everything inside.
        fs::remove_dir_all(r.join("a")).unwrap();
        idx.update(&[r.join("a")]);
        assert_eq!(all(&idx), vec![".gitignore", "b/three.txt"]);

        // A new folder is walked.
        write(r, "c/d/x.txt", "");
        write(r, "c/y.txt", "");
        idx.update(&[r.join("c")]);
        assert_eq!(all(&idx), vec![".gitignore", "b/three.txt", "c/d/x.txt", "c/y.txt"]);

        // Same file twice, and a path outside the root, change nothing.
        idx.update(&[r.join("c/y.txt"), r.join("c/y.txt"), PathBuf::from("/definitely/outside")]);
        assert_eq!(all(&idx).len(), 4);
        // Changes inside .git are ignored.
        write(r, ".git/HEAD", "");
        idx.update(&[r.join(".git/HEAD")]);
        assert_eq!(all(&idx).len(), 4);
    }

    #[test]
    fn update_respects_nested_gitignore() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "pkg/.gitignore", "build_no/\n");
        write(r, "pkg/a.txt", "");
        let idx = built(r);
        write(r, "pkg/build_no/out.txt", "");
        write(r, "pkg/b.txt", "");
        idx.update(&[r.join("pkg/build_no/out.txt"), r.join("pkg/b.txt")]);
        assert_eq!(all(&idx), vec!["pkg/.gitignore", "pkg/a.txt", "pkg/b.txt"]);
    }

    #[test]
    fn rebuild_picks_up_everything() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "a.txt", "");
        let idx = built(r);
        write(r, "b.txt", "");
        idx.rebuild();
        assert!(idx.wait_ready(Duration::from_secs(10)));
        assert_eq!(all(&idx), vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn manager_keeps_eight_roots() {
        let mgr = IndexManager::new(None);
        let dirs: Vec<_> = (0..9).map(|_| tempfile::tempdir().unwrap()).collect();
        for d in &dirs {
            mgr.get_or_start(d.path());
        }
        assert_eq!(mgr.len(), 8);
        assert!(mgr.get(dirs[0].path()).is_none());
        assert!(mgr.get(dirs[8].path()).is_some());
    }

    #[test]
    fn dropped_index_stops_its_build() {
        let mgr = IndexManager::new(None);
        let dirs: Vec<_> = (0..9).map(|_| tempfile::tempdir().unwrap()).collect();
        let first = mgr.get_or_start(dirs[0].path());
        let before = first.generation.load(Ordering::SeqCst);
        for d in &dirs[1..] {
            mgr.get_or_start(d.path());
        }
        // The manager dropped the first index. Its running build must see a new generation.
        assert!(first.generation.load(Ordering::SeqCst) > before);
    }

    #[test]
    fn listener_is_called_when_ready() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.txt", "");
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let mgr = IndexManager::new(Some(Arc::new(move |_, n| {
            h.store(n, Ordering::SeqCst);
        })));
        let idx = mgr.get_or_start(d.path());
        assert!(idx.wait_ready(Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn empty_folder_is_ready_with_zero_files() {
        let d = tempfile::tempdir().unwrap();
        let idx = built(d.path());
        assert_eq!(idx.status().count, 0);
        assert!(idx.query("x", 5).items.is_empty());
    }

    /// Run: KESTREL_BENCH_DIR=/some/big/folder cargo test -p kestrel-search --release -- --ignored --nocapture bench_real
    #[test]
    #[ignore]
    fn bench_real_walk() {
        let Some(dir) = std::env::var_os("KESTREL_BENCH_DIR") else { return };
        let t = Instant::now();
        let idx = built(Path::new(&dir));
        println!("walk + sort: {:?}, {} files", t.elapsed(), idx.status().count);
        let t = Instant::now();
        let r = idx.query("mainrs", 100);
        println!("query: {:?}, first: {:?}", t.elapsed(), r.items.first().map(|h| &h.path));
    }
}
