import { describe, expect, it } from 'vitest';
import { codeText, dragWidth, normalizeWidth, pageMaxWidth, widthLabel } from './markdown-layout';

describe('normalizeWidth', () => {
  it('keeps 0 and normal values', () => {
    expect(normalizeWidth(0)).toBe(0);
    expect(normalizeWidth(900)).toBe(900);
    expect(normalizeWidth(320)).toBe(320);
  });
  it('raises small values to 320', () => {
    expect(normalizeWidth(1)).toBe(320);
    expect(normalizeWidth(319)).toBe(320);
  });
  it('rounds', () => {
    expect(normalizeWidth(500.4)).toBe(500);
    expect(normalizeWidth(500.6)).toBe(501);
    expect(normalizeWidth(0.4)).toBe(0);
  });
  it('uses the default for invalid values', () => {
    for (const v of ['800', null, undefined, NaN, Infinity, -5, {}]) expect(normalizeWidth(v)).toBe(900);
  });
});

describe('pageMaxWidth', () => {
  it('adds the padding', () => {
    expect(pageMaxWidth(900)).toBe('964px');
  });
  it('gives none for full width', () => {
    expect(pageMaxWidth(0)).toBe('none');
  });
});

describe('dragWidth', () => {
  it('doubles the movement of the right edge', () => {
    expect(dragWidth(900, 50, 'r', 1, 5000)).toBe(1000);
    expect(dragWidth(900, -50, 'r', 1, 5000)).toBe(800);
  });
  it('reverses the left edge', () => {
    expect(dragWidth(900, -50, 'l', 1, 5000)).toBe(1000);
    expect(dragWidth(900, 50, 'l', 1, 5000)).toBe(800);
  });
  it('divides by the zoom', () => {
    expect(dragWidth(900, 100, 'r', 2, 5000)).toBe(1000);
  });
  it('clamps to the minimum', () => {
    expect(dragWidth(400, -500, 'r', 1, 5000)).toBe(320);
  });
  it('gives 0 near the full view width', () => {
    expect(dragWidth(900, 400, 'r', 1, 1000)).toBe(0);
    expect(dragWidth(900, 17, 'r', 1, 1000)).toBe(0);
    expect(dragWidth(900, 10, 'r', 1, 1000)).toBe(920);
  });
  it('ignores a zoom of 0', () => {
    expect(dragWidth(900, 50, 'r', 0, 5000)).toBe(1000);
  });
});

describe('widthLabel', () => {
  it('formats', () => {
    expect(widthLabel(1200)).toBe('1200 px');
    expect(widthLabel(0)).toBe('Full width');
  });
});

describe('codeText', () => {
  it('removes one final line break', () => {
    expect(codeText('a\nb\n')).toBe('a\nb');
    expect(codeText('a\n\n')).toBe('a\n');
  });
  it('keeps text without a final line break', () => {
    expect(codeText('a')).toBe('a');
    expect(codeText('')).toBe('');
  });
});
