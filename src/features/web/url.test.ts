import { describe, expect, it } from 'vitest';
import { addBookmark, bookmarkTitle, hostOf, normalizeUrl, removeBookmark, sameUrl } from './url';

describe('normalizeUrl', () => {
  it('keeps full http and https addresses', () => {
    expect(normalizeUrl('https://chat.example.com/#/')).toBe('https://chat.example.com/#/');
    expect(normalizeUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });
  it('adds https when the scheme is missing', () => {
    expect(normalizeUrl('mail.example.com')).toBe('https://mail.example.com/');
    expect(normalizeUrl('  calendar.example.com/x ')).toBe('https://calendar.example.com/x');
  });
  it('uses http for local hosts', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeUrl('127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/a');
  });
  it('rejects other schemes, spaces and empty text', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
    expect(normalizeUrl('two words')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });
});

describe('titles and bookmarks', () => {
  it('uses the saved title, else the host', () => {
    expect(bookmarkTitle('https://mail.example.com/', { 'https://mail.example.com/': 'Inbox' })).toBe('Inbox');
    expect(bookmarkTitle('https://www.example.com/a', {})).toBe('example.com');
    expect(bookmarkTitle('https://a.com/', { 'https://a.com/': '  ' })).toBe('a.com');
  });
  it('returns the text when it is not an address', () => {
    expect(hostOf('nonsense')).toBe('nonsense');
  });
  it('treats a trailing slash as the same address', () => {
    expect(sameUrl('https://a.com', 'https://a.com/')).toBe(true);
    expect(sameUrl('https://a.com/?q=1', 'https://a.com?q=1')).toBe(true);
    expect(sameUrl('https://a.com/x', 'https://a.com/y')).toBe(false);
  });
  it('adds and removes without duplicates', () => {
    const list = ['https://a.com/'];
    expect(addBookmark(list, 'https://a.com')).toEqual(['https://a.com/']);
    expect(addBookmark(list, 'https://b.com/')).toEqual(['https://a.com/', 'https://b.com/']);
    expect(removeBookmark(['https://a.com/', 'https://b.com/'], 'https://a.com')).toEqual(['https://b.com/']);
  });
});
