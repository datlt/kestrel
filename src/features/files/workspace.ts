// WorkspaceService: open folder, per-folder sessions, global state, window title.

import type { AppContext, RecentFolder, SessionTabs, WorkspaceService } from '../../core/types';
import { debounce, isInside, samePath } from '../../core/util';
import {
  wsClose,
  wsGlobalLoad,
  wsGlobalPatch,
  wsNewWindow,
  wsOpen,
  wsRecentList,
  wsSessionLoad,
  wsSessionSave,
} from '../../ipc/fs';
import { createStore } from './state';

const GLOBAL_CACHE_KEY = 'kestrel.globalState';
const SESSION_VERSION = 1;
const SESSION_DELAY_MS = 1000;
const GLOBAL_DELAY_MS = 400;

interface SavedSession {
  version?: number;
  tabs?: SessionTabs | null;
  state?: Record<string, unknown>;
}

const EMPTY_TABS: SessionTabs = { tabs: [], activeId: null };

let globalReady: Promise<void> = Promise.resolve();

/** Resolves when the global state of the newest workbench is read from disk. The window manager may await it before it mounts the shell. */
export function whenStateReady(): Promise<void> {
  return globalReady;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createWorkspaceService(ctx: AppContext): WorkspaceService {
  let root: string | null = null;
  let name: string | null = null;
  // True while the folder changes. Tab events in that time must not overwrite a session.
  let switching = false;
  let queue: Promise<unknown> = Promise.resolve();

  // --- Global state --------------------------------------------------------
  // Start with a copy in localStorage, because the shell reads values before the
  // file is loaded. The file replaces the copy as soon as it arrives.
  const flushGlobal = debounce(() => void saveGlobal(), GLOBAL_DELAY_MS);
  const globalState = createStore(() => {
    mirrorGlobal();
    flushGlobal();
  });
  try {
    const cached = localStorage.getItem(GLOBAL_CACHE_KEY);
    if (cached) globalState.replace(JSON.parse(cached));
  } catch {
    // A broken cache is ignored.
  }
  const myGlobalReady = wsGlobalLoad()
    .then((fromDisk) => {
      const pending = globalState.takeDirty();
      const merged = { ...fromDisk };
      for (const [k, v] of Object.entries(pending)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      globalState.replace(merged);
      // Keys changed before the load finished still have to be saved.
      if (Object.keys(pending).length) void wsGlobalPatch(pending).catch(() => {});
      mirrorGlobal();
    })
    .catch((e) => console.warn('cannot load global state', e));
  globalReady = myGlobalReady;

  function mirrorGlobal() {
    try {
      localStorage.setItem(GLOBAL_CACHE_KEY, JSON.stringify(globalState.snapshot()));
    } catch {
      // The cache is optional.
    }
  }

  async function saveGlobal() {
    const patch = globalState.takeDirty();
    if (!Object.keys(patch).length) return;
    try {
      await wsGlobalPatch(patch);
    } catch (e) {
      ctx.ui.notify(`Cannot save app state: ${message(e)}`, { kind: 'warn' });
    }
  }

  // --- Per-folder state and session -----------------------------------------
  const scheduleSession = debounce(() => void saveSessionNow(), SESSION_DELAY_MS);
  const state = createStore(() => {
    if (root && !switching) scheduleSession();
  });

  async function saveSessionNow() {
    scheduleSession.cancel();
    if (!switching) await writeSession();
  }

  async function writeSession() {
    if (!root) return;
    const session: SavedSession = { version: SESSION_VERSION, tabs: ctx.tabs.snapshot(), state: state.snapshot() };
    try {
      await wsSessionSave(root, session);
    } catch (e) {
      ctx.ui.notify(`Cannot save the session: ${message(e)}`, { kind: 'warn' });
    }
  }

  for (const type of ['tab:activated', 'tabs:changed', 'file:opened', 'file:closed'] as const) {
    ctx.bus.on(type, () => {
      if (root && !switching) scheduleSession();
    });
  }

  // --- Window title ---------------------------------------------------------
  function updateTitle() {
    const tab = ctx.tabs?.active();
    const parts = [tab?.title, name, 'Kestrel'].filter(Boolean);
    ctx.window.setTitle(parts.join(' - '));
  }
  ctx.bus.on('tab:activated', updateTitle);
  ctx.bus.on('workspace:changed', updateTitle);

  // --- Opening and closing --------------------------------------------------
  async function restoreTabs(session: SavedSession | null) {
    const tabs = session?.tabs;
    try {
      await ctx.tabs.restore(tabs && Array.isArray(tabs.tabs) ? tabs : EMPTY_TABS);
    } catch (e) {
      ctx.ui.notify(`Cannot restore the open files: ${message(e)}`, { kind: 'warn' });
    }
  }

  async function doOpen(target: string) {
    if (root && samePath(root, target)) return;
    const from = root;
    switching = true;
    scheduleSession.cancel();
    try {
      if (from) await writeSession();
      if (!(await ctx.tabs.closeAll())) {
        // The user cancelled. If tabs were closed already, put them back.
        if (from) await restoreTabs((await wsSessionLoad(from).catch(() => null)) as SavedSession | null);
        return;
      }
      // Sent only after all tabs closed, so a cancel does not stop language servers or other per-folder work.
      ctx.bus.emit('workspace:will-change', { from, to: target });
      let opened;
      try {
        // A window can have several roots. Adding the new root first keeps the old one if this fails.
        opened = await wsOpen(target);
        if (from) await wsClose(from).catch(() => {});
      } catch (e) {
        ctx.ui.notify(`Cannot open folder: ${message(e)}`, { kind: 'error' });
        if (from) await restoreTabs((await wsSessionLoad(from).catch(() => null)) as SavedSession | null);
        return;
      }
      const session = ((await wsSessionLoad(opened.root).catch(() => null)) as SavedSession | null) ?? null;
      state.replace(session?.state && typeof session.state === 'object' ? session.state : {});
      root = opened.root;
      name = opened.name;
      ctx.bus.emit('workspace:changed', { root });
      await restoreTabs(session);
    } finally {
      switching = false;
    }
  }

  async function doClose() {
    if (!root) return;
    const from = root;
    switching = true;
    scheduleSession.cancel();
    try {
      await writeSession();
      if (!(await ctx.tabs.closeAll())) {
        await restoreTabs((await wsSessionLoad(from).catch(() => null)) as SavedSession | null);
        return;
      }
      ctx.bus.emit('workspace:will-change', { from, to: null });
      await wsClose(from).catch(() => {});
      root = null;
      name = null;
      state.replace({});
      ctx.bus.emit('workspace:changed', { root: null });
    } finally {
      switching = false;
    }
  }

  // Folder changes run one after the other.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const service: WorkspaceService = {
    get root() {
      return root;
    },
    get name() {
      return name;
    },
    async open(target, opts) {
      if (opts?.newWindow) {
        try {
          await wsNewWindow(target);
        } catch (e) {
          ctx.ui.notify(`Cannot open a new window: ${message(e)}`, { kind: 'error' });
        }
        return;
      }
      await serial(() => doOpen(target));
    },
    close: () => serial(doClose),
    async pickAndOpen(opts) {
      // The dialog plugin loads only when the user opens the picker.
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const picked = await openDialog({ directory: true, multiple: false, title: 'Open Folder' });
      if (typeof picked === 'string') await service.open(picked, opts);
    },
    async recent(): Promise<RecentFolder[]> {
      try {
        return await wsRecentList();
      } catch {
        return [];
      }
    },
    relative(path) {
      if (!root || !isInside(path, root)) return path;
      const p = path.replace(/\\/g, '/');
      const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
      return p.length <= r.length ? '' : p.slice(r.length + 1);
    },
    state,
    globalState,
    async saveSession() {
      await saveSessionNow();
      flushGlobal.cancel();
      await saveGlobal();
    },
    async restoreInitial(target) {
      await myGlobalReady;
      // The window manager chose the folder. `open` also restores the tabs saved for it.
      if (target) await service.open(target);
    },
  };

  // The workspace tab closes for good. The window manager called `close()` before, so the session is saved.
  ctx.bus.on('workbench:disposing', () => {
    scheduleSession.cancel();
    flushGlobal.cancel();
    void saveGlobal();
    if (root) void wsClose(root).catch(() => {});
  });
  return service;
}
