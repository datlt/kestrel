// History tab: the commits of one file on the left, the diff of the file in the
// selected commit on the right. The list is virtualized and loads more commits
// when you scroll down. `git log --follow` makes renames work.

import { createElement, RefreshCw } from 'lucide';
import type { AppContext, Disposable, TabContent } from '../../core/types';
import { h } from '../../core/dom';
import { basename, rafThrottle } from '../../core/util';
import { fileIcon } from '../../ui/file-icons';
import { gitLog, gitShow, type GitLogEntry, type GitShowResult } from '../../ipc/git';
import { DiffContent, makeDiffData, type DiffData } from './diff';
import { authorColor, fullDate, initials, relativeTime, shortSha } from './format';
import type { HistoryHandle } from './history-tab';
import type { GitService } from './service';
import './git.css';

const ROW_H = 46;
const OVERSCAN = 6;
const PAGE = 100;
const WIDTH_KEY = 'git.historyWidth';
const NONE: GitShowResult = { exists: false, text: '', binary: false, tooLarge: false, size: 0 };

export class HistoryContent implements TabContent, HistoryHandle {
  private root: HTMLElement;
  private list: HTMLElement;
  private sizer: HTMLElement;
  private rowsEl: HTMLElement;
  private status: HTMLElement;
  private head: HTMLElement;
  private diffHost: HTMLElement;
  private diff: DiffContent | null = null;

  private entries: GitLogEntry[] = [];
  private done = false;
  private loading = false;
  private selected = -1;
  private wantSha: string | null;
  private rel: string | null = null;
  private error: string | null = null;
  private stale = false;
  private visible = true;
  private disposed = false;
  private token = 0;
  private diffToken = 0;
  private diffTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private subs: Disposable[] = [];

  constructor(
    private ctx: AppContext,
    private svc: GitService,
    private path: string,
    host: HTMLElement,
  ) {
    this.wantSha = svc.historySelect.get(path) ?? null;
    svc.historySelect.delete(path);

    this.sizer = h('div', { class: 'git-hist-sizer' });
    this.rowsEl = h('div', { class: 'git-hist-rows' });
    this.status = h('div', { class: 'git-hist-status' });
    this.list = h('div', { class: 'git-hist-list', tabindex: 0 }, this.sizer, this.rowsEl);
    this.list.append(this.status);
    this.head = h('div', { class: 'git-hist-head' });
    this.diffHost = h('div', { class: 'git-hist-diff' });
    const split = h('div', { class: 'git-hist-split', title: 'Drag to resize' });
    const detail = h('div', { class: 'git-hist-detail' }, this.head, this.diffHost);
    this.root = h('div', { class: 'git-history' }, this.list, split, detail);
    const width = ctx.workspace.globalState.get<number>(WIDTH_KEY);
    this.setWidth(typeof width === 'number' ? width : 340);
    host.append(this.root);

    this.list.addEventListener('scroll', rafThrottle(() => this.onScroll()), { passive: true });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.rowsEl.addEventListener('mousedown', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.git-hist-row');
      if (row) this.select(Number(row.dataset.i), false);
      this.list.focus();
    });
    split.addEventListener('pointerdown', (e) => this.dragSplit(e, split));

    this.subs.push(
      ctx.bus.on('fs:changed', (e) => (e.gitChanged || e.rescan) && this.requestReload()),
      ctx.bus.on('workbench:activated', () => this.visible && this.stale && this.requestReload()),
      ctx.bus.on('workbench:disposing', () => this.dispose()),
    );
    this.renderHead(null);
    void this.loadMore();
  }

  focus(): void {
    this.list.focus();
  }

  onShow(): void {
    this.visible = true;
    this.renderRows();
    if (this.stale) this.requestReload();
    const sha = this.svc.historySelect.get(this.path);
    if (sha) {
      this.svc.historySelect.delete(this.path);
      this.selectSha(sha);
    }
  }

  onHide(): void {
    this.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.diffTimer);
    clearTimeout(this.reloadTimer);
    this.subs.forEach((s) => s.dispose());
    this.diff?.dispose();
    this.root.remove();
  }

  /** Selects a commit. If it is not loaded yet, loads more pages until it is found. */
  selectSha(sha: string): void {
    const i = this.entries.findIndex((e) => e.sha.startsWith(sha) || sha.startsWith(e.sha));
    if (i >= 0) return this.select(i, true);
    this.wantSha = sha;
    if (!this.done && !this.loading) void this.loadMore();
  }

  private requestReload() {
    this.stale = true;
    if (!this.visible || !this.ctx.window.isActive()) return;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 400);
  }

  private async relPath(): Promise<string | null> {
    if (this.rel) return this.rel;
    const top = await this.svc.topLevel();
    this.rel = top ? this.svc.toRel(this.path, top) : null;
    return this.rel;
  }

  /** Reads the list again from the start. Keeps the selected commit. */
  private async reload() {
    this.stale = false;
    const keep = this.entries[this.selected]?.sha ?? this.wantSha;
    const count = Math.max(PAGE, this.entries.length);
    const token = ++this.token;
    this.loading = true;
    try {
      const root = this.ctx.workspace.root;
      const rel = await this.relPath();
      if (!root || !rel) throw new Error('This file is not inside a git repository.');
      const list = await gitLog(root, rel, count, 0);
      if (this.disposed || token !== this.token) return;
      this.error = null;
      this.entries = list;
      this.done = list.length < count;
      this.wantSha = keep;
    } catch (e) {
      if (this.disposed || token !== this.token) return;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.loading = false;
    this.afterLoad();
  }

  private async loadMore() {
    if (this.loading || this.done || this.disposed) return;
    this.loading = true;
    const token = this.token;
    this.renderStatus();
    try {
      const root = this.ctx.workspace.root;
      const rel = await this.relPath();
      if (!root || !rel) throw new Error('This file is not inside a git repository.');
      const list = await gitLog(root, rel, PAGE, this.entries.length);
      if (this.disposed || token !== this.token) return;
      this.entries = this.entries.concat(list);
      if (list.length < PAGE) this.done = true;
    } catch (e) {
      if (this.disposed || token !== this.token) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.done = true;
    }
    this.loading = false;
    this.afterLoad();
  }

  private afterLoad() {
    this.sizer.style.height = `${this.entries.length * ROW_H}px`;
    if (this.wantSha) {
      const sha = this.wantSha;
      const i = this.entries.findIndex((e) => e.sha.startsWith(sha) || sha.startsWith(e.sha));
      if (i >= 0) {
        this.wantSha = null;
        this.selected = -1;
        this.select(i, true);
      } else if (!this.done) {
        void this.loadMore();
      } else {
        this.wantSha = null;
      }
    }
    if (this.selected < 0 && this.entries.length > 0 && !this.wantSha) this.select(0, false);
    if (this.entries.length === 0) this.renderHead(null);
    this.renderRows();
    this.renderStatus();
  }

  private renderStatus() {
    let text = '';
    if (this.error) text = this.error;
    else if (this.entries.length === 0) text = this.loading ? 'Loading history...' : 'No commits found for this file.';
    else if (this.loading) text = 'Loading more commits...';
    this.status.textContent = text;
    this.status.style.display = text ? '' : 'none';
    this.status.classList.toggle('git-hist-status-top', this.entries.length === 0);
    this.status.style.top = this.entries.length * ROW_H + 'px';
  }

  private onScroll() {
    this.renderRows();
    const { scrollTop, clientHeight } = this.list;
    if (scrollTop + clientHeight > this.entries.length * ROW_H - ROW_H * 10) void this.loadMore();
  }

  private renderRows() {
    if (!this.visible || this.disposed) return;
    const top = this.list.scrollTop;
    const view = this.list.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(this.entries.length - 1, Math.ceil((top + view) / ROW_H) + OVERSCAN);
    const now = Date.now() / 1000;
    const rows: HTMLElement[] = [];
    for (let i = first; i <= last; i++) {
      const e = this.entries[i];
      const avatar = h('div', { class: 'git-avatar', style: `background:${authorColor(e.authorEmail || e.authorName)}` }, initials(e.authorName));
      const title = h('div', { class: 'git-hist-subject' }, e.subject || '(no message)');
      const meta = h(
        'div',
        { class: 'git-hist-meta' },
        h('span', { class: 'git-hist-author' }, e.authorName),
        h('span', { class: 'git-hist-date', title: fullDate(e.authorTime) }, relativeTime(e.authorTime, now)),
        h('span', { class: 'git-hist-sha' }, shortSha(e.sha)),
      );
      rows.push(
        h(
          'div',
          {
            class: `git-hist-row${i === this.selected ? ' git-hist-selected' : ''}`,
            style: `top:${i * ROW_H}px;height:${ROW_H}px`,
            'data-i': i,
            title: `${e.subject}\n${e.authorName} <${e.authorEmail}>\n${fullDate(e.authorTime)}\n${e.sha}`,
          },
          avatar,
          h('div', { class: 'git-hist-text' }, title, meta),
        ),
      );
    }
    this.rowsEl.replaceChildren(...rows);
  }

  private select(i: number, center: boolean) {
    if (i < 0 || i >= this.entries.length || i === this.selected) return;
    this.selected = i;
    const y = i * ROW_H;
    const { scrollTop, clientHeight } = this.list;
    if (center) this.list.scrollTop = Math.max(0, y - clientHeight / 2 + ROW_H / 2);
    else if (y < scrollTop) this.list.scrollTop = y;
    else if (y + ROW_H > scrollTop + clientHeight) this.list.scrollTop = y + ROW_H - clientHeight;
    this.renderRows();
    this.renderHead(this.entries[i]);
    clearTimeout(this.diffTimer);
    this.diffTimer = setTimeout(() => void this.showDiff(i), 80);
    if (i > this.entries.length - 10) void this.loadMore();
  }

  private onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const page = Math.max(1, Math.floor(this.list.clientHeight / ROW_H) - 1);
    const to: Record<string, number> = {
      ArrowDown: this.selected + 1,
      ArrowUp: this.selected - 1,
      PageDown: this.selected + page,
      PageUp: this.selected - page,
      Home: 0,
      End: this.entries.length - 1,
    };
    if (!(e.key in to)) return;
    e.preventDefault();
    this.select(Math.min(this.entries.length - 1, Math.max(0, to[e.key])), false);
  }

  private renderHead(e: GitLogEntry | null) {
    if (!e) {
      this.head.replaceChildren(h('span', { class: 'git-hist-file' }, fileIcon(basename(this.path)), basename(this.path)));
      return;
    }
    const meta = `${e.authorName} <${e.authorEmail}>, ${fullDate(e.authorTime)} (${relativeTime(e.authorTime)})`;
    this.head.replaceChildren(
      h(
        'div',
        { class: 'git-hist-title' },
        h('span', { class: 'git-hist-file', title: e.path }, fileIcon(basename(e.path)), basename(e.path)),
        h('span', { class: 'git-hist-sha git-hist-sha-full', title: e.sha }, shortSha(e.sha)),
        h('button', { class: 'git-btn', type: 'button', title: 'Refresh', onclick: () => void this.reload() }, createElement(RefreshCw)),
      ),
      h('div', { class: 'git-hist-commit-subject' }, e.subject),
      h('div', { class: 'git-hist-commit-meta' }, meta),
      ...(e.body ? [h('pre', { class: 'git-hist-body' }, e.body)] : []),
    );
  }

  private async commitData(e: GitLogEntry): Promise<DiffData> {
    const { ctx } = this;
    const root = ctx.workspace.root;
    if (!root) throw new Error('No folder is open.');
    const maxBytes = ctx.settings.get('editor.maxFileMB') * 1024 * 1024;
    const parent = e.parents[0];
    const left = parent ? await gitShow(root, parent, e.origPath ?? e.path, maxBytes) : NONE;
    const right = await gitShow(root, e.sha, e.path, maxBytes);
    let note: string | null = null;
    if (e.parents.length > 1) note = 'Merge commit: compared with the first parent';
    else if (!parent) note = right.exists ? 'File added (first commit)' : null;
    else if (!left.exists && right.exists) note = 'File added';
    else if (left.exists && !right.exists) note = 'File deleted';
    else if (e.origPath) note = `Renamed from ${e.origPath}`;
    return makeDiffData(ctx, left, right, note);
  }

  private async showDiff(i: number) {
    const e = this.entries[i];
    if (!e || this.disposed) return;
    const token = ++this.diffToken;
    const loader = async () => {
      const data = await this.commitData(e);
      if (token !== this.diffToken) throw new Error('Superseded');
      return data;
    };
    const name = basename(e.path);
    if (this.diff) {
      this.diff.setName(`${name} @ ${shortSha(e.sha)}`, e.path);
      await this.diff.setLoader(loader).catch(() => undefined);
    } else {
      const diff = new DiffContent(this.ctx, this.svc, { base: 'HEAD', path: e.path }, this.diffHost, { loader });
      diff.setName(`${name} @ ${shortSha(e.sha)}`, e.path);
      this.diff = diff;
    }
  }

  private setWidth(w: number) {
    this.list.style.width = `${Math.min(700, Math.max(220, w))}px`;
  }

  private dragSplit(ev: PointerEvent, handle: HTMLElement) {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startW = this.list.getBoundingClientRect().width;
    const move = rafThrottle((e: PointerEvent) => this.setWidth(startW + e.clientX - startX));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      this.ctx.workspace.globalState.set(WIDTH_KEY, Math.round(this.list.getBoundingClientRect().width));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }
}
