import { describe, expect, it } from 'vitest';
import { applyPreserveCase, compilePattern, expandTemplate, matchesInLine, replacementFor } from './pattern';

const re = (query: string, o: Partial<{ regex: boolean; matchCase: boolean; wholeWord: boolean }> = {}) => {
  const c = compilePattern({ query, regex: false, matchCase: false, wholeWord: false, ...o });
  if (!c.ok) throw new Error(c.error);
  return c.re;
};
const first = (line: string, r: RegExp) => matchesInLine(line, r)[0];

describe('compilePattern', () => {
  it('escapes plain text with special characters', () => {
    const r = re('a.b(c)*[x]$1');
    expect(matchesInLine('a.b(c)*[x]$1 axb(c)', r).map((m) => m[0])).toEqual(['a.b(c)*[x]$1']);
  });
  it('ignores case unless match case is set', () => {
    expect(matchesInLine('Foo foo FOO', re('foo')).length).toBe(3);
    expect(matchesInLine('Foo foo FOO', re('foo', { matchCase: true })).length).toBe(1);
  });
  it('whole word works with non-ASCII letters', () => {
    const r = re('café', { wholeWord: true });
    expect(matchesInLine('café cafés écafé café.', r).map((m) => m.index)).toEqual([0, 17]);
    const jp = re('設定', { wholeWord: true });
    expect(matchesInLine('設定 の設定 設定値', jp).map((m) => m.index)).toEqual([0]);
  });
  it('whole word with a regex alternative', () => {
    const r = re('foo|bar', { regex: true, wholeWord: true });
    expect(matchesInLine('foo foobar bar', r).map((m) => m[0])).toEqual(['foo', 'bar']);
  });
  it('reports a broken regex', () => {
    const c = compilePattern({ query: '(', regex: true, matchCase: false, wholeWord: false });
    expect(c.ok).toBe(false);
  });
  it('accepts patterns that only work without the u flag', () => {
    expect(matchesInLine('a-b', re('a\\-b', { regex: true })).length).toBe(1);
  });
  it('skips empty matches', () => {
    expect(matchesInLine('aab', re('a*', { regex: true })).map((m) => m[0])).toEqual(['aa']);
  });
});

describe('expandTemplate', () => {
  const m = first('John Smith', re('(\\w+) (?<last>\\w+)', { regex: true }));
  it('expands groups, named groups and the whole match', () => {
    expect(expandTemplate('$2, $1', m)).toBe('Smith, John');
    expect(expandTemplate('$<last>!', m)).toBe('Smith!');
    expect(expandTemplate('[$&]', m)).toBe('[John Smith]');
  });
  it('handles escapes', () => {
    expect(expandTemplate('a\\nb\\tc\\\\d', m)).toBe('a\nb\tc\\d');
    expect(expandTemplate('$$1 \\$1', m)).toBe('$1 $1');
  });
  it('keeps references to missing groups as text', () => {
    expect(expandTemplate('$5 $<nope> $', m)).toBe('$5 $<nope> $');
  });
  it('gives an empty text for a group that did not match', () => {
    const x = first('b', re('(a)?(b)', { regex: true }));
    expect(expandTemplate('[$1][$2]', x)).toBe('[][b]');
  });
  it('prefers two digits when that group exists', () => {
    const x = first('abcdefghijk', re('(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)', { regex: true }));
    expect(expandTemplate('$11-$1', x)).toBe('k-a');
  });
});

describe('replacementFor', () => {
  it('uses plain text as it is in plain mode', () => {
    const m = first('x foo', re('foo'));
    expect(replacementFor(m, { template: '$1 \\n $&', regex: false, preserveCase: false })).toBe('$1 \\n $&');
  });
  it('expands the template in regex mode', () => {
    const m = first('get(5)', re('get\\((\\d)\\)', { regex: true }));
    expect(replacementFor(m, { template: 'at($1)', regex: true, preserveCase: false })).toBe('at(5)');
  });
});

describe('applyPreserveCase', () => {
  it('follows the match', () => {
    expect(applyPreserveCase('FOO', 'bar baz')).toBe('BAR BAZ');
    expect(applyPreserveCase('Foo', 'bar baz')).toBe('Bar baz');
    expect(applyPreserveCase('foo', 'Bar')).toBe('Bar');
    expect(applyPreserveCase('fOO', 'bar')).toBe('bar');
  });
  it('leaves matches without letters alone', () => {
    expect(applyPreserveCase('123', 'abc')).toBe('abc');
  });
  it('is used by replacementFor', () => {
    const m = first('Foo', re('foo'));
    expect(replacementFor(m, { template: 'bar', regex: false, preserveCase: true })).toBe('Bar');
  });
});
