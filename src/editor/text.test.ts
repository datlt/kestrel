import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { escapeText, finalNewlineChange, minimalChange, trailingWhitespaceChanges } from './text';

function apply(text: string, changes: { from: number; to: number; insert: string }[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

describe('trailingWhitespaceChanges', () => {
  it('removes spaces and tabs at line ends only', () => {
    const text = 'a  \n b\t \n\n  \nc';
    const doc = Text.of(text.split('\n'));
    expect(apply(text, trailingWhitespaceChanges(doc))).toBe('a\n b\n\n\nc');
  });

  it('returns nothing for clean text', () => {
    expect(trailingWhitespaceChanges(Text.of(['a', 'b']))).toEqual([]);
  });
});

describe('finalNewlineChange', () => {
  it('adds a line break at the end', () => {
    expect(finalNewlineChange(Text.of(['a', 'b']))).toEqual({ from: 3, to: 3, insert: '\n' });
  });
  it('does nothing when there is one or the text is empty', () => {
    expect(finalNewlineChange(Text.of(['a', '']))).toBeNull();
    expect(finalNewlineChange(Text.of(['']))).toBeNull();
  });
});

describe('minimalChange', () => {
  it('finds the changed middle', () => {
    expect(minimalChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
    expect(minimalChange('abc', 'abd')).toEqual({ from: 2, to: 3, insert: 'd' });
    expect(minimalChange('same', 'same')).toBeNull();
    expect(minimalChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' });
  });

  it('does not cut a surrogate pair', () => {
    const a = 'x\u{1F600}y';
    const b = 'x\u{1F601}y';
    const c = minimalChange(a, b)!;
    expect(a.slice(0, c.from) + c.insert + a.slice(c.to)).toBe(b);
    expect(c.from).toBe(1);
    expect(c.to).toBe(3);
  });
});

describe('escapeText', () => {
  it('escapes html', () => {
    expect(escapeText('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
