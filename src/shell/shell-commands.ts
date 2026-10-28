// The shell commands (docs/DESIGN.md, section 6).

import type { AppContext, Command, Disposable } from '../core/types';
import type { TabModel } from './tabs';

interface Deps {
  tabs: TabModel;
  togglePalette(): void;
  toggleTheme(): void;
  zoomContent(step: 1 | -1 | 0): void;
  zoomUi(step: 1 | -1 | 0): void;
}

export function registerShellCommands(ctx: AppContext, d: Deps): Disposable {
  const hasTab = () => ctx.tabs.active() !== null;
  const hasTabs = () => ctx.tabs.list().length > 0;

  const showView = (id: string) => ctx.views.show(id, { focus: true });

  const commands: Command[] = [
    { id: 'workbench.commandPalette', title: 'Show All Commands', category: 'View', keybinding: ['Mod-Shift-p', 'F1'], hidden: true, run: () => d.togglePalette() },
    { id: 'workbench.toggleSidebar', title: 'Toggle Sidebar', category: 'View', keybinding: 'Mod-b', run: () => ctx.views.toggleSidebar() },
    { id: 'workbench.togglePanel', title: 'Toggle Panel', category: 'View', keybinding: 'Mod-j', run: () => ctx.views.togglePanel() },
    {
      id: 'workbench.closeTab',
      title: 'Close Tab',
      category: 'View',
      keybinding: 'Mod-w',
      when: hasTab,
      run: () => {
        const tab = ctx.tabs.active();
        if (tab) return ctx.tabs.close(tab.id);
      },
    },
    { id: 'workbench.closeAllTabs', title: 'Close All Tabs', category: 'View', when: hasTabs, run: () => d.tabs.closeAllUser() },
    {
      id: 'workbench.closeOtherTabs',
      title: 'Close Other Tabs',
      category: 'View',
      when: () => ctx.tabs.list().length > 1,
      run: () => {
        const tab = ctx.tabs.active();
        if (tab) return d.tabs.closeOthers(tab.id);
      },
    },
    {
      id: 'workbench.reopenClosedTab',
      title: 'Reopen Closed Tab',
      category: 'View',
      keybinding: 'Mod-Shift-t',
      when: () => d.tabs.hasClosed(),
      run: () => d.tabs.reopenClosed(),
    },
    { id: 'workbench.nextTab', title: 'Next Tab', category: 'View', keybinding: 'Ctrl-Tab', when: hasTabs, run: () => d.tabs.cycle(1) },
    { id: 'workbench.prevTab', title: 'Previous Tab', category: 'View', keybinding: 'Ctrl-Shift-Tab', when: hasTabs, run: () => d.tabs.cycle(-1) },
    { id: 'workbench.showExplorer', title: 'Show Explorer', category: 'View', keybinding: 'Mod-Shift-e', run: () => showView('explorer') },
    {
      id: 'workbench.showSearch',
      title: 'Show Search',
      category: 'View',
      keybinding: 'Mod-Shift-f',
      run: () => {
        showView('search');
        if (ctx.commands.get('search.findInFiles')) return ctx.commands.execute('search.findInFiles');
      },
    },
    { id: 'workbench.showGit', title: 'Show Source Control', category: 'View', keybinding: 'Ctrl-Shift-g', run: () => showView('git') },

    { id: 'view.zoomIn', title: 'Zoom In', category: 'View', keybinding: ['Mod-=', 'Mod-Shift-='], run: () => d.zoomContent(1) },
    { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', keybinding: 'Mod--', run: () => d.zoomContent(-1) },
    { id: 'view.zoomReset', title: 'Reset Zoom', category: 'View', keybinding: 'Mod-0', run: () => d.zoomContent(0) },
    { id: 'view.uiZoomIn', title: 'Zoom Window In', category: 'View', keybinding: 'Mod-Alt-=', run: () => d.zoomUi(1) },
    { id: 'view.uiZoomOut', title: 'Zoom Window Out', category: 'View', keybinding: 'Mod-Alt--', run: () => d.zoomUi(-1) },
    { id: 'view.uiZoomReset', title: 'Reset Window Zoom', category: 'View', keybinding: 'Mod-Alt-0', run: () => d.zoomUi(0) },
    { id: 'view.toggleTheme', title: 'Toggle Light/Dark Theme', category: 'View', run: () => d.toggleTheme() },
  ];
  return ctx.commands.registerMany(commands);
}
