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
  validateDraft,
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
