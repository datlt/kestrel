import { describe, expect, it } from 'vitest';
import { buildRequest, DEFAULT_OPTIONS, needsNewRequest, normalizeOptions, normalizeScope, scopeForSession, toggleRelation } from './options';

describe('options', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_OPTIONS.relations).toEqual(['extends', 'implements', 'composition', 'aggregation']);
    expect(DEFAULT_OPTIONS.depth).toBe(1);
    expect(DEFAULT_OPTIONS.direction).toBe('both');
    expect(DEFAULT_OPTIONS.members).toBe('public');
    expect(DEFAULT_OPTIONS.external).toBe(false);
    expect(DEFAULT_OPTIONS.layout).toBe('TB');
  });

  it('normalizes bad input to defaults and clamps depth', () => {
    expect(normalizeOptions(undefined)).toEqual(DEFAULT_OPTIONS);
    expect(normalizeOptions('x')).toEqual(DEFAULT_OPTIONS);
    const o = normalizeOptions({ relations: ['nested', 'bogus', 'extends'], depth: 99, direction: 'sideways', members: 'all', external: true, layout: 'LR' });
    expect(o.relations).toEqual(['extends', 'nested']);
    expect(o.depth).toBe(5);
    expect(o.direction).toBe('both');
    expect(o.members).toBe('all');
    expect(o.external).toBe(true);
    expect(o.layout).toBe('LR');
    expect(normalizeOptions({ depth: -3 }).depth).toBe(0);
  });

  it('toggles a relation and keeps the canonical order', () => {
    const on = toggleRelation(DEFAULT_OPTIONS, 'dependency');
    expect(on.relations).toEqual(['extends', 'implements', 'composition', 'aggregation', 'dependency']);
    const off = toggleRelation(on, 'extends');
    expect(off.relations).toEqual(['implements', 'composition', 'aggregation', 'dependency']);
    expect(DEFAULT_OPTIONS.relations).toHaveLength(4);
  });

  it('builds the request', () => {
    const req = buildRequest('/root', { kind: 'folder', path: '/root/a' }, { ...DEFAULT_OPTIONS, direction: 'in', external: true });
    expect(req).toEqual({
      root: '/root',
      scope: { kind: 'folder', path: '/root/a' },
      relations: ['extends', 'implements', 'composition', 'aggregation'],
      depth: 1,
      direction: 'in',
      includeExternal: true,
      maxNodes: 150,
      maxFan: 20,
    });
    const more = buildRequest('/root', { kind: 'types', ids: ['a'] }, { ...DEFAULT_OPTIONS, depth: 1, direction: 'in' }, 200, 500);
    expect(more).toMatchObject({ maxNodes: 200, maxFan: 500, depth: 1, direction: 'in', scope: { kind: 'types', ids: ['a'] } });
  });

  it('asks Rust again only for options that change the data', () => {
    expect(needsNewRequest(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, members: 'all' })).toBe(false);
    expect(needsNewRequest(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, layout: 'LR' })).toBe(false);
    expect(needsNewRequest(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, depth: 3 })).toBe(true);
    expect(needsNewRequest(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, direction: 'out' })).toBe(true);
    expect(needsNewRequest(DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, external: true })).toBe(true);
    expect(needsNewRequest(DEFAULT_OPTIONS, toggleRelation(DEFAULT_OPTIONS, 'nested'))).toBe(true);
  });

  it('drops the editor text from the saved scope and checks restored scopes', () => {
    expect(scopeForSession({ kind: 'cursor', path: '/a.kt', line: 1, column: 2, text: 'secret' })).toEqual({ kind: 'cursor', path: '/a.kt', line: 1, column: 2 });
    expect(scopeForSession({ kind: 'file', path: '/a.kt', text: 'x' })).toEqual({ kind: 'file', path: '/a.kt' });
    expect(normalizeScope({ kind: 'types', ids: ['a', 'b'] })).toEqual({ kind: 'types', ids: ['a', 'b'] });
    expect(normalizeScope({ kind: 'types', ids: [1] })).toBeNull();
    expect(normalizeScope({ kind: 'cursor', path: '/a', line: 'x', column: 1 })).toBeNull();
    expect(normalizeScope(null)).toBeNull();
  });
});
