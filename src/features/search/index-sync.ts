// Keeps the Rust file index in sync with the open folder.

import type { AppContext } from '../../core/types';
import { debounce, samePath } from '../../core/util';
import { searchIndexStatus, searchIndexUpdate } from '../../ipc/search';

/** More changed paths than this: rebuild the index instead. */
const MAX_PATHS = 5000;
const FLUSH_MS = 400;

function warn(what: string, e: unknown): void {
  console.warn(`search index: ${what} failed`, e);
}

export function startIndexSync(ctx: AppContext): void {
  const pending = new Set<string>();
  let rescan = false;

  const flush = debounce(() => {
    const root = ctx.workspace.root;
    if (!root) return;
    const paths = rescan ? [] : [...pending];
    const full = rescan;
    pending.clear();
    rescan = false;
    searchIndexUpdate(root, paths, full).catch((e) => warn('update', e));
  }, FLUSH_MS);

  function start(root: string | null): void {
    flush.cancel();
    pending.clear();
    rescan = false;
    // The first call makes Rust build the index in a background thread.
    if (root) searchIndexStatus(root).catch((e) => warn('start', e));
  }

  ctx.bus.on('workspace:changed', ({ root }) => start(root));
  ctx.bus.on('fs:changed', (e) => {
    const root = ctx.workspace.root;
    if (!root || !samePath(e.root, root)) return;
    if (e.rescan) {
      rescan = true;
    } else if (!rescan) {
      for (const p of e.paths) pending.add(p);
      if (pending.size > MAX_PATHS) {
        rescan = true;
        pending.clear();
      }
    }
    if (rescan || pending.size) flush();
  });

  ctx.bus.on('workbench:disposing', () => {
    flush.cancel();
    pending.clear();
  });

  if (ctx.workspace.root) start(ctx.workspace.root);
}
