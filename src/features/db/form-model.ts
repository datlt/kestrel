// Data and checks of the connection form. No DOM code, so tests can import it.

import type { DbConnectionConfig, DbDriver, DbSslMode, DbTrinoAuth } from '../../ipc/db';

/** What the user types. Numbers stay as text until the form is checked. */
export interface ConnDraft {
  id: string;
  name: string;
  /** Database engine. */
  driver: DbDriver;
  /** Trino only. */
  catalog: string;
  /** Trino only: how to log in. */
  trinoAuth: DbTrinoAuth;
  host: string;
  port: string;
  user: string;
  /** MySQL: the default database. Trino: the schema. */
  database: string;
  ssl: DbSslMode;
  readOnly: boolean;
  production: boolean;
  color: string;
  initSql: string;
  connectTimeoutSec: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshIdentityFile: string;
}

export type DraftField = keyof ConnDraft;

/** Port of a new connection: MySQL 3306. Trino 443 with TLS, 8080 without. */
export function defaultPort(driver: DbDriver, ssl: DbSslMode): string {
  if (driver !== 'trino') return '3306';
  return ssl === 'disabled' ? '8080' : '443';
}

/** Login of a new Trino connection: a password over TLS, only the user name over plain http. */
export function defaultTrinoAuth(ssl: DbSslMode): DbTrinoAuth {
  return ssl === 'disabled' ? 'none' : 'password';
}

/** The login a Trino config uses. An unset value follows the TLS setting (as the Rust side does). */
export function effectiveTrinoAuth(c: Pick<DbConnectionConfig, 'ssl' | 'trinoAuth'>): DbTrinoAuth {
  return c.trinoAuth ?? defaultTrinoAuth(c.ssl);
}

/** The server may ask for a password for this connection (MySQL, or Trino with the password login). */
export function usesPassword(c: Pick<DbConnectionConfig, 'driver' | 'ssl' | 'trinoAuth'>): boolean {
  return c.driver !== 'trino' || effectiveTrinoAuth(c) === 'password';
}

/**
 * Changes the engine of a draft. The port and the login change too, but only
 * while they still have the default of the old settings. A value the user typed stays.
 */
export function withDriver(d: ConnDraft, driver: DbDriver): ConnDraft {
  if (driver === d.driver) return d;
  const next: ConnDraft = { ...d, driver };
  // Trino knows only https (TLS) and http (no TLS).
  if (driver === 'trino' && next.ssl === 'preferred') next.ssl = 'required';
  if (d.port.trim() === '' || d.port === defaultPort(d.driver, d.ssl)) next.port = defaultPort(driver, next.ssl);
  if (driver === 'trino') next.trinoAuth = defaultTrinoAuth(next.ssl);
  return next;
}

/** Changes the TLS setting of a draft. For Trino the port and the login follow it while they are the defaults. */
export function withSsl(d: ConnDraft, ssl: DbSslMode): ConnDraft {
  const next: ConnDraft = { ...d, ssl };
  if (d.driver === 'trino') {
    if (d.port.trim() === '' || d.port === defaultPort('trino', d.ssl)) next.port = defaultPort('trino', ssl);
    if (d.trinoAuth === defaultTrinoAuth(d.ssl)) next.trinoAuth = defaultTrinoAuth(ssl);
  }
  return next;
}

export function blankDraft(id: string): ConnDraft {
  return {
    id,
    name: '',
    driver: 'mysql',
    catalog: '',
    trinoAuth: 'password',
    host: '127.0.0.1',
    port: '3306',
    user: '',
    database: '',
    ssl: 'preferred',
    readOnly: false,
    production: false,
    color: '',
    initSql: '',
    connectTimeoutSec: '',
    sshEnabled: false,
    sshHost: '',
    sshPort: '',
    sshUser: '',
    sshIdentityFile: '',
  };
}

export function draftFromConfig(c: DbConnectionConfig): ConnDraft {
  return {
    id: c.id,
    name: c.name,
    driver: c.driver ?? 'mysql',
    catalog: c.catalog ?? '',
    trinoAuth: effectiveTrinoAuth(c),
    host: c.host,
    port: String(c.port),
    user: c.user,
    database: c.database ?? '',
    // Trino knows only https and http, so `preferred` means https.
    ssl: c.driver === 'trino' && c.ssl === 'preferred' ? 'required' : c.ssl,
    readOnly: c.readOnly,
    production: c.production,
    color: c.color ?? '',
    initSql: c.initSql ?? '',
    connectTimeoutSec: c.connectTimeoutSec == null ? '' : String(c.connectTimeoutSec),
    sshEnabled: !!c.ssh,
    sshHost: c.ssh?.host ?? '',
    sshPort: c.ssh?.port == null ? '' : String(c.ssh.port),
    sshUser: c.ssh?.user ?? '',
    sshIdentityFile: c.ssh?.identityFile ?? '',
  };
}

function wholeNumber(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

export type DraftErrors = Partial<Record<DraftField, string>>;

export function validateDraft(d: ConnDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = 'Enter a name.';
  if (!d.host.trim()) e.host = 'Enter the host name or address.';
  const port = wholeNumber(d.port);
  if (port === null || port < 1 || port > 65535) e.port = 'The port is a number from 1 to 65535.';
  if (!d.user.trim()) e.user = 'Enter the user name.';
  if (d.driver === 'trino' && !d.catalog.trim()) e.catalog = 'Enter the catalog, for example hive.';
  if (d.connectTimeoutSec.trim()) {
    const t = wholeNumber(d.connectTimeoutSec);
    if (t === null || t < 1 || t > 600) e.connectTimeoutSec = 'Use a number of seconds from 1 to 600.';
  }
  if (d.sshEnabled && d.driver !== 'trino') {
    if (!d.sshHost.trim()) e.sshHost = 'Enter the SSH host.';
    if (d.sshPort.trim()) {
      const p = wholeNumber(d.sshPort);
      if (p === null || p < 1 || p > 65535) e.sshPort = 'The port is a number from 1 to 65535.';
    }
  }
  return e;
}

/** Builds the stored config. Call it only when `validateDraft` found no errors. */
export function configFromDraft(d: ConnDraft): DbConnectionConfig {
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  const trino = d.driver === 'trino';
  const cfg: DbConnectionConfig = {
    id: d.id,
    name: d.name.trim(),
    // A MySQL config has no engine fields, as before.
    ...(trino ? { driver: 'trino' as const, catalog: opt(d.catalog), trinoAuth: d.trinoAuth } : {}),
    host: d.host.trim(),
    port: Number(d.port.trim()),
    user: d.user.trim(),
    database: opt(d.database),
    ssl: d.ssl,
    ssh: d.sshEnabled && !trino
      ? {
          host: d.sshHost.trim(),
          port: d.sshPort.trim() ? Number(d.sshPort.trim()) : null,
          user: opt(d.sshUser),
          identityFile: opt(d.sshIdentityFile),
        }
      : null,
    readOnly: d.readOnly,
    production: d.production,
    color: opt(d.color),
    initSql: d.initSql.trim() ? d.initSql : null,
    connectTimeoutSec: d.connectTimeoutSec.trim() ? Number(d.connectTimeoutSec.trim()) : null,
  };
  return cfg;
}

export function sameDraft(a: ConnDraft, b: ConnDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- The list in the setting `db.connections` ---------------------------------------

export function upsertConnection(list: readonly DbConnectionConfig[], cfg: DbConnectionConfig): DbConnectionConfig[] {
  const i = list.findIndex((c) => c.id === cfg.id);
  if (i < 0) return [...list, cfg];
  const next = [...list];
  next[i] = cfg;
  return next;
}

export function removeConnection(list: readonly DbConnectionConfig[], id: string): DbConnectionConfig[] {
  return list.filter((c) => c.id !== id);
}

/** "Shop copy", then "Shop copy 2" when that name exists. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name} copy`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Another connection has this name (names are shown in pickers, so they should differ). */
export function nameTaken(list: readonly DbConnectionConfig[], name: string, selfId: string): boolean {
  const n = name.trim().toLowerCase();
  return list.some((c) => c.id !== selfId && c.name.trim().toLowerCase() === n);
}

/** Short text for lists: `user@host:port/database`. */
export function connectionSummary(c: DbConnectionConfig): string {
  return `${c.user}@${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
}
