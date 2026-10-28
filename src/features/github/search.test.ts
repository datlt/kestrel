import { describe, expect, it } from 'vitest';
import { buildSearchQuery, checksFromRollup, mergeRows, rowsFromSearch, searchGraphql } from './search';

describe('buildSearchQuery', () => {
  it('builds the three sections', () => {
    expect(buildSearchQuery('review')).toContain('is:pr is:open review-requested:@me');
    expect(buildSearchQuery('mine')).toContain('author:@me');
    expect(buildSearchQuery('repo', { owner: 'acme', name: 'shop' })).toContain('repo:acme/shop');
  });
  it('needs a repository for the repository section', () => {
    expect(() => buildSearchQuery('repo')).toThrow();
  });
  it('names the operations Kestrel...', () => {
    expect(searchGraphql('review')).toMatch(/^query KestrelSearchReviewRequested\(/);
    expect(searchGraphql('mine')).toMatch(/^query KestrelSearchMyPulls\(/);
    expect(searchGraphql('repo')).toMatch(/^query KestrelSearchRepoPulls\(/);
  });
});

describe('rowsFromSearch', () => {
  const data = {
    viewer: { login: 'me' },
    search: {
      issueCount: 2,
      nodes: [
        {
          number: 5,
          title: 'Add cart',
          url: 'https://h/acme/shop/pull/5',
          isDraft: true,
          updatedAt: '2026-01-02T00:00:00Z',
          author: { login: 'bob' },
          repository: { nameWithOwner: 'acme/shop' },
          headRefName: 'cart',
          baseRefName: 'main',
          reviewDecision: 'REVIEW_REQUIRED',
          latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'me' } }, { state: 'COMMENTED', author: { login: 'zed' } }] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
          additions: 10,
          deletions: 2,
        },
        {},
        null,
        { number: 6, repository: { nameWithOwner: 'acme/shop' } },
      ],
    },
  };
  it('maps fields', () => {
    const { rows, total } = rowsFromSearch('h', data);
    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ host: 'h', owner: 'acme', repo: 'shop', number: 5, draft: true, author: 'bob', decision: 'REVIEW_REQUIRED', myReview: 'APPROVED', checks: 'failed', additions: 10 });
    expect(rows[1]).toMatchObject({ number: 6, author: 'ghost', decision: null, checks: null, url: 'https://h/acme/shop/pull/6' });
  });
  it('handles empty answers', () => {
    expect(rowsFromSearch('h', null)).toEqual({ rows: [], total: 0 });
  });
  it('maps checks', () => {
    expect(checksFromRollup('SUCCESS')).toBe('passed');
    expect(checksFromRollup('PENDING')).toBe('running');
    expect(checksFromRollup(undefined)).toBeNull();
  });
  it('sorts merged rows by update time', () => {
    const a = { host: 'h', owner: 'o', repo: 'r', number: 1, updatedAt: '2026-01-01' } as any;
    const b = { host: 'h', owner: 'o', repo: 'r', number: 2, updatedAt: '2026-02-01' } as any;
    expect(mergeRows([[a], [b]])).toEqual([b, a]);
  });
  it('lists one pull request once', () => {
    const a = { host: 'h', owner: 'o', repo: 'r', number: 1, updatedAt: '2026-01-01' } as any;
    expect(mergeRows([[a], [{ ...a }]])).toHaveLength(1);
  });
});
