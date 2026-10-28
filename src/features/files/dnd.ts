// Drag and drop of files and folders onto the window (Tauri drag-drop events).
// Every workbench listens, but only the visible one acts on a drop.

import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { AppContext } from '../../core/types';
import { fsStat } from '../../ipc/fs';

const DRAG_CLASS = 'files-dragging';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function startDragDrop(ctx: AppContext): void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  getCurrentWebview()
    .onDragDropEvent(async (event) => {
      const p = event.payload;
      if (!ctx.window.isActive()) return;
      if (p.type === 'enter') {
        document.documentElement.classList.add(DRAG_CLASS);
        return;
      }
      // `over` arrives many times while the user drags. Keep the highlight then.
      if (p.type === 'over') return;
      document.documentElement.classList.remove(DRAG_CLASS);
      if (p.type !== 'drop') return;
      let folder: string | null = null;
      const files: string[] = [];
      for (const path of p.paths) {
        try {
          const st = await fsStat(path);
          if (!st.exists) continue;
          if (st.isDir) folder ??= path;
          else files.push(path);
        } catch {
          // Skip paths we cannot read.
        }
      }
      if (folder) {
        // The window manager shows the folder in a workspace tab. Files of the same drop are not opened,
        // because the visible tab can change.
        try {
          await ctx.window.openFolder(folder);
        } catch (e) {
          ctx.ui.notify(`Cannot open ${folder}: ${errorText(e)}`, { kind: 'error' });
        }
        return;
      }
      for (const f of files) {
        try {
          await ctx.editors.openFile(f);
        } catch (e) {
          ctx.ui.notify(`Cannot open ${f}: ${errorText(e)}`, { kind: 'error' });
        }
      }
    })
    .then((fn) => {
      if (stopped) fn();
      else unlisten = fn;
    })
    .catch((e) => console.warn('cannot listen for drag and drop', e));
  ctx.bus.on('workbench:disposing', () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  });
  // Another tab can become visible during a drag. Remove the highlight then.
  ctx.bus.on('workbench:deactivated', () => document.documentElement.classList.remove(DRAG_CLASS));
}
