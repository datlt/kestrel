// Forwards the watcher events of Rust to the event bus.

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { AppContext, FsChangeEvent } from '../../core/types';
import { samePath } from '../../core/util';

const EVENT = 'kestrel://fs-changed';

/**
 * Listens on this window. All workbenches of the window get every event, so each
 * one keeps only the events of its own root. Stops on `workbench:disposing`.
 */
export function startWatcherBridge(ctx: AppContext): void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  getCurrentWebviewWindow()
    .listen<FsChangeEvent>(EVENT, (e) => {
      const root = ctx.workspace.root;
      if (!root || !samePath(e.payload.root, root)) return;
      ctx.bus.emit('fs:changed', e.payload);
    })
    .then((fn) => {
      // The workbench can close before the listener is ready.
      if (stopped) fn();
      else unlisten = fn;
    })
    .catch((err) => console.warn('cannot listen for file changes', err));
  ctx.bus.on('workbench:disposing', () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  });
}
