//! `DbManager`: sessions, connecting, running statements.
//!
//! A session is one MySQL connection (plus a shared SSH tunnel when needed).
//! Sessions belong to an owner (the window label). A session runs one statement
//! at a time: the connection sits behind a mutex that we only `try_lock`, and a
//! second call while it is locked fails with `db_busy`.

use crate::error::{self, Phase, is_lost, map_error};
use crate::export::{BOM, CsvOptions, Dialect, PartGuard, check_read_only, check_target, part_path, push_row};
use crate::idea;
use crate::schema;
use crate::trino::{TrinoOptions, TrinoSession};
use crate::tunnel::{TunnelKey, Tunnels, tunnel_key};
use crate::types::*;
use crate::values::{describe_column, format_value};
use crate::keychain;
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use mysql_async::consts::StatusFlags;
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, SslOpts};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::OwnedMutexGuard;

const DEFAULT_CONNECT_TIMEOUT_SEC: u64 = 10;
/// Time for the side connection that sends `KILL QUERY`.
const KILL_TIMEOUT: Duration = Duration::from_secs(5);
/// Time to wait for a running statement when a session closes.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
struct SessionState {
    autocommit: bool,
    in_transaction: bool,
    database: Option<String>,
}

struct Session {
    /// `None` after the session closed.
    conn: Arc<tokio::sync::Mutex<Option<Conn>>>,
    /// `CONNECTION_ID()` on the server. `KILL QUERY` needs it.
    connection_id: u32,
    /// Options of the working connection. The side connection for `KILL QUERY` uses them too.
    side_opts: Opts,
    read_only: bool,
    tunnel: Option<TunnelKey>,
    state: Mutex<SessionState>,
    /// True while a statement runs.
    running: AtomicBool,
    /// Set by `cancel`. The running call then ends with `cancelled`.
    cancel_requested: AtomicBool,
}

/// Holds the connection of a session while one call uses it.
struct RunGuard {
    sess: Arc<Session>,
    slot: OwnedMutexGuard<Option<Conn>>,
}

impl RunGuard {
    fn conn(&mut self) -> Result<&mut Conn> {
        self.slot.as_mut().ok_or_else(|| Error::new(codes::DB_LOST, "the session is closed"))
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.sess.running.store(false, Ordering::SeqCst);
    }
}

impl Session {
    /// Takes the connection, or fails with `db_busy` when another call uses it.
    fn acquire(self: &Arc<Self>) -> Result<RunGuard> {
        let conn = self
            .conn
            .clone()
            .try_lock_owned()
            .map_err(|_| Error::new(codes::DB_BUSY, "the session runs another statement"))?;
        self.cancel_requested.store(false, Ordering::SeqCst);
        self.running.store(true, Ordering::SeqCst);
        Ok(RunGuard { sess: self.clone(), slot: conn })
    }

    /// Turns a driver error into an error of the contract. After a cancel, the
    /// interruption is reported as `cancelled`.
    fn fail(&self, e: mysql_async::Error) -> Error {
        if self.cancel_requested.load(Ordering::SeqCst) && (error::is_interrupted(&e) || !is_lost(&e)) {
            return Error::cancelled();
        }
        map_error(&e, Phase::Run)
    }

    /// The result of a call that is not a statement. After a cancel the call ends with `cancelled`.
    fn finish<T>(&self, r: mysql_async::Result<T>) -> Result<T> {
        match r {
            Ok(v) => Ok(v),
            Err(e) => Err(self.fail(e)),
        }
    }

    /// Reads `autocommit` and `inTransaction` from the status flags of the last OK packet.
    /// After an error there is no OK packet, and the old values stay.
    fn sync_state(&self, conn: &Conn) {
        if let Some(ok) = conn.last_ok_packet() {
            let flags = ok.status_flags();
            let mut st = self.state.lock();
            st.autocommit = flags.contains(StatusFlags::SERVER_STATUS_AUTOCOMMIT);
            st.in_transaction = flags.contains(StatusFlags::SERVER_STATUS_IN_TRANS);
        }
    }

    /// Sends a cheap statement to get fresh status flags (after an error or a stopped result).
    async fn refresh_state(&self, conn: &mut Conn) {
        if conn.query_drop("DO 0").await.is_ok() {
            self.sync_state(conn);
        }
    }

    fn tx_state(&self) -> TxState {
        let st = self.state.lock();
        TxState { autocommit: st.autocommit, in_transaction: st.in_transaction }
    }

    /// Sends `KILL QUERY` from a short side connection.
    async fn kill_query(&self) -> mysql_async::Result<()> {
        let mut side = match tokio::time::timeout(KILL_TIMEOUT, Conn::new(self.side_opts.clone())).await {
            Ok(r) => r?,
            Err(_) => return Err(mysql_async::Error::Io(mysql_async::IoError::Io(std::io::Error::from(std::io::ErrorKind::TimedOut)))),
        };
        let r = side.query_drop(format!("KILL QUERY {}", self.connection_id)).await;
        let _ = side.disconnect().await;
        r
    }
}

/// A session of either engine.
#[derive(Clone)]
enum Handle {
    Mysql(Arc<Session>),
    Trino(Arc<TrinoSession>),
}

struct Inner {
    sessions: Mutex<HashMap<(String, String), Handle>>,
    tunnels: Tunnels,
    next_id: AtomicU64,
    /// OAuth2 tokens of Trino connections, by connection id. They live until the app quits.
    trino_tokens: Arc<Mutex<HashMap<String, String>>>,
    trino_options: TrinoOptions,
}

/// Runs blocking Trino work on a thread of the blocking pool.
async fn blocking<T: Send + 'static>(t: &Arc<TrinoSession>, f: impl FnOnce(&Arc<TrinoSession>) -> Result<T> + Send + 'static) -> Result<T> {
    let t = t.clone();
    tokio::task::spawn_blocking(move || f(&t)).await.map_err(|e| Error::internal(format!("Trino task failed: {e}")))?
}

fn not_for_trino(what: &str) -> Error {
    Error::invalid(format!("Trino sessions run in auto-commit mode: {what} is not available"))
}

/// All database sessions of the app. Cheap to clone.
#[derive(Clone)]
pub struct DbManager {
    inner: Arc<Inner>,
}

impl Default for DbManager {
    fn default() -> Self {
        Self::new()
    }
}

/// An open connection that is not a session yet.
struct Opened {
    conn: Conn,
    opts: Opts,
    tunnel: Option<TunnelKey>,
}

/// Finds the password when the caller sent none. Order for an IntelliJ source:
/// the IntelliJ files, the IntelliJ keychain entry, the Kestrel keychain entry.
/// Without a source: the Kestrel keychain entry. No entry means an empty password.
/// The password is never logged.
async fn resolve_password(cfg: &ConnectionConfig) -> Result<String> {
    if let Some(src) = &cfg.source {
        let (s, uuid, user) = (src.clone(), src.uuid.clone(), cfg.user.clone());
        let from_file = tokio::task::spawn_blocking(move || idea::file_password(&s)).await.ok().flatten();
        if let Some(p) = from_file {
            return Ok(p);
        }
        let from_keychain = tokio::task::spawn_blocking(move || idea::intellij_keychain_password(&uuid, &user)).await.ok().flatten();
        if let Some(p) = from_keychain {
            return Ok(p);
        }
    }
    Ok(keychain::get(&cfg.id).await.map_err(|e| Error::new(codes::DB_CONNECT, e.to_string()))?.unwrap_or_default())
}

fn connect_timeout(cfg: &ConnectionConfig) -> Duration {
    Duration::from_secs(cfg.connect_timeout_sec.unwrap_or(DEFAULT_CONNECT_TIMEOUT_SEC).clamp(1, 300))
}

fn build_opts(cfg: &ConnectionConfig, host: &str, port: u16, password: &str, tls: bool) -> Opts {
    let database = cfg.database.as_deref().map(str::trim).filter(|d| !d.is_empty());
    let mut b = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(cfg.user.clone()))
        .pass((!password.is_empty()).then(|| password.to_string()))
        .db_name(database.map(str::to_string))
        .prefer_socket(false)
        .tcp_keepalive(Some(Duration::from_secs(30)));
    if tls {
        // Like `mysql --ssl-mode=REQUIRED`: the link is encrypted, but the server
        // certificate is not checked (most servers use a self-signed certificate).
        b = b.ssl_opts(SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true));
    }
    b.into()
}

/// True when the server (or the TLS handshake) cannot do TLS. Only then `preferred` retries without TLS.
fn tls_unavailable(e: &mysql_async::Error) -> bool {
    matches!(
        e,
        mysql_async::Error::Driver(mysql_async::DriverError::NoClientSslFlagFromServer) | mysql_async::Error::Io(mysql_async::IoError::Tls(_))
    )
}

async fn connect_once(opts: Opts, deadline: Instant, host: &str, port: u16) -> Result<Conn> {
    let left = deadline.saturating_duration_since(Instant::now());
    match tokio::time::timeout(left, Conn::new(opts)).await {
        Ok(Ok(c)) => Ok(c),
        Ok(Err(e)) => Err(connect_failure(&e, host, port)),
        Err(_) => Err(Error::new(codes::DB_CONNECT, format!("cannot connect to {host}:{port}: timed out"))),
    }
}

/// A server error keeps its own text (`1045 (28000): ...`). Other errors get the address.
fn connect_failure(e: &mysql_async::Error, host: &str, port: u16) -> Error {
    match e {
        mysql_async::Error::Server(_) => map_error(e, Phase::Connect),
        other => Error::new(codes::DB_CONNECT, format!("cannot connect to {host}:{port}: {}", map_error(other, Phase::Connect))),
    }
}

async fn open_conn(cfg: &ConnectionConfig, host: &str, port: u16, password: &str, timeout: Duration) -> Result<(Conn, Opts)> {
    let deadline = Instant::now() + timeout;
    let attempt = |tls: bool| build_opts(cfg, host, port, password, tls);
    match cfg.ssl {
        SslMode::Disabled => {
            let o = attempt(false);
            Ok((connect_once(o.clone(), deadline, host, port).await?, o))
        }
        SslMode::Required => {
            let o = attempt(true);
            Ok((connect_once(o.clone(), deadline, host, port).await?, o))
        }
        SslMode::Preferred => {
            let o = attempt(true);
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, Conn::new(o.clone())).await {
                Ok(Ok(c)) => Ok((c, o)),
                Ok(Err(e)) if tls_unavailable(&e) => {
                    let o = attempt(false);
                    Ok((connect_once(o.clone(), deadline, host, port).await?, o))
                }
                Ok(Err(e)) => Err(connect_failure(&e, host, port)),
                Err(_) => Err(Error::new(codes::DB_CONNECT, format!("cannot connect to {host}:{port}: timed out"))),
            }
        }
    }
}

/// True when the SQL starts with `USE` or `DROP`. Then the current database can change.
fn may_change_database(sql: &str) -> bool {
    matches!(first_keyword(sql).as_str(), "use" | "drop")
}

/// The first word of a statement in lower case. Skips spaces and comments.
pub fn first_keyword(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => s = rest[end + 2..].trim_start(),
                None => return String::new(),
            }
        } else if s.starts_with("--") || s.starts_with('#') {
            match s.find('\n') {
                Some(end) => s = s[end + 1..].trim_start(),
                None => return String::new(),
            }
        } else {
            break;
        }
    }
    s.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase()
}

impl DbManager {
    pub fn new() -> Self {
        Self::with_trino_options(TrinoOptions::default())
    }

    /// Like `new`, with other settings for the Trino client (tests use this to avoid a real browser).
    pub fn with_trino_options(trino_options: TrinoOptions) -> Self {
        DbManager {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                tunnels: Tunnels::default(),
                next_id: AtomicU64::new(1),
                trino_tokens: Arc::new(Mutex::new(HashMap::new())),
                trino_options,
            }),
        }
    }

    fn handle(&self, owner: &str, id: &str) -> Result<Handle> {
        self.inner
            .sessions
            .lock()
            .get(&(owner.to_string(), id.to_string()))
            .cloned()
            .ok_or_else(|| Error::new(codes::DB_LOST, "this database session does not exist (any more). Connect again"))
    }

    /// Builds a Trino client for a connection. The password comes from the argument or the keychain.
    async fn trino_client(&self, args: &ConnectArgs) -> Result<Arc<TrinoSession>> {
        let password = match &args.password {
            Some(p) => p.clone(),
            None => resolve_password(&args.config).await?,
        };
        TrinoSession::new(&args.config, &password, self.inner.trino_tokens.clone(), self.inner.trino_options.clone())
    }

    // --- Connect and disconnect -------------------------------------------

    /// Opens the tunnel (when configured) and the connection, and prepares it.
    async fn open(&self, owner: &str, args: &ConnectArgs) -> Result<Opened> {
        let cfg = &args.config;
        let password = match &args.password {
            Some(p) => p.clone(),
            None => resolve_password(cfg).await?,
        };
        let timeout = connect_timeout(cfg);
        let (host, port, tunnel) = match &cfg.ssh {
            Some(_) => {
                let key = tunnel_key(owner, cfg);
                let local = self.inner.tunnels.acquire(&key, cfg, timeout).await?;
                ("127.0.0.1".to_string(), local, Some(key))
            }
            None => (cfg.host.clone(), cfg.port, None),
        };
        let result = async {
            let (mut conn, opts) = open_conn(cfg, &host, port, &password, timeout).await?;
            if let Err(e) = prepare(&mut conn, cfg).await {
                let _ = conn.disconnect().await;
                return Err(e);
            }
            Ok((conn, opts))
        }
        .await;
        match result {
            Ok((conn, opts)) => Ok(Opened { conn, opts, tunnel }),
            Err(e) => {
                if let Some(key) = &tunnel {
                    self.inner.tunnels.release(key).await;
                }
                Err(e)
            }
        }
    }

    /// Connects, reads the server version, disconnects.
    pub async fn test(&self, owner: &str, args: ConnectArgs) -> Result<TestResult> {
        if args.config.driver == Driver::Trino {
            let client = self.trino_client(&args).await?;
            let init = args.config.init_sql.clone();
            let version = blocking(&client, move |t| t.check(init.as_deref())).await?;
            return Ok(TestResult { server_version: version });
        }
        // The test tunnel has its own key, so a running session never shares it.
        let test_owner = format!("{owner}#test");
        let mut opened = self.open(&test_owner, &args).await?;
        let version = opened.conn.query_first::<String, _>("SELECT VERSION()").await;
        let _ = opened.conn.disconnect().await;
        if let Some(key) = &opened.tunnel {
            self.inner.tunnels.release(key).await;
        }
        let version = version.map_err(|e| map_error(&e, Phase::Connect))?.unwrap_or_default();
        Ok(TestResult { server_version: version })
    }

    pub async fn connect(&self, owner: &str, args: ConnectArgs) -> Result<SessionInfo> {
        if args.config.driver == Driver::Trino {
            return self.connect_trino(owner, args).await;
        }
        let mut opened = self.open(owner, &args).await?;
        let info = opened
            .conn
            .query_first::<(String, u64, Option<String>), _>("SELECT VERSION(), CONNECTION_ID(), DATABASE()")
            .await;
        let (version, connection_id, database) = match info {
            Ok(Some(row)) => row,
            Ok(None) => (String::new(), u64::from(opened.conn.id()), None),
            Err(e) => {
                let _ = opened.conn.disconnect().await;
                if let Some(key) = &opened.tunnel {
                    self.inner.tunnels.release(key).await;
                }
                return Err(map_error(&e, Phase::Connect));
            }
        };
        let flags = opened.conn.last_ok_packet().map(|p| p.status_flags());
        let state = SessionState {
            autocommit: flags.map(|f| f.contains(StatusFlags::SERVER_STATUS_AUTOCOMMIT)).unwrap_or(true),
            in_transaction: flags.map(|f| f.contains(StatusFlags::SERVER_STATUS_IN_TRANS)).unwrap_or(false),
            database: database.clone(),
        };
        let id = format!("s{}", self.inner.next_id.fetch_add(1, Ordering::SeqCst));
        let session = Arc::new(Session {
            connection_id: opened.conn.id(),
            conn: Arc::new(tokio::sync::Mutex::new(Some(opened.conn))),
            side_opts: opened.opts,
            read_only: args.config.read_only,
            tunnel: opened.tunnel,
            state: Mutex::new(state.clone()),
            running: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
        });
        self.inner.sessions.lock().insert((owner.to_string(), id.clone()), Handle::Mysql(session.clone()));
        Ok(SessionInfo {
            session_id: id,
            driver: Driver::Mysql,
            supports_transactions: true,
            server_version: version,
            connection_id,
            database,
            autocommit: state.autocommit,
            read_only: session.read_only,
        })
    }

    async fn connect_trino(&self, owner: &str, args: ConnectArgs) -> Result<SessionInfo> {
        let client = self.trino_client(&args).await?;
        let init = args.config.init_sql.clone();
        let version = blocking(&client, move |t| t.check(init.as_deref())).await?;
        let id = format!("s{}", self.inner.next_id.fetch_add(1, Ordering::SeqCst));
        let info = SessionInfo {
            session_id: id.clone(),
            driver: Driver::Trino,
            supports_transactions: false,
            server_version: version,
            connection_id: 0,
            database: client.schema(),
            autocommit: true,
            read_only: args.config.read_only,
        };
        self.inner.sessions.lock().insert((owner.to_string(), id), Handle::Trino(client));
        Ok(info)
    }

    /// Closes a session. A session that does not exist is not an error.
    pub async fn disconnect(&self, owner: &str, session_id: &str) -> Result<()> {
        let removed = self.inner.sessions.lock().remove(&(owner.to_string(), session_id.to_string()));
        if let Some(sess) = removed {
            self.close_session(sess).await;
        }
        Ok(())
    }

    async fn close_session(&self, handle: Handle) {
        let sess = match handle {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                // Trino keeps no connection. Stopping the running statement is enough.
                let _ = tokio::task::spawn_blocking(move || t.cancel()).await;
                return;
            }
        };
        if sess.running.load(Ordering::SeqCst) {
            sess.cancel_requested.store(true, Ordering::SeqCst);
            let _ = sess.kill_query().await;
        }
        // The kill ends the statement soon. If it does not end within the wait time,
        // we leave the connection to be dropped when the running call ends.
        if let Ok(mut slot) = tokio::time::timeout(CLOSE_WAIT, sess.conn.clone().lock_owned()).await {
            if let Some(conn) = slot.take() {
                let _ = conn.disconnect().await;
            }
        }
        if let Some(key) = &sess.tunnel {
            self.inner.tunnels.release(key).await;
        }
    }

    /// Closes all sessions of an owner (a window).
    pub async fn close_owner(&self, owner: &str) {
        let list: Vec<Handle> = {
            let mut map = self.inner.sessions.lock();
            let keys: Vec<_> = map.keys().filter(|(o, _)| o == owner).cloned().collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        self.close_all_of(list).await;
    }

    /// Closes every session and tunnel. For app exit.
    pub async fn close_all(&self) {
        let list: Vec<Handle> = self.inner.sessions.lock().drain().map(|(_, s)| s).collect();
        self.close_all_of(list).await;
        self.inner.tunnels.kill_all_now();
    }

    async fn close_all_of(&self, list: Vec<Handle>) {
        let mut set = tokio::task::JoinSet::new();
        for sess in list {
            let me = self.clone();
            set.spawn(async move { me.close_session(sess).await });
        }
        while set.join_next().await.is_some() {}
    }

    /// Kills all ssh processes at once, without waiting. Use it when `close_all` ran out of time.
    pub fn kill_tunnels_now(&self) {
        self.inner.tunnels.kill_all_now();
    }

    /// Number of open sessions of an owner. For tests and diagnostics.
    pub fn session_count(&self, owner: &str) -> usize {
        self.inner.sessions.lock().keys().filter(|(o, _)| o == owner).count()
    }

    // --- Statements -------------------------------------------------------

    pub async fn execute(&self, owner: &str, session_id: &str, sql: &str, max_rows: usize) -> Result<ExecResult> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let sql = sql.to_string();
                return blocking(&t, move |t| t.execute(&sql, max_rows)).await;
            }
        };
        let mut guard = sess.acquire()?;
        let started = Instant::now();
        let run = run_statement(&sess, guard.conn()?, sql, max_rows, started).await;
        match run {
            Ok(done) => {
                if done.needs_refresh {
                    if let Ok(c) = guard.conn() {
                        sess.refresh_state(c).await;
                    }
                } else {
                    sess.sync_state(guard.conn()?);
                }
                if may_change_database(sql) {
                    if let Ok(db) = guard.conn()?.query_first::<Option<String>, _>("SELECT DATABASE()").await {
                        sess.state.lock().database = db.flatten();
                    }
                }
                if sess.cancel_requested.load(Ordering::SeqCst) {
                    // The server stopped the statement, but some statements (SLEEP) end without an error.
                    return Err(Error::cancelled());
                }
                let tx = sess.tx_state();
                let database = sess.state.lock().database.clone();
                Ok(ExecResult {
                    results: done.results,
                    database,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    autocommit: tx.autocommit,
                    in_transaction: tx.in_transaction,
                })
            }
            Err(e) => {
                if !is_lost(&e) {
                    if let Ok(c) = guard.conn() {
                        sess.refresh_state(c).await;
                    }
                }
                Err(sess.fail(e))
            }
        }
    }

    /// Stops the running statement. Does nothing when no statement runs.
    pub async fn cancel(&self, owner: &str, session_id: &str) -> Result<()> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                tokio::task::spawn_blocking(move || t.cancel()).await.map_err(|e| Error::internal(e.to_string()))?;
                return Ok(());
            }
        };
        if !sess.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        sess.cancel_requested.store(true, Ordering::SeqCst);
        sess.kill_query().await.map_err(|e| map_error(&e, Phase::Run))
    }

    async fn simple(&self, owner: &str, session_id: &str, sql: &str) -> Result<TxState> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(_) => return Err(not_for_trino("changing auto-commit, COMMIT and ROLLBACK")),
        };
        let mut guard = sess.acquire()?;
        let r = guard.conn()?.query_drop(sql).await;
        match r {
            Ok(()) => {
                sess.sync_state(guard.conn()?);
                Ok(sess.tx_state())
            }
            Err(e) => {
                if !is_lost(&e) {
                    if let Ok(c) = guard.conn() {
                        sess.refresh_state(c).await;
                    }
                }
                Err(sess.fail(e))
            }
        }
    }

    pub async fn set_autocommit(&self, owner: &str, session_id: &str, on: bool) -> Result<TxState> {
        self.simple(owner, session_id, if on { "SET autocommit = 1" } else { "SET autocommit = 0" }).await
    }

    pub async fn commit(&self, owner: &str, session_id: &str) -> Result<TxState> {
        self.simple(owner, session_id, "COMMIT").await
    }

    pub async fn rollback(&self, owner: &str, session_id: &str) -> Result<TxState> {
        self.simple(owner, session_id, "ROLLBACK").await
    }

    /// `USE <database>`.
    pub async fn use_database(&self, owner: &str, session_id: &str, database: &str) -> Result<()> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let db = database.to_string();
                return blocking(&t, move |t| t.use_database(&db)).await;
            }
        };
        let mut guard = sess.acquire()?;
        let r = guard.conn()?.query_drop(format!("USE {}", schema::quote_ident(database))).await;
        sess.finish(r)?;
        sess.sync_state(guard.conn()?);
        sess.state.lock().database = Some(database.to_string());
        Ok(())
    }

    // --- Schema -----------------------------------------------------------

    pub async fn databases(&self, owner: &str, session_id: &str) -> Result<Vec<String>> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => return blocking(&t, |t| t.databases()).await,
        };
        let mut guard = sess.acquire()?;
        let r = schema::databases(guard.conn()?).await;
        sess.finish(r)
    }

    pub async fn objects(&self, owner: &str, session_id: &str, database: &str) -> Result<DbObjects> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let db = database.to_string();
                return blocking(&t, move |t| t.objects(&db)).await;
            }
        };
        let mut guard = sess.acquire()?;
        let r = schema::objects(guard.conn()?, database).await;
        sess.finish(r)
    }

    pub async fn columns(&self, owner: &str, session_id: &str, database: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let (db, table) = (database.to_string(), table.to_string());
                return blocking(&t, move |t| t.columns(&db, &table)).await;
            }
        };
        let mut guard = sess.acquire()?;
        let r = schema::columns(guard.conn()?, database, table).await;
        sess.finish(r)
    }

    pub async fn indexes(&self, owner: &str, session_id: &str, database: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            // Trino has no indexes.
            Handle::Trino(_) => return Ok(Vec::new()),
        };
        let mut guard = sess.acquire()?;
        let r = schema::indexes(guard.conn()?, database, table).await;
        sess.finish(r)
    }

    pub async fn ddl(&self, owner: &str, session_id: &str, database: &str, name: &str, kind: ObjectKind) -> Result<String> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let (db, name) = (database.to_string(), name.to_string());
                return blocking(&t, move |t| t.ddl(&db, &name, kind)).await;
            }
        };
        let mut guard = sess.acquire()?;
        let r = schema::ddl(guard.conn()?, database, name, kind).await;
        match sess.finish(r)? {
            Some(text) => Ok(text),
            None => Err(Error::new(codes::DB_ERROR, format!("the server does not show the definition of `{name}` (missing privilege?)"))),
        }
    }

    pub async fn completion_schema(&self, owner: &str, session_id: &str, database: &str) -> Result<std::collections::BTreeMap<String, Vec<String>>> {
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let db = database.to_string();
                return blocking(&t, move |t| t.completion_schema(&db)).await;
            }
        };
        let mut guard = sess.acquire()?;
        let r = schema::completion_schema(guard.conn()?, database).await;
        sess.finish(r)
    }

    // --- Export -----------------------------------------------------------

    /// Runs one read statement and writes ALL rows into a CSV file. The rows go
    /// to `<path>.part` as they arrive. At the end the file gets its real name.
    /// On an error or a cancel the part file is deleted.
    pub async fn export_csv(&self, owner: &str, session_id: &str, sql: &str, path: &str, options: ExportOptions) -> Result<ExportResult> {
        let opts = CsvOptions::resolve(&options)?;
        let sess = match self.handle(owner, session_id)? {
            Handle::Mysql(s) => s,
            Handle::Trino(t) => {
                let (sql, path) = (sql.to_string(), path.to_string());
                return blocking(&t, move |t| t.export_csv(&sql, &path, &options)).await;
            }
        };
        check_read_only(sql, Dialect::Mysql, &[])?;
        let target = check_target(path)?;
        let mut guard = sess.acquire()?;
        let started = Instant::now();
        let run = export_stream(&sess, guard.conn()?, sql, &target, opts, started).await;
        match run {
            Ok(done) => {
                sess.sync_state(guard.conn()?);
                Ok(done)
            }
            Err(e) => {
                if e.code() != codes::DB_LOST {
                    if let Ok(c) = guard.conn() {
                        sess.refresh_state(c).await;
                    }
                }
                Err(e)
            }
        }
    }

    // --- Passwords --------------------------------------------------------

    pub async fn password_set(&self, id: &str, password: &str) -> Result<()> {
        keychain::set(id, password).await
    }

    pub async fn password_delete(&self, id: &str) -> Result<()> {
        keychain::delete(id).await
    }

    pub async fn password_exists(&self, id: &str) -> Result<bool> {
        keychain::exists(id).await
    }
}

/// Runs the init SQL and the read-only setting of a new connection.
async fn prepare(conn: &mut Conn, cfg: &ConnectionConfig) -> Result<()> {
    if cfg.read_only {
        conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(|e| map_error(&e, Phase::Connect))?;
    }
    if let Some(init) = cfg.init_sql.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let run = async {
            let qr = conn.query_iter(init).await?;
            qr.drop_result().await
        };
        run.await.map_err(|e| match &e {
            mysql_async::Error::Server(s) => Error::new(codes::DB_CONNECT, format!("init SQL failed: {}", error::server_message(s))),
            other => map_error(other, Phase::Connect),
        })?;
    }
    Ok(())
}

/// Streams the rows of one statement into `<target>.part`, then renames the file.
async fn export_stream(sess: &Arc<Session>, conn: &mut Conn, sql: &str, target: &std::path::Path, opts: CsvOptions, started: Instant) -> Result<ExportResult> {
    let part = part_path(target);
    let file = tokio::fs::File::create(&part).await?;
    // The guard is declared first, so the file is closed before the guard removes it.
    let mut part_guard = PartGuard::new(part.clone());
    let mut out = tokio::io::BufWriter::with_capacity(256 * 1024, file);
    let mut bytes: u64 = 0;
    let mut rows: u64 = 0;
    if opts.bom {
        out.write_all(BOM).await?;
        bytes += BOM.len() as u64;
    }
    let mut qr = conn.query_iter(sql).await.map_err(|e| sess.fail(e))?;
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    if let Some(cols) = qr.columns() {
        let columns: Vec<Column> = cols.iter().map(describe_column).collect();
        let binary: Vec<bool> = columns.iter().map(|c| c.binary).collect();
        if opts.header {
            push_row(&mut buf, opts.delimiter, columns.iter().map(|c| Some(c.name.as_str())));
            out.write_all(&buf).await?;
            bytes += buf.len() as u64;
        }
        loop {
            let next = qr.next().await;
            let row = match next {
                Ok(r) => r,
                Err(e) => return Err(sess.fail(e)),
            };
            let Some(row) = row else { break };
            if sess.cancel_requested.load(Ordering::SeqCst) {
                // `cancel` already sent KILL QUERY. Read what is on the way.
                let _ = qr.drop_result().await;
                return Err(Error::cancelled());
            }
            let values: Vec<Option<String>> = row.unwrap().iter().zip(&binary).map(|(v, b)| format_value(v, *b)).collect();
            buf.clear();
            push_row(&mut buf, opts.delimiter, values.iter().map(|v| v.as_deref()));
            if let Err(e) = out.write_all(&buf).await {
                let _ = sess.kill_query().await;
                let _ = qr.drop_result().await;
                return Err(e.into());
            }
            bytes += buf.len() as u64;
            rows += 1;
        }
    }
    // A later result set (it should not exist for a read statement) is read and dropped.
    qr.drop_result().await.map_err(|e| sess.fail(e))?;
    if sess.cancel_requested.load(Ordering::SeqCst) {
        return Err(Error::cancelled());
    }
    out.flush().await?;
    out.shutdown().await?;
    drop(out);
    tokio::fs::rename(&part, target).await?;
    part_guard.disarm();
    Ok(ExportResult { rows, bytes, elapsed_ms: started.elapsed().as_millis() as u64 })
}

struct Done {
    results: Vec<QueryResult>,
    /// The result was cut short and the statement was killed. The status flags need a refresh.
    needs_refresh: bool,
}

/// Runs one statement and reads all its result sets (up to `max_rows` rows each).
/// `max_rows == 0` means no limit.
async fn run_statement(sess: &Arc<Session>, conn: &mut Conn, sql: &str, max_rows: usize, started: Instant) -> mysql_async::Result<Done> {
    let mut qr = conn.query_iter(sql).await?;
    let mut results: Vec<QueryResult> = Vec::new();
    loop {
        let Some(cols) = qr.columns() else {
            // No more result sets. This call also reports an error of a later result set.
            qr.next().await?;
            break;
        };
        if cols.is_empty() {
            results.push(QueryResult {
                kind: ResultKind::Affected,
                columns: Vec::new(),
                rows: Vec::new(),
                truncated: false,
                affected_rows: qr.affected_rows(),
                last_insert_id: qr.last_insert_id().filter(|id| *id > 0).map(|id| id.to_string()),
                warnings: qr.warnings(),
                info: Some(qr.info().into_owned()).filter(|s| !s.is_empty()),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
            qr.next().await?;
            continue;
        }
        let columns: Vec<Column> = cols.iter().map(describe_column).collect();
        let binary: Vec<bool> = columns.iter().map(|c| c.binary).collect();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;
        while let Some(row) = qr.next().await? {
            if max_rows > 0 && rows.len() >= max_rows {
                truncated = true;
                break;
            }
            rows.push(row.unwrap().iter().zip(&binary).map(|(v, b)| format_value(v, *b)).collect());
        }
        results.push(QueryResult {
            kind: ResultKind::Rows,
            columns,
            rows,
            truncated,
            affected_rows: 0,
            last_insert_id: None,
            warnings: qr.warnings(),
            info: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
        if truncated {
            // Stop the server from sending more rows, then read what is already on the way.
            // The killed statement ends with error 1317. We ignore it.
            let _ = sess.kill_query().await;
            let _ = qr.drop_result().await;
            return Ok(Done { results, needs_refresh: true });
        }
    }
    drop_empty_tail(&mut results);
    Ok(Done { results, needs_refresh: false })
}

/// A CALL ends with an OK packet after its result sets. Without information it is only noise.
fn drop_empty_tail(results: &mut Vec<QueryResult>) {
    let has_rows = results.iter().any(|r| r.kind == ResultKind::Rows);
    if has_rows {
        if let Some(last) = results.last() {
            if last.kind == ResultKind::Affected && last.affected_rows == 0 && last.info.is_none() && last.last_insert_id.is_none() {
                results.pop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_first_keyword() {
        assert_eq!(first_keyword("  SELECT 1"), "select");
        assert_eq!(first_keyword("/* note */ use kestrel_demo"), "use");
        assert_eq!(first_keyword("-- c\n# d\nDROP DATABASE x"), "drop");
        assert_eq!(first_keyword("/* open"), "");
        assert_eq!(first_keyword(""), "");
    }

    #[test]
    fn database_may_change_for_use_and_drop() {
        assert!(may_change_database("USE x"));
        assert!(may_change_database("drop database x"));
        assert!(!may_change_database("select 1"));
    }

    fn affected(n: u64, info: Option<&str>) -> QueryResult {
        QueryResult {
            kind: ResultKind::Affected,
            columns: vec![],
            rows: vec![],
            truncated: false,
            affected_rows: n,
            last_insert_id: None,
            warnings: 0,
            info: info.map(String::from),
            elapsed_ms: 0,
        }
    }

    fn rows() -> QueryResult {
        QueryResult { kind: ResultKind::Rows, ..affected(0, None) }
    }

    #[test]
    fn empty_ok_after_result_sets_is_dropped() {
        let mut v = vec![rows(), rows(), affected(0, None)];
        drop_empty_tail(&mut v);
        assert_eq!(v.len(), 2);
        let mut v = vec![rows(), affected(3, None)];
        drop_empty_tail(&mut v);
        assert_eq!(v.len(), 2);
        let mut only = vec![affected(0, None)];
        drop_empty_tail(&mut only);
        assert_eq!(only.len(), 1);
    }

    #[test]
    fn timeout_is_limited() {
        let mut cfg = crate::tunnel_test_config();
        cfg.connect_timeout_sec = Some(0);
        assert_eq!(connect_timeout(&cfg), Duration::from_secs(1));
        cfg.connect_timeout_sec = None;
        assert_eq!(connect_timeout(&cfg), Duration::from_secs(10));
    }
}
