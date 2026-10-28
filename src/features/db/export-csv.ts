// "Download CSV" for a result table. Loaded with `import()` the first time
// the user downloads something.
//
// Two ways to get the data:
// - "Rows shown": the rows that are in memory. They are written by the file service.
// - "All rows": only when the result was cut off and the statement only reads
//   data. Rust runs the statement again and streams every row into the file.

import type { AppContext } from '../../core/types';
import { platform } from '../../core/util';
import type { DbValue } from '../../ipc/db';
import { fsWriteFile } from '../../ipc/fs';
import { describeError } from './errors';
import { ALL_ROWS_LABEL, baseName, canExportAll, csvFileName, exportBaseName, revealLabel, shownRowsLabel } from './export-model';
import { toCsv } from './grid-data';
import type { ResultEntry } from './results-store';

/** Where the pane shows that an export runs. */
export interface ExportProgress {
  start(text: string, cancel: () => void): void;
  stop(): void;
}

export interface DownloadOptions {
  ctx: AppContext;
  entry: ResultEntry;
  /** The rows in memory, in the order of the grid (sorted when the user sorted). */
  rows: DbValue[][];
  progress: ExportProgress;
}

/** The Downloads folder plus the file name. Without a Downloads folder (browser dev mode), only the name. */
async function suggestedPath(name: string): Promise<string> {
  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path');
    return await join(await downloadDir(), name);
  } catch {
    return name;
  }
}

export async function downloadCsv(o: DownloadOptions): Promise<void> {
  const { ctx, entry, rows, progress } = o;
  const result = entry.result;
  const exporter = entry.exporter;
  const all = !!exporter && canExportAll(entry.sql, result.truncated);

  // A cut-off result: the user decides how much to save.
  let mode: 'shown' | 'all' = 'shown';
  if (result.truncated && all) {
    const answer = await ctx.ui.confirm({
      title: 'This result was cut off',
      message: `The table shows ${rows.length.toLocaleString('en-US')} rows, but the query has more. Which rows do you want to save?`,
      buttons: [shownRowsLabel(rows.length), ALL_ROWS_LABEL, 'Cancel'],
    });
    if (answer === ALL_ROWS_LABEL) mode = 'all';
    else if (answer !== shownRowsLabel(rows.length)) return;
    if (mode === 'all' && exporter?.busy()) {
      ctx.ui.notify('The connection is busy. Wait for the running statement or cancel it.', { kind: 'warn' });
      return;
    }
  }

  const fileName = csvFileName(exportBaseName(result.columns));
  let path: string | null;
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    path = await save({ title: 'Download as CSV', defaultPath: await suggestedPath(fileName), filters: [{ name: 'CSV', extensions: ['csv'] }] });
  } catch (e) {
    ctx.ui.notify(`Could not open the file dialog: ${describeError(e).text}`, { kind: 'error' });
    return;
  }
  if (!path) return;
  const saved = baseName(path);

  try {
    let count: number;
    if (mode === 'all' && exporter) {
      progress.start(`Saving all rows to ${saved}...`, () => exporter.cancel());
      try {
        count = (await exporter.exportAll(entry.sql, path)).rows;
      } finally {
        progress.stop();
      }
    } else {
      // A byte order mark helps Excel to read UTF-8.
      await fsWriteFile(path, toCsv(result.columns, rows), { encoding: 'utf-8', bom: true, lineEnding: 'crlf', expectedMtimeMs: null });
      count = rows.length;
    }
    const note = mode === 'shown' && result.truncated && !all ? ' Only the shown rows are in the file. This statement cannot run again.' : '';
    const target = path;
    ctx.ui.notify(`Saved ${count.toLocaleString('en-US')} rows to ${saved}.${note}`, {
      timeoutMs: 8000,
      actions: [{ label: revealLabel(platform), run: () => void reveal(ctx, target) }],
    });
  } catch (e) {
    const d = describeError(e);
    if (d.kind === 'cancelled') ctx.ui.notify('Download cancelled. No file was kept.', { kind: 'info', timeoutMs: 4000 });
    else ctx.ui.notify(`Could not save the CSV file: ${d.text}`, { kind: 'error' });
  }
}

async function reveal(ctx: AppContext, path: string): Promise<void> {
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  } catch (e) {
    ctx.ui.notify(`Could not show the file: ${describeError(e).text}`, { kind: 'error' });
  }
}
