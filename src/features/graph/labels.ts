// When a label shows and how big it is. Pure functions.

/** Draw at most this many labels in one frame (the nodes with the most links win). */
export const MAX_LABELS = 400;

/** Labels that would be smaller than this on the screen (before the text fade shift) are hidden, in px. */
const MIN_FONT_PX = 6.5;

/** Font size of a label in screen pixels. It shrinks with the zoom, a little slower than the picture. */
export function labelFontPx(zoom: number): number {
  return Math.min(14, 11 * Math.pow(zoom, 0.7));
}

/**
 * Label opacity from 0 to 1. A label is hidden when its font would be smaller
 * than 6.5 px, and fully visible at 40% more than that. `textFade` moves the
 * limit: +1 doubles it, -1 halves it. Nodes with many links count as bigger.
 */
export function labelAlpha(zoom: number, textFade: number, degree: number): number {
  const min = MIN_FONT_PX * Math.pow(2, textFade / 1.5);
  const px = labelFontPx(zoom) * (1 + 0.08 * Math.sqrt(Math.max(0, degree)));
  const a = (px - min) / (min * 0.4);
  return a <= 0 ? 0 : a >= 1 ? 1 : a;
}
