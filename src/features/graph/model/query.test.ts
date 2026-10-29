import { describe, expect, it } from 'vitest';
import type { NoteNode } from '../types';
import { compileQuery } from './index';

function note(rel: string, extra: Partial<NoteNode> = {}): NoteNode {
  const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return { kind: 'note', path: `/r/${rel}`, rel, name, title: null, tags: [], aliases: [], size: 1, mtimeMs: 1, ...extra };
}

const auth = note('docs/api/Auth.md', { title: 'Authentication', tags: ['API/v2', 'guide'] });
const daily = note('notes/Daily Log.md', { tags: ['journal'] });
const home = note('Home.md');

function matches(q: string, nodes: NoteNode[] = [auth, daily, home]): string[] {
  const c = compileQuery(q);
  expect(c.error, q).toBeNull();
  return nodes.filter((n) => c.test(n)).map((n) => n.rel);
}

describe('compileQuery', () => {
  it('is empty for blank text and matches everything', () => {
    for (const q of ['', '   ', '\n']) {
      const c = compileQuery(q);
      expect(c.empty).toBe(true);
      expect(c.error).toBeNull();
      expect(c.test(auth)).toBe(true);
    }
  });

  it('matches words in the rel path without case, all words must match', () => {
    expect(matches('AUTH')).toEqual(['docs/api/Auth.md']);
    expect(matches('docs auth')).toEqual(['docs/api/Auth.md']);
    expect(matches('docs home')).toEqual([]);
    expect(matches('o')).toEqual(['docs/api/Auth.md', 'notes/Daily Log.md', 'Home.md']);
  });

  it('matches quoted phrases', () => {
    expect(matches('"daily log"')).toEqual(['notes/Daily Log.md']);
    expect(matches('"log daily"')).toEqual([]);
    expect(matches('"notes/" log')).toEqual(['notes/Daily Log.md']);
  });

  it('excludes with a minus', () => {
    expect(matches('o -auth')).toEqual(['notes/Daily Log.md', 'Home.md']);
    expect(matches('-"daily log" -home')).toEqual(['docs/api/Auth.md']);
    expect(matches('--auth')).toEqual(['docs/api/Auth.md']);
  });

  it('keeps a minus inside a word', () => {
    expect(matches('foo-bar', [note('foo-bar.md'), note('foo.md')])).toEqual(['foo-bar.md']);
  });

  it('supports OR and groups', () => {
    expect(matches('auth OR home')).toEqual(['docs/api/Auth.md', 'Home.md']);
    expect(matches('docs OR notes -daily')).toEqual(['docs/api/Auth.md']);
    expect(matches('(auth OR daily) o')).toEqual(['docs/api/Auth.md', 'notes/Daily Log.md']);
    expect(matches('-(auth OR daily)')).toEqual(['Home.md']);
    expect(matches('((auth))')).toEqual(['docs/api/Auth.md']);
  });

  it('treats lower case or as a word', () => {
    expect(matches('auth or home')).toEqual([]);
  });

  it('supports path: and file:', () => {
    expect(matches('path:docs/api')).toEqual(['docs/api/Auth.md']);
    expect(matches('file:auth')).toEqual(['docs/api/Auth.md']);
    expect(matches('file:docs')).toEqual([]);
    expect(matches('file:"daily log"')).toEqual(['notes/Daily Log.md']);
    expect(matches('PATH:NOTES')).toEqual(['notes/Daily Log.md']);
  });

  it('supports title:, with the name when there is no title', () => {
    expect(matches('title:authentic')).toEqual(['docs/api/Auth.md']);
    expect(matches('title:home')).toEqual(['Home.md']);
  });

  it('supports tag: with and without #, also for nested tags', () => {
    expect(matches('tag:#api')).toEqual(['docs/api/Auth.md']);
    expect(matches('tag:api')).toEqual(['docs/api/Auth.md']);
    expect(matches('tag:api/v2')).toEqual(['docs/api/Auth.md']);
    expect(matches('tag:API/V2')).toEqual(['docs/api/Auth.md']);
    expect(matches('tag:ap')).toEqual([]);
    expect(matches('tag:v2')).toEqual([]);
    expect(matches('-tag:guide')).toEqual(['notes/Daily Log.md', 'Home.md']);
    expect(matches('tag:journal OR tag:api')).toEqual(['docs/api/Auth.md', 'notes/Daily Log.md']);
  });

  it('supports regular expressions on the rel path and after a key', () => {
    expect(matches('/^docs\\//')).toEqual(['docs/api/Auth.md']);
    expect(matches('/AUTH|HOME/')).toEqual(['docs/api/Auth.md', 'Home.md']);
    expect(matches('file:/^d/')).toEqual(['notes/Daily Log.md']);
    expect(matches('tag:/^jour/')).toEqual(['notes/Daily Log.md']);
    expect(matches('-/^docs/')).toEqual(['notes/Daily Log.md', 'Home.md']);
  });

  it('treats unknown keys as plain words', () => {
    expect(matches('foo:bar', [note('foo:bar.md'), note('x.md')])).toEqual(['foo:bar.md']);
  });

  it('ignores empty parts without an error', () => {
    for (const q of ['tag:', 'path:""', '-', '()', 'auth OR', 'OR auth', 'auth -']) {
      const c = compileQuery(q);
      expect(c.error, q).toBeNull();
    }
    expect(matches('auth OR')).toEqual(['docs/api/Auth.md']);
    expect(compileQuery('()').empty).toBe(true);
    expect(compileQuery('tag:').empty).toBe(true);
  });

  it('reports broken queries and then matches everything', () => {
    const bad: [string, RegExp][] = [
      ['"open', /quote/i],
      ['path:"open', /quote/i],
      ['/open', /regular/i],
      ['/(/', /regular/i],
      ['(a', /\)/],
      ['a)', /\)/],
      ['((a)', /\)/],
    ];
    for (const [q, re] of bad) {
      const c = compileQuery(q);
      expect(c.error, q).toMatch(re);
      expect(c.empty).toBe(false);
      expect(c.test(home)).toBe(true);
      expect(c.test(auth)).toBe(true);
    }
  });

  it('never throws on junk', () => {
    const junk = ['(((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((a', ')(', '"""', '///', '\0', 'tag:/[/', '-(-(-(', '\\'];
    for (const q of junk) expect(() => compileQuery(q), q).not.toThrow();
    // Not a string at all.
    expect(() => compileQuery(undefined as unknown as string)).not.toThrow();
    expect(() => compileQuery(null as unknown as string)).not.toThrow();
    expect(() => compileQuery(5 as unknown as string)).not.toThrow();
    expect(() => compileQuery('('.repeat(100000))).not.toThrow();
    expect(compileQuery('('.repeat(100000)).error).not.toBeNull();
  });

  it('gives the same answer when the same node is tested again after a change of node', () => {
    const c = compileQuery('auth');
    expect([c.test(auth), c.test(home), c.test(auth), c.test(home)]).toEqual([true, false, true, false]);
  });
});
