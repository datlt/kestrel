import { describe, expect, it } from 'vitest';
import type { DbConnectionConfig } from '../../ipc/db';
import {
  blankDraft,
  configFromDraft,
  connectionSummary,
  copyName,
  draftFromConfig,
  nameTaken,
  removeConnection,
  sameDraft,
  upsertConnection,
  defaultPort,
  defaultTrinoAuth,
  usesPassword,
  validateDraft,
  withDriver,
  withSsl,
} from './form-model';

const valid = () => ({ ...blankDraft('a'), name: 'Local', user: 'root' });

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(valid())).toEqual({});
  });
  it('asks for the required fields', () => {
    const e = validateDraft(blankDraft('a'));
    expect(Object.keys(e).sort()).toEqual(['name', 'user']);
    expect(validateDraft({ ...valid(), host: ' ' }).host).toBeDefined();
  });
  it('checks the ports', () => {
    for (const p of ['', 'abc', '0', '70000', '3.5', '-1']) expect(validateDraft({ ...valid(), port: p }).port, p).toBeDefined();
    expect(validateDraft({ ...valid(), port: '65535' }).port).toBeUndefined();
  });
  it('checks the timeout only when set', () => {
    expect(validateDraft({ ...valid(), connectTimeoutSec: '' }).connectTimeoutSec).toBeUndefined();
    expect(validateDraft({ ...valid(), connectTimeoutSec: '0' }).connectTimeoutSec).toBeDefined();
    expect(validateDraft({ ...valid(), connectTimeoutSec: '601' }).connectTimeoutSec).toBeDefined();
    expect(validateDraft({ ...valid(), connectTimeoutSec: '30' }).connectTimeoutSec).toBeUndefined();
  });
  it('checks the SSH fields only when the tunnel is on', () => {
    expect(validateDraft({ ...valid(), sshHost: '' })).toEqual({});
    const e = validateDraft({ ...valid(), sshEnabled: true, sshPort: 'x' });
    expect(e.sshHost).toBeDefined();
    expect(e.sshPort).toBeDefined();
    expect(validateDraft({ ...valid(), sshEnabled: true, sshHost: 'bastion' })).toEqual({});
  });
});

describe('configFromDraft', () => {
  it('trims, converts numbers and drops empty optional fields', () => {
    const cfg = configFromDraft({ ...valid(), name: ' Local ', port: ' 3307 ', database: ' ', color: '#ff0000' });
    expect(cfg).toMatchObject({ id: 'a', name: 'Local', port: 3307, database: null, ssh: null, color: '#ff0000', initSql: null, connectTimeoutSec: null });
  });
  it('builds the SSH tunnel', () => {
    const cfg = configFromDraft({ ...valid(), sshEnabled: true, sshHost: 'bastion', sshPort: '2222', sshUser: 'me', sshIdentityFile: '' });
    expect(cfg.ssh).toEqual({ host: 'bastion', port: 2222, user: 'me', identityFile: null });
  });
  it('keeps the SQL text of initSql as typed', () => {
    expect(configFromDraft({ ...valid(), initSql: "SET time_zone = '+09:00'" }).initSql).toBe("SET time_zone = '+09:00'");
  });
  it('round-trips through a draft', () => {
    const cfg: DbConnectionConfig = {
      id: 'x', name: 'N', host: 'h', port: 1, user: 'u', database: 'd', ssl: 'required',
      ssh: { host: 's', port: null, user: null, identityFile: '/k' }, readOnly: true, production: true,
      color: '#fff', initSql: 'SELECT 1', connectTimeoutSec: 5,
    };
    expect(configFromDraft(draftFromConfig(cfg))).toEqual(cfg);
  });
  it('compares drafts', () => {
    expect(sameDraft(valid(), valid())).toBe(true);
    expect(sameDraft(valid(), { ...valid(), host: 'x' })).toBe(false);
  });
});

describe('connection list', () => {
  const a = configFromDraft(valid());
  const b = { ...a, id: 'b', name: 'Other' };
  it('adds and replaces', () => {
    expect(upsertConnection([a], b).map((c) => c.id)).toEqual(['a', 'b']);
    expect(upsertConnection([a, b], { ...a, name: 'New' }).map((c) => c.name)).toEqual(['New', 'Other']);
  });
  it('removes', () => {
    expect(removeConnection([a, b], 'a').map((c) => c.id)).toEqual(['b']);
  });
  it('makes copy names', () => {
    expect(copyName('Shop', ['Shop'])).toBe('Shop copy');
    expect(copyName('Shop', ['Shop', 'Shop copy'])).toBe('Shop copy 2');
    expect(copyName('Shop', ['Shop', 'Shop copy', 'Shop copy 2'])).toBe('Shop copy 3');
  });
  it('finds taken names', () => {
    expect(nameTaken([a, b], ' other ', 'a')).toBe(true);
    expect(nameTaken([a, b], 'Other', 'b')).toBe(false);
  });
  it('summarizes', () => {
    expect(connectionSummary({ ...a, database: 'shop' })).toBe('root@127.0.0.1:3306/shop');
    expect(connectionSummary({ ...a, database: null })).toBe('root@127.0.0.1:3306');
  });
});

describe('Trino form', () => {
  const trino = () => withDriver({ ...blankDraft('t'), name: 'Lake', user: 'me', host: 'trino.example.com', catalog: 'hive' }, 'trino');

  it('starts as MySQL', () => {
    const d = blankDraft('a');
    expect(d).toMatchObject({ driver: 'mysql', port: '3306', ssl: 'preferred' });
  });
  it('uses port 443, TLS and the password login when you choose Trino', () => {
    expect(trino()).toMatchObject({ driver: 'trino', port: '443', ssl: 'required', trinoAuth: 'password' });
  });
  it('knows the default ports', () => {
    expect(defaultPort('mysql', 'disabled')).toBe('3306');
    expect(defaultPort('trino', 'required')).toBe('443');
    expect(defaultPort('trino', 'disabled')).toBe('8080');
  });
  it('switches to port 8080 and no login when TLS is turned off', () => {
    expect(withSsl(trino(), 'disabled')).toMatchObject({ port: '8080', trinoAuth: 'none', ssl: 'disabled' });
    expect(defaultTrinoAuth('required')).toBe('password');
  });
  it('keeps a port and a login that the user chose', () => {
    const custom = { ...trino(), port: '8443', trinoAuth: 'oauth2' as const };
    expect(withSsl(custom, 'disabled')).toMatchObject({ port: '8443', trinoAuth: 'oauth2' });
  });
  it('goes back to port 3306 for MySQL', () => {
    expect(withDriver(trino(), 'mysql').port).toBe('3306');
    expect(withDriver({ ...trino(), port: '9999' }, 'mysql').port).toBe('9999');
  });
  it('needs a catalog', () => {
    expect(validateDraft({ ...trino(), catalog: ' ' }).catalog).toBeDefined();
    expect(validateDraft(trino())).toEqual({});
    expect(validateDraft({ ...valid(), catalog: '' }).catalog).toBeUndefined();
  });
  it('builds a Trino config without MySQL-only settings', () => {
    const cfg = configFromDraft({ ...trino(), database: 'web', readOnly: true, sshEnabled: true, sshHost: 'x' });
    expect(cfg).toMatchObject({ driver: 'trino', catalog: 'hive', trinoAuth: 'password', database: 'web', port: 443, ssl: 'required', ssh: null, readOnly: true });
  });
  it('writes no engine fields for MySQL', () => {
    const cfg = configFromDraft(valid());
    expect('driver' in cfg || 'catalog' in cfg || 'trinoAuth' in cfg).toBe(false);
  });
  it('round-trips a Trino config', () => {
    const cfg = configFromDraft({ ...trino(), trinoAuth: 'oauth2', database: 'web' });
    expect(configFromDraft(draftFromConfig(cfg))).toEqual(cfg);
  });
  it('reads a Trino config that has no login set', () => {
    const base: DbConnectionConfig = { id: 'x', name: 'N', driver: 'trino', catalog: 'c', host: 'h', port: 443, user: 'u', ssl: 'required', readOnly: false, production: false };
    expect(draftFromConfig(base).trinoAuth).toBe('password');
    expect(draftFromConfig({ ...base, ssl: 'disabled' }).trinoAuth).toBe('none');
  });
  it('asks for a password only with MySQL or the Trino password login', () => {
    expect(usesPassword({ ssl: 'preferred' })).toBe(true);
    expect(usesPassword({ driver: 'trino', ssl: 'required', trinoAuth: 'password' })).toBe(true);
    expect(usesPassword({ driver: 'trino', ssl: 'required', trinoAuth: 'oauth2' })).toBe(false);
    expect(usesPassword({ driver: 'trino', ssl: 'disabled' })).toBe(false);
  });
});
