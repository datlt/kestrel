import { describe, expect, it } from 'vitest';
import { PALETTE_DARK, PALETTE_LIGHT } from './colors';
import { makeGraph, sampleGraph } from './fixtures';
import { buildFolderTree } from './index';
import type { FolderNode } from '../types';

function find(t: FolderNode, rel: string): FolderNode {
  if (t.rel === rel) return t;
  for (const c of t.children) {
    const f = rel === c.rel || rel.startsWith(`${c.rel}/`) ? find(c, rel) : null;
    if (f) return f;
  }
  throw new Error(`no folder ${rel}`);
}

describe('buildFolderTree', () => {
  it('builds the folders that hold nodes with counts', () => {
    const t = buildFolderTree(sampleGraph(), 1, 'light');
    expect(t).toMatchObject({ rel: '', name: 'vault', path: '/vault', depth: 0, notes: 1, totalNotes: 6, color: null });
    expect(t.children.map((c) => c.rel)).toEqual(['docs', 'notes']);
    expect(find(t, 'docs')).toMatchObject({ name: 'docs', path: '/vault/docs', depth: 1, notes: 1, totalNotes: 3 });
    expect(find(t, 'docs/api')).toMatchObject({ depth: 2, notes: 2, totalNotes: 2, path: '/vault/docs/api' });
    expect(find(t, 'notes/ideas')).toMatchObject({ notes: 1, totalNotes: 1 });
  });

  it('counts only notes, but keeps folders that hold attachments or missing nodes', () => {
    const g = makeGraph({ notes: ['a.md'], attachments: ['img/x.png'], missing: ['gone/y.md'] });
    const t = buildFolderTree(g, 1, 'light');
    expect(t.children.map((c) => c.rel)).toEqual(['gone', 'img']);
    expect(find(t, 'img')).toMatchObject({ notes: 0, totalNotes: 0 });
    expect(t.totalNotes).toBe(1);
  });

  it('sorts children by name without case, then by code point', () => {
    const g = makeGraph({ notes: ['b/x.md', 'A/x.md', 'a/x.md', 'C/x.md'] });
    expect(buildFolderTree(g, 1, 'light').children.map((c) => c.name)).toEqual(['A', 'a', 'b', 'C']);
  });

  it('colors folders at the color depth, null above, inherited below', () => {
    const t1 = buildFolderTree(sampleGraph(), 1, 'light');
    expect(find(t1, '').color).toBeNull();
    expect(find(t1, 'docs').color).toBe(PALETTE_LIGHT[0]);
    expect(find(t1, 'notes').color).toBe(PALETTE_LIGHT[1]);
    expect(find(t1, 'docs/api').color).toBe(PALETTE_LIGHT[0]);
    expect(find(t1, 'notes/ideas').color).toBe(PALETTE_LIGHT[1]);

    const t2 = buildFolderTree(sampleGraph(), 2, 'light');
    expect(find(t2, 'docs').color).toBeNull();
    expect(find(t2, 'docs/api').color).toBe(PALETTE_LIGHT[0]);
    expect(find(t2, 'notes/ideas').color).toBe(PALETTE_LIGHT[1]);
  });

  it('uses the dark palette for the dark theme', () => {
    const t = buildFolderTree(sampleGraph(), 1, 'dark');
    expect(find(t, 'docs').color).toBe(PALETTE_DARK[0]);
  });

  it('gives the same folder the same color every time, in the order of the tree', () => {
    const g = makeGraph({ notes: ['z/a.md', 'm/a.md', 'a/a.md'] });
    const colors = (t: FolderNode): string[] => t.children.map((c) => c.color!);
    expect(colors(buildFolderTree(g, 1, 'light'))).toEqual(colors(buildFolderTree(g, 1, 'light')));
    expect(colors(buildFolderTree(g, 1, 'light'))).toEqual([PALETTE_LIGHT[0], PALETTE_LIGHT[1], PALETTE_LIGHT[2]]);
  });

  it('reuses colors after 12 folders', () => {
    const notes = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}/a.md`);
    const t = buildFolderTree(makeGraph({ notes }), 1, 'light');
    expect(t.children[12].color).toBe(PALETTE_LIGHT[0]);
  });

  it('handles an empty graph and a root with a slash at the end', () => {
    const t = buildFolderTree(makeGraph({}), 1, 'light');
    expect(t.children).toEqual([]);
    const g = makeGraph({ notes: ['d/a.md'], root: '/v/' });
    expect(buildFolderTree(g, 1, 'light').children[0].path).toBe('/v/d');
  });
});
