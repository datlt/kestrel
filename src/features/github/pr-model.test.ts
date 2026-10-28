import { describe, expect, it } from 'vitest';
import {
  addDraft,
  buildLineComment,
  buildReviewPayload,
  buildTimeline,
  commentCounts,
  deleteDraft,
  draftCounts,
  editDraft,
  emptyDrafts,
  filterFiles,
  mergeBaseOf,
  newPathOf,
  normalizeRange,
  oldPathOf,
  parseFiles,
  parsePull,
  parseThreadsPage,
  readDraftStore,
  reviewerStates,
  splitDrafts,
  stepIndex,
  summarizeChecks,
  threadsForFile,
  validateReview,
} from './pr-model';

describe('pull and files', () => {
  it('parses a pull request', () => {
    const p = parsePull({
      title: 'T',
      state: 'closed',
      merged_at: '2026-01-01',
      head: { ref: 'f', sha: 'h1', repo: { full_name: 'x/y' } },
      base: { ref: 'main', sha: 'b1' },
      user: { login: 'a' },
      requested_reviewers: [{ login: 'r1' }],
      labels: [{ name: 'bug', color: 'ff0000' }],
    });
    expect(p).toMatchObject({ title: 'T', state: 'merged', headSha: 'h1', baseRef: 'main', author: 'a', requestedUsers: ['r1'], body: '' });
  });
  it('uses the merge base or the fallback', () => {
    expect(mergeBaseOf({ merge_base_commit: { sha: 'm' } }, 'b')).toBe('m');
    expect(mergeBaseOf({}, 'b')).toBe('b');
  });
  it('maps file statuses and paths', () => {
    const files = parseFiles([
      { filename: 'a.kt', status: 'added', additions: 3, deletions: 0 },
      { filename: 'b.kt', status: 'removed', additions: 0, deletions: 4 },
      { filename: 'c.kt', status: 'renamed', previous_filename: 'old.kt', additions: 1, deletions: 1 },
      { filename: 'd.kt', status: 'changed' },
    ]);
    expect(files.map((f) => f.status)).toEqual(['added', 'deleted', 'renamed', 'modified']);
    expect([oldPathOf(files[0]), newPathOf(files[0])]).toEqual([null, 'a.kt']);
    expect([oldPathOf(files[1]), newPathOf(files[1])]).toEqual(['b.kt', null]);
    expect([oldPathOf(files[2]), newPathOf(files[2])]).toEqual(['old.kt', 'c.kt']);
    expect(filterFiles(files, 'OLD').map((f) => f.path)).toEqual(['c.kt']);
    expect(filterFiles(files, '')).toHaveLength(4);
  });
  it('steps through the list', () => {
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
    expect(stepIndex(3, 2, 1)).toBe(-1);
    expect(stepIndex(3, 0, -1)).toBe(-1);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
  it('counts check runs', () => {
    const s = summarizeChecks({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }] });
    expect(s).toEqual({ passed: 1, failed: 1, running: 1, total: 3 });
  });
});

describe('timeline and reviewers', () => {
  it('sorts comments and reviews, skips pending reviews', () => {
    const t = buildTimeline(
      [{ id: 1, user: { login: 'a' }, body: 'x', created_at: '2026-01-02' }],
      [
        { id: 2, user: { login: 'b' }, state: 'APPROVED', submitted_at: '2026-01-01' },
        { id: 3, user: { login: 'c' }, state: 'PENDING', submitted_at: '2026-01-03' },
      ],
    );
    expect(t.map((i) => i.id)).toEqual(['r2', 'c1']);
  });
  it('keeps the last decision of each reviewer', () => {
    const r = reviewerStates(
      [
        { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01' },
        { user: { login: 'b' }, state: 'COMMENTED', submitted_at: '2026-01-02' },
        { user: { login: 'c' }, state: 'APPROVED', submitted_at: '2026-01-02' },
        { user: { login: 'a' }, state: 'COMMENTED', submitted_at: '2026-01-02' },
      ],
      ['d', 'c'],
      'a',
    );
    expect(r).toEqual([
      { login: 'b', state: 'CHANGES_REQUESTED' },
      { login: 'c', state: 'PENDING' },
      { login: 'd', state: 'PENDING' },
    ]);
  });
});

const threadData = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: true, endCursor: 'cur' },
        nodes: [
          {
            id: 'T1', isResolved: false, isOutdated: false, path: 'a.kt', line: 12, startLine: 10, diffSide: 'RIGHT', viewerCanResolve: true,
            comments: { nodes: [{ id: 'C1', databaseId: 101, body: 'hi', createdAt: '2026-01-01', state: 'SUBMITTED', author: { login: 'bob' } }, { id: 'C2', databaseId: 102, body: 're', createdAt: '2026-01-02', state: 'PENDING', author: { login: 'me' } }] },
          },
          { id: 'T2', isResolved: true, isOutdated: true, path: 'a.kt', line: null, startLine: null, diffSide: 'LEFT', viewerCanUnresolve: true, comments: { nodes: [{ id: 'C3', databaseId: 103, body: 'old', author: null }] } },
          { id: 'T3', comments: { nodes: [] } },
        ],
      },
    },
  },
};

describe('threads', () => {
  const page = parseThreadsPage(threadData);
  it('maps threads', () => {
    expect(page.hasNext).toBe(true);
    expect(page.cursor).toBe('cur');
    expect(page.threads).toHaveLength(2);
    expect(page.threads[0]).toMatchObject({ id: 'T1', path: 'a.kt', side: 'RIGHT', line: 12, startLine: 10, outdated: false, resolved: false, canResolve: true });
    expect(page.threads[0].comments.map((c) => [c.id, c.pending, c.mine])).toEqual([['101', false, false], ['102', true, false]]);
    expect(page.threads[1]).toMatchObject({ side: 'LEFT', line: 0, outdated: true, resolved: true, canResolve: true });
    expect(page.threads[1].startLine).toBeUndefined();
    expect(page.threads[1].comments[0].author).toBe('ghost');
  });
  it('counts comments per file', () => {
    expect(commentCounts(page.threads).get('a.kt')).toBe(3);
  });
});

describe('drafts', () => {
  it('adds, edits, deletes and numbers drafts', () => {
    const s = emptyDrafts('h1');
    const a = addDraft(s, { path: 'a.kt', side: 'RIGHT', line: 5, body: 'one' });
    const b = addDraft(s, { path: 'b.kt', side: 'LEFT', line: 9, startLine: 7, body: 'two' });
    expect([a.id, b.id]).toEqual(['draft-1', 'draft-2']);
    expect(editDraft(s, 'draft-1', 'uno')).toBe(true);
    expect(editDraft(s, 'nope', 'x')).toBe(false);
    expect(s.drafts[0].body).toBe('uno');
    expect(deleteDraft(s, 'draft-1')).toBe(true);
    expect(deleteDraft(s, 'draft-1')).toBe(false);
    expect(draftCounts(s.drafts).get('b.kt')).toBe(1);
  });
  it('reads saved values safely', () => {
    expect(readDraftStore(undefined, 'h').drafts).toEqual([]);
    expect(readDraftStore({ drafts: 'x' }, 'h').next).toBe(1);
    const s = readDraftStore({ headSha: 'old', next: 1, reviewBody: 'r', drafts: [{ id: 'draft-7', path: 'a', side: 'RIGHT', line: 1, body: 'b' }, { id: 5 }] }, 'h');
    expect(s.drafts).toHaveLength(1);
    expect(s.headSha).toBe('old');
    expect(s.next).toBe(8);
    expect(s.reviewBody).toBe('r');
  });
  it('shows drafts inside the threads of a file', () => {
    const page = parseThreadsPage(threadData);
    const s = emptyDrafts('h');
    addDraft(s, { path: 'a.kt', side: 'RIGHT', line: 3, body: 'new' });
    addDraft(s, { path: 'a.kt', side: 'RIGHT', line: 12, body: 'reply', reply: { threadId: 'T1', commentId: '101' } });
    addDraft(s, { path: 'other.kt', side: 'RIGHT', line: 1, body: 'x' });
    const t = threadsForFile('a.kt', page.threads, s.drafts, 'me');
    expect(t.map((x) => x.id)).toEqual(['T1', 'T2', 'draft-thread-draft-1']);
    expect(t[0].comments.at(-1)).toMatchObject({ id: 'draft-2', pending: true, mine: true, author: 'me' });
    expect(t[2].comments[0].body).toBe('new');
    expect(splitDrafts(s.drafts)).toMatchObject({ lines: [{ id: 'draft-1' }, { id: 'draft-3' }], replies: [{ id: 'draft-2' }] });
  });
});

describe('payloads', () => {
  it('orders a range and drops start_line for one line', () => {
    expect(normalizeRange({ side: 'RIGHT', line: 5 })).toEqual({ line: 5 });
    expect(normalizeRange({ side: 'RIGHT', line: 5, startLine: 5 })).toEqual({ line: 5 });
    expect(normalizeRange({ side: 'RIGHT', line: 5, startLine: 9 })).toEqual({ line: 9, start: 5 });
  });
  it('builds a single comment', () => {
    expect(buildLineComment('sha', 'a.kt', { side: 'LEFT', line: 4 }, 'b')).toEqual({ commit_id: 'sha', path: 'a.kt', line: 4, side: 'LEFT', body: 'b' });
  });
  it('builds a comment on several lines with both sides', () => {
    expect(buildLineComment('sha', 'a.kt', { side: 'RIGHT', line: 12, startLine: 10 }, 'b')).toEqual({ commit_id: 'sha', path: 'a.kt', line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT', body: 'b' });
  });
  it('builds a review with drafts', () => {
    const s = emptyDrafts('h');
    addDraft(s, { path: 'a.kt', side: 'RIGHT', line: 3, body: 'x' });
    addDraft(s, { path: 'b.kt', side: 'LEFT', line: 8, startLine: 6, body: 'y' });
    expect(buildReviewPayload('sha', 'REQUEST_CHANGES', '  fix it  ', s.drafts)).toEqual({
      commit_id: 'sha',
      event: 'REQUEST_CHANGES',
      body: 'fix it',
      comments: [
        { path: 'a.kt', line: 3, side: 'RIGHT', body: 'x' },
        { path: 'b.kt', line: 8, side: 'LEFT', start_line: 6, start_side: 'LEFT', body: 'y' },
      ],
    });
  });
  it('leaves out an empty body and empty comments', () => {
    expect(buildReviewPayload('sha', 'APPROVE', '', [])).toEqual({ commit_id: 'sha', event: 'APPROVE' });
  });
  it('validates reviews', () => {
    expect(validateReview('APPROVE', '', 0)).toBeNull();
    expect(validateReview('COMMENT', ' ', 0)).not.toBeNull();
    expect(validateReview('COMMENT', '', 2)).toBeNull();
    expect(validateReview('REQUEST_CHANGES', '', 0)).not.toBeNull();
  });
});
