//! Tests of the Trino client against a mock Trino server.
//! The mock is a small HTTP server on 127.0.0.1 (std only). It needs no network
//! and no MySQL. Every request is recorded, so tests can check headers and DELETE calls.

use kestrel_db::*;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

const OWNER: &str = "trino-test";

// --- Mock server --------------------------------------------------------------

#[derive(Clone, Debug)]
struct Req {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Req {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn ok(body: Value) -> Resp {
    Resp { status: 200, headers: vec![], body: body.to_string() }
}

struct Mock {
    base: String,
    port: u16,
    log: Arc<Mutex<Vec<Req>>>,
}

impl Mock {
    /// `handler(request, base_url)` answers every request.
    fn start(handler: impl Fn(&Req, &str) -> Resp + Send + Sync + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");
        let log = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(handler);
        let (b, l) = (base.clone(), log.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (h, b, l) = (handler.clone(), b.clone(), l.clone());
                std::thread::spawn(move || serve(stream, &*h, &b, &l));
            }
        });
        Mock { base, port, log }
    }

    fn requests(&self) -> Vec<Req> {
        self.log.lock().clone()
    }

    fn count(&self, method: &str, path_prefix: &str) -> usize {
        self.requests().iter().filter(|r| r.method == method && r.path.starts_with(path_prefix)).count()
    }
}

fn serve(mut stream: TcpStream, handler: &dyn Fn(&Req, &str) -> Resp, base: &str, log: &Mutex<Vec<Req>>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let length: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let req = Req { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() };
    log.lock().push(req.clone());
    let resp = handler(&req, base);
    let mut out = format!("HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n", resp.status, resp.body.len());
    for (k, v) in &resp.headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.write_all(resp.body.as_bytes());
}

/// The answers that every test needs: `SELECT 1` and `/v1/info`.
fn basics(req: &Req) -> Option<Resp> {
    if req.method == "GET" && req.path == "/v1/info" {
        return Some(ok(json!({ "nodeVersion": { "version": "999" } })));
    }
    if req.method == "POST" && req.body.trim() == "SELECT 1" {
        return Some(ok(json!({ "columns": [{ "name": "_col0", "type": "integer" }], "data": [[1]] })));
    }
    None
}

fn not_found() -> Resp {
    Resp { status: 404, headers: vec![], body: "{}".into() }
}

// --- Helpers ------------------------------------------------------------------

fn config(mock: &Mock, extra: Value) -> ConnectionConfig {
    let mut v = json!({
        "id": "t1", "name": "t", "driver": "trino", "catalog": "hive", "host": "127.0.0.1", "port": mock.port,
        "user": "alice", "database": "sales", "ssl": "disabled", "trinoAuth": "none",
        "readOnly": false, "production": false
    });
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn args(mock: &Mock, extra: Value) -> ConnectArgs {
    ConnectArgs { config: config(mock, extra), password: Some("pw".into()) }
}

async fn connect(m: &DbManager, mock: &Mock) -> SessionInfo {
    m.connect(OWNER, args(mock, json!({}))).await.expect("connect")
}

fn cell(r: &ExecResult, row: usize, col: usize) -> Option<String> {
    r.results[0].rows[row][col].clone()
}

fn temp_csv() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.csv").to_str().unwrap().to_string();
    (dir, path)
}

// --- Tests --------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn session_info_and_headers() {
    let mock = Mock::start(|req, _| basics(req).unwrap_or_else(not_found));
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    assert_eq!(s.driver, Driver::Trino);
    assert!(!s.supports_transactions && s.autocommit);
    assert_eq!(s.server_version, "999");
    assert_eq!(s.database.as_deref(), Some("sales"));
    let post = mock.requests().into_iter().find(|r| r.method == "POST").unwrap();
    assert_eq!(post.path, "/v1/statement");
    assert_eq!(post.header("X-Trino-User"), Some("alice"));
    assert_eq!(post.header("X-Trino-Catalog"), Some("hive"));
    assert_eq!(post.header("X-Trino-Schema"), Some("sales"));
    assert_eq!(post.header("X-Trino-Source"), Some("kestrel"));
    assert!(post.header("Authorization").is_none());
    assert_eq!(m.test(OWNER, args(&mock, json!({}))).await.unwrap().server_version, "999");
}

#[tokio::test(flavor = "multi_thread")]
async fn paging_columns_and_value_mapping() {
    let mock = Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", "/v1/statement") => ok(json!({ "id": "q1", "nextUri": format!("{base}/v1/statement/q1/1"), "stats": { "state": "QUEUED" } })),
            ("GET", "/v1/statement/q1/1") => ok(json!({
                "nextUri": format!("{base}/v1/statement/q1/2"),
                "columns": [
                    { "name": "id", "type": "bigint" }, { "name": "name", "type": "varchar(10)" },
                    { "name": "price", "type": "decimal(10,2)" }, { "name": "tags", "type": "array(varchar)" },
                    { "name": "ok", "type": "boolean" }, { "name": "raw", "type": "varbinary" },
                    { "name": "ratio", "type": "double" }, { "name": "m", "type": "map(varchar,integer)" }
                ],
                "data": [[9007199254740993_i64, "a", "12.50", ["x", "y"], true, "AH8=", 1.5e10, {"k": 1}]]
            })),
            ("GET", "/v1/statement/q1/2") => {
                // Page 2 repeats the columns, as Trino does. Whitespace in nested values must go.
                let body = r#"{"nextUri":"BASE/v1/statement/q1/3","columns":[{"name":"id","type":"bigint"}],
                    "data":[[2,null,null,[ ],false,null,null,{ }]]}"#;
                Resp { status: 200, headers: vec![], body: body.replace("BASE", base) }
            }
            ("GET", "/v1/statement/q1/3") => ok(json!({ "data": [[3, "c d", "0.01", [[1, 2], [3]], null, null, "NaN", null]] })),
            _ => not_found(),
        }
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let r = m.execute(OWNER, &s.session_id, "SELECT * FROM t;", 100).await.unwrap();
    let res = &r.results[0];
    assert_eq!(res.kind, ResultKind::Rows);
    assert!(!res.truncated);
    assert_eq!(res.rows.len(), 3);
    let types: Vec<_> = res.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(types, ["bigint", "varchar(10)", "decimal(10,2)", "array(varchar)", "boolean", "varbinary", "double", "map(varchar,integer)"]);
    let numeric: Vec<_> = res.columns.iter().map(|c| c.numeric).collect();
    assert_eq!(numeric, [true, false, true, false, false, false, true, false]);
    assert!(res.columns[5].binary && !res.columns[0].binary);
    assert_eq!(r.results[0].rows[0][0].as_deref(), Some("9007199254740993"));
    assert_eq!(cell(&r, 0, 2).as_deref(), Some("12.50"));
    assert_eq!(cell(&r, 0, 3).as_deref(), Some("[\"x\",\"y\"]"));
    assert_eq!(cell(&r, 0, 4).as_deref(), Some("true"));
    assert_eq!(cell(&r, 0, 5).as_deref(), Some("0x007F"));
    assert_eq!(cell(&r, 0, 6).as_deref(), Some("15000000000.0"));
    assert_eq!(cell(&r, 0, 7).as_deref(), Some("{\"k\":1}"));
    assert_eq!(cell(&r, 1, 1), None);
    assert_eq!(cell(&r, 1, 3).as_deref(), Some("[]"));
    assert_eq!(cell(&r, 1, 7).as_deref(), Some("{}"));
    assert_eq!(cell(&r, 2, 3).as_deref(), Some("[[1,2],[3]]"));
    assert_eq!(cell(&r, 2, 6).as_deref(), Some("NaN"));
    // The trailing `;` was removed from the statement text.
    let posts: Vec<_> = mock.requests().into_iter().filter(|r| r.method == "POST" && r.body.contains("FROM t")).collect();
    assert_eq!(posts[0].body, "SELECT * FROM t");
    assert_eq!(r.database.as_deref(), Some("sales"));
    assert!(r.autocommit && !r.in_transaction);
}

#[tokio::test(flavor = "multi_thread")]
async fn server_error_is_db_error_with_error_name() {
    let mock = Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        match req.method.as_str() {
            "POST" => ok(json!({ "nextUri": format!("{base}/v1/statement/e/1") })),
            _ => ok(json!({ "error": { "message": "line 1:15: Table 'hive.sales.nope' does not exist", "errorName": "TABLE_NOT_FOUND", "errorType": "USER_ERROR" } })),
        }
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let err = m.execute(OWNER, &s.session_id, "SELECT * FROM nope", 10).await.unwrap_err();
    assert_eq!(err.code(), "db_error");
    assert_eq!(err.to_string(), "TABLE_NOT_FOUND: line 1:15: Table 'hive.sales.nope' does not exist");
    // The session can run the next statement.
    assert!(m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn update_statement_gives_affected_result() {
    let mock = Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        match req.method.as_str() {
            "POST" => ok(json!({ "nextUri": format!("{base}/v1/statement/u/1"), "columns": [{ "name": "rows", "type": "bigint" }], "data": [[3]] })),
            _ => ok(json!({ "updateType": "INSERT", "updateCount": 3 })),
        }
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let r = m.execute(OWNER, &s.session_id, "INSERT INTO t SELECT 1", 10).await.unwrap();
    let res = &r.results[0];
    assert_eq!((res.kind, res.affected_rows, res.info.as_deref()), (ResultKind::Affected, 3, Some("INSERT")));
    assert!(res.rows.is_empty() && res.columns.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn max_rows_truncates_and_sends_delete() {
    let mock = Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        let page = |n: u32| {
            let rows: Vec<Value> = (0..2).map(|i| json!([n * 2 + i])).collect();
            json!({ "nextUri": format!("{base}/v1/statement/t/{}", n + 1), "columns": [{ "name": "n", "type": "integer" }], "data": rows })
        };
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", _) => ok(page(0)),
            ("GET", "/v1/statement/t/1") => ok(page(1)),
            ("GET", "/v1/statement/t/2") => ok(page(2)),
            ("DELETE", _) => Resp { status: 204, headers: vec![], body: String::new() },
            _ => not_found(),
        }
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let r = m.execute(OWNER, &s.session_id, "SELECT n FROM big", 3).await.unwrap();
    assert!(r.results[0].truncated);
    assert_eq!(r.results[0].rows.len(), 3);
    assert_eq!(mock.count("GET", "/v1/statement/t/1"), 1);
    assert_eq!(mock.count("GET", "/v1/statement/t/2"), 0);
    // The rest of the query is cancelled at the `nextUri` of page 1.
    let del: Vec<_> = mock.requests().into_iter().filter(|r| r.method == "DELETE").collect();
    assert_eq!(del.len(), 1);
    assert_eq!(del[0].path, "/v1/statement/t/2");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_sends_delete_and_ends_with_cancelled() {
    let mock = Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", _) if req.body.contains("slow") => ok(json!({ "nextUri": format!("{base}/v1/statement/s/1") })),
            ("GET", "/v1/statement/s/1") => {
                std::thread::sleep(Duration::from_millis(600));
                ok(json!({ "nextUri": format!("{base}/v1/statement/s/2") }))
            }
            ("DELETE", _) => Resp { status: 204, headers: vec![], body: String::new() },
            _ => not_found(),
        }
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let (m2, sid) = (m.clone(), s.session_id.clone());
    let task = tokio::spawn(async move { m2.execute(OWNER, &sid, "SELECT slow", 10).await });
    tokio::time::sleep(Duration::from_millis(250)).await;
    let busy = m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.unwrap_err();
    assert_eq!(busy.code(), "db_busy");
    let schema_busy = m.databases(OWNER, &s.session_id).await.unwrap_err();
    assert_eq!(schema_busy.code(), "db_busy");
    m.cancel(OWNER, &s.session_id).await.unwrap();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err.code(), "cancelled");
    assert!(mock.count("DELETE", "/v1/statement/s/1") >= 1);
    assert!(m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.is_ok());
    // Cancel with nothing running does nothing.
    m.cancel(OWNER, &s.session_id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn password_login_uses_basic_auth_over_a_checked_link() {
    let expected = "Basic YWxpY2U6cHc="; // alice:pw
    let mock = Mock::start(move |req, _| {
        if req.header("Authorization") != Some(expected) {
            return Resp { status: 401, headers: vec![("WWW-Authenticate".into(), "Basic realm=\"Trino\"".into())], body: "Unauthorized".into() };
        }
        basics(req).unwrap_or_else(not_found)
    });
    let opts = TrinoOptions { allow_http_password: true, ..TrinoOptions::default() };
    let m = DbManager::with_trino_options(opts);
    let mut bad = args(&mock, json!({ "trinoAuth": "password" }));
    bad.password = Some("wrong".into());
    let err = m.connect(OWNER, bad).await.unwrap_err();
    assert_eq!(err.code(), "db_auth");
    let s = m.connect(OWNER, args(&mock, json!({ "trinoAuth": "password" }))).await.unwrap();
    assert_eq!(s.server_version, "999");
    assert!(mock.requests().iter().filter(|r| r.method == "POST").all(|r| r.header("Authorization").is_some()));
}

#[tokio::test(flavor = "multi_thread")]
async fn password_over_http_is_refused_and_none_with_401_is_db_auth() {
    let mock = Mock::start(|_, _| Resp { status: 401, headers: vec![], body: "login please".into() });
    let m = DbManager::new();
    let err = m.connect(OWNER, args(&mock, json!({ "trinoAuth": "password" }))).await.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    // The default login type is `password` when SSL is on, so it is also refused for http only if chosen.
    let err = m.connect(OWNER, args(&mock, json!({ "trinoAuth": "none" }))).await.unwrap_err();
    assert_eq!(err.code(), "db_auth");
    assert!(err.to_string().contains("login please"), "{err}");
    assert_eq!(mock.count("POST", "/v1/statement"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn oauth2_flow_opens_browser_polls_token_and_keeps_token() {
    let polls = Arc::new(Mutex::new(0u32));
    let p2 = polls.clone();
    let mock = Mock::start(move |req, base| {
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/oauth2/token/abc") => {
                *p2.lock() += 1;
                ok(json!({ "nextUri": format!("{base}/oauth2/token/abc2") }))
            }
            ("GET", "/oauth2/token/abc2") => ok(json!({ "token": "tok-123" })),
            _ if req.header("Authorization") == Some("Bearer tok-123") => basics(req).unwrap_or_else(not_found),
            _ => Resp {
                status: 401,
                headers: vec![(
                    "WWW-Authenticate".into(),
                    format!("Bearer x_redirect_server=\"{base}/oauth2/initiate/abc\", x_token_server=\"{base}/oauth2/token/abc\""),
                )],
                body: String::new(),
            },
        }
    });
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let o2 = opened.clone();
    let opts = TrinoOptions {
        open_browser: Arc::new(move |url| {
            o2.lock().push(url.to_string());
            Ok(())
        }),
        poll_interval: Duration::from_millis(10),
        ..TrinoOptions::default()
    };
    let m = DbManager::with_trino_options(opts);
    let cfg = json!({ "trinoAuth": "oauth2" });
    let s = m.connect(OWNER, args(&mock, cfg.clone())).await.unwrap();
    assert_eq!(s.server_version, "999");
    assert_eq!(opened.lock().as_slice(), [format!("{}/oauth2/initiate/abc", mock.base)]);
    assert_eq!(*polls.lock(), 1);
    // The retried statement carried the token.
    let posts: Vec<_> = mock.requests().into_iter().filter(|r| r.method == "POST").collect();
    assert_eq!(posts.len(), 2);
    assert!(posts[0].header("Authorization").is_none());
    assert_eq!(posts[1].header("Authorization"), Some("Bearer tok-123"));
    // A second session of the same connection reuses the token: no browser.
    let s2 = m.connect(OWNER, args(&mock, cfg)).await.unwrap();
    assert_eq!(opened.lock().len(), 1);
    assert!(m.execute(OWNER, &s2.session_id, "SELECT 1", 10).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn oauth2_login_times_out_and_missing_header_is_db_auth() {
    let mock = Mock::start(|req, base| match req.path.as_str() {
        "/never" => ok(json!({ "nextUri": format!("{base}/never") })),
        "/v1/statement" if req.body.contains("plain401") => Resp { status: 401, headers: vec![], body: String::new() },
        _ => Resp {
            status: 401,
            headers: vec![("WWW-Authenticate".into(), format!("Bearer x_redirect_server=\"{base}/r\", x_token_server=\"{base}/never\""))],
            body: String::new(),
        },
    });
    let opts = TrinoOptions {
        open_browser: Arc::new(|_| Ok(())),
        poll_interval: Duration::from_millis(10),
        login_timeout: Duration::from_millis(300),
        ..TrinoOptions::default()
    };
    let m = DbManager::with_trino_options(opts);
    let t = Instant::now();
    let err = m.connect(OWNER, args(&mock, json!({ "trinoAuth": "oauth2" }))).await.unwrap_err();
    assert_eq!(err.code(), "db_auth");
    assert!(err.to_string().contains("timed out"), "{err}");
    assert!(t.elapsed() < Duration::from_secs(5));

    let no_oauth = Mock::start(|_, _| Resp { status: 401, headers: vec![("WWW-Authenticate".into(), "Basic realm=\"x\"".into())], body: String::new() });
    let m2 = DbManager::with_trino_options(TrinoOptions { open_browser: Arc::new(|_| panic!("no browser")), ..TrinoOptions::default() });
    let err = m2.connect(OWNER, args(&no_oauth, json!({ "trinoAuth": "oauth2" }))).await.unwrap_err();
    assert_eq!(err.code(), "db_auth");
}

#[tokio::test(flavor = "multi_thread")]
async fn transactions_are_invalid_input() {
    let mock = Mock::start(|req, _| basics(req).unwrap_or_else(not_found));
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    for r in [m.set_autocommit(OWNER, &s.session_id, false).await, m.commit(OWNER, &s.session_id).await, m.rollback(OWNER, &s.session_id).await] {
        let err = r.unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(err.to_string().contains("auto-commit"), "{err}");
    }
    // Nothing reached the server.
    assert_eq!(mock.count("POST", "/v1/statement"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn unreachable_server_is_db_connect() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mock = Mock { base: String::new(), port, log: Arc::new(Mutex::new(vec![])) };
    let m = DbManager::new();
    let err = m.connect(OWNER, args(&mock, json!({ "connectTimeoutSec": 2 }))).await.unwrap_err();
    assert_eq!(err.code(), "db_connect");
}

#[tokio::test(flavor = "multi_thread")]
async fn schema_calls_use_information_schema() {
    let mock = Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        if req.method == "DELETE" {
            return not_found();
        }
        let sql = req.body.as_str();
        let rows = |cols: &[&str], data: Value| ok(json!({ "columns": cols.iter().map(|c| json!({ "name": c, "type": "varchar" })).collect::<Vec<_>>(), "data": data }));
        let _ = base;
        if sql == "SHOW SCHEMAS FROM \"hive\"" {
            rows(&["Schema"], json!([["information_schema"], ["sales"]]))
        } else if sql.contains("\"hive\".information_schema.tables") && sql.contains("table_schema = 'sa''les'") {
            rows(&["table_name", "table_type"], json!([["orders", "BASE TABLE"], ["v_orders", "VIEW"]]))
        } else if sql.contains("information_schema.columns") && sql.contains("table_name = 'orders'") {
            rows(&["c", "t", "n", "d", "cm"], json!([["id", "bigint", "NO", null, "key"], ["note", "varchar", "YES", "x", null]]))
        } else if sql.contains("information_schema.columns") {
            rows(&["t", "c"], json!([["orders", "id"], ["orders", "note"], ["items", "sku"]]))
        } else if sql == "SHOW CREATE TABLE \"hive\".\"sales\".\"orders\"" {
            rows(&["Create Table"], json!([["CREATE TABLE hive.sales.orders (\n   id bigint\n)"]]))
        } else if sql == "SHOW CREATE VIEW \"hive\".\"sales\".\"v_orders\"" {
            rows(&["Create View"], json!([["CREATE VIEW v AS SELECT 1"]]))
        } else {
            Resp { status: 200, headers: vec![], body: json!({ "error": { "message": format!("unexpected: {sql}"), "errorName": "TEST" } }).to_string() }
        }
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    assert_eq!(m.databases(OWNER, &s.session_id).await.unwrap(), ["information_schema", "sales"]);
    let o = m.objects(OWNER, &s.session_id, "sa'les").await.unwrap();
    assert_eq!((o.tables.len(), o.views.len(), o.procedures.len()), (1, 1, 0));
    assert_eq!((o.tables[0].name.as_str(), o.views[0].name.as_str()), ("orders", "v_orders"));
    let c = m.columns(OWNER, &s.session_id, "sales", "orders").await.unwrap();
    assert_eq!((c[0].name.as_str(), c[0].type_name.as_str(), c[0].nullable, c[0].comment.as_deref()), ("id", "bigint", false, Some("key")));
    assert!(c[1].nullable && c[1].default_value.as_deref() == Some("x"));
    assert!(m.indexes(OWNER, &s.session_id, "sales", "orders").await.unwrap().is_empty());
    assert!(m.ddl(OWNER, &s.session_id, "sales", "orders", ObjectKind::Table).await.unwrap().starts_with("CREATE TABLE hive.sales.orders"));
    assert!(m.ddl(OWNER, &s.session_id, "sales", "v_orders", ObjectKind::View).await.unwrap().starts_with("CREATE VIEW"));
    let err = m.ddl(OWNER, &s.session_id, "sales", "p", ObjectKind::Procedure).await.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    let map = m.completion_schema(OWNER, &s.session_id, "sales").await.unwrap();
    assert_eq!(map["orders"], ["id", "note"]);
    assert_eq!(map["items"], ["sku"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn use_changes_the_schema_header_and_set_schema_header_is_read() {
    let mock = Mock::start(|req, _| {
        if req.method == "POST" && req.body.starts_with("USE ") {
            return Resp {
                status: 200,
                headers: vec![("X-Trino-Set-Schema".into(), "other%20schema".into())],
                body: json!({ "updateType": "USE" }).to_string(),
            };
        }
        basics(req).unwrap_or_else(not_found)
    });
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    m.use_database(OWNER, &s.session_id, "marketing").await.unwrap();
    m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.unwrap();
    let last = mock.requests().into_iter().filter(|r| r.method == "POST").last().unwrap();
    assert_eq!(last.header("X-Trino-Schema"), Some("marketing"));
    // A `USE` statement of the user changes the schema through the answer header.
    let r = m.execute(OWNER, &s.session_id, "USE other_schema", 10).await.unwrap();
    assert_eq!(r.database.as_deref(), Some("other schema"));
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_connection_refuses_writes() {
    let mock = Mock::start(|req, _| basics(req).unwrap_or_else(not_found));
    let m = DbManager::new();
    let s = m.connect(OWNER, args(&mock, json!({ "readOnly": true }))).await.unwrap();
    assert!(s.read_only);
    let err = m.execute(OWNER, &s.session_id, "DELETE FROM t", 10).await.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.is_ok());
}

fn csv_mock() -> Mock {
    Mock::start(|req, base| {
        if let Some(r) = basics(req) {
            return r;
        }
        let cols = json!([{ "name": "id", "type": "integer" }, { "name": "txt", "type": "varchar" }, { "name": "tags", "type": "array(varchar)" }]);
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", _) if req.body.contains("fail") => ok(json!({ "nextUri": format!("{base}/v1/statement/c/f1"), "columns": cols, "data": [[1, "a", null]] })),
            ("GET", "/v1/statement/c/f1") => ok(json!({ "error": { "message": "boom", "errorName": "GENERIC_INTERNAL_ERROR" } })),
            ("POST", _) if req.body.contains("slow") => ok(json!({ "nextUri": format!("{base}/v1/statement/c/s1"), "columns": cols, "data": [[1, "a", null]] })),
            ("GET", "/v1/statement/c/s1") => {
                std::thread::sleep(Duration::from_millis(500));
                ok(json!({ "nextUri": format!("{base}/v1/statement/c/s2"), "data": [[2, "b", null]] }))
            }
            ("POST", _) => ok(json!({ "nextUri": format!("{base}/v1/statement/c/1"), "columns": cols, "data": [[1, "plain", null], [2, "a,b", ["x", "y"]]] })),
            ("GET", "/v1/statement/c/1") => ok(json!({ "nextUri": format!("{base}/v1/statement/c/2"), "data": [[3, "say \"hi\"\nnow", null], [4, "日本語", []]] })),
            ("GET", "/v1/statement/c/2") => ok(json!({ "data": [[5, "", null]] })),
            ("DELETE", _) => Resp { status: 204, headers: vec![], body: String::new() },
            _ => not_found(),
        }
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn export_csv_writes_all_pages() {
    let mock = csv_mock();
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let (dir, path) = temp_csv();
    let r = m.export_csv(OWNER, &s.session_id, "SELECT * FROM t", &path, ExportOptions::default()).await.unwrap();
    assert_eq!(r.rows, 5);
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(r.bytes, bytes.len() as u64);
    assert!(!dir.path().join("out.csv.part").exists());
    let text = String::from_utf8(bytes).unwrap();
    let expected = "\u{feff}id,txt,tags\r\n1,plain,\r\n2,\"a,b\",\"[\"\"x\"\",\"\"y\"\"]\"\r\n3,\"say \"\"hi\"\"\nnow\",\r\n4,日本語,[]\r\n5,,\r\n";
    assert_eq!(text, expected);
    // No BOM, no header, other delimiter.
    let o = ExportOptions { delimiter: Some("|".into()), header: Some(false), bom: Some(false) };
    let r = m.export_csv(OWNER, &s.session_id, "SELECT * FROM t", &path, o).await.unwrap();
    assert_eq!(r.rows, 5);
    assert!(std::fs::read_to_string(&path).unwrap().starts_with("1|plain|\r\n2|a,b|\"[\"\"x\"\",\"\"y\"\"]\"\r\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn export_csv_refuses_writes_and_removes_part_on_error_and_cancel() {
    let mock = csv_mock();
    let m = DbManager::new();
    let s = connect(&m, &mock).await;
    let (dir, path) = temp_csv();
    let part = dir.path().join("out.csv.part");
    let posts_before = mock.count("POST", "/v1/statement");
    for sql in ["INSERT INTO t VALUES (1)", "DROP TABLE t", "SELECT 1; DROP TABLE t", "USE x"] {
        let err = m.export_csv(OWNER, &s.session_id, sql, &path, ExportOptions::default()).await.unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{sql}");
    }
    assert_eq!(mock.count("POST", "/v1/statement"), posts_before);

    let err = m.export_csv(OWNER, &s.session_id, "SELECT fail", &path, ExportOptions::default()).await.unwrap_err();
    assert_eq!(err.code(), "db_error");
    assert!(err.to_string().starts_with("GENERIC_INTERNAL_ERROR: boom"));
    assert!(!part.exists() && !std::path::Path::new(&path).exists());

    let (m2, sid, p2) = (m.clone(), s.session_id.clone(), path.clone());
    let task = tokio::spawn(async move { m2.export_csv(OWNER, &sid, "SELECT slow", &p2, ExportOptions::default()).await });
    let t = Instant::now();
    while !part.exists() && t.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(part.exists());
    tokio::time::sleep(Duration::from_millis(100)).await;
    m.cancel(OWNER, &s.session_id).await.unwrap();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err.code(), "cancelled");
    assert!(!part.exists() && !std::path::Path::new(&path).exists());
    assert!(mock.count("DELETE", "/v1/statement/c/s1") >= 1);
}
