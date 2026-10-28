// Layout state: sizes and visibility of the sidebar and the bottom panel.
// It is saved in globalState under `shell.layout`.

import type { StateStore } from '../core/types';

export interface LayoutState {
  sidebarWidth: number;
  panelHeight: number;
  sidebarVisible: boolean;
  panelVisible: boolean;
  sidebarView: string | null;
  panelView: string | null;
}

export const LAYOUT_KEY = 'shell.layout';
export const SIDEBAR_DEFAULT = 260;
export const PANEL_DEFAULT = 220;

export function defaultLayout(): LayoutState {
  return {
    sidebarWidth: SIDEBAR_DEFAULT,
    panelHeight: PANEL_DEFAULT,
    sidebarVisible: true,
    panelVisible: false,
    sidebarView: null,
    panelView: null,
  };
}

/** Takes unknown saved data and returns a valid state (bad values fall back to defaults). */
export function sanitizeLayout(raw: unknown): LayoutState {
  const out = defaultLayout();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  out.sidebarWidth = num(r.sidebarWidth, 120, 1200, out.sidebarWidth);
  out.panelHeight = num(r.panelHeight, 60, 1200, out.panelHeight);
  if (typeof r.sidebarVisible === 'boolean') out.sidebarVisible = r.sidebarVisible;
  if (typeof r.panelVisible === 'boolean') out.panelVisible = r.panelVisible;
  if (typeof r.sidebarView === 'string') out.sidebarView = r.sidebarView;
  if (typeof r.panelView === 'string') out.panelView = r.panelView;
  return out;
}

export interface LayoutStore {
  readonly state: LayoutState;
  /** True when saved data was found and applied. */
  readonly loaded: boolean;
  /** Reads the saved state. Returns true when something was saved. */
  load(): boolean;
  patch(p: Partial<LayoutState>): void;
  onChange(fn: () => void): void;
}

export function createLayoutStore(getStore: () => StateStore | undefined): LayoutStore {
  const listeners: (() => void)[] = [];
  const store: LayoutStore & { state: LayoutState; loaded: boolean } = {
    state: defaultLayout(),
    loaded: false,
    load() {
      const saved = getStore()?.get<unknown>(LAYOUT_KEY);
      if (saved === undefined) return false;
      store.state = sanitizeLayout(saved);
      store.loaded = true;
      listeners.forEach((fn) => fn());
      return true;
    },
    patch(p) {
      store.state = { ...store.state, ...p };
      getStore()?.set(LAYOUT_KEY, store.state);
      listeners.forEach((fn) => fn());
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
  return store;
}
