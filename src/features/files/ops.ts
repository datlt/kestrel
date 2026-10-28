// File operations of the explorer: rename and delete, with the open tabs handled.

import type { AppContext, Tab } from '../../core/types';
import { isInside } from '../../core/util';
import { fsDelete, fsRename } from '../../ipc/fs';
import { platform } from '../../core/util';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TAB_KINDS = ['file:', 'image:'];

interface OpenTab {
  tab: Tab;
  prefix: string;
  path: string;
}

/** Tabs that show a file inside `path` (or the file itself). */
function tabsInside(ctx: AppContext, path: string): OpenTab[] {
  const out: OpenTab[] = [];
  for (const tab of ctx.tabs.list()) {
    const prefix = TAB_KINDS.find((p) => tab.id.startsWith(p));
    if (!prefix) continue;
    const p = tab.id.slice(prefix.length);
    if (isInside(p, path)) out.push({ tab, prefix, path: p });
  }
  return out;
}

/** Returns an error text for a bad file name, or null. `nested` allows `a/b.txt`. */
export function validateName(name: string, nested: boolean): string | null {
  if (!name.trim()) return 'Type a name.';
  if (/[\u0000]/.test(name)) return 'The name has an invalid character.';
  if (platform === 'windows' && /[<>:"|?*]/.test(name.replace(/^[a-zA-Z]:/, ''))) {
    return 'The name has a character that Windows does not allow.';
  }
  const parts = name.split(/[\\/]/);
  if (!nested && parts.length > 1) return 'The name cannot have a slash.';
  if (nested && /^[\\/]/.test(name)) return 'Use a path relative to this folder.';
  if (parts.some((p) => p === '.' || p === '..' || (p === '' && !(nested && name.endsWith('/'))))) {
    return 'The name is not valid.';
  }
  return null;
}

/**
 * Renames or moves a file or folder. Open tabs of the old path are closed and
 * opened again with the new path. Returns false when nothing changed.
 */
export async function renameEntry(ctx: AppContext, from: string, to: string): Promise<boolean> {
  const affected = tabsInside(ctx, from);
  if (affected.some((a) => a.tab.dirty)) {
    ctx.ui.notify('Save or close the changed files before you rename. Some open files are not saved.', { kind: 'warn' });
    return false;
  }
  try {
    await fsRename(from, to);
  } catch (e) {
    ctx.ui.notify(`Cannot rename: ${errorText(e)}`, { kind: 'error' });
    return false;
  }
  const activeId = ctx.tabs.active()?.id;
  const moved = affected.map((a) => ({
    ...a,
    next: to + a.path.slice(from.length),
    wasActive: a.tab.id === activeId,
  }));
  for (const m of moved) await ctx.tabs.close(m.tab.id, { force: true });
  for (const m of moved) {
    try {
      await ctx.editors.openFile(m.next, { activate: false });
    } catch (e) {
      ctx.ui.notify(`Cannot open ${m.next}: ${errorText(e)}`, { kind: 'warn' });
    }
  }
  const active = moved.find((m) => m.wasActive);
  if (active) {
    const id = [...TAB_KINDS].map((p) => p + active.next).find((id) => ctx.tabs.get(id));
    if (id) ctx.tabs.activate(id);
  }
  return true;
}

/** Asks, then moves the entry to the trash. Closes its tabs. Returns false when it was not deleted. */
export async function deleteEntry(ctx: AppContext, path: string, name: string, isDir: boolean): Promise<boolean> {
  const trashLabel = platform === 'windows' ? 'Move to Recycle Bin' : 'Move to Trash';
  const choice = await ctx.ui.confirm({
    title: `Delete '${name}'?`,
    message: isDir
      ? 'The folder and everything in it will be moved to the trash.'
      : 'The file will be moved to the trash.',
    buttons: [trashLabel, 'Delete Permanently', 'Cancel'],
  });
  if (choice !== trashLabel && choice !== 'Delete Permanently') return false;

  const confirmPermanent = async (reason?: string) => {
    const r = await ctx.ui.confirm({
      title: `Delete '${name}' permanently?`,
      message: `${reason ? reason + ' ' : ''}You cannot undo this.`,
      buttons: ['Delete', 'Cancel'],
    });
    return r === 'Delete';
  };

  let permanent = choice === 'Delete Permanently';
  if (permanent && !(await confirmPermanent())) return false;
  try {
    await fsDelete(path, permanent);
  } catch (e) {
    if (permanent) {
      ctx.ui.notify(`Cannot delete: ${errorText(e)}`, { kind: 'error' });
      return false;
    }
    if (!(await confirmPermanent(`The trash is not available (${errorText(e)}).`))) return false;
    permanent = true;
    try {
      await fsDelete(path, true);
    } catch (e2) {
      ctx.ui.notify(`Cannot delete: ${errorText(e2)}`, { kind: 'error' });
      return false;
    }
  }
  for (const a of tabsInside(ctx, path)) await ctx.tabs.close(a.tab.id, { force: true });
  return true;
}
