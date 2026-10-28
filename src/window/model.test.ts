import { describe, expect, it } from 'vitest';
import { describeTabs, TabModel } from './model';

function make() {
  let n = 0;
  return new TabModel(() => `t${++n}`);
}

describe('TabModel', () => {
  it('adds and activates', () => {
    const m = make();
    const a = m.add('/a');
    const b = m.add('/b');
    expect(m.active?.id).toBe(b.id);
    m.activate(a.id);
    expect(m.active?.id).toBe(a.id);
    const c = m.add('/c', { activate: false });
    expect(m.active?.id).toBe(a.id);
    expect(m.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  it('first tab is active even with activate false', () => {
    const m = make();
    const a = m.add('/a', { activate: false });
    expect(m.active?.id).toBe(a.id);
  });

  it('closes the active tab and picks the right neighbor, then the left one', () => {
    const m = make();
    const [a, b, c] = [m.add('/a'), m.add('/b'), m.add('/c')];
    m.activate(b.id);
    expect(m.close(b.id)?.id).toBe(c.id);
    expect(m.close(c.id)?.id).toBe(a.id);
    expect(m.close(a.id)).toBeUndefined();
    expect(m.tabs.length).toBe(0);
  });

  it('closing an inactive tab keeps the active one', () => {
    const m = make();
    const [a, b] = [m.add('/a'), m.add('/b')];
    m.activate(b.id);
    m.close(a.id);
    expect(m.active?.id).toBe(b.id);
  });

  it('reorders', () => {
    const m = make();
    const [a, b, c] = [m.add('/a'), m.add('/b'), m.add('/c')];
    m.move(a.id, 2);
    expect(m.tabs.map((t) => t.id)).toEqual([b.id, c.id, a.id]);
    m.move(a.id, 0);
    expect(m.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    m.move(c.id, 99);
    expect(m.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  it('wraps in neighbor()', () => {
    const m = make();
    const [a, , c] = [m.add('/a'), m.add('/b'), m.add('/c')];
    expect(m.neighbor(1)?.id).toBe(a.id);
    expect(m.neighbor(-1)?.id).not.toBe(c.id);
    m.activate(a.id);
    expect(m.neighbor(-1)?.id).toBe(c.id);
  });

  it('finds by root', () => {
    const m = make();
    m.add('/a');
    const b = m.add('/b/');
    m.add(null);
    expect(m.findByRoot('/b', (x, y) => x.replace(/\/+$/, '') === y.replace(/\/+$/, ''))?.id).toBe(b.id);
    expect(m.findByRoot('/zzz', () => false)).toBeUndefined();
  });

  it('saves and restores', () => {
    const m = make();
    m.add('/a');
    const b = m.add(null);
    m.add('/c', { activate: false });
    m.activate(b.id);
    const saved = m.snapshot();
    expect(saved).toEqual({ tabs: [{ root: '/a' }, { root: null }, { root: '/c' }], active: 1 });
    const r = make();
    r.restore(JSON.parse(JSON.stringify(saved)));
    expect(r.tabs.map((t) => t.root)).toEqual(['/a', null, '/c']);
    expect(r.active?.root).toBeNull();
    expect(r.indexOf(r.active!.id)).toBe(1);
  });

  it('restores bad data as one empty tab', () => {
    for (const bad of [undefined, null, 5, {}, { tabs: [] }, { tabs: 'x' }]) {
      const m = make();
      m.restore(bad);
      expect(m.tabs.length).toBe(1);
      expect(m.active?.root).toBeNull();
    }
  });

  it('clamps a bad active index and drops bad roots', () => {
    const m = make();
    m.restore({ tabs: [{ root: '/a' }, { root: 7 }, null], active: 50 });
    expect(m.tabs.map((t) => t.root)).toEqual(['/a', null, null]);
    expect(m.indexOf(m.active!.id)).toBe(2);
  });
});

describe('describeTabs', () => {
  it('uses the folder name, and the parent only for duplicates', () => {
    const m = make();
    const a = m.add('/work/app');
    const b = m.add('/play/app');
    const c = m.add('/work/lib');
    const d = m.add(null);
    const labels = describeTabs(m.tabs);
    expect(labels.get(a.id)).toEqual({ name: 'app', description: 'work' });
    expect(labels.get(b.id)).toEqual({ name: 'app', description: 'play' });
    expect(labels.get(c.id)).toEqual({ name: 'lib', description: '' });
    expect(labels.get(d.id)).toEqual({ name: 'New Tab', description: '' });
  });

  it('handles Windows paths', () => {
    const m = make();
    const a = m.add('C:\\x\\app');
    m.add('D:\\y\\app');
    expect(describeTabs(m.tabs).get(a.id)).toEqual({ name: 'app', description: 'x' });
  });

  it('does not mark two empty tabs as duplicates', () => {
    const m = make();
    const a = m.add(null);
    m.add(null);
    expect(describeTabs(m.tabs).get(a.id)?.description).toBe('');
  });
});
