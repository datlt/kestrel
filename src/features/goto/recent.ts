// Recently opened classes and files. Kept per folder in `ctx.workspace.state`.

export const RECENT_KEY = 'goto.recent';
export const RECENT_MAX = 50;

export interface RecentClass {
  type: 'class';
  /** `path#name`. The same key that class rows use. */
  key: string;
  name: string;
  container: string;
  kind: string;
  lang: string;
  /** Absolute path. */
  path: string;
  line: number;
  column: number;
  test: boolean;
}

export interface RecentFile {
  type: 'file';
  /** Path relative to the folder. The same as the key of file rows. */
  key: string;
}

export type RecentEntry = RecentClass | RecentFile;

export function classKey(path: string, name: string): string {
  return `${path}#${name}`;
}

function isEntry(v: unknown): v is RecentEntry {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.type === 'file') return typeof r.key === 'string';
  if (r.type === 'class') {
    return (
      typeof r.key === 'string' &&
      typeof r.name === 'string' &&
      typeof r.path === 'string' &&
      typeof r.line === 'number' &&
      typeof r.column === 'number'
    );
  }
  return false;
}

/** Reads the saved value. Entries that look wrong are dropped. */
export function readRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry).slice(0, RECENT_MAX);
}

/** Puts the entry first. An older entry with the same type and key is removed. Returns a new list. */
export function addRecent(list: readonly RecentEntry[], entry: RecentEntry, max = RECENT_MAX): RecentEntry[] {
  const rest = list.filter((e) => !(e.type === entry.type && e.key === entry.key));
  return [entry, ...rest].slice(0, max);
}

/** Position of each key in the list of one type. 0 is the newest. */
export function recentRanks(list: readonly RecentEntry[], type: RecentEntry['type']): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const e of list) {
    if (e.type === type && !ranks.has(e.key)) ranks.set(e.key, ranks.size);
  }
  return ranks;
}

/** How many places a row moves up when it was opened recently. The newest rows get the most. */
export function recentBonus(rank: number): number {
  if (rank < 5) return 4;
  if (rank < 20) return 2;
  return 1;
}

/**
 * Moves recently opened rows up by a few places. Other rows keep their order.
 * It is a small push: a recent row does not jump over the best matches.
 */
export function applyRecentBonus<T>(rows: readonly T[], keyOf: (row: T) => string, ranks: ReadonlyMap<string, number>): T[] {
  if (ranks.size === 0) return [...rows];
  const scored = rows.map((row, i) => {
    const rank = ranks.get(keyOf(row));
    return { row, i, pos: rank === undefined ? i : i - recentBonus(rank) };
  });
  scored.sort((a, b) => a.pos - b.pos || a.i - b.i);
  return scored.map((s) => s.row);
}
