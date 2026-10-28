// Pure model of one pull request: REST answers, review threads, drafts and the
// payloads that go to GitHub. No DOM and no IPC here, so vitest can run it.

import type { DiffSide, ReviewComment, ReviewThread } from './review-diff/types';

// ---------------------------------------------------------------------------
// Pull request
// ---------------------------------------------------------------------------

export interface PrUser {
  login: string;
}

export interface PrInfo {
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headRef: string;
  headSha: string;
  /** `owner/repo` of the head branch (a fork can differ from the base repository). */
  headRepo: string;
  baseRef: string;
  baseSha: string;
  mergeableState: string;
  author: string;
  htmlUrl: string;
  labels: { name: string; color: string }[];
  requestedUsers: string[];
  requestedTeams: string[];
  createdAt: string;
  updatedAt: string;
}

export function parsePull(j: any): PrInfo {
  return {
    title: String(j?.title ?? ''),
    body: String(j?.body ?? ''),
    state: j?.merged || j?.merged_at ? 'merged' : j?.state === 'closed' ? 'closed' : 'open',
    draft: !!j?.draft,
    headRef: String(j?.head?.ref ?? ''),
    headSha: String(j?.head?.sha ?? ''),
    headRepo: String(j?.head?.repo?.full_name ?? ''),
    baseRef: String(j?.base?.ref ?? ''),
    baseSha: String(j?.base?.sha ?? ''),
    mergeableState: String(j?.mergeable_state ?? ''),
    author: String(j?.user?.login ?? 'ghost'),
    htmlUrl: String(j?.html_url ?? ''),
    labels: Array.isArray(j?.labels) ? j.labels.map((l: any) => ({ name: String(l?.name ?? ''), color: String(l?.color ?? '') })) : [],
    requestedUsers: Array.isArray(j?.requested_reviewers) ? j.requested_reviewers.map((u: any) => String(u?.login ?? '')).filter(Boolean) : [],
    requestedTeams: Array.isArray(j?.requested_teams) ? j.requested_teams.map((t: any) => String(t?.slug ?? t?.name ?? '')).filter(Boolean) : [],
    createdAt: String(j?.created_at ?? ''),
    updatedAt: String(j?.updated_at ?? ''),
  };
}

/** `compare/<base>...<head>` path and the merge base from its answer. */
export const comparePath = (owner: string, repo: string, baseSha: string, headSha: string) =>
  `repos/${owner}/${repo}/compare/${baseSha}...${headSha}`;

export function mergeBaseOf(compare: any, fallback: string): string {
  const sha = compare?.merge_base_commit?.sha;
  return typeof sha === 'string' && sha ? sha : fallback;
}

export function mergeableText(state: string): string | null {
  switch (state) {
    case 'clean':
      return 'Can be merged';
    case 'dirty':
      return 'Has merge conflicts';
    case 'blocked':
      return 'Merge is blocked';
    case 'behind':
      return 'Branch is behind the base';
    case 'unstable':
      return 'Some checks failed';
    case 'draft':
      return 'Draft';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Checks of the head commit
// ---------------------------------------------------------------------------

export interface ChecksSummary {
  passed: number;
  failed: number;
  running: number;
  total: number;
}

export function summarizeChecks(answer: any): ChecksSummary {
  const runs: any[] = Array.isArray(answer?.check_runs) ? answer.check_runs : [];
  const s: ChecksSummary = { passed: 0, failed: 0, running: 0, total: runs.length };
  for (const r of runs) {
    if (r?.status !== 'completed') s.running++;
    else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r?.conclusion)) s.failed++;
    else s.passed++;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface PrFile {
  path: string;
  /** Old path of a renamed file. */
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export function parseFiles(list: any): PrFile[] {
  if (!Array.isArray(list)) return [];
  return list.map((f) => {
    const raw = String(f?.status ?? 'modified');
    const status: FileStatus = raw === 'added' ? 'added' : raw === 'removed' ? 'deleted' : raw === 'renamed' ? 'renamed' : 'modified';
    return {
      path: String(f?.filename ?? ''),
      oldPath: status === 'renamed' && f?.previous_filename ? String(f.previous_filename) : undefined,
      status,
      additions: Number(f?.additions ?? 0),
      deletions: Number(f?.deletions ?? 0),
    };
  });
}

/** Path where the file lives in the base (merge base) commit. null: the file is new. */
export const oldPathOf = (f: PrFile): string | null => (f.status === 'added' ? null : (f.oldPath ?? f.path));
/** Path where the file lives at the head commit. null: the file was deleted. */
export const newPathOf = (f: PrFile): string | null => (f.status === 'deleted' ? null : f.path);

export function filterFiles(files: PrFile[], query: string): PrFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => f.path.toLowerCase().includes(q) || (f.oldPath ?? '').toLowerCase().includes(q));
}

/** Index of the next file in the list (wraps nowhere: returns -1 at the end). */
export function stepIndex(count: number, current: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  const next = current + dir;
  return next < 0 || next >= count ? -1 : next;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineItem {
  kind: 'comment' | 'review';
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** Reviews only: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`. */
  state?: string;
}

export function buildTimeline(issueComments: any[], reviews: any[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const c of issueComments ?? []) {
    items.push({ kind: 'comment', id: `c${c?.id}`, author: String(c?.user?.login ?? 'ghost'), body: String(c?.body ?? ''), createdAt: String(c?.created_at ?? '') });
  }
  for (const r of reviews ?? []) {
    if (r?.state === 'PENDING') continue;
    items.push({
      kind: 'review',
      id: `r${r?.id}`,
      author: String(r?.user?.login ?? 'ghost'),
      body: String(r?.body ?? ''),
      createdAt: String(r?.submitted_at ?? r?.created_at ?? ''),
      state: String(r?.state ?? 'COMMENTED'),
    });
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export function reviewStateText(state: string | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'approved these changes';
    case 'CHANGES_REQUESTED':
      return 'requested changes';
    case 'DISMISSED':
      return 'review was dismissed';
    default:
      return 'reviewed';
  }
}

export interface ReviewerState {
  login: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING` (asked, no answer yet). */
  state: string;
}

/** The last review of each person (comments do not replace an approval), then the ones that were asked. */
export function reviewerStates(reviews: any[], requestedUsers: string[], author: string): ReviewerState[] {
  const last = new Map<string, string>();
  for (const r of [...(reviews ?? [])].sort((a, b) => String(a?.submitted_at ?? '').localeCompare(String(b?.submitted_at ?? '')))) {
    const login = r?.user?.login;
    const state = r?.state;
    if (!login || login === author || !state || state === 'PENDING') continue;
    const prev = last.get(login);
    if (state === 'COMMENTED' && (prev === 'APPROVED' || prev === 'CHANGES_REQUESTED')) continue;
    last.set(login, state);
  }
  const out: ReviewerState[] = [...last].map(([login, state]) => ({ login, state }));
  for (const login of requestedUsers) {
    const i = out.findIndex((o) => o.login === login);
    if (i >= 0) out[i] = { login, state: 'PENDING' };
    else out.push({ login, state: 'PENDING' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review threads (GraphQL)
// ---------------------------------------------------------------------------

export const THREADS_QUERY = `query KestrelReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path
          resolvedBy { login }
          line startLine originalLine originalStartLine
          diffSide startDiffSide
          viewerCanResolve viewerCanUnresolve
          comments(first: 100) {
            nodes { id databaseId body createdAt state author { login } }
          }
        }
      }
    }
  }
}`;

export const RESOLVE_MUTATION = `mutation KestrelResolveThread($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

export const UNRESOLVE_MUTATION = `mutation KestrelUnresolveThread($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

export interface PrThread extends ReviewThread {
  path: string;
  canResolve: boolean;
}

export interface ThreadsPage {
  threads: PrThread[];
  hasNext: boolean;
  cursor: string | null;
}

export function parseThreadsPage(data: any): ThreadsPage {
  const conn = data?.repository?.pullRequest?.reviewThreads;
  const nodes: any[] = Array.isArray(conn?.nodes) ? conn.nodes : [];
  const threads: PrThread[] = [];
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') continue;
    const comments: ReviewComment[] = (n.comments?.nodes ?? []).filter(Boolean).map((c: any) => {
      const author = String(c.author?.login ?? 'ghost');
      return {
        id: String(c.databaseId ?? c.id),
        author,
        body: String(c.body ?? ''),
        createdAt: String(c.createdAt ?? ''),
        pending: c.state === 'PENDING',
        // Only Kestrel drafts can be edited here. A pending review on GitHub is edited on GitHub.
        mine: false,
      };
    });
    if (comments.length === 0) continue;
    const outdated = !!n.isOutdated;
    const line = Number(n.line ?? 0) || 0;
    const startLine = Number(n.startLine ?? 0) || 0;
    const t: PrThread = {
      id: n.id,
      path: String(n.path ?? ''),
      side: n.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
      line,
      outdated,
      resolved: !!n.isResolved,
      resolvedBy: n.resolvedBy?.login ? String(n.resolvedBy.login) : undefined,
      comments,
      canResolve: !!(n.isResolved ? n.viewerCanUnresolve : n.viewerCanResolve),
    };
    if (startLine && startLine < line) t.startLine = startLine;
    threads.push(t);
  }
  return { threads, hasNext: !!conn?.pageInfo?.hasNextPage, cursor: conn?.pageInfo?.endCursor ?? null };
}

/** Number of comments (all threads, all comments) per file path. */
export function commentCounts(threads: PrThread[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of threads) m.set(t.path, (m.get(t.path) ?? 0) + t.comments.length);
  return m;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface Draft {
  /** `draft-<n>`. The review diff uses this as the comment id. */
  id: string;
  path: string;
  side: DiffSide;
  line: number;
  startLine?: number;
  body: string;
  /** Reply to a thread: the thread id and the REST id of its first comment. */
  reply?: { threadId: string; commentId: string };
}

export interface DraftStore {
  /** Head commit when the drafts were written. */
  headSha: string;
  drafts: Draft[];
  /** The text of the "Finish Review" box. */
  reviewBody: string;
  next: number;
}

export const emptyDrafts = (headSha: string): DraftStore => ({ headSha, drafts: [], reviewBody: '', next: 1 });

/** Reads the saved value. Anything that does not look right gives an empty store. */
export function readDraftStore(raw: unknown, headSha: string): DraftStore {
  const r = raw as Partial<DraftStore> | null | undefined;
  if (!r || !Array.isArray(r.drafts)) return emptyDrafts(headSha);
  const drafts = r.drafts.filter(
    (d): d is Draft => !!d && typeof d.id === 'string' && typeof d.path === 'string' && typeof d.body === 'string' && typeof d.line === 'number' && (d.side === 'LEFT' || d.side === 'RIGHT'),
  );
  const next = Math.max(typeof r.next === 'number' ? r.next : 1, ...drafts.map((d) => Number(d.id.replace('draft-', '')) + 1 || 1));
  return { headSha: typeof r.headSha === 'string' ? r.headSha : headSha, drafts, reviewBody: typeof r.reviewBody === 'string' ? r.reviewBody : '', next };
}

export function addDraft(store: DraftStore, d: Omit<Draft, 'id'>): Draft {
  const draft: Draft = { ...d, id: `draft-${store.next++}` };
  store.drafts.push(draft);
  return draft;
}

export function editDraft(store: DraftStore, id: string, body: string): boolean {
  const d = store.drafts.find((x) => x.id === id);
  if (!d) return false;
  d.body = body;
  return true;
}

export function deleteDraft(store: DraftStore, id: string): boolean {
  const i = store.drafts.findIndex((x) => x.id === id);
  if (i < 0) return false;
  store.drafts.splice(i, 1);
  return true;
}

/** Drafts that start a new thread (they go into the review) and drafts that reply (sent as replies). */
export function splitDrafts(drafts: Draft[]): { lines: Draft[]; replies: Draft[] } {
  return { lines: drafts.filter((d) => !d.reply), replies: drafts.filter((d) => !!d.reply) };
}

/**
 * The threads of one file for the review diff: the threads of GitHub, with
 * reply drafts added to their thread, and one new thread for each line draft.
 */
export function threadsForFile(path: string, threads: PrThread[], drafts: Draft[], me: string): ReviewThread[] {
  const toComment = (d: Draft): ReviewComment => ({ id: d.id, author: me, body: d.body, createdAt: '', pending: true, mine: true });
  const out: ReviewThread[] = threads
    .filter((t) => t.path === path)
    .map((t) => ({
      id: t.id,
      side: t.side,
      line: t.line,
      startLine: t.startLine,
      outdated: t.outdated,
      resolved: t.resolved,
      resolvedBy: t.resolvedBy,
      comments: [...t.comments, ...drafts.filter((d) => d.reply?.threadId === t.id).map(toComment)],
    }));
  for (const d of drafts) {
    if (d.reply || d.path !== path) continue;
    const t: ReviewThread = { id: `draft-thread-${d.id}`, side: d.side, line: d.line, outdated: false, resolved: false, comments: [toComment(d)] };
    if (d.startLine && d.startLine < d.line) t.startLine = d.startLine;
    out.push(t);
  }
  return out;
}

/** Drafts per file path (for the file list). */
export function draftCounts(drafts: Draft[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of drafts) m.set(d.path, (m.get(d.path) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------
// Payloads for GitHub
// ---------------------------------------------------------------------------

export interface LineRange {
  side: DiffSide;
  line: number;
  startLine?: number;
}

/** Lines in order, and `start_line` only for a real range. */
export function normalizeRange(r: LineRange): { line: number; start?: number } {
  if (r.startLine && r.startLine !== r.line) {
    const lo = Math.min(r.startLine, r.line);
    const hi = Math.max(r.startLine, r.line);
    return { line: hi, start: lo };
  }
  return { line: r.line };
}

export interface RestLineComment {
  path: string;
  line: number;
  side: DiffSide;
  start_line?: number;
  start_side?: DiffSide;
  body: string;
}

function lineFields(path: string, r: LineRange, body: string): RestLineComment {
  const n = normalizeRange(r);
  const c: RestLineComment = { path, line: n.line, side: r.side, body };
  if (n.start !== undefined) {
    c.start_line = n.start;
    c.start_side = r.side;
  }
  return c;
}

/** Body of `POST pulls/<n>/comments` (a comment that is posted at once). */
export function buildLineComment(commitId: string, path: string, r: LineRange, body: string): RestLineComment & { commit_id: string } {
  return { commit_id: commitId, ...lineFields(path, r, body) };
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewPayload {
  commit_id: string;
  event: ReviewEvent;
  body?: string;
  comments?: RestLineComment[];
}

/** Body of `POST pulls/<n>/reviews`. Reply drafts are not part of it. */
export function buildReviewPayload(commitId: string, event: ReviewEvent, body: string, lineDrafts: Draft[]): ReviewPayload {
  const p: ReviewPayload = { commit_id: commitId, event };
  const text = body.trim();
  if (text) p.body = text;
  if (lineDrafts.length > 0) p.comments = lineDrafts.map((d) => lineFields(d.path, d, d.body));
  return p;
}

/** An error text when GitHub would refuse the review, else null. */
export function validateReview(event: ReviewEvent, body: string, draftCount: number): string | null {
  const hasBody = body.trim().length > 0;
  if (event === 'COMMENT' && !hasBody && draftCount === 0) return 'Write a comment or add draft comments first.';
  if (event === 'REQUEST_CHANGES' && !hasBody && draftCount === 0) return 'Write what must change, or add draft comments.';
  return null;
}

export const REVIEW_EVENT_LABEL: Record<ReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request Changes',
};
