import { describe, expect, it } from 'vitest';
import { fullTime, relativeTime } from './time';

const now = Date.parse('2026-10-28T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('handles small and large spans', () => {
    expect(relativeTime(ago(10_000), now)).toBe('just now');
    expect(relativeTime(ago(MIN), now)).toBe('1 minute ago');
    expect(relativeTime(ago(5 * MIN), now)).toBe('5 minutes ago');
    expect(relativeTime(ago(HOUR), now)).toBe('1 hour ago');
    expect(relativeTime(ago(3 * HOUR + 5 * MIN), now)).toBe('3 hours ago');
    expect(relativeTime(ago(DAY), now)).toBe('1 day ago');
    expect(relativeTime(ago(12 * DAY), now)).toBe('12 days ago');
    expect(relativeTime(ago(65 * DAY), now)).toBe('2 months ago');
    expect(relativeTime(ago(800 * DAY), now)).toBe('2 years ago');
  });
  it('treats the future as just now', () => {
    expect(relativeTime(ago(-HOUR), now)).toBe('just now');
  });
  it('gives empty text for drafts and bad dates', () => {
    expect(relativeTime('', now)).toBe('');
    expect(relativeTime('nonsense', now)).toBe('');
    expect(fullTime('nonsense')).toBe('');
    expect(fullTime(ago(0))).not.toBe('');
  });
});
