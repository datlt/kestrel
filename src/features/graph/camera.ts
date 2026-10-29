// Camera math for the graph canvas. Pure functions, no DOM.
//
// A camera is the graph point at the center of the canvas and a zoom factor.
// Screen coordinates are in CSS pixels, with 0, 0 at the top left of the canvas.

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.25;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function toScreen(c: Camera, w: number, h: number, gx: number, gy: number): [number, number] {
  return [(gx - c.x) * c.zoom + w / 2, (gy - c.y) * c.zoom + h / 2];
}

export function toGraph(c: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  return [(sx - w / 2) / c.zoom + c.x, (sy - h / 2) / c.zoom + c.y];
}

/** Zooms by `factor` and keeps the graph point under the screen point `sx, sy` where it is. */
export function zoomAt(c: Camera, w: number, h: number, sx: number, sy: number, factor: number): Camera {
  const zoom = clampZoom(c.zoom * factor);
  const [gx, gy] = toGraph(c, w, h, sx, sy);
  return { zoom, x: gx - (sx - w / 2) / zoom, y: gy - (sy - h / 2) / zoom };
}

/** Moves the picture by a drag of `dx, dy` screen pixels. */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x - dx / c.zoom, y: c.y - dy / c.zoom };
}

/** Bounds of the points `pos[2i], pos[2i+1]`. `indices` limits it to some points. Null when there are none. */
export function boundsOf(pos: ArrayLike<number>, indices?: ArrayLike<number> | null, count?: number): Bounds | null {
  const n = indices ? indices.length : (count ?? Math.floor(pos.length / 2));
  if (n === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    const x = pos[i * 2];
    const y = pos[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** The camera that shows `b` inside a canvas of `w` x `h` with a margin in pixels. */
export function fitBounds(b: Bounds, w: number, h: number, margin = 48, maxZoom = 2.5): Camera {
  const bw = Math.max(b.maxX - b.minX, 1);
  const bh = Math.max(b.maxY - b.minY, 1);
  const zoom = clampZoom(Math.min(maxZoom, Math.max(w - margin * 2, 40) / bw, Math.max(h - margin * 2, 40) / bh));
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom };
}

/** Between two cameras. The zoom changes in log space, so it feels even. */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t) };
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.zoom / b.zoom - 1) < 0.0005;
}

/** Graph rectangle that is visible, with a margin in graph units. */
export function visibleRect(c: Camera, w: number, h: number, margin = 0): Bounds {
  const hw = w / 2 / c.zoom + margin;
  const hh = h / 2 / c.zoom + margin;
  return { minX: c.x - hw, maxX: c.x + hw, minY: c.y - hh, maxY: c.y + hh };
}

export const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
