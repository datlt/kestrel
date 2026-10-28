import { describe, expect, it } from 'vitest';
import { authorColor, initials, relativeTime, shortRelativeTime } from './format';

describe('relativeTime', () => {
  const now = 1_000_000_000;
  it('uses plain units', () => {
    expect(relativeTime(now - 10, now)).toBe('now');
    expect(relativeTime(now - 60, now)).toBe('1 minute ago');
    expect(relativeTime(now - 3 * 3600, now)).toBe('3 hours ago');
    expect(relativeTime(now - 86400, now)).toBe('1 day ago');
    expect(relativeTime(now - 90 * 86400, now)).toBe('3 months ago');
    expect(relativeTime(now - 800 * 86400, now)).toBe('2 years ago');
  });
  it('does not go negative for times in the future', () => {
    expect(relativeTime(now + 500, now)).toBe('now');
  });
  it('has a short form', () => {
    expect(shortRelativeTime(now - 7200, now)).toBe('2h');
    expect(shortRelativeTime(now - 5 * 86400, now)).toBe('5d');
  });
});

describe('avatar', () => {
  it('builds initials', () => {
    expect(initials('Tuan Dat Le')).toBe('TL');
    expect(initials('alice')).toBe('AL');
    expect(initials('  ')).toBe('?');
    expect(initials('山田 太郎')).toBe('山太');
  });
  it('gives a stable color', () => {
    expect(authorColor('a@b.c')).toBe(authorColor('a@b.c'));
    expect(authorColor('a@b.c')).not.toBe(authorColor('x@y.z'));
  });
});
