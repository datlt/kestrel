// Files and workspace feature. Owner: files.
//
//   workspace.ts  WorkspaceService (open folder, sessions, title via ctx.window)
//   state.ts      JSON stores for per-folder and global state
//   watcher.ts    Rust file watcher events -> bus `fs:changed`
//   tree.ts       explorer tree model (one folder level at a time)
//   explorer.ts   explorer view
//   ops.ts        rename and delete with open tabs
//   commands.ts   commands of docs/DESIGN.md section 6
//   dnd.ts        drag and drop onto the window (visible workbench only)

import type { AppContext } from '../../core/types';
import { registerFileCommands } from './commands';
import { startDragDrop } from './dnd';
import { createExplorer } from './explorer';
import { startWatcherBridge } from './watcher';

export { createWorkspaceService, whenStateReady } from './workspace';

/** Registers the explorer view, file commands and the watcher bridge. */
export function initFiles(ctx: AppContext): void {
  const explorer = createExplorer(ctx);
  ctx.views.register(explorer.descriptor());
  registerFileCommands(ctx, explorer);
  startWatcherBridge(ctx);
  startDragDrop(ctx);
}
