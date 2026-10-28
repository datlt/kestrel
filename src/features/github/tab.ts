// Pull request tab: header, overview, files with the review diff, review bar.
// Every write to GitHub starts from a click of the user (see `write*` methods).

import {
  createElement,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Columns2,
  ExternalLink,
  GitBranch,
  RefreshCw,
  Rows3,
} from 'lucide';
import type { AppContext, Disposable, TabContent } from '../../core/types';
import { h } from '../../core/dom';
import { basename, dirname, joinPath } from '../../core/util';
import { ghPrCheckout } from '../../ipc/gh';
import { gitRepoInfo } from '../../ipc/git';
import { isIpcError } from '../../ipc/invoke';
import { fileIcon } from '../../ui/file-icons';
import { relativeTime } from '../git/format';
import { errorText, GhCalls, isCancelled } from './api';
import { draftsKey, prShort, prTabId, prWebUrl, viewedKey, type PullRef } from './parse';
import {
  addDraft,
  buildLineComment,
  buildReviewPayload,
  buildTimeline,
  commentCounts,
  comparePath,
  deleteDraft,
  draftCounts,
  editDraft,
  emptyDrafts,
  filterFiles,
  mergeableText,
  mergeBaseOf,
  newPathOf,
  oldPathOf,
  parseFiles,
  parsePull,
  parseThreadsPage,
  readDraftStore,
  RESOLVE_MUTATION,
  REVIEW_EVENT_LABEL,
  reviewerStates,
  reviewStateText,
  splitDrafts,
  stepIndex,
  summarizeChecks,
  THREADS_QUERY,
  threadsForFile,
  UNRESOLVE_MUTATION,
  validateReview,
  type ChecksSummary,
  type DraftStore,
  type PrFile,
  type PrInfo,
  type PrThread,
  type ReviewEvent,
  type ReviewerState,
  type TimelineItem,
} from './pr-model';
import { openExternal, renderInto, renderSafe, routeLinks } from './rendered';
import type { GithubService, PrUiState } from './service';
import type { NewComment, ReviewDiffHandle } from './review-diff/types';
import './github.css';

const ROW_H = 26;
const OVERSCAN = 8;

type FileTexts = { kind: 'ok'; oldText: string | null; newText: string | null } | { kind: 'message'; text: string; retry?: boolean };
type Part = 'overview' | 'files';

const STATUS_LETTER: Record<PrFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' };

function setKids(el: HTMLElement, ...children: (Node | null | undefined | false)[]) {
  el.replaceChildren(...(children.filter(Boolean) as Node[]));
}

const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || !!el.closest?.('[contenteditable="true"]'));
};

export class PrTab implements TabContent {
  private readonly id: string;
  private readonly calls = new GhCalls();
  private readonly subs: Disposable[] = [];
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  // Data.
  private info: PrInfo | null = null;
  private mergeBase = '';
  private files: PrFile[] = [];
  private threads: PrThread[] = [];
  private threadsProblem: string | null = null;
  private timeline: TimelineItem[] = [];
  private reviewers: ReviewerState[] = [];
  private checks: ChecksSummary | null = null;
  private loading = false;
  private loadError: string | null = null;
  private store: DraftStore = emptyDrafts('');
  private viewed = new Set<string>();
  private texts = new Map<string, Promise<FileTexts>>();

  // UI state.
  private part: Part = 'overview';
  private selected: string | null = null;
  private filter = '';
  private layout: 'split' | 'unified';
  private diff: ReviewDiffHandle | null = null;
  private diffToken = 0;
  private finishOpen = false;
  private finishBusy = false;
  private finishError = '';
  private commentError = '';
  private commentBusy = false;
  private commentText = '';
  private visibleFiles: PrFile[] = [];
  private ui: PrUiState = { part: 'overview', selected: null, filter: '', finishOpen: false, overviewScroll: 0, fileScroll: 0, diffScroll: 0 };

  /** Remembers where the user is, so a rebuilt tab can open in the same place. */
  private saveUi() {
    if (this.disposed) return;
    this.ui = { ...this.ui, part: this.part, selected: this.selected, filter: this.filter, finishOpen: this.finishOpen };
    this.svc.tabUi.set(this.id, this.ui);
  }

  // Elements.
  private readonly root: HTMLElement;
  private readonly headerEl = h('div', { class: 'gh-pr-header' });
  private readonly navEl = h('div', { class: 'gh-pr-nav' });
  private readonly overviewEl = h('div', { class: 'gh-pr-overview' });
  private readonly filesEl = h('div', { class: 'gh-pr-files' });
  private readonly finishEl = h('div', { class: 'gh-pr-finish' });
  private readonly barEl = h('div', { class: 'gh-pr-bar' });
  private fileScroller!: HTMLElement;
  private fileSpacer!: HTMLElement;
  private fileRows!: HTMLElement;
  private fileSummary!: HTMLElement;
  private diffToolbar!: HTMLElement;
  private diffHost!: HTMLElement;

  constructor(
    private ctx: AppContext,
    private svc: GithubService,
    private ref: PullRef,
    host: HTMLElement,
  ) {
    this.id = prTabId(ref);
    const ui = svc.tabUi.get(this.id);
    if (ui) {
      this.part = ui.part;
      this.selected = ui.selected;
      this.filter = ui.filter;
      this.finishOpen = ui.finishOpen;
      this.ui = { ...ui };
    }
    this.layout = ctx.workspace.globalState.get<'split' | 'unified'>('github.diffLayout') === 'unified' ? 'unified' : 'split';
    this.root = h('div', { class: 'gh-pr', tabindex: '-1' }, this.headerEl, this.navEl, h('div', { class: 'gh-pr-main' }, this.overviewEl, this.filesEl), this.finishEl, this.barEl);
    host.append(this.root);
    this.buildFilesPane();
    this.overviewEl.addEventListener('scroll', () => {
      if (this.overviewEl.clientHeight) this.ui.overviewScroll = this.overviewEl.scrollTop;
      this.saveUi();
    });
    this.diffHost.addEventListener(
      'scroll',
      (e) => {
        const el = e.target as HTMLElement;
        if (el.clientHeight && (el === this.diffHost || el.classList?.contains('cm-scroller'))) {
          this.ui.diffScroll = el.scrollTop;
          this.saveUi();
        }
      },
      true,
    );
    this.cleanups.push(routeLinks(this.root, prWebUrl(ref)));
    this.root.addEventListener('keydown', this.onKey, true);
    this.cleanups.push(() => this.root.removeEventListener('keydown', this.onKey, true));
    this.subs.push(this.svc.onChange(() => this.renderHeader()));
    this.subs.push(this.ctx.bus.on('workbench:disposing', () => this.dispose()));
    this.renderAll();
    this.overviewEl.scrollTop = this.ui.overviewScroll;
    this.fileScroller.scrollTop = this.ui.fileScroll;
    void this.load();
  }

  // --- TabContent --------------------------------------------------------------

  focus(): void {
    this.root.focus();
  }

  zoom(step: 1 | -1 | 0): boolean {
    return this.diff?.zoom(step) ?? false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.calls.close();
    this.diff?.dispose();
    this.diff = null;
    for (const s of this.subs) s.dispose();
    for (const c of this.cleanups) c();
    this.root.remove();
  }

  /** Called by the commands `github.nextFile` and `github.previousFile`. */
  goFile(dir: 1 | -1): void {
    if (this.part !== 'files') this.setPart('files');
    const idx = this.visibleFiles.findIndex((f) => f.path === this.selected);
    const next = stepIndex(this.visibleFiles.length, idx, dir);
    if (next < 0) {
      this.ctx.ui.notify(dir === 1 ? 'This is the last file.' : 'This is the first file.', { kind: 'info', timeoutMs: 1500 });
      return;
    }
    this.selectFile(this.visibleFiles[next].path, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    let dir: 1 | -1 | 0 = 0;
    if (e.altKey && !e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      dir = e.key === 'ArrowDown' ? 1 : -1;
    } else if (!e.altKey && (e.key === ']' || e.key === '[') && !isEditable(e.target)) {
      dir = e.key === ']' ? 1 : -1;
    }
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    this.goFile(dir);
  };

  // --- Loading -----------------------------------------------------------------

  private get host() {
    return this.ref.host;
  }
  private get me() {
    return this.svc.loginOf(this.host);
  }
  private repoPath(rest: string) {
    return `repos/${this.ref.owner}/${this.ref.repo}/${rest}`;
  }
  private async rest<T>(path: string, extra: { method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; paginate?: boolean } = {}): Promise<T> {
    const answer = await this.calls.rest<unknown>({ host: this.host, path, ...extra });
    // A paginated answer can come as a list of pages. Join them.
    if (extra.paginate && Array.isArray(answer) && answer.length > 0 && answer.every(Array.isArray)) return (answer as unknown[][]).flat() as T;
    return answer as T;
  }

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.loadError = null;
    this.renderHeader();
    try {
      if (!this.svc.status) await this.svc.loadStatus();
      if (!this.svc.repo) await this.svc.loadRepo();
      const n = this.ref.number;
      const pull = parsePull(await this.rest(this.repoPath(`pulls/${n}`)));
      const previousHead = this.info?.headSha;
      this.info = pull;
      if (previousHead && previousHead !== pull.headSha) this.texts.clear();
      const [compare, files, threads, discussion, checks] = await Promise.allSettled([
        this.rest<any>(comparePath(this.ref.owner, this.ref.repo, pull.baseSha, pull.headSha)),
        this.rest<any[]>(this.repoPath(`pulls/${n}/files?per_page=100`), { paginate: true }),
        this.fetchThreads(),
        this.fetchDiscussion(),
        this.rest<any>(this.repoPath(`commits/${pull.headSha}/check-runs`)),
      ]);
      if (this.disposed) return;
      this.mergeBase = compare.status === 'fulfilled' ? mergeBaseOf(compare.value, pull.baseSha) : pull.baseSha;
      if (files.status === 'rejected') throw files.reason;
      this.files = parseFiles(files.value);
      this.threads = threads.status === 'fulfilled' ? threads.value : [];
      this.threadsProblem = threads.status === 'rejected' ? errorText(threads.reason) : null;
      if (discussion.status === 'fulfilled') this.applyDiscussion(discussion.value.comments, discussion.value.reviews);
      this.checks = checks.status === 'fulfilled' ? summarizeChecks(checks.value) : null;
      this.store = readDraftStore(this.ctx.workspace.globalState.get(draftsKey(this.ref)), pull.headSha);
      this.viewed = new Set(this.ctx.workspace.globalState.get<string[]>(viewedKey(this.ref, pull.headSha)) ?? []);
      this.ctx.tabs.setTitle(this.id, pull.title || prShort(this.ref), prShort(this.ref));
      if (this.selected && !this.files.some((f) => f.path === this.selected)) this.selected = null;
    } catch (e) {
      if (!isCancelled(e) && !this.disposed) this.loadError = errorText(e);
    } finally {
      this.loading = false;
      if (!this.disposed) {
        this.renderAll();
        this.fileScroller.scrollTop = this.ui.fileScroll;
        if (this.part === 'files') {
          if (!this.selected && this.visibleFiles.length) this.selectFile(this.visibleFiles[0].path, false);
          else if (this.selected) void this.showFile(this.selected);
        }
      }
    }
  }

  private async fetchThreads(): Promise<PrThread[]> {
    const all: PrThread[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const data: unknown = await this.calls.graphql(this.host, THREADS_QUERY, { owner: this.ref.owner, name: this.ref.repo, number: this.ref.number, after });
      const page = parseThreadsPage(data);
      all.push(...page.threads);
      if (!page.hasNext || !page.cursor) break;
      after = page.cursor;
    }
    return all;
  }

  private async fetchDiscussion(): Promise<{ comments: any[]; reviews: any[] }> {
    const n = this.ref.number;
    const [comments, reviews] = await Promise.all([
      this.rest<any[]>(this.repoPath(`issues/${n}/comments`), { paginate: true }),
      this.rest<any[]>(this.repoPath(`pulls/${n}/reviews`), { paginate: true }),
    ]);
    return { comments: comments ?? [], reviews: reviews ?? [] };
  }

  private applyDiscussion(comments: any[], reviews: any[]) {
    this.timeline = buildTimeline(comments, reviews);
    this.reviewers = reviewerStates(reviews, this.info?.requestedUsers ?? [], this.info?.author ?? '');
  }

  /** After a write: read the threads and the timeline again. */
  private async reloadDiscussion(): Promise<void> {
    const [threads, discussion] = await Promise.allSettled([this.fetchThreads(), this.fetchDiscussion()]);
    if (this.disposed) return;
    if (threads.status === 'fulfilled') {
      this.threads = threads.value;
      this.threadsProblem = null;
    }
    if (discussion.status === 'fulfilled') this.applyDiscussion(discussion.value.comments, discussion.value.reviews);
    this.afterThreadsChanged();
    this.renderHeader();
    this.renderOverview();
  }

  // --- Drafts ------------------------------------------------------------------

  private saveStore() {
    const empty = this.store.drafts.length === 0 && !this.store.reviewBody.trim();
    this.ctx.workspace.globalState.set(draftsKey(this.ref), empty ? null : this.store);
  }

  private saveViewed() {
    if (!this.info) return;
    this.ctx.workspace.globalState.set(viewedKey(this.ref, this.info.headSha), this.viewed.size ? [...this.viewed] : null);
  }

  /** Redraws everything that shows threads or draft counts. */
  private afterThreadsChanged() {
    this.renderBar();
    this.renderFileList();
    this.renderNav();
    if (this.diff && this.selected) this.diff.setThreads(threadsForFile(this.selected, this.threads, this.store.drafts, this.me));
  }

  // --- Writes (each one runs only from a click) --------------------------------

  private async onAddComment(c: NewComment): Promise<void> {
    const path = this.selected;
    if (!path || !this.info) throw new Error('No file is selected.');
    if (c.mode === 'review') {
      addDraft(this.store, { path, side: c.side, line: c.line, startLine: c.startLine, body: c.body });
      this.store.headSha = this.store.headSha || this.info.headSha;
      this.saveStore();
      this.afterThreadsChanged();
      return;
    }
    try {
      await this.rest(this.repoPath(`pulls/${this.ref.number}/comments`), {
        method: 'POST',
        body: buildLineComment(this.info.headSha, path, c, c.body),
      });
    } catch (e) {
      throw new Error(errorText(e));
    }
    await this.reloadDiscussion();
  }

  private async onReply(threadId: string, body: string, mode: 'review' | 'now'): Promise<void> {
    const path = this.selected;
    if (!path) throw new Error('No file is selected.');
    const real = this.threads.find((t) => t.id === threadId);
    if (real && mode === 'now') {
      try {
        await this.rest(this.repoPath(`pulls/${this.ref.number}/comments/${real.comments[0].id}/replies`), { method: 'POST', body: { body } });
      } catch (e) {
        throw new Error(errorText(e));
      }
      await this.reloadDiscussion();
      return;
    }
    if (real) {
      addDraft(this.store, { path, side: real.side, line: real.line, startLine: real.startLine, body, reply: { threadId, commentId: real.comments[0].id } });
    } else {
      // A thread that only has drafts: the new comment is one more draft on the same lines.
      const draftId = threadId.replace('draft-thread-', '');
      const base = this.store.drafts.find((d) => d.id === draftId);
      if (!base) throw new Error('The draft of this thread was deleted.');
      addDraft(this.store, { path: base.path, side: base.side, line: base.line, startLine: base.startLine, body });
    }
    this.saveStore();
    this.afterThreadsChanged();
  }

  private async onEditDraft(id: string, body: string): Promise<void> {
    if (editDraft(this.store, id, body)) this.saveStore();
    this.afterThreadsChanged();
  }

  private async onDeleteDraft(id: string): Promise<void> {
    if (deleteDraft(this.store, id)) this.saveStore();
    this.afterThreadsChanged();
  }

  private async onResolve(threadId: string, resolved: boolean): Promise<void> {
    if (threadId.startsWith('draft-')) throw new Error('Send the review first. Then you can resolve the thread.');
    try {
      await this.calls.graphql(this.host, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { id: threadId });
    } catch (e) {
      throw new Error(errorText(e));
    }
    await this.reloadDiscussion();
  }

  private async postComment(): Promise<void> {
    const body = this.commentText.trim();
    if (!body || this.commentBusy) return;
    this.commentBusy = true;
    this.commentError = '';
    this.renderOverview();
    try {
      await this.rest(this.repoPath(`issues/${this.ref.number}/comments`), { method: 'POST', body: { body } });
      this.commentText = '';
      await this.reloadDiscussion();
    } catch (e) {
      this.commentError = errorText(e);
    }
    this.commentBusy = false;
    this.renderOverview();
  }

  private async submitReview(event: ReviewEvent): Promise<void> {
    if (!this.info || this.finishBusy) return;
    const { lines, replies } = splitDrafts(this.store.drafts);
    const problem = validateReview(event, this.store.reviewBody, lines.length);
    if (problem) {
      this.finishError = problem;
      this.renderFinish();
      return;
    }
    if (event !== 'COMMENT') {
      const verb = REVIEW_EVENT_LABEL[event];
      const choice = await this.ctx.ui.confirm({
        title: `${verb} ${prShort(this.ref)}?`,
        message: event === 'APPROVE' ? 'GitHub tells the author that you approved this pull request.' : 'GitHub tells the author that you want changes before this pull request can be merged.',
        buttons: [verb, 'Cancel'],
      });
      if (choice !== verb) return;
    }
    this.finishBusy = true;
    this.finishError = '';
    this.renderFinish();
    try {
      await this.rest(this.repoPath(`pulls/${this.ref.number}/reviews`), {
        method: 'POST',
        body: buildReviewPayload(this.info.headSha, event, this.store.reviewBody, lines),
      });
      // The review is on GitHub now. Remove what it contains.
      for (const d of lines) deleteDraft(this.store, d.id);
      this.store.reviewBody = '';
      this.saveStore();
      const failed: string[] = [];
      for (const d of replies) {
        try {
          await this.rest(this.repoPath(`pulls/${this.ref.number}/comments/${d.reply!.commentId}/replies`), { method: 'POST', body: { body: d.body } });
          deleteDraft(this.store, d.id);
        } catch (e) {
          failed.push(errorText(e));
        }
      }
      this.saveStore();
      this.finishOpen = failed.length > 0;
      this.finishError = failed.length ? `The review was sent. ${failed.length} reply draft(s) failed and stay as drafts: ${failed[0]}` : '';
      this.ctx.ui.notify(`${REVIEW_EVENT_LABEL[event]} sent.`, { kind: 'info', timeoutMs: 3000 });
      await this.reloadDiscussion();
    } catch (e) {
      this.finishError = errorText(e);
    }
    this.finishBusy = false;
    this.renderFinish();
    this.renderBar();
  }

  private async deleteAllDrafts(): Promise<void> {
    if (this.store.drafts.length === 0) return;
    const choice = await this.ctx.ui.confirm({
      title: `Delete ${this.store.drafts.length} draft comment(s)?`,
      message: 'They are not on GitHub yet. This cannot be undone.',
      buttons: ['Delete Drafts', 'Cancel'],
    });
    if (choice !== 'Delete Drafts') return;
    this.store.drafts = [];
    this.saveStore();
    this.afterThreadsChanged();
  }

  // --- Check out and local files ----------------------------------------------

  private async checkOut(): Promise<void> {
    const root = this.ctx.workspace.root;
    if (!root) return;
    if (this.ctx.editors.all().some((ed) => ed.isDirty())) {
      const choice = await this.ctx.ui.confirm({
        title: 'Some files have unsaved changes',
        message: 'Check out may change these files on disk. Save them first, or continue.',
        buttons: ['Check Out Anyway', 'Cancel'],
      });
      if (choice !== 'Check Out Anyway') return;
    }
    try {
      await ghPrCheckout(root, this.ref.number);
      this.ctx.ui.notify(`Checked out ${prShort(this.ref)}.`, { kind: 'info', timeoutMs: 3000 });
      if (this.ctx.commands.get('git.refresh')) void this.ctx.commands.execute('git.refresh');
    } catch (e) {
      this.ctx.ui.notify(`Check out failed: ${errorText(e)}`, { kind: 'error' });
    }
  }

  private canOpenLocal(): boolean {
    return this.svc.isThisRepo(this.host, this.ref.owner, this.ref.repo);
  }

  private async openLocal(f: PrFile): Promise<void> {
    const root = this.ctx.workspace.root;
    const rel = newPathOf(f);
    if (!root || !rel || !this.info) {
      this.ctx.ui.notify('This file was deleted in the pull request.', { kind: 'info', timeoutMs: 3000 });
      return;
    }
    let top = root;
    try {
      const repo = await gitRepoInfo(root);
      top = repo.topLevel || root;
      if (repo.branch !== this.info.headRef) {
        const choice = await this.ctx.ui.confirm({
          title: 'The branch of this pull request is not checked out',
          message: `The open folder is on ${repo.branch ?? 'a detached HEAD'}, not on ${this.info.headRef}. The local file can differ from the pull request.`,
          buttons: ['Open Local File', 'Cancel'],
        });
        if (choice !== 'Open Local File') return;
      }
    } catch {
      // Not a git folder for the app: open the file at the folder root.
    }
    await this.ctx.editors.openFile(joinPath(top, ...rel.split('/')));
  }

  // --- Rendering: header, nav, overview ---------------------------------------

  private renderAll() {
    this.renderHeader();
    this.renderNav();
    this.renderOverview();
    this.renderFileList();
    this.renderBar();
    this.renderFinish();
    this.applyPart();
  }

  private btn(label: string, onclick: () => void, opts: { title?: string; icon?: Parameters<typeof createElement>[0]; primary?: boolean; disabled?: boolean } = {}) {
    return h(
      'button',
      { class: `gh-pbtn${opts.primary ? ' gh-pbtn-primary' : ''}`, type: 'button', title: opts.title, disabled: opts.disabled, onclick },
      opts.icon ? createElement(opts.icon) : null,
      label ? h('span', null, label) : null,
    );
  }

  private renderHeader() {
    if (this.disposed) return;
    const info = this.info;
    const buttons = h(
      'div',
      { class: 'gh-pr-buttons' },
      this.btn('Open in Browser', () => openExternal(info?.htmlUrl || prWebUrl(this.ref)), { icon: ExternalLink }),
      this.canOpenLocal() ? this.btn('Check Out', () => void this.checkOut(), { icon: GitBranch, title: 'Check out the branch of this pull request in the open folder', disabled: !info }) : null,
      h('button', { class: `gh-pbtn${this.loading ? ' gh-spinning' : ''}`, type: 'button', title: 'Refresh', onclick: () => void this.load() }, createElement(RefreshCw), h('span', null, 'Refresh')),
    );
    if (!info) {
      setKids(this.headerEl, 
        h('div', { class: 'gh-pr-title-row' }, h('span', { class: 'gh-pr-title' }, prShort(this.ref)), h('span', { class: 'gh-spacer' }), buttons),
        this.loadError
          ? h('div', { class: 'gh-error' }, this.loadError, ' ', h('button', { class: 'gh-link', type: 'button', onclick: () => void this.load() }, 'Retry'))
          : h('div', { class: 'gh-muted' }, 'Loading...'),
      );
      return;
    }
    const stateText = info.state === 'merged' ? 'Merged' : info.state === 'closed' ? 'Closed' : info.draft ? 'Draft' : 'Open';
    const meta: (HTMLElement | string)[] = [
      h('span', { class: 'gh-branches' }, `${info.headRef} -> ${info.baseRef}`),
      `${info.author} opened ${info.createdAt ? relativeTime(Date.parse(info.createdAt) / 1000) : ''}`,
    ];
    const merge = info.state === 'open' ? mergeableText(info.mergeableState) : null;
    const line3 = h('div', { class: 'gh-pr-chips' });
    if (this.reviewers.length) {
      line3.append(h('span', { class: 'gh-muted' }, 'Reviewers:'));
      for (const r of this.reviewers) {
        const kind = r.state === 'APPROVED' ? 'ok' : r.state === 'CHANGES_REQUESTED' ? 'bad' : r.state === 'PENDING' ? 'wait' : '';
        const text = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes requested' : r.state === 'PENDING' ? 'waiting' : r.state === 'DISMISSED' ? 'dismissed' : 'commented';
        line3.append(h('span', { class: `gh-badge${kind ? ` gh-badge-${kind}` : ''}` }, `${r.login}: ${text}`));
      }
    }
    for (const t of info.requestedTeams) line3.append(h('span', { class: 'gh-badge gh-badge-wait' }, `team ${t}: waiting`));
    for (const l of info.labels) {
      const dot = h('span', { class: 'gh-label-dot' });
      if (/^[0-9a-f]{6}$/i.test(l.color)) dot.style.background = `#${l.color}`;
      line3.append(h('span', { class: 'gh-badge' }, dot, l.name));
    }
    if (this.checks && this.checks.total > 0) {
      const c = this.checks;
      const kind = c.failed ? 'bad' : c.running ? 'wait' : 'ok';
      const parts = [c.passed ? `${c.passed} passed` : '', c.failed ? `${c.failed} failed` : '', c.running ? `${c.running} running` : ''].filter(Boolean).join(', ');
      line3.append(h('span', { class: `gh-badge gh-badge-${kind}`, title: 'Checks of the last commit' }, `Checks: ${parts}`));
    }
    setKids(this.headerEl, 
      h(
        'div',
        { class: 'gh-pr-title-row' },
        h('span', { class: 'gh-pr-title', title: info.title }, info.title),
        h('span', { class: 'gh-pr-number' }, `#${this.ref.number}`),
        h('span', { class: `gh-state gh-state-${info.state}${info.draft && info.state === 'open' ? ' gh-state-draft' : ''}` }, stateText),
        merge ? h('span', { class: 'gh-muted' }, merge) : null,
        h('span', { class: 'gh-spacer' }),
        buttons,
      ),
      h('div', { class: 'gh-pr-meta' }, ...meta.flatMap((m, i) => (i ? [h('span', { class: 'gh-sep' }, '·'), m] : [m]))),
      line3.childElementCount ? line3 : null,
      this.loadError ? h('div', { class: 'gh-error' }, this.loadError) : null,
      this.threadsProblem ? h('div', { class: 'gh-error' }, `Review threads could not be loaded: ${this.threadsProblem}`) : null,
    );
  }

  private renderNav() {
    const tab = (part: Part, label: string) =>
      h('button', { class: `gh-nav-btn${this.part === part ? ' gh-nav-on' : ''}`, type: 'button', onclick: () => this.setPart(part) }, label);
    const viewedCount = this.files.filter((f) => this.viewed.has(f.path)).length;
    setKids(this.navEl, tab('overview', 'Overview'), tab('files', `Files (${this.files.length})`), this.files.length ? h('span', { class: 'gh-muted gh-nav-note' }, `${viewedCount} of ${this.files.length} viewed`) : null);
  }

  private setPart(part: Part) {
    this.part = part;
    this.saveUi();
    this.renderNav();
    this.applyPart();
    if (part === 'files') {
      if (!this.selected && this.files.length) this.selectFile(this.visibleFiles[0]?.path ?? this.files[0].path, false);
      else if (this.selected && !this.diff) void this.showFile(this.selected);
      this.paintFiles();
    }
  }

  private applyPart() {
    this.overviewEl.hidden = this.part !== 'overview';
    this.filesEl.hidden = this.part !== 'files';
  }

  private renderOverview() {
    if (this.disposed) return;
    const info = this.info;
    const scroll = this.overviewEl.scrollTop;
    const content = h('div', { class: 'gh-overview-inner' });
    if (!info) {
      this.overviewEl.replaceChildren(content);
      return;
    }
    const desc = h('div', { class: 'gh-md' });
    if (info.body.trim()) void renderInto(desc, info.body, this.host).catch(() => (desc.textContent = info.body));
    else desc.append(h('span', { class: 'gh-muted' }, 'No description.'));
    content.append(h('div', { class: 'gh-card' }, h('div', { class: 'gh-card-head' }, h('b', null, info.author), ' described this pull request'), desc));
    for (const item of this.timeline) {
      const body = h('div', { class: 'gh-md' });
      if (item.body.trim()) void renderInto(body, item.body, this.host).catch(() => (body.textContent = item.body));
      const what = item.kind === 'review' ? reviewStateText(item.state) : 'commented';
      const kind = item.state === 'APPROVED' ? ' gh-card-ok' : item.state === 'CHANGES_REQUESTED' ? ' gh-card-bad' : '';
      content.append(
        h(
          'div',
          { class: `gh-card${kind}` },
          h('div', { class: 'gh-card-head' }, h('b', null, item.author), ` ${what}`, item.createdAt ? h('span', { class: 'gh-muted' }, `, ${relativeTime(Date.parse(item.createdAt) / 1000)}`) : null),
          item.body.trim() ? body : null,
        ),
      );
    }
    const area = h('textarea', {
      class: 'gh-textarea',
      rows: '4',
      placeholder: 'Leave a comment (Markdown)',
      oninput: (e) => {
        this.commentText = (e.target as HTMLTextAreaElement).value;
        send.disabled = this.commentBusy || !this.commentText.trim();
      },
    });
    area.value = this.commentText;
    area.disabled = this.commentBusy;
    const send = h('button', { class: `gh-pbtn gh-pbtn-primary${this.commentBusy ? ' gh-spinning' : ''}`, type: 'button', disabled: this.commentBusy || !this.commentText.trim(), onclick: () => void this.postComment() }, this.commentBusy ? 'Sending...' : 'Comment');
    content.append(h('div', { class: 'gh-card gh-compose' }, area, this.commentError ? h('div', { class: 'gh-error' }, this.commentError) : null, h('div', { class: 'gh-compose-row' }, send)));
    this.overviewEl.replaceChildren(content);
    this.overviewEl.scrollTop = scroll;
  }

  // --- Rendering: files ---------------------------------------------------------

  private buildFilesPane() {
    const filter = h('input', {
      class: 'gh-input',
      type: 'search',
      placeholder: 'Filter files',
      'aria-label': 'Filter files',
      oninput: (e) => {
        this.filter = (e.target as HTMLInputElement).value;
        this.saveUi();
        this.renderFileList();
      },
    });
    filter.value = this.filter;
    this.fileSummary = h('div', { class: 'gh-muted gh-file-summary' });
    this.fileSpacer = h('div', { class: 'gh-file-spacer' });
    this.fileRows = h('div', { class: 'gh-file-rows' });
    this.fileScroller = h('div', { class: 'gh-file-scroll', tabindex: '0' }, this.fileSpacer, this.fileRows);
    this.fileScroller.addEventListener(
      'scroll',
      () => {
        if (this.fileScroller.clientHeight) this.ui.fileScroll = this.fileScroller.scrollTop;
        this.paintFiles();
      },
      { passive: true },
    );
    const ro = new ResizeObserver(() => requestAnimationFrame(() => this.paintFiles()));
    ro.observe(this.fileScroller);
    this.cleanups.push(() => ro.disconnect());
    this.diffToolbar = h('div', { class: 'gh-diff-toolbar' });
    this.diffHost = h('div', { class: 'gh-diff-host' });
    this.filesEl.append(
      h('div', { class: 'gh-file-side' }, h('div', { class: 'gh-file-head' }, filter, this.fileSummary), this.fileScroller),
      h('div', { class: 'gh-diff-pane' }, this.diffToolbar, this.diffHost),
    );
  }

  private renderFileList() {
    if (this.disposed) return;
    this.visibleFiles = filterFiles(this.files, this.filter);
    this.fileSpacer.style.height = `${this.visibleFiles.length * ROW_H}px`;
    const adds = this.files.reduce((n, f) => n + f.additions, 0);
    const dels = this.files.reduce((n, f) => n + f.deletions, 0);
    this.fileSummary.textContent = this.loading && !this.files.length ? 'Loading...' : `${this.visibleFiles.length} of ${this.files.length} files, +${adds} -${dels}`;
    this.paintFiles();
  }

  private paintFiles() {
    if (this.disposed || this.filesEl.hidden) return;
    const sc = this.fileScroller;
    const first = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.visibleFiles.length, Math.ceil((sc.scrollTop + (sc.clientHeight || 600)) / ROW_H) + OVERSCAN);
    const counts = commentCounts(this.threads);
    const drafts = draftCounts(this.store.drafts);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const f = this.visibleFiles[i];
      const isViewed = this.viewed.has(f.path);
      const comments = counts.get(f.path) ?? 0;
      const draftN = drafts.get(f.path) ?? 0;
      const check = h('input', {
        class: 'gh-viewed',
        type: 'checkbox',
        title: isViewed ? 'Viewed. Click to unmark.' : 'Mark as viewed',
        'aria-label': `Viewed: ${f.path}`,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => this.setViewed(f.path, (e.target as HTMLInputElement).checked),
      });
      check.checked = isViewed;
      const row = h(
        'div',
        {
          class: `gh-file gh-s-${f.status}${f.path === this.selected ? ' gh-file-on' : ''}${isViewed ? ' gh-file-viewed' : ''}`,
          style: `top:${i * ROW_H}px`,
          title: f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path,
          onclick: () => this.selectFile(f.path, false),
          oncontextmenu: (e) => {
            e.preventDefault();
            this.ctx.ui.contextMenu(e as MouseEvent, [
              { label: 'Open File in Editor', run: () => void this.openLocal(f), disabled: !this.canOpenLocal() || f.status === 'deleted' },
              { label: 'Copy Path', run: () => void navigator.clipboard.writeText(f.path).catch(() => {}) },
              { label: isViewed ? 'Mark as Not Viewed' : 'Mark as Viewed', run: () => this.setViewed(f.path, !isViewed) },
            ]);
          },
        },
        check,
        fileIcon(basename(f.path)),
        h('span', { class: 'gh-file-name' }, basename(f.path)),
        h('span', { class: 'gh-file-dir' }, f.oldPath ? `${basename(f.oldPath)} -> ${dirname(f.path)}` : dirname(f.path)),
        comments || draftN ? h('span', { class: 'gh-file-comments', title: `${comments} comment(s)${draftN ? `, ${draftN} draft(s)` : ''}` }, `${comments + draftN}`) : null,
        h('span', { class: 'gh-file-stat' }, h('span', { class: 'gh-add' }, `+${f.additions}`), ' ', h('span', { class: 'gh-del' }, `-${f.deletions}`)),
        h('span', { class: 'gh-letter' }, STATUS_LETTER[f.status]),
      );
      frag.append(row);
    }
    this.fileRows.replaceChildren(frag);
  }

  private setViewed(path: string, on: boolean) {
    if (on) this.viewed.add(path);
    else this.viewed.delete(path);
    this.saveViewed();
    this.renderNav();
    this.paintFiles();
    this.renderDiffToolbar();
  }

  private selectFile(path: string, scroll: boolean) {
    this.selected = path;
    this.ui.diffScroll = 0;
    this.saveUi();
    if (scroll) {
      const i = this.visibleFiles.findIndex((f) => f.path === path);
      const sc = this.fileScroller;
      const top = i * ROW_H;
      if (top < sc.scrollTop) sc.scrollTop = top;
      else if (top + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW_H - sc.clientHeight;
    }
    this.paintFiles();
    void this.showFile(path);
  }

  private atEnd = 0;

  /** Moves to the next change. A second press at the end moves to the next file. */
  private stepChange(dir: 1 | -1) {
    if (this.diff?.nextChange(dir)) {
      this.atEnd = 0;
      return;
    }
    if (this.atEnd === dir) {
      this.atEnd = 0;
      this.goFile(dir);
      return;
    }
    this.atEnd = dir;
    this.ctx.ui.notify(dir === 1 ? 'Last change. Press again for the next file.' : 'First change. Press again for the previous file.', { kind: 'info', timeoutMs: 1500 });
  }

  private renderDiffToolbar() {
    const f = this.files.find((x) => x.path === this.selected);
    if (!f) {
      setKids(this.diffToolbar, h('span', { class: 'gh-muted' }, this.files.length ? 'Select a file.' : 'No files.'));
      return;
    }
    const isViewed = this.viewed.has(f.path);
    const viewedBox = h('input', { class: 'gh-viewed', type: 'checkbox', onchange: (e) => this.setViewed(f.path, (e.target as HTMLInputElement).checked) });
    viewedBox.checked = isViewed;
    const mini = (label: string, icon: Parameters<typeof createElement>[0], fn: () => void) =>
      h('button', { class: 'gh-btn', type: 'button', title: label, 'aria-label': label, onclick: fn }, createElement(icon));
    setKids(this.diffToolbar, 
      h('span', { class: 'gh-diff-path', title: f.path }, f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path),
      h('span', { class: 'gh-spacer' }),
      mini('Previous File ([ or Alt+Up)', ArrowUp, () => this.goFile(-1)),
      mini('Next File (] or Alt+Down)', ArrowDown, () => this.goFile(1)),
      mini('Previous Change (press again at the first change for the previous file)', ChevronUp, () => this.stepChange(-1)),
      mini('Next Change (press again at the last change for the next file)', ChevronDown, () => this.stepChange(1)),
      mini(this.layout === 'split' ? 'Show One Column' : 'Show Two Columns', this.layout === 'split' ? Rows3 : Columns2, () => {
        this.layout = this.layout === 'split' ? 'unified' : 'split';
        this.ctx.workspace.globalState.set('github.diffLayout', this.layout);
        this.diff?.setLayout(this.layout);
        this.renderDiffToolbar();
      }),
      this.canOpenLocal() && f.status !== 'deleted' ? this.btn('Open File in Editor', () => void this.openLocal(f), { title: 'Open the local file of the open folder' }) : null,
      h('label', { class: 'gh-viewed-label' }, viewedBox, 'Viewed'),
    );
  }

  /** Loads the two texts of a file. The answer is cached for this tab. */
  private loadTexts(f: PrFile): Promise<FileTexts> {
    const hit = this.texts.get(f.path);
    if (hit) return hit;
    const info = this.info!;
    const read = async (path: string | null, ref: string): Promise<string | null> =>
      path === null ? null : this.calls.fileText(this.host, this.ref.owner, this.ref.repo, path, ref);
    const p = (async (): Promise<FileTexts> => {
      try {
        const [oldText, newText] = await Promise.all([read(oldPathOf(f), this.mergeBase), read(newPathOf(f), info.headSha)]);
        return { kind: 'ok', oldText, newText };
      } catch (e) {
        if (isIpcError(e, 'binary')) return { kind: 'message', text: 'This is a binary file. There is no text diff.' };
        if (isIpcError(e, 'too_large')) return { kind: 'message', text: 'This file is larger than 5 MB. Open it in the browser to see the changes.' };
        this.texts.delete(f.path);
        return { kind: 'message', text: errorText(e), retry: true };
      }
    })();
    this.texts.set(f.path, p);
    return p;
  }

  private async showFile(path: string): Promise<void> {
    const f = this.files.find((x) => x.path === path);
    const token = ++this.diffToken;
    this.diff?.dispose();
    this.diff = null;
    this.renderDiffToolbar();
    this.diffHost.replaceChildren();
    if (!f || !this.info) return;
    this.diffHost.append(h('div', { class: 'gh-muted gh-diff-note' }, 'Loading...'));
    const texts = await this.loadTexts(f);
    if (token !== this.diffToken || this.disposed) return;
    if (texts.kind === 'message') {
      const note = h('div', { class: texts.retry ? 'gh-error gh-diff-note' : 'gh-muted gh-diff-note' }, texts.text);
      if (texts.retry) note.append(' ', h('button', { class: 'gh-link', type: 'button', onclick: () => void this.showFile(path) }, 'Retry'));
      if (this.info.htmlUrl) note.append(' ', h('button', { class: 'gh-link', type: 'button', onclick: () => openExternal(`${this.info!.htmlUrl}/files`) }, 'Open in Browser'));
      this.diffHost.replaceChildren(note);
      return;
    }
    try {
      const { createReviewDiff } = await import('./review-diff');
      if (token !== this.diffToken || this.disposed) return;
      this.diffHost.replaceChildren();
      this.diff = createReviewDiff(this.diffHost, {
        ctx: this.ctx,
        path: f.path,
        oldText: texts.oldText,
        newText: texts.newText,
        threads: threadsForFile(f.path, this.threads, this.store.drafts, this.me),
        layout: this.layout,
        canComment: this.info.state === 'open',
        renderMarkdown: (md) => renderSafe(md, this.host),
        onAddComment: (c) => this.onAddComment(c),
        onReply: (id, body, mode) => this.onReply(id, body, mode),
        onEditDraft: (id, body) => this.onEditDraft(id, body),
        onDeleteDraft: (id) => this.onDeleteDraft(id),
        onResolve: (id, resolved) => this.onResolve(id, resolved),
      });
      const top = this.ui.diffScroll;
      if (top > 0) {
        const restore = () => {
          const sc = this.diffHost.querySelector<HTMLElement>('.cm-scroller') ?? this.diffHost;
          sc.scrollTop = top;
        };
        requestAnimationFrame(() => requestAnimationFrame(restore));
      }
    } catch (e) {
      this.diffHost.replaceChildren(h('div', { class: 'gh-error gh-diff-note' }, `The diff could not be shown: ${errorText(e)}`));
    }
  }

  // --- Rendering: review bar ----------------------------------------------------

  private renderBar() {
    if (this.disposed) return;
    const n = this.store.drafts.length;
    const stale = n > 0 && this.info && this.store.headSha && this.store.headSha !== this.info.headSha;
    setKids(this.barEl, 
      h('span', { class: 'gh-bar-count' }, n === 1 ? '1 draft comment' : `${n} draft comments`),
      stale ? h('span', { class: 'gh-warn', title: 'The branch has new commits. Check that each draft still points to the right line.' }, 'Drafts were written for an older commit.') : null,
      h('span', { class: 'gh-spacer' }),
      n > 0 ? this.btn('Delete Drafts', () => void this.deleteAllDrafts()) : null,
      this.btn('Finish Review', () => {
        this.finishOpen = !this.finishOpen;
        this.saveUi();
        this.renderFinish();
      }, { primary: true, disabled: !this.info }),
    );
  }

  private renderFinish() {
    if (this.disposed) return;
    this.finishEl.hidden = !this.finishOpen;
    if (!this.finishOpen) return;
    const area = h('textarea', {
      class: 'gh-textarea',
      rows: '4',
      placeholder: 'Review summary (Markdown, optional for Approve)',
      oninput: (e) => {
        this.store.reviewBody = (e.target as HTMLTextAreaElement).value;
        this.saveStore();
      },
    });
    area.value = this.store.reviewBody;
    area.disabled = this.finishBusy;
    const own = this.info?.author === this.me;
    const go = (event: ReviewEvent, label: string, cls = '') =>
      h('button', { class: `gh-pbtn${cls}${this.finishBusy ? ' gh-spinning' : ''}`, type: 'button', disabled: this.finishBusy, onclick: () => void this.submitReview(event) }, label);
    const n = this.store.drafts.length;
    setKids(this.finishEl, 
      h('div', { class: 'gh-finish-title' }, 'Finish your review', h('span', { class: 'gh-muted' }, ` (${n} draft comment${n === 1 ? '' : 's'} will be sent)`)),
      area,
      own ? h('div', { class: 'gh-muted' }, 'This is your own pull request. GitHub does not allow you to approve it or request changes.') : null,
      this.finishError ? h('div', { class: 'gh-error' }, this.finishError) : null,
      h(
        'div',
        { class: 'gh-finish-row' },
        go('COMMENT', this.finishBusy ? 'Sending...' : 'Comment'),
        go('APPROVE', 'Approve', ' gh-pbtn-ok'),
        go('REQUEST_CHANGES', 'Request Changes', ' gh-pbtn-bad'),
        h('span', { class: 'gh-spacer' }),
        h('button', { class: 'gh-pbtn', type: 'button', disabled: this.finishBusy, onclick: () => { this.finishOpen = false; this.saveUi(); this.renderFinish(); } }, 'Close'),
      ),
    );
  }
}
