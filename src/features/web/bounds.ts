// Pure math for the native web view bounds.
//
// The web view sits over a placeholder element. Rust wants logical pixels
// relative to the window content. The page coordinates are CSS pixels, and
// the window zoom (`ui.zoom`, a web view zoom) makes one CSS pixel
// `zoom` logical pixels. The macOS title bar needs no extra offset, because
// the main web view already covers the whole window content.

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smaller areas count as "not visible" (a hidden tab has a 0 x 0 box). */
export const MIN_SIZE = 2;

const round = (n: number) => Math.round(n * 2) / 2;

/** Bounds for Rust, or null when the placeholder has no usable size. */
export function toLogicalBounds(rect: RectLike, zoom = 1): Bounds | null {
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = round(rect.width * z);
  const height = round(rect.height * z);
  if (width < MIN_SIZE || height < MIN_SIZE) return null;
  return { x: round(rect.left * z), y: round(rect.top * z), width, height };
}

export function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export const WEB_ZOOM_MIN = 0.5;
export const WEB_ZOOM_MAX = 3;

/** Next page zoom. step 1 = in, -1 = out, 0 = reset. Steps of 10%. */
export function nextWebZoom(current: number, step: 1 | -1 | 0): number {
  if (step === 0) return 1;
  const next = Math.round((current + step * 0.1) * 100) / 100;
  return Math.min(WEB_ZOOM_MAX, Math.max(WEB_ZOOM_MIN, next));
}

/** Everything that must be true before the native view is visible. */
export interface ShowState {
  /** The tab is the active tab of the editor area. */
  tabShown: boolean;
  /** The workbench is the visible workspace tab. */
  workbenchActive: boolean;
  /** The window is minimized or hidden. */
  windowHidden: boolean;
  /** A popup (quick pick, menu, dialog) is open. */
  overlayOpen: boolean;
}

export function shouldShow(s: ShowState): boolean {
  return s.tabShown && s.workbenchActive && !s.windowHidden && !s.overlayOpen;
}
