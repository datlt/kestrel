import { describe, expect, it } from 'vitest';
import { PALETTE_DARK, PALETTE_LIGHT } from './colors';
import { DEFAULT_OPTIONS, graphTitle, normalizeFolderState, normalizeOptions, normalizeScope } from './index';

const JUNK: unknown[] = [
  undefined,
  null,
  0,
  1,
  NaN,
  '',
  'x',
  true,
  [],
  [1, 2],
  {},
  () => 1,
  Symbol('s'),
  { layout: 5, groups: 'x', depth: {}, query: [] },
  { collapsed: 'a', hidden: { a: 1 } },
  { kind: 'folder' },
  { kind: { x: 1 } },
  JSON.parse('{"__proto__": {"depth": 99}}'),
];

describe('normalizeOptions', () => {
  it('returns the defaults for junk and never throws', () => {
    for (const v of JUNK) expect(normalizeOptions(v)).toEqual(DEFAULT_OPTIONS);
  });

  it('keeps good values and returns a new object', () => {
    const o = normalizeOptions({ layout: 'radial', showTags: true, nodeSize: 2, depth: 3, labelBy: 'title', colorBy: 'tag' });
    expect(o).toMatchObject({ layout: 'radial', showTags: true, nodeSize: 2, depth: 3, labelBy: 'title', colorBy: 'tag' });
    expect(normalizeOptions({})).not.toBe(DEFAULT_OPTIONS);
  });

  it('clamps numbers to their range', () => {
    const hi = normalizeOptions({
      folderPull: 9,
      colorDepth: 99,
      textFade: 99,
      nodeSize: 99,
      linkThickness: 99,
      bundling: 99,
      centerForce: 99,
      repelForce: 99,
      linkForce: 99,
      linkDistance: 9999,
      depth: 99,
    });
    expect(hi).toMatchObject({
      folderPull: 1,
      colorDepth: 4,
      textFade: 3,
      nodeSize: 3,
      linkThickness: 3,
      bundling: 1,
      centerForce: 1,
      repelForce: 20,
      linkForce: 1,
      linkDistance: 500,
      depth: 5,
    });
    const lo = normalizeOptions({
      folderPull: -1,
      colorDepth: -5,
      textFade: -99,
      nodeSize: 0,
      linkThickness: -1,
      bundling: -1,
      centerForce: -1,
      repelForce: -1,
      linkForce: -1,
      linkDistance: 1,
      depth: 0,
    });
    expect(lo).toMatchObject({
      folderPull: 0,
      colorDepth: 1,
      textFade: -3,
      nodeSize: 0.2,
      linkThickness: 0.2,
      bundling: 0,
      centerForce: 0,
      repelForce: 0,
      linkForce: 0,
      linkDistance: 30,
      depth: 1,
    });
  });

  it('rounds the integer fields and rejects NaN and Infinity', () => {
    expect(normalizeOptions({ depth: 2.6, colorDepth: 1.2 })).toMatchObject({ depth: 3, colorDepth: 1 });
    expect(normalizeOptions({ nodeSize: NaN, repelForce: Infinity, linkDistance: '100' })).toMatchObject({
      nodeSize: DEFAULT_OPTIONS.nodeSize,
      repelForce: DEFAULT_OPTIONS.repelForce,
      linkDistance: DEFAULT_OPTIONS.linkDistance,
    });
  });

  it('rejects wrong types and unknown enum values', () => {
    const o = normalizeOptions({ layout: 'spiral', colorBy: 'size', labelBy: 'path', showTags: 'yes', query: 5 });
    expect(o).toMatchObject({ layout: 'force', colorBy: 'folder', labelBy: 'name', showTags: false, query: '' });
  });

  it('checks the groups', () => {
    const o = normalizeOptions({
      groups: [
        { query: 'tag:a', color: '#ABC' },
        { query: 'x', color: 'red' },
        { query: 5, color: '#112233' },
        null,
        'x',
        { query: 'ok', color: ' #00ff00 ' },
      ],
    });
    expect(o.groups).toEqual([
      { query: 'tag:a', color: '#aabbcc' },
      { query: '', color: '#112233' },
      { query: 'ok', color: '#00ff00' },
    ]);
  });

  it('limits the number of groups and the length of the query', () => {
    const groups = Array.from({ length: 200 }, () => ({ query: 'a', color: '#000000' }));
    expect(normalizeOptions({ groups }).groups).toHaveLength(50);
    expect(normalizeOptions({ query: 'a'.repeat(10000) }).query).toHaveLength(2000);
  });

  it('does not take the prototype of the input', () => {
    expect(normalizeOptions(JSON.parse('{"__proto__": {"depth": 4}}')).depth).toBe(DEFAULT_OPTIONS.depth);
  });
});

describe('normalizeFolderState', () => {
  it('never throws on junk', () => {
    for (const v of JUNK) expect(normalizeFolderState(v)).toEqual({ collapsed: [], hidden: [] });
  });

  it('keeps strings, drops the root and duplicates, fixes slashes', () => {
    const s = normalizeFolderState({ collapsed: ['a', 'a', '', 5, null, '/b/', 'c\\d'], hidden: ['x', {}] });
    expect(s).toEqual({ collapsed: ['a', 'b', 'c/d'], hidden: ['x'] });
  });
});

describe('normalizeScope', () => {
  it('accepts the three kinds', () => {
    expect(normalizeScope({ kind: 'project' })).toEqual({ kind: 'project' });
    expect(normalizeScope({ kind: 'folder', path: '/a' })).toEqual({ kind: 'folder', path: '/a' });
    expect(normalizeScope({ kind: 'local', path: '/a/b.md', follow: true })).toEqual({ kind: 'local', path: '/a/b.md', follow: true });
    expect(normalizeScope({ kind: 'local' })).toEqual({ kind: 'local', path: null, follow: false });
    expect(normalizeScope({ kind: 'local', path: 5, follow: 'yes' })).toEqual({ kind: 'local', path: null, follow: false });
  });

  it('returns null for junk and never throws', () => {
    for (const v of JUNK) expect(normalizeScope(v)).toBeNull();
    expect(normalizeScope({ kind: 'folder', path: '' })).toBeNull();
    expect(normalizeScope({ kind: 'other' })).toBeNull();
  });
});

describe('graphTitle', () => {
  it('names the scope', () => {
    expect(graphTitle({ kind: 'project' }, '/r')).toBe('Graph');
    expect(graphTitle({ kind: 'folder', path: '/r/docs' }, '/r')).toBe('Graph: docs');
    expect(graphTitle({ kind: 'folder', path: '/r/docs/' }, '/r')).toBe('Graph: docs');
    expect(graphTitle({ kind: 'folder', path: 'C:\\r\\docs' }, null)).toBe('Graph: docs');
    expect(graphTitle({ kind: 'local', path: '/r/docs/Auth.md', follow: false }, '/r')).toBe('Local Graph: Auth');
    expect(graphTitle({ kind: 'local', path: '/r/docs/Auth.markdown', follow: true }, null)).toBe('Local Graph: Auth');
    expect(graphTitle({ kind: 'local', path: null, follow: true }, '/r')).toBe('Local Graph');
  });

  it('uses the root name when the folder path has no name', () => {
    expect(graphTitle({ kind: 'folder', path: '/' }, '/r/vault')).toBe('Graph: vault');
  });
});

describe('palettes', () => {
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it('has 12 different colors each', () => {
    expect(new Set(PALETTE_LIGHT).size).toBe(12);
    expect(new Set(PALETTE_DARK).size).toBe(12);
  });

  it('has contrast of at least 3:1 on the editor background', () => {
    for (const c of PALETTE_LIGHT) expect(contrast(c, '#ffffff'), c).toBeGreaterThanOrEqual(3);
    for (const c of PALETTE_DARK) expect(contrast(c, '#1e1e1e'), c).toBeGreaterThanOrEqual(3);
  });
});
