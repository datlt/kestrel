//! Integration tests against a real MySQL server.
//!
//! Start the test server with `scripts/dev-mysql.sh start`, then run:
//!   KESTREL_TEST_MYSQL=127.0.0.1:13306 cargo test -p kestrel-db
//! The tests are skipped when `KESTREL_TEST_MYSQL` is not set.
//! Optional: KESTREL_TEST_MYSQL_USER (default root) and
//! KESTREL_TEST_MYSQL_PASSWORD (default: the test password of scripts/dev-mysql.sh).

use kestrel_db::*;
use serde_json::json;
use std::time::{Duration, Instant};

const OWNER: &str = "test-window";

struct Env {
    host: String,
    port: u16,
    user: String,
    password: String,
}

fn env() -> Option<Env> {
    let addr = std::env::var("KESTREL_TEST_MYSQL").ok().filter(|s| !s.is_empty())?;
    let (host, port) = addr.rsplit_once(':').expect("KESTREL_TEST_MYSQL must look like host:port");
    Some(Env {
        host: host.to_string(),
        port: port.parse().expect("bad port in KESTREL_TEST_MYSQL"),
        user: std::env::var("KESTREL_TEST_MYSQL_USER").unwrap_or_else(|_| "root".into()),
        password: std::env::var("KESTREL_TEST_MYSQL_PASSWORD").unwrap_or_else(|_| "kestrel-dev-pw".into()),
    })
}

macro_rules! require_env {
    () => {
        match env() {
            Some(e) => e,
            None => {
                eprintln!("skipped: KESTREL_TEST_MYSQL is not set");
                return;
            }
        }
    };
}

fn config(e: &Env, extra: serde_json::Value) -> ConnectionConfig {
    let mut v = json!({
        "id": "it", "name": "it", "host": e.host, "port": e.port, "user": e.user,
        "database": "kestrel_demo", "ssl": "preferred", "readOnly": false, "production": false
    });
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn args(e: &Env, extra: serde_json::Value) -> ConnectArgs {
    ConnectArgs { config: config(e, extra), password: Some(e.password.clone()) }
}

async fn connect(m: &DbManager, e: &Env) -> SessionInfo {
    m.connect(OWNER, args(e, json!({}))).await.expect("connect")
}

async fn run(m: &DbManager, s: &SessionInfo, sql: &str) -> ExecResult {
    m.execute(OWNER, &s.session_id, sql, 1000).await.unwrap_or_else(|e| panic!("`{sql}` failed: {e}"))
}

fn cell(r: &ExecResult, row: usize, col: usize) -> Option<String> {
    r.results[0].rows[row][col].clone()
}

fn code_of(e: &kestrel_common::Error) -> &'static str {
    e.code()
}

/// A scratch database that the test creates and drops.
async fn scratch_db(m: &DbManager, s: &SessionInfo, name: &str) {
    run(m, s, &format!("DROP DATABASE IF EXISTS {name}")).await;
    run(m, s, &format!("CREATE DATABASE {name}")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn test_returns_server_version() {
    let e = require_env!();
    let m = DbManager::new();
    let r = m.test(OWNER, args(&e, json!({}))).await.unwrap();
    assert!(r.server_version.starts_with('8') || r.server_version.starts_with('5'), "{}", r.server_version);
    assert_eq!(m.session_count(OWNER), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_info_and_default_database() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    assert_eq!(s.database.as_deref(), Some("kestrel_demo"));
    assert!(s.autocommit && !s.read_only);
    assert!(s.connection_id > 0);
    let r = run(&m, &s, "SELECT CONNECTION_ID()").await;
    assert_eq!(cell(&r, 0, 0), Some(s.connection_id.to_string()));
    m.disconnect(OWNER, &s.session_id).await.unwrap();
    assert_eq!(m.session_count(OWNER), 0);
    // After a disconnect the session is gone and calls fail with db_lost.
    let err = m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_lost");
}

#[tokio::test(flavor = "multi_thread")]
async fn select_with_types() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let r = run(
        &m,
        &s,
        "SELECT CAST('{\"a\": 1}' AS JSON) AS j, CAST('12345678901234567890.123456789' AS DECIMAL(30,9)) AS d, \
         CAST('2026-10-28 12:34:56.789' AS DATETIME(3)) AS dt, UNHEX('00FF10') AS b, NULL AS n, \
         'こんにちは Hà Nội 🎉' AS u, CAST(18446744073709551615 AS UNSIGNED) AS big, 1.50 AS price",
    )
    .await;
    let res = &r.results[0];
    assert_eq!(res.kind, ResultKind::Rows);
    let types: Vec<_> = res.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(types[0], "JSON");
    assert_eq!(types[1], "DECIMAL");
    assert_eq!(types[2], "DATETIME");
    assert_eq!(types[6], "BIGINT UNSIGNED");
    assert!(res.columns[1].numeric && res.columns[6].numeric && !res.columns[0].numeric);
    assert!(res.columns[3].binary && !res.columns[0].binary && !res.columns[5].binary);
    let row = &res.rows[0];
    assert_eq!(row[0].as_deref(), Some("{\"a\": 1}"));
    assert_eq!(row[1].as_deref(), Some("12345678901234567890.123456789"));
    assert_eq!(row[2].as_deref(), Some("2026-10-28 12:34:56.789"));
    assert_eq!(row[3].as_deref(), Some("0x00FF10"));
    assert_eq!(row[4], None);
    assert_eq!(row[5].as_deref(), Some("こんにちは Hà Nội 🎉"));
    assert_eq!(row[6].as_deref(), Some("18446744073709551615"));
    assert_eq!(row[7].as_deref(), Some("1.50"));
    assert!(res.columns[4].nullable);
    assert_eq!(res.affected_rows, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn columns_of_real_tables_and_blob_preview() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let r = run(&m, &s, "SELECT id, thumbnail, released_at, title_id FROM episodes ORDER BY id LIMIT 1").await;
    let cols = &r.results[0].columns;
    assert_eq!(cols[0].type_name, "BIGINT UNSIGNED");
    assert_eq!(cols[0].table.as_deref(), Some("episodes"));
    assert!(!cols[0].nullable);
    assert_eq!(cols[1].type_name, "BLOB");
    assert!(cols[1].binary && cols[1].nullable);
    assert_eq!(cols[2].type_name, "DATETIME");
    assert!(r.results[0].rows[0][1].is_none());
    assert!(r.results[0].rows[0][2].as_deref().unwrap().contains('.'), "DATETIME(3) keeps milliseconds");

    // A long binary value: 256 bytes of hex and the size.
    let r = run(&m, &s, "SELECT CAST(REPEAT('a', 300) AS BINARY) AS b, CAST(REPEAT('a', 256) AS BINARY) AS c").await;
    let long = r.results[0].rows[0][0].clone().unwrap();
    assert_eq!(long, format!("0x{} (300 bytes)", "61".repeat(256)));
    let exact = r.results[0].rows[0][1].clone().unwrap();
    assert_eq!(exact, format!("0x{}", "61".repeat(256)));

    let r = run(&m, &s, "SELECT name, genre, meta FROM titles ORDER BY id").await;
    // The seed data is not checked as text (the seed script stores it with the wrong
    // client character set). The unicode round trip has its own test.
    assert_eq!(r.results[0].rows.len(), 5);
    assert!(cell(&r, 0, 0).is_some_and(|n| !n.is_empty()));
    assert_eq!(r.results[0].columns[1].type_name, "ENUM");
    assert_eq!(r.results[0].columns[2].type_name, "JSON");
    assert_eq!(cell(&r, 2, 2), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn truncation_keeps_the_session_usable() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let r = m.execute(OWNER, &s.session_id, "SELECT * FROM kestrel_logs.access_log", 100).await.unwrap();
    assert_eq!(r.results.len(), 1);
    assert_eq!(r.results[0].rows.len(), 100);
    assert!(r.results[0].truncated);
    // The same session runs the next statement at once.
    let r = run(&m, &s, "SELECT COUNT(*) FROM kestrel_logs.access_log").await;
    assert_eq!(cell(&r, 0, 0).as_deref(), Some("50000"));
    // Several rounds in a row.
    for _ in 0..3 {
        let r = m.execute(OWNER, &s.session_id, "SELECT * FROM kestrel_logs.access_log ORDER BY id", 10).await.unwrap();
        assert_eq!(r.results[0].rows.len(), 10);
        assert!(r.results[0].truncated);
    }
    // Exactly maxRows rows is not truncated.
    let r = m.execute(OWNER, &s.session_id, "SELECT * FROM titles", 5).await.unwrap();
    assert_eq!(r.results[0].rows.len(), 5);
    assert!(!r.results[0].truncated);
    let r = m.execute(OWNER, &s.session_id, "SELECT * FROM titles", 4).await.unwrap();
    assert!(r.results[0].truncated);
}

#[tokio::test(flavor = "multi_thread")]
async fn truncation_inside_a_transaction_keeps_the_transaction() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let tx = m.set_autocommit(OWNER, &s.session_id, false).await.unwrap();
    assert!(!tx.autocommit);
    run(&m, &s, "SELECT 1").await;
    let r = m.execute(OWNER, &s.session_id, "SELECT * FROM kestrel_logs.access_log", 10).await.unwrap();
    assert!(r.results[0].truncated);
    assert!(!r.autocommit);
    assert!(r.in_transaction, "KILL QUERY must not end the transaction");
    m.rollback(OWNER, &s.session_id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn call_returns_all_result_sets() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let r = run(&m, &s, "CALL free_episodes(1)").await;
    assert_eq!(r.results.len(), 1, "the empty OK packet of CALL is dropped");
    assert_eq!(r.results[0].rows.len(), 3);
    assert_eq!(r.results[0].columns[0].name, "no");
    assert_eq!(cell(&r, 0, 1).as_deref(), Some("Episode 1"));

    let r = run(&m, &s, "SELECT 1 AS a; SELECT 2 AS b, 3 AS c; SELECT 4 AS d").await;
    assert_eq!(r.results.len(), 3);
    assert_eq!(r.results[1].columns.len(), 2);
    assert_eq!(r.results[2].rows[0][0].as_deref(), Some("4"));
    // The session works after a multi-result statement.
    assert_eq!(cell(&run(&m, &s, "SELECT 7").await, 0, 0).as_deref(), Some("7"));
}

#[tokio::test(flavor = "multi_thread")]
async fn affected_results_and_info() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    scratch_db(&m, &s, "kestrel_it_affected").await;
    run(&m, &s, "CREATE TABLE kestrel_it_affected.t (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(10))").await;
    let r = run(&m, &s, "INSERT INTO kestrel_it_affected.t (v) VALUES ('a'), ('b')").await;
    let res = &r.results[0];
    assert_eq!(res.kind, ResultKind::Affected);
    assert_eq!(res.affected_rows, 2);
    assert_eq!(res.last_insert_id.as_deref(), Some("1"));
    assert!(res.info.as_deref().unwrap().contains("Records: 2"));
    assert!(res.columns.is_empty() && res.rows.is_empty());
    let r = run(&m, &s, "UPDATE kestrel_it_affected.t SET v = 'z' WHERE id = 1").await;
    assert!(r.results[0].info.as_deref().unwrap().contains("Rows matched: 1  Changed: 1"));
    assert_eq!(r.results[0].last_insert_id, None);
    run(&m, &s, "DROP DATABASE kestrel_it_affected").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn autocommit_rollback_and_commit() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let other = connect(&m, &e).await;
    scratch_db(&m, &s, "kestrel_it_tx").await;
    run(&m, &s, "CREATE TABLE kestrel_it_tx.t (id INT PRIMARY KEY, v VARCHAR(10)) ENGINE=InnoDB").await;

    let tx = m.set_autocommit(OWNER, &s.session_id, false).await.unwrap();
    assert_eq!(tx, TxState { autocommit: false, in_transaction: false });
    let r = run(&m, &s, "INSERT INTO kestrel_it_tx.t VALUES (1, 'a')").await;
    assert!(!r.autocommit && r.in_transaction);
    // Another session does not see the row yet.
    assert_eq!(cell(&run(&m, &other, "SELECT COUNT(*) FROM kestrel_it_tx.t").await, 0, 0).as_deref(), Some("0"));
    // A failing statement keeps the transaction open.
    let err = m.execute(OWNER, &s.session_id, "INSERT INTO kestrel_it_tx.t VALUES (1, 'dup')", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    assert!(err.to_string().starts_with("1062 (23000): "), "{err}");
    let r = run(&m, &s, "SELECT COUNT(*) FROM kestrel_it_tx.t").await;
    assert!(r.in_transaction);
    assert_eq!(cell(&r, 0, 0).as_deref(), Some("1"));

    let tx = m.rollback(OWNER, &s.session_id).await.unwrap();
    assert_eq!(tx, TxState { autocommit: false, in_transaction: false });
    assert_eq!(cell(&run(&m, &s, "SELECT COUNT(*) FROM kestrel_it_tx.t").await, 0, 0).as_deref(), Some("0"));

    run(&m, &s, "INSERT INTO kestrel_it_tx.t VALUES (2, 'b')").await;
    let tx = m.commit(OWNER, &s.session_id).await.unwrap();
    assert!(!tx.autocommit && !tx.in_transaction);
    assert_eq!(cell(&run(&m, &other, "SELECT COUNT(*) FROM kestrel_it_tx.t").await, 0, 0).as_deref(), Some("1"));

    // Back to autocommit: a statement commits at once.
    let tx = m.set_autocommit(OWNER, &s.session_id, true).await.unwrap();
    assert_eq!(tx, TxState { autocommit: true, in_transaction: false });
    let r = run(&m, &s, "INSERT INTO kestrel_it_tx.t VALUES (3, 'c')").await;
    assert!(r.autocommit && !r.in_transaction);
    assert_eq!(cell(&run(&m, &other, "SELECT COUNT(*) FROM kestrel_it_tx.t").await, 0, 0).as_deref(), Some("2"));

    // An explicit transaction in autocommit mode.
    let r = run(&m, &s, "START TRANSACTION").await;
    assert!(r.autocommit && r.in_transaction);
    run(&m, &s, "INSERT INTO kestrel_it_tx.t VALUES (4, 'd')").await;
    let tx = m.rollback(OWNER, &s.session_id).await.unwrap();
    assert!(tx.autocommit && !tx.in_transaction);
    assert_eq!(cell(&run(&m, &other, "SELECT COUNT(*) FROM kestrel_it_tx.t").await, 0, 0).as_deref(), Some("2"));

    run(&m, &s, "DROP DATABASE kestrel_it_tx").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_stops_a_running_statement() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let m2 = m.clone();
    let sid = s.session_id.clone();
    let started = Instant::now();
    let task = tokio::spawn(async move { m2.execute(OWNER, &sid, "SELECT SLEEP(10)", 100).await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    m.cancel(OWNER, &s.session_id).await.unwrap();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(code_of(&err), "cancelled");
    assert!(started.elapsed() < Duration::from_secs(5), "cancel took {:?}", started.elapsed());
    // The session still works.
    assert_eq!(cell(&run(&m, &s, "SELECT 5").await, 0, 0).as_deref(), Some("5"));
    // Cancel without a running statement does nothing.
    m.cancel(OWNER, &s.session_id).await.unwrap();
    assert_eq!(cell(&run(&m, &s, "SELECT 6").await, 0, 0).as_deref(), Some("6"));
}

#[tokio::test(flavor = "multi_thread")]
async fn second_call_while_busy_fails_with_db_busy() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let m2 = m.clone();
    let sid = s.session_id.clone();
    let task = tokio::spawn(async move { m2.execute(OWNER, &sid, "SELECT SLEEP(5)", 100).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let err = m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_busy");
    let err = m.databases(OWNER, &s.session_id).await.unwrap_err();
    assert_eq!(code_of(&err), "db_busy", "schema calls are busy too");
    let err = m.commit(OWNER, &s.session_id).await.unwrap_err();
    assert_eq!(code_of(&err), "db_busy");
    m.cancel(OWNER, &s.session_id).await.unwrap();
    let _ = task.await.unwrap();
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0).as_deref(), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn ddl_of_every_object_kind() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let sid = &s.session_id;
    let ddl = |name: &'static str, kind: ObjectKind| {
        let m = m.clone();
        let sid = sid.clone();
        async move { m.ddl(OWNER, &sid, "kestrel_demo", name, kind).await.unwrap() }
    };
    let t = ddl("titles", ObjectKind::Table).await;
    assert!(t.starts_with("CREATE TABLE `titles`"), "{t}");
    assert!(t.contains("fk_titles_author"));
    let v = ddl("title_stats", ObjectKind::View).await;
    assert!(v.contains("VIEW `title_stats`"), "{v}");
    let p = ddl("free_episodes", ObjectKind::Procedure).await;
    assert!(p.contains("PROCEDURE `free_episodes`"), "{p}");
    let f = ddl("coin_to_yen", ObjectKind::Function).await;
    assert!(f.contains("FUNCTION `coin_to_yen`"), "{f}");
    let tr = ddl("trg_episodes_price", ObjectKind::Trigger).await;
    assert!(tr.contains("TRIGGER `trg_episodes_price`"), "{tr}");
    // Unknown object: a server error.
    let err = m.ddl(OWNER, sid, "kestrel_demo", "nope", ObjectKind::Table).await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    assert!(err.to_string().starts_with("1146 (42S02): "), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn objects_columns_indexes_and_completion() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let sid = &s.session_id;

    let dbs = m.databases(OWNER, sid).await.unwrap();
    assert!(dbs.contains(&"kestrel_demo".to_string()) && dbs.contains(&"kestrel_logs".to_string()));

    let o = m.objects(OWNER, sid, "kestrel_demo").await.unwrap();
    let names = |l: &[DbObject]| l.iter().map(|x| x.name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&o.tables), ["authors", "episodes", "titles"]);
    assert_eq!(names(&o.views), ["title_stats"]);
    assert_eq!(names(&o.procedures), ["free_episodes"]);
    assert_eq!(names(&o.functions), ["coin_to_yen"]);
    assert_eq!(names(&o.triggers), ["trg_episodes_price"]);
    let authors = &o.tables[0];
    assert_eq!(authors.comment.as_deref(), Some("Comic authors"));
    assert_eq!(authors.detail.as_deref(), Some("InnoDB"));
    assert!(authors.rows_estimate.is_some());
    assert_eq!(authors.kind, ObjectKind::Table);
    assert_eq!(o.views[0].comment, None);
    assert_eq!(o.triggers[0].detail.as_deref(), Some("episodes"));
    let logs = m.objects(OWNER, sid, "kestrel_logs").await.unwrap();
    assert_eq!(names(&logs.tables), ["access_log"]);

    let cols = m.columns(OWNER, sid, "kestrel_demo", "titles").await.unwrap();
    let col_names: Vec<_> = cols.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(col_names, ["id", "author_id", "name", "genre", "rating", "is_completed", "meta", "published_on"]);
    assert_eq!(cols[0].key, "PRI");
    assert_eq!(cols[0].type_name, "int unsigned");
    assert!(cols[0].extra.contains("auto_increment"));
    assert!(!cols[0].nullable && cols[4].nullable);
    assert_eq!(cols[3].type_name, "enum('action','romance','comedy','drama','fantasy')");
    assert_eq!(cols[5].default_value.as_deref(), Some("0"));
    assert_eq!(cols[1].key, "MUL");
    let authors_cols = m.columns(OWNER, sid, "kestrel_demo", "authors").await.unwrap();
    assert_eq!(authors_cols[1].comment.as_deref(), Some("Pen name"));
    assert_eq!(authors_cols[2].default_value.as_deref(), Some("JP"));

    let idx = m.indexes(OWNER, sid, "kestrel_demo", "titles").await.unwrap();
    assert_eq!(idx[0].name, "PRIMARY");
    assert!(idx[0].unique);
    assert_eq!(idx[0].columns, ["id"]);
    let genre = idx.iter().find(|i| i.name == "idx_titles_genre_rating").unwrap();
    assert!(!genre.unique);
    assert_eq!(genre.columns, ["genre", "rating"]);
    assert_eq!(genre.type_name, "BTREE");
    let ep = m.indexes(OWNER, sid, "kestrel_demo", "episodes").await.unwrap();
    let uk = ep.iter().find(|i| i.name == "uk_episodes_title_no").unwrap();
    assert!(uk.unique);
    assert_eq!(uk.columns, ["title_id", "no"]);

    let schema = m.completion_schema(OWNER, sid, "kestrel_demo").await.unwrap();
    assert_eq!(schema["authors"], ["id", "name", "country", "created_at"]);
    assert!(schema["titles"].contains(&"genre".to_string()));
    assert!(schema.contains_key("title_stats"), "views are included");
    let value = serde_json::to_value(&schema).unwrap();
    assert!(value["episodes"].is_array());
}

#[tokio::test(flavor = "multi_thread")]
async fn use_changes_the_current_database() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    m.use_database(OWNER, &s.session_id, "kestrel_logs").await.unwrap();
    let r = run(&m, &s, "SELECT DATABASE()").await;
    assert_eq!(cell(&r, 0, 0).as_deref(), Some("kestrel_logs"));
    assert_eq!(r.database.as_deref(), Some("kestrel_logs"));
    let r = run(&m, &s, "use kestrel_demo").await;
    assert_eq!(r.database.as_deref(), Some("kestrel_demo"));
    let err = m.use_database(OWNER, &s.session_id, "no_such_db").await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    assert!(err.to_string().starts_with("1049 (42000): "), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_session_refuses_writes() {
    let e = require_env!();
    let m = DbManager::new();
    let s = m.connect(OWNER, args(&e, json!({ "readOnly": true }))).await.unwrap();
    assert!(s.read_only);
    assert_eq!(cell(&run(&m, &s, "SELECT COUNT(*) FROM titles").await, 0, 0).as_deref(), Some("5"));
    let err = m.execute(OWNER, &s.session_id, "INSERT INTO authors (name) VALUES ('x')", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    assert!(err.to_string().starts_with("1792 (25006): "), "{err}");
    // Still usable.
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0).as_deref(), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_password_and_bad_targets_are_db_connect() {
    let e = require_env!();
    let m = DbManager::new();
    let mut a = args(&e, json!({}));
    a.password = Some("definitely-wrong".into());
    let err = m.connect(OWNER, a.clone()).await.unwrap_err();
    assert_eq!(code_of(&err), "db_auth");
    assert!(err.to_string().starts_with("1045 (28000): "), "{err}");
    let err = m.test(OWNER, a).await.unwrap_err();
    assert_eq!(code_of(&err), "db_auth");

    let err = m.connect(OWNER, args(&e, json!({ "database": "no_such_db" }))).await.unwrap_err();
    assert_eq!(code_of(&err), "db_connect");
    assert!(err.to_string().starts_with("1049 (42000): "), "{err}");
    assert_eq!(m.session_count(OWNER), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_port_and_timeout_are_db_connect() {
    // No MySQL server needed: nothing listens on port 1.
    let m = DbManager::new();
    let cfg: ConnectionConfig = serde_json::from_value(json!({
        "id": "x", "name": "x", "host": "127.0.0.1", "port": 1, "user": "root", "ssl": "disabled",
        "readOnly": false, "production": false, "connectTimeoutSec": 2
    }))
    .unwrap();
    let err = m.connect(OWNER, ConnectArgs { config: cfg, password: Some(String::new()) }).await.unwrap_err();
    assert_eq!(code_of(&err), "db_connect");
}

#[tokio::test(flavor = "multi_thread")]
async fn init_sql_and_ssl_modes() {
    let e = require_env!();
    let m = DbManager::new();
    let s = m.connect(OWNER, args(&e, json!({ "initSql": "SET @kestrel = 42; SET time_zone = '+09:00'" }))).await.unwrap();
    assert_eq!(cell(&run(&m, &s, "SELECT @kestrel, @@session.time_zone").await, 0, 0).as_deref(), Some("42"));
    assert_eq!(cell(&run(&m, &s, "SELECT @@session.time_zone").await, 0, 0).as_deref(), Some("+09:00"));

    // A failing init SQL is a connect error.
    let err = m.connect(OWNER, args(&e, json!({ "initSql": "SELEKT 1" }))).await.unwrap_err();
    assert_eq!(code_of(&err), "db_connect");
    assert!(err.to_string().contains("init SQL failed"), "{err}");

    let cipher = |mode: &'static str| {
        let m = m.clone();
        let a = args(&e, json!({ "ssl": mode }));
        async move {
            let s = m.connect(OWNER, a).await.unwrap_or_else(|e| panic!("ssl {mode}: {e}"));
            let r = m.execute(OWNER, &s.session_id, "SHOW SESSION STATUS LIKE 'Ssl_cipher'", 10).await.unwrap();
            r.results[0].rows[0][1].clone().unwrap_or_default()
        }
    };
    assert_eq!(cipher("disabled").await, "");
    assert!(!cipher("required").await.is_empty(), "required must use TLS");
    assert!(!cipher("preferred").await.is_empty(), "preferred uses TLS when the server has it");
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_have_code_sqlstate_and_text() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let err = m.execute(OWNER, &s.session_id, "SELEKT 1", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    assert!(err.to_string().starts_with("1064 (42000): You have an error in your SQL syntax"), "{err}");
    let err = m.execute(OWNER, &s.session_id, "SELECT * FROM nope", 10).await.unwrap_err();
    assert!(err.to_string().starts_with("1146 (42S02): "), "{err}");
    let err = m.execute(OWNER, &s.session_id, "", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    // Error in the second result set of a multi statement.
    let err = m.execute(OWNER, &s.session_id, "SELECT 1; SELECT * FROM nope", 10).await.unwrap_err();
    assert!(err.to_string().starts_with("1146 (42S02): "), "{err}");
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0).as_deref(), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn killed_connection_is_db_lost() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let killer = connect(&m, &e).await;
    run(&m, &killer, &format!("KILL {}", s.connection_id)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let err = m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_lost", "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_belong_to_their_owner() {
    let e = require_env!();
    let m = DbManager::new();
    let a = m.connect("window-a", args(&e, json!({}))).await.unwrap();
    let b = m.connect("window-b", args(&e, json!({}))).await.unwrap();
    // A window cannot use the session of another window.
    let err = m.execute("window-b", &a.session_id, "SELECT 1", 10).await.unwrap_err();
    assert_eq!(code_of(&err), "db_lost");
    m.close_owner("window-a").await;
    assert_eq!(m.session_count("window-a"), 0);
    assert_eq!(m.session_count("window-b"), 1);
    assert!(m.execute("window-b", &b.session_id, "SELECT 1", 10).await.is_ok());
    m.close_all().await;
    assert_eq!(m.session_count("window-b"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_session_stops_its_running_statement() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let m2 = m.clone();
    let sid = s.session_id.clone();
    let task = tokio::spawn(async move { m2.execute(OWNER, &sid, "SELECT SLEEP(10)", 10).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    m.close_owner(OWNER).await;
    assert!(t.elapsed() < Duration::from_secs(5));
    assert!(task.await.unwrap().is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn unicode_round_trip() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    scratch_db(&m, &s, "kestrel_it_unicode").await;
    run(&m, &s, "CREATE TABLE kestrel_it_unicode.t (v VARCHAR(100)) DEFAULT CHARSET utf8mb4").await;
    run(&m, &s, "INSERT INTO kestrel_it_unicode.t VALUES ('日本語 한국어 Tiếng Việt 🎉')").await;
    let r = run(&m, &s, "SELECT v FROM kestrel_it_unicode.t").await;
    assert_eq!(cell(&r, 0, 0).as_deref(), Some("日本語 한국어 Tiếng Việt 🎉"));
    run(&m, &s, "DROP DATABASE kestrel_it_unicode").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn warnings_are_counted() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let r = run(&m, &s, "SELECT CAST('12abc' AS SIGNED)").await;
    assert_eq!(r.results[0].warnings, 1);
}

// --- SSH tunnel with a fake `ssh` program ------------------------------------

/// A small Python program that behaves like `ssh -N -L`: it forwards the local port.
#[cfg(unix)]
const FAKE_SSH: &str = r#"#!/usr/bin/env python3
import asyncio, os, sys
args = sys.argv[1:]
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "starts.log"), "a") as f:
    f.write(" ".join(args) + "\n")
if args[-1].endswith("failhost"):
    sys.stderr.write("ssh: Could not resolve hostname failhost\n")
    sys.exit(255)
spec = args[args.index("-L") + 1].split(":")
lport, host, port = int(spec[1]), spec[2], int(spec[3])

async def pump(r, w):
    try:
        while True:
            data = await r.read(65536)
            if not data:
                break
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        w.close()

async def handle(r, w):
    try:
        rr, rw = await asyncio.open_connection(host, port)
    except Exception:
        w.close()
        return
    await asyncio.gather(pump(r, rw), pump(rr, w))

async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", lport)
    async with server:
        await server.serve_forever()

asyncio.run(main())
"#;

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn ssh_tunnel_is_shared_and_closed() {
    use std::os::unix::fs::PermissionsExt;
    let e = require_env!();
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let dir = std::env::temp_dir().join(format!("kestrel-fake-ssh-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("ssh");
    std::fs::write(&script, FAKE_SSH).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    // The fake program must come first in the PATH, and we must not read the login shell.
    // SAFETY: this is the only test that changes the environment, and it does it before any ssh start.
    unsafe {
        std::env::set_var("KESTREL_SKIP_SHELL_ENV", "1");
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path}", dir.display()));
    }
    kestrel_common::process::init_shell_env();

    let m = DbManager::new();
    let tunnel_args = |host: &str| args(&e, json!({ "ssh": { "host": host, "port": 2222, "user": "deploy", "identityFile": "/keys/id" } }));
    let a = m.connect(OWNER, tunnel_args("bastion")).await.unwrap();
    let b = m.connect(OWNER, tunnel_args("bastion")).await.unwrap();
    assert_eq!(cell(&run(&m, &a, "SELECT 1").await, 0, 0).as_deref(), Some("1"));
    assert_eq!(cell(&run(&m, &b, "SELECT 2").await, 0, 0).as_deref(), Some("2"));

    let log = std::fs::read_to_string(dir.join("starts.log")).unwrap();
    assert_eq!(log.lines().count(), 1, "one tunnel for two sessions:\n{log}");
    let line = log.lines().next().unwrap();
    for part in ["-N", "BatchMode=yes", "ExitOnForwardFailure=yes", "ServerAliveInterval=30", "-p 2222", "-i /keys/id", "deploy@bastion"] {
        assert!(line.contains(part), "missing `{part}` in `{line}`");
    }
    let spec = line.split(' ').skip_while(|p| *p != "-L").nth(1).unwrap().to_string();
    let local_port: u16 = spec.split(':').nth(1).unwrap().parse().unwrap();
    assert_eq!(spec, format!("127.0.0.1:{local_port}:{}:{}", e.host, e.port));
    let accepts = || std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{local_port}").parse().unwrap(), Duration::from_millis(300)).is_ok();
    assert!(accepts());

    // One session closes: the tunnel stays. The last one closes: ssh is killed.
    m.disconnect(OWNER, &a.session_id).await.unwrap();
    assert!(accepts(), "the second session still uses the tunnel");
    assert_eq!(cell(&run(&m, &b, "SELECT 3").await, 0, 0).as_deref(), Some("3"));
    m.disconnect(OWNER, &b.session_id).await.unwrap();
    let t = Instant::now();
    while accepts() && t.elapsed() < Duration::from_secs(3) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!accepts(), "ssh must be killed after the last session");

    // ssh exits at once: its stderr is in the db_connect message.
    let err = m.connect(OWNER, tunnel_args("failhost")).await.unwrap_err();
    assert_eq!(code_of(&err), "db_connect");
    assert!(err.to_string().contains("Could not resolve hostname failhost"), "{err}");

    // test() opens its own tunnel and closes it.
    let r = m.test(OWNER, tunnel_args("bastion")).await.unwrap();
    assert!(!r.server_version.is_empty());
    let log = std::fs::read_to_string(dir.join("starts.log")).unwrap();
    assert_eq!(log.lines().count(), 3);
    let _ = std::fs::remove_dir_all(&dir);
}

// --- IntelliJ data source --------------------------------------------------------

/// A made-up `.idea/dataSources.xml` points at the test server. The password is
/// only in the URL of that file. The connect call sends `password: null`.
#[tokio::test(flavor = "multi_thread")]
async fn idea_source_connects_with_the_password_from_the_file() {
    let Some(e) = env() else { return };
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".idea")).unwrap();
    let enc = |s: &str| s.bytes().map(|b| format!("%{b:02X}")).collect::<String>();
    let url = format!("jdbc:mysql://{}:{}@{}:{}/kestrel_demo?useSSL=false", enc(&e.user), enc(&e.password), e.host, e.port);
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="DataSourceManagerImpl" format="xml">
<data-source source="LOCAL" name="local test" uuid="11111111-2222-3333-4444-555555555555">
<driver-ref>mysql.8</driver-ref><jdbc-url>{url}</jdbc-url>
</data-source></component></project>"#
    );
    std::fs::write(dir.path().join(".idea/dataSources.xml"), xml).unwrap();

    let list = idea_list(dir.path()).unwrap();
    assert_eq!(list.sources.len(), 1);
    let src = &list.sources[0];
    assert!(src.supported);
    assert_eq!(src.config.id, "idea:11111111-2222-3333-4444-555555555555");
    assert!(!serde_json::to_string(&list).unwrap().contains(&e.password), "the list must not hold the password");

    let m = DbManager::new();
    let args = ConnectArgs { config: src.config.clone(), password: None };
    let t = m.test(OWNER, args.clone()).await.expect("test");
    assert!(!t.server_version.is_empty());
    let s = m.connect(OWNER, args).await.expect("connect");
    assert_eq!(s.database.as_deref(), Some("kestrel_demo"));
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0).as_deref(), Some("1"));
    m.close_owner(OWNER).await;
}

// --- Keychain (opt in: it can show a system prompt) --------------------------

#[tokio::test(flavor = "multi_thread")]
async fn keychain_round_trip() {
    if std::env::var("KESTREL_TEST_KEYCHAIN").is_err() {
        eprintln!("skipped: KESTREL_TEST_KEYCHAIN is not set");
        return;
    }
    let m = DbManager::new();
    let id = format!("kestrel-test-{}", std::process::id());
    assert!(!m.password_exists(&id).await.unwrap());
    m.password_set(&id, "secret").await.unwrap();
    assert!(m.password_exists(&id).await.unwrap());
    m.password_delete(&id).await.unwrap();
    assert!(!m.password_exists(&id).await.unwrap());
    // Deleting twice is fine.
    m.password_delete(&id).await.unwrap();
}

// --- CSV export ------------------------------------------------------------

/// A small RFC 4180 reader for the tests. Returns the rows as lists of fields.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => quoted = true,
                ',' => row.push(std::mem::take(&mut field)),
                '\r' => {
                    assert_eq!(chars.next(), Some('\n'), "a bare CR outside quotes");
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                other => field.push(other),
            }
        }
    }
    assert!(!quoted && field.is_empty() && row.is_empty(), "the file must end with CRLF");
    rows
}

#[tokio::test(flavor = "multi_thread")]
async fn export_csv_streams_50k_rows() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.csv");
    let sql = "SELECT id, path, CONCAT('a,\"b\"', CHAR(10 USING utf8mb4), 'c') AS tricky, NULL AS n, 'こんにちは Hà Nội' AS u \
               FROM kestrel_logs.access_log ORDER BY id";
    let r = m.export_csv(OWNER, &s.session_id, sql, path.to_str().unwrap(), ExportOptions::default()).await.unwrap();
    assert_eq!(r.rows, 50_000);
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(r.bytes, bytes.len() as u64);
    assert!(!dir.path().join("out.csv.part").exists());
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
    let rows = parse_csv(std::str::from_utf8(&bytes[3..]).unwrap());
    assert_eq!(rows.len(), 50_001);
    assert_eq!(rows[0], ["id", "path", "tricky", "n", "u"]);
    assert_eq!(rows[1][0], "1");
    assert_eq!(rows[1][2], "a,\"b\"\nc");
    assert_eq!(rows[1][3], "");
    assert_eq!(rows[1][4], "こんにちは Hà Nội");
    assert_eq!(rows[50_000][0], "50000");
    // The raw text has the quoted form.
    assert!(String::from_utf8_lossy(&bytes).contains("\"a,\"\"b\"\"\nc\""));
    // The session still works.
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0), Some("1".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn export_csv_options_and_overwrite() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("o.csv");
    std::fs::write(&path, "old").unwrap();
    let o = ExportOptions { delimiter: Some(";".into()), header: Some(false), bom: Some(false) };
    let r = m.export_csv(OWNER, &s.session_id, "SELECT 1 AS a, 'x;y' AS b UNION ALL SELECT 2, NULL", path.to_str().unwrap(), o).await.unwrap();
    assert_eq!(r.rows, 2);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "1;\"x;y\"\r\n2;\r\n");
    // An empty result keeps the header only.
    let r = m.export_csv(OWNER, &s.session_id, "SELECT 1 AS a WHERE 1 = 0", path.to_str().unwrap(), ExportOptions { bom: Some(false), ..Default::default() }).await.unwrap();
    assert_eq!(r.rows, 0);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\r\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn export_csv_refuses_writes_and_bad_paths() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.csv");
    let p = path.to_str().unwrap();
    for sql in ["INSERT INTO kestrel_demo.titles (id) VALUES (1)", "DROP TABLE x", "SELECT 1; DELETE FROM kestrel_demo.titles", "CALL p()"] {
        let err = m.export_csv(OWNER, &s.session_id, sql, p, ExportOptions::default()).await.unwrap_err();
        assert_eq!(code_of(&err), "invalid_input", "{sql}");
    }
    assert!(!path.exists() && !dir.path().join("w.csv.part").exists());
    let err = m.export_csv(OWNER, &s.session_id, "SELECT 1", "relative.csv", ExportOptions::default()).await.unwrap_err();
    assert_eq!(code_of(&err), "invalid_input");
    // A server error removes the part file.
    let err = m.export_csv(OWNER, &s.session_id, "SELECT * FROM no_such_table_x", p, ExportOptions::default()).await.unwrap_err();
    assert_eq!(code_of(&err), "db_error");
    assert!(!path.exists() && !dir.path().join("w.csv.part").exists());
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0), Some("1".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn export_csv_cancel_removes_the_part_file() {
    let e = require_env!();
    let m = DbManager::new();
    let s = connect(&m, &e).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.csv");
    let part = dir.path().join("c.csv.part");
    let (m2, sid, p) = (m.clone(), s.session_id.clone(), path.to_str().unwrap().to_string());
    let task = tokio::spawn(async move {
        m2.export_csv(OWNER, &sid, "SELECT id, SLEEP(0.01) FROM kestrel_logs.access_log", &p, ExportOptions::default()).await
    });
    // Wait until the export has started and the part file exists.
    let t = Instant::now();
    while !part.exists() && t.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(part.exists(), "the part file should exist while the export runs");
    tokio::time::sleep(Duration::from_millis(300)).await;
    // A second statement is refused while the export runs.
    let busy = m.execute(OWNER, &s.session_id, "SELECT 1", 10).await.unwrap_err();
    assert_eq!(code_of(&busy), "db_busy");
    m.cancel(OWNER, &s.session_id).await.unwrap();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(code_of(&err), "cancelled");
    assert!(!part.exists() && !path.exists());
    assert_eq!(cell(&run(&m, &s, "SELECT 1").await, 0, 0), Some("1".into()));
}
