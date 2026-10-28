use super::*;
use kestrel_common::process;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Once};
use tempfile::TempDir;

const AUTH_JSON: &str = r#"{"hosts":{
 "github.example.test":[{"state":"success","active":true,"host":"github.example.test","login":"octo","tokenSource":"keyring","token":"SECRET-TOKEN-1","scopes":"gist, read:org, repo"}],
 "GHE.example.test":[
   {"state":"error","active":true,"host":"GHE.example.test","login":"ent","tokenSource":"keyring","error":"token expired","token":"SECRET-TOKEN-2"},
   {"state":"success","active":false,"host":"GHE.example.test","login":"ent2","scopes":["repo"]}]
}}"#;

/// Reads the login shell environment once. Without it, every child process
/// would wait for the environment (up to 5 seconds).
fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        process::init_shell_env();
        let _ = process::shell_env();
    });
}

struct Fake {
    dir: TempDir,
    gh: Gh,
}

impl Fake {
    /// A fake `gh` shell script. `api_body` runs for `gh api ...`. Every
    /// call writes its arguments to `args.log`.
    fn new(api_body: &str) -> Fake {
        let script = format!(
            r#"#!/bin/sh
D=$(dirname "$0")
echo "$@" >> "$D/args.log"
case "$1" in
  --version) echo "gh version 2.97.0 (2026-07-31)"; exit 0;;
  auth) case "$2" in
      status) cat "$D/auth.json"; exit 0;;
      *) exit 0;;
    esac;;
  api) :;;
  *) exit 0;;
esac
{api_body}
"#
        );
        Self::with_script(&script)
    }

    fn with_script(script: &str) -> Fake {
        init();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("auth.json"), AUTH_JSON).unwrap();
        let path = dir.path().join("gh");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        Fake { gh: Gh::with_program(&path), dir }
    }

    fn api_calls(&self) -> Vec<String> {
        let log = std::fs::read_to_string(self.dir.path().join("args.log")).unwrap_or_default();
        log.lines().filter(|l| l.starts_with("api")).map(str::to_string).collect()
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
}

fn req(path: &str) -> ApiRequest {
    ApiRequest { host: "github.example.test".into(), path: path.into(), method: None, body: None, paginate: None }
}

fn response(status_line: &str, body: &str) -> String {
    format!("printf 'HTTP/2.0 {status_line}\\r\\nContent-Type: application/json\\r\\nX-Test: 1\\r\\n\\r\\n%s' '{body}'")
}

// ---- status ---------------------------------------------------------------------------------

#[test]
fn status_reads_accounts_and_never_returns_a_token() {
    let f = Fake::new("");
    let s = f.gh.status(&Job::default()).unwrap();
    assert!(s.installed);
    assert_eq!(s.version.as_deref(), Some("2.97.0"));
    assert_eq!(s.accounts.len(), 3);
    let octo = s.accounts.iter().find(|a| a.login == "octo").unwrap();
    assert_eq!(octo.scopes, vec!["gist", "read:org", "repo"]);
    assert_eq!(octo.state, "success");
    assert!(octo.active);
    let broken = s.accounts.iter().find(|a| a.login == "ent").unwrap();
    assert_eq!(broken.state, "error");
    assert_eq!(broken.error.as_deref(), Some("token expired"));
    assert!(broken.active);
    let text = serde_json::to_string(&s).unwrap();
    assert!(!text.contains("SECRET"), "token leaked: {text}");
    assert!(!text.contains("\"token\""), "token field leaked: {text}");
    // The scopes can be a list too.
    assert_eq!(s.accounts.iter().find(|a| a.login == "ent2").unwrap().scopes, vec!["repo"]);
    let log = std::fs::read_to_string(f.file("args.log")).unwrap();
    assert!(!log.contains("show-token"));
    assert!(log.contains("auth status --json hosts"));
}

#[test]
fn status_with_a_missing_program_is_not_installed() {
    init();
    let gh = Gh::with_program("/nonexistent/kestrel-gh-test/gh");
    let s = gh.status(&Job::default()).unwrap();
    assert!(!s.installed);
    assert!(s.version.is_none());
    assert!(s.accounts.is_empty());
    let e = gh.api(&req("user"), &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_missing");
    let e = gh.switch("github.example.test", "octo", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_missing");
}

#[test]
fn switch_and_logout_run_gh_auth() {
    let f = Fake::new("");
    f.gh.switch("github.example.test", "octo", &Job::default()).unwrap();
    // The host is written as `gh` lists it.
    f.gh.logout("ghe.example.test", "ent", &Job::default()).unwrap();
    let log = std::fs::read_to_string(f.file("args.log")).unwrap();
    assert!(log.contains("auth switch --hostname github.example.test --user octo"));
    assert!(log.contains("auth logout --hostname GHE.example.test --user ent"));
    let e = f.gh.switch("github.example.test", "--oops", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "invalid_input");
    let e = f.gh.switch("nope.example.test", "octo", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "invalid_input");
}

#[test]
fn switch_failure_gives_gh_error() {
    let f = Fake::with_script(
        "#!/bin/sh\nD=$(dirname \"$0\")\ncase \"$1\" in --version) echo 'gh version 2.97.0 (x)';; auth) if [ \"$2\" = status ]; then cat \"$D/auth.json\"; else echo 'no such account' >&2; exit 1; fi;; esac\n",
    );
    let e = f.gh.switch("github.example.test", "octo", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_error");
    assert!(e.to_string().contains("no such account"));
}

#[test]
fn status_is_cached_for_the_host_check() {
    let f = Fake::new(&response("200 OK", "{}"));
    f.gh.api(&req("user"), &Job::default()).unwrap();
    f.gh.api(&req("user"), &Job::default()).unwrap();
    let log = std::fs::read_to_string(f.file("args.log")).unwrap();
    assert_eq!(log.lines().filter(|l| l.starts_with("auth status")).count(), 1);
}

// ---- api ------------------------------------------------------------------------------------

#[test]
fn api_get_reads_status_headers_and_json() {
    let f = Fake::new(&response("200 OK", r#"{"login":"octo","n":[1,2]}"#));
    let v = f.gh.api(&req("repos/o/r/pulls/1?state=open"), &Job::default()).unwrap();
    assert_eq!(v["login"], "octo");
    assert_eq!(v["n"][1], 2);
    let calls = f.api_calls();
    assert_eq!(calls, vec!["api --hostname github.example.test -X GET -i repos/o/r/pulls/1?state=open"]);
}

#[test]
fn api_empty_answer_is_null() {
    let f = Fake::new("printf 'HTTP/2.0 204 No Content\\r\\nX-A: b\\r\\n\\r\\n'");
    let v = f.gh.api(&ApiRequest { method: Some("DELETE".into()), ..req("repos/o/r/x") }, &Job::default()).unwrap();
    assert!(v.is_null());
}

#[test]
fn api_post_sends_the_body_on_stdin() {
    let f = Fake::new(&format!("cat > \"$D/body.json\"\n{}", response("201 Created", r#"{"id":7}"#)));
    let r = ApiRequest { method: Some("post".into()), body: Some(json!({"body":"hi"})), ..req("repos/o/r/issues/1/comments") };
    let v = f.gh.api(&r, &Job::default()).unwrap();
    assert_eq!(v["id"], 7);
    assert_eq!(std::fs::read_to_string(f.file("body.json")).unwrap(), r#"{"body":"hi"}"#);
    assert_eq!(f.api_calls(), vec!["api --hostname github.example.test -X POST -i --input - repos/o/r/issues/1/comments"]);
}

#[test]
fn api_paginate_joins_pages() {
    let f = Fake::new("echo '[[{\"n\":1},{\"n\":2}],[{\"n\":3}],[]]'");
    let r = ApiRequest { paginate: Some(true), ..req("repos/o/r/pulls/1/files?per_page=100") };
    let v = f.gh.api(&r, &Job::default()).unwrap();
    let ns: Vec<i64> = v.as_array().unwrap().iter().map(|x| x["n"].as_i64().unwrap()).collect();
    assert_eq!(ns, vec![1, 2, 3]);
    let call = &f.api_calls()[0];
    assert!(call.contains("--paginate --slurp"), "{call}");
}

#[test]
fn api_paginate_error_uses_the_status_in_the_error_text() {
    let f = Fake::new("echo '{\"message\":\"Not Found\"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1");
    let e = f.gh.api(&ApiRequest { paginate: Some(true), ..req("repos/o/r/x") }, &Job::default()).unwrap_err();
    assert_eq!(e.code(), "not_found");
    assert_eq!(e.to_string(), "HTTP 404: Not Found");
}

#[test]
fn api_maps_http_errors() {
    let cases = [
        ("401 Unauthorized", r#"{"message":"Bad credentials"}"#, "gh_auth", "HTTP 401: Bad credentials"),
        ("404 Not Found", r#"{"message":"Not Found"}"#, "not_found", "HTTP 404: Not Found"),
        ("500 Internal Server Error", r#"{"message":"Boom"}"#, "gh_error", "HTTP 500: Boom"),
        (
            "422 Unprocessable Entity",
            r#"{"message":"Validation Failed","errors":[{"resource":"Review","code":"custom","message":"line must be part of the diff"},"plain"]}"#,
            "gh_error",
            "HTTP 422: Validation Failed: line must be part of the diff; plain",
        ),
        ("502 Bad Gateway", "<html>oops</html>", "gh_error", "HTTP 502: Bad Gateway"),
    ];
    for (line, body, code, text) in cases {
        let f = Fake::new(&format!("{}\nexit 1", response(line, body)));
        let e = f.gh.api(&req("repos/o/r"), &Job::default()).unwrap_err();
        assert_eq!(e.code(), code, "{line}");
        assert_eq!(e.to_string(), text, "{line}");
    }
}

#[test]
fn api_failure_without_a_status_uses_the_error_text() {
    let f = Fake::new("echo 'error connecting to github.example.test' >&2; exit 1");
    let e = f.gh.api(&req("user"), &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_error");
    assert!(e.to_string().contains("error connecting"));
    let f = Fake::new("echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4");
    assert_eq!(f.gh.api(&req("user"), &Job::default()).unwrap_err().code(), "gh_auth");
}

#[test]
fn api_checks_its_input() {
    let f = Fake::new(&response("200 OK", "{}"));
    let job = Job::default();
    let bad_paths = [
        "https://evil.example/user",
        "/user",
        "repos/../admin",
        "repos/o/%2e%2e/x",
        "repos/o/r/./x",
        "",
        "-X",
        "repos/o/r x",
        "repos/{owner}/r",
        "repos/o/r#frag",
        "user?a=b c",
    ];
    for p in bad_paths {
        assert_eq!(f.gh.api(&req(p), &job).unwrap_err().code(), "invalid_input", "path {p:?}");
    }
    let e = f.gh.api(&ApiRequest { host: "evil.example.test".into(), ..req("user") }, &job).unwrap_err();
    assert_eq!(e.code(), "invalid_input");
    let e = f.gh.api(&ApiRequest { method: Some("TRACE".into()), ..req("user") }, &job).unwrap_err();
    assert_eq!(e.code(), "invalid_input");
    let e = f.gh.api(&ApiRequest { paginate: Some(true), method: Some("POST".into()), ..req("user") }, &job).unwrap_err();
    assert_eq!(e.code(), "invalid_input");
    let e = f.gh.api(&ApiRequest { body: Some(json!({})), ..req("user") }, &job).unwrap_err();
    assert_eq!(e.code(), "invalid_input");
    // The host check is not case sensitive and the query may have `[]` and `%`.
    let ok = ApiRequest { host: "GITHUB.example.test".into(), ..req("search/issues?q=a%20b&x[]=1") };
    f.gh.api(&ok, &job).unwrap();
    // Nothing reached `gh api` for the bad input.
    assert_eq!(f.api_calls().len(), 1);
}

// ---- graphql --------------------------------------------------------------------------------

#[test]
fn graphql_sends_query_and_variables_and_returns_data() {
    let f = Fake::new("cat > \"$D/body.json\"\necho '{\"data\":{\"viewer\":{\"login\":\"octo\"}}}'");
    let v = f.gh.graphql("github.example.test", "query KestrelViewer($n:Int){viewer{login}}", &json!({"n": 3}), &Job::default()).unwrap();
    assert_eq!(v["viewer"]["login"], "octo");
    let sent: Value = serde_json::from_str(&std::fs::read_to_string(f.file("body.json")).unwrap()).unwrap();
    assert_eq!(sent["variables"]["n"], 3);
    assert!(sent["query"].as_str().unwrap().starts_with("query KestrelViewer"));
    assert_eq!(f.api_calls(), vec!["api graphql --hostname github.example.test --input -"]);
}

#[test]
fn graphql_errors_give_gh_error_with_joined_messages() {
    let f = Fake::new("echo '{\"data\":null,\"errors\":[{\"message\":\"first\"},{\"message\":\"second\"}]}'; echo 'gh: first' >&2; exit 1");
    let e = f.gh.graphql("github.example.test", "query KestrelX{a}", &json!({}), &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_error");
    assert_eq!(e.to_string(), "first; second");
    // An HTTP error without `errors`.
    let f = Fake::new("echo '{\"message\":\"Bad credentials\"}'; echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1");
    let e = f.gh.graphql("github.example.test", "query KestrelX{a}", &json!({}), &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_auth");
    assert_eq!(e.to_string(), "HTTP 401: Bad credentials");
}

// ---- file text ------------------------------------------------------------------------------

fn raw_body(body_cmd: &str) -> String {
    format!("printf 'HTTP/2.0 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\n'\n{body_cmd}")
}

#[test]
fn file_text_reads_utf8_and_encodes_the_path() {
    let f = Fake::new(&raw_body("printf 'h\\303\\251llo\\nworld'"));
    let t = f.gh.file_text("github.example.test", "o", "r", "src/a b/\u{65e5}.ts", "feature/x y", &Job::default()).unwrap();
    assert_eq!(t, "h\u{e9}llo\nworld");
    let call = &f.api_calls()[0];
    assert!(call.contains("-H Accept: application/vnd.github.raw"), "{call}");
    assert!(call.ends_with("repos/o/r/contents/src/a%20b/%E6%97%A5.ts?ref=feature%2Fx%20y"), "{call}");
}

#[test]
fn file_text_rejects_binary_and_big_files() {
    let f = Fake::new(&raw_body("printf '\\377\\376abc'"));
    let e = f.gh.file_text("github.example.test", "o", "r", "a.bin", "main", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "binary");
    let f = Fake::new(&raw_body("printf 'ab\\000cd'"));
    let e = f.gh.file_text("github.example.test", "o", "r", "a.bin", "main", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "binary");
    let f = Fake::new(&raw_body("head -c 5300000 /dev/zero | tr '\\000' 'a'"));
    let e = f.gh.file_text("github.example.test", "o", "r", "big.txt", "main", &Job::default()).unwrap_err();
    assert_eq!(e.code(), "too_large");
    // Just under 5 MB is fine.
    let f = Fake::new(&raw_body("head -c 5242880 /dev/zero | tr '\\000' 'a'"));
    assert_eq!(f.gh.file_text("github.example.test", "o", "r", "ok.txt", "main", &Job::default()).unwrap().len(), 5 * 1024 * 1024);
}

#[test]
fn file_text_maps_errors_and_checks_input() {
    let f = Fake::new(&format!("{}\nexit 1", response("404 Not Found", r#"{"message":"Not Found"}"#)));
    let job = Job::default();
    assert_eq!(f.gh.file_text("github.example.test", "o", "r", "x.txt", "main", &job).unwrap_err().code(), "not_found");
    for (o, r, p, rf) in [("o/x", "r", "a", "m"), ("o", "..", "a", "m"), ("o", "r", "a/../b", "m"), ("o", "r", "", "m"), ("o", "r", "a", "-x")] {
        let e = f.gh.file_text("github.example.test", o, r, p, rf, &job).unwrap_err();
        assert_eq!(e.code(), "invalid_input", "{o} {r} {p} {rf}");
    }
}

// ---- remotes --------------------------------------------------------------------------------

#[test]
fn parses_remote_urls() {
    let want = |h: &str| Some((h.to_string(), "o".to_string(), "r".to_string()));
    assert_eq!(parse_url("https://github.com/o/r.git"), want("github.com"));
    assert_eq!(parse_url("https://github.com/o/r"), want("github.com"));
    assert_eq!(parse_url("https://github.com/o/r/"), want("github.com"));
    assert_eq!(parse_url("https://user:pw@GitHub.com:8443/o/r.git"), want("github.com"));
    assert_eq!(parse_url("http://ghe.example.test/o/r"), want("ghe.example.test"));
    assert_eq!(parse_url("git@github.com:o/r.git"), want("github.com"));
    assert_eq!(parse_url("git@github.com:o/r"), want("github.com"));
    assert_eq!(parse_url("git@OSS.Example.Test:o/r.git"), want("oss.example.test"));
    assert_eq!(parse_url("github.com:o/r"), want("github.com"));
    assert_eq!(parse_url("ssh://git@github.com/o/r.git"), want("github.com"));
    assert_eq!(parse_url("ssh://git@ghe.example.test:2222/o/r"), want("ghe.example.test"));
    assert_eq!(parse_url("ssh://ghe.example.test/o/r.git"), want("ghe.example.test"));
    // A repository can be called "x.github.io" or have a dot.
    assert_eq!(parse_url("git@github.com:o/r.name.git").unwrap().2, "r.name");
    // Not repository addresses.
    for bad in ["", "/home/me/repo", "C:\\repo", "C:/repo", "file:///tmp/r", "https://github.com/o", "https://github.com/o/r/extra", "git@github.com:r", "ftp://h/o/r"] {
        assert_eq!(parse_url(bad), None, "{bad}");
    }
}

#[test]
fn origin_comes_first_in_the_remote_list() {
    let text = "up\thttps://github.com/a/b.git (fetch)\nup\thttps://github.com/a/b.git (push)\n\
                origin\tgit@ghe.example.test:o/r.git (fetch)\norigin\tgit@ghe.example.test:o/r.git (push)\n\
                local\t/tmp/x (fetch)\nzed\tssh://git@github.com:22/c/d (fetch)\n";
    let list = parse_remotes(text);
    let names: Vec<&str> = list.iter().map(|r| r.remote.as_str()).collect();
    assert_eq!(names, vec!["origin", "up", "zed"]);
    assert_eq!(list[0].host, "ghe.example.test");
}

fn git_repo(remotes: &[(&str, &str)]) -> TempDir {
    init();
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let ok = process::command("git").args(args).current_dir(dir.path()).status().unwrap().success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    for (n, u) in remotes {
        git(&["remote", "add", n, u]);
    }
    dir
}

#[test]
fn repo_of_keeps_only_hosts_with_a_login() {
    let f = Fake::new("");
    let job = Job::default();
    let repo = git_repo(&[("up", "git@github.example.test:a/b.git"), ("origin", "https://elsewhere.example/x/y.git")]);
    let r = f.gh.repo_of(repo.path(), &job).unwrap().unwrap();
    assert_eq!(r, RepoRef { host: "github.example.test".into(), owner: "a".into(), name: "b".into(), remote: "up".into() });
    let repo = git_repo(&[("up", "git@github.example.test:a/b.git"), ("origin", "ssh://git@ghe.example.test:2222/o/r.git")]);
    let r = f.gh.repo_of(repo.path(), &job).unwrap().unwrap();
    assert_eq!((r.remote.as_str(), r.host.as_str(), r.name.as_str()), ("origin", "ghe.example.test", "r"));
    let repo = git_repo(&[("origin", "https://elsewhere.example/x/y.git")]);
    assert_eq!(f.gh.repo_of(repo.path(), &job).unwrap(), None);
    let repo = git_repo(&[]);
    assert_eq!(f.gh.repo_of(repo.path(), &job).unwrap(), None);
    // Not a repository, and not a folder.
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(f.gh.repo_of(plain.path(), &job).unwrap(), None);
    assert_eq!(f.gh.repo_of(&plain.path().join("nope"), &job).unwrap_err().code(), "not_found");
}

// ---- pull request checkout ------------------------------------------------------------------

#[test]
fn pr_checkout_returns_the_output_and_maps_failure() {
    let f = Fake::with_script(
        "#!/bin/sh\nD=$(dirname \"$0\")\necho \"$@ in $(pwd)\" >> \"$D/args.log\"\nif [ -f \"$D/fail\" ]; then printf 'error: Your local changes would be overwritten\\nPlease commit.\\n' >&2; exit 1; fi\necho out-line; echo err-line >&2\n",
    );
    let work = tempfile::tempdir().unwrap();
    let text = f.gh.pr_checkout(work.path(), 12, &Job::default()).unwrap();
    assert_eq!(text, "out-line\nerr-line");
    let log = std::fs::read_to_string(f.file("args.log")).unwrap();
    assert!(log.contains("pr checkout 12 in "), "{log}");
    std::fs::write(f.file("fail"), "").unwrap();
    let e = f.gh.pr_checkout(work.path(), 12, &Job::default()).unwrap_err();
    assert_eq!(e.code(), "gh_error");
    assert!(e.to_string().contains("Your local changes would be overwritten\nPlease commit."), "{e}");
    assert_eq!(f.gh.pr_checkout(work.path(), 0, &Job::default()).unwrap_err().code(), "invalid_input");
    assert_eq!(f.gh.pr_checkout(&work.path().join("x"), 1, &Job::default()).unwrap_err().code(), "not_found");
}

// ---- cancel and timeout ---------------------------------------------------------------------

#[test]
fn cancel_kills_the_process() {
    let f = Fake::new("sleep 30");
    let job = Arc::new(Job::default());
    // Fill the status cache first, so the cancel hits `gh api`.
    f.gh.status(&Job::default()).unwrap();
    let j = job.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        j.cancel();
    });
    let t = Instant::now();
    let e = f.gh.api(&req("user"), &job).unwrap_err();
    assert_eq!(e.code(), "cancelled");
    assert!(t.elapsed() < Duration::from_secs(10));
    // A cancelled job stays cancelled.
    assert_eq!(f.gh.api(&req("user"), &job).unwrap_err().code(), "cancelled");
}

#[test]
fn timeout_kills_the_process() {
    init();
    let mut cmd = process::command("sleep");
    cmd.arg("30");
    let t = Instant::now();
    let e = run::run(cmd, None, Duration::from_millis(300), &Job::default(), "gh_missing", "gh").unwrap_err();
    assert_eq!(e.code(), "gh_error");
    assert!(e.to_string().contains("did not answer"));
    assert!(t.elapsed() < Duration::from_secs(10));
}

// ---- the fake gh program of scripts/fake-gh -------------------------------------------------

#[test]
fn works_with_scripts_fake_gh() {
    if std::process::Command::new("node").arg("--version").output().is_err() {
        return;
    }
    init();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fake-gh");
    let fixtures = tempfile::tempdir().unwrap();
    let put = |rel: &str, text: &str| {
        let p = fixtures.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    };
    std::fs::copy(root.join("fixtures/auth-status.json"), fixtures.path().join("auth-status.json")).unwrap();
    put("rest/GET/repos__o__r__pulls.json", r#"[{"n":1},{"n":2}]"#);
    put("rest/GET/repos__o__r__pulls.2.json", r#"[{"n":3}]"#);
    put("rest/GET/repos__o__r__down.json", r#"{"$status":500,"$body":{"message":"Server Error"}}"#);
    put("rest/GET/repos__o__r__contents__a b.txt.json", "");
    put("rest/GET/repos__o__r__contents__src__a.ts@abc.txt", "export {}\n");
    put("rest/POST/repos__o__r__pulls__1__reviews.json", r#"{"id":99}"#);
    put("graphql/KestrelPulls.json", r#"{"data":{"search":{"issueCount":2}}}"#);
    put("graphql/KestrelResolve.json", r#"{"data":{"x":1}}"#);
    put("graphql/KestrelBroken.json", r#"{"data":null,"errors":[{"message":"nope"}]}"#);
    // `node` runs the script through its first line.
    let program = std::fs::canonicalize(root.join("gh.mjs")).unwrap();
    let wrapper = fixtures.path().join("gh");
    std::fs::write(&wrapper, format!("#!/bin/sh\nKESTREL_FAKE_GH_DIR='{}' exec node '{}' \"$@\"\n", fixtures.path().display(), program.display())).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let gh = Gh::with_program(&wrapper);
    let job = Job::default();

    let s = gh.status(&job).unwrap();
    assert_eq!(s.accounts.len(), 2);
    assert_eq!(s.accounts[0].host, "ghe.example.test");
    assert_eq!(gh.api(&req("repos/o/r/pulls?per_page=1"), &job).unwrap(), json!([{"n":1},{"n":2}]));
    let all = gh.api(&ApiRequest { paginate: Some(true), ..req("repos/o/r/pulls") }, &job).unwrap();
    assert_eq!(all, json!([{"n":1},{"n":2},{"n":3}]));
    assert_eq!(gh.api(&req("repos/o/r/missing"), &job).unwrap_err().code(), "not_found");
    assert_eq!(gh.api(&req("repos/o/r/down"), &job).unwrap_err().to_string(), "HTTP 500: Server Error");
    assert_eq!(gh.file_text("github.example.test", "o", "r", "src/a.ts", "abc", &job).unwrap(), "export {}\n");
    let post = ApiRequest { method: Some("POST".into()), body: Some(json!({"event":"COMMENT"})), ..req("repos/o/r/pulls/1/reviews") };
    assert_eq!(gh.api(&post, &job).unwrap()["id"], 99);
    assert_eq!(gh.graphql("github.example.test", "query KestrelPulls($q:String!){search{issueCount}}", &json!({}), &job).unwrap()["search"]["issueCount"], 2);
    gh.graphql("ghe.example.test", "mutation KestrelResolve{x}", &json!({"id":"T"}), &job).unwrap();
    let e = gh.graphql("github.example.test", "query KestrelBroken{x}", &json!({}), &job).unwrap_err();
    assert_eq!((e.code(), e.to_string().as_str()), ("gh_error", "nope"));
    let writes = std::fs::read_to_string(fixtures.path().join("writes.log")).unwrap();
    assert_eq!(writes.lines().count(), 2);
    assert!(writes.contains(r#""method":"POST","path":"repos/o/r/pulls/1/reviews","body":{"event":"COMMENT"}"#), "{writes}");
    gh.switch("github.example.test", "octo-fake", &job).unwrap();
    let work = tempfile::tempdir().unwrap();
    assert!(gh.pr_checkout(work.path(), 5, &job).unwrap().contains("pull request 5"));
    let log = std::fs::read_to_string(fixtures.path().join("gh.log")).unwrap();
    assert!(log.contains("auth switch --hostname github.example.test --user octo-fake") && log.contains("pr checkout 5"), "{log}");
}
