import { describe, expect, it } from 'vitest';
import type { DirEntry } from '../../ipc/fs';
import { TreeModel } from './tree';

const dir = (path: string, extra: Partial<DirEntry> = {}): DirEntry => ({
  name: path.split('/').pop()!,
  path,
  isDir: true,
  isSymlink: false,
  ignored: false,
  ...extra,
});
const file = (path: string): DirEntry => ({ ...dir(path), isDir: false });

/** A fake file system: folder path -> entries. */
function makeModel(fsMap: Record<string, DirEntry[]>) {
  const calls: string[] = [];
  const model = new TreeModel({
    list: async (d) => {
      calls.push(d);
      const l = fsMap[d];
      if (!l) throw Object.assign(new Error('gone'), { code: 'not_found' });
      return l;
    },
    isExcluded: (rel) => rel === 'hidden',
    onError: () => {},
  });
  return { model, calls };
}

const javaTree = (): Record<string, DirEntry[]> => ({
  '/r': [dir('/r/src', { compact: ['main', 'java'], compactStyle: 'slash' }), dir('/r/docs'), file('/r/a.txt')],
  '/r/src/main/java': [dir('/r/src/main/java/com', { compact: ['example', 'app'], compactStyle: 'dot' })],
  '/r/src/main/java/com/example/app': [file('/r/src/main/java/com/example/app/A.java')],
  '/r/docs': [file('/r/docs/x.md')],
});

describe('compact rows', () => {
  it('uses the deepest folder as the node path', async () => {
    const { model } = makeModel(javaTree());
    await model.setRoot('/r');
    const src = model.rows[0];
    expect(src.path).toBe('/r/src/main/java');
    expect(src.name).toBe('java');
    expect(src.chain).toEqual(['src', 'main', 'java']);
    expect(src.rel).toBe('src/main/java');
    expect(src.chainPaths).toEqual(['/r/src', '/r/src/main', '/r/src/main/java']);
    expect(src.depth).toBe(0);
    expect(model.chainIndex.get('/r/src/main')).toBe(src);
    expect(model.nodeAt('/r/src')).toBe(src);
    expect(model.knows('/r/src/main')).toBe(true);
  });

  it('expands the deepest folder and joins with dots below a source root', async () => {
    const { model } = makeModel(javaTree());
    await model.setRoot('/r');
    await model.expand(model.rows[0]);
    const com = model.rows[1];
    expect(com.chain).toEqual(['com', 'example', 'app']);
    expect(com.chainStyle).toBe('dot');
    expect(com.depth).toBe(1);
    await model.expand(com);
    expect(model.rows.map((r) => r.name)).toEqual(['java', 'app', 'A.java', 'docs', 'a.txt']);
  });

  it('hides a row by its top folder', async () => {
    const l = javaTree();
    l['/r'].push(dir('/r/hidden', { compact: ['inner'] }));
    const { model } = makeModel(l);
    await model.setRoot('/r');
    expect(model.rows.some((r) => r.chain?.[0] === 'hidden')).toBe(false);
  });

  it('reveals a file inside a compact row', async () => {
    const { model } = makeModel(javaTree());
    await model.setRoot('/r');
    const n = await model.reveal('/r/src/main/java/com/example/app/A.java');
    expect(n?.name).toBe('A.java');
    expect(model.rows.map((r) => r.name)).toContain('A.java');
    // A folder inside a row gives the row.
    const row = await model.reveal('/r/src/main');
    expect(row?.path).toBe('/r/src/main/java');
  });

  it('reads the parent again when a folder of the row changes', async () => {
    const l = javaTree();
    const { model, calls } = makeModel(l);
    await model.setRoot('/r');
    await model.expand(model.rows[0]);
    calls.length = 0;
    // `src/main` got a second folder. The chain of `src` now ends at `src`.
    l['/r'] = [dir('/r/src', { compact: ['main'] }), dir('/r/docs'), file('/r/a.txt')];
    await model.refresh(['/r/src/main']);
    expect(calls).toEqual(['/r']);
    expect(model.rows[0].path).toBe('/r/src/main');
    expect(model.byPath.has('/r/src/main/java')).toBe(false);
    expect(model.chainIndex.get('/r/src')).toBe(model.rows[0]);
  });

  it('saves the folders inside an expanded row and restores them in a flat tree', async () => {
    const { model } = makeModel(javaTree());
    await model.setRoot('/r');
    await model.expand(model.rows[0]);
    expect(model.expandedPaths()).toEqual(['src', 'src/main', 'src/main/java']);

    // Same state with compact off: every folder is its own row.
    const flat = makeModel({
      '/r': [dir('/r/src'), dir('/r/docs')],
      '/r/src': [dir('/r/src/main')],
      '/r/src/main': [dir('/r/src/main/java')],
      '/r/src/main/java': [file('/r/src/main/java/B.java')],
    });
    await flat.model.setRoot('/r');
    await flat.model.restoreExpanded(['src', 'src/main', 'src/main/java']);
    expect(flat.model.rows.map((r) => r.name)).toEqual(['src', 'main', 'java', 'B.java', 'docs']);
  });

  it('keeps rows without a chain as before', async () => {
    const { model } = makeModel(javaTree());
    await model.setRoot('/r');
    const docs = model.rows.find((r) => r.name === 'docs')!;
    expect(docs.chain).toBeNull();
    expect(docs.path).toBe('/r/docs');
    expect(docs.rel).toBe('docs');
  });
});
