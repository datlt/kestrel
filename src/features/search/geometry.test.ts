import { describe, expect, it } from 'vitest';
import { MIN_SIZE, clampGeometry, clampSplit, defaultGeometry, loadGeometry, resizeGeometry } from './geometry';

const area = { w: 1200, h: 800 };

describe('clampGeometry', () => {
  it('moves a popup that sticks out back inside', () => {
    expect(clampGeometry({ x: 1000, y: 700, w: 600, h: 400 }, area)).toEqual({ x: 600, y: 400, w: 600, h: 400 });
    expect(clampGeometry({ x: -50, y: -9, w: 600, h: 400 }, area)).toEqual({ x: 0, y: 0, w: 600, h: 400 });
  });
  it('shrinks a popup that is too big and raises one that is too small', () => {
    expect(clampGeometry({ x: 0, y: 0, w: 5000, h: 5000 }, area)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
    const g = clampGeometry({ x: 0, y: 0, w: 10, h: 10 }, area);
    expect([g.w, g.h]).toEqual([MIN_SIZE.w, MIN_SIZE.h]);
  });
  it('fits a window that is smaller than the minimum size', () => {
    expect(clampGeometry({ x: 5, y: 5, w: 600, h: 400 }, { w: 400, h: 300 })).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
});

describe('defaultGeometry', () => {
  it('is centered and inside the area', () => {
    const g = defaultGeometry(area);
    expect(g.w).toBe(960);
    expect(g.x).toBe(120);
    expect(g.y + g.h).toBeLessThanOrEqual(area.h);
  });
});

describe('resizeGeometry', () => {
  const start = { x: 100, y: 100, w: 600, h: 400 };
  it('grows to the right and down', () => {
    expect(resizeGeometry(start, 'se', 50, 30, area)).toEqual({ x: 100, y: 100, w: 650, h: 430 });
  });
  it('keeps the right side when the left edge moves', () => {
    expect(resizeGeometry(start, 'w', -40, 0, area)).toEqual({ x: 60, y: 100, w: 640, h: 400 });
    expect(resizeGeometry(start, 'w', 500, 0, area)).toEqual({ x: 140, y: 100, w: MIN_SIZE.w, h: 400 });
  });
  it('stops at the area', () => {
    expect(resizeGeometry(start, 'e', 9999, 0, area).w).toBe(1100);
    expect(resizeGeometry(start, 'n', 0, -9999, area)).toMatchObject({ y: 0, h: 500 });
  });
});

describe('loadGeometry and clampSplit', () => {
  it('rejects bad data', () => {
    expect(loadGeometry(null)).toBeNull();
    expect(loadGeometry({ x: 1, y: 2, w: 'a', h: 4 })).toBeNull();
    expect(loadGeometry({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
  it('limits the split', () => {
    expect(clampSplit(0)).toBe(0.15);
    expect(clampSplit(2)).toBe(0.85);
    expect(clampSplit(NaN)).toBe(0.45);
  });
});
