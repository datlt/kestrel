// Counts the popups (quick pick, palette, menu, dialog) that are open on one
// target. The target is the overlay layer of a workbench, or `document` for the
// workspace strip menu. When the count goes from 0 to 1, or from 1 to 0, it
// sends the DOM event `kestrel:overlay` with `detail: { open }`. The event
// bubbles. The web feature listens for it and sends `overlay:changed` on the
// bus of the workbench (native web views sit above the page and must hide).

export const OVERLAY_EVENT = 'kestrel:overlay';

const counts = new WeakMap<EventTarget, number>();

function send(target: EventTarget, open: boolean) {
  target.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { bubbles: true, detail: { open } }));
}

/** Call after a popup was added to the page. */
export function overlayOpened(target: EventTarget): void {
  const n = (counts.get(target) ?? 0) + 1;
  counts.set(target, n);
  if (n === 1) send(target, true);
}

/** Call after a popup was removed from the page. */
export function overlayClosed(target: EventTarget): void {
  const n = Math.max(0, (counts.get(target) ?? 0) - 1);
  counts.set(target, n);
  if (n === 0) send(target, false);
}
