import { afterEach, describe, expect, it, vi } from 'vitest';
import { basename, dirname, escapeHtml, extname, isInside, joinPath, samePath, sep } from './util';

describe('basename', () => {
  it('handles Unix paths', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt');
    expect(basename('c.txt')).toBe('c.txt');
    expect(basename('/a/b/')).toBe('b');
  });
  it('handles Windows paths', () => {
    expect(basename('C:\\a\\b\\c.txt')).toBe('c.txt');
    expect(basename('C:\\a\\b\\')).toBe('b');
  });
});

describe('dirname', () => {
  it('handles Unix paths', () => {
    expect(dirname('/a/b/c.txt')).toBe('/a/b');
    expect(dirname('/a')).toBe('/');
    expect(dirname('c.txt')).toBe('');
  });
  it('handles Windows paths', () => {
    expect(dirname('C:\\a\\b\\c.txt')).toBe('C:\\a\\b');
    expect(dirname('C:\\a')).toBe('C:\\');
    expect(dirname('C:\\')).toBe('C:\\');
  });
});

describe('extname', () => {
  it('returns the lower case extension with a dot', () => {
    expect(extname('/a/b/Main.KT')).toBe('.kt');
    expect(extname('x.tar.gz')).toBe('.gz');
  });
  it('returns an empty string without an extension', () => {
    expect(extname('/a/Makefile')).toBe('');
    expect(extname('/a/.gitignore')).toBe('');
    expect(extname('C:\\a.b\\file')).toBe('');
  });
});

describe('sep and joinPath', () => {
  it('detects the separator', () => {
    expect(sep('/a/b')).toBe('/');
    expect(sep('C:\\a')).toBe('\\');
    expect(sep('C:\\a/b')).toBe('/');
  });
  it('joins with the separator of the first part', () => {
    expect(joinPath('/a/b', 'c', 'd.txt')).toBe('/a/b/c/d.txt');
    expect(joinPath('/a/b/', '/c')).toBe('/a/b/c');
    expect(joinPath('C:\\a', 'b/c', 'd')).toBe('C:\\a\\b\\c\\d');
    expect(joinPath('C:\\a\\', 'b')).toBe('C:\\a\\b');
  });
  it('skips empty parts', () => {
    expect(joinPath('/a', '', 'b')).toBe('/a/b');
  });
});

describe('isInside and samePath (linux rules)', () => {
  it('finds files inside a folder', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });
  it('accepts mixed separators', () => {
    expect(isInside('C:\\a\\b\\c', 'C:\\a')).toBe(true);
    expect(isInside('C:\\a\\b', 'C:/a')).toBe(true);
  });
  it('is case sensitive on linux', () => {
    expect(isInside('/A/b', '/a')).toBe(false);
    expect(samePath('/a/B', '/a/b')).toBe(false);
    expect(samePath('/a/b/', '/a/b')).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
  it('leaves normal text alone', () => {
    expect(escapeHtml('hello 日本語')).toBe('hello 日本語');
  });
});

describe('platform detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(userAgent: string) {
    vi.resetModules();
    vi.stubGlobal('navigator', { userAgent });
    return import('./util');
  }

  it('reads the user agent', async () => {
    expect((await load('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).platform).toBe('macos');
    expect((await load('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).platform).toBe('windows');
    expect((await load('Mozilla/5.0 (X11; Linux x86_64)')).platform).toBe('linux');
  });

  it('ignores case in paths on macOS and Windows', async () => {
    const mac = await load('Mozilla/5.0 (Macintosh)');
    expect(mac.isMac).toBe(true);
    expect(mac.isInside('/Users/Me/Proj/a.txt', '/users/me/proj')).toBe(true);
    expect(mac.samePath('/A/b', '/a/B')).toBe(true);
    const win = await load('Mozilla/5.0 (Windows NT 10.0)');
    expect(win.isInside('C:\\Work\\A', 'c:\\work')).toBe(true);
  });
});
