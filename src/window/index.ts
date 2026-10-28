// The window manager. Owner: window. See docs/DESIGN.md, section 8.1.
//
// A window has a list of workspace tabs (TabModel). Each tab is a workbench.
// Workbenches are created the first time their tab is shown. Hidden
// workbenches stay alive with `display: none`, so switching is instant.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { h } from '../core/dom';
import { createSettings } from '../core/settings';
import type { WindowApi } from '../core/types';
import { debounce, isMac, platform, samePath } from '../core/util';
import { appLog } from '../ipc/app';
import { wsGlobalLoad, wsGlobalPatch, wsLaunchArgs, wsNewWindow, wsRecentList, type LaunchTarget } from '../ipc/fs';
import type { PopupItem } from './menu';
import { describeTabs, TabModel, type SavedTabs } from './model';
import { createStrip, type StripTab } from './strip';
import { createWorkbench, type Workbench, type WindowActions } from './workbench';

const LEGACY_LAST_FOLDER_KEY = 'workspace.lastFolder';
const DEFAULT_TITLE = 'Kestrel';

interface Entry {
  id: string;
  /** Set when the workbench is mounted. */
  wb?: Workbench;
  /** Set while the workbench is being created. */
  creating?: Promise<Workbench | null>;
  title: string;
  dirty: boolean;
}

export async function startWindow(report: (where: string, err: unknown) => void): Promise<void> {
  const t0 = performance.now();
  const win = getCurrentWindow();
  const isMain = win.label === 'main';
  const stateKey = `window.tabs.${win.label}`;

  let counter = 0;
  const model = new TabModel(() => `wb${++counter}`);
  const entries = new Map<string, Entry>();
  let visibleId = '';
  let closingWindow = false;

  const app = document.getElementById('app')!;
  const hosts = h('div', { class: 'win-hosts' });

  // ---- Shared settings: every workbench bus gets `settings:changed`. ----
  const settings = await createSettings((e) => {
    for (const entry of entries.values()) entry.wb?.bus.emit('settings:changed', e);
  });

  // ---- Which tabs to open ----
  const globalState = isMain ? await wsGlobalLoad().catch(() => ({}) as Record<string, unknown>) : {};
  const urlRoot = new URLSearchParams(location.search).get('root');
  let launch: LaunchTarget | null = null;
  if (urlRoot) {
    model.restore({ tabs: [{ root: urlRoot }], active: 0 } satisfies SavedTabs);
  } else if (isMain) {
    launch = await wsLaunchArgs().catch(() => null);
    const saved = globalState[stateKey];
    const legacy = globalState[LEGACY_LAST_FOLDER_KEY];
    if (saved) model.restore(saved);
    else if (typeof legacy === 'string' && legacy) model.restore({ tabs: [{ root: legacy }], active: 0 });
    else model.restore(null);
    if (launch?.kind === 'folder') {
      const same = model.findByRoot(launch.path, samePath);
      if (same) model.activate(same.id);
      else if (model.tabs.length === 1 && !model.tabs[0].root) model.setRoot(model.tabs[0].id, launch.path);
      else model.add(launch.path);
    }
  } else {
    model.restore(null);
  }
  for (const t of model.tabs) entries.set(t.id, { id: t.id, title: DEFAULT_TITLE, dirty: false });

  // ---- Saving the tab list (main window only) ----
  const writeTabs = () => {
    if (!isMain) return;
    wsGlobalPatch({ [stateKey]: model.snapshot() }).catch((e) => report('save tab list', e));
  };
  const saveTabs = debounce(writeTabs, 300);

  // ---- The strip ----
  const strip = createStrip({
    activate: (id) => void activate(id),
    close: (id) => void closeTab(id),
    move: (id, index) => {
      model.move(id, index);
      renderStrip();
      saveTabs();
    },
    contextItems,
    plusItems,
  });
  app.append(strip.el, hosts);

  function renderStrip() {
    const labels = describeTabs(model.tabs);
    const activeId = model.active?.id;
    const tabs: StripTab[] = model.tabs.map((t) => {
      const label = labels.get(t.id)!;
      return {
        id: t.id,
        name: label.name,
        description: label.description,
        tooltip: t.root ?? 'Empty workspace tab',
        dirty: entries.get(t.id)?.dirty ?? false,
        active: t.id === activeId,
      };
    });
    strip.render(tabs);
  }

  if (isMac) {
    const refresh = () => win.isFullscreen().then((on) => strip.setFullscreen(on)).catch(() => {});
    void refresh();
    win.onResized(debounce(refresh, 80)).catch(() => {});
  }

  // ---- Workbenches ----
  function windowApiFor(id: string): WindowApi {
    return {
      workbenchId: id,
      isActive: () => model.active?.id === id,
      openFolder,
      pickFolder,
      setTitle(title) {
        const entry = entries.get(id);
        if (!entry) return;
        entry.title = title;
        if (visibleId === id) win.setTitle(title).catch(() => {});
      },
    };
  }

  const actions = (id: string): WindowActions => ({
    next: () => {
      const t = model.neighbor(1);
      if (t) void activate(t.id);
    },
    prev: () => {
      const t = model.neighbor(-1);
      if (t) void activate(t.id);
    },
    close: () => void closeTab(id),
    newTab: () => void newEmptyTab(),
    goto: (n) => {
      const t = model.tabs[n - 1];
      if (t) void activate(t.id);
    },
    count: () => model.tabs.length,
  });

  /** Creates and mounts the workbench of a tab once. Returns null when it failed. */
  function ensure(id: string): Promise<Workbench | null> {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(null);
    if (entry.wb) return Promise.resolve(entry.wb);
    entry.creating ??= (async () => {
      const host = h('div', { class: 'win-host hidden' });
      hosts.append(host);
      try {
        const wb = await createWorkbench({
          id,
          windowLabel: win.label,
          host,
          settings,
          windowApi: windowApiFor(id),
          actions: actions(id),
          report,
        });
        entry.wb = wb;
        watch(entry, wb);
        return wb;
      } catch (e) {
        report(`create workbench ${id}`, e);
        host.remove();
        entry.creating = undefined;
        return null;
      }
    })();
    return entry.creating;
  }

  /** Follows folder and dirty changes of a workbench. */
  function watch(entry: Entry, wb: Workbench) {
    const refreshDirty = () => {
      const dirty = wb.ctx.tabs.list().some((t) => t.dirty);
      if (dirty !== entry.dirty) {
        entry.dirty = dirty;
        renderStrip();
      }
    };
    wb.bus.on('tabs:changed', refreshDirty);
    wb.bus.on('tab:activated', refreshDirty);
    wb.bus.on('workspace:changed', ({ root }) => {
      if (!model.get(entry.id)) return;
      model.setRoot(entry.id, root);
      renderStrip();
      saveTabs();
    });
  }

  /** Makes the host of the active tab visible, if it is mounted. */
  function showActive() {
    const next = model.active ? entries.get(model.active.id) : undefined;
    if (!next?.wb || next.id === visibleId) return;
    const prev = visibleId ? entries.get(visibleId) : undefined;
    if (prev?.wb) {
      prev.wb.host.classList.add('hidden');
      prev.wb.bus.emit('workbench:deactivated', {});
    }
    next.wb.host.classList.remove('hidden');
    visibleId = next.id;
    win.setTitle(next.title).catch(() => {});
    next.wb.bus.emit('workbench:activated', {});
    next.wb.ctx.tabs.active()?.content?.focus();
  }

  /** Creates the workbench if needed, shows it when its tab is active, then restores its folder. */
  async function bring(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry) return;
    const fresh = !entry.wb;
    const wb = await ensure(id);
    if (!wb) return;
    showActive();
    if (fresh) {
      await wb.restore(model.get(id)?.root ?? null);
      // The folder may be gone. Show what really opened.
      if (model.get(id)) {
        model.setRoot(id, wb.ctx.workspace.root);
        renderStrip();
        saveTabs();
      }
    }
  }

  async function activate(id: string): Promise<void> {
    if (!model.activate(id)) return;
    renderStrip();
    saveTabs();
    // An already mounted workbench switches at once, without waiting for anything.
    showActive();
    await bring(id);
  }

  async function newEmptyTab(): Promise<void> {
    const tab = model.add(null);
    entries.set(tab.id, { id: tab.id, title: DEFAULT_TITLE, dirty: false });
    renderStrip();
    saveTabs();
    await bring(tab.id);
  }

  async function openFolder(root: string): Promise<void> {
    const same = model.findByRoot(root, samePath);
    if (same) return activate(same.id);
    const current = model.active;
    if (current && !current.root) {
      const wb = await ensure(current.id);
      if (wb) {
        await wb.ctx.workspace.open(root);
        return;
      }
    }
    const tab = model.add(root);
    entries.set(tab.id, { id: tab.id, title: DEFAULT_TITLE, dirty: false });
    renderStrip();
    saveTabs();
    await bring(tab.id);
  }

  async function pickFolder(): Promise<void> {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === 'string' && picked) await openFolder(picked);
  }

  // ---- Closing ----

  /**
   * Asks about unsaved files of a workbench. Returns false when the user
   * cancels or a save fails. The workbench must be visible to show the dialog.
   */
  async function confirmDirty(entry: Entry): Promise<boolean> {
    const wb = entry.wb;
    if (!wb) return true;
    const dirty = wb.ctx.tabs.list().filter((t) => t.dirty);
    if (dirty.length === 0) return true;
    if (visibleId !== entry.id) {
      model.activate(entry.id);
      renderStrip();
      showActive();
    }
    const name = wb.ctx.workspace.name ?? 'this workspace';
    const names = dirty.slice(0, 8).map((t) => t.title);
    if (dirty.length > names.length) names.push(`and ${dirty.length - names.length} more`);
    const choice = await wb.ctx.ui.confirm({
      title: `Save changes in "${name}"?`,
      message: names.join('\n'),
      buttons: ['Save All', "Don't Save", 'Cancel'],
    });
    if (choice === 'Save All') {
      for (const t of dirty) {
        if (t.content?.save && (await t.content.save()) === false) return false;
      }
      return true;
    }
    if (choice === "Don't Save") {
      // Close them now, so closing the workspace does not ask again.
      for (const t of dirty) await wb.ctx.tabs.close(t.id, { force: true });
      return true;
    }
    return false;
  }

  async function closeTab(id: string): Promise<boolean> {
    const entry = entries.get(id);
    if (!entry || !model.get(id)) return false;
    const before = model.active?.id;
    if (!(await confirmDirty(entry))) {
      // Go back to the tab the user was using.
      if (before && before !== model.active?.id) void activate(before);
      return false;
    }
    const wb = entry.wb;
    if (wb) {
      try {
        await wb.ctx.workspace.saveSession();
        await wb.ctx.workspace.close();
      } catch (e) {
        report('close workspace tab', e);
      }
    }
    // The last tab stays and becomes an empty tab.
    if (model.tabs.length === 1) {
      model.setRoot(id, null);
      entry.dirty = false;
      renderStrip();
      saveTabs();
      return true;
    }
    wb?.bus.emit('workbench:disposing', {});
    model.close(id);
    const next = model.active;
    if (next) {
      renderStrip();
      await bring(next.id);
    }
    entries.delete(id);
    wb?.host.remove();
    if (visibleId === id) visibleId = '';
    renderStrip();
    saveTabs();
    return true;
  }

  async function closeOthers(id: string): Promise<void> {
    for (const t of [...model.tabs]) {
      if (t.id !== id && !(await closeTab(t.id))) return;
    }
  }

  // ---- Menus ----
  const revealLabel = platform === 'macos' ? 'Reveal in Finder' : platform === 'windows' ? 'Reveal in Explorer' : 'Reveal in File Manager';

  function contextItems(id: string): PopupItem[] {
    const root = model.get(id)?.root ?? null;
    return [
      { label: 'Close', run: () => void closeTab(id) },
      { label: 'Close Others', disabled: model.tabs.length < 2, run: () => void closeOthers(id) },
      {
        label: 'Copy Path',
        disabled: !root,
        separatorBefore: true,
        run: () => void navigator.clipboard.writeText(root ?? '').catch(() => {}),
      },
      {
        label: revealLabel,
        disabled: !root,
        run: () => void revealItemInDir(root ?? '').catch((e) => report('reveal folder', e)),
      },
      {
        label: 'Open in New Window',
        disabled: !root,
        run: () => void wsNewWindow(root).catch((e) => report('new window', e)),
      },
    ];
  }

  async function plusItems(): Promise<PopupItem[]> {
    const items: PopupItem[] = [{ label: 'Open Folder…', run: () => void pickFolder().catch((e) => report('pick folder', e)) }];
    const recent = await wsRecentList().catch(() => []);
    recent.slice(0, 8).forEach((r, i) => {
      items.push({
        label: r.name,
        hint: r.path,
        separatorBefore: i === 0,
        run: () => void openFolder(r.path).catch((e) => report('open recent folder', e)),
      });
    });
    items.push({ label: 'New Empty Tab', separatorBefore: true, run: () => void newEmptyTab() });
    return items;
  }

  // ---- Closing the window ----
  win
    .onCloseRequested(async (event) => {
      // Stop the close first. Asking the user takes time.
      event.preventDefault();
      if (closingWindow) return;
      closingWindow = true;
      try {
        for (const t of [...model.tabs]) {
          const entry = entries.get(t.id);
          if (entry && !(await confirmDirty(entry))) return;
        }
        for (const entry of entries.values()) {
          try {
            await entry.wb?.ctx.workspace.saveSession();
          } catch (e) {
            report('save session', e);
          }
        }
        saveTabs.cancel();
        await wsGlobalPatch(isMain ? { [stateKey]: model.snapshot() } : {}).catch(() => {});
        await win.destroy();
      } finally {
        closingWindow = false;
      }
    })
    .catch((e) => report('close guard', e));

  // ---- Start: only the active tab is created ----
  renderStrip();
  const first = model.active!;
  const firstWb = await ensure(first.id);
  showActive();

  // Show the window now. A hidden web view does not run requestAnimationFrame,
  // so we cannot wait for a frame here. The window background gets the theme
  // color first, so there is no white or dark flash before the first paint.
  const dark = document.documentElement.dataset.theme !== 'light';
  win
    .setBackgroundColor(dark ? '#1f2023' : '#ffffff')
    .catch(() => {})
    .then(() => win.show())
    .then(() => win.setFocus())
    .then(() => appLog('info', `window shown ${Math.round(performance.now() - t0)} ms after window manager start`))
    .catch((e) => report('show window', e));

  if (!firstWb) return;
  await firstWb.restore(first.root);
  model.setRoot(first.id, firstWb.ctx.workspace.root);
  renderStrip();
  if (launch?.kind === 'file' && model.active) {
    const wb = entries.get(model.active.id)?.wb;
    await wb?.ctx.editors.openFile(launch.path).catch((e) => report('open launch file', e));
  }
  saveTabs();
}
