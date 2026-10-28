import { describe, expect, it } from 'vitest';
import { fontFamilyFor, themeFromVars } from './theme';

describe('themeFromVars', () => {
  it('reads colors from the variables', () => {
    const vars: Record<string, string> = { '--bg': '#ffffff', '--fg': '#111111', '--danger': '#cf222e' };
    const t = themeFromVars((n) => vars[n] ?? '');
    expect(t.background).toBe('#ffffff');
    expect(t.foreground).toBe('#111111');
    expect(t.red).toBe('#cf222e');
    expect(t.brightRed).toBe('#cf222e');
  });

  it('uses fallbacks for missing variables', () => {
    const t = themeFromVars(() => '');
    expect(t.background).toMatch(/^#/);
    expect(t.green).toMatch(/^#/);
  });
});

describe('fontFamilyFor', () => {
  it('puts the editor font first and the mono variable after it', () => {
    expect(fontFamilyFor('"Fira Code", monospace', () => ' Menlo ')).toBe('"Fira Code", monospace, Menlo, monospace');
    expect(fontFamilyFor('', () => '')).toBe('monospace');
  });
});
