import { describe, expect, it } from 'vitest';
import { createLayoutStore, defaultLayout, sanitizeLayout } from './layout-state';

describe('sanitizeLayout', () => {
  it('returns defaults for bad input', () => {
    expect(sanitizeLayout(null)).toEqual(defaultLayout());
    expect(sanitizeLayout('x')).toEqual(defaultLayout());
    expect(sanitizeLayout({ sidebarWidth: 'wide', panelVisible: 3 })).toEqual(defaultLayout());
  });

  it('keeps good values and clamps sizes', () => {
    const s = sanitizeLayout({ sidebarWidth: 300, panelHeight: 99999, panelVisible: true, sidebarView: 'git' });
    expect(s.sidebarWidth).toBe(300);
    expect(s.panelHeight).toBe(1200);
    expect(s.panelVisible).toBe(true);
    expect(s.sidebarView).toBe('git');
  });
});

describe('createLayoutStore', () => {
  function memory() {
    const data = new Map<string, unknown>();
    return { data, store: { get: <T>(k: string) => data.get(k) as T | undefined, set: (k: string, v: unknown) => void data.set(k, v) } };
  }

  it('saves on patch and notifies', () => {
    const m = memory();
    const s = createLayoutStore(() => m.store);
    let calls = 0;
    s.onChange(() => calls++);
    s.patch({ sidebarVisible: false });
    expect(calls).toBe(1);
    expect((m.data.get('shell.layout') as { sidebarVisible: boolean }).sidebarVisible).toBe(false);
  });

  it('loads saved state', () => {
    const m = memory();
    m.data.set('shell.layout', { sidebarWidth: 333 });
    const s = createLayoutStore(() => m.store);
    expect(s.load()).toBe(true);
    expect(s.state.sidebarWidth).toBe(333);
  });

  it('works while the workspace does not exist yet', () => {
    const s = createLayoutStore(() => undefined);
    expect(s.load()).toBe(false);
    s.patch({ panelVisible: true });
    expect(s.state.panelVisible).toBe(true);
  });
});
