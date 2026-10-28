// Terminal colors, taken from the theme variables in src/styles/vars.css and
// src/editor/tokens.css, so the terminal follows the light and dark themes.

import type { ITheme } from '@xterm/xterm';

type VarReader = (name: string) => string;

/** Builds the xterm theme. `read` returns the value of a CSS variable (empty when missing). */
export function themeFromVars(read: VarReader): ITheme {
  const v = (name: string, fallback: string) => read(name).trim() || fallback;
  const fg = v('--fg', '#d6d7da');
  const red = v('--danger', '#f2686a');
  const green = v('--ok', '#57c27a');
  const yellow = v('--warn', '#e3b341');
  const blue = v('--info', '#4c9dff');
  const magenta = v('--tok-keyword', '#c678dd');
  const cyan = v('--tok-builtin', '#56b6c2');
  const muted = v('--fg-muted', '#8b8e96');
  return {
    background: v('--bg', '#1f2023'),
    foreground: fg,
    cursor: fg,
    cursorAccent: v('--bg', '#1f2023'),
    selectionBackground: v('--selection', 'rgba(76, 157, 255, 0.28)'),
    black: v('--fg-faint', '#5d6068'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: muted,
    brightBlack: muted,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: fg,
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
