import { describe, expect, it } from 'vitest';
import { TEST_GLOBS, escapeGlob, globToRegExp, matchesAnyGlob, parseFileMask } from './globs';

describe('parseFileMask', () => {
  it('splits include and exclude globs', () => {
    expect(parseFileMask('*.kt, *.java, !*Test.kt')).toEqual({ include: ['*.kt', '*.java'], exclude: ['*Test.kt'] });
    expect(parseFileMask('')).toEqual({ include: [], exclude: [] });
    expect(parseFileMask('!, src/{a,b}')).toEqual({ include: ['src/{a,b}'], exclude: [] });
  });
});

describe('globToRegExp', () => {
  it('matches a name at any depth when the glob has no slash', () => {
    expect(globToRegExp('*.kt')!.test('a/b/C.kt')).toBe(true);
    expect(globToRegExp('*.kt')!.test('a/b/C.java')).toBe(false);
  });
  it('anchors a glob with a slash at the root', () => {
    expect(globToRegExp('src/*.ts')!.test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts')!.test('x/src/a.ts')).toBe(false);
    expect(globToRegExp('src/*.ts')!.test('src/deep/a.ts')).toBe(false);
  });
  it('matches everything inside a folder', () => {
    expect(globToRegExp('src')!.test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('/src')!.test('x/src/a.ts')).toBe(false);
  });
  it('supports braces, classes and escapes', () => {
    expect(globToRegExp('*.{kt,java}')!.test('A.java')).toBe(true);
    expect(globToRegExp('file[0-9].txt')!.test('file7.txt')).toBe(true);
    expect(globToRegExp('file[!0-9].txt')!.test('file7.txt')).toBe(false);
    expect(globToRegExp(escapeGlob('a[1].txt'))!.test('a[1].txt')).toBe(true);
  });
  it('returns null for an empty glob', () => {
    expect(globToRegExp('  ')).toBeNull();
  });
});

describe('TEST_GLOBS', () => {
  const isTest = (p: string) => matchesAnyGlob(p, TEST_GLOBS);
  it('accepts test files', () => {
    for (const p of [
      'app/src/test/kotlin/A.kt',
      'tests/a.py',
      'src/testFixtures/F.kt',
      'src/androidTest/java/X.java',
      'src/testByKotest/K.kt',
      'src/UnitTests/Foo.swift',
      'src/main/FooTest.kt',
      'src/main/FooTests.swift',
      'src/main/FooSpec.kt',
      'FooTest.java',
    ]) {
      expect(isTest(p), p).toBe(true);
    }
  });
  it('rejects production files', () => {
    for (const p of ['src/main/Foo.kt', 'src/latest/Foo.kt', 'src/Contest.kt', 'src/Spectrum.kt', 'README.md']) {
      expect(isTest(p), p).toBe(false);
    }
  });
});
