// The status bar item `preview.info` is shared by the image viewer and the CSV
// preview. Only the owner that set it may remove it, so one tab never removes
// the text of another tab. The owner is kept per workbench (per `ctx`).

import type { AppContext } from '../../core/types';

const STATUS_ID = 'preview.info';
const owners = new WeakMap<AppContext, string>();

/** Shows `text` for `owner`. With `null` it removes the item, but only when `owner` set it. */
export function setPreviewInfo(ctx: AppContext, owner: string, text: string | null, tooltip?: string): void {
  if (text) {
    owners.set(ctx, owner);
    ctx.status.set({ id: STATUS_ID, align: 'right', priority: 40, text, tooltip });
  } else if (owners.get(ctx) === owner) {
    owners.delete(ctx);
    ctx.status.remove(STATUS_ID);
  }
}
