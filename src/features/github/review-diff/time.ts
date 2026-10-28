// Pure logic: time text of a comment.

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** "3 hours ago". Empty text for an empty or bad date (drafts have no date). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((now - t) / 1000);
  if (s < MINUTE) return 'just now';
  if (s < HOUR) return plural(Math.floor(s / MINUTE), 'minute');
  if (s < DAY) return plural(Math.floor(s / HOUR), 'hour');
  const days = Math.floor(s / DAY);
  if (days < 30) return plural(days, 'day');
  if (days < 365) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
}

/** Full local time for the title of the relative time. Empty for a bad date. */
export function fullTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
}
