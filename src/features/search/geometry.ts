// Position and size of the popup, and the split between list and preview.

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_SIZE: Size = { w: 560, h: 380 };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Centered, about 80% of the area, at most 960 x 700. */
export function defaultGeometry(area: Size): Geometry {
  const w = Math.round(Math.min(960, area.w * 0.8));
  const h = Math.round(Math.min(700, area.h * 0.8));
  return clampGeometry({ x: Math.round((area.w - w) / 2), y: Math.round((area.h - h) / 3), w, h }, area);
}

/** Keeps the popup inside the area. The popup shrinks when the area is small. */
export function clampGeometry(g: Geometry, area: Size, min: Size = MIN_SIZE): Geometry {
  const w = clamp(Math.round(g.w), Math.min(min.w, area.w), area.w);
  const h = clamp(Math.round(g.h), Math.min(min.h, area.h), area.h);
  return { x: clamp(Math.round(g.x), 0, area.w - w), y: clamp(Math.round(g.y), 0, area.h - h), w, h };
}

/** Reads a saved geometry. Returns null when it is not valid. */
export function loadGeometry(raw: unknown): Geometry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const nums = [r.x, r.y, r.w, r.h];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
}

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Resizes from an edge or a corner. The opposite side stays where it is. */
export function resizeGeometry(start: Geometry, edge: Edge, dx: number, dy: number, area: Size, min: Size = MIN_SIZE): Geometry {
  let { x, y, w, h } = start;
  const minW = Math.min(min.w, area.w);
  const minH = Math.min(min.h, area.h);
  if (edge.includes('e')) w = clamp(start.w + dx, minW, area.w - start.x);
  if (edge.includes('s')) h = clamp(start.h + dy, minH, area.h - start.y);
  if (edge.includes('w')) {
    const right = start.x + start.w;
    w = clamp(start.w - dx, minW, right);
    x = right - w;
  }
  if (edge.includes('n')) {
    const bottom = start.y + start.h;
    h = clamp(start.h - dy, minH, bottom);
    y = bottom - h;
  }
  return { x, y, w, h };
}

/** Share of the body height for the list. */
export const DEFAULT_SPLIT = 0.45;

export function clampSplit(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0.15), 0.85) : DEFAULT_SPLIT;
}
