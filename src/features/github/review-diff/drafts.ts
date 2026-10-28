// Pure logic: draft actions, thread summaries and the keys of the diff.

import type { ReviewComment, ReviewThread } from './types';

export const isDraftId = (id: string): boolean => id.startsWith('draft-');

/** Edit and Delete show only on the user's own drafts. */
export function draftActions(c: Pick<ReviewComment, 'mine' | 'pending'>): { edit: boolean; delete: boolean } {
  const own = c.mine && c.pending;
  return { edit: own, delete: own };
}

/** A comment box can send only when it has some text. */
export const canSubmit = (text: string): boolean => text.trim().length > 0;

/**
 * The line of a resolved thread. The contract has no field for the person who resolved
 * the thread, so a `resolvedBy` field is used when the caller sets it. Else the author
 * of the first comment is named.
 */
export function resolvedSummary(thread: ReviewThread & { resolvedBy?: string }): string {
  const who = thread.resolvedBy || thread.comments[0]?.author || 'unknown';
  const n = thread.comments.length;
  return `Resolved thread by ${who}, ${n} comment${n === 1 ? '' : 's'}`;
}

/** The Resolve button shows only when the caller gave `onResolve` and GitHub knows the thread. */
export function canResolve(thread: ReviewThread, hasHandler: boolean): boolean {
  return hasHandler && !isDraftId(thread.id) && thread.comments.length > 0;
}

export type KeyAction = 'next' | 'prev' | 'comment' | 'escape';

export interface KeyInfo {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** The event comes from a textarea, an input or an editable element. */
  inEditable: boolean;
}

/** Maps a key press in the diff to an action. Typing in a text box never gives an action. */
export function keyAction(e: KeyInfo, canComment: boolean): KeyAction | null {
  if (e.inEditable) return null;
  if (e.ctrlKey || e.metaKey) return null;
  if (e.altKey) {
    if (e.shiftKey) return null;
    if (e.key === 'ArrowDown') return 'next';
    if (e.key === 'ArrowUp') return 'prev';
    return null;
  }
  if (e.shiftKey) return null;
  if (e.key === 'n') return 'next';
  if (e.key === 'p') return 'prev';
  if (e.key === 'c') return canComment ? 'comment' : null;
  if (e.key === 'Escape') return 'escape';
  return null;
}
