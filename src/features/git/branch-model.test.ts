import { describe, expect, it } from 'vitest';
import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from '../../ipc/git';
import {
  buildBranchItems,
  buildStartPointItems,
  dirtyDecision,
  isSwitchTarget,
  shortGitMessage,
  sortLocal,
  switchRequest,
  upstreamText,
  validateBranchName,
  visibleRemotes,
} from './branch-model';

const NOW = 1_700_000_000;

function local(name: string, o: Partial<GitLocalBranch> = {}): GitLocalBranch {
  return { name, current: false, sha: 'abc1234', time: NOW - 3600, subject: `work on ${name}`, upstream: null, ahead: 0, behind: 0, gone: false, ...o };
}
function remote(name: string, o: Partial<GitRemoteBranch> = {}): GitRemoteBranch {
  return { name, remote: name.split('/')[0], sha: 'def5678', time: NOW - 86400, subject: 'remote work', ...o };
}
function list(l: GitLocalBranch[], r: GitRemoteBranch[] = [], o: Partial<GitBranchList> = {}): GitBranchList {
  const cur = l.find((b) => b.current)?.name ?? null;
  return { current: cur, detached: false, head: 'abc1234', local: l, remote: r, ...o };
}

describe('sortLocal', () => {
  it('puts the current branch first, then the newest commit', () => {
    const sorted = sortLocal([
      local('old', { time: 100 }),
      local('main', { time: 200, current: false }),
      local('feature/x', { time: 50, current: true }),
      local('new', { time: 900 }),
    ]);
    expect(sorted.map((b) => b.name)).toEqual(['feature/x', 'new', 'main', 'old']);
  });
  it('uses the name when times are equal', () => {
    expect(sortLocal([local('b', { time: 1 }), local('a', { time: 1 })]).map((b) => b.name)).toEqual(['a', 'b']);
  });
});

describe('visibleRemotes', () => {
  it('hides remote branches that have a local branch', () => {
    const l = list([local('main', { current: true }), local('feature/x')], [
      remote('origin/main'),
      remote('origin/feature/x'),
      remote('origin/other/y'),
    ]);
    expect(visibleRemotes(l).map((r) => r.name)).toEqual(['origin/other/y']);
  });
  it('hides a remote branch that is the upstream of a local branch with another name', () => {
    const l = list([local('fix', { upstream: 'origin/feature/z' })], [remote('origin/feature/z')]);
    expect(visibleRemotes(l)).toEqual([]);
  });
  it('keeps the same short name from a second remote', () => {
    const l = list([local('main', { current: true, upstream: 'origin/main' })], [remote('origin/main'), remote('upstream/main')]);
    // `main` exists locally, so both are hidden.
    expect(visibleRemotes(l)).toEqual([]);
    const l2 = list([local('main', { current: true })], [remote('origin/dev'), remote('upstream/dev', { time: NOW })]);
    expect(visibleRemotes(l2).map((r) => r.name)).toEqual(['upstream/dev', 'origin/dev']);
  });
});

describe('upstreamText', () => {
  it('shows counts, gone and no upstream', () => {
    expect(upstreamText(local('a'))).toBe('');
    expect(upstreamText(local('a', { upstream: 'origin/a' }))).toBe('origin/a');
    expect(upstreamText(local('a', { upstream: 'origin/a', ahead: 2, behind: 1 }))).toBe('origin/a ↑2 ↓1');
    expect(upstreamText(local('a', { upstream: 'origin/a', gone: true }))).toBe('origin/a (gone)');
  });
});

describe('buildBranchItems', () => {
  const l = list(
    [local('main', { time: NOW - 100 }), local('feature/a/b', { current: true, upstream: 'origin/feature/a/b', ahead: 1, time: NOW - 7200 })],
    [remote('origin/main'), remote('origin/team/new-thing')],
  );

  it('starts with the actions, then local, then remote', () => {
    const items = buildBranchItems(l, { now: NOW });
    expect(items.map((i) => i.id)).toEqual([
      'new',
      'newFrom',
      'fetch',
      'local:feature/a/b',
      'local:main',
      'remote:origin/team/new-thing',
    ]);
    expect(items[0].label).toBe('Create New Branch...');
    expect(items[1].label).toBe('Create New Branch From...');
  });

  it('marks the current branch and fills description and detail', () => {
    const icon = () => document.createElement('i');
    const items = buildBranchItems(l, { now: NOW, checkIcon: icon });
    const cur = items.find((i) => i.id === 'local:feature/a/b')!;
    expect(cur.current).toBe(true);
    expect(cur.icon).toBe(icon);
    expect(cur.description).toBe('origin/feature/a/b ↑1');
    expect(cur.detail).toBe('work on feature/a/b · 2 hours ago');
    expect(items.find((i) => i.id === 'local:main')!.icon).toBeUndefined();
    const rem = items.find((i) => i.kind === 'remote')!;
    expect(rem.label).toBe('origin/team/new-thing');
    expect(rem.detail).toBe('remote work · 1 day ago');
  });

  it('shows a wait text while a fetch runs', () => {
    const items = buildBranchItems(l, { now: NOW, fetching: true });
    expect(items[2]).toMatchObject({ id: 'fetching', kind: 'fetching', label: 'Fetching...' });
  });

  it('shows a detached HEAD with its short sha', () => {
    const d = list([local('main')], [], { detached: true, current: null, head: 'abc1234' });
    const items = buildBranchItems(d, { now: NOW });
    expect(items[3]).toMatchObject({ kind: 'detached', label: 'HEAD (detached at abc1234)', current: true });
    expect(isSwitchTarget(items[3])).toBe(false);
  });

  it('handles an empty repo', () => {
    const items = buildBranchItems(list([], [], { head: null }), { now: NOW });
    expect(items.map((i) => i.kind)).toEqual(['new', 'newFrom', 'fetch']);
  });
});

describe('buildStartPointItems', () => {
  it('lists all local and remote branches, even remote ones with a local branch', () => {
    const l = list([local('main', { current: true })], [remote('origin/main')]);
    const items = buildStartPointItems(l, { now: NOW });
    expect(items.map((i) => i.id)).toEqual(['main', 'origin/main']);
  });
});

describe('switchRequest', () => {
  it('does nothing for the current branch', () => {
    const items = buildBranchItems(list([local('main', { current: true })]), { now: NOW });
    expect(switchRequest(items.find((i) => i.kind === 'local')!)).toBeNull();
    expect(switchRequest(items[0])).toBeNull();
  });
  it('switches to a local branch with slashes', () => {
    const items = buildBranchItems(list([local('a/b/c')]), { now: NOW });
    expect(switchRequest(items.find((i) => i.kind === 'local')!)).toEqual({ branch: 'a/b/c' });
  });
  it('tracks a remote branch', () => {
    const items = buildBranchItems(list([local('main', { current: true })], [remote('origin/feature/x')]), { now: NOW });
    expect(switchRequest(items.find((i) => i.kind === 'remote')!)).toEqual({ branch: 'feature/x', track: 'origin/feature/x' });
  });
});

describe('dirtyDecision', () => {
  const ed = (path: string, dirty: boolean) => ({ path, isDirty: () => dirty });
  it('does not ask when all editors are saved', () => {
    expect(dirtyDecision([]).ask).toBe(false);
    expect(dirtyDecision([ed('/a/b.ts', false)]).ask).toBe(false);
  });
  it('asks and names the files', () => {
    const d = dirtyDecision([ed('/a/b.ts', true), ed('C:\\x\\y.rs', true), ed('/z', false)]);
    expect(d.ask).toBe(true);
    expect(d.names).toEqual(['b.ts', 'y.rs']);
    expect(d.message).toContain('2 files have unsaved changes: b.ts, y.rs');
  });
  it('cuts a long list', () => {
    const many = Array.from({ length: 8 }, (_, i) => ed(`/f${i}.txt`, true));
    expect(dirtyDecision(many).message).toContain('and 3 more');
  });
});

describe('validateBranchName', () => {
  it('accepts normal names', () => {
    for (const n of ['feature/x', 'fix-123', 'v1.2.3', 'user/tuan/日本語', 'a_b']) expect(validateBranchName(n)).toBeNull();
  });
  it('rejects names that git rejects', () => {
    for (const n of ['', ' ', 'a b', '-x', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '/a', 'a/', 'a//b', 'a.', 'x.lock', 'a/.b', 'a/b.lock/c', '@', 'HEAD', 'a@{b']) {
      expect(validateBranchName(n), JSON.stringify(n)).not.toBeNull();
    }
  });
  it('rejects a name that exists', () => {
    expect(validateBranchName('main', ['main', 'dev'])).toContain('already exists');
  });
});

describe('shortGitMessage', () => {
  it('cuts long messages', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const out = shortGitMessage(text, 5);
    expect(out.split('\n')).toHaveLength(6);
    expect(out.endsWith('...')).toBe(true);
    expect(shortGitMessage('one\ntwo')).toBe('one\ntwo');
  });
});
