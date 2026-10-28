//! Trino sessions. A native client of the Trino HTTP protocol (no JDBC).
//!
//! How a statement runs:
//! 1. `POST /v1/statement` with the SQL as body.
//! 2. Every answer can hold `columns`, `data`, an `error` and a `nextUri`.
//!    The client reads them and sends `GET <nextUri>` until there is no `nextUri`.
//! 3. To stop early (row limit or cancel) the client sends `DELETE <nextUri>`.
//!
//! The HTTP client is `ureq` (blocking). Every call here blocks, so the manager
//! runs them inside `spawn_blocking`.
//!
//! Login (`TrinoAuth`):
//! - `none`: only the header `X-Trino-User`.
//! - `password`: HTTP Basic, only over https.
//! - `oauth2`: the server answers 401 with
//!   `WWW-Authenticate: Bearer x_redirect_server="...", x_token_server="..."`.
//!   We open `x_redirect_server` in the system browser and poll `x_token_server`
//!   until it gives `{ "token": ... }`. Then we repeat the request with
//!   `Authorization: Bearer <token>`. The token stays in memory, per connection id.

use crate::export::{BOM, CsvOptions, Dialect, PartGuard, check_read_only, check_target, part_path, push_row};
use crate::types::*;
use crate::values::hex_preview;
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufWriter, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use ureq::Agent;
use ureq::http::Response;
use ureq::tls::{RootCerts, TlsConfig};

const DEFAULT_CONNECT_TIMEOUT_SEC: u64 = 10;
/// Time limit of one HTTP call. Trino answers a page within a few seconds.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// The biggest answer page that we accept.
const MAX_PAGE_BYTES: u64 = 512 * 1024 * 1024;
/// How often a call is repeated after HTTP 502, 503 or 504.
const RETRIES: u32 = 5;
const WRITE_BUFFER: usize = 256 * 1024;

type Tokens = Arc<Mutex<HashMap<String, String>>>;

/// Settings of the Trino client that tests can change.
#[derive(Clone)]
pub struct TrinoOptions {
    /// Opens a web page in the system browser (for the OAuth2 login).
    pub open_browser: Arc<dyn Fn(&str) -> Result<()> + Send + Sync>,
    /// How long we wait for the user to finish the browser login.
    pub login_timeout: Duration,
    /// Pause between two polls of the token server.
    pub poll_interval: Duration,
    /// Tests only: allow password login over http. The password would travel as plain text.
    pub allow_http_password: bool,
}

impl Default for TrinoOptions {
    fn default() -> Self {
        TrinoOptions { open_browser: Arc::new(open_in_browser), login_timeout: Duration::from_secs(180), poll_interval: Duration::from_millis(500), allow_http_password: false }
    }
}

impl std::fmt::Debug for TrinoOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrinoOptions").field("login_timeout", &self.login_timeout).field("poll_interval", &self.poll_interval).finish()
    }
}

/// Opens a URL in the default browser. Only http and https addresses are allowed.
fn open_in_browser(url: &str) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(Error::new(codes::DB_AUTH, "the login address of the server is not an http(s) address"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = kestrel_common::process::command("open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // `cmd /c start` would treat `&` in the address as a command separator.
        let mut c = kestrel_common::process::command("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(url);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut c = kestrel_common::process::command("xdg-open");
        c.arg(url);
        c
    };
    let mut child = cmd.spawn().map_err(|e| Error::new(codes::DB_AUTH, format!("cannot open the browser: {e}")))?;
    // Wait in a thread, so the child does not stay as a zombie process.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// --- Answer of the server ---------------------------------------------------

#[derive(Deserialize)]
struct ColumnDef {
    name: String,
    #[serde(rename = "type", default)]
    type_name: String,
}

#[derive(Deserialize)]
struct ErrorInfo {
    #[serde(default)]
    message: String,
    #[serde(rename = "errorName", default)]
    error_name: String,
}

#[derive(Deserialize)]
struct Page {
    #[serde(rename = "nextUri")]
    next_uri: Option<String>,
    columns: Option<Vec<ColumnDef>>,
    data: Option<Vec<Vec<Box<RawValue>>>>,
    error: Option<ErrorInfo>,
    #[serde(rename = "updateType")]
    update_type: Option<String>,
    #[serde(rename = "updateCount")]
    update_count: Option<u64>,
}

struct HttpResp {
    status: u16,
    www_authenticate: Vec<String>,
    set_schema: Option<String>,
    set_catalog: Option<String>,
    body: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
    Delete,
}

/// What a statement run gives back besides the rows.
#[derive(Default)]
struct RunInfo {
    update_type: Option<String>,
    update_count: Option<u64>,
}

pub(crate) enum Flow {
    Continue,
    Stop,
}

/// Receives the columns and the rows of a statement while it runs.
pub(crate) trait Sink {
    fn columns(&mut self, columns: &[Column]) -> Result<()>;
    fn rows(&mut self, rows: Vec<Vec<Option<String>>>) -> Result<Flow>;
}

/// Keeps rows in memory, up to `max` (0 means no limit).
struct Collect {
    max: usize,
    columns: Vec<Column>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

impl Collect {
    fn new(max: usize) -> Self {
        Collect { max, columns: Vec::new(), rows: Vec::new(), truncated: false }
    }
}

impl Sink for Collect {
    fn columns(&mut self, columns: &[Column]) -> Result<()> {
        self.columns = columns.to_vec();
        Ok(())
    }

    fn rows(&mut self, rows: Vec<Vec<Option<String>>>) -> Result<Flow> {
        for row in rows {
            if self.max > 0 && self.rows.len() >= self.max {
                self.truncated = true;
                return Ok(Flow::Stop);
            }
            self.rows.push(row);
        }
        Ok(Flow::Continue)
    }
}

/// Writes rows as CSV into a file while they arrive.
struct CsvSink<W: Write> {
    out: W,
    opts: CsvOptions,
    buf: Vec<u8>,
    rows: u64,
    bytes: u64,
}

impl<W: Write> CsvSink<W> {
    fn put(&mut self) -> Result<()> {
        self.out.write_all(&self.buf)?;
        self.bytes += self.buf.len() as u64;
        self.buf.clear();
        Ok(())
    }
}

impl<W: Write> Sink for CsvSink<W> {
    fn columns(&mut self, columns: &[Column]) -> Result<()> {
        if self.opts.header {
            push_row(&mut self.buf, self.opts.delimiter, columns.iter().map(|c| Some(c.name.as_str())));
            self.put()?;
        }
        Ok(())
    }

    fn rows(&mut self, rows: Vec<Vec<Option<String>>>) -> Result<Flow> {
        for row in &rows {
            push_row(&mut self.buf, self.opts.delimiter, row.iter().map(|v| v.as_deref()));
            self.put()?;
            self.rows += 1;
        }
        Ok(Flow::Continue)
    }
}

// --- Session ----------------------------------------------------------------

pub(crate) struct TrinoSession {
    agent: Agent,
    /// `https://host:port` or `http://host:port`.
    base: String,
    host: String,
    user: String,
    auth: TrinoAuth,
    password: String,
    tokens: Tokens,
    token_key: String,
    options: TrinoOptions,
    read_only: bool,
    catalog: Mutex<Option<String>>,
    schema: Mutex<Option<String>>,
    pub(crate) server_version: Mutex<String>,
    busy: AtomicBool,
    cancel: AtomicBool,
    /// The `nextUri` of the running statement. `cancel` sends DELETE to it.
    current_uri: Mutex<Option<String>>,
}

/// Marks the session as busy. The mark goes away when this value is dropped.
pub(crate) struct Busy(Arc<TrinoSession>);

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The login type of a connection. The default depends on the ssl setting.
pub(crate) fn auth_of(cfg: &ConnectionConfig) -> TrinoAuth {
    cfg.trino_auth.unwrap_or(if cfg.ssl == SslMode::Disabled { TrinoAuth::None } else { TrinoAuth::Password })
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

impl TrinoSession {
    /// Builds the client. It does not connect: `check` does.
    pub(crate) fn new(cfg: &ConnectionConfig, password: &str, tokens: Tokens, options: TrinoOptions) -> Result<Arc<Self>> {
        let host = cfg.host.trim().to_string();
        if host.is_empty() || cfg.port == 0 {
            return Err(Error::invalid("a Trino connection needs a host and a port"));
        }
        let auth = auth_of(cfg);
        let https = cfg.ssl != SslMode::Disabled;
        if auth == TrinoAuth::Password && !https && !options.allow_http_password {
            return Err(Error::invalid("Trino password login works only over https. Turn SSL on, or use the login type `none`"));
        }
        if cfg.user.trim().is_empty() {
            return Err(Error::invalid("a Trino connection needs a user name"));
        }
        if cfg.ssh.is_some() {
            return Err(Error::invalid("an SSH tunnel is not supported for Trino yet"));
        }
        let timeout = Duration::from_secs(cfg.connect_timeout_sec.unwrap_or(DEFAULT_CONNECT_TIMEOUT_SEC).clamp(1, 300));
        let mut b = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(timeout))
            .timeout_global(Some(CALL_TIMEOUT))
            .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
            .user_agent("kestrel");
        if is_loopback(&host) {
            // A proxy from the environment must not catch local servers.
            b = b.proxy(None);
        }
        let agent: Agent = b.build().into();
        let shown_host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.clone() };
        Ok(Arc::new(TrinoSession {
            agent,
            base: format!("{}://{}:{}", if https { "https" } else { "http" }, shown_host, cfg.port),
            host,
            user: cfg.user.trim().to_string(),
            auth,
            password: password.to_string(),
            tokens,
            token_key: cfg.id.clone(),
            options,
            read_only: cfg.read_only,
            catalog: Mutex::new(clean(&cfg.catalog)),
            schema: Mutex::new(clean(&cfg.database)),
            server_version: Mutex::new(String::new()),
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            current_uri: Mutex::new(None),
        }))
    }

    pub(crate) fn schema(&self) -> Option<String> {
        self.schema.lock().clone()
    }

    pub(crate) fn acquire(self: &Arc<Self>) -> Result<Busy> {
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(Error::new(codes::DB_BUSY, "the session runs another statement"));
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(Busy(self.clone()))
    }

    pub(crate) fn is_running(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Runs `SELECT 1` (this starts the login), reads the server version and the init SQL.
    pub(crate) fn check(self: &Arc<Self>, init_sql: Option<&str>) -> Result<String> {
        self.run(trim_sql("SELECT 1"), &mut Collect::new(0))?;
        let version = self.read_version();
        *self.server_version.lock() = version.clone();
        if let Some(init) = init_sql.map(str::trim).filter(|s| !s.is_empty()) {
            self.run(trim_sql(init), &mut Collect::new(0)).map_err(|e| Error::new(codes::DB_CONNECT, format!("init SQL failed: {e}")))?;
        }
        Ok(version)
    }

    /// `GET /v1/info` gives the version. A failure only means an empty version.
    fn read_version(&self) -> String {
        #[derive(Deserialize)]
        struct Info {
            #[serde(rename = "nodeVersion")]
            node_version: Option<NodeVersion>,
        }
        #[derive(Deserialize)]
        struct NodeVersion {
            version: String,
        }
        let url = format!("{}/v1/info", self.base);
        let Ok(resp) = self.request(Method::Get, &url, None, true) else { return String::new() };
        if resp.status != 200 {
            return String::new();
        }
        serde_json::from_slice::<Info>(&resp.body).ok().and_then(|i| i.node_version).map(|v| v.version).unwrap_or_default()
    }

    // --- HTTP ---------------------------------------------------------------

    fn auth_header(&self) -> Option<String> {
        match self.auth {
            TrinoAuth::None => None,
            TrinoAuth::Password => Some(format!("Basic {}", base64_encode(format!("{}:{}", self.user, self.password).as_bytes()))),
            TrinoAuth::Oauth2 => self.tokens.lock().get(&self.token_key).map(|t| format!("Bearer {t}")),
        }
    }

    fn transport_error(&self, e: ureq::Error, lost: bool) -> Error {
        let text = format!("cannot reach {}: {e}", self.host);
        Error::new(if lost { codes::DB_LOST } else { codes::DB_CONNECT }, text)
    }

    /// Adds the Trino headers and the login header to a request.
    fn decorate<B>(&self, mut r: ureq::RequestBuilder<B>, trino_headers: bool, auth: &Option<String>, catalog: &Option<String>, schema: &Option<String>) -> ureq::RequestBuilder<B> {
        if trino_headers {
            r = r.header("X-Trino-User", &self.user).header("X-Trino-Source", "kestrel");
            if let Some(c) = catalog {
                r = r.header("X-Trino-Catalog", c);
            }
            if let Some(s) = schema {
                r = r.header("X-Trino-Schema", s);
            }
        }
        if let Some(a) = auth {
            r = r.header("Authorization", a);
        }
        r
    }

    /// One HTTP call without login handling.
    fn raw(&self, method: Method, url: &str, body: Option<&str>, trino_headers: bool, with_auth: bool) -> std::result::Result<HttpResp, ureq::Error> {
        let auth = if with_auth { self.auth_header() } else { None };
        let catalog = self.catalog.lock().clone();
        let schema = self.schema.lock().clone();
        let resp = match method {
            Method::Post => self.decorate(self.agent.post(url), trino_headers, &auth, &catalog, &schema).send(body.unwrap_or(""))?,
            Method::Get => self.decorate(self.agent.get(url), trino_headers, &auth, &catalog, &schema).call()?,
            Method::Delete => self.decorate(self.agent.delete(url), trino_headers, &auth, &catalog, &schema).call()?,
        };
        read_response(resp)
    }

    /// One HTTP call with login handling and a few retries.
    fn request(&self, method: Method, url: &str, body: Option<&str>, lost: bool) -> Result<HttpResp> {
        let mut logins = 0;
        let mut retries = 0;
        loop {
            let resp = self.raw(method, url, body, true, true).map_err(|e| self.transport_error(e, lost))?;
            match resp.status {
                401 => {
                    if self.auth == TrinoAuth::Oauth2 && logins == 0 {
                        logins += 1;
                        self.tokens.lock().remove(&self.token_key);
                        self.oauth_login(&resp)?;
                    } else {
                        return Err(Error::new(codes::DB_AUTH, auth_message(self.auth, &resp)));
                    }
                }
                502..=504 if retries < RETRIES => {
                    retries += 1;
                    std::thread::sleep(Duration::from_millis(100 * u64::from(retries)));
                }
                _ => {
                    self.read_session_headers(&resp);
                    return Ok(resp);
                }
            }
        }
    }

    /// `USE` answers with `X-Trino-Set-Schema` (and `X-Trino-Set-Catalog`).
    fn read_session_headers(&self, resp: &HttpResp) {
        if let Some(c) = &resp.set_catalog {
            *self.catalog.lock() = Some(percent_decode(c));
        }
        if let Some(s) = &resp.set_schema {
            *self.schema.lock() = Some(percent_decode(s));
        }
    }

    // --- OAuth2 -------------------------------------------------------------

    /// Opens the login page and waits for the token.
    fn oauth_login(&self, unauthorized: &HttpResp) -> Result<()> {
        let header = unauthorized.www_authenticate.iter().find(|h| h.contains("x_redirect_server")).cloned().unwrap_or_default();
        let redirect = quoted_param(&header, "x_redirect_server");
        let token_server = quoted_param(&header, "x_token_server");
        let (Some(redirect), Some(token_server)) = (redirect, token_server) else {
            return Err(Error::new(codes::DB_AUTH, "the server asks for a login but does not offer OAuth2 (no x_redirect_server in WWW-Authenticate)"));
        };
        if !(token_server.starts_with("https://") || token_server.starts_with("http://")) {
            return Err(Error::new(codes::DB_AUTH, "the token address of the server is not an http(s) address"));
        }
        (self.options.open_browser)(&redirect)?;
        let deadline = Instant::now() + self.options.login_timeout;
        let mut uri = token_server;
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(Error::cancelled());
            }
            if Instant::now() >= deadline {
                return Err(Error::new(codes::DB_AUTH, "the browser login timed out"));
            }
            let resp = self.raw(Method::Get, &uri, None, false, false).map_err(|e| self.transport_error(e, false))?;
            if resp.status != 200 {
                return Err(Error::new(codes::DB_AUTH, format!("the browser login failed (token server answered HTTP {})", resp.status)));
            }
            #[derive(Deserialize)]
            struct Answer {
                token: Option<String>,
                #[serde(rename = "nextUri")]
                next_uri: Option<String>,
                error: Option<String>,
            }
            let answer: Answer = serde_json::from_slice(&resp.body).map_err(|_| Error::new(codes::DB_AUTH, "the token server sent an answer that is not JSON"))?;
            if let Some(token) = answer.token.filter(|t| !t.is_empty()) {
                self.tokens.lock().insert(self.token_key.clone(), token);
                return Ok(());
            }
            if let Some(e) = answer.error {
                return Err(Error::new(codes::DB_AUTH, format!("the browser login failed: {e}")));
            }
            match answer.next_uri {
                Some(next) => uri = next,
                None => return Err(Error::new(codes::DB_AUTH, "the token server sent neither a token nor a next address")),
            }
            self.sleep_checked(self.options.poll_interval, deadline);
        }
    }

    /// Sleeps in short steps and stops early on cancel.
    fn sleep_checked(&self, total: Duration, deadline: Instant) {
        let end = (Instant::now() + total).min(deadline);
        while Instant::now() < end && !self.cancel.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(20).min(end.saturating_duration_since(Instant::now())));
        }
    }

    // --- Statements ---------------------------------------------------------

    /// Stops the running statement. Does nothing when no statement runs.
    pub(crate) fn cancel(&self) {
        if !self.is_running() {
            return;
        }
        self.cancel.store(true, Ordering::SeqCst);
        let uri = self.current_uri.lock().clone();
        if let Some(uri) = uri {
            self.delete(&uri);
        }
    }

    /// Tells the server to drop the rest of a query. Errors do not matter here.
    fn delete(&self, uri: &str) {
        let _ = self.raw(Method::Delete, uri, None, true, true);
    }

    fn start(&self, sql: &str) -> Result<Page> {
        let url = format!("{}/v1/statement", self.base);
        let resp = self.request(Method::Post, &url, Some(sql), false)?;
        parse_page(&resp)
    }

    /// Runs one statement and sends the columns and rows to `sink`.
    fn run(&self, sql: &str, sink: &mut dyn Sink) -> Result<RunInfo> {
        let result = self.run_inner(sql, sink);
        *self.current_uri.lock() = None;
        if self.cancel.load(Ordering::SeqCst) {
            return Err(Error::cancelled());
        }
        result
    }

    fn run_inner(&self, sql: &str, sink: &mut dyn Sink) -> Result<RunInfo> {
        let mut info = RunInfo::default();
        let mut columns: Option<Vec<Column>> = None;
        let mut page = self.start(sql)?;
        loop {
            *self.current_uri.lock() = page.next_uri.clone();
            if self.cancel.load(Ordering::SeqCst) {
                if let Some(uri) = &page.next_uri {
                    self.delete(uri);
                }
                return Err(Error::cancelled());
            }
            if let Some(e) = &page.error {
                return Err(error_of(e));
            }
            if page.update_type.is_some() {
                info.update_type = page.update_type.clone();
            }
            if page.update_count.is_some() {
                info.update_count = page.update_count;
            }
            // Update statements send a `rows` count column. It is no result set.
            let is_update = info.update_type.is_some();
            if columns.is_none() && !is_update {
                if let Some(defs) = &page.columns {
                    let cols: Vec<Column> = defs.iter().map(describe_column).collect();
                    sink.columns(&cols)?;
                    columns = Some(cols);
                }
            }
            let mut flow = Flow::Continue;
            if let (Some(cols), Some(data)) = (&columns, &page.data) {
                if !data.is_empty() {
                    let rows: Vec<Vec<Option<String>>> =
                        data.iter().map(|row| row.iter().enumerate().map(|(i, v)| cell_text(v, cols.get(i).is_some_and(|c| c.binary))).collect()).collect();
                    flow = sink.rows(rows)?;
                }
            }
            let Some(uri) = page.next_uri.clone() else { return Ok(info) };
            if matches!(flow, Flow::Stop) {
                // The caller has enough rows. Tell the server to drop the rest.
                self.delete(&uri);
                return Ok(info);
            }
            let had_content = page.data.as_ref().is_some_and(|d| !d.is_empty());
            if !had_content {
                std::thread::sleep(Duration::from_millis(10));
            }
            let resp = self.request(Method::Get, &uri, None, true)?;
            page = parse_page(&resp)?;
        }
    }

    fn check_writable(&self, sql: &str) -> Result<()> {
        if self.read_only {
            check_read_only(sql, Dialect::Trino, &["use"]).map_err(|_| Error::invalid("this connection is read-only: only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, VALUES, TABLE and USE are allowed"))?;
        }
        Ok(())
    }

    pub(crate) fn execute(self: &Arc<Self>, sql: &str, max_rows: usize) -> Result<ExecResult> {
        let _busy = self.acquire()?;
        self.check_writable(sql)?;
        let started = Instant::now();
        let mut sink = Collect::new(max_rows);
        let info = self.run(trim_sql(sql), &mut sink)?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let result = if info.update_type.is_some() || sink.columns.is_empty() {
            QueryResult {
                kind: ResultKind::Affected,
                columns: Vec::new(),
                rows: Vec::new(),
                truncated: false,
                affected_rows: info.update_count.unwrap_or(0),
                last_insert_id: None,
                warnings: 0,
                info: info.update_type,
                elapsed_ms,
            }
        } else {
            QueryResult {
                kind: ResultKind::Rows,
                columns: sink.columns,
                rows: sink.rows,
                truncated: sink.truncated,
                affected_rows: 0,
                last_insert_id: None,
                warnings: 0,
                info: None,
                elapsed_ms,
            }
        };
        Ok(ExecResult { results: vec![result], database: self.schema(), elapsed_ms, autocommit: true, in_transaction: false })
    }

    /// Runs a statement of our own and returns all its rows.
    fn query_all(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        let mut sink = Collect::new(0);
        self.run(sql, &mut sink)?;
        Ok(sink.rows)
    }

    pub(crate) fn use_database(self: &Arc<Self>, database: &str) -> Result<()> {
        let _busy = self.acquire()?;
        // Trino keeps no state for us: the schema goes into the headers of the next calls.
        *self.schema.lock() = Some(database.to_string());
        Ok(())
    }

    pub(crate) fn export_csv(self: &Arc<Self>, sql: &str, path: &str, options: &ExportOptions) -> Result<ExportResult> {
        let opts = CsvOptions::resolve(options)?;
        check_read_only(sql, Dialect::Trino, &[])?;
        let target = check_target(path)?;
        let _busy = self.acquire()?;
        let started = Instant::now();
        let part = part_path(&target);
        let file = std::fs::File::create(&part)?;
        // The guard is declared first, so the file is closed before the guard removes it.
        let mut guard = PartGuard::new(part.clone());
        let mut out = BufWriter::with_capacity(WRITE_BUFFER, file);
        let mut bytes = 0;
        if opts.bom {
            out.write_all(BOM)?;
            bytes = BOM.len() as u64;
        }
        let mut sink = CsvSink { out, opts, buf: Vec::with_capacity(8192), rows: 0, bytes };
        self.run(trim_sql(sql), &mut sink)?;
        sink.out.flush()?;
        let (rows, bytes) = (sink.rows, sink.bytes);
        drop(sink);
        std::fs::rename(&part, &target)?;
        guard.disarm();
        Ok(ExportResult { rows, bytes, elapsed_ms: started.elapsed().as_millis() as u64 })
    }

    // --- Schema -------------------------------------------------------------

    fn catalog_name(&self) -> Result<String> {
        self.catalog.lock().clone().ok_or_else(|| Error::invalid("this Trino connection has no catalog. Set the catalog in the connection"))
    }

    pub(crate) fn databases(self: &Arc<Self>) -> Result<Vec<String>> {
        let _busy = self.acquire()?;
        let rows = self.query_all(&format!("SHOW SCHEMAS FROM {}", quote_ident(&self.catalog_name()?)))?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    pub(crate) fn objects(self: &Arc<Self>, database: &str) -> Result<DbObjects> {
        let _busy = self.acquire()?;
        let catalog = quote_ident(&self.catalog_name()?);
        let rows = self.query_all(&format!(
            "SELECT table_name, table_type FROM {catalog}.information_schema.tables WHERE table_schema = {} ORDER BY table_name",
            literal(database)
        ))?;
        let mut out = DbObjects::default();
        for r in rows {
            let Some(name) = r.first().cloned().flatten() else { continue };
            let is_view = r.get(1).cloned().flatten().is_some_and(|t| t.to_ascii_uppercase().contains("VIEW"));
            let kind = if is_view { ObjectKind::View } else { ObjectKind::Table };
            let obj = DbObject { name, kind, comment: None, rows_estimate: None, detail: None };
            if is_view {
                out.views.push(obj);
            } else {
                out.tables.push(obj);
            }
        }
        Ok(out)
    }

    pub(crate) fn columns(self: &Arc<Self>, database: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let _busy = self.acquire()?;
        let catalog = quote_ident(&self.catalog_name()?);
        let rows = self.query_all(&format!(
            "SELECT column_name, data_type, is_nullable, column_default, comment FROM {catalog}.information_schema.columns \
             WHERE table_schema = {} AND table_name = {} ORDER BY ordinal_position",
            literal(database),
            literal(table)
        ))?;
        let cell = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten();
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: cell(r, 0).unwrap_or_default(),
                type_name: cell(r, 1).unwrap_or_default(),
                nullable: cell(r, 2).is_some_and(|s| s.eq_ignore_ascii_case("YES")),
                key: String::new(),
                default_value: cell(r, 3),
                extra: String::new(),
                comment: cell(r, 4).filter(|c| !c.is_empty()),
            })
            .collect())
    }

    pub(crate) fn ddl(self: &Arc<Self>, database: &str, name: &str, kind: ObjectKind) -> Result<String> {
        let what = match kind {
            ObjectKind::Table => "TABLE",
            ObjectKind::View => "VIEW",
            _ => return Err(Error::invalid("Trino shows the definition of tables and views only")),
        };
        let _busy = self.acquire()?;
        let sql = format!("SHOW CREATE {what} {}.{}.{}", quote_ident(&self.catalog_name()?), quote_ident(database), quote_ident(name));
        let rows = self.query_all(&sql)?;
        rows.into_iter()
            .next()
            .and_then(|r| r.into_iter().next().flatten())
            .ok_or_else(|| Error::new(codes::DB_ERROR, format!("the server does not show the definition of `{name}`")))
    }

    pub(crate) fn completion_schema(self: &Arc<Self>, database: &str) -> Result<BTreeMap<String, Vec<String>>> {
        let _busy = self.acquire()?;
        let catalog = quote_ident(&self.catalog_name()?);
        let rows = self.query_all(&format!(
            "SELECT table_name, column_name FROM {catalog}.information_schema.columns WHERE table_schema = {} ORDER BY table_name, ordinal_position",
            literal(database)
        ))?;
        let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for r in rows {
            let mut it = r.into_iter();
            if let (Some(Some(t)), Some(Some(c))) = (it.next(), it.next()) {
                map.entry(t).or_default().push(c);
            }
        }
        Ok(map)
    }
}

// --- Helpers ------------------------------------------------------------------

/// Trino does not accept a `;` at the end of a statement.
fn trim_sql(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
}

/// `"name"` with doubled quotes inside.
pub(crate) fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `'text'` with doubled quotes inside.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn error_of(e: &ErrorInfo) -> Error {
    let text = if e.error_name.is_empty() { e.message.clone() } else { format!("{}: {}", e.error_name, e.message) };
    Error::new(codes::DB_ERROR, text)
}

fn auth_message(auth: TrinoAuth, resp: &HttpResp) -> String {
    let body = String::from_utf8_lossy(&resp.body);
    let body = body.trim();
    let detail = if body.is_empty() || body.starts_with('<') || body.len() > 200 { String::new() } else { format!(": {body}") };
    match auth {
        TrinoAuth::None => format!("the server asks for a login (HTTP 401). Use the login type `password` or `oauth2`{detail}"),
        TrinoAuth::Password => format!("the server refused the user name or password (HTTP 401){detail}"),
        TrinoAuth::Oauth2 => format!("the server refused the OAuth2 token (HTTP 401){detail}"),
    }
}

fn parse_page(resp: &HttpResp) -> Result<Page> {
    if resp.status != 200 {
        let body = String::from_utf8_lossy(&resp.body);
        let body: String = body.trim().chars().take(300).collect();
        return Err(Error::new(codes::DB_ERROR, format!("HTTP {}{}", resp.status, if body.is_empty() { String::new() } else { format!(": {body}") })));
    }
    serde_json::from_slice(&resp.body).map_err(|e| Error::new(codes::DB_ERROR, format!("the server sent an answer that is not a Trino result: {e}")))
}

fn read_response(resp: Response<ureq::Body>) -> std::result::Result<HttpResp, ureq::Error> {
    let (parts, mut body) = resp.into_parts();
    let header = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let www_authenticate = parts.headers.get_all("www-authenticate").iter().filter_map(|v| v.to_str().ok()).map(str::to_string).collect();
    let body = body.with_config().limit(MAX_PAGE_BYTES).read_to_vec()?;
    Ok(HttpResp {
        status: parts.status.as_u16(),
        www_authenticate,
        set_schema: header("x-trino-set-schema"),
        set_catalog: header("x-trino-set-catalog"),
        body,
    })
}

/// The value of `name="value"` in a header such as
/// `Bearer x_redirect_server="https://a", x_token_server="https://b"`.
fn quoted_param(header: &str, name: &str) -> Option<String> {
    let start = header.find(&format!("{name}=\""))? + name.len() + 2;
    let end = header[start..].find('"')?;
    Some(header[start..start + end].to_string())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const NUMERIC_TYPES: [&str; 8] = ["tinyint", "smallint", "integer", "int", "bigint", "real", "double", "decimal"];

fn base_type(type_name: &str) -> String {
    type_name.split('(').next().unwrap_or("").trim().to_ascii_lowercase()
}

fn describe_column(def: &ColumnDef) -> Column {
    let base = base_type(&def.type_name);
    Column {
        name: def.name.clone(),
        type_name: if def.type_name.is_empty() { "unknown".into() } else { def.type_name.clone() },
        table: None,
        nullable: true,
        numeric: NUMERIC_TYPES.contains(&base.as_str()),
        binary: base == "varbinary",
    }
}

/// The text of one cell. Numbers, booleans and text stay as the server wrote them.
/// Arrays, maps and rows become compact JSON. `varbinary` (base64) becomes a hex preview.
fn cell_text(raw: &RawValue, binary: bool) -> Option<String> {
    let s = raw.get().trim();
    match s.as_bytes().first()? {
        b'n' => None,
        b'"' => {
            let text: String = serde_json::from_str(s).unwrap_or_else(|_| s.to_string());
            if binary {
                if let Some(bytes) = base64_decode(&text) {
                    return Some(hex_preview(&bytes));
                }
            }
            Some(text)
        }
        b'[' | b'{' => Some(minify_json(s)),
        _ => Some(s.to_string()),
    }
}

/// Removes the white space outside of strings. It keeps the text of numbers and the key order.
fn minify_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in s.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in text.trim_end_matches('=').bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.to_string()).unwrap()
    }

    #[test]
    fn cells_keep_the_written_text() {
        assert_eq!(cell_text(&raw("null"), false), None);
        assert_eq!(cell_text(&raw("12345678901234567890"), false).as_deref(), Some("12345678901234567890"));
        assert_eq!(cell_text(&raw("1.0E10"), false).as_deref(), Some("1.0E10"));
        assert_eq!(cell_text(&raw("true"), false).as_deref(), Some("true"));
        assert_eq!(cell_text(&raw("\"a\\\"b\\u00e9\""), false).as_deref(), Some("a\"bé"));
        assert_eq!(cell_text(&raw("[1, {\"b\": \"x y\", \"a\": [2,  3]}]"), false).as_deref(), Some("[1,{\"b\":\"x y\",\"a\":[2,3]}]"));
        assert_eq!(cell_text(&raw("\"AH8=\""), true).as_deref(), Some("0x007F"));
    }

    #[test]
    fn base64_round_trip() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\x00\xff\x10"] {
            assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
        }
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
        assert!(base64_decode("a$b").is_none());
    }

    #[test]
    fn reads_the_oauth_header() {
        let h = "Bearer x_redirect_server=\"https://t.example.test/oauth2/token/initiate/abc\", x_token_server=\"https://t.example.test/oauth2/token/abc\"";
        assert_eq!(quoted_param(h, "x_redirect_server").as_deref(), Some("https://t.example.test/oauth2/token/initiate/abc"));
        assert_eq!(quoted_param(h, "x_token_server").as_deref(), Some("https://t.example.test/oauth2/token/abc"));
        assert_eq!(quoted_param("Basic realm=\"x\"", "x_token_server"), None);
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(literal("it's"), "'it''s'");
        assert_eq!(trim_sql(" SELECT 1 ; \n"), "SELECT 1");
    }

    #[test]
    fn column_types() {
        let c = describe_column(&ColumnDef { name: "p".into(), type_name: "decimal(10,2)".into() });
        assert!(c.numeric && !c.binary && c.type_name == "decimal(10,2)");
        let c = describe_column(&ColumnDef { name: "b".into(), type_name: "varbinary".into() });
        assert!(c.binary && !c.numeric);
        let c = describe_column(&ColumnDef { name: "a".into(), type_name: "array(integer)".into() });
        assert!(!c.numeric);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("my%20schema"), "my schema");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
