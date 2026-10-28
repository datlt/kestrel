// One terminal pane: an xterm.js screen connected to one shell session in Rust.

import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { createElement, ChevronDown, ChevronUp, X } from 'lucide';
import { h } from '../../core/dom';
import { isMac } from '../../core/util';
import type { Settings } from '../../core/types';
import { termKill, termResize, termSpawn, termWrite, type TermSession } from '../../ipc/term';
import { clipboardAction, isClosingKey, routeKey } from './keys';
import { fontFamilyFor, themeFromDocument } from './theme';
import { loadXterm } from './xterm-loader';

export interface PaneDeps {
  /** Folder for the new shell. Waits a moment while the workspace still opens. */
  cwd(): Promise<string>;
  settings(): Readonly<Settings>;
  /** The pane got keyboard focus. */
  onFocus(pane: TerminalPane): void;
  /** The program set a title (for example the folder name). */
  onTitle(pane: TerminalPane, title: string): void;
  /** The user pressed a key in a pane whose shell has ended: close the pane. */
  onCloseRequest(pane: TerminalPane): void;
  onContextMenu(pane: TerminalPane, e: MouseEvent): void;
  /** Shows an error to the user. */
  onError(message: string): void;
}

export function terminalFontSize(s: Readonly<Settings>): number {
  const own = s['terminal.fontSize'];
  return own > 0 ? own : s['editor.fontSize'];
}

function rootVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

function fontFamily(s: Readonly<Settings>): string {
  return fontFamilyFor(s['editor.fontFamily'], rootVar);
}

const HEX = /^#[0-9a-f]{6}$/i;

function openLink(uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return;
  import('@tauri-apps/plugin-opener')
    .then((m) => m.openUrl(uri))
    .catch(() => window.open(uri, '_blank', 'noopener'));
}

export class TerminalPane {
  readonly el: HTMLElement;
  private screen: HTMLElement;
  private searchBar: HTMLElement;
  private searchInput: HTMLInputElement;
  private searchCount: HTMLElement;

  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private searchAddon: SearchAddon | null = null;
  private session: TermSession | null = null;
  private observer: ResizeObserver | null = null;
  private fitFrame = 0;
  private pendingInput: string[] = [];
  private disposed = false;
  private _exited = false;

  constructor(
    readonly id: string,
    private deps: PaneDeps,
  ) {
    this.screen = h('div', { class: 'term-screen' });
    this.searchInput = h('input', {
      class: 'term-search-input',
      type: 'text',
      placeholder: 'Find',
      spellcheck: 'false',
      'aria-label': 'Find in terminal',
    });
    this.searchCount = h('span', { class: 'term-search-count' });
    const icon = (svg: SVGElement) => svg;
    this.searchBar = h(
      'div',
      { class: 'term-search', hidden: true },
      this.searchInput,
      this.searchCount,
      h('button', { class: 'term-icon-btn', title: 'Previous match (Shift-Enter)', onclick: () => this.findStep(false) }, icon(createElement(ChevronUp))),
      h('button', { class: 'term-icon-btn', title: 'Next match (Enter)', onclick: () => this.findStep(true) }, icon(createElement(ChevronDown))),
      h('button', { class: 'term-icon-btn', title: 'Close (Escape)', onclick: () => this.closeSearch() }, icon(createElement(X))),
    );
    this.el = h('div', { class: 'term-pane', 'data-pane': id }, this.screen, this.searchBar);

    this.el.addEventListener('focusin', () => this.deps.onFocus(this));
    this.el.addEventListener('pointerdown', () => this.deps.onFocus(this), true);
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.deps.onContextMenu(this, e);
    });
    this.searchInput.addEventListener('input', () => this.find(true, true));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.findStep(!e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSearch();
      }
    });
  }

  get exited(): boolean {
    return this._exited;
  }

  /** Loads xterm, opens the screen and starts the shell. Call it after `el` is in the page. */
  async start(): Promise<void> {
    let mods;
    try {
      mods = await loadXterm();
    } catch (e) {
      this.deps.onError(`Cannot load the terminal: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.disposed) return;
    const s = this.deps.settings();
    const term = new mods.Terminal({
      // Unicode 11 widths (CJK, emoji) use a proposed API.
      allowProposedApi: true,
      cursorBlink: s['terminal.cursorBlink'],
      fontFamily: fontFamily(s),
      fontSize: terminalFontSize(s),
      scrollback: Math.max(0, s['terminal.scrollback']),
      theme: themeFromDocument(),
      macOptionClickForcesSelection: true,
    });
    this.term = term;
    const fit = new mods.FitAddon();
    this.fitAddon = fit;
    term.loadAddon(fit);
    term.loadAddon(new mods.Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new mods.WebLinksAddon((_e, uri) => openLink(uri)));
    const search = new mods.SearchAddon();
    this.searchAddon = search;
    term.loadAddon(search);
    search.onDidChangeResults((r) => {
      this.searchCount.textContent = this.searchInput.value ? (r.resultCount > 0 ? `${r.resultIndex + 1}/${r.resultCount}` : 'No results') : '';
    });

    term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    term.open(this.screen);

    // WebGL is faster. When the browser has no WebGL, or it fails later, xterm
    // keeps using its DOM renderer.
    try {
      const gl = new mods.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch (e) {
      console.warn('[terminal] WebGL is not available, using the DOM renderer', e);
    }

    term.onData((data) => this.send(data));
    term.onResize(({ cols, rows }) => {
      if (this.session) void termResize(this.session.id, cols, rows).catch(() => {});
    });
    term.onTitleChange((t) => this.deps.onTitle(this, t));

    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.el);
    this.fitNow();

    try {
      const session = await termSpawn(
        { cwd: await this.deps.cwd(), cols: term.cols, rows: term.rows, shell: s['terminal.shell'] },
        (bytes) => {
          if (!this.disposed) term.write(bytes);
        },
        (code) => this.handleExit(code),
      );
      if (this.disposed) {
        void termKill(session.id).catch(() => {});
        return;
      }
      this.session = session;
      // The size can have changed while the shell started.
      void termResize(session.id, term.cols, term.rows).catch(() => {});
      this.writeBuf += this.pendingInput.splice(0).join('');
      void this.flushWrites();
    } catch (e) {
      this._exited = true;
      const msg = e instanceof Error ? e.message : String(e);
      term.write(`\r\n\x1b[31m[Cannot start the shell: ${msg}]\x1b[0m\r\n`);
    }
  }

  private send(data: string): void {
    if (this._exited) return;
    if (!this.session) {
      this.pendingInput.push(data);
      return;
    }
    this.writeBuf += data;
    void this.flushWrites();
  }

  /** Input not sent yet. Keys typed while a write runs are sent together next. */
  private writeBuf = '';
  private writing = false;

  /**
   * Sends input one write at a time. Each `term_write` is its own async
   * command, so two writes in flight can reach the shell in the wrong order
   * ("src" became "scr" when typing fast).
   */
  private async flushWrites(): Promise<void> {
    if (this.writing || !this.session) return;
    this.writing = true;
    try {
      while (this.writeBuf && this.session && !this.disposed) {
        const chunk = this.writeBuf;
        this.writeBuf = '';
        await termWrite(this.session.id, chunk).catch(() => {});
      }
    } finally {
      this.writing = false;
    }
  }

  private handleKey(e: KeyboardEvent): boolean {
    const route = routeKey(e, isMac);
    if (route === 'search') {
      if (e.type === 'keydown') {
        e.preventDefault();
        this.openSearch();
      }
      return false;
    }
    const clip = clipboardAction(e, isMac);
    if (clip) {
      e.preventDefault();
      if (clip === 'copy') {
        const text = this.term?.getSelection();
        if (text) void navigator.clipboard.writeText(text).catch(() => {});
      } else {
        void this.paste();
      }
      return false;
    }
    if (route === 'app') return false;
    if (this._exited) {
      // IME composition sends keyCode 229. It must not close the pane.
      if (!e.isComposing && e.keyCode !== 229 && isClosingKey(e)) {
        e.preventDefault();
        this.deps.onCloseRequest(this);
      }
      return false;
    }
    return true;
  }

  private handleExit(code: number): void {
    if (this._exited || this.disposed) return;
    this._exited = true;
    // Output and the exit message use two channels. A short wait keeps the message last.
    setTimeout(() => {
      if (this.disposed) return;
      this.term?.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n\x1b[2m[Press any key to close this pane]\x1b[0m\r\n`);
    }, 40);
  }

  async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.term?.paste(text);
    } catch {
      // The browser can refuse clipboard access. Nothing to paste then.
    }
  }

  copySelection(): void {
    const text = this.term?.getSelection();
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
  }

  hasSelection(): boolean {
    return !!this.term?.hasSelection();
  }

  selectAll(): void {
    this.term?.selectAll();
  }

  // --- Layout ------------------------------------------------------------

  private scheduleFit(): void {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.fitNow();
    });
  }

  /** Fits the screen to the pane. It does nothing while the pane is hidden. */
  fitNow(): void {
    if (this.disposed || !this.term || !this.fitAddon) return;
    if (this.el.clientWidth < 20 || this.el.clientHeight < 20) return;
    try {
      this.fitAddon.fit();
    } catch {
      // The renderer is not ready yet. The next resize fits again.
    }
  }

  focus(): void {
    this.term?.focus();
  }

  hasFocus(): boolean {
    return this.el.contains(document.activeElement);
  }

  setActive(active: boolean): void {
    this.el.classList.toggle('is-active', active);
  }

  clear(): void {
    this.term?.clear();
  }

  // --- Settings and theme --------------------------------------------------

  applySettings(): void {
    const term = this.term;
    if (!term) return;
    const s = this.deps.settings();
    term.options.fontFamily = fontFamily(s);
    term.options.fontSize = terminalFontSize(s);
    term.options.scrollback = Math.max(0, s['terminal.scrollback']);
    term.options.cursorBlink = s['terminal.cursorBlink'];
    this.scheduleFit();
  }

  applyTheme(): void {
    if (this.term) this.term.options.theme = themeFromDocument();
  }

  // --- Search --------------------------------------------------------------

  openSearch(): void {
    this.searchBar.hidden = false;
    const selected = this.term?.getSelection();
    if (selected && !selected.includes('\n')) this.searchInput.value = selected;
    this.searchInput.focus();
    this.searchInput.select();
    this.scheduleFit();
    if (this.searchInput.value) this.find(true, true);
  }

  closeSearch(): void {
    this.searchBar.hidden = true;
    this.searchAddon?.clearDecorations();
    this.searchCount.textContent = '';
    this.scheduleFit();
    this.term?.focus();
  }

  private searchOptions(incremental: boolean): ISearchOptions {
    const match = rootVar('--warn').trim();
    const active = rootVar('--accent').trim();
    const opts: ISearchOptions = { incremental };
    if (HEX.test(match) && HEX.test(active)) {
      opts.decorations = {
        matchBackground: match,
        matchOverviewRuler: match,
        activeMatchBackground: active,
        activeMatchColorOverviewRuler: active,
      };
    }
    return opts;
  }

  private find(forward: boolean, incremental: boolean): void {
    const q = this.searchInput.value;
    if (!this.searchAddon) return;
    if (!q) {
      this.searchAddon.clearDecorations();
      this.searchCount.textContent = '';
      return;
    }
    const opts = this.searchOptions(incremental);
    if (forward) this.searchAddon.findNext(q, opts);
    else this.searchAddon.findPrevious(q, opts);
  }

  private findStep(forward: boolean): void {
    this.find(forward, false);
  }

  // --- End -----------------------------------------------------------------

  /** Stops the shell. The pane stays in the page. */
  kill(): void {
    if (this.session && !this._exited) void termKill(this.session.id).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.observer?.disconnect();
    if (this.session) void termKill(this.session.id).catch(() => {});
    try {
      this.term?.dispose();
    } catch {
      // A lost WebGL context can throw while it is disposed.
    }
    this.term = null;
    this.el.remove();
  }
}
