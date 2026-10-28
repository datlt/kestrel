// Small helpers shared by the history tab and the blame gutter.

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "5 minutes ago", "3 days ago", "2 years ago". `time` and `now` are in seconds. */
export function relativeTime(time: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - time);
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (d < 45) return 'now';
  if (d < HOUR) return unit(Math.max(1, Math.round(d / MIN)), 'minute');
  if (d < DAY) return unit(Math.round(d / HOUR), 'hour');
  if (d < 30 * DAY) return unit(Math.round(d / DAY), 'day');
  if (d < 365 * DAY) return unit(Math.max(1, Math.round(d / (30 * DAY))), 'month');
  return unit(Math.round(d / (365 * DAY)), 'year');
}

/** Short form for narrow columns: "now", "5m", "3h", "4d", "7mo", "2y". */
export function shortRelativeTime(time: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - time);
  if (d < 45) return 'now';
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))}m`;
  if (d < DAY) return `${Math.round(d / HOUR)}h`;
  if (d < 30 * DAY) return `${Math.round(d / DAY)}d`;
  if (d < 365 * DAY) return `${Math.max(1, Math.round(d / (30 * DAY)))}mo`;
  return `${Math.round(d / (365 * DAY))}y`;
}

/** Up to two letters for an avatar: "Tuan Dat" gives "TD", "alice" gives "AL". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  const chars = (w: string) => Array.from(w);
  if (words.length === 1) return chars(words[0]).slice(0, 2).join('').toUpperCase();
  return (chars(words[0])[0] + chars(words[words.length - 1])[0]).toUpperCase();
}

/** A stable color for an author. The same text always gives the same color. */
export function authorColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 52%, 42%)`;
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** Locale date and time for tooltips. `time` is in seconds. */
export function fullDate(time: number): string {
  return new Date(time * 1000).toLocaleString();
}
