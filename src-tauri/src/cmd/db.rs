//! Tauri commands for the database feature (MySQL). The contract is src/ipc/db.ts.
//! All logic lives in `kestrel-db`. These functions only pass arguments on.
//! Every command is async, so no database call blocks the main thread.
//! Sessions belong to the window that opened them (owner = window label).

use super::{Handler, SetupResult};
use kestrel_common::Result;
use kestrel_db::{
    ColumnInfo, ConnectArgs, ConnectionConfig, DbManager, DbObjects, ExecResult, IndexInfo, ObjectKind, SessionInfo, TestResult, TxState,
};
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::{App, AppHandle, Manager, State, Window};

/// How long the app waits for sessions to close when it quits.
const EXIT_WAIT: Duration = Duration::from_secs(2);

type Db<'a> = State<'a, DbManager>;

#[tauri::command]
async fn db_test(window: Window, db: Db<'_>, config: ConnectionConfig, password: Option<String>) -> Result<TestResult> {
    db.test(window.label(), ConnectArgs { config, password }).await
}

#[tauri::command]
async fn db_connect(window: Window, db: Db<'_>, config: ConnectionConfig, password: Option<String>) -> Result<SessionInfo> {
    db.connect(window.label(), ConnectArgs { config, password }).await
}

#[tauri::command]
async fn db_disconnect(window: Window, db: Db<'_>, session_id: String) -> Result<()> {
    db.disconnect(window.label(), &session_id).await
}

#[tauri::command]
async fn db_execute(window: Window, db: Db<'_>, session_id: String, sql: String, max_rows: usize) -> Result<ExecResult> {
    db.execute(window.label(), &session_id, &sql, max_rows).await
}

#[tauri::command]
async fn db_cancel(window: Window, db: Db<'_>, session_id: String) -> Result<()> {
    db.cancel(window.label(), &session_id).await
}

#[tauri::command]
async fn db_set_autocommit(window: Window, db: Db<'_>, session_id: String, on: bool) -> Result<TxState> {
    db.set_autocommit(window.label(), &session_id, on).await
}

#[tauri::command]
async fn db_commit(window: Window, db: Db<'_>, session_id: String) -> Result<TxState> {
    db.commit(window.label(), &session_id).await
}

#[tauri::command]
async fn db_rollback(window: Window, db: Db<'_>, session_id: String) -> Result<TxState> {
    db.rollback(window.label(), &session_id).await
}

#[tauri::command]
async fn db_use(window: Window, db: Db<'_>, session_id: String, database: String) -> Result<()> {
    db.use_database(window.label(), &session_id, &database).await
}

#[tauri::command]
async fn db_databases(window: Window, db: Db<'_>, session_id: String) -> Result<Vec<String>> {
    db.databases(window.label(), &session_id).await
}

#[tauri::command]
async fn db_objects(window: Window, db: Db<'_>, session_id: String, database: String) -> Result<DbObjects> {
    db.objects(window.label(), &session_id, &database).await
}

#[tauri::command]
async fn db_columns(window: Window, db: Db<'_>, session_id: String, database: String, table: String) -> Result<Vec<ColumnInfo>> {
    db.columns(window.label(), &session_id, &database, &table).await
}

#[tauri::command]
async fn db_indexes(window: Window, db: Db<'_>, session_id: String, database: String, table: String) -> Result<Vec<IndexInfo>> {
    db.indexes(window.label(), &session_id, &database, &table).await
}

#[tauri::command]
async fn db_ddl(window: Window, db: Db<'_>, session_id: String, database: String, name: String, kind: ObjectKind) -> Result<String> {
    db.ddl(window.label(), &session_id, &database, &name, kind).await
}

#[tauri::command]
async fn db_completion_schema(window: Window, db: Db<'_>, session_id: String, database: String) -> Result<BTreeMap<String, Vec<String>>> {
    db.completion_schema(window.label(), &session_id, &database).await
}

#[tauri::command]
async fn db_password_set(db: Db<'_>, id: String, password: String) -> Result<()> {
    db.password_set(&id, &password).await
}

#[tauri::command]
async fn db_password_delete(db: Db<'_>, id: String) -> Result<()> {
    db.password_delete(&id).await
}

#[tauri::command]
async fn db_password_exists(db: Db<'_>, id: String) -> Result<bool> {
    db.password_exists(&id).await
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![
        db_test,
        db_connect,
        db_disconnect,
        db_execute,
        db_cancel,
        db_set_autocommit,
        db_commit,
        db_rollback,
        db_use,
        db_databases,
        db_objects,
        db_columns,
        db_indexes,
        db_ddl,
        db_completion_schema,
        db_password_set,
        db_password_delete,
        db_password_exists,
    ])
}

pub fn setup(app: &mut App) -> SetupResult {
    app.manage(DbManager::new());
    Ok(())
}

/// Closes the sessions and the SSH tunnels of the window. It runs in the background.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let db = app.state::<DbManager>().inner().clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        db.close_owner(&label).await;
    });
}

/// Closes everything and waits a short time for it. After that, ssh is killed in any case.
pub fn on_exit(app: &AppHandle) {
    let db = app.state::<DbManager>().inner().clone();
    let work = db.clone();
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(EXIT_WAIT, work.close_all()).await;
    });
    db.kill_tunnels_now();
}
