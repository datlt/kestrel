// Sidebar view "Pull Requests": accounts of `gh` and three lists of pull requests.

import {
  createElement,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  GitPullRequestDraft,
  LogOut,
  Plus,
  Repeat,
  RefreshCw,
} from 'lucide';
import type { AppContext, ViewInstance } from '../../core/types';
import { h } from '../../core/dom';
import { ghLoginCommand, ghLogout, ghSwitch, type GhAccount } from '../../ipc/gh';
import { relativeTime } from '../git/format';
import { errorText, isCancelled } from './api';
import { prShort } from './parse';
import { openExternal } from './rendered';
import {
  buildSearchQuery,
  CHECKS_LABEL,
  DECISION_LABEL,
  mergeRows,
  rowsFromSearch,
  searchGraphql,
  type PullRow,
  type SearchAnswer,
  type SectionId,
} from './search';
import type { GithubService } from './service';
import { openPullTab } from './tab-entry';
import './github.css';

const REFRESH_MS = 5 * 60 * 1000;

interface SectionState {
  loading: boolean;
  rows: PullRow[];
  /** Rows after removing duplicates, plus results that were not fetched. */
  total: number;
  /** A host had more results than the rows we fetched. */
  more: boolean;
  errors: { host: string; message: string }[];
  loaded: boolean;
}

const SECTIONS: { id: SectionId; title: string; empty: string }[] = [
  { id: 'review', title: 'Review Requested', empty: 'Nobody asked you for a review.' },
  { id: 'mine', title: 'My Pull Requests', empty: 'You have no open pull requests.' },
  { id: 'repo', title: 'This Repository', empty: 'This repository has no open pull requests.' },
];

export function createGithubView(ctx: AppContext, svc: GithubService, host: HTMLElement): ViewInstance {
  const collapsed = new Set<string>(ctx.workspace.globalState.get<string[]>('github.collapsed') ?? []);
  const state: Record<SectionId, SectionState> = {
    review: { loading: false, rows: [], total: 0, more: false, errors: [], loaded: false },
    mine: { loading: false, rows: [], total: 0, more: false, errors: [], loaded: false },
    repo: { loading: false, rows: [], total: 0, more: false, errors: [], loaded: false },
  };
  const runs: Record<SectionId, number> = { review: 0, mine: 0, repo: 0 };
  let shown = false;
  let active = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let accountBusy: string | null = null;

  host.classList.add('gh-view');
  const scroller = h('div', { class: 'gh-scroll' });
  host.append(scroller);

  // --- Loading ---------------------------------------------------------------

  async function searchSection(id: SectionId): Promise<void> {
    const run = ++runs[id];
    const s = state[id];
    const hosts = id === 'repo' ? (svc.repo && svc.workingHosts().includes(svc.repo.host) ? [svc.repo.host] : []) : svc.workingHosts();
    if (hosts.length === 0) {
      s.rows = [];
      s.total = 0;
      s.more = false;
      s.errors = [];
      s.loading = false;
      s.loaded = true;
      render();
      return;
    }
    s.loading = true;
    render();
    const query = buildSearchQuery(id, svc.repo ? { owner: svc.repo.owner, name: svc.repo.name } : null);
    const gql = searchGraphql(id);
    const results = await Promise.all(
      hosts.map(async (hostName) => {
        try {
          const data = await svc.calls.graphql<SearchAnswer>(hostName, gql, { q: query });
          return { host: hostName, ...rowsFromSearch(hostName, data), error: null as string | null };
        } catch (e) {
          return { host: hostName, rows: [] as PullRow[], total: 0, error: isCancelled(e) ? null : errorText(e) };
        }
      }),
    );
    if (run !== runs[id] || disposed) return;
    s.rows = mergeRows(results.map((r) => r.rows));
    const missing = results.reduce((n, r) => n + Math.max(0, r.total - r.rows.length), 0);
    s.total = s.rows.length + missing;
    s.more = missing > 0;
    s.errors = results.filter((r) => r.error).map((r) => ({ host: r.host, message: r.error as string }));
    s.loading = false;
    s.loaded = true;
    render();
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([svc.loadStatus(), svc.loadRepo()]);
    if (disposed) return;
    await Promise.all(SECTIONS.map((sec) => searchSection(sec.id)));
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (shown && active) void refreshAll();
    }, REFRESH_MS);
  }
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // --- Accounts --------------------------------------------------------------

  async function addAccount() {
    const hostName = await ctx.ui.prompt({
      title: 'Add GitHub Account: host',
      value: 'github.com',
      placeholder: 'github.com',
      validate: (v) => (/^[A-Za-z0-9.-]+(:\d+)?$/.test(v.trim()) ? null : 'Enter a host name, for example github.com'),
    });
    if (!hostName) return;
    const command = ghLoginCommand(hostName.trim());
    if (ctx.commands.get('terminal.run')) {
      await ctx.commands.execute('terminal.run', { command, title: 'gh auth login' });
      ctx.ui.notify('Finish the login in the terminal, then press the refresh button of the accounts.', { kind: 'info', timeoutMs: 8000 });
      return;
    }
    const choice = await ctx.ui.confirm({
      title: 'Run this command in a terminal',
      message: `The terminal command is not available. Open a terminal yourself and run:\n\n${command}`,
      buttons: ['Copy Command', 'Close'],
    });
    if (choice === 'Copy Command') void navigator.clipboard.writeText(command).catch(() => {});
  }

  async function switchAccount(a: GhAccount) {
    accountBusy = `${a.host}/${a.login}`;
    render();
    try {
      await ghSwitch(a.host, a.login);
    } catch (e) {
      ctx.ui.notify(`Switch failed: ${errorText(e)}`, { kind: 'error' });
    }
    accountBusy = null;
    await refreshAll();
  }

  async function logoutAccount(a: GhAccount) {
    const choice = await ctx.ui.confirm({
      title: `Log out ${a.login} from ${a.host}?`,
      message: 'gh removes the login from this computer. You can log in again later.',
      buttons: ['Log Out', 'Cancel'],
    });
    if (choice !== 'Log Out') return;
    accountBusy = `${a.host}/${a.login}`;
    render();
    try {
      await ghLogout(a.host, a.login);
    } catch (e) {
      ctx.ui.notify(`Log out failed: ${errorText(e)}`, { kind: 'error' });
    }
    accountBusy = null;
    await refreshAll();
  }

  // --- Rendering -------------------------------------------------------------

  const iconBtn = (title: string, icon: Parameters<typeof createElement>[0], onclick: () => void, spinning = false) =>
    h('button', { class: `gh-btn${spinning ? ' gh-spinning' : ''}`, type: 'button', title, 'aria-label': title, onclick }, createElement(icon));

  function accountsBlock(): HTMLElement {
    const head = h(
      'div',
      { class: 'gh-section-head gh-static' },
      h('span', { class: 'gh-section-title' }, 'Accounts'),
      h('span', { class: 'gh-spacer' }),
      iconBtn('Add Account', Plus, () => void addAccount()),
      iconBtn('Refresh Accounts', RefreshCw, () => void refreshAll(), svc.loading),
    );
    const box = h('div', { class: 'gh-accounts' });
    if (svc.problem) box.append(h('div', { class: 'gh-error' }, svc.problem));
    else if (!svc.status) box.append(h('div', { class: 'gh-muted' }, 'Loading...'));
    else if (svc.accounts().length === 0) box.append(h('div', { class: 'gh-muted' }, 'No GitHub account. Press + to add one.'));
    for (const a of svc.accounts()) {
      const bad = a.state !== 'success';
      const busy = accountBusy === `${a.host}/${a.login}`;
      const iconAct = (title: string, icon: Parameters<typeof createElement>[0], fn: () => void) =>
        h('button', { class: 'gh-btn gh-account-act', type: 'button', title, 'aria-label': title, disabled: busy, onclick: fn }, createElement(icon));
      const row = h(
        'div',
        { class: `gh-account${bad ? ' gh-bad' : ''}${a.active ? ' gh-current' : ''}`, tabindex: '0' },
        h('span', { class: 'gh-dot', title: a.active ? 'Active account of this host' : bad ? 'Login is broken' : 'Not active' }),
        h(
          'div',
          { class: 'gh-account-text' },
          h('div', { class: 'gh-account-line' }, h('span', { class: 'gh-account-login', title: a.login }, a.login), a.active ? h('span', { class: 'gh-tag' }, 'active') : null),
          h('div', { class: 'gh-account-host', title: a.host }, a.host),
        ),
        h(
          'div',
          { class: 'gh-account-acts' },
          !a.active ? iconAct(`Switch to ${a.login} on ${a.host}`, Repeat, () => void switchAccount(a)) : null,
          iconAct(`Log out ${a.login} from ${a.host}`, LogOut, () => void logoutAccount(a)),
        ),
      );
      box.append(row);
      if (bad) box.append(h('div', { class: 'gh-account-error' }, a.error || (a.state === 'timeout' ? 'gh did not answer in time.' : 'The login does not work.')));
    }
    return h('div', { class: 'gh-section' }, head, box);
  }

  function pullRow(r: PullRow): HTMLElement {
    const ref = { host: r.host, owner: r.owner, repo: r.repo, number: r.number };
    const when = r.updatedAt ? relativeTime(Date.parse(r.updatedAt) / 1000) : '';
    const badges = h('div', { class: 'gh-badges' });
    if (r.draft) badges.append(h('span', { class: 'gh-badge' }, 'Draft'));
    if (r.decision) {
      const kind = r.decision === 'APPROVED' ? 'ok' : r.decision === 'CHANGES_REQUESTED' ? 'bad' : 'wait';
      badges.append(h('span', { class: `gh-badge gh-badge-${kind}` }, DECISION_LABEL[r.decision]));
    }
    if (r.checks) {
      const kind = r.checks === 'passed' ? 'ok' : r.checks === 'failed' ? 'bad' : 'wait';
      badges.append(h('span', { class: `gh-badge gh-badge-${kind}` }, CHECKS_LABEL[r.checks]));
    }
    if (r.myReview === 'APPROVED') badges.append(h('span', { class: 'gh-badge gh-badge-ok', title: 'You approved this pull request' }, 'You approved'));
    else if (r.myReview === 'CHANGES_REQUESTED') badges.append(h('span', { class: 'gh-badge gh-badge-bad', title: 'You requested changes' }, 'You requested changes'));
    else if (r.myReview === 'COMMENTED') badges.append(h('span', { class: 'gh-badge', title: 'You commented' }, 'You commented'));
    const multiHost = svc.workingHosts().length > 1;
    const row = h(
      'div',
      {
        class: 'gh-pull',
        tabindex: '0',
        role: 'button',
        title: `${r.title}\n${prShort(ref)} on ${r.host}\n${r.headRef} -> ${r.baseRef}\n+${r.additions} -${r.deletions}`,
        onclick: () => openPullTab(ctx, svc, ref, `${r.title}`),
        onkeydown: (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' || ke.key === ' ') {
            ke.preventDefault();
            openPullTab(ctx, svc, ref, r.title);
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          ctx.ui.contextMenu(e as MouseEvent, [
            { label: 'Open', run: () => openPullTab(ctx, svc, ref, r.title) },
            { label: 'Open in Browser', run: () => openExternal(r.url) },
            { label: 'Copy Link', run: () => void navigator.clipboard.writeText(r.url).catch(() => {}) },
          ]);
        },
      },
      h(
        'div',
        { class: 'gh-pull-title' },
        createElement(r.draft ? GitPullRequestDraft : GitPullRequest),
        h('span', { class: 'gh-pull-text' }, r.title),
      ),
      h(
        'div',
        { class: 'gh-pull-meta' },
        `${prShort(ref)}${multiHost ? ` (${r.host})` : ''} by ${r.author}${when ? `, ${when}` : ''}`,
      ),
      badges.childElementCount ? badges : null,
    );
    return row;
  }

  function section(def: (typeof SECTIONS)[number]): HTMLElement {
    const s = state[def.id];
    const isCollapsed = collapsed.has(def.id);
    const head = h(
      'div',
      {
        class: 'gh-section-head',
        onclick: () => {
          if (isCollapsed) collapsed.delete(def.id);
          else collapsed.add(def.id);
          ctx.workspace.globalState.set('github.collapsed', [...collapsed]);
          render();
        },
      },
      createElement(isCollapsed ? ChevronRight : ChevronDown),
      h('span', { class: 'gh-section-title' }, def.title),
      s.loaded ? h('span', { class: 'gh-count' }, `${s.total}${s.more ? '+' : ''}`) : null,
      h('span', { class: 'gh-spacer' }),
      h(
        'button',
        {
          class: `gh-btn${s.loading ? ' gh-spinning' : ''}`,
          type: 'button',
          title: `Refresh ${def.title}`,
          'aria-label': `Refresh ${def.title}`,
          onclick: (e) => {
            e.stopPropagation();
            void searchSection(def.id);
          },
        },
        createElement(RefreshCw),
      ),
    );
    const out = h('div', { class: 'gh-section' }, head);
    if (isCollapsed) return out;
    const body = h('div', { class: 'gh-section-body' });
    for (const err of s.errors) body.append(h('div', { class: 'gh-error', title: err.message }, `${err.host}: ${err.message}`));
    if (s.loading && s.rows.length === 0) body.append(h('div', { class: 'gh-muted' }, 'Loading...'));
    for (const r of s.rows) body.append(pullRow(r));
    if (!s.loading && s.loaded && s.rows.length === 0 && s.errors.length === 0) {
      let text = def.empty;
      if (svc.workingHosts().length === 0) text = 'Log in to a GitHub account first.';
      else if (def.id === 'repo' && !svc.repo) text = ctx.workspace.root ? 'The open folder is not a GitHub repository.' : 'Open a folder to see its pull requests.';
      body.append(h('div', { class: 'gh-muted' }, text));
    }
    out.append(body);
    return out;
  }

  function render() {
    if (disposed) return;
    const top = scroller.scrollTop;
    scroller.replaceChildren(accountsBlock(), ...SECTIONS.map(section));
    scroller.scrollTop = top;
    const n = state.review.rows.length;
    ctx.views.setBadge('github', n > 0 ? String(n) : null);
  }

  const subs = [
    svc.onChange(render),
    ctx.bus.on('workspace:changed', () => {
      if (shown) void refreshAll();
      else void svc.loadRepo();
    }),
    ctx.bus.on('workbench:activated', () => {
      active = true;
      if (shown) void refreshAll();
    }),
    ctx.bus.on('workbench:deactivated', () => {
      active = false;
    }),
  ];

  svc.requestRefresh = () => void refreshAll();
  render();

  return {
    onShow() {
      shown = true;
      void refreshAll();
      startTimer();
    },
    onHide() {
      shown = false;
      stopTimer();
    },
    focus: () => scroller.focus(),
    dispose() {
      disposed = true;
      svc.requestRefresh = null;
      stopTimer();
      for (const s of subs) s.dispose();
      host.replaceChildren();
    },
  };
}
