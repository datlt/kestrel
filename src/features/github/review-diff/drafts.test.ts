import { describe, expect, it } from 'vitest';
import { canResolve, canSubmit, draftActions, isDraftId, keyAction, resolvedSummary, type KeyInfo } from './drafts';
import type { ReviewComment, ReviewThread } from './types';

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  author: 'ann',
  body: 'x',
  createdAt: '',
  pending: false,
  mine: false,
  ...over,
});
const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 't1',
  side: 'RIGHT',
  line: 1,
  outdated: false,
  resolved: true,
  comments: [comment(), comment({ id: 'c2', author: 'bob' })],
  ...over,
});

describe('draftActions', () => {
  it('allows edit and delete on own drafts only', () => {
    expect(draftActions({ mine: true, pending: true })).toEqual({ edit: true, delete: true });
    expect(draftActions({ mine: true, pending: false })).toEqual({ edit: false, delete: false });
    expect(draftActions({ mine: false, pending: true })).toEqual({ edit: false, delete: false });
  });
});

describe('text helpers', () => {
  it('canSubmit needs text', () => {
    expect(canSubmit('')).toBe(false);
    expect(canSubmit('  \n ')).toBe(false);
    expect(canSubmit(' a ')).toBe(true);
  });
  it('isDraftId', () => {
    expect(isDraftId('draft-1')).toBe(true);
    expect(isDraftId('PRRT_1')).toBe(false);
  });
  it('resolvedSummary', () => {
    expect(resolvedSummary(thread())).toBe('Resolved thread by ann, 2 comments');
    expect(resolvedSummary(thread({ comments: [comment()] }))).toBe('Resolved thread by ann, 1 comment');
    expect(resolvedSummary({ ...thread(), resolvedBy: 'cy' })).toBe('Resolved thread by cy, 2 comments');
  });
  it('canResolve', () => {
    expect(canResolve(thread(), true)).toBe(true);
    expect(canResolve(thread(), false)).toBe(false);
    expect(canResolve(thread({ id: 'draft-1' }), true)).toBe(false);
  });
});

describe('keyAction', () => {
  const k = (key: string, over: Partial<KeyInfo> = {}): KeyInfo => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    inEditable: false,
    ...over,
  });
  it('maps the keys', () => {
    expect(keyAction(k('n'), true)).toBe('next');
    expect(keyAction(k('p'), true)).toBe('prev');
    expect(keyAction(k('ArrowDown', { altKey: true }), true)).toBe('next');
    expect(keyAction(k('ArrowUp', { altKey: true }), true)).toBe('prev');
    expect(keyAction(k('c'), true)).toBe('comment');
    expect(keyAction(k('Escape'), true)).toBe('escape');
  });
  it('c does nothing without canComment', () => {
    expect(keyAction(k('c'), false)).toBeNull();
  });
  it('never fires while typing', () => {
    for (const key of ['n', 'p', 'c', 'Escape']) expect(keyAction(k(key, { inEditable: true }), true)).toBeNull();
    expect(keyAction(k('ArrowDown', { altKey: true, inEditable: true }), true)).toBeNull();
  });
  it('ignores shortcuts with Ctrl or Cmd', () => {
    expect(keyAction(k('c', { metaKey: true }), true)).toBeNull();
    expect(keyAction(k('n', { ctrlKey: true }), true)).toBeNull();
  });
});
