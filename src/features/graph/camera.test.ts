import { describe, expect, it } from 'vitest';
import { boundsOf, clampZoom, fitBounds, lerpCamera, MAX_ZOOM, MIN_ZOOM, panBy, toGraph, toScreen, visibleRect, zoomAt } from './camera';
import { appendBasis } from './spline';
import { approach, lerpPositions } from './animate';

describe('camera', () => {
  const cam = { x: 100, y: -50, zoom: 2 };
  it('converts between screen and graph', () => {
    const [sx, sy] = toScreen(cam, 800, 600, 120, -40);
    expect(sx).toBeCloseTo(440);
    expect(sy).toBeCloseTo(320);
    const [gx, gy] = toGraph(cam, 800, 600, sx, sy);
    expect(gx).toBeCloseTo(120);
    expect(gy).toBeCloseTo(-40);
  });
  it('keeps the point under the cursor when zooming', () => {
    const before = toGraph(cam, 800, 600, 200, 150);
    const next = zoomAt(cam, 800, 600, 200, 150, 1.5);
    expect(next.zoom).toBeCloseTo(3);
    const after = toGraph(next, 800, 600, 200, 150);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });
  it('clamps the zoom', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(zoomAt(cam, 800, 600, 0, 0, 1000).zoom).toBe(MAX_ZOOM);
  });
  it('pans with the drag', () => {
    const p = panBy(cam, 20, -10);
    expect(p.x).toBeCloseTo(90);
    expect(p.y).toBeCloseTo(-45);
  });
  it('finds bounds and fits them', () => {
    const pos = new Float64Array([0, 0, 100, 50, -20, 80]);
    expect(boundsOf(pos)).toEqual({ minX: -20, minY: 0, maxX: 100, maxY: 80 });
    expect(boundsOf(pos, [1])).toEqual({ minX: 100, minY: 50, maxX: 100, maxY: 50 });
    expect(boundsOf(new Float64Array(0))).toBeNull();
    const c = fitBounds({ minX: -500, minY: -250, maxX: 500, maxY: 250 }, 1000, 600, 50);
    expect(c.x).toBeCloseTo(0);
    expect(c.zoom).toBeCloseTo(0.9);
  });
  it('does not zoom in too far for one point', () => {
    expect(fitBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 800, 600).zoom).toBeLessThanOrEqual(2.5);
  });
  it('interpolates the zoom in log space', () => {
    const m = lerpCamera({ x: 0, y: 0, zoom: 1 }, { x: 10, y: 10, zoom: 4 }, 0.5);
    expect(m.zoom).toBeCloseTo(2);
    expect(m.x).toBeCloseTo(5);
  });
  it('gives the visible rectangle', () => {
    const r = visibleRect({ x: 0, y: 0, zoom: 2 }, 400, 200, 10);
    expect(r.maxX).toBeCloseTo(110);
    expect(r.maxY).toBeCloseTo(60);
  });
});

describe('animate', () => {
  it('goes from the start to the end', () => {
    const out = new Float64Array(2);
    const from = new Float64Array([0, 0]);
    const to = new Float64Array([10, -10]);
    expect(Array.from(lerpPositions(from, to, 0, out))).toEqual([0, 0]);
    expect(Array.from(lerpPositions(from, to, 0.5, out))).toEqual([5, -5]);
    expect(Array.from(lerpPositions(from, to, 1, out))).toEqual([10, -10]);
  });
  it('approaches a target without passing it', () => {
    expect(approach(0, 1, 50, 100)).toBeCloseTo(0.5);
    expect(approach(0.9, 1, 50, 100)).toBe(1);
    expect(approach(0.2, 0, 50, 100)).toBe(0);
  });
});

describe('appendBasis', () => {
  function record(pts: number[]) {
    const calls: string[] = [];
    appendBasis(
      {
        moveTo: (x, y) => calls.push(`M${x},${y}`),
        lineTo: (x, y) => calls.push(`L${x},${y}`),
        bezierCurveTo: (_a, _b, _c, _d, x, y) => calls.push(`C${+x.toFixed(2)},${+y.toFixed(2)}`),
      },
      pts,
    );
    return calls;
  }
  it('draws nothing for one point and a line for two', () => {
    expect(record([1, 1])).toEqual([]);
    expect(record([0, 0, 5, 5])).toEqual(['M0,0', 'L5,5']);
  });
  it('starts at the first point and ends at the last point', () => {
    const calls = record([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(calls[0]).toBe('M0,0');
    expect(calls[calls.length - 1]).toBe('L0,10');
  });
});
