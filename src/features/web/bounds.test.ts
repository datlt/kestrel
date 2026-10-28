import { describe, expect, it } from 'vitest';
import { nextWebZoom, sameBounds, shouldShow, toLogicalBounds } from './bounds';

describe('toLogicalBounds', () => {
  it('copies the box at zoom 1', () => {
    expect(toLogicalBounds({ left: 10, top: 80, width: 600, height: 400 })).toEqual({ x: 10, y: 80, width: 600, height: 400 });
  });
  it('multiplies by the window zoom', () => {
    expect(toLogicalBounds({ left: 100, top: 50, width: 500, height: 300 }, 1.2)).toEqual({ x: 120, y: 60, width: 600, height: 360 });
  });
  it('rounds to half pixels', () => {
    expect(toLogicalBounds({ left: 10.26, top: 0.74, width: 100.1, height: 50.9 })).toEqual({ x: 10.5, y: 0.5, width: 100, height: 51 });
  });
  it('returns null for hidden or tiny boxes', () => {
    expect(toLogicalBounds({ left: 0, top: 0, width: 0, height: 0 })).toBeNull();
    expect(toLogicalBounds({ left: 0, top: 0, width: 1, height: 300 })).toBeNull();
    expect(toLogicalBounds({ left: 0, top: 0, width: NaN, height: 300 })).toBeNull();
  });
  it('treats a bad zoom as 1', () => {
    expect(toLogicalBounds({ left: 1, top: 1, width: 10, height: 10 }, 0)).toEqual({ x: 1, y: 1, width: 10, height: 10 });
  });
});

describe('sameBounds', () => {
  it('compares values and nulls', () => {
    const a = { x: 1, y: 2, width: 3, height: 4 };
    expect(sameBounds(a, { ...a })).toBe(true);
    expect(sameBounds(a, { ...a, width: 5 })).toBe(false);
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(a, null)).toBe(false);
  });
});

describe('nextWebZoom', () => {
  it('steps by 10 percent inside the limits', () => {
    expect(nextWebZoom(1, 1)).toBe(1.1);
    expect(nextWebZoom(1, -1)).toBe(0.9);
    expect(nextWebZoom(1.7, 0)).toBe(1);
    expect(nextWebZoom(3, 1)).toBe(3);
    expect(nextWebZoom(0.5, -1)).toBe(0.5);
  });
});

describe('shouldShow', () => {
  const all = { tabShown: true, workbenchActive: true, windowHidden: false, overlayOpen: false };
  it('shows only when every condition is fine', () => {
    expect(shouldShow(all)).toBe(true);
    expect(shouldShow({ ...all, tabShown: false })).toBe(false);
    expect(shouldShow({ ...all, workbenchActive: false })).toBe(false);
    expect(shouldShow({ ...all, windowHidden: true })).toBe(false);
    expect(shouldShow({ ...all, overlayOpen: true })).toBe(false);
  });
});
