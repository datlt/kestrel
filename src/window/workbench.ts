// One workbench: the whole editor (bus, commands, shell, editors, workspace,
// features) for one workspace tab. It is built like the old single-window
// startup in main.ts. The only differences are the shared settings service and
// `ctx.window`.

import { createBus } from '../core/bus';
import { createCommandRegistry } from '../core/commands';
import type { AppContext, EventBus, SettingsService, WindowApi } from '../core/types';
import { platform } from '../core/util';
import { createShell } from '../shell';
import { createEditorService } from '../editor';
import { createWorkspaceService, initFiles, whenStateReady } from '../features/files';
import { initSearch } from '../features/search';
import { initGit } from '../features/git';
import { initLsp } from '../features/lsp';
import { initPreview } from '../features/preview';
import { initSettingsUi } from '../features/settings';
import { initDb } from '../features/db';
import { initWeb } from '../features/web';
import { initTerminal } from '../features/terminal';
import { initDiagram } from '../features/diagram';
import { initUsages } from '../features/usages';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface WindowActions {
  next(): void;
  prev(): void;
  close(): void;
  newTab(): void;
  /** `n` starts at 1. */
  goto(n: number): void;
  /** Number of workspace tabs now. */
  count(): number;
}

export interface Workbench {
  readonly id: string;
  readonly host: HTMLElement;
  readonly ctx: AppContext;
  readonly bus: EventBus;
  /** Opens the folder (or no folder) and restores its saved tabs. */
  restore(root: string | null): Promise<void>;
}

export interface WorkbenchInit {
  id: string;
  windowLabel: string;
  host: HTMLElement;
  settings: SettingsService;
  windowApi: WindowApi;
  actions: WindowActions;
  report(where: string, err: unknown): void;
}

export async function createWorkbench(init: WorkbenchInit): Promise<Workbench> {
  const { id, host, report } = init;
  const bus = createBus();
  const commands = createCommandRegistry();
  const ctx = {
    platform,
    windowLabel: init.windowLabel,
    window: init.windowApi,
    bus,
    commands,
    settings: init.settings,
  } as Mutable<AppContext>;

  const shell = createShell(ctx);
  ctx.tabs = shell.tabs;
  ctx.views = shell.views;
  ctx.status = shell.status;
  ctx.ui = shell.ui;
  ctx.editors = createEditorService(ctx);
  ctx.workspace = createWorkspaceService(ctx);
  // The layout is in globalState. Wait for the file, so the first paint uses it.
  await whenStateReady();

  registerWindowCommands(ctx, init.actions);

  const features: [string, (ctx: AppContext) => void][] = [
    ['files', initFiles],
    ['search', initSearch],
    ['git', initGit],
    ['preview', initPreview],
    ['lsp', initLsp],
    ['settings', initSettingsUi],
    ['db', initDb],
    ['web', initWeb],
    ['terminal', initTerminal],
    ['diagram', initDiagram],
    ['usages', initUsages],
  ];
  for (const [name, fn] of features) {
    try {
      fn(ctx);
    } catch (e) {
      report(`init ${name}`, e);
    }
  }

  shell.mount(host);

  return {
    id,
    host,
    ctx,
    bus,
    async restore(root) {
      try {
        await ctx.workspace.restoreInitial(root);
      } catch (e) {
        report('restore workspace', e);
      }
    },
  };
}

function registerWindowCommands(ctx: AppContext, a: WindowActions) {
  const category = 'Window';
  ctx.commands.registerMany([
    { id: 'window.nextWorkspaceTab', title: 'Next Workspace Tab', category, keybinding: 'Mod-Shift-]', run: () => a.next() },
    { id: 'window.prevWorkspaceTab', title: 'Previous Workspace Tab', category, keybinding: 'Mod-Shift-[', run: () => a.prev() },
    { id: 'window.closeWorkspaceTab', title: 'Close Workspace Tab', category, run: () => a.close() },
    { id: 'window.newWorkspaceTab', title: 'New Workspace Tab', category, run: () => a.newTab() },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `window.workspaceTab${i + 1}`,
      title: `Go to Workspace Tab ${i + 1}`,
      category,
      hidden: true,
      keybinding: `Mod-${i + 1}`,
      when: () => a.count() > i,
      run: () => a.goto(i + 1),
    })),
  ]);
}
