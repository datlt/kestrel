// Git blame gutter. It sits on the left of the line numbers of a file editor.
//
// - The first line of each block shows the author and the age of the commit.
// - Each block has a soft color by age (new commits are stronger).
// - Hover shows a tooltip with the commit. Click opens the history tab.
// - Lines that are not committed (or that you typed after the last load) say
//   "Not committed yet".
// - Positions move with your edits (StateField + mapping). The data loads again
//   after `file:saved`, after git changes, and one second after you stop typing.
//
// The editor service does not run this for large files (`FileMeta.large`).

import { Prec, RangeSet, RangeValue, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from '@codemirror/view';
import type { AppContext, FileEditor } from '../../core/types';
import { gitBlame, gitCommitInfo, type GitBlameRange, type GitLogEntry } from '../../ipc/git';
import { isIpcError } from '../../ipc/invoke';
import { fullDate, relativeTime, shortSha } from './format';
import { openHistory } from './history-tab';
import type { GitService } from './service';
import './git.css';

/** What one block of lines knows. One object is shared by all lines of a block. */
interface Block {
  sha: string;
  author: string;
  email: string;
  time: number;
  summary: string;
  uncommitted: boolean;
  /** 0 (old) to 1 (new). */
  recency: number;
}

/** Lines that have no blame data: typed after the last load, or a new file. */
const LOCAL: Block = { sha: '', author: '', email: '', time: 0, summary: '', uncommitted: true, recency: 1 };

const YEAR = 365 * 24 * 3600;

class Mark extends RangeValue {
  constructor(readonly block: Block) {
    super();
  }
  override eq(other: RangeValue) {
    return other instanceof Mark && other.block === this.block;
  }
}

const setBlame = StateEffect.define<RangeSet<Mark>>();

const blameField = StateField.define<RangeSet<Mark>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    // Keep the marks on their lines while you type.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

function blockAt(set: RangeSet<Mark>, pos: number): Block {
  const it = set.iter(pos);
  return it.value && it.from === pos ? it.value.block : LOCAL;
}

function buildMarks(ranges: readonly GitBlameRange[], doc: { lines: number; line(n: number): { from: number } }): RangeSet<Mark> {
  const now = Date.now() / 1000;
  const marks: ReturnType<Mark['range']>[] = [];
  for (const r of ranges) {
    const block: Block = {
      sha: r.sha,
      author: r.author,
      email: r.authorEmail,
      time: r.authorTime,
      summary: r.summary,
      uncommitted: r.uncommitted,
      recency: r.uncommitted ? 1 : Math.max(0, 1 - (now - r.authorTime) / (2 * YEAR)),
    };
    const mark = new Mark(block);
    for (let n = r.startLine; n < r.startLine + r.lineCount && n <= doc.lines; n++) marks.push(mark.range(doc.line(n).from));
  }
  return RangeSet.of(marks, true);
}

interface Env {
  ctx: AppContext;
  svc: GitService;
  editor: FileEditor;
  commits: Map<string, Promise<GitLogEntry>>;
  tip: HTMLElement | null;
  tipTimer: ReturnType<typeof setTimeout> | undefined;
}

function hideTip(env: Env) {
  clearTimeout(env.tipTimer);
  env.tip?.remove();
  env.tip = null;
}

function showTip(env: Env, view: EditorView, anchor: HTMLElement, block: Block) {
  const root = env.ctx.workspace.root;
  if (!root) return;
  let commit = env.commits.get(block.sha);
  if (!commit) {
    commit = gitCommitInfo(root, block.sha);
    env.commits.set(block.sha, commit);
    commit.catch(() => env.commits.delete(block.sha));
  }
  const tip = document.createElement('div');
  tip.className = 'git-blame-tip';
  const line = (cls: string, text: string) => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    tip.append(el);
  };
  line('git-blame-tip-sha', block.sha);
  line('git-blame-tip-meta', `${block.author} <${block.email}>`);
  line('git-blame-tip-meta', `${fullDate(block.time)} (${relativeTime(block.time)})`);
  line('git-blame-tip-subject', block.summary);
  hideTip(env);
  env.tip = tip;
  view.dom.append(tip);
  const r = anchor.getBoundingClientRect();
  tip.style.left = `${Math.min(r.right + 6, window.innerWidth - 380)}px`;
  tip.style.top = `${Math.min(r.top, window.innerHeight - 160)}px`;
  void commit.then((c) => {
    // Replace the summary with the full message when the commit arrives.
    if (env.tip !== tip || !c.body) return;
    line('git-blame-tip-body', c.body);
  });
}

class Cell extends GutterMarker {
  constructor(
    readonly block: Block,
    readonly first: boolean,
    readonly env: Env,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof Cell && other.block === this.block && other.first === this.first;
  }
  override toDOM(view: EditorView) {
    const { block, first, env } = this;
    const el = document.createElement('div');
    el.className = 'git-blame-cell';
    if (first) el.classList.add('git-blame-first');
    if (block.uncommitted) {
      el.classList.add('git-blame-local');
      if (first) el.textContent = 'Not committed yet';
      return el;
    }
    // Newer commits get a stronger tint.
    el.style.background = `color-mix(in srgb, var(--accent) ${(3 + block.recency * 15).toFixed(1)}%, transparent)`;
    if (first) {
      const who = document.createElement('span');
      who.className = 'git-blame-author';
      who.textContent = block.author;
      const when = document.createElement('span');
      when.className = 'git-blame-when';
      when.textContent = relativeTime(block.time);
      el.append(who, when);
    }
    el.addEventListener('mouseenter', () => {
      clearTimeout(env.tipTimer);
      env.tipTimer = setTimeout(() => showTip(env, view, el, block), 350);
    });
    el.addEventListener('mouseleave', () => hideTip(env));
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      hideTip(env);
      openHistory(env.ctx, env.svc, env.editor.path, block.sha);
    });
    return el;
  }
}

const LOAD_DELAY_MS = 1000;

/** Text as git sees the file on disk: same line ending as the file. */
function textForGit(editor: FileEditor, text: string): string {
  const eol = editor.meta.lineEnding;
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : eol === 'cr' ? text.replace(/\n/g, '\r') : text;
}

/** The blame extension for one file editor. */
export function blameExtension(ctx: AppContext, svc: GitService, editor: FileEditor): Extension {
  const env: Env = { ctx, svc, editor, commits: new Map(), tip: null, tipTimer: undefined };

  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      token = 0;
      destroyed = false;
      warned = false;
      subs: { dispose(): void }[];

      constructor(readonly view: EditorView) {
        const same = (p: string) => p === editor.path;
        this.subs = [
          ctx.bus.on('file:saved', (e) => same(e.path) && this.schedule(100)),
          ctx.bus.on('fs:changed', (e) => (e.gitChanged || e.rescan) && this.schedule(300)),
        ];
        void this.load();
      }

      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(LOAD_DELAY_MS);
      }

      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
        hideTip(env);
        this.subs.forEach((s) => s.dispose());
      }

      schedule(ms: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.load(), ms);
      }

      async load() {
        const token = ++this.token;
        const root = ctx.workspace.root;
        const rel = svc.toRel(editor.path);
        const doc = this.view.state.doc;
        if (!root || !rel) return;
        try {
          // With unsaved edits, git blames the editor text instead of the file.
          const contents = editor.isDirty() ? textForGit(editor, doc.toString()) : null;
          const ranges = await gitBlame(root, rel, contents);
          if (this.destroyed || token !== this.token) return;
          if (this.view.state.doc !== doc) return this.schedule(200); // The text changed meanwhile.
          this.view.dispatch({ effects: setBlame.of(buildMarks(ranges, doc)) });
        } catch (e) {
          if (this.destroyed || token !== this.token) return;
          // Untracked file: every line is "not committed yet".
          if (isIpcError(e, 'not_found')) {
            this.view.dispatch({ effects: setBlame.of(RangeSet.empty) });
          } else if (!this.warned) {
            this.warned = true;
            ctx.ui.notify(`Git blame failed: ${(e as Error).message}`, { kind: 'error' });
          }
        }
      }
    },
  );

  const column = gutter({
    class: 'git-blame-gutter',
    lineMarker(view, line) {
      const set = view.state.field(blameField);
      const block = blockAt(set, line.from);
      const n = view.state.doc.lineAt(line.from).number;
      const prev = n > 1 ? blockAt(set, view.state.doc.line(n - 1).from) : null;
      return new Cell(block, prev !== block, env);
    },
    lineMarkerChange: (u) => u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setBlame))),
    initialSpacer: () => new Cell(LOCAL, false, env),
  });

  // Highest precedence puts this gutter before the line numbers.
  return [blameField, plugin, Prec.highest(column)];
}
