import { describe, expect, it } from 'vitest';
import { parseLineSuffix } from './query';

describe('parseLineSuffix', () => {
  it('keeps a plain query', () => {
    expect(parseLineSuffix('BookService')).toEqual({ name: 'BookService' });
  });
  it('reads a line', () => {
    expect(parseLineSuffix('BookService:42')).toEqual({ name: 'BookService', line: 42, column: undefined });
  });
  it('reads a line and a column', () => {
    expect(parseLineSuffix('BookService:42:7')).toEqual({ name: 'BookService', line: 42, column: 7 });
  });
  it('reads a line without a name', () => {
    expect(parseLineSuffix(':12')).toEqual({ name: '', line: 12, column: undefined });
  });
  it('keeps a trailing space of the name (it means "the name ends here")', () => {
    expect(parseLineSuffix('Book :3').name).toBe('Book ');
    expect(parseLineSuffix('Book ').name).toBe('Book ');
  });
  it('does not take text after the colon that is not a number', () => {
    expect(parseLineSuffix('Foo:bar')).toEqual({ name: 'Foo:bar' });
    expect(parseLineSuffix('Foo:4x')).toEqual({ name: 'Foo:4x' });
  });
  it('ignores line 0', () => {
    expect(parseLineSuffix('Foo:0')).toEqual({ name: 'Foo:0' });
  });
  it('ignores column 0', () => {
    expect(parseLineSuffix('Foo:5:0')).toEqual({ name: 'Foo', line: 5, column: undefined });
  });
});
