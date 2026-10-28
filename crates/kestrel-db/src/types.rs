//! Data types of the database contract. They mirror `src/ipc/db.ts`.
//! JSON uses camelCase names, like the TypeScript side.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disabled,
    #[default]
    Preferred,
    Required,
}

/// The database engine of a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    #[default]
    Mysql,
    Trino,
}

/// How a Trino session logs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrinoAuth {
    /// Only the user name (header `X-Trino-User`).
    None,
    /// HTTP Basic. Only over https.
    Password,
    /// Login in the system browser. The token stays in memory.
    Oauth2,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnel {
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub identity_file: Option<String>,
}

/// Says that a connection comes from an IntelliJ project (`.idea/dataSources.xml`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaRef {
    /// Always "idea".
    #[serde(default = "idea_kind")]
    pub kind: String,
    pub project_root: String,
    pub uuid: String,
}

fn idea_kind() -> String {
    "idea".into()
}

/// A saved connection. It has no password: the password comes in a separate argument.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Default `mysql`. For `trino`: `database` is the schema and `ssl` `disabled` means http.
    #[serde(default)]
    pub driver: Driver,
    /// Trino only: the catalog, for example `hive`.
    #[serde(default)]
    pub catalog: Option<String>,
    /// Trino only. `None` means `password` when `ssl` is not `disabled`, else `none`.
    #[serde(default)]
    pub trino_auth: Option<TrinoAuth>,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl: SslMode,
    #[serde(default)]
    pub ssh: Option<SshTunnel>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub production: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub init_sql: Option<String>,
    #[serde(default)]
    pub connect_timeout_sec: Option<u64>,
    /// Set for connections that come from IntelliJ.
    #[serde(default)]
    pub source: Option<IdeaRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PasswordSource {
    /// The password is in the JDBC URL or the properties of the IntelliJ file.
    File,
    Keychain,
    None,
}

/// One data source of an IntelliJ project. It never holds a password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaDataSource {
    pub config: ConnectionConfig,
    pub driver: String,
    pub supported: bool,
    pub reason: Option<String>,
    pub password_source: PasswordSource,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaList {
    /// Absolute path of dataSources.xml, or null when the project has none.
    pub file: Option<String>,
    pub sources: Vec<IdeaDataSource>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub config: ConnectionConfig,
    /// `None`: read the password from the OS keychain (no entry means an empty password).
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub server_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub driver: Driver,
    /// False for Trino: every statement commits at once.
    pub supports_transactions: bool,
    pub server_version: String,
    pub connection_id: u64,
    pub database: Option<String>,
    pub autocommit: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub table: Option<String>,
    pub nullable: bool,
    pub numeric: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultKind {
    Rows,
    Affected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub kind: ResultKind,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: bool,
    pub affected_rows: u64,
    pub last_insert_id: Option<String>,
    pub warnings: u16,
    pub info: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxState {
    pub autocommit: bool,
    pub in_transaction: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub results: Vec<QueryResult>,
    pub database: Option<String>,
    pub elapsed_ms: u64,
    pub autocommit: bool,
    pub in_transaction: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Table,
    View,
    Procedure,
    Function,
    Trigger,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    pub kind: ObjectKind,
    pub comment: Option<String>,
    pub rows_estimate: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObjects {
    pub tables: Vec<DbObject>,
    pub views: Vec<DbObject>,
    pub procedures: Vec<DbObject>,
    pub functions: Vec<DbObject>,
    pub triggers: Vec<DbObject>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    pub key: String,
    #[serde(rename = "default")]
    pub default_value: Option<String>,
    pub extra: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// Options of `db_export_csv`. Missing values use the defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// One character. Default `,`.
    #[serde(default)]
    pub delimiter: Option<String>,
    /// Write the column names as the first row. Default true.
    #[serde(default)]
    pub header: Option<bool>,
    /// Write a UTF-8 BOM first. Default true.
    #[serde(default)]
    pub bom: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub rows: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}
