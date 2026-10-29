// Pure helpers for the Markdown preview layout: the text width and the copy
// text of code blocks. They have no DOM code, so tests can run them in node.

/** Left and right padding of the text column (32 px each side), in CSS px. */
export const PAGE_PADDING = 64;
/** The smallest text width. Smaller values count as this. */
export const MIN_TEXT_WIDTH = 320;
/** Width used when a saved value is not a valid number. */
export const DEFAULT_TEXT_WIDTH = 900;

/**
 * Turn a saved value into a valid text width.
 * 0 means full width. 1 to 319 count as 320. Values are rounded.
 * A value that is not a finite number, or is negative, gives the default (900).
 */
export function normalizeWidth(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return DEFAULT_TEXT_WIDTH;
  const n = Math.round(v);
  if (n === 0) return 0;
  return Math.max(MIN_TEXT_WIDTH, n);
}

/** CSS `max-width` of the page element for a text width. */
export function pageMaxWidth(width: number): string {
  return width <= 0 ? 'none' : `${width + PAGE_PADDING}px`;
}

/**
 * Width while the user drags an edge. The page is centered, so the width changes
 * by twice the pointer movement. `dx` is in zoomed px, `startWidth` in CSS px.
 * `available` is the width of the view in CSS px. When the page would fill it,
 * the result is 0 (full width).
 */
export function dragWidth(startWidth: number, dx: number, side: 'l' | 'r', zoom: number, available: number): number {
  const z = zoom > 0 ? zoom : 1;
  const next = Math.round(startWidth + ((side === 'r' ? 2 : -2) * dx) / z);
  if (next + PAGE_PADDING >= available - 2) return 0;
  return Math.max(MIN_TEXT_WIDTH, next);
}

/** Text for the label that shows during a drag. */
export function widthLabel(width: number): string {
  return width <= 0 ? 'Full width' : `${width} px`;
}

/** Text to copy from a code block: the block text without one final line break. */
export function codeText(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}
