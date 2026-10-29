import { describe, expect, it } from 'vitest';
import { headingLine, linkTarget } from './wikilinks';

describe('linkTarget', () => {
  it('decodes the href that comrak percent-encodes', () => {
    expect(linkTarget('Auth%20Flow#Login')).toBe('Auth Flow#Login');
    expect(linkTarget('%E3%83%8E%E3%83%BC%E3%83%88/%E8%A8%AD%E8%A8%88')).toBe('ノート/設計');
  });

  it('keeps a broken escape as it is', () => {
    expect(linkTarget('100%')).toBe('100%');
  });
});

describe('headingLine', () => {
  const text = '# Title\n\nIntro\n\n## Part 2 ##\n\ntext ^block-1\n### Tiếng Việt\r\n';

  it('finds a heading without case', () => {
    expect(headingLine(text, 'title', false)).toBe(1);
    expect(headingLine(text, 'Part 2', false)).toBe(5);
    expect(headingLine(text, 'tiếng việt', false)).toBe(8);
  });

  it('finds a block id', () => {
    expect(headingLine(text, 'block-1', true)).toBe(7);
  });

  it('gives null when nothing matches', () => {
    expect(headingLine(text, 'Nope', false)).toBeNull();
    expect(headingLine(text, '', false)).toBeNull();
  });
});
