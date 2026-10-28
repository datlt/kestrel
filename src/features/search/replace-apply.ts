// Writes a replace to disk or to open editors.
//
// Open files change through their editor: one CodeMirror transaction for the
// whole file, so Undo works and the normal auto save runs. Other files are
// read and written through `src/ipc/fs.ts`. The write sends the mtime of the
// read, so a file that changed on disk in between is skipped.

import type { AppContext } from '../../core/types';
import { fsReadFile, fsWriteFile } from '../../ipc/fs';
import { isIpcError } from '../../ipc/invoke';
import { planEdits, applyEdits, type Target } from './apply';
import type { ReplaceOptions } from './pattern';

export interface ReplaceJob {
  path: string;
  targets: Target[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ReplaceReport {
  /** Matches that were replaced. */
  replaced: number;
  /** Files that changed. */
  files: number;
  /** Matches that were not in the text any more. */
  missed: number;
  skipped: SkippedFile[];
  /** Open files that changed but are not saved yet. */
  unsaved: string[];
}

const MAX_BYTES = 20 * 1024 * 1024;
const PARALLEL = 4;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Outcome = { replaced: number; missed: number; skipped?: string; unsaved?: boolean };

async function replaceInEditor(ctx: AppContext, job: ReplaceJob, re: RegExp, opts: ReplaceOptions): Promise<Outcome | null> {
  const ed = ctx.editors.get(job.path);
  if (!ed) return null;
  if (ed.meta.readonly) return { replaced: 0, missed: 0, skipped: 'The file is read-only.' };
  const doc = ed.view.state.doc.toString();
  const plan = planEdits(doc, job.targets, re, opts);
  if (plan.edits.length) {
    // `changes` use positions of the old text, so one dispatch is enough.
    ed.view.dispatch({
      changes: plan.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
      userEvent: 'input.replace',
    });
  }
  return { replaced: plan.edits.length, missed: plan.missed, unsaved: plan.edits.length > 0 && ed.isDirty() };
}

async function replaceOnDisk(job: ReplaceJob, re: RegExp, opts: ReplaceOptions): Promise<Outcome> {
  const res = await fsReadFile(job.path, { maxBytes: MAX_BYTES });
  if (res.binary) return { replaced: 0, missed: 0, skipped: 'The file is binary.' };
  if (res.tooLarge) return { replaced: 0, missed: 0, skipped: 'The file is too large.' };
  if (res.lossy) return { replaced: 0, missed: 0, skipped: `Some bytes are not valid ${res.encoding}. Saving would change them.` };
  if (res.readonly) return { replaced: 0, missed: 0, skipped: 'The file is read-only.' };
  if (res.mixedLineEndings) return { replaced: 0, missed: 0, skipped: 'The file mixes line endings. Saving would change them.' };
  // The read keeps the line endings of the file. The plan works on `\n`, and the write adds them again.
  const text = res.text.replace(/\r\n?/g, '\n');
  const plan = planEdits(text, job.targets, re, opts);
  if (!plan.edits.length) return { replaced: 0, missed: plan.missed };
  try {
    await fsWriteFile(job.path, applyEdits(text, plan.edits), {
      encoding: res.encoding,
      bom: res.bom,
      lineEnding: res.lineEnding,
      expectedMtimeMs: res.mtimeMs,
    });
  } catch (e) {
    if (isIpcError(e, 'conflict')) return { replaced: 0, missed: 0, skipped: 'The file changed on disk during the replace.' };
    if (isIpcError(e, 'unmappable')) return { replaced: 0, missed: 0, skipped: `${res.encoding} cannot store the new text.` };
    throw e;
  }
  return { replaced: plan.edits.length, missed: plan.missed };
}

export async function runReplace(
  ctx: AppContext,
  jobs: readonly ReplaceJob[],
  re: RegExp,
  opts: ReplaceOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<ReplaceReport> {
  const report: ReplaceReport = { replaced: 0, files: 0, missed: 0, skipped: [], unsaved: [] };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const out = (await replaceInEditor(ctx, job, re, opts)) ?? (await replaceOnDisk(job, re, opts));
        report.missed += out.missed;
        if (out.skipped) report.skipped.push({ path: job.path, reason: out.skipped });
        if (out.replaced > 0) {
          report.replaced += out.replaced;
          report.files++;
          if (out.unsaved) report.unsaved.push(job.path);
        }
      } catch (e) {
        report.skipped.push({ path: job.path, reason: message(e) });
      }
      onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  return report;
}
