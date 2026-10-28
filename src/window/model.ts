// The list of workspace tabs of one window. Pure logic, no DOM and no Tauri,
// so it is easy to test. The window manager keeps one TabModel per window.

import { basename, dirname } from '../core/util';

export interface WsTab {
  id: string;
  /** Folder of the tab, or null for an empty tab. */
  root: string | null;
}

/** What we save in the global state. `active` is an index into `tabs`. */
export interface SavedTabs {
  tabs: { root: string | null }[];
  active: number;
}

export interface TabLabel {
  name: string;
  /** Parent folder. Only set when another tab has the same name. */
  description: string;
}

export const EMPTY_TAB_NAME = 'New Tab';

export class TabModel {
  private list: WsTab[] = [];
  private activeId = '';

  constructor(private readonly newId: () => string) {}

  get tabs(): readonly WsTab[] {
    return this.list;
  }

  get active(): WsTab | undefined {
    return this.list.find((t) => t.id === this.activeId);
  }

  get(id: string): WsTab | undefined {
    return this.list.find((t) => t.id === id);
  }

  indexOf(id: string): number {
    return this.list.findIndex((t) => t.id === id);
  }

  /** Adds a tab (at the end, or at `index`). The new tab becomes active unless `activate` is false. */
  add(root: string | null, opts: { activate?: boolean; index?: number } = {}): WsTab {
    const tab: WsTab = { id: this.newId(), root };
    const at = opts.index === undefined ? this.list.length : Math.max(0, Math.min(this.list.length, opts.index));
    this.list.splice(at, 0, tab);
    if (opts.activate !== false || !this.activeId) this.activeId = tab.id;
    return tab;
  }

  activate(id: string): boolean {
    if (!this.get(id)) return false;
    this.activeId = id;
    return true;
  }

  setRoot(id: string, root: string | null): void {
    const tab = this.get(id);
    if (tab) tab.root = root;
  }

  /**
   * Removes a tab. When it was the active one, the tab on its right becomes
   * active (or the one on its left when it was the last). Returns the new
   * active tab, or undefined when the list is empty now.
   */
  close(id: string): WsTab | undefined {
    const i = this.indexOf(id);
    if (i < 0) return this.active;
    this.list.splice(i, 1);
    if (this.activeId === id) {
      this.activeId = this.list[Math.min(i, this.list.length - 1)]?.id ?? '';
    }
    return this.active;
  }

  /** Moves a tab to a new index. */
  move(id: string, to: number): void {
    const from = this.indexOf(id);
    if (from < 0) return;
    const [tab] = this.list.splice(from, 1);
    this.list.splice(Math.max(0, Math.min(this.list.length, to)), 0, tab);
  }

  /** The tab at `offset` steps from the active tab (wraps around). */
  neighbor(offset: number): WsTab | undefined {
    const n = this.list.length;
    if (n === 0) return undefined;
    const i = this.indexOf(this.activeId);
    return this.list[(((i < 0 ? 0 : i) + offset) % n + n) % n];
  }

  findByRoot(root: string, same: (a: string, b: string) => boolean): WsTab | undefined {
    return this.list.find((t) => t.root !== null && same(t.root, root));
  }

  snapshot(): SavedTabs {
    return {
      tabs: this.list.map((t) => ({ root: t.root })),
      active: Math.max(0, this.indexOf(this.activeId)),
    };
  }

  /** Replaces the list with saved tabs. Bad data gives one empty tab. */
  restore(saved: unknown): void {
    this.list = [];
    this.activeId = '';
    const s = saved as Partial<SavedTabs> | null | undefined;
    const items = Array.isArray(s?.tabs) ? s.tabs : [];
    for (const item of items) {
      const root = item && typeof item.root === 'string' && item.root ? item.root : null;
      this.add(root, { activate: false });
    }
    if (this.list.length === 0) this.add(null);
    const idx = typeof s?.active === 'number' ? s.active : 0;
    this.activeId = this.list[Math.max(0, Math.min(this.list.length - 1, idx))].id;
  }
}

/** Name and optional description of every tab. Tabs with the same name get their parent folder. */
export function describeTabs(tabs: readonly WsTab[]): Map<string, TabLabel> {
  const names = tabs.map((t) => (t.root ? basename(t.root) : EMPTY_TAB_NAME));
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const out = new Map<string, TabLabel>();
  tabs.forEach((t, i) => {
    const name = names[i];
    const dup = t.root !== null && (count.get(name) ?? 0) > 1;
    out.set(t.id, { name, description: dup && t.root ? basename(dirname(t.root)) : '' });
  });
  return out;
}
