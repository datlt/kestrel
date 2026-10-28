import { describe, expect, it } from 'vitest';
import { draftsKey, parsePrTabId, parsePullRef, prTabId, prWebUrl, viewedKey } from './parse';

describe('parsePullRef', () => {
  it('reads a pull request address', () => {
    expect(parsePullRef('https://github.example.test/acme/shop/pull/42', 'x')).toEqual({ host: 'github.example.test', owner: 'acme', repo: 'shop', number: 42 });
    expect(parsePullRef(' https://github.com/acme/shop/pull/7/files#diff-abc ', 'x')?.number).toBe(7);
    expect(parsePullRef('https://github.com/acme/shop/pull/7?x=1', 'x')?.number).toBe(7);
  });
  it('reads owner/repo#n with the default host', () => {
    expect(parsePullRef('acme/shop#12', 'github.com')).toEqual({ host: 'github.com', owner: 'acme', repo: 'shop', number: 12 });
  });
  it('reads host/owner/repo#n', () => {
    expect(parsePullRef('git.example.test/acme/shop#3', 'github.com')?.host).toBe('git.example.test');
  });
  it('refuses other text', () => {
    for (const t of ['', 'hello', 'acme/shop', 'acme/shop#0', 'acme/shop#x', 'https://github.com/acme/shop/issues/3', 'https://github.com/acme/shop', 'ftp://h/a/b/pull/1']) {
      expect(parsePullRef(t, 'github.com')).toBeNull();
    }
  });
});

describe('ids and keys', () => {
  const ref = { host: 'github.example.test', owner: 'acme', repo: 'shop', number: 42 };
  it('builds and reads the tab id', () => {
    expect(prTabId(ref)).toBe('pr:github.example.test/acme/shop#42');
    expect(parsePrTabId(prTabId(ref))).toEqual(ref);
    expect(parsePrTabId('file:/x')).toBeNull();
  });
  it('builds state keys', () => {
    expect(draftsKey(ref)).toBe('github.drafts:github.example.test/acme/shop#42');
    expect(viewedKey(ref, 'abc')).toBe('github.viewed:github.example.test/acme/shop#42@abc');
    expect(prWebUrl(ref)).toBe('https://github.example.test/acme/shop/pull/42');
  });
});
