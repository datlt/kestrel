import { describe, expect, it } from 'vitest';
import { clampUiZoom, nextUiZoom } from './zoom';

describe('window zoom', () => {
  it('steps by 10 percent without float noise', () => {
    expect(nextUiZoom(1, 1)).toBe(1.1);
    expect(nextUiZoom(1.1, 1)).toBe(1.2);
    expect(nextUiZoom(0.7, -1)).toBe(0.6);
  });

  it('resets to 1', () => {
    expect(nextUiZoom(2.3, 0)).toBe(1);
  });

  it('stays between 0.5 and 3', () => {
    expect(nextUiZoom(3, 1)).toBe(3);
    expect(nextUiZoom(0.5, -1)).toBe(0.5);
    expect(clampUiZoom(NaN)).toBe(1);
  });
});
