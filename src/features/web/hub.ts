// State of the web feature for one workbench (never at module level).
//
// The hub knows which web tabs exist, what titles we saw, and whether the
// native web views may be visible now. A native web view is drawn above the
// page, so it must hide when a popup is open, when the workbench is in the
// background, and when the window is minimized.

import type { AppContext, Disposable, TabInput } from '../../core/types';
import { debounce } from '../../core/util';
import { webSupported } from '../../ipc/web';
import { OVERLAY_EVENT } from '../../shell/overlay-count';
import { shouldShow, type ShowState } from './bounds';
import { addBookmark, bookmarkTitle, hostOf, normalizeUrl, removeBookmark, sameUrl } from './url';

export const WEB_TAB_PREFIX = 'web:';
const TITLES_KEY = 'web.titles';
/** After a popup closed, wait a moment before the web view shows again (a new popup may open at once). */
const SHOW_DELAY_MS = 40;

/** What a web tab saves for the next session. */
export interface WebTabState {
  /** Number in the tab id (`web:<n>`). */
  n: number;
  url: string;
  /** Last page title. */
  title?: string;
  /** Address that the tab was opened from (a bookmark). Used to find the tab again. */
  origin?: string;
  /** Page zoom, 1 = 100%. */
  zoom?: number;
}

/** What the commands can ask from the content of a web tab. */
export interface WebHandle {
  reload(): void;
  back(): void;
  forward(): void;
  currentUrl(): string;
}

export interface TabMeta {
  url: string;
  origin?: string;
}

export class WebHub {
  /** Live content of web tabs by tab id. */
  readonly contents = new Map<string, { snapshot(): WebTabState }>();
  /** Address of each web tab, also for tabs that are not created yet. */
  readonly meta = new Map<string, TabMeta>();
  titles: Record<string, string> = {};

  private seq = 0;
  private active: boolean;
  private layerOverlay = false;
  private windowOverlay = false;
  private windowHidden = false;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private visibilityListeners = new Set<() => void>();
  private changeListeners = new Set<() => void>();
  private cleanups: (() => void)[] = [];
  private subs: Disposable[] = [];
  private disposed = false;
  private closers = new Set<() => void>();

  constructor(private readonly ctx: AppContext) {
    this.active = ctx.window.isActive();
    const saved = ctx.workspace.globalState.get<Record<string, string>>(TITLES_KEY);
    if (saved && typeof saved === 'object') this.titles = { ...saved };

    const bus = ctx.bus;
    this.subs.push(
      bus.on('workbench:activated', () => {
        this.active = true;
        this.layerOverlay = false;
        this.visibilityChanged();
      }),
      bus.on('workbench:deactivated', () => {
        this.active = false;
        this.layerOverlay = false;
        this.visibilityChanged();
      }),
      bus.on('overlay:changed', (e) => this.setLayerOverlay(e.open)),
      bus.on('tabs:changed', () => this.pruneMeta()),
      bus.on('settings:changed', (e) => {
        if (e.settings['web.bookmarks'] !== e.previous['web.bookmarks']) this.changed();
      }),
      bus.on('workbench:disposing', () => this.dispose()),
    );

    // Popups of this workbench and of the workspace strip tell us with a DOM event
    // (src/shell/overlay-count.ts). We send `overlay:changed` on the bus for the
    // popups of this workbench, so other features can use it too.
    const onOverlay = (e: Event) => {
      const open = (e as CustomEvent<{ open?: boolean }>).detail?.open === true;
      if (e.target === document) {
        this.windowOverlay = open;
        this.visibilityChanged();
      } else if (this.ctx.window.isActive()) {
        this.ctx.bus.emit('overlay:changed', { open });
      }
    };
    document.addEventListener(OVERLAY_EVENT, onOverlay);
    this.cleanups.push(() => document.removeEventListener(OVERLAY_EVENT, onOverlay));

    this.watchWindow();
  }

  // ---- Visibility -------------------------------------------------------------------------

  /** The conditions that do not depend on one tab. */
  state(): Omit<ShowState, 'tabShown'> {
    return {
      workbenchActive: this.active,
      windowHidden: this.windowHidden,
      overlayOpen: this.layerOverlay || this.windowOverlay,
    };
  }

  canShow(): boolean {
    return shouldShow({ tabShown: true, ...this.state() });
  }

  /** Tabs call this to learn when to hide or show their web view. */
  onVisibility(fn: () => void): Disposable {
    this.visibilityListeners.add(fn);
    return { dispose: () => this.visibilityListeners.delete(fn) };
  }

  private setLayerOverlay(open: boolean) {
    if (this.layerOverlay === open) return;
    this.layerOverlay = open;
    this.visibilityChanged();
  }

  private visibilityChanged() {
    clearTimeout(this.showTimer);
    // Hide at once. Show after a short wait, so a popup that is replaced does not flicker.
    if (this.canShow()) {
      this.showTimer = setTimeout(() => this.fire(), SHOW_DELAY_MS);
    } else {
      this.fire();
    }
  }

  private fire() {
    for (const fn of [...this.visibilityListeners]) fn();
  }

  /** Follows minimize and hide of the window. */
  private watchWindow() {
    const check = debounce(() => {
      void (async () => {
        let minimized = false;
        if (webSupported()) {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            minimized = await getCurrentWindow().isMinimized();
          } catch {
            minimized = false;
          }
        }
        const hidden = minimized || document.visibilityState === 'hidden';
        if (hidden !== this.windowHidden) {
          this.windowHidden = hidden;
          this.visibilityChanged();
        }
      })();
    }, 50);
    document.addEventListener('visibilitychange', check);
    this.cleanups.push(() => {
      document.removeEventListener('visibilitychange', check);
      check.cancel();
    });
    if (!webSupported()) return;
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const offs = await Promise.all([win.onResized(check), win.onFocusChanged(check)]);
        if (this.disposed) offs.forEach((off) => off());
        else this.cleanups.push(...offs);
      })
      .catch((err) => console.error('web: window events failed', err));
  }

  // ---- Tabs ---------------------------------------------------------------------------

  /** A new tab number that no open tab uses. */
  nextN(): number {
    do this.seq++;
    while (this.ctx.tabs.get(`${WEB_TAB_PREFIX}${this.seq}`));
    return this.seq;
  }

  /** Called when a tab is restored, so new tabs do not reuse its number. */
  seen(n: number) {
    if (n > this.seq) this.seq = n;
  }

  tabInput(state: WebTabState): TabInput {
    const id = `${WEB_TAB_PREFIX}${state.n}`;
    this.meta.set(id, { url: state.url, origin: state.origin });
    const ctx = this.ctx;
    return {
      id,
      kind: 'web',
      title: state.title || bookmarkTitle(state.origin ?? state.url, this.titles),
      description: hostOf(state.url),
      tooltip: state.url,
      create: async (host) => {
        const { createWebTab } = await import('./tab');
        return createWebTab(ctx, this, host, id, state);
      },
      serialize: () => this.contents.get(id)?.snapshot() ?? state,
    };
  }

  /** Opens an address in a new web tab. `origin` is the bookmark that it comes from. */
  openUrl(url: string, origin?: string) {
    const n = this.nextN();
    this.ctx.tabs.open(this.tabInput({ n, url, origin }));
    this.changed();
  }

  /** Activates the tab of this bookmark, or opens a new one. */
  openBookmark(url: string) {
    for (const [id, m] of this.meta) {
      if (m.origin && sameUrl(m.origin, url) && this.ctx.tabs.get(id)) {
        this.ctx.tabs.activate(id);
        return;
      }
    }
    this.openUrl(url, url);
  }

  /** Content of the active tab when it is a web tab. */
  activeHandle(): WebHandle | null {
    const tab = this.ctx.tabs.active();
    if (!tab || !tab.id.startsWith(WEB_TAB_PREFIX)) return null;
    return (tab.content as unknown as WebHandle | null) ?? null;
  }

  /** Address of the active web tab, also when its content is not created yet. */
  activeUrl(): string | null {
    const tab = this.ctx.tabs.active();
    if (!tab || !tab.id.startsWith(WEB_TAB_PREFIX)) return null;
    return this.meta.get(tab.id)?.url ?? null;
  }

  webTabs(): { id: string; title: string; url: string }[] {
    return this.ctx.tabs
      .list()
      .filter((t) => t.id.startsWith(WEB_TAB_PREFIX))
      .map((t) => ({ id: t.id, title: t.title, url: this.meta.get(t.id)?.url ?? '' }));
  }

  private pruneMeta() {
    for (const id of [...this.meta.keys()]) {
      if (!this.ctx.tabs.get(id)) this.meta.delete(id);
    }
    this.changed();
  }

  // ---- Titles and bookmarks ----------------------------------------------------------------

  /** Saves the title for the addresses, so the bookmark list can show it. */
  rememberTitle(urls: (string | undefined)[], title: string) {
    const clean = title.trim();
    if (!clean) return;
    let touched = false;
    for (const u of urls) {
      if (u && this.titles[u] !== clean) {
        this.titles[u] = clean;
        touched = true;
      }
    }
    if (!touched) return;
    // Keep the list small: only titles of current bookmarks and the 100 newest others.
    const keys = Object.keys(this.titles);
    if (keys.length > 300) {
      const keep = new Set(this.ctx.settings.get('web.bookmarks'));
      for (const k of keys.slice(0, keys.length - 200)) if (!keep.has(k)) delete this.titles[k];
    }
    this.ctx.workspace.globalState.set(TITLES_KEY, this.titles);
    this.changed();
  }

  bookmarks(): string[] {
    const list = this.ctx.settings.get('web.bookmarks');
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  }

  /** Adds a bookmark. Returns false when the address is not valid or exists already. */
  async addBookmark(url: string): Promise<boolean> {
    const clean = normalizeUrl(url);
    if (!clean) return false;
    const before = this.bookmarks();
    const next = addBookmark(before, clean);
    if (next.length === before.length) return false;
    await this.ctx.settings.update({ 'web.bookmarks': next });
    return true;
  }

  async removeBookmark(url: string): Promise<void> {
    await this.ctx.settings.update({ 'web.bookmarks': removeBookmark(this.bookmarks(), url) });
  }

  // ---- Change notices for the sidebar ------------------------------------------------------

  onChange(fn: () => void): Disposable {
    this.changeListeners.add(fn);
    return { dispose: () => this.changeListeners.delete(fn) };
  }

  changed() {
    for (const fn of [...this.changeListeners]) fn();
  }

  // ---- End of life -------------------------------------------------------------------------

  /** Tab contents register a function that closes their native view. */
  registerCloser(fn: () => void): Disposable {
    this.closers.add(fn);
    return { dispose: () => this.closers.delete(fn) };
  }

  /** The workbench closes for good. Close every web view and remove every listener. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.showTimer);
    for (const close of [...this.closers]) close();
    this.closers.clear();
    for (const s of this.subs) s.dispose();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.visibilityListeners.clear();
    this.changeListeners.clear();
  }
}
