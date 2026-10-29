// Find bar of the Markdown preview. The bar lives in the main window, over the
// top right corner of the frame. It searches the text of `#md` in the frame and
// marks the matches with the CSS Custom Highlight API of the frame window.
// The text logic is in markdown-find-text.ts.

import { h } from '../../core/dom';
import {
  buildHaystack,
  clampIndex,
  countLabel,
  endPlace,
  findKeyAction,
  findMatches,
  startPlace,
  type Match,
  type Segment,
} from './markdown-find-text';

const HIGHLIGHT_ALL = 'kestrel-find';
const HIGHLIGHT_CURRENT = 'kestrel-find-current';
const BLOCK_SELECTOR = 'p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote,dt,dd,summary,div,tr,figcaption';
/** Text inside these is not searched. */
const SKIP_SELECTOR = '.md-code-tools,script,style';
/** Spaces between these elements are layout only, not text. */
const LAYOUT_PARENT = 'ul,ol,table,thead,tbody,tfoot,tr,dl,details,blockquote,div';
const MAX_SELECTED_CHARS = 200;
/** A search of a text longer than this waits for a pause in typing. */
const DEBOUNCE_ABOVE_CHARS = 200_000;
const DEBOUNCE_MS = 100;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
type HighlightConstructor = new (...ranges: Range[]) => unknown;

export class PreviewFind {
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly caseButton: HTMLButtonElement;
  private doc: Document | null = null;
  private matches: Range[] = [];
  private index = -1;
  private textSize = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private matchCase = false;

  constructor(
    root: HTMLElement,
    private readonly iframe: HTMLIFrameElement,
  ) {
    this.input = h('input', {
      class: 'preview-find-input',
      type: 'text',
      placeholder: 'Find',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Find in preview',
      oninput: () => this.onInput(),
      onkeydown: (e: Event) => this.onKey(e as KeyboardEvent),
    });
    this.count = h('span', { class: 'preview-find-count', 'aria-live': 'polite' });
    this.caseButton = h('button', { class: 'preview-btn preview-find-btn', type: 'button', title: 'Match case', 'aria-label': 'Match case', 'aria-pressed': 'false', onclick: () => this.toggleCase() }, 'Aa');
    this.bar = h(
      'div',
      { class: 'preview-find', role: 'search', hidden: true },
      this.input,
      this.count,
      this.caseButton,
      h('button', { class: 'preview-btn preview-find-btn', type: 'button', title: 'Previous match (Shift-Enter)', 'aria-label': 'Previous match', onclick: () => this.previous() }, '↑'),
      h('button', { class: 'preview-btn preview-find-btn', type: 'button', title: 'Next match (Enter)', 'aria-label': 'Next match', onclick: () => this.next() }, '↓'),
      h('button', { class: 'preview-btn preview-find-btn', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => this.close() }, '✕'),
    );
    root.append(this.bar);
  }

  isOpen(): boolean {
    return !this.bar.hidden;
  }

  /** Shows the bar. A short selected line in the frame becomes the query. */
  open(): void {
    const selected = this.doc?.defaultView?.getSelection()?.toString().trim() ?? '';
    if (selected && selected.length <= MAX_SELECTED_CHARS && !/[\r\n]/.test(selected)) this.input.value = selected;
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
    this.search(false, true);
  }

  close(): void {
    clearTimeout(this.timer);
    this.bar.hidden = true;
    this.clearHighlights();
    this.matches = [];
    this.index = -1;
    this.iframe.contentWindow?.focus();
  }

  next(): void {
    this.step(1);
  }

  previous(): void {
    this.step(-1);
  }

  /** The frame loaded again. Old ranges belong to the old document. */
  attach(doc: Document): void {
    this.doc = doc;
    this.matches = [];
    this.index = -1;
  }

  /** The content was rendered again. Search again and keep the place when possible. */
  refresh(): void {
    if (this.isOpen()) this.search(true, false);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.clearHighlights();
    this.bar.remove();
    this.doc = null;
    this.matches = [];
  }

  // --- Input -------------------------------------------------------------

  private onInput(): void {
    clearTimeout(this.timer);
    if (this.textSize > DEBOUNCE_ABOVE_CHARS) this.timer = setTimeout(() => this.search(false, true), DEBOUNCE_MS);
    else this.search(false, true);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      this.input.select();
      return;
    }
    const action = findKeyAction(e, true);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'close') this.close();
    else this.step(action === 'next' ? 1 : -1);
  }

  private toggleCase(): void {
    this.matchCase = !this.matchCase;
    this.caseButton.setAttribute('aria-pressed', String(this.matchCase));
    this.search(false, true);
  }

  // --- Search ------------------------------------------------------------

  /** Text nodes of the article with the block that holds each one. */
  private collect(article: HTMLElement): { nodes: Text[]; segments: Segment[] } {
    const doc = article.ownerDocument;
    const walker = doc.createTreeWalker(article, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes: Text[] = [];
    const segments: Segment[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const node = n as Text;
      const parent = node.parentElement;
      const text = node.data;
      if (!parent || !text || parent.closest(SKIP_SELECTOR)) continue;
      if (!text.trim() && parent.matches(LAYOUT_PARENT)) continue;
      nodes.push(node);
      segments.push({ text, block: parent.closest(BLOCK_SELECTOR) ?? article });
    }
    return { nodes, segments };
  }

  /** Finds the matches again. `keep` tries to stay at the same match number. `reveal` scrolls to the current one. */
  private search(keep: boolean, reveal: boolean): void {
    const article = this.doc?.getElementById('md');
    const query = this.input.value;
    if (!this.doc || !article || !query) {
      this.matches = [];
      this.index = -1;
      this.textSize = 0;
      this.paint(false);
      return;
    }
    const { nodes, segments } = this.collect(article);
    const hay = buildHaystack(segments);
    this.textSize = hay.text.length;
    const ranges: Range[] = [];
    for (const m of findMatches(hay.text, query, this.matchCase)) {
      const range = this.toRange(nodes, hay, m);
      if (range) ranges.push(range);
    }
    this.matches = ranges;
    this.index = clampIndex(keep ? this.index : 0, ranges.length);
    this.paint(reveal);
  }

  private toRange(nodes: Text[], hay: ReturnType<typeof buildHaystack>, m: Match): Range | null {
    const from = startPlace(hay, m.start);
    const to = endPlace(hay, m.end);
    if (!from || !to || !this.doc) return null;
    const range = this.doc.createRange();
    range.setStart(nodes[from.segment], from.offset);
    range.setEnd(nodes[to.segment], to.offset);
    return range;
  }

  private step(delta: 1 | -1): void {
    const n = this.matches.length;
    if (!n) return;
    this.index = (this.index + delta + n) % n;
    this.paint(true);
  }

  // --- Highlight ---------------------------------------------------------

  private registry(): { highlights: HighlightRegistry; Highlight: HighlightConstructor } | null {
    const win = this.doc?.defaultView as (Window & { CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightConstructor }) | null | undefined;
    if (!win?.CSS?.highlights || !win.Highlight) return null;
    return { highlights: win.CSS.highlights, Highlight: win.Highlight };
  }

  private clearHighlights(): void {
    const reg = this.registry();
    if (reg) {
      reg.highlights.delete(HIGHLIGHT_ALL);
      reg.highlights.delete(HIGHLIGHT_CURRENT);
    }
  }

  /** Marks the matches, updates the counter and shows the current match. */
  private paint(reveal: boolean): void {
    this.count.textContent = countLabel(this.index, this.matches.length, this.input.value);
    this.bar.classList.toggle('no-results', !!this.input.value && !this.matches.length);
    this.clearHighlights();
    const current = this.matches[this.index];
    if (!current) return;
    const reg = this.registry();
    if (reg) {
      reg.highlights.set(HIGHLIGHT_ALL, new reg.Highlight(...this.matches));
      reg.highlights.set(HIGHLIGHT_CURRENT, new reg.Highlight(current));
    } else {
      const sel = this.doc?.defaultView?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(current);
    }
    if (reveal) this.reveal(current);
  }

  /** Scrolls only when the match is outside the visible part (of the frame, and of a code block that scrolls sideways). */
  private reveal(range: Range): void {
    const win = this.doc?.defaultView;
    const el = range.startContainer.parentElement;
    if (!win || !el) return;
    const r = range.getBoundingClientRect();
    const clip = el.closest('pre')?.getBoundingClientRect();
    const visible =
      r.top >= 0 &&
      r.bottom <= win.innerHeight &&
      r.left >= 0 &&
      r.right <= win.innerWidth &&
      (!clip || (r.left >= clip.left && r.right <= clip.right));
    if (!visible) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}
