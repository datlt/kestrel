// Keyboard selection in a list that has header rows. Headers are never selected.

export type MoveKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end';

export interface HasKind {
  type: string;
}

const selectable = (rows: readonly HasKind[], i: number): boolean => i >= 0 && i < rows.length && rows[i].type !== 'header';

export function firstSelectable(rows: readonly HasKind[]): number {
  for (let i = 0; i < rows.length; i++) if (selectable(rows, i)) return i;
  return -1;
}

export function lastSelectable(rows: readonly HasKind[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (selectable(rows, i)) return i;
  return -1;
}

/** The selectable row at or after `i`, going in `dir`. -1 when there is none. */
function nearest(rows: readonly HasKind[], i: number, dir: 1 | -1): number {
  for (let k = i; k >= 0 && k < rows.length; k += dir) if (selectable(rows, k)) return k;
  return -1;
}

/**
 * Where the selection goes. Up and Down wrap around. Page keys, Home and End
 * stop at the ends. `page` is the number of rows that fit in the list.
 * Returns -1 when no row can be selected.
 */
export function moveSelection(rows: readonly HasKind[], current: number, key: MoveKey, page = 8): number {
  const first = firstSelectable(rows);
  if (first < 0) return -1;
  const last = lastSelectable(rows);
  if (!selectable(rows, current)) return key === 'up' || key === 'end' ? last : first;
  switch (key) {
    case 'down': {
      const next = nearest(rows, current + 1, 1);
      return next < 0 ? first : next;
    }
    case 'up': {
      const prev = nearest(rows, current - 1, -1);
      return prev < 0 ? last : prev;
    }
    case 'pageDown': {
      const target = Math.min(rows.length - 1, current + page);
      const down = nearest(rows, target, 1);
      return down >= 0 ? down : last;
    }
    case 'pageUp': {
      const target = Math.max(0, current - page);
      const up = nearest(rows, target, -1);
      return up >= 0 ? up : first;
    }
    case 'home':
      return first;
    case 'end':
      return last;
  }
}
