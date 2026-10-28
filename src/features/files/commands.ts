// Commands of the files feature (docs/DESIGN.md, section 6).

import type { AppContext } from '../../core/types';
import { fsCreateFile, fsStat, fsWriteFile, wsNewWindow } from '../../ipc/fs';
import type { Explorer } from './explorer';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function openRecent(ctx: AppContext) {
  const list = await ctx.workspace.recent();
  if (!list.length) {
    ctx.ui.notify('There are no recent folders yet.');
    return;
  }
  const items = list.map((r) => ({
    id: r.path,
    label: r.name,
    description: r.path,
    hint: r.path === ctx.workspace.root ? 'current' : undefined,
  }));
  ctx.ui.quickPick({
    placeholder: 'Open a recent folder',
    items,
    onAccept: (item) =>
      ctx.window.openFolder(item.id).catch((e) => ctx.ui.notify(`Cannot open ${item.id}: ${errorText(e)}`, { kind: 'error' })),
  });
}

async function openSettingsJson(ctx: AppContext) {
  const path = ctx.settings.path();
  try {
    // The file does not exist before the first save. Create it, so the editor can open it.
    if (!(await fsStat(path)).exists) {
      await fsCreateFile(path);
      await fsWriteFile(path, '{\n}\n', { encoding: 'utf-8', bom: false, lineEnding: 'lf', expectedMtimeMs: null });
    }
    await ctx.editors.openFile(path);
  } catch (e) {
    ctx.ui.notify(`Cannot open settings: ${errorText(e)}`, { kind: 'error' });
  }
}

export function registerFileCommands(ctx: AppContext, explorer: Explorer): void {
  const hasRoot = () => ctx.workspace.root !== null;
  ctx.commands.registerMany([
    {
      id: 'workspace.openFolder',
      title: 'Open Folder...',
      category: 'File',
      keybinding: 'Mod-o',
      run: () => ctx.window.pickFolder().catch((e) => ctx.ui.notify(`Cannot open folder: ${errorText(e)}`, { kind: 'error' })),
    },
    { id: 'workspace.openRecent', title: 'Open Recent Folder...', category: 'File', keybinding: 'Mod-r', run: () => openRecent(ctx) },
    {
      id: 'workspace.newWindow',
      title: 'New Window',
      category: 'File',
      keybinding: 'Mod-Shift-n',
      run: () => wsNewWindow().catch((e) => ctx.ui.notify(`Cannot open a new window: ${errorText(e)}`, { kind: 'error' })),
    },
    { id: 'workspace.closeFolder', title: 'Close Folder', category: 'File', when: hasRoot, run: () => ctx.workspace.close() },
    // No key binding: Mod-, belongs to `settings.open`.
    { id: 'workspace.openSettingsJson', title: 'Open Settings (JSON)', category: 'Preferences', run: () => openSettingsJson(ctx) },
    { id: 'explorer.revealActiveFile', title: 'Reveal Active File in Explorer', category: 'Explorer', when: hasRoot, run: () => explorer.revealActive() },
    { id: 'explorer.newFile', title: 'New File in Explorer', category: 'Explorer', when: hasRoot, run: () => explorer.newFile() },
    { id: 'explorer.newFolder', title: 'New Folder in Explorer', category: 'Explorer', when: hasRoot, run: () => explorer.newFolder() },
    { id: 'explorer.rename', title: 'Rename Selected Item', category: 'Explorer', when: () => explorer.hasSelection(), run: () => explorer.rename() },
    { id: 'explorer.delete', title: 'Delete Selected Item', category: 'Explorer', when: () => explorer.hasSelection(), run: () => explorer.delete() },
    { id: 'explorer.refresh', title: 'Refresh Explorer', category: 'Explorer', when: hasRoot, run: () => explorer.refresh() },
    { id: 'explorer.collapseAll', title: 'Collapse All Folders in Explorer', category: 'Explorer', when: hasRoot, run: () => explorer.collapseAll() },
  ]);
}
