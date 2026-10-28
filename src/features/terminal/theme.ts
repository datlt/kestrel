// Terminal colors. The background, text, cursor and selection follow the theme
// variables in src/styles/vars.css. The 16 ANSI colors come from two fixed
// palettes (dark and light), so a program that prints "bright red" gets a color
// that differs from "red", and every color is readable on the terminal background.
// The palettes follow the look of the GitHub and VS Code terminal colors.

import type { ITheme } from '@xterm/xterm';

type VarReader = (name: string) => string;

/** The 16 ANSI colors of one palette. */
export type AnsiPalette = Pick<
  ITheme,
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
>;

/**
 * Colors for the dark theme (background #1f2023). Bright colors are lighter than
 * the normal ones. `black` is a dark gray: it is meant as a background color, and
 * xterm lifts it when a program uses it for text.
 */
export const DARK_ANSI = {
  black: '#4b5262',
  red: '#ee5d55',
  green: '#3fb950',
  yellow: '#d4a72c',
  blue: '#5a9cf5',
  magenta: '#c678dd',
  cyan: '#39b9c8',
  white: '#c9ccd1',
  brightBlack: '#8b93a1',
  brightRed: '#ff7b72',
  brightGreen: '#7ee787',
  brightYellow: '#f2cc60',
  brightBlue: '#8cb8ff',
  brightMagenta: '#e0a3f5',
  brightCyan: '#76e3ea',
  brightWhite: '#ffffff',
} as const satisfies Required<AnsiPalette>;

/**
 * Colors for the light theme (background #ffffff). Text on a white background
 * needs dark colors, so the bright colors are the stronger, darker ones, and
 * `white` is a mid gray that stays readable.
 */
export const LIGHT_ANSI = {
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#8a5a00',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#0e7490',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#6f4700',
  brightBlue: '#0969da',
  brightMagenta: '#6639ba',
  brightCyan: '#1b7c83',
  brightWhite: '#1f2328',
} as const satisfies Required<AnsiPalette>;

/**
 * xterm moves the color of a character toward black or white until it reaches
 * this contrast ratio against the cell background (WCAG AA for normal text).
 */
export const MINIMUM_CONTRAST_RATIO = 4.5;

/** Reads `#rgb`, `#rrggbb` and `rgb(r, g, b)`. Returns null for anything else. */
export function parseColor(value: string): [number, number, number] | null {
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return [r, g, b];
  }
  m = /^#([0-9a-f]{6})/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** Relative luminance, 0 (black) to 1 (white), as WCAG defines it. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colors, 1 to 21. Returns 1 when a color cannot be read. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when the background color is dark. An unreadable value counts as dark. */
export function isDarkBackground(bg: string): boolean {
  const c = parseColor(bg);
  return !c || luminance(c) < 0.4;
}

/** Builds the xterm theme. `read` returns the value of a CSS variable (empty when missing). */
export function themeFromVars(read: VarReader): ITheme {
  const v = (name: string, fallback: string) => read(name).trim() || fallback;
  const bg = v('--bg', '#1f2023');
  const fg = v('--fg', '#d6d7da');
  const palette = isDarkBackground(bg) ? DARK_ANSI : LIGHT_ANSI;
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: v('--selection', 'rgba(76, 157, 255, 0.28)'),
    ...palette,
  };
}

export function themeFromDocument(): ITheme {
  const style = getComputedStyle(document.documentElement);
  return themeFromVars((name) => style.getPropertyValue(name));
}

/**
 * Font family for xterm. The canvas cannot use `var(--font-mono)`, so we read the
 * value of the variable and append it as the last fallback.
 */
export function fontFamilyFor(editorFamily: string, readVar: VarReader): string {
  const mono = readVar('--font-mono').trim();
  return [editorFamily.trim(), mono, 'monospace'].filter(Boolean).join(', ');
}
