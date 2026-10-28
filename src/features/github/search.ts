// Pure helpers for the sidebar: search queries, the GraphQL text and the rows.

export type SectionId = 'review' | 'mine' | 'repo';

export interface RepoName {
  owner: string;
  name: string;
}

export function buildSearchQuery(section: SectionId, repo?: RepoName | null): string {
  const tail = 'archived:false sort:updated-desc';
  if (section === 'review') return `is:pr is:open review-requested:@me ${tail}`;
  if (section === 'mine') return `is:pr is:open author:@me ${tail}`;
  if (!repo) throw new Error('The repository search needs a repository.');
  return `is:pr is:open repo:${repo.owner}/${repo.name} ${tail}`;
}

/** Operation names. The fake `gh` answers GraphQL by operation name. */
export const SEARCH_OPERATION: Record<SectionId, string> = {
  review: 'KestrelSearchReviewRequested',
  mine: 'KestrelSearchMyPulls',
  repo: 'KestrelSearchRepoPulls',
};

export function searchGraphql(section: SectionId): string {
  return `query ${SEARCH_OPERATION[section]}($q: String!) {
  viewer { login }
  search(type: ISSUE, first: 50, query: $q) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt
        author { login }
        repository { nameWithOwner }
        headRefName baseRefName
        reviewDecision
        latestReviews(first: 20) { nodes { state author { login } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        additions deletions
      }
    }
  }
}`;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type ChecksState = 'passed' | 'failed' | 'running' | null;

export interface PullRow {
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updatedAt: string;
  author: string;
  headRef: string;
  baseRef: string;
  decision: ReviewDecision;
  /** State of the review of the signed in user, if there is one. */
  myReview: string | null;
  checks: ChecksState;
  additions: number;
  deletions: number;
}

export interface SearchAnswer {
  viewer?: { login?: string } | null;
  search?: { issueCount?: number; nodes?: (RawPull | null)[] | null } | null;
}

interface RawPull {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  updatedAt?: string;
  author?: { login?: string } | null;
  repository?: { nameWithOwner?: string } | null;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string | null;
  latestReviews?: { nodes?: ({ state?: string; author?: { login?: string } | null } | null)[] | null } | null;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null)[] | null } | null;
  additions?: number;
  deletions?: number;
}

export function checksFromRollup(state: string | undefined | null): ChecksState {
  switch (state) {
    case 'SUCCESS':
      return 'passed';
    case 'FAILURE':
    case 'ERROR':
      return 'failed';
    case 'PENDING':
    case 'EXPECTED':
      return 'running';
    default:
      return null;
  }
}

function decisionOf(v: string | null | undefined): ReviewDecision {
  return v === 'APPROVED' || v === 'CHANGES_REQUESTED' || v === 'REVIEW_REQUIRED' ? v : null;
}

function hostOfUrl(url: string, fallback: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return fallback;
  }
}

/** Turns the GraphQL answer into rows. Nodes that are not pull requests are skipped. */
export function rowsFromSearch(host: string, data: SearchAnswer | null | undefined): { rows: PullRow[]; total: number } {
  const me = data?.viewer?.login ?? '';
  const nodes = data?.search?.nodes ?? [];
  const rows: PullRow[] = [];
  for (const n of nodes) {
    if (!n || typeof n.number !== 'number' || !n.repository?.nameWithOwner) continue;
    const [owner, repo] = n.repository.nameWithOwner.split('/');
    if (!owner || !repo) continue;
    const mine = n.latestReviews?.nodes?.find((r) => r && me && r.author?.login === me);
    const url = n.url ?? `https://${host}/${owner}/${repo}/pull/${n.number}`;
    rows.push({
      host: hostOfUrl(url, host),
      owner,
      repo,
      number: n.number,
      title: n.title ?? '',
      url,
      draft: !!n.isDraft,
      updatedAt: n.updatedAt ?? '',
      author: n.author?.login ?? 'ghost',
      headRef: n.headRefName ?? '',
      baseRef: n.baseRefName ?? '',
      decision: decisionOf(n.reviewDecision),
      myReview: mine?.state ?? null,
      checks: checksFromRollup(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
      additions: n.additions ?? 0,
      deletions: n.deletions ?? 0,
    });
  }
  return { rows, total: data?.search?.issueCount ?? rows.length };
}

export const DECISION_LABEL: Record<Exclude<ReviewDecision, null>, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
};

export const CHECKS_LABEL: Record<Exclude<ChecksState, null>, string> = {
  passed: 'Checks passed',
  failed: 'Checks failed',
  running: 'Checks running',
};

/** Merges the rows of several hosts: newest update first. The same pull request appears once. */
export function mergeRows(lists: PullRow[][]): PullRow[] {
  const seen = new Set<string>();
  const all = lists.flat().filter((r) => {
    const key = `${r.host}/${r.owner}/${r.repo}#${r.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
