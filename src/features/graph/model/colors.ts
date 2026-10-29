// Palettes for the folder and tag colors. 12 colors each. The light palette has
// at least 3:1 contrast on white, the dark palette on #1e1e1e (checked in tests).

export const PALETTE_LIGHT: readonly string[] = [
  '#2f6fed', // blue
  '#e8590c', // orange
  '#2b8a3e', // green
  '#ae3ec9', // purple
  '#d6336c', // pink
  '#0c8599', // teal
  '#a8780a', // gold
  '#5f3dc4', // indigo
  '#e03131', // red
  '#5c940d', // lime
  '#a9672f', // brown
  '#4c6a85', // slate
];

export const PALETTE_DARK: readonly string[] = [
  '#6b9bff',
  '#ff922b',
  '#51cf66',
  '#da77f2',
  '#f783ac',
  '#3bc9db',
  '#ffd43b',
  '#9775fa',
  '#ff6b6b',
  '#a9e34b',
  '#d9a066',
  '#8fb1cc',
];

export function palette(theme: 'light' | 'dark'): readonly string[] {
  return theme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT;
}
