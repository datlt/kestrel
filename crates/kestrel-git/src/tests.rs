//! Tests with real repositories made by `git init` in temp folders.

use super::*;
use std::process::Command;
use std::sync::Once;
use std::time::Duration;

fn init_env() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Do not start a login shell in tests.
        unsafe { std::env::set_var("KESTREL_SKIP_SHELL_ENV", "1") };
        kestrel_common::process::init_shell_env();
    });
}

struct Repo {
    dir: tempfile::TempDir,
}

impl Repo {
    fn new() -> Repo {
        init_env();
        let dir = tempfile::tempdir().unwrap();
        let r = Repo { dir };
        r.git(&["init", "-q", "-b", "main"]);
        r
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(self.root())
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(["-c", "core.quotepath=off", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.root().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn commit_all(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }

    fn status(&self) -> Status {
        Git::new().status("k", self.root()).unwrap()
    }
}

fn find<'a>(s: &'a Status, path: &str) -> &'a StatusEntry {
    s.entries.iter().find(|e| e.path == path).unwrap_or_else(|| panic!("no entry {path}: {:?}", s.entries))
}

#[test]
fn empty_repo_without_commits() {
    let r = Repo::new();
    let s = r.status();
    assert_eq!(s.branch.branch.as_deref(), Some("main"));
    assert_eq!(s.branch.head, None);
    assert!(!s.branch.detached);
    assert!(s.entries.is_empty());

    let info = repo_info(r.root()).unwrap();
    assert_eq!(info.branch.branch.as_deref(), Some("main"));
    assert_eq!(info.branch.head, None);
    assert!(!info.branch.detached);

    r.write("a.txt", "hi\n");
    r.git(&["add", "a.txt"]);
    r.write("b.txt", "new\n");
    let s = r.status();
    let a = find(&s, "a.txt");
    assert_eq!((a.index, a.worktree, a.staged, a.unstaged), ('A', '.', true, false));
    assert_eq!(find(&s, "b.txt").kind, EntryKind::Untracked);

    assert_eq!(show(r.root(), "HEAD", "a.txt").unwrap(), None);
    assert_eq!(show(r.root(), ":0", "a.txt").unwrap(), Some(b"hi\n".to_vec()));
    let d = diff_names(r.root(), "HEAD", None).unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].status, d[0].path.as_str()), ('A', "a.txt"));
}

#[test]
fn staged_and_unstaged_on_same_file() {
    let r = Repo::new();
    r.write("f.txt", "one\n");
    r.commit_all("first");
    r.write("f.txt", "two\n");
    r.git(&["add", "f.txt"]);
    r.write("f.txt", "three\n");
    let s = r.status();
    assert_eq!(s.entries.len(), 1);
    let e = find(&s, "f.txt");
    assert_eq!((e.index, e.worktree), ('M', 'M'));
    assert!(e.staged && e.unstaged);
    assert_eq!(show(r.root(), "HEAD", "f.txt").unwrap().unwrap(), b"one\n");
    assert_eq!(show(r.root(), ":0", "f.txt").unwrap().unwrap(), b"two\n");
}

#[test]
fn deleted_and_untracked_files() {
    let r = Repo::new();
    r.write("gone.txt", "x\n");
    r.write("keep.txt", "y\n");
    r.commit_all("c");
    std::fs::remove_file(r.root().join("gone.txt")).unwrap();
    r.write("dir/new.txt", "z\n");
    let s = r.status();
    let g = find(&s, "gone.txt");
    assert_eq!((g.index, g.worktree), ('.', 'D'));
    assert_eq!(find(&s, "dir/new.txt").kind, EntryKind::Untracked);
    assert!(!find(&s, "dir/new.txt").staged);
}

#[test]
fn rename_with_score() {
    let r = Repo::new();
    let body: String = (0..20).map(|i| format!("line {i}\n")).collect();
    r.write("old name.txt", &body);
    r.commit_all("c");
    r.git(&["mv", "old name.txt", "new name.txt"]);
    let s = r.status();
    let e = find(&s, "new name.txt");
    assert_eq!(e.kind, EntryKind::Renamed);
    assert_eq!(e.orig_path.as_deref(), Some("old name.txt"));
    assert_eq!(e.score, Some(100));
    assert_eq!(e.index, 'R');

    let d = diff_names(r.root(), "HEAD", None).unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].status, 'R');
    assert_eq!(d[0].path, "new name.txt");
    assert_eq!(d[0].orig_path.as_deref(), Some("old name.txt"));
    assert_eq!(d[0].score, Some(100));
}

#[test]
fn unicode_and_space_names() {
    let r = Repo::new();
    r.write("日本語/ファイル 名.txt", "a\n");
    r.write("é à.txt", "b\n");
    let s = r.status();
    assert!(s.entries.iter().any(|e| e.path == "日本語/ファイル 名.txt"));
    assert!(s.entries.iter().any(|e| e.path == "é à.txt"));
    r.commit_all("c");
    r.write("é à.txt", "changed\n");
    let s = r.status();
    assert_eq!(find(&s, "é à.txt").worktree, 'M');
    assert_eq!(show(r.root(), "HEAD", "日本語/ファイル 名.txt").unwrap().unwrap(), b"a\n");
    let d = diff_names(r.root(), "HEAD", None).unwrap();
    assert_eq!(d[0].path, "é à.txt");
}

#[test]
fn merge_conflict() {
    let r = Repo::new();
    r.write("c.txt", "base\n");
    r.commit_all("base");
    r.git(&["checkout", "-q", "-b", "other"]);
    r.write("c.txt", "other\n");
    r.commit_all("other");
    r.git(&["checkout", "-q", "main"]);
    r.write("c.txt", "main\n");
    r.commit_all("main");
    let out = Command::new("git")
        .current_dir(r.root())
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "other"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let s = r.status();
    let e = find(&s, "c.txt");
    assert_eq!(e.kind, EntryKind::Unmerged);
    assert_eq!((e.index, e.worktree), ('U', 'U'));
    assert!(!e.staged && !e.unstaged);
    // The index has no stage 0 while the file is in conflict.
    assert_eq!(show(r.root(), ":0", "c.txt").unwrap(), None);
    assert_eq!(show(r.root(), "HEAD", "c.txt").unwrap().unwrap(), b"main\n");
}

#[test]
fn detached_head() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("c1");
    r.write("a.txt", "2\n");
    r.commit_all("c2");
    r.git(&["checkout", "-q", "--detach", "HEAD~1"]);
    let s = r.status();
    assert!(s.branch.detached);
    assert_eq!(s.branch.branch, None);
    assert_eq!(s.branch.head.as_deref().map(str::len), Some(40));
    let info = repo_info(r.root()).unwrap();
    assert!(info.branch.detached);
    assert_eq!(info.branch.branch, None);
    assert_eq!(info.branch.head, s.branch.head);
}

#[test]
fn upstream_ahead_behind() {
    let origin = Repo::new();
    origin.write("a.txt", "1\n");
    origin.commit_all("c1");
    let clone = tempfile::tempdir().unwrap();
    init_env();
    let out = Command::new("git")
        .args(["clone", "-q"])
        .arg(origin.root())
        .arg(clone.path())
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let c = Repo { dir: clone };
    c.write("b.txt", "2\n");
    c.commit_all("local");
    origin.write("o.txt", "3\n");
    origin.commit_all("remote");
    c.git(&["fetch", "-q"]);
    let s = c.status();
    assert_eq!(s.branch.upstream.as_deref(), Some("origin/main"));
    assert_eq!((s.branch.ahead, s.branch.behind), (1, 1));
    let info = repo_info(c.root()).unwrap();
    assert_eq!(info.branch.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.branch.ahead, info.branch.behind), (1, 1));

    let b = branches(c.root()).unwrap();
    assert_eq!(b[0].name, "main");
    assert!(b[0].current && !b[0].remote);
    assert!(b.iter().any(|x| x.name == "origin/main" && x.remote));
    assert!(!b.iter().any(|x| x.name.ends_with("/HEAD")));
}

#[test]
fn merge_base_and_diff_between_refs() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("base");
    r.git(&["checkout", "-q", "-b", "feature"]);
    r.write("f.txt", "feature\n");
    r.commit_all("feature work");
    r.git(&["checkout", "-q", "main"]);
    r.write("m.txt", "main\n");
    r.commit_all("main work");
    let base_sha = r.git(&["rev-parse", "main~1"]).trim().to_string();
    assert_eq!(merge_base(r.root(), "main", "feature").unwrap(), base_sha);

    let d = diff_names(r.root(), &base_sha, Some("feature")).unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].status, d[0].path.as_str()), ('A', "f.txt"));
    // Working tree (on main) against the merge base shows what main added.
    let d = diff_names(r.root(), &base_sha, None).unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].path, "m.txt");

    let b = branches(r.root()).unwrap();
    let names: Vec<_> = b.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, vec!["main", "feature"]);
    assert_eq!(show(r.root(), "feature", "f.txt").unwrap().unwrap(), b"feature\n");
    assert_eq!(show(r.root(), "feature", "m.txt").unwrap(), None);
}

#[test]
fn no_common_ancestor() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    r.commit_all("c1");
    r.git(&["checkout", "-q", "--orphan", "lonely"]);
    r.write("b.txt", "2\n");
    r.commit_all("c2");
    let e = merge_base(r.root(), "main", "lonely").unwrap_err();
    assert_eq!(e.code(), "not_found");
}

#[test]
fn show_missing_and_binary() {
    let r = Repo::new();
    r.write("a.txt", "1\n");
    let bytes: Vec<u8> = vec![0, 159, 146, 150, 255, 0];
    std::fs::write(r.root().join("bin.dat"), &bytes).unwrap();
    r.commit_all("c");
    assert_eq!(show(r.root(), "HEAD", "nope.txt").unwrap(), None);
    assert_eq!(show(r.root(), ":0", "nope.txt").unwrap(), None);
    assert_eq!(show(r.root(), "HEAD", "bin.dat").unwrap().unwrap(), bytes);
    assert_eq!(show(r.root(), "HEAD", "a.txt").unwrap().unwrap(), b"1\n");
    assert_eq!(show(r.root(), "no-such-branch", "a.txt").unwrap_err().code(), "invalid_input");
    assert_eq!(show(r.root(), "--output=x", "a.txt").unwrap_err().code(), "invalid_input");
}

#[test]
fn works_from_a_subfolder() {
    let r = Repo::new();
    r.write("sub/a.txt", "1\n");
    r.commit_all("c");
    r.write("sub/a.txt", "2\n");
    let sub = r.root().join("sub");
    let s = Git::new().status("k", &sub).unwrap();
    assert_eq!(s.entries[0].path, "sub/a.txt");
    assert_eq!(Path::new(&s.top_level), kestrel_common::paths::normalize(r.root()));
    assert_eq!(show(&sub, "HEAD", "sub/a.txt").unwrap().unwrap(), b"1\n");
}

#[test]
fn not_a_repo_and_missing_folder() {
    init_env();
    let dir = tempfile::tempdir().unwrap();
    // Stop git from finding a repo in a parent folder of the temp dir.
    let e = Git::new().status("k", dir.path());
    if let Err(e) = e {
        assert_eq!(e.code(), "not_a_repo");
    }
    let e = repo_info(&dir.path().join("does-not-exist")).unwrap_err();
    assert_eq!(e.code(), "not_found");
}

#[test]
fn newer_status_cancels_older() {
    let r = Repo::new();
    let git = Git::new();
    let old = git.begin("a");
    let new = git.begin("a");
    assert!(old.is_cancelled());
    assert!(!new.is_cancelled());
    let e = status_with_job(r.root(), &old).unwrap_err();
    assert_eq!(e.code(), "cancelled");
    assert!(status_with_job(r.root(), &new).is_ok());
    git.cancel("a");
    assert!(new.is_cancelled());
}

#[test]
fn cancel_kills_a_running_process() {
    init_env();
    let job = Arc::new(Job::default());
    let j = job.clone();
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        j.cancel();
    });
    // A git alias that sleeps. The sleep process keeps the pipes open after
    // git is killed, so this also tests that cancel does not wait for it.
    let dir = tempfile::tempdir().unwrap();
    let start = std::time::Instant::now();
    let r = run(dir.path(), &["-c", "alias.slow=!sleep 10", "slow"], &job);
    killer.join().unwrap();
    assert_eq!(r.err().map(|e| e.code()), Some("cancelled"));
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn many_files_status() {
    let r = Repo::new();
    for i in 0..2000 {
        r.write(&format!("d{}/f{i}.txt", i % 20), "x\n");
    }
    let s = r.status();
    assert_eq!(s.entries.len(), 2000);
}

// --- history and blame -----------------------------------------------------

#[test]
fn log_follows_renames_and_pages() {
    let r = Repo::new();
    r.write("a.txt", "one\n");
    r.commit_all("first");
    r.git(&["mv", "a.txt", "b.txt"]);
    r.write("b.txt", "one\ntwo\n");
    r.commit_all("second\n\nlong body");
    r.write("b.txt", "one\ntwo\nthree\n");
    r.commit_all("third");

    let all = log(r.root(), "b.txt", 50, 0).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].subject, "third");
    assert_eq!(all[0].path, "b.txt");
    assert_eq!(all[1].subject, "second");
    assert_eq!(all[1].body, "long body");
    assert_eq!(all[1].path, "b.txt");
    assert_eq!(all[2].subject, "first");
    assert_eq!(all[2].path, "a.txt");
    assert_eq!(all[1].orig_path.as_deref(), Some("a.txt"));
    assert_eq!(all[0].orig_path, None);
    assert!(all[2].parents.is_empty());
    assert_eq!(all[1].parents, vec![all[2].sha.clone()]);
    assert_eq!(all[0].author_name, "T");
    assert_eq!(all[0].author_email, "t@example.com");
    assert!(all[0].author_time > 1_600_000_000);

    let page = log(r.root(), "b.txt", 1, 1).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].sha, all[1].sha);
}

#[test]
fn log_unicode_path_in_subfolder() {
    let r = Repo::new();
    r.write("日本語/ファイル é.txt", "x\n");
    r.commit_all("add");
    r.write("日本語/ファイル é.txt", "y\n");
    r.commit_all("change");
    // Ask from a sub folder: the path is still relative to the top level.
    let sub = r.root().join("日本語");
    let list = log(&sub, "日本語/ファイル é.txt", 10, 0).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].path, "日本語/ファイル é.txt");
}

#[test]
fn log_empty_repo_and_unknown_file() {
    let r = Repo::new();
    assert!(log(r.root(), "a.txt", 10, 0).unwrap().is_empty());
    r.write("a.txt", "x\n");
    r.commit_all("one");
    assert!(log(r.root(), "nope.txt", 10, 0).unwrap().is_empty());
}

#[test]
fn log_root_commit_and_commit_info() {
    let r = Repo::new();
    r.write("a.txt", "x\n");
    r.commit_all("root\n\nmore");
    let list = log(r.root(), "a.txt", 10, 0).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].parents.is_empty());
    let info = commit_info(r.root(), &list[0].sha).unwrap();
    assert_eq!(info.subject, "root");
    assert_eq!(info.body, "more");
    assert!(commit_info(r.root(), "--bad").is_err());
}

#[test]
fn blame_ranges_and_uncommitted() {
    let r = Repo::new();
    r.write("a.txt", "one\ntwo\nthree\n");
    r.commit_all("first");
    r.write("a.txt", "one\nTWO\nthree\n");
    r.commit_all("second");
    let sha_first = r.git(&["rev-parse", "HEAD~1"]).trim().to_string();
    let sha_second = r.git(&["rev-parse", "HEAD"]).trim().to_string();

    let b = blame(r.root(), "a.txt", None).unwrap();
    assert_eq!(b.len(), 3);
    assert_eq!((b[0].start_line, b[0].line_count, b[0].sha.as_str()), (1, 1, sha_first.as_str()));
    assert_eq!((b[1].start_line, b[1].sha.as_str()), (2, sha_second.as_str()));
    assert_eq!(b[1].summary, "second");
    assert_eq!(b[1].author, "T");
    assert_eq!(b[1].author_email, "t@example.com");
    assert_eq!(b[1].previous_sha.as_deref(), Some(sha_first.as_str()));
    assert_eq!(b[1].previous_path.as_deref(), Some("a.txt"));
    assert!(!b[1].uncommitted);
    assert_eq!(b[2].sha, sha_first);

    // Edit on disk without commit: git blames the working tree file.
    r.write("a.txt", "one\nTWO\nthree\nfour\n");
    let b = blame(r.root(), "a.txt", None).unwrap();
    let last = b.last().unwrap();
    assert!(last.uncommitted);
    assert_eq!((last.start_line, last.line_count), (4, 1));
    assert_eq!(last.author, "Not Committed Yet");
}

#[test]
fn blame_with_contents_from_stdin() {
    let r = Repo::new();
    r.write("a.txt", "one\ntwo\n");
    r.commit_all("first");
    // The disk file stays the same. The editor text has two new lines.
    let b = blame(r.root(), "a.txt", Some("one\nnew1\nnew2\ntwo\n")).unwrap();
    assert_eq!(b.len(), 3);
    assert!(!b[0].uncommitted);
    assert!(b[1].uncommitted);
    assert_eq!((b[1].start_line, b[1].line_count), (2, 2));
    assert!(!b[2].uncommitted);
    assert_eq!(b[2].start_line, 4);
}

#[test]
fn blame_errors_for_untracked_file() {
    let r = Repo::new();
    r.write("a.txt", "x\n");
    r.commit_all("one");
    r.write("new.txt", "y\n");
    let e = blame(r.root(), "new.txt", None).unwrap_err();
    assert_eq!(e.code(), codes::NOT_FOUND);
}
