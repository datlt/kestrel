// History lists for the query, file mask and replace fields.

export const HISTORY_MAX = 30;

/** Puts `value` at the front. An old copy is removed. Empty text is not stored. */
export function pushHistory(list: readonly string[], value: string, max = HISTORY_MAX): string[] {
  if (!value.trim()) return [...list];
  return [value, ...list.filter((v) => v !== value)].slice(0, max);
}

/** Reads a saved list. Anything that is not a list of strings gives an empty list. */
export function cleanHistory(raw: unknown, max = HISTORY_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, max);
}
