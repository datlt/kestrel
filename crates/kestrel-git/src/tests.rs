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

// --- Branch switcher ---------------------------------------------------------

#[test]
fn parse_track_forms() {
    assert_eq!(parse::parse_track(""), (0, 0, false));
    assert_eq!(parse::parse_track("[ahead 2]"), (2, 0, false));
    assert_eq!(parse::parse_track("[behind 3]"), (0, 3, false));
    assert_eq!(parse::parse_track("[ahead 2, behind 1]"), (2, 1, false));
    assert_eq!(parse::parse_track("[gone]"), (0, 0, true));
}

/// A repo with a commit on `main`, plus a bare remote named `origin`.
fn repo_with_remote() -> (Repo, tempfile::TempDir) {
    let r = Repo::new();
    r.write("a.txt", "one\n");
    r.commit_all("first");
    let remote = tempfile::tempdir().unwrap();
    let out = Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).arg(remote.path()).output().unwrap();
    assert!(out.status.success());
    r.git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
    r.git(&["push", "-q", "-u", "origin", "main"]);
    (r, remote)
}

fn commit_at(r: &Repo, file: &str, msg: &str, date: &str) {
    r.write(file, msg);
    r.git(&["add", "-A"]);
    let env = format!("{date} +0000");
    let out = Command::new("git")
        .current_dir(r.root())
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(["commit", "-q", "-m", msg])
        .env("GIT_COMMITTER_DATE", &env)
        .env("GIT_AUTHOR_DATE", &env)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn branch_list_local_remote_and_counts() {
    let (r, _remote) = repo_with_remote();
    // `feature/x` is ahead of its upstream by one commit.
    r.git(&["switch", "-q", "-c", "feature/x"]);
    r.git(&["push", "-q", "-u", "origin", "feature/x"]);
    commit_at(&r, "b.txt", "second", "2020-01-01T00:00:00");
    // `old` has no upstream and an old commit.
    r.git(&["switch", "-q", "main"]);
    r.git(&["switch", "-q", "-c", "old"]);
    commit_at(&r, "c.txt", "ancient", "2001-01-01T00:00:00");
    r.git(&["switch", "-q", "main"]);
    // `origin/only-remote` has no local branch.
    r.git(&["push", "-q", "origin", "main:only-remote"]);
    r.git(&["fetch", "-q"]);

    let list = branch_list(r.root()).unwrap();
    assert_eq!(list.current.as_deref(), Some("main"));
    assert!(!list.detached);
    assert!(list.head.is_some());
    let names: Vec<_> = list.local.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names.len(), 3, "{names:?}");
    // Newest commit first. `main` has the commit of today.
    assert_eq!(names, ["main", "feature/x", "old"]);
    let fx = &list.local[1];
    assert_eq!(fx.upstream.as_deref(), Some("origin/feature/x"));
    assert_eq!((fx.ahead, fx.behind, fx.gone), (1, 0, false));
    assert_eq!(fx.subject, "second");
    assert_eq!(fx.time, 1577836800);
    let main = list.local.iter().find(|b| b.name == "main").unwrap();
    assert!(main.current);
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!((main.ahead, main.behind), (0, 0));
    let old = list.local.iter().find(|b| b.name == "old").unwrap();
    assert_eq!(old.upstream, None);
    assert_eq!(old.subject, "ancient");

    let remote: Vec<_> = list.remote.iter().map(|b| b.name.as_str()).collect();
    assert!(remote.contains(&"origin/only-remote"), "{remote:?}");
    assert!(remote.contains(&"origin/feature/x"));
    assert!(!remote.iter().any(|n| n.ends_with("/HEAD")));
    let ro = list.remote.iter().find(|b| b.name == "origin/only-remote").unwrap();
    assert_eq!(ro.remote, "origin");
    assert_eq!(ro.subject, "first");
}

#[test]
fn branch_list_behind_and_gone() {
    let (r, remote) = repo_with_remote();
    // Another clone pushes a commit to main and deletes `topic`.
    r.git(&["switch", "-q", "-c", "topic"]);
    r.git(&["push", "-q", "-u", "origin", "topic"]);
    r.git(&["switch", "-q", "main"]);
    let other = tempfile::tempdir().unwrap();
    let st = Command::new("git").args(["clone", "-q"]).arg(remote.path()).arg(other.path()).output().unwrap();
    assert!(st.status.success());
    let g = |args: &[&str]| {
        let o = Command::new("git")
            .current_dir(other.path())
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    std::fs::write(other.path().join("n.txt"), "n").unwrap();
    g(&["add", "-A"]);
    g(&["commit", "-q", "-m", "remote work"]);
    g(&["push", "-q", "origin", "main"]);
    g(&["push", "-q", "origin", ":topic"]);

    let git = Git::new();
    git.fetch_with_timeout("f", r.root(), Duration::from_secs(60)).unwrap();
    let list = branch_list(r.root()).unwrap();
    let main = list.local.iter().find(|b| b.name == "main").unwrap();
    assert_eq!((main.ahead, main.behind), (0, 1));
    // `--prune` removed the remote branch, and `topic` shows as gone.
    assert!(!list.remote.iter().any(|b| b.name == "origin/topic"));
    let topic = list.local.iter().find(|b| b.name == "topic").unwrap();
    assert!(topic.gone);
}

#[test]
fn branch_list_detached_and_unborn() {
    let r = Repo::new();
    let list = branch_list(r.root()).unwrap();
    assert_eq!(list.current.as_deref(), Some("main"));
    assert_eq!(list.head, None);
    assert!(!list.detached);
    assert!(list.local.is_empty());

    r.write("a.txt", "1");
    r.commit_all("first");
    r.git(&["switch", "-q", "--detach", "HEAD"]);
    let list = branch_list(r.root()).unwrap();
    assert_eq!(list.current, None);
    assert!(list.detached);
    assert_eq!(list.head.as_deref().map(str::len), Some(7));
    assert!(list.local.iter().all(|b| !b.current));
}

#[test]
fn branch_list_is_fast_with_2000_branches() {
    use std::io::Write;
    let r = Repo::new();
    r.write("a.txt", "1");
    r.commit_all("first");
    let sha = r.git(&["rev-parse", "HEAD"]).trim().to_string();
    let mut input = String::new();
    for i in 0..2000 {
        input.push_str(&format!("create refs/heads/bulk/b{i} {sha}\n"));
    }
    let mut child = Command::new("git")
        .current_dir(r.root())
        .args(["update-ref", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    let t = std::time::Instant::now();
    let list = branch_list(r.root()).unwrap();
    let took = t.elapsed();
    assert_eq!(list.local.len(), 2001);
    assert!(took < Duration::from_secs(3), "took {took:?}");
}

#[test]
fn switch_plain_new_and_missing() {
    let r = Repo::new();
    r.write("a.txt", "1");
    r.commit_all("first");
    r.git(&["branch", "other"]);

    switch(r.root(), "other", &SwitchOptions::default()).unwrap();
    assert_eq!(branch_list(r.root()).unwrap().current.as_deref(), Some("other"));

    let opts = SwitchOptions { create: true, ..Default::default() };
    switch(r.root(), "fresh/one", &opts).unwrap();
    assert_eq!(branch_list(r.root()).unwrap().current.as_deref(), Some("fresh/one"));

    // Create from a start point.
    r.write("b.txt", "2");
    r.commit_all("second");
    let opts = SwitchOptions { create: true, start_point: Some("main".into()), ..Default::default() };
    switch(r.root(), "from-main", &opts).unwrap();
    assert!(!r.root().join("b.txt").exists());

    // A name that exists.
    let e = switch(r.root(), "other", &opts).unwrap_err();
    assert_eq!(e.code(), codes::ALREADY_EXISTS);
    // A branch that does not exist.
    let e = switch(r.root(), "nope", &SwitchOptions::default()).unwrap_err();
    assert_eq!(e.code(), codes::NOT_FOUND, "{}", e);
    // A name that looks like an option.
    let e = switch(r.root(), "--force", &SwitchOptions::default()).unwrap_err();
    assert_eq!(e.code(), codes::INVALID_INPUT);
}

#[test]
fn switch_track_remote_branch() {
    let (r, _remote) = repo_with_remote();
    r.git(&["push", "-q", "origin", "main:feature/remote"]);
    r.git(&["fetch", "-q"]);
    let opts = SwitchOptions { track: Some("origin/feature/remote".into()), ..Default::default() };
    switch(r.root(), "feature/remote", &opts).unwrap();
    let list = branch_list(r.root()).unwrap();
    assert_eq!(list.current.as_deref(), Some("feature/remote"));
    let b = list.local.iter().find(|b| b.name == "feature/remote").unwrap();
    assert_eq!(b.upstream.as_deref(), Some("origin/feature/remote"));
}

#[test]
fn switch_blocked_by_local_changes_is_conflict_and_stash_flow() {
    let r = Repo::new();
    r.write("a.txt", "base\n");
    r.commit_all("first");
    r.git(&["switch", "-q", "-c", "other"]);
    r.write("a.txt", "other\n");
    r.commit_all("other change");
    r.git(&["switch", "-q", "main"]);

    // A tracked change that conflicts with the target branch.
    r.write("a.txt", "mine\n");
    let e = switch(r.root(), "other", &SwitchOptions::default()).unwrap_err();
    assert_eq!(e.code(), codes::CONFLICT, "{}", e);
    assert!(e.to_string().contains("a.txt"), "{}", e);
    // Nothing was thrown away.
    assert_eq!(std::fs::read_to_string(r.root().join("a.txt")).unwrap(), "mine\n");
    assert_eq!(branch_list(r.root()).unwrap().current.as_deref(), Some("main"));

    // An untracked file that the target branch would overwrite.
    r.git(&["checkout", "-q", "--", "a.txt"]);
    r.git(&["switch", "-q", "other"]);
    r.write("only-other.txt", "x");
    r.commit_all("add file");
    r.git(&["switch", "-q", "main"]);
    r.write("only-other.txt", "untracked mine");
    let e = switch(r.root(), "other", &SwitchOptions::default()).unwrap_err();
    assert_eq!(e.code(), codes::CONFLICT, "{}", e);
    std::fs::remove_file(r.root().join("only-other.txt")).unwrap();

    // Stash, switch, pop.
    r.write("a.txt", "mine\n");
    r.write("new-untracked.txt", "u\n");
    let msg = format!("{STASH_PREFIX} other");
    assert!(stash_push(r.root(), &msg).unwrap().created);
    assert!(!r.root().join("new-untracked.txt").exists());
    switch(r.root(), "other", &SwitchOptions::default()).unwrap();
    switch(r.root(), "main", &SwitchOptions::default()).unwrap();
    stash_pop(r.root()).unwrap();
    assert_eq!(std::fs::read_to_string(r.root().join("a.txt")).unwrap(), "mine\n");
    assert!(r.root().join("new-untracked.txt").exists());
    assert_eq!(r.git(&["stash", "list"]).trim(), "");
}

#[test]
fn stash_edge_cases() {
    let r = Repo::new();
    r.write("a.txt", "base\n");
    r.commit_all("first");
    // Nothing to stash.
    assert!(!stash_push(r.root(), "Kestrel: before switching to x").unwrap().created);
    // No Kestrel stash.
    assert_eq!(stash_pop(r.root()).unwrap_err().code(), codes::NOT_FOUND);
    // A stash of the user is not touched.
    r.write("a.txt", "user work\n");
    r.git(&["stash", "push", "-m", "my own stash"]);
    assert_eq!(stash_pop(r.root()).unwrap_err().code(), codes::NOT_FOUND);
    // The newest Kestrel stash is used, even with a user stash on top.
    r.write("a.txt", "kestrel work\n");
    stash_push(r.root(), &format!("{STASH_PREFIX} y")).unwrap();
    r.write("a.txt", "newer user work\n");
    r.git(&["stash", "push", "-m", "another own stash"]);
    stash_pop(r.root()).unwrap();
    assert_eq!(std::fs::read_to_string(r.root().join("a.txt")).unwrap(), "kestrel work\n");
    assert_eq!(r.git(&["stash", "list"]).lines().count(), 2);
}

#[test]
fn stash_pop_conflict_reports_conflict() {
    let r = Repo::new();
    r.write("a.txt", "base\n");
    r.commit_all("first");
    r.write("a.txt", "stashed\n");
    stash_push(r.root(), &format!("{STASH_PREFIX} z")).unwrap();
    r.write("a.txt", "different\n");
    r.commit_all("other work");
    let e = stash_pop(r.root()).unwrap_err();
    assert_eq!(e.code(), codes::CONFLICT, "{}", e);
    // Git keeps the stash when it does not apply.
    assert_eq!(r.git(&["stash", "list"]).lines().count(), 1);
}

#[test]
fn validate_names() {
    let r = Repo::new();
    r.write("a.txt", "1");
    r.commit_all("first");
    let ok = |n: &str| validate_branch_name(r.root(), n).unwrap();
    assert!(ok("feature/new-thing").valid);
    assert!(ok("v1.2").valid);
    assert!(ok("日本語").valid);
    for bad in ["", " ", "a b", "a..b", "-x", "x.lock", "a~b", "a:b", "/x", "x/", "@{-1}", "HEAD", "a//b", "x."] {
        let c = ok(bad);
        assert!(!c.valid, "{bad:?} should be invalid");
        assert!(c.message.is_some());
    }
    let c = ok("main");
    assert!(!c.valid);
    assert!(c.message.unwrap().contains("already exists"));
}

#[test]
fn fetch_prunes_and_reports_errors() {
    let (r, remote) = repo_with_remote();
    r.git(&["push", "-q", "origin", "main:gone-soon"]);
    r.git(&["fetch", "-q"]);
    assert!(branch_list(r.root()).unwrap().remote.iter().any(|b| b.name == "origin/gone-soon"));
    let o = Command::new("git").current_dir(remote.path()).args(["branch", "-D", "gone-soon"]).output().unwrap();
    assert!(o.status.success());
    let git = Git::new();
    git.fetch("f", r.root()).unwrap();
    assert!(!branch_list(r.root()).unwrap().remote.iter().any(|b| b.name == "origin/gone-soon"));

    // A remote that does not exist gives an error and no password prompt.
    r.git(&["remote", "set-url", "origin", "/no/such/place"]);
    let e = git.fetch("f", r.root()).unwrap_err();
    assert_eq!(e.code(), codes::IO);
}

#[test]
fn fetch_without_remote_is_fine() {
    let r = Repo::new();
    r.write("a.txt", "1");
    r.commit_all("first");
    Git::new().fetch("f", r.root()).unwrap();
}

#[test]
fn fetch_timeout_and_cancel() {
    let (r, _remote) = repo_with_remote();
    // A slow upload-pack program makes the fetch take a long time.
    r.git(&["config", "remote.origin.uploadpack", "sleep 5 && git-upload-pack"]);
    let git = Git::new();
    let t = std::time::Instant::now();
    let e = git.fetch_with_timeout("f", r.root(), Duration::from_millis(300)).unwrap_err();
    assert_eq!(e.code(), codes::IO, "{e}");
    assert!(e.to_string().contains("longer than"), "{e}");
    assert!(t.elapsed() < Duration::from_secs(4));

    let git = Arc::new(Git::new());
    let g2 = git.clone();
    let root = r.root().to_path_buf();
    let h = std::thread::spawn(move || g2.fetch("fc", &root));
    std::thread::sleep(Duration::from_millis(400));
    git.cancel("fc");
    let e = h.join().unwrap().unwrap_err();
    assert_eq!(e.code(), codes::CANCELLED);
}
