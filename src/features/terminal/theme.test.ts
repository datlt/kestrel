import { describe, expect, it } from 'vitest';
import {
  DARK_ANSI,
  LIGHT_ANSI,
  MINIMUM_CONTRAST_RATIO,
  contrastRatio,
  fontFamilyFor,
  isDarkBackground,
  parseColor,
  themeFromVars,
} from './theme';

const DARK_BG = '#1f2023';
const LIGHT_BG = '#ffffff';
const NAMES = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

describe('themeFromVars', () => {
  it('takes background, text and selection from the variables', () => {
    const vars: Record<string, string> = { '--bg': '#ffffff', '--fg': '#111111', '--selection': 'rgba(1, 2, 3, 0.2)' };
    const t = themeFromVars((n) => vars[n] ?? '');
    expect(t.background).toBe('#ffffff');
    expect(t.foreground).toBe('#111111');
    expect(t.cursor).toBe('#111111');
    expect(t.cursorAccent).toBe('#ffffff');
    expect(t.selectionBackground).toBe('rgba(1, 2, 3, 0.2)');
  });

  it('uses fallbacks for missing variables', () => {
    const t = themeFromVars(() => '');
    expect(t.background).toBe(DARK_BG);
    expect(t.green).toBe(DARK_ANSI.green);
  });

  it('picks the dark palette on a dark background and the light palette on a light one', () => {
    expect(themeFromVars((n) => (n === '--bg' ? DARK_BG : '')).red).toBe(DARK_ANSI.red);
    expect(themeFromVars((n) => (n === '--bg' ? LIGHT_BG : '')).red).toBe(LIGHT_ANSI.red);
    expect(themeFromVars((n) => (n === '--bg' ? 'rgb(250, 250, 250)' : '')).brightGreen).toBe(LIGHT_ANSI.brightGreen);
  });

  it('does not use the colors of the UI for the ANSI colors', () => {
    const vars: Record<string, string> = { '--danger': '#123456', '--ok': '#234567', '--warn': '#345678' };
    const t = themeFromVars((n) => vars[n] ?? '');
    expect(t.red).not.toBe('#123456');
    expect(t.green).not.toBe('#234567');
    expect(t.yellow).not.toBe('#345678');
  });
});

describe('ANSI palettes', () => {
  for (const [label, palette, bg] of [
    ['dark', DARK_ANSI, DARK_BG],
    ['light', LIGHT_ANSI, LIGHT_BG],
  ] as const) {
    it(`${label}: every bright color differs from its normal color`, () => {
      for (const n of ['black', ...NAMES] as const) {
        const bright = `bright${n[0].toUpperCase()}${n.slice(1)}` as keyof typeof palette;
        expect(palette[bright], n).not.toBe(palette[n]);
      }
    });

    it(`${label}: the 16 colors are different from each other`, () => {
      expect(new Set(Object.values(palette)).size).toBe(16);
    });

    it(`${label}: colors are readable on the background (contrast >= ${MINIMUM_CONTRAST_RATIO})`, () => {
      const names = Object.keys(palette) as (keyof typeof palette)[];
      for (const n of names) {
        // `black` is a background color. xterm lifts it when it is used for text.
        if (n === 'black' && label === 'dark') continue;
        expect(contrastRatio(palette[n], bg), `${label} ${n} ${palette[n]}`).toBeGreaterThanOrEqual(MINIMUM_CONTRAST_RATIO);
      }
    });

    it(`${label}: all values are 6 digit hex colors`, () => {
      for (const c of Object.values(palette)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    });
  }
});

describe('color helpers', () => {
  it('parses hex and rgb values', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#1f2023')).toEqual([31, 32, 35]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseColor('red')).toBeNull();
  });

  it('computes the WCAG contrast ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(contrastRatio('nope', '#fff')).toBe(1);
  });

  it('tells dark from light backgrounds', () => {
    expect(isDarkBackground('#1f2023')).toBe(true);
    expect(isDarkBackground('#ffffff')).toBe(false);
    expect(isDarkBackground('')).toBe(true);
  });
});

describe('fontFamilyFor', () => {
  it('puts the editor font first and the mono variable after it', () => {
    expect(fontFamilyFor('"Fira Code", monospace', () => ' Menlo ')).toBe('"Fira Code", monospace, Menlo, monospace');
    expect(fontFamilyFor('', () => '')).toBe('monospace');
  });
});
