//! Runs the GitHub CLI (`gh`). See docs/DESIGN.md section 12.3.
//!
//! `gh` keeps the tokens in the system keychain and adds them to each
//! request. Kestrel never reads, stores, logs or returns a token. We never
//! pass `--show-token`, and we read only the fields we need from the JSON
//! of `gh auth status`, so a `token` field cannot get out.
//!
//! The program is `gh`, or the file in the environment variable
//! `KESTREL_GH_PROGRAM` (tests and the fake `scripts/fake-gh/gh.mjs`).

mod check;
mod remote;
pub mod run;

pub use remote::{parse_remotes, parse_url, Remote};
pub use run::Job;

use kestrel_common::error::codes;
use kestrel_common::{process, Error, Result};
use parking_lot::Mutex;
use run::Output;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const LONG_TIMEOUT: Duration = Duration::from_secs(120);
const STATUS_TTL: Duration = Duration::from_secs(10);
/// Files over this size are not read as text.
pub const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhAccount {
    pub host: String,
    pub login: String,
    pub active: bool,
    /// `success`, `error` or `timeout`.
    pub state: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub accounts: Vec<GhAccount>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub name: String,
    pub remote: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub host: String,
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub paginate: Option<bool>,
}

pub struct Gh {
    program: OsString,
    status_cache: Mutex<Option<(Instant, GhStatus)>>,
}

impl Default for Gh {
    fn default() -> Self {
        Self::new()
    }
}

/// What `gh api` answered, after the status line and headers are split off.
struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Gh {
    /// Uses `KESTREL_GH_PROGRAM` when it is set, else `gh`.
    pub fn new() -> Self {
        let program = std::env::var_os("KESTREL_GH_PROGRAM").filter(|p| !p.is_empty()).unwrap_or_else(|| "gh".into());
        Self::with_program(program)
    }

    pub fn with_program(program: impl Into<OsString>) -> Self {
        Gh { program: program.into(), status_cache: Mutex::new(None) }
    }

    fn command(&self, args: &[&str], cwd: Option<&Path>) -> Command {
        let mut cmd = process::command(&self.program);
        cmd.args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_SPINNER_DISABLED", "1")
            .env_remove("GH_FORCE_TTY");
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd
    }

    fn run_gh(&self, args: &[&str], cwd: Option<&Path>, input: Option<&[u8]>, timeout: Duration, job: &Job) -> Result<Output> {
        run::run(self.command(args, cwd), input, timeout, job, codes::GH_MISSING, "gh")
    }

    // ---- status, switch, logout ------------------------------------------------------------

    /// The `gh` version and the logged-in accounts. A broken login gives an
    /// account with `state: error`. A missing `gh` gives `installed: false`.
    pub fn status(&self, job: &Job) -> Result<GhStatus> {
        let started = Instant::now();
        let out = match self.run_gh(&["--version"], None, None, TIMEOUT, job) {
            Ok(o) => o,
            Err(e) if e.code() == codes::GH_MISSING => {
                return Ok(GhStatus { installed: false, version: None, accounts: Vec::new() });
            }
            Err(e) => return Err(e),
        };
        let version = parse_version(&String::from_utf8_lossy(&out.stdout));
        let out = self.run_gh(&["auth", "status", "--json", "hosts"], None, None, TIMEOUT, job)?;
        if !out.ok() {
            return Err(failure_message(&out));
        }
        let accounts = parse_accounts(&out.stdout)?;
        let status = GhStatus { installed: true, version, accounts };
        *self.status_cache.lock() = Some((Instant::now(), status.clone()));
        log::debug!("gh status accounts={} ms={}", status.accounts.len(), started.elapsed().as_millis());
        Ok(status)
    }

    /// The status, from the cache when it is younger than 10 seconds.
    fn cached_status(&self, job: &Job) -> Result<GhStatus> {
        if let Some((at, s)) = self.status_cache.lock().as_ref() {
            if at.elapsed() < STATUS_TTL {
                return Ok(s.clone());
            }
        }
        self.status(job)
    }

    /// Checks that `host` has a `gh` login. Returns the host as `gh` writes it.
    fn login_host(&self, host: &str, job: &Job) -> Result<String> {
        let host = host.trim();
        let find = |s: &GhStatus| s.accounts.iter().find(|a| a.host.eq_ignore_ascii_case(host)).map(|a| a.host.clone());
        let cached = self.cached_status(job)?;
        if !cached.installed {
            return Err(missing());
        }
        if let Some(h) = find(&cached) {
            return Ok(h);
        }
        // The user may have logged in a moment ago. Look once more.
        let fresh = self.status(job)?;
        find(&fresh).ok_or_else(|| Error::invalid(format!("no gh login for the host: {host}")))
    }

    pub fn switch(&self, host: &str, login: &str, job: &Job) -> Result<()> {
        self.auth_change("switch", host, login, job)
    }

    pub fn logout(&self, host: &str, login: &str, job: &Job) -> Result<()> {
        self.auth_change("logout", host, login, job)
    }

    fn auth_change(&self, verb: &str, host: &str, login: &str, job: &Job) -> Result<()> {
        check::login(login)?;
        let host = self.login_host(host, job)?;
        let out = self.run_gh(&["auth", verb, "--hostname", &host, "--user", login], None, None, TIMEOUT, job)?;
        *self.status_cache.lock() = None;
        log::debug!("gh auth {verb} host={host} ok={}", out.ok());
        if out.ok() { Ok(()) } else { Err(failure_message(&out)) }
    }

    // ---- api -------------------------------------------------------------------------------

    /// A REST call. Returns the parsed JSON, `null` for an empty answer.
    pub fn api(&self, req: &ApiRequest, job: &Job) -> Result<Value> {
        let method = check::method(req.method.as_deref())?;
        check::path(&req.path)?;
        let paginate = req.paginate.unwrap_or(false);
        if paginate && method != "GET" {
            return Err(Error::invalid("paginate works with GET only"));
        }
        if req.body.is_some() && method == "GET" {
            return Err(Error::invalid("a GET request has no body"));
        }
        let host = self.login_host(&req.host, job)?;
        let body = match &req.body {
            Some(v) => Some(serde_json::to_vec(v)?),
            None => None,
        };
        let res = self.exec_api(&host, method, &req.path, &[], body.as_deref(), paginate, job)?;
        if res.body.iter().all(|b| b.is_ascii_whitespace()) {
            return Ok(Value::Null);
        }
        let value: Value = serde_json::from_slice(&res.body)
            .map_err(|_| Error::new(codes::GH_ERROR, format!("HTTP {}: the answer is not JSON", res.status)))?;
        if paginate { Ok(flatten_pages(value)) } else { Ok(value) }
    }

    /// A GraphQL call. Returns `data`.
    pub fn graphql(&self, host: &str, query: &str, variables: &Value, job: &Job) -> Result<Value> {
        let started = Instant::now();
        let host = self.login_host(host, job)?;
        let body = serde_json::to_vec(&json!({ "query": query, "variables": variables }))?;
        let out = self.run_gh(
            &["api", "graphql", "--hostname", &host, "--input", "-"],
            None,
            Some(&body),
            TIMEOUT,
            job,
        )?;
        log::debug!("gh graphql host={host} code={:?} ms={}", out.code, started.elapsed().as_millis());
        let value: Option<Value> = serde_json::from_slice(&out.stdout).ok();
        if let Some(errors) = value.as_ref().and_then(|v| v.get("errors")) {
            let text = graphql_messages(errors);
            if !text.is_empty() {
                return Err(Error::new(codes::GH_ERROR, text));
            }
        }
        if !out.ok() {
            return Err(failure_for(&out));
        }
        let value = value.ok_or_else(|| Error::new(codes::GH_ERROR, "the answer is not JSON"))?;
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }

    /// The text of a file at `reference` (a commit, branch or tag).
    pub fn file_text(&self, host: &str, owner: &str, repo: &str, path: &str, reference: &str, job: &Job) -> Result<String> {
        check::name(owner)?;
        check::name(repo)?;
        let path = path.trim_start_matches('/');
        if path.is_empty() || path.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
            return Err(Error::invalid("not a valid file path"));
        }
        if reference.is_empty() || reference.starts_with('-') {
            return Err(Error::invalid("not a valid reference"));
        }
        let encoded: Vec<String> = path.split('/').map(check::encode).collect();
        let api_path = format!("repos/{owner}/{repo}/contents/{}?ref={}", encoded.join("/"), check::encode(reference));
        let host = self.login_host(host, job)?;
        let header = "Accept: application/vnd.github.raw";
        let res = self.exec_api(&host, "GET", &api_path, &["-H", header], None, false, job)?;
        let too_large = res.body.len() > MAX_FILE_BYTES
            || res
                .headers
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("content-length") && v.trim().parse::<usize>().is_ok_and(|n| n > MAX_FILE_BYTES));
        if too_large {
            return Err(Error::new(codes::TOO_LARGE, "the file is larger than 5 MB"));
        }
        if res.body.contains(&0) {
            return Err(Error::new(codes::BINARY, "the file is binary"));
        }
        String::from_utf8(res.body).map_err(|_| Error::new(codes::BINARY, "the file is not UTF-8 text"))
    }

    /// Runs `gh api` and checks the HTTP status. Error answers become errors.
    /// Without `paginate` it uses `-i` to read the status. With `paginate` it
    /// uses `--paginate --slurp` (one JSON array of pages), and the status of
    /// a failure comes from the error text of `gh`.
    #[allow(clippy::too_many_arguments)]
    fn exec_api(
        &self,
        host: &str,
        method: &str,
        path: &str,
        extra: &[&str],
        body: Option<&[u8]>,
        paginate: bool,
        job: &Job,
    ) -> Result<Response> {
        let started = Instant::now();
        let mut args = vec!["api", "--hostname", host, "-X", method];
        args.extend_from_slice(extra);
        args.extend_from_slice(if paginate { &["--paginate", "--slurp"] } else { &["-i"] });
        if body.is_some() {
            args.extend_from_slice(&["--input", "-"]);
        }
        args.push(path);
        let timeout = if paginate { LONG_TIMEOUT } else { TIMEOUT };
        let out = self.run_gh(&args, None, body, timeout, job);
        let log_path = path.split('?').next().unwrap_or(path);
        let ms = started.elapsed().as_millis();
        let out = match out {
            Ok(o) => o,
            Err(e) => {
                log::debug!("gh api host={host} method={method} path={log_path} error={} ms={ms}", e.code());
                return Err(e);
            }
        };
        let result = if paginate {
            if out.ok() {
                Ok(Response { status: 200, headers: Vec::new(), body: out.stdout })
            } else {
                Err(failure_for(&out))
            }
        } else {
            match split_response(&out.stdout) {
                Some(r) if (200..400).contains(&r.status) => Ok(r),
                Some(r) => Err(error_for_status(r.status, &r.body)),
                None => Err(failure_for(&out)),
            }
        };
        let status = match &result {
            Ok(r) => r.status.to_string(),
            Err(e) => e.code().to_string(),
        };
        log::debug!("gh api host={host} method={method} path={log_path} status={status} ms={ms}");
        result
    }

    // ---- repository of a folder, pull request checkout ------------------------------------

    /// The GitHub repository of a folder, from its git remotes. Only hosts
    /// with a `gh` login count. `None` when there is none.
    pub fn repo_of(&self, root: &Path, job: &Job) -> Result<Option<RepoRef>> {
        if !root.is_dir() {
            return Err(Error::not_found(format!("folder not found: {}", root.display())));
        }
        let mut cmd = process::command("git");
        cmd.args(["remote", "-v"]).current_dir(root).env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C");
        let out = match run::run(cmd, None, TIMEOUT, job, codes::GIT_MISSING, "git") {
            Ok(o) => o,
            Err(e) if e.code() == codes::GIT_MISSING => return Ok(None),
            Err(e) => return Err(e),
        };
        if !out.ok() {
            return Ok(None);
        }
        let remotes = parse_remotes(&String::from_utf8_lossy(&out.stdout));
        if remotes.is_empty() {
            return Ok(None);
        }
        let status = self.cached_status(job)?;
        Ok(remotes.into_iter().find_map(|r| {
            let known = status.accounts.iter().any(|a| a.host.eq_ignore_ascii_case(&r.host));
            known.then(|| RepoRef { host: r.host, owner: r.owner, name: r.name, remote: r.remote })
        }))
    }

    /// `gh pr checkout <n>` in the folder. Returns what `gh` and git printed.
    pub fn pr_checkout(&self, root: &Path, number: u64, job: &Job) -> Result<String> {
        if number == 0 {
            return Err(Error::invalid("not a valid pull request number"));
        }
        if !root.is_dir() {
            return Err(Error::not_found(format!("folder not found: {}", root.display())));
        }
        let started = Instant::now();
        let n = number.to_string();
        let out = self.run_gh(&["pr", "checkout", &n], Some(root), None, LONG_TIMEOUT, job)?;
        log::debug!("gh pr checkout code={:?} ms={}", out.code, started.elapsed().as_millis());
        if !out.ok() {
            return Err(failure_message(&out));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let text = [stdout.trim(), out.stderr.trim()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n");
        Ok(text)
    }
}

// ---- Parsing (unit tested) -----------------------------------------------------------------

fn missing() -> Error {
    Error::new(codes::GH_MISSING, "gh is not installed or not in PATH")
}

/// "gh version 2.97.0 (2026-07-31)" gives "2.97.0".
fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().next()?;
    let mut it = line.split_whitespace();
    (it.next()? == "gh" && it.next()? == "version").then(|| it.next().map(str::to_string)).flatten()
}

/// Reads the JSON of `gh auth status --json hosts`. Only the listed fields
/// are copied, so a `token` field never goes on.
pub fn parse_accounts(json: &[u8]) -> Result<Vec<GhAccount>> {
    let v: Value = serde_json::from_slice(json).map_err(|_| Error::new(codes::GH_ERROR, "gh auth status gave no JSON"))?;
    let mut list = Vec::new();
    let Some(hosts) = v.get("hosts").and_then(Value::as_object) else {
        return Ok(list);
    };
    for (host, entries) in hosts {
        let Some(entries) = entries.as_array() else { continue };
        for e in entries {
            let state = match e.get("state").and_then(Value::as_str) {
                Some("success") => "success",
                Some("timeout") => "timeout",
                _ => "error",
            };
            let scopes = match e.get("scopes") {
                Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect(),
                _ => Vec::new(),
            };
            list.push(GhAccount {
                host: e.get("host").and_then(Value::as_str).unwrap_or(host).to_string(),
                login: e.get("login").and_then(Value::as_str).unwrap_or("").to_string(),
                active: e.get("active").and_then(Value::as_bool).unwrap_or(false),
                state: state.to_string(),
                scopes,
                error: e.get("error").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
            });
        }
    }
    Ok(list)
}

/// Splits `HTTP/2.0 200 OK`, the headers, an empty line and the body.
fn split_response(stdout: &[u8]) -> Option<Response> {
    if !stdout.starts_with(b"HTTP/") {
        return None;
    }
    let find = |pat: &[u8]| stdout.windows(pat.len()).position(|w| w == pat).map(|i| (i, pat.len()));
    let (end, skip) = match (find(b"\r\n\r\n"), find(b"\n\n")) {
        (Some(a), Some(b)) => if a.0 <= b.0 { a } else { b },
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => (stdout.len(), 0),
    };
    let head = String::from_utf8_lossy(&stdout[..end]);
    let mut lines = head.lines();
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let body = stdout.get(end + skip..).unwrap_or(&[]).to_vec();
    Some(Response { status, headers, body })
}

/// The error text of a GitHub JSON answer: `message`, then `errors`.
fn github_message(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let mut text = v.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let details = match v.get("errors") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|e| match e {
                Value::String(s) => Some(s.clone()),
                Value::Object(_) => e.get("message").and_then(Value::as_str).map(str::to_string).or_else(|| {
                    let parts: Vec<&str> = ["resource", "field", "code"].iter().filter_map(|k| e.get(*k).and_then(Value::as_str)).collect();
                    (!parts.is_empty()).then(|| parts.join(" "))
                }),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("; "),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    if !details.is_empty() {
        text = if text.is_empty() { details } else { format!("{text}: {details}") };
    }
    (!text.is_empty()).then_some(text)
}

fn graphql_messages(errors: &Value) -> String {
    match errors {
        Value::Array(a) => a
            .iter()
            .filter_map(|e| e.get("message").and_then(Value::as_str).or_else(|| e.as_str()))
            .collect::<Vec<_>>()
            .join("; "),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// Maps an HTTP error status to an error: 401 `gh_auth`, 404 `not_found`,
/// 403 with `too_large` in the body `too_large`, others `gh_error`.
fn error_for_status(status: u16, body: &[u8]) -> Error {
    let text = github_message(body).unwrap_or_else(|| reason(status).to_string());
    let message = format!("HTTP {status}: {text}");
    let code = match status {
        401 => codes::GH_AUTH,
        404 => codes::NOT_FOUND,
        403 if String::from_utf8_lossy(body).contains("too_large") => codes::TOO_LARGE,
        _ => codes::GH_ERROR,
    };
    Error::new(code, message)
}

/// The status in `gh: Not Found (HTTP 404)`.
fn status_in_stderr(stderr: &str) -> Option<u16> {
    let i = stderr.rfind("(HTTP ")?;
    stderr[i + 6..].split(')').next()?.trim().parse().ok()
}

fn first_error_line(stderr: &str) -> String {
    let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = line.strip_prefix("gh: ").unwrap_or(line);
    let line = match line.rfind(" (HTTP ") {
        Some(i) => &line[..i],
        None => line,
    };
    line.chars().take(500).collect()
}

/// An error from a failed `gh api` run that has no HTTP status line in the
/// output: use the status in the error text, or the text itself.
fn failure_for(out: &Output) -> Error {
    if let Some(status) = status_in_stderr(&out.stderr) {
        let mut e = error_for_status(status, &out.stdout);
        // Keep the text of `gh` when GitHub sent no JSON message.
        if github_message(&out.stdout).is_none() {
            let line = first_error_line(&out.stderr);
            if !line.is_empty() {
                e = Error::new(e.code(), format!("HTTP {status}: {line}"));
            }
        }
        return e;
    }
    failure_message(out)
}

/// An error from the text `gh` wrote to stderr (git's messages can have
/// several lines, so we keep the whole text, up to 1000 characters).
fn failure_message(out: &Output) -> Error {
    let text = out.stderr.trim();
    let text = text.strip_prefix("gh: ").unwrap_or(text);
    let text: String = text.chars().take(1000).collect();
    let all = out.stderr.to_lowercase();
    if all.contains("gh auth login") || all.contains("not logged in") {
        return Error::new(codes::GH_AUTH, if text.is_empty() { "not logged in".into() } else { text });
    }
    let text = if text.is_empty() { format!("gh exited with code {:?}", out.code) } else { text };
    Error::new(codes::GH_ERROR, text)
}

/// `--slurp` gives an array of pages. Join the arrays of the pages. A page
/// that is not an array stays one item.
fn flatten_pages(v: Value) -> Value {
    match v {
        Value::Array(pages) => {
            let mut all = Vec::new();
            for page in pages {
                match page {
                    Value::Array(items) => all.extend(items),
                    other => all.push(other),
                }
            }
            Value::Array(all)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests;
