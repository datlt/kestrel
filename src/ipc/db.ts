// IPC for the database feature (MySQL). This file is the contract between
// the Rust side (src-tauri/src/cmd/db.rs, crates/kestrel-db) and the frontend
// (src/features/db). Owner: integrator. Do not change a signature without the
// integrator: both sides are written at the same time.
//
// Rules for the Rust side:
// - One session = one MySQL connection (plus an optional SSH tunnel). A SQL
//   console tab owns one session, so its transaction belongs to that tab.
// - A session runs one statement at a time. A second call while one runs
//   fails with code `db_busy` (schema calls included).
// - Errors use the codes `db_error` (server error; message starts with
//   "<number> (<sqlstate>): "), `db_connect` (connect, login, TLS or SSH
//   problems), `db_busy`, `db_lost` (connection lost; reconnect), `cancelled`.
// - Sessions belong to the window that opened them. Rust closes them (and
//   their tunnels) when the window closes and when the app quits.
// - Passwords never travel in settings. They come in `password` arguments or
//   from the OS keychain (`db_password_*`).

import { invoke } from './invoke';

export type DbSslMode = 'disabled' | 'preferred' | 'required';

export interface DbSshTunnel {
  /**
   * Bastion host. Rust starts the system `ssh` program
   * (`ssh -N -L 127.0.0.1:<free port>:<db host>:<db port> ...` with
   * `BatchMode=yes`), so `~/.ssh/config`, keys and the ssh agent work.
   * Password login for ssh is not supported.
   */
  host: string;
  port?: number | null;
  user?: string | null;
  /** Private key file. Empty: ssh picks the key (agent, ~/.ssh/config). */
  identityFile?: string | null;
}

/** A saved connection. Stored in the setting `db.connections` (no password). */
export interface DbConnectionConfig {
  /** Stable unique id (also the keychain account name of the password). */
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Default database (schema) after connect. */
  database?: string | null;
  ssl: DbSslMode;
  ssh?: DbSshTunnel | null;
  /** Every session runs `SET SESSION TRANSACTION READ ONLY` after connect. */
  readOnly: boolean;
  /** Production marker: red color in the UI and a confirm before writes. */
  production: boolean;
  /** Label color (CSS color) in the tree and tabs. */
  color?: string | null;
  /** SQL that runs after each connect, for example `SET time_zone = '+09:00'`. */
  initSql?: string | null;
  /** Default 10 seconds. */
  connectTimeoutSec?: number | null;
}

export interface DbSessionInfo {
  sessionId: string;
  serverVersion: string;
  /** `CONNECTION_ID()` of the session. */
  connectionId: number;
  database: string | null;
  autocommit: boolean;
  readOnly: boolean;
}

export interface DbColumn {
  name: string;
  /** Type name for display, for example `VARCHAR`, `BIGINT UNSIGNED`, `DATETIME`, `JSON`, `BLOB`. */
  type: string;
  /** Source table of the column, when the server sends it. */
  table: string | null;
  nullable: boolean;
  /** Numbers align to the right in the grid. */
  numeric: boolean;
  /** Binary data (BLOB, BINARY, VARBINARY, BIT, GEOMETRY). */
  binary: boolean;
}

/**
 * A cell value. `null` is SQL NULL. Other values are text exactly as MySQL
 * sends them, so BIGINT, DECIMAL and DATETIME(6) keep full precision.
 * Binary values are `0x` + hex of the first 256 bytes, then ` (N bytes)` when
 * the value is longer.
 */
export type DbValue = string | null;

export interface DbResult {
  /** `rows` when the statement returned a result set (SELECT, SHOW, CALL...), else `affected`. */
  kind: 'rows' | 'affected';
  /** Empty for `affected`. */
  columns: DbColumn[];
  rows: DbValue[][];
  /** The result had more than `maxRows` rows. Rust stopped reading (KILL QUERY on a side connection, then drain), so the session stays usable. */
  truncated: boolean;
  affectedRows: number;
  /** As text (it can be bigger than 2^53). null when 0. */
  lastInsertId: string | null;
  warnings: number;
  /** Server info text, for example "Rows matched: 1  Changed: 1  Warnings: 0". */
  info: string | null;
  elapsedMs: number;
}

export interface DbTxState {
  autocommit: boolean;
  /** A transaction is open on the server (server status flag SERVER_STATUS_IN_TRANS). */
  inTransaction: boolean;
}

export interface DbExecResult extends DbTxState {
  /** One statement can give several results (for example CALL of a procedure). */
  results: DbResult[];
  /** Current database after the statement (USE changes it). */
  database: string | null;
  elapsedMs: number;
}

export type DbObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger';

export interface DbObject {
  name: string;
  kind: DbObjectKind;
  comment: string | null;
  /** Tables: the estimate from information_schema (not exact for InnoDB). */
  rowsEstimate: number | null;
  /** Tables: ENGINE. Triggers: the table name. */
  detail: string | null;
}

export interface DbObjects {
  tables: DbObject[];
  views: DbObject[];
  procedures: DbObject[];
  functions: DbObject[];
  triggers: DbObject[];
}

export interface DbColumnInfo {
  name: string;
  /** COLUMN_TYPE, for example `int unsigned`, `varchar(200)`, `enum('a','b')`. */
  type: string;
  nullable: boolean;
  /** `PRI`, `UNI`, `MUL` or empty. */
  key: string;
  default: string | null;
  /** For example `auto_increment`, `DEFAULT_GENERATED`. */
  extra: string;
  comment: string | null;
}

export interface DbIndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
  /** BTREE, FULLTEXT, ... */
  type: string;
}

export interface DbConnectArgs {
  config: DbConnectionConfig;
  /** null: use the password saved in the keychain (or no password). */
  password: string | null;
}

// --- Connections and sessions -------------------------------------------

/** Connects, reads the server version, disconnects. */
export const dbTest = (args: DbConnectArgs) => invoke<{ serverVersion: string }>('db_test', { ...args });
export const dbConnect = (args: DbConnectArgs) => invoke<DbSessionInfo>('db_connect', { ...args });
export const dbDisconnect = (sessionId: string) => invoke<void>('db_disconnect', { sessionId });

// --- Statements ----------------------------------------------------------

/**
 * Runs ONE statement (the frontend splits scripts). `maxRows` limits the rows
 * of each result set.
 */
export const dbExecute = (sessionId: string, sql: string, maxRows: number) =>
  invoke<DbExecResult>('db_execute', { sessionId, sql, maxRows });
/** Stops the running statement (`KILL QUERY` from a side connection). */
export const dbCancel = (sessionId: string) => invoke<void>('db_cancel', { sessionId });
export const dbSetAutocommit = (sessionId: string, on: boolean) => invoke<DbTxState>('db_set_autocommit', { sessionId, on });
export const dbCommit = (sessionId: string) => invoke<DbTxState>('db_commit', { sessionId });
export const dbRollback = (sessionId: string) => invoke<DbTxState>('db_rollback', { sessionId });
/** `USE <database>`. */
export const dbUse = (sessionId: string, database: string) => invoke<void>('db_use', { sessionId, database });

// --- Schema (use a separate session from the console, see db_busy) ---------

export const dbDatabases = (sessionId: string) => invoke<string[]>('db_databases', { sessionId });
export const dbObjects = (sessionId: string, database: string) => invoke<DbObjects>('db_objects', { sessionId, database });
export const dbColumns = (sessionId: string, database: string, table: string) =>
  invoke<DbColumnInfo[]>('db_columns', { sessionId, database, table });
export const dbIndexes = (sessionId: string, database: string, table: string) =>
  invoke<DbIndexInfo[]>('db_indexes', { sessionId, database, table });
/** `SHOW CREATE TABLE/VIEW/PROCEDURE/FUNCTION/TRIGGER`, as SQL text. */
export const dbDdl = (sessionId: string, database: string, name: string, kind: DbObjectKind) =>
  invoke<string>('db_ddl', { sessionId, database, name, kind });
/** Table name → column names, for SQL completion (one information_schema query). */
export const dbCompletionSchema = (sessionId: string, database: string) =>
  invoke<Record<string, string[]>>('db_completion_schema', { sessionId, database });

// --- Passwords in the OS keychain (service `dev.kestrel.editor.db`, account = connection id)

export const dbPasswordSet = (id: string, password: string) => invoke<void>('db_password_set', { id, password });
export const dbPasswordDelete = (id: string) => invoke<void>('db_password_delete', { id });
export const dbPasswordExists = (id: string) => invoke<boolean>('db_password_exists', { id });
