// The shell (workbench UI). Owner: shell. See docs/DESIGN.md, section 7.1.
//
// createShell() builds the services (tabs, views, status bar, ui helpers) but
// does not call other services: `ctx.workspace` and `ctx.editors` do not exist
// yet. The layout is built later, in mount().

import { Settings } from 'lucide';
import { h } from '../core/dom';
import type { AppContext, MenuItem, Shell, UiService } from '../core/types';
import { samePath } from '../core/util';
import { createDialogs } from './dialogs';
import { createEmptyState } from './empty';
import { icon } from './icons';
import { installKeys } from './keys';
import { createLayout } from './layout';
import { createLayoutStore } from './layout-state';
import { createMenu } from './menu';
import { createNotifier } from './notify';
import { createPalette } from './palette';
import { createQuickPick } from './quickpick';
import { registerShellCommands } from './shell-commands';
import { createStatusBar } from './statusbar';
import { createTabBar } from './tabbar';
import { createTabModel } from './tabs';
import { createTheme } from './theme';
import { createViews } from './views';
import { createZoom } from './zoom';
import './shell.css';

const MANAGE_LABELS: Record<string, string> = {
  'workbench.commandPalette': 'Command Palette...',
  'settings.open': 'Settings',
  'workspace.openSettingsJson': 'Open Settings (JSON)',
};

export function createShell(ctx: AppContext): Shell {
  const store = createLayoutStore(() => ctx.workspace?.globalState);
  // All overlays live in this layer. It is added to the shell root in mount(),
  // so a hidden workbench never shows them.
  const overlays = h('div', { class: 'shell-overlays' });
  const menu = createMenu((binding) => ctx.commands.keyLabel(binding), overlays);
  const dialogs = createDialogs(overlays);
  const quickPick = createQuickPick(overlays);
  const notifier = createNotifier(overlays);
  const ui: UiService = {
    quickPick: quickPick.open,
    notify: notifier.notify,
    confirm: dialogs.confirm,
    prompt: dialogs.prompt,
    contextMenu: menu.contextMenu,
  };
  const tabs = createTabModel(ctx, ui);
  const views = createViews(store);
  const status = createStatusBar((command, args) => {
    ctx.commands.execute(command, ...args).catch((err) => {
      console.error(`command ${command} failed`, err);
      ui.notify(`Command failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
    });
  });
  const theme = createTheme(ctx);
  // Set the theme now, so the first paint has the right colors.
  theme.apply();

  function mount(root: HTMLElement) {
    // Commands use ctx.tabs, ctx.views and ctx.ui, which main.ts set after createShell.
    const zoom = createZoom(ctx);
    const palette = createPalette(ctx, ui.quickPick);
    registerShellCommands(ctx, {
      tabs,
      togglePalette: palette.toggle,
      toggleTheme: () => void theme.toggle(),
      zoomContent: zoom.zoomContent,
      zoomUi: zoom.zoomUi,
    });
    const removeKeys = installKeys(ctx);
    store.load();

    const empty = createEmptyState(ctx);
    const runCommand = (id: string) => {
      ctx.commands.execute(id).catch((err) => {
        console.error(`command ${id} failed`, err);
        ui.notify(`Command failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      });
    };
    const tabBar = createTabBar(tabs, {
      openMenu: menu.openAt,
      notify: ui.notify,
      run: runCommand,
      keyLabelOf: (id) => {
        const cmd = ctx.commands.get(id);
        const binding = Array.isArray(cmd?.keybinding) ? cmd.keybinding[0] : cmd?.keybinding;
        return binding ? ctx.commands.keyLabel(binding) : undefined;
      },
    });
    const hosts = h('div', { class: 'shell-tab-hosts' });
    const layout = createLayout({
      store,
      activityBar: views.activityBar,
      sidebar: views.sidebar,
      panel: views.panel,
      tabBar: tabBar.el,
      content: hosts,
      empty: empty.el,
      statusBar: status.el,
      overlays,
    });
    tabs.attach(hosts);
    root.replaceChildren(layout.root);
    views.mount();

    // Settings button at the bottom of the activity bar.
    const settingsButton = h(
      'button',
      { class: 'shell-activity-btn', title: 'Manage', 'aria-label': 'Manage' },
      icon(Settings),
    );
    settingsButton.addEventListener('click', () => {
      const r = settingsButton.getBoundingClientRect();
      menu.openAt(r.right + 4, r.top, manageMenu());
    });
    views.activityBottom.append(settingsButton);

    function manageMenu(): MenuItem[] {
      const entries: [string, boolean][] = [
        ['workbench.commandPalette', false],
        ['settings.open', false],
        ['workspace.openSettingsJson', false],
        ['view.toggleTheme', true],
        ['view.uiZoomIn', true],
        ['view.uiZoomOut', false],
        ['view.uiZoomReset', false],
      ];
      const items: MenuItem[] = [];
      for (const [id, separatorBefore] of entries) {
        const cmd = ctx.commands.get(id);
        if (!cmd) continue;
        const binding = Array.isArray(cmd.keybinding) ? cmd.keybinding[0] : cmd.keybinding;
        items.push({
          label: MANAGE_LABELS[id] ?? cmd.title,
          keybinding: binding,
          separatorBefore,
          run: () => void ctx.commands.execute(id),
        });
      }
      return items;
    }

    // Empty state.
    const syncEmpty = () => {
      const isEmpty = tabs.list().length === 0;
      if (empty.el.hidden === !isEmpty) return;
      empty.el.hidden = !isEmpty;
      if (isEmpty) void empty.refresh();
    };
    empty.el.hidden = true;
    tabs.onDidChange((c) => {
      if (c === 'list') syncEmpty();
    });
    syncEmpty();
    ctx.bus.on('workspace:changed', () => {
      // The saved layout may not have been ready at mount.
      if (!store.loaded) store.load();
      if (!empty.el.hidden) void empty.refresh();
    });

    zoom.attachGestures(layout.editorArea);
    zoom.applyUiZoom();
    theme.apply(true);

    ctx.bus.on('file:saved', ({ path }) => {
      if (samePath(path, ctx.settings.path())) {
        ctx.settings.reload().catch((err) => console.error('settings reload failed', err));
      }
    });

    // The window manager emits these events.
    ctx.bus.on('workbench:activated', () => tabs.focusActive());
    ctx.bus.on('workbench:deactivated', () => {
      quickPick.close();
      menu.close();
    });
    ctx.bus.on('workbench:disposing', () => {
      quickPick.close();
      menu.close();
      removeKeys();
      tabBar.dispose();
      zoom.dispose();
      theme.dispose();
      notifier.dispose();
      // Dispose the content of all open tabs and all views, then remove the DOM.
      tabs.dispose();
      views.dispose();
      layout.root.remove();
    });
  }

  return { tabs, views: views.api, status: status.api, ui, mount };
}
