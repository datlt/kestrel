// The preview under the result list: a read-only CodeMirror view with syntax
// colors. Every match of the file is marked and the selected one is stronger.

import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { AppContext } from '../../core/types';
import { h } from '../../core/dom';
import { fsReadFile } from '../../ipc/fs';
import type { ResultFile } from './results';

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
/// Documents bigger than this get no syntax colors.
const HIGHLIGHT_LIMIT_CHARS = 1_000_000;
const CACHE_SIZE = 8;

const hit = Decoration.mark({ class: 'find-pv-hit' });
const current = Decoration.mark({ class: 'find-pv-hit find-pv-current' });

export class ResultPreview {
  private readonly view: EditorView;
  private readonly marks = new Compartment();
  private readonly cache = new Map<string, string>();
  private path: string | null = null;
  private token = 0;
  private disposed = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly host: HTMLElement,
    private readonly message: HTMLElement,
    private readonly onOpen: () => void,
  ) {
    this.view = new EditorView({ parent: host, state: this.baseState('', []) });
    this.host.addEventListener('dblclick', () => this.onOpen());
  }

  private baseState(doc: string, extra: Extension[]): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        this.ctx.editors.highlightExtension(),
        this.marks.of(EditorView.decorations.of(Decoration.none)),
        ...extra,
      ],
    });
  }

  clear(text = ''): void {
    this.token++;
    this.path = null;
    this.view.setState(this.baseState('', []));
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  /** Shows `file` and selects the line `line`. */
  async show(file: ResultFile, line: number): Promise<void> {
    const token = ++this.token;
    if (this.path === file.path && !this.ctx.editors.get(file.path)) {
      this.setMarks(file, line);
      return;
    }
    let text: string;
    try {
      const open = this.ctx.editors.get(file.path);
      if (open) {
        text = open.view.state.doc.toString();
      } else {
        const cached = this.cache.get(file.path);
        if (cached !== undefined) {
          text = cached;
        } else {
          const res = await fsReadFile(file.path, { maxBytes: MAX_PREVIEW_BYTES });
          if (token !== this.token || this.disposed) return;
          if (res.binary || res.tooLarge) {
            this.clear(res.binary ? 'This file is binary.' : 'This file is too large for the preview.');
            return;
          }
          text = res.text.replace(/\r\n?/g, '\n');
          this.cache.set(file.path, text);
          if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
        }
      }
    } catch (e) {
      if (token === this.token) this.clear(`Cannot read the file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const lang =
      text.length > HIGHLIGHT_LIMIT_CHARS
        ? null
        : await this.ctx.editors.loadLanguage(this.ctx.editors.languageIdFor(file.path)).catch(() => null);
    if (token !== this.token || this.disposed) return;
    this.message.hidden = true;
    this.path = file.path;
    this.view.setState(this.baseState(text, lang ? [lang.extension] : []));
    this.setMarks(file, line);
  }

  private setMarks(file: ResultFile, line: number): void {
    const doc = this.view.state.doc;
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    for (const m of file.matches) {
      if (m.line < 1 || m.line > doc.lines) continue;
      const l = doc.line(m.line);
      for (const [s, e] of m.ranges) {
        const from = l.from + m.offset + s;
        const to = l.from + m.offset + e;
        // The file may have changed since the search. Mark only text that still fits.
        if (to > l.to || doc.sliceString(from, to) !== m.text.slice(s, e)) continue;
        ranges.push({ from, to, deco: m.line === line ? current : hit });
      }
    }
    ranges.sort((a, b) => a.from - b.from);
    const set: DecorationSet = Decoration.set(ranges.map((r) => r.deco.range(r.from, r.to)));
    const effects: import('@codemirror/state').StateEffect<unknown>[] = [
      this.marks.reconfigure(EditorView.decorations.of(set)),
    ];
    const target = ranges.find((r) => r.deco === current) ?? null;
    if (target) effects.push(EditorView.scrollIntoView(target.from, { y: 'center' }));
    else if (line >= 1 && line <= doc.lines) effects.push(EditorView.scrollIntoView(doc.line(line).from, { y: 'center' }));
    this.view.dispatch({ effects });
  }

  /** Call after the popup was added to the page again. */
  refresh(): void {
    this.view.requestMeasure();
  }

  dispose(): void {
    this.disposed = true;
    this.view.destroy();
  }
}

export function previewShell(): { root: HTMLElement; path: HTMLElement; host: HTMLElement; message: HTMLElement } {
  const path = h('div', { class: 'find-pv-path' });
  const host = h('div', { class: 'find-pv-host' });
  const message = h('div', { class: 'find-pv-message' });
  message.hidden = true;
  const root = h('div', { class: 'find-preview' }, path, h('div', { class: 'find-pv-body' }, host, message));
  return { root, path, host, message };
}
