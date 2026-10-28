// Save flows: normal save, Save As, conflicts, characters that the encoding
// cannot store, read-only files, trim whitespace and final newline.

import { isIpcError } from '../ipc/invoke';
import { fsWriteFile, type WriteFileResult } from '../ipc/fs';
import { basename, joinPath, samePath } from '../core/util';
import { deleteDraftFile, replaceTab } from './draft-ops';
import type { FileEditorImpl } from './file-editor';
import { programmatic, type EngineHost } from './host';
import { finalNewlineChange, trailingWhitespaceChanges, type TextChange } from './text';

export interface SaveOptions {
  saveAs?: boolean;
  /** Auto save: never ask questions. Skips the save when a question would be needed. */
  auto?: boolean;
  /** Write even when the file changed on disk. */
  overwrite?: boolean;
}

/** Saves one at a time per editor, in call order. */
export function saveFile(host: EngineHost, ed: FileEditorImpl, opts: SaveOptions = {}): Promise<boolean> {
  const run = () => doSave(host, ed, opts);
  const result = ed.saveQueue.then(run, run);
  ed.saveQueue = result.catch(() => false);
  return result;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function doSave(host: EngineHost, ed: FileEditorImpl, opts: SaveOptions): Promise<boolean> {
  const { ctx } = host;
  if (opts.saveAs) return opts.auto ? false : saveAs(host, ed);
  // A queued auto save can run after a manual save already wrote the text.
  if (opts.auto && (!ed.isDirty() || ed.autosaveStopped)) return false;

  if (ed.meta.readonly && !opts.overwrite) {
    if (opts.auto) return false;
    const choice = await ctx.ui.confirm({
      title: 'File is read-only',
      message: `${ed.title} is read-only. You can save a copy with another name.`,
      buttons: ['Save As...', 'Cancel'],
    });
    return choice === 'Save As...' ? saveAs(host, ed) : false;
  }

  if (ed.lossy && !ed.lossyAccepted) {
    if (opts.auto) return false;
    const choice = await ctx.ui.confirm({
      title: 'Some bytes could not be decoded',
      message:
        `${ed.title} has bytes that are not valid in ${ed.meta.encoding}. The editor shows them as the character U+FFFD. ` +
        'If you save, those bytes are lost.',
      buttons: ['Save Anyway', 'Cancel'],
    });
    if (choice !== 'Save Anyway') return false;
    ed.lossyAccepted = true;
  }

  applyFormatting(host, ed);
  const doc = ed.view.state.doc;
  const text = doc.toString();
  let result: WriteFileResult;
  ed.saving = true;
  try {
    result = await fsWriteFile(ed.path, text, {
      encoding: ed.meta.encoding,
      bom: ed.meta.bom,
      lineEnding: ed.meta.lineEnding,
      expectedMtimeMs: opts.overwrite ? null : ed.meta.mtimeMs || null,
    });
  } catch (e) {
    ed.saving = false;
    return handleWriteError(host, ed, opts, e);
  }
  ed.saving = false;
  ed.meta.mtimeMs = result.mtimeMs;
  ed.meta.size = result.size;
  ed.markClean(doc);
  ed.resumeAutosave();
  ctx.bus.emit('file:saved', { path: ed.path });
  host.statusChanged(ed);
  return true;
}

async function handleWriteError(host: EngineHost, ed: FileEditorImpl, opts: SaveOptions, e: unknown): Promise<boolean> {
  const { ctx } = host;
  if (isIpcError(e, 'conflict')) {
    if (opts.auto) {
      ed.stopAutosave(`Auto save stopped: ${ed.title} was changed on disk by another program.`, [
        { label: 'Overwrite', run: () => void saveFile(host, ed, { overwrite: true }) },
        { label: 'Reload', run: () => void ed.reload() },
      ]);
      return false;
    }
    const choice = await ctx.ui.confirm({
      title: 'File changed on disk',
      message:
        `${ed.title} was changed by another program after you opened it. ` +
        'Overwrite keeps your version. Reload drops your changes and loads the file from disk.',
      buttons: ['Overwrite', 'Reload', 'Cancel'],
    });
    if (choice === 'Overwrite') return doSave(host, ed, { ...opts, overwrite: true });
    if (choice === 'Reload') await ed.reload();
    return false;
  }
  if (isIpcError(e, 'unmappable')) {
    if (opts.auto) {
      ed.stopAutosave(`Auto save stopped: ${ed.title} has characters that ${ed.meta.encoding} cannot store.`, [
        {
          label: 'Save as UTF-8',
          run: () => {
            ed.meta.encoding = 'utf-8';
            ed.meta.bom = false;
            void saveFile(host, ed);
          },
        },
        { label: 'Reload', run: () => void ed.reload() },
      ]);
      return false;
    }
    if (await offerUtf8(host, ed)) return doSave(host, ed, opts);
    return false;
  }
  if (opts.auto) {
    // One message, then auto save waits. Otherwise the same error would show after every edit.
    ed.stopAutosave(`Auto save stopped: could not save ${ed.title}. ${message(e)}`, [], 'error');
    return false;
  }
  ctx.ui.notify(`Could not save ${ed.title}: ${message(e)}`, { kind: 'error' });
  return false;
}

/** Asks to switch to UTF-8. Returns true when the user agreed (the editor meta is changed). */
async function offerUtf8(host: EngineHost, ed: FileEditorImpl): Promise<boolean> {
  const choice = await host.ctx.ui.confirm({
    title: `Cannot save as ${ed.meta.encoding.toUpperCase()}`,
    message: `The text of ${ed.title} has characters that this encoding cannot store.`,
    buttons: ['Save as UTF-8', 'Cancel'],
  });
  if (choice !== 'Save as UTF-8') return false;
  ed.meta.encoding = 'utf-8';
  ed.meta.bom = false;
  return true;
}

async function saveAs(host: EngineHost, ed: FileEditorImpl): Promise<boolean> {
  const { ctx } = host;
  let target: string | null;
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const root = ctx.workspace.root;
    // A draft lives in the app folder. Offer the open folder (if any) as the place.
    const defaultPath = ed.isDraft ? (root ? joinPath(root, basename(ed.path)) : basename(ed.path)) : ed.path;
    target = await save({ title: 'Save As', defaultPath });
  } catch (e) {
    ctx.ui.notify(`Could not open the save dialog: ${message(e)}`, { kind: 'error' });
    return false;
  }
  if (!target) return false;

  applyFormatting(host, ed);
  const doc = ed.view.state.doc;
  const text = doc.toString();
  let result: WriteFileResult;
  for (;;) {
    ed.saving = true;
    try {
      result = await fsWriteFile(target, text, {
        encoding: ed.meta.encoding,
        bom: ed.meta.bom,
        lineEnding: ed.meta.lineEnding,
        expectedMtimeMs: null,
      });
      ed.saving = false;
      break;
    } catch (e) {
      ed.saving = false;
      if (isIpcError(e, 'unmappable') && (await offerUtf8(host, ed))) continue;
      if (!isIpcError(e, 'unmappable')) ctx.ui.notify(`Could not save ${target}: ${message(e)}`, { kind: 'error' });
      return false;
    }
  }

  ctx.bus.emit('file:saved', { path: target });
  if (samePath(target, ed.path)) {
    ed.meta.mtimeMs = result.mtimeMs;
    ed.meta.size = result.size;
    ed.markClean(doc);
    ed.resumeAutosave();
    host.statusChanged(ed);
    return true;
  }
  // The tab id contains the path. Close this tab and open the new file at the same place.
  const wasDraft = ed.isDraft;
  const oldPath = ed.path;
  ed.markClean(doc);
  await replaceTab(host, ed, target);
  // The text is in the new file now. The draft file is not needed any more.
  if (wasDraft) {
    await deleteDraftFile(oldPath).catch((e) => ctx.ui.notify(`Could not delete the draft file: ${message(e)}`, { kind: 'warn' }));
  }
  return true;
}

/** Applies `files.trimTrailingWhitespace` and `files.insertFinalNewline` to the document. */
function applyFormatting(host: EngineHost, ed: FileEditorImpl): void {
  const s = host.ctx.settings;
  const doc = ed.view.state.doc;
  const changes: TextChange[] = [];
  // In a patch, a trailing space can be the context of an empty line.
  if (s.get('files.trimTrailingWhitespace') && ed.languageId !== 'diff') changes.push(...trailingWhitespaceChanges(doc));
  if (s.get('files.insertFinalNewline')) {
    const change = finalNewlineChange(doc);
    if (change) changes.push(change);
  }
  if (changes.length) ed.view.dispatch({ changes, annotations: programmatic.of(true) });
}
