// Puts the results of the index and of language servers into one list, and
// builds the grouped list of the All tab. No DOM here.

import { isIndexedPath } from './lsp-map';
import {
  GROUP_TITLES,
  type FindWindowRow,
  type Group,
  type HeaderRow,
  type MoreRow,
  type Row,
  type TextRow,
} from './rows';

export const ALL_GROUP_LIMIT = 5;

interface Located {
  path: string;
  line: number;
  name: string;
  key: string;
}

/**
 * Index results first, then the results of language servers. A server result is
 * dropped when the index reads that kind of file (the index is better there),
 * or when it points to the same file, line and name as an earlier row.
 */
export function mergeResults<T extends Located>(index: readonly T[], lsp: readonly T[], limit = Infinity): T[] {
  const out: T[] = [...index];
  const seen = new Set(out.map((r) => `${r.path}:${r.line}:${r.name}`));
  const seenKeys = new Set(out.map((r) => r.key));
  for (const r of lsp) {
    if (out.length >= limit) break;
    if (isIndexedPath(r.path)) continue;
    const id = `${r.path}:${r.line}:${r.name}`;
    if (seen.has(id) || seenKeys.has(r.key)) continue;
    seen.add(id);
    seenKeys.add(r.key);
    out.push(r);
  }
  return out.slice(0, limit);
}

export type AllGroups = Record<Group, readonly Row[]>;

const GROUP_ORDER: Group[] = ['classes', 'files', 'symbols', 'actions'];

/**
 * The list of the All tab: for each group that has rows, a header, at most
 * `limit` rows and, when the group has more, a "More" row. Empty groups are left out.
 * `hasMore` tells that a group has more rows than the list got (for example a cut result).
 */
export function groupAll(groups: AllGroups, limit = ALL_GROUP_LIMIT, hasMore: Partial<Record<Group, boolean>> = {}): Row[] {
  const rows: Row[] = [];
  for (const g of GROUP_ORDER) {
    const items = groups[g];
    if (items.length === 0) continue;
    const header: HeaderRow = { type: 'header', key: `h:${g}`, group: g, title: GROUP_TITLES[g] };
    rows.push(header, ...items.slice(0, limit));
    if (items.length > limit || hasMore[g]) {
      const more: MoreRow = { type: 'more', key: `m:${g}`, group: g, title: `More ${GROUP_TITLES[g].toLowerCase()}` };
      rows.push(more);
    }
  }
  return rows;
}

/** The Text tab: the matching lines, then "Open in Find Window". With no match the list is empty. */
export function textTabRows(matches: readonly TextRow[], query: string): Row[] {
  if (!query.trim()) return [];
  const find: FindWindowRow = { type: 'findWindow', key: 'find-window', query };
  return [...matches, find];
}
