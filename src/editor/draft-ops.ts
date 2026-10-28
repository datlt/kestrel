// Drafts on disk: create, list, delete, and rename when the language changes.
// The pure helpers (names, numbers, path check) are in drafts.ts.

import { basename, dirname, joinPath } from '../core/util';
import { fsCreateDir, fsCreateFile, fsDelete, fsListDir, fsReadFile, fsRename, fsStat } from '../ipc/fs';
import { isIpcError } from '../ipc/invoke';
import { DEFAULT_DRAFT_EXT, draftTitle, firstLine, nextDraftNumber, draftFileName } from './drafts';
import type { FileEditorImpl } from './file-editor';
import type { EngineHost } from './host';
import { extensionForLanguage, languageIdFor } from './languages';

export interface DraftInfo {
  path: string;
  title: string;
  mtimeMs: number;
  /** First line of text that is not blank. Empty for an empty draft. */
  preview: string;
  empty: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** File names in the drafts folder. Empty list when the folder does not exist yet. */
async function draftNames(dir: string): Promise<string[]> {
  try {
    return (await fsListDir(dir, dir)).filter((e) => !e.isDir).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Creates an empty draft file with the lowest free number. Returns its path, or null (the user got a message). */
export async function createDraftFile(host: EngineHost): Promise<string | null> {
  const { ui } = host.ctx;
  const dir = await host.draftsDir();
  if (!dir) {
    ui.notify('Cannot create a draft: the app data folder is not known.', { kind: 'error' });
    return null;
  }
  try {
    await fsCreateDir(dir);
  } catch (e) {
    if (!isIpcError(e, 'already_exists')) {
      ui.notify(`Cannot create the drafts folder: ${message(e)}`, { kind: 'error' });
      return null;
    }
  }
  const names = await draftNames(dir);
  for (const ed of host.openEditors()) if (ed.isDraft) names.push(basename(ed.path));
  let n = nextDraftNumber(names);
  // Another window can create a draft at the same moment. Then the file exists: try the next number.
  for (let tries = 0; tries < 50; tries++, n++) {
    const path = joinPath(dir, draftFileName(n, DEFAULT_DRAFT_EXT));
    try {
      await fsCreateFile(path);
      return path;
    } catch (e) {
      if (isIpcError(e, 'already_exists')) continue;
      ui.notify(`Cannot create a draft: ${message(e)}`, { kind: 'error' });
      return null;
    }
  }
  ui.notify('Cannot create a draft: no free draft name.', { kind: 'error' });
  return null;
}

/** All drafts, newest first. */
export async function listDrafts(host: EngineHost): Promise<DraftInfo[]> {
  const dir = await host.draftsDir();
  if (!dir) return [];
  let entries;
  try {
    entries = (await fsListDir(dir, dir)).filter((e) => !e.isDir);
  } catch {
    return [];
  }
  const out = await Promise.all(
    entries.map(async (entry): Promise<DraftInfo> => {
      const open = host.openEditors().find((ed) => ed.path === entry.path);
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = await fsStat(entry.path);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        // Keep 0. The draft goes to the end of the list.
      }
      let text = '';
      if (open) {
        text = open.getText();
      } else if (size > 0) {
        try {
          text = (await fsReadFile(entry.path, { maxBytes: 64 * 1024 })).text;
        } catch {
          // No preview line for this draft.
        }
      }
      const preview = firstLine(text);
      return { path: entry.path, title: draftTitle(entry.path), mtimeMs, preview, empty: open ? open.getText().length === 0 : size === 0 };
    }),
  );
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.title.localeCompare(a.title, undefined, { numeric: true }));
}

/** Deletes the file for good. A missing file is fine. */
export async function deleteDraftFile(path: string): Promise<void> {
  try {
    await fsDelete(path, true);
  } catch (e) {
    if (!isIpcError(e, 'not_found')) throw e;
  }
}

/** Closes the tab of `ed` and opens `newPath` at the same cursor position. */
export async function replaceTab(host: EngineHost, ed: FileEditorImpl, newPath: string): Promise<void> {
  const where = ed.tabData();
  await host.ctx.tabs.close(ed.tabId, { force: true });
  await host.openFile(newPath, { line: where.line, column: where.column, mode: where.mode });
}

/**
 * The user changed the language of a draft. Rename the file to the matching
 * extension, so the language is still right after a restart.
 */
export async function renameDraftForLanguage(host: EngineHost, ed: FileEditorImpl, languageId: string): Promise<void> {
  const { ui } = host.ctx;
  const ext = extensionForLanguage(languageId);
  if (!ext || languageIdFor(ed.path) === languageId) return;
  const name = basename(ed.path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const target = joinPath(dirname(ed.path), `${stem}.${ext}`);
  try {
    if ((await fsStat(target)).exists) {
      ui.notify(`The draft keeps its file name: ${basename(target)} exists already.`, { kind: 'warn' });
      return;
    }
    // Write the text first, so the rename moves the newest text.
    if (ed.isDirty() && !(await ed.save())) return;
    await fsRename(ed.path, target);
  } catch (e) {
    ui.notify(`Cannot rename the draft: ${message(e)}`, { kind: 'error' });
    return;
  }
  await replaceTab(host, ed, target);
}
