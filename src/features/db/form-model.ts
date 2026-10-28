// Data and checks of the connection form. No DOM code, so tests can import it.

import type { DbConnectionConfig, DbSslMode } from '../../ipc/db';

/** What the user types. Numbers stay as text until the form is checked. */
export interface ConnDraft {
  id: string;
  name: string;
  host: string;
  port: string;
  user: string;
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

export function blankDraft(id: string): ConnDraft {
  return {
    id,
    name: '',
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
    host: c.host,
    port: String(c.port),
    user: c.user,
    database: c.database ?? '',
    ssl: c.ssl,
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
  if (d.connectTimeoutSec.trim()) {
    const t = wholeNumber(d.connectTimeoutSec);
    if (t === null || t < 1 || t > 600) e.connectTimeoutSec = 'Use a number of seconds from 1 to 600.';
  }
  if (d.sshEnabled) {
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
  const cfg: DbConnectionConfig = {
    id: d.id,
    name: d.name.trim(),
    host: d.host.trim(),
    port: Number(d.port.trim()),
    user: d.user.trim(),
    database: opt(d.database),
    ssl: d.ssl,
    ssh: d.sshEnabled
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
