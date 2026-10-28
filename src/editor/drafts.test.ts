import { describe, expect, it } from 'vitest';
import { draftFileName, draftNumber, draftTitle, firstLine, isDraftPath, nextDraftNumber } from './drafts';
import { extensionForLanguage, languageIdFor, LANGUAGES } from './languages';

describe('draft names', () => {
  it('reads the number from a file name', () => {
    expect(draftNumber('draft-1.txt')).toBe(1);
    expect(draftNumber('draft-12.py')).toBe(12);
    expect(draftNumber('Draft-3.MD')).toBe(3);
    expect(draftNumber('draft-4')).toBe(4);
    expect(draftNumber('draft-0.txt')).toBeNull();
    expect(draftNumber('notes.txt')).toBeNull();
    expect(draftNumber('draft-1.txt.bak')).toBeNull();
    expect(draftNumber('draft-x.txt')).toBeNull();
  });

  it('picks the lowest free number', () => {
    expect(nextDraftNumber([])).toBe(1);
    expect(nextDraftNumber(['draft-1.txt', 'draft-2.txt'])).toBe(3);
    expect(nextDraftNumber(['draft-2.txt', 'draft-3.py'])).toBe(1);
    expect(nextDraftNumber(['draft-1.txt', 'draft-3.txt', 'readme.md'])).toBe(2);
    expect(nextDraftNumber(new Set(['draft-1.sql', 'draft-2.txt']))).toBe(3);
  });

  it('builds file names and titles', () => {
    expect(draftFileName(2)).toBe('draft-2.txt');
    expect(draftFileName(5, '.py')).toBe('draft-5.py');
    expect(draftTitle('/data/drafts/draft-7.kt')).toBe('Draft 7');
    expect(draftTitle('C:\\data\\drafts\\draft-8.txt')).toBe('Draft 8');
    expect(draftTitle('/data/drafts/my notes.txt')).toBe('my notes.txt');
  });
});

describe('isDraftPath', () => {
  const dir = '/Users/a/Library/Application Support/kestrel/drafts';
  it('accepts files inside the drafts folder', () => {
    expect(isDraftPath(`${dir}/draft-1.txt`, dir)).toBe(true);
    expect(isDraftPath(`${dir}/draft-1.txt`, `${dir}/`)).toBe(true);
    expect(isDraftPath(`${dir}/sub/a.txt`, dir)).toBe(true);
  });
  it('rejects other paths', () => {
    expect(isDraftPath(dir, dir)).toBe(false);
    expect(isDraftPath(`${dir}-old/draft-1.txt`, dir)).toBe(false);
    expect(isDraftPath('/Users/a/work/draft-1.txt', dir)).toBe(false);
    expect(isDraftPath(`${dir}/draft-1.txt`, null)).toBe(false);
  });
  it('accepts Windows separators', () => {
    expect(isDraftPath('C:\\k\\drafts\\draft-1.txt', 'C:\\k\\drafts')).toBe(true);
    expect(isDraftPath('C:\\k\\drafts2\\draft-1.txt', 'C:\\k\\drafts')).toBe(false);
  });
});

describe('extensionForLanguage', () => {
  it('gives an extension that maps back to the same language', () => {
    for (const l of LANGUAGES) {
      const ext = extensionForLanguage(l.id);
      if (ext) expect(languageIdFor(`/x/draft-1.${ext}`)).toBe(l.id);
    }
    expect(extensionForLanguage('python')).toBe('py');
    expect(extensionForLanguage('plaintext')).toBe('txt');
    expect(extensionForLanguage('nope')).toBeNull();
  });
});

describe('firstLine', () => {
  it('skips blank lines and cuts long lines', () => {
    expect(firstLine('\n  \n  hello  \nworld')).toBe('hello');
    expect(firstLine('')).toBe('');
    expect(firstLine('a'.repeat(200), 10)).toBe('aaaaaaaaaa...');
  });
});
