// Git marks in the editor gutter: added, modified and deleted lines, compared
// with the index version of the file (HEAD when the file is not in the index).

import { RangeSet, StateEffect, StateField, Text, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, gutter, GutterMarker, type ViewUpdate } from '@codemirror/view';
import type { Chunk } from '@codemirror/merge';
import type { AppContext, FileEditor } from '../../core/types';
import { gitShow } from '../../ipc/git';
import { loadMerge } from './diff-tab';
import type { GitService } from './service';
// The gutter marks are styled in this file. The diff and the view load later, so import it here too.
import './git.css';

type Kind = 'added' | 'modified' | 'deleted-top' | 'deleted-bottom';

class Marker extends GutterMarker {
  constructor(readonly kind: Kind) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof Marker && other.kind === this.kind;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = `git-gutter-mark git-gutter-${this.kind}`;
    return el;
  }
}

const MARKERS: Record<Kind, Marker> = {
  added: new Marker('added'),
  modified: new Marker('modified'),
  'deleted-top': new Marker('deleted-top'),
  'deleted-bottom': new Marker('deleted-bottom'),
};

const setMarkers = StateEffect.define<RangeSet<Marker>>();

const markerField = StateField.define<RangeSet<Marker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    // Between two diffs, keep the marks on their lines while the user types.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

// Files bigger than this get no marks (the diff would cost too much).
const MAX_CHARS = 3_000_000;
const DEBOUNCE_MS = 250;

/** Turns diff chunks into gutter marks on the lines of the current document. */
function buildMarkers(chunks: readonly Chunk[], doc: Text): RangeSet<Marker> {
  const ranges: ReturnType<Marker['range']>[] = [];
  const seen = new Set<number>();
  const put = (lineNo: number, kind: Kind) => {
    if (seen.has(lineNo)) return;
    seen.add(lineNo);
    ranges.push(MARKERS[kind].range(doc.line(lineNo).from));
  };
  for (const c of chunks) {
    if (c.fromB === c.toB) {
      // Lines were removed. Mark the line after the gap (or the last line).
      if (c.fromB >= doc.length) put(doc.lines, 'deleted-bottom');
      else put(doc.lineAt(c.fromB).number, 'deleted-top');
      continue;
    }
    const first = doc.lineAt(Math.min(c.fromB, doc.length)).number;
    const last = doc.lineAt(Math.min(c.endB, doc.length)).number;
    const kind: Kind = c.fromA === c.toA ? 'added' : 'modified';
    for (let n = first; n <= last; n++) put(n, kind);
  }
  return RangeSet.of(ranges, true);
}

interface Hub {
  /** Reads the base text of every open editor again. Without `force`, only editors that have none. */
  reloadAll(force: boolean): void;
}

/** Start of each group of changed lines (line numbers), in order. */
function changeStarts(view: EditorView): number[] {
  const starts: number[] = [];
  const doc = view.state.doc;
  let last = -10;
  const it = view.state.field(markerField).iter();
  while (it.value) {
    const n = doc.lineAt(it.from).number;
    if (n > last + 1) starts.push(n);
    last = n;
    it.next();
  }
  return starts;
}

/** Moves the cursor of the editor to the next or previous change. Returns false when there is none. */
export function jumpToChange(editor: FileEditor, dir: 1 | -1): boolean {
  const view = editor.view;
  if (!view.state.field(markerField, false)) return false;
  const starts = changeStarts(view);
  if (starts.length === 0) return false;
  const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
  let target: number;
  if (dir > 0) target = starts.find((n) => n > cur) ?? starts[0];
  else target = [...starts].reverse().find((n) => n < cur) ?? starts[starts.length - 1];
  const pos = view.state.doc.line(target).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
  return true;
}

export function createGutter(ctx: AppContext, svc: GitService): { provider: (e: FileEditor) => Extension | null; hub: Hub } {
  const plugins = new Set<{ reload(force: boolean): void }>();
  const hub: Hub = { reloadAll: (force) => plugins.forEach((p) => p.reload(force)) };

  const provider = (editor: FileEditor): Extension | null => {
    if (editor.path.startsWith('untitled:')) return null;

    const plugin = ViewPlugin.fromClass(
      class {
        base: Text | null = null;
        timer: ReturnType<typeof setTimeout> | undefined;
        baseToken = 0;
        destroyed = false;
        self = { reload: (force: boolean) => (force || this.base === null) && void this.loadBase() };

        constructor(readonly view: EditorView) {
          plugins.add(this.self);
          void this.loadBase();
        }

        update(u: ViewUpdate) {
          if (u.docChanged) this.schedule();
        }

        destroy() {
          this.destroyed = true;
          clearTimeout(this.timer);
          plugins.delete(this.self);
        }

        enabled() {
          return ctx.settings.get('git.gutter') && ctx.settings.get('git.enabled');
        }

        schedule() {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.compute(), DEBOUNCE_MS);
        }

        /** Reads the index version (or HEAD) of the file again. */
        async loadBase() {
          const token = ++this.baseToken;
          let base: Text | null = null;
          try {
            const root = ctx.workspace.root;
            const rel = this.enabled() ? svc.toRel(editor.path) : null;
            if (root && rel) {
              const limit = MAX_CHARS;
              let r = await gitShow(root, ':0', rel, limit);
              if (!r.exists) r = await gitShow(root, 'HEAD', rel, limit);
              if (r.exists && !r.binary && !r.tooLarge) base = Text.of(r.text.split(/\r\n?|\n/));
              else if (!r.exists && svc.model?.items.some((i) => i.group === 'untracked' && i.path === rel))
                base = Text.empty; // New file: every line is added.
            }
          } catch {
            base = null;
          }
          if (this.destroyed || token !== this.baseToken) return;
          this.base = base;
          await this.compute();
        }

        async compute() {
          if (this.destroyed) return;
          const doc = this.view.state.doc;
          if (!this.base || doc.length > MAX_CHARS || !this.enabled()) {
            if (this.view.state.field(markerField).size) this.view.dispatch({ effects: setMarkers.of(RangeSet.empty) });
            return;
          }
          const base = this.base;
          const m = await loadMerge();
          if (this.destroyed || this.view.state.doc !== doc) return; // A newer edit will schedule again.
          const chunks = m.Chunk.build(base, doc, { scanLimit: 500, timeout: 100 });
          this.view.dispatch({ effects: setMarkers.of(buildMarkers(chunks, doc)) });
        }
      },
    );

    return [
      markerField,
      plugin,
      gutter({
        class: 'git-gutter',
        markers: (v) => v.state.field(markerField),
        initialSpacer: () => MARKERS.added,
      }),
    ];
  };

  return { provider, hub };
}
