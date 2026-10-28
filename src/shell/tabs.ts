// TabService: the model of the open tabs (the tab bar is in tabbar.ts).
//
// Tab content is created lazily: the first time a tab is shown. A restored
// session with 30 tabs creates only the active one.

import type {
  AppContext,
  Disposable,
  OpenTabOptions,
  SessionTabs,
  Tab,
  TabContent,
  TabInput,
  TabService,
  UiService,
} from '../core/types';
import { basename, dirname } from '../core/util';

export interface TabRec {
  id: string;
  input: TabInput;
  title: string;
  description: string | undefined;
  dirty: boolean;
  preview: boolean;
  content: TabContent | null;
  /** Element that holds the content. It fills the editor area. */
  host: HTMLElement;
  creating: Promise<void> | null;
  removed: boolean;
  closing: Promise<boolean> | null;
}

interface ClosedTab {
  id: string;
  kind: string;
  title: string;
  data: unknown;
}

export type TabChange = 'list' | 'active' | 'state';

export interface TabModel extends TabService {
  /** Tabs in display order, with the internal fields. */
  records(): readonly TabRec[];
  onDidChange(fn: (change: TabChange) => void): void;
  /** Gives the element that holds all tab hosts. Called by mount(). */
  attach(contentRoot: HTMLElement): void;
  closeOthers(id: string): Promise<boolean>;
  closeToRight(id: string): Promise<boolean>;
  /** Closes with the "reopen" memory (the user closed them). */
  closeAllUser(): Promise<boolean>;
  reopenClosed(): Promise<boolean>;
  hasClosed(): boolean;
  /** Moves to the next (1) or previous (-1) tab in most-recently-used order. */
  cycle(dir: 1 | -1): void;
  move(id: string, toIndex: number): void;
  focusActive(): void;
  /** Asks to save each dirty tab. Returns false when the user cancelled. */
  confirmWindowClose(): Promise<boolean>;
  /** Removes the listeners on `window`. Called when the workbench is disposed. */
  dispose(): void;
}

const CLOSED_MAX = 20;

/** Name of the parent folder for tabs that stand for a file. Used to tell equal titles apart. */
export function parentFolderOf(tabId: string): string | undefined {
  const m = /^(?:file|image):(.+)$/.exec(tabId) ?? /^diff:[^:]*:(.+)$/.exec(tabId);
  if (!m) return undefined;
  const dir = dirname(m[1]);
  return dir ? basename(dir) : undefined;
}

/** File path behind a tab id, for "Copy Path". */
export function pathOfTab(tabId: string): string | undefined {
  const m = /^(?:file|image|history):(.+)$/.exec(tabId) ?? /^diff:[^:]*:(.+)$/.exec(tabId);
  return m?.[1];
}

export function createTabModel(ctx: Pick<AppContext, 'bus'>, ui: Pick<UiService, 'confirm' | 'notify'>): TabModel {
  const tabs: TabRec[] = [];
  const byId = new Map<string, TabRec>();
  let mru: string[] = [];
  let active: TabRec | null = null;
  let contentRoot: HTMLElement | null = null;
  const listeners: ((c: TabChange) => void)[] = [];
  const kinds = new Map<string, (data: unknown) => TabInput | null>();
  let closed: ClosedTab[] = [];

  let cycling = false;
  let cycleList: string[] = [];
  let cycleIndex = 0;

  const emit = (c: TabChange) => {
    listeners.forEach((fn) => fn(c));
    // The list, the dirty state, the title and the preview state are saved or shown elsewhere.
    if (c !== 'active') ctx.bus.emit('tabs:changed', {});
  };

  function bumpMru(rec: TabRec) {
    mru = [rec.id, ...mru.filter((id) => id !== rec.id)];
  }

  /** Focus the content when nothing else (sidebar, panel, dialog) has the focus. */
  function canAutoFocus(): boolean {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return true;
    return !!contentRoot?.parentElement?.contains(ae);
  }

  function isDirty(rec: TabRec): boolean {
    return rec.dirty || rec.content?.isDirty?.() === true;
  }

  function startCreate(rec: TabRec, wantFocus: boolean) {
    rec.creating = (async () => {
      try {
        const content = await rec.input.create(rec.host);
        if (rec.removed) {
          content.dispose();
          return;
        }
        rec.content = content;
        if (active === rec) {
          content.onShow?.();
          if (wantFocus) content.focus();
        }
      } catch (err) {
        console.error(`tab ${rec.id} failed to open`, err);
        const box = document.createElement('div');
        box.className = 'shell-tab-error';
        box.textContent = `Could not open "${rec.title}": ${err instanceof Error ? err.message : String(err)}`;
        rec.host.replaceChildren(box);
        ui.notify(`Could not open ${rec.title}: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      }
    })();
  }

  function activateTab(rec: TabRec, opts: { focus?: boolean } = {}) {
    if (active === rec) {
      if (opts.focus) rec.content?.focus();
      return;
    }
    const prev = active;
    if (prev) {
      prev.content?.onHide?.();
      prev.host.hidden = true;
    }
    active = rec;
    if (!cycling) bumpMru(rec);
    rec.host.hidden = false;
    const wantFocus = opts.focus ?? canAutoFocus();
    if (!rec.content && !rec.creating) {
      startCreate(rec, wantFocus);
    } else if (rec.content) {
      rec.content.onShow?.();
      if (wantFocus) rec.content.focus();
    }
    emit('active');
    ctx.bus.emit('tab:activated', { tabId: rec.id });
  }

  function removeTab(rec: TabRec, o: { record: boolean; activateNext: boolean }) {
    const i = tabs.indexOf(rec);
    if (i < 0) return;
    if (cycling) endCycle(false);
    const wasActive = active === rec;
    if (o.record) pushClosed(rec);
    rec.removed = true;
    tabs.splice(i, 1);
    byId.delete(rec.id);
    mru = mru.filter((id) => id !== rec.id);
    if (wasActive) {
      active = null;
      try {
        rec.content?.onHide?.();
      } catch (e) {
        console.error(e);
      }
    }
    try {
      rec.content?.dispose();
    } catch (e) {
      console.error(e);
    }
    rec.host.remove();
    if (wasActive) {
      const next = o.activateNext ? byId.get(mru[0]) : undefined;
      if (next) activateTab(next);
      else if (o.activateNext) ctx.bus.emit('tab:activated', { tabId: null });
    }
    emit('list');
  }

  function pushClosed(rec: TabRec) {
    let data: unknown;
    try {
      data = rec.input.serialize?.();
    } catch {
      return;
    }
    if (data == null) return;
    closed = [...closed.filter((c) => c.id !== rec.id), { id: rec.id, kind: rec.input.kind, title: rec.title, data }].slice(-CLOSED_MAX);
  }

  async function askSave(rec: TabRec): Promise<boolean> {
    const canSave = !!rec.content?.save;
    const buttons = canSave ? ['Save', "Don't Save", 'Cancel'] : ["Don't Save", 'Cancel'];
    const choice = await ui.confirm({
      title: `Do you want to save the changes to ${rec.title}?`,
      message: "Your changes will be lost if you don't save them.",
      buttons,
    });
    if (choice === 'Save') return (await rec.content?.save?.()) === true;
    return choice === "Don't Save";
  }

  function closeOne(rec: TabRec, force: boolean, record: boolean): Promise<boolean> {
    if (rec.removed) return Promise.resolve(true);
    if (rec.closing) return rec.closing;
    const p = (async () => {
      if (!force) {
        if (rec.content?.confirmClose) {
          if (!(await rec.content.confirmClose())) return false;
        } else if (isDirty(rec) && !(await askSave(rec))) {
          return false;
        }
      }
      if (!rec.removed) removeTab(rec, { record, activateNext: true });
      return true;
    })();
    rec.closing = p;
    void p.finally(() => {
      rec.closing = null;
    });
    return p;
  }

  async function closeMany(list: TabRec[], force: boolean, record: boolean): Promise<boolean> {
    // The active tab goes last, so the shell does not wake up other tabs on the way.
    const ordered = [...list].sort((a, b) => Number(a === active) - Number(b === active));
    for (const rec of ordered) {
      if (!(await closeOne(rec, force, record))) return false;
    }
    return true;
  }

  function endCycle(focus: boolean) {
    if (!cycling) return;
    cycling = false;
    if (active) bumpMru(active);
    if (focus) active?.content?.focus();
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control') endCycle(true);
  };
  const onBlur = () => endCycle(false);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  ctx.bus.on('workspace:will-change', () => {
    closed = [];
  });

  const service: TabModel = {
    dispose() {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      // Dispose the content of every open tab. No questions: the workbench is closing.
      for (const rec of tabs) {
        rec.removed = true;
        try {
          rec.content?.dispose();
        } catch (e) {
          console.error(e);
        }
        rec.content = null;
      }
    },
    records: () => tabs,
    onDidChange: (fn) => void listeners.push(fn),

    attach(root) {
      contentRoot = root;
      for (const rec of tabs) root.append(rec.host);
    },

    open(input, opts: OpenTabOptions = {}) {
      const existing = byId.get(input.id);
      if (existing) {
        if (!opts.preview && existing.preview) {
          existing.preview = false;
          emit('state');
        }
        if (opts.activate !== false) activateTab(existing);
        return existing as Tab;
      }

      const activate = opts.activate !== false;
      const host = document.createElement('div');
      host.className = 'shell-tab-host';
      host.hidden = true;
      const rec: TabRec = {
        id: input.id,
        input,
        title: input.title,
        description: input.description,
        dirty: false,
        preview: !!opts.preview,
        content: null,
        host,
        creating: null,
        removed: false,
        closing: null,
      };

      let index = tabs.length;
      let replacedActive = false;
      if (rec.preview) {
        const old = tabs.find((t) => t.preview && !isDirty(t));
        if (old) {
          index = tabs.indexOf(old);
          replacedActive = old === active;
          removeTab(old, { record: false, activateNext: false });
        }
      } else if (activate && active) {
        index = tabs.indexOf(active) + 1;
      }
      tabs.splice(index, 0, rec);
      byId.set(rec.id, rec);
      if (!activate) mru.push(rec.id);
      contentRoot?.append(host);
      emit('list');
      if (activate || replacedActive) activateTab(rec);
      return rec as Tab;
    },

    get: (id) => byId.get(id) as Tab | undefined,
    list: () => [...tabs] as Tab[],
    active: () => active as Tab | null,

    activate(id) {
      const rec = byId.get(id);
      if (rec) activateTab(rec);
    },

    close: (id, opts) => {
      const rec = byId.get(id);
      return rec ? closeOne(rec, !!opts?.force, true) : Promise.resolve(true);
    },

    closeAll: (opts) => closeMany([...tabs], !!opts?.force, false),
    closeAllUser: () => closeMany([...tabs], false, true),
    closeOthers: (id) => closeMany(tabs.filter((t) => t.id !== id), false, true),
    closeToRight(id) {
      const i = tabs.findIndex((t) => t.id === id);
      return closeMany(i < 0 ? [] : tabs.slice(i + 1), false, true);
    },

    setDirty(id, dirty) {
      const rec = byId.get(id);
      if (!rec || rec.dirty === dirty) return;
      rec.dirty = dirty;
      if (dirty) rec.preview = false;
      emit('state');
    },

    setTitle(id, title, description) {
      const rec = byId.get(id);
      if (!rec) return;
      rec.title = title;
      if (description !== undefined) rec.description = description;
      emit('state');
    },

    pin(id) {
      const rec = byId.get(id);
      if (!rec?.preview) return;
      rec.preview = false;
      emit('state');
    },

    registerKind(kind, restore) {
      kinds.set(kind, restore);
      return {
        dispose() {
          if (kinds.get(kind) === restore) kinds.delete(kind);
        },
      } satisfies Disposable;
    },

    snapshot(): SessionTabs {
      const out: SessionTabs['tabs'] = [];
      let activeId: string | null = null;
      for (const rec of tabs) {
        let data: unknown = null;
        try {
          data = rec.input.serialize?.() ?? null;
        } catch (e) {
          console.error(`serialize of ${rec.id} failed`, e);
        }
        if (data == null) continue;
        out.push({ id: rec.id, kind: rec.input.kind, title: rec.title, data });
        if (rec === active) activeId = rec.id;
      }
      return { tabs: out, activeId };
    },

    async restore(session) {
      let target: TabRec | undefined;
      for (const t of session.tabs) {
        let input: TabInput | null = null;
        try {
          input = kinds.get(t.kind)?.(t.data) ?? null;
        } catch (e) {
          console.error(`restore of ${t.id} failed`, e);
        }
        if (!input) continue;
        const rec = service.open(input, { activate: false }) as unknown as TabRec;
        if (t.id === session.activeId || input.id === session.activeId) target = rec;
      }
      if (!active) {
        const rec = target ?? tabs[0];
        if (rec) activateTab(rec);
      }
      await active?.creating;
    },

    async reopenClosed() {
      while (closed.length) {
        const c = closed.pop()!;
        if (byId.has(c.id)) continue;
        let input: TabInput | null = null;
        try {
          input = kinds.get(c.kind)?.(c.data) ?? null;
        } catch (e) {
          console.error(e);
        }
        if (!input) continue;
        service.open(input);
        return true;
      }
      return false;
    },
    hasClosed: () => closed.length > 0,

    cycle(dir) {
      if (tabs.length < 2) return;
      if (!cycling) {
        cycling = true;
        cycleList = mru.filter((id) => byId.has(id));
        cycleIndex = 0;
      }
      const n = cycleList.length;
      for (let step = 0; step < n; step++) {
        cycleIndex = (cycleIndex + dir + n) % n;
        const rec = byId.get(cycleList[cycleIndex]);
        if (rec) {
          activateTab(rec, { focus: false });
          break;
        }
      }
    },

    move(id, toIndex) {
      const from = tabs.findIndex((t) => t.id === id);
      if (from < 0) return;
      const [rec] = tabs.splice(from, 1);
      tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, rec);
      emit('list');
    },

    focusActive() {
      active?.content?.focus();
    },

    async confirmWindowClose() {
      for (const rec of tabs.filter(isDirty)) {
        activateTab(rec, { focus: false });
        if (!(await askSave(rec))) return false;
      }
      return true;
    },
  };
  return service;
}
