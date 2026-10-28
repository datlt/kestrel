import { describe, expect, it } from 'vitest';
import { lspLanguageId, normalizeUri, pathToUri, uriToPath } from './uri';

describe('pathToUri', () => {
  it('maps a posix path', () => {
    expect(pathToUri('/Users/me/app/Main.kt')).toBe('file:///Users/me/app/Main.kt');
  });
  it('encodes spaces, hash, percent and non-ASCII text', () => {
    expect(pathToUri('/tmp/my dir/a#b%c.kt')).toBe('file:///tmp/my%20dir/a%23b%25c.kt');
    expect(pathToUri('/tmp/日本語/é.kt')).toBe('file:///tmp/%E6%97%A5%E6%9C%AC%E8%AA%9E/%C3%A9.kt');
  });
  it('maps a Windows drive path', () => {
    expect(pathToUri('C:\\Users\\me\\My Docs\\a.kt')).toBe('file:///C:/Users/me/My%20Docs/a.kt');
    expect(pathToUri('d:/x/y.ts')).toBe('file:///d:/x/y.ts');
  });
  it('maps a UNC path', () => {
    expect(pathToUri('\\\\server\\share\\dir x\\a.kt')).toBe('file://server/share/dir%20x/a.kt');
  });
});

describe('uriToPath', () => {
  it('maps back a posix URI', () => {
    expect(uriToPath('file:///tmp/my%20dir/a%23b%25c.kt')).toBe('/tmp/my dir/a#b%c.kt');
    expect(uriToPath('file:///tmp/%E6%97%A5%E6%9C%AC%E8%AA%9E/%C3%A9.kt')).toBe('/tmp/日本語/é.kt');
  });
  it('maps a Windows URI to a native path', () => {
    expect(uriToPath('file:///C:/Users/me/My%20Docs/a.kt')).toBe('C:\\Users\\me\\My Docs\\a.kt');
    expect(uriToPath('file:///c%3A/Users/me/a.kt')).toBe('C:\\Users\\me\\a.kt');
    expect(uriToPath('file:///c:/x')).toBe('C:\\x');
  });
  it('maps a UNC URI', () => {
    expect(uriToPath('file://server/share/dir%20x/a.kt')).toBe('\\\\server\\share\\dir x\\a.kt');
  });
  it('accepts localhost and ignores other schemes', () => {
    expect(uriToPath('file://localhost/etc/hosts')).toBe('/etc/hosts');
    expect(uriToPath('jar:file:///a.jar!/A.class')).toBeNull();
    expect(uriToPath('untitled:Untitled-1')).toBeNull();
  });
  it('keeps text that is not valid percent encoding', () => {
    expect(uriToPath('file:///tmp/100%/a.kt')).toBe('/tmp/100%/a.kt');
  });
});

describe('round trip', () => {
  const paths = ['/a/b c/d.kt', '/日本/ü#?.java', 'C:\\work\\a b\\c.ts', '\\\\host\\s\\f.kt', '/a/(x)/*.kt'];
  for (const p of paths) {
    it(p, () => expect(uriToPath(pathToUri(p))).toBe(p));
  }
});

describe('normalizeUri', () => {
  it('gives one form to different spellings of a Windows file', () => {
    const a = normalizeUri('file:///c%3A/Users/me/a.kt');
    expect(a).toBe(normalizeUri('file:///C:/Users/me/a.kt'));
    expect(a).toBe(normalizeUri('file:///c:/Users/me/a.kt'));
  });
  it('keeps posix case', () => {
    expect(normalizeUri('file:///Users/Me/A.kt')).toBe('file:///Users/Me/A.kt');
  });
  it('returns other schemes as they are', () => {
    expect(normalizeUri('untitled:1')).toBe('untitled:1');
  });
});

describe('lspLanguageId', () => {
  it('maps jsx and tsx', () => {
    expect(lspLanguageId('jsx')).toBe('javascriptreact');
    expect(lspLanguageId('tsx')).toBe('typescriptreact');
    expect(lspLanguageId('kotlin')).toBe('kotlin');
  });
});
