// One terminal pane: an xterm.js screen connected to one shell session in Rust.

import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { createElement, ChevronDown, ChevronUp, X } from 'lucide';
import { h } from '../../core/dom';
import { isMac } from '../../core/util';
import type { Settings } from '../../core/types';
import { termKill, termResize, termSpawn, termWrite, type TermSession } from '../../ipc/term';
import { attachIme, isImeKey, type ImeHandle } from './ime';
import { clipboardAction, isClosingKey, routeKey } from './keys';
import { readyDelay } from './run';
import { MINIMUM_CONTRAST_RATIO, fontFamilyFor, themeFromDocument } from './theme';
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

/** What a pane starts with. Everything is optional. */
export interface PaneInit {
  /** Folder for the shell. Missing: the folder of the workspace. */
  cwd?: string;
  /** A line to run when the shell is ready (`terminal.run`). */
  command?: string;
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
  private ime: ImeHandle | null = null;
  /** True after the user typed in this pane (not the command of `terminal.run`). */
  private _typed = false;

  // The command of `terminal.run`, and what we know about the output of the new shell.
  private runCommand: string | null;
  private runStart = 0;
  private firstOutputAt: number | null = null;
  private lastOutputAt: number | null = null;
  private runTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    private deps: PaneDeps,
    private init: PaneInit = {},
  ) {
    this.runCommand = init.command ?? null;
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
      // WebKit sends the Enter that confirms a conversion with keyCode 229 and isComposing false.
      if (isImeKey(e)) return;
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

  /** True after the user typed in this pane. */
  get typed(): boolean {
    return this._typed;
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
      // xterm moves a color that is hard to read (dark blue on black) until it
      // reaches this contrast. The ANSI palettes in theme.ts already pass it.
      minimumContrastRatio: MINIMUM_CONTRAST_RATIO,
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
    // Input methods (Japanese, Vietnamese ...). This must come after `open`: it
    // needs the helper textarea of xterm. See ime.ts for what it does.
    this.ime = attachIme(term, (text) => term.input(text, true));

    // WebGL is faster. When the browser has no WebGL, or it fails later, xterm
    // keeps using its DOM renderer.
    try {
      const gl = new mods.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch (e) {
      console.warn('[terminal] WebGL is not available, using the DOM renderer', e);
    }

    term.onData((data) => {
      this._typed = true;
      this.send(data);
    });
    term.onResize(({ cols, rows }) => {
      if (this.session) void termResize(this.session.id, cols, rows).catch(() => {});
    });
    term.onTitleChange((t) => this.deps.onTitle(this, t));

    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.el);
    this.fitNow();

    try {
      const session = await termSpawn(
        {
          cwd: this.init.cwd || (await this.deps.cwd()),
          cols: term.cols,
          rows: term.rows,
          shell: s['terminal.shell'],
          highlight: s['terminal.highlightCommands'] !== false,
        },
        (bytes) => {
          if (this.disposed) return;
          // `bytes` is a Uint8Array. xterm decodes UTF-8 as a stream, so a character
          // that is cut between two batches is put together again.
          term.write(bytes);
          this.noteOutput();
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
      this.runStart = performance.now();
      this.armRun();
    } catch (e) {
      this._exited = true;
      const msg = e instanceof Error ? e.message : String(e);
      term.write(`\r\n\x1b[31m[Cannot start the shell: ${msg}]\x1b[0m\r\n`);
    }
  }

  private noteOutput(): void {
    const now = performance.now();
    this.firstOutputAt ??= now;
    this.lastOutputAt = now;
    if (this.runCommand && this.session) this.armRun();
  }

  /**
   * Sends the command of `terminal.run` when the shell is ready: after the first
   * output (the prompt) and a short quiet time, at the latest 1 second after the
   * shell started. Input that comes too early waits in the terminal driver, so a
   * late start is not a problem.
   */
  private armRun(): void {
    if (!this.runCommand || this.disposed) return;
    if (this.runTimer) clearTimeout(this.runTimer);
    this.runTimer = null;
    const wait = readyDelay(this.runStart, this.firstOutputAt, this.lastOutputAt, performance.now());
    if (wait > 0) {
      this.runTimer = setTimeout(() => this.armRun(), wait);
      return;
    }
    const line = this.runCommand;
    this.runCommand = null;
    this.send(`${line}\r`);
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
    // A key of an input method (composition, keyCode 229) goes to xterm untouched: no
    // app shortcut, no copy and paste, no "close the pane". ime.ts stops these events
    // before they reach xterm, so this line is the second guard.
    if (isImeKey(e) || this.ime?.composing) return true;
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
      // isClosingKey skips the keys of an input method.
      if (isClosingKey(e)) {
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
      this.ime?.sync();
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
    // A new font size changes the cell size. The textarea of the input method must follow.
    this.ime?.sync();
  }

  applyTheme(): void {
    if (!this.term) return;
    this.term.options.theme = themeFromDocument();
    this.term.options.minimumContrastRatio = MINIMUM_CONTRAST_RATIO;
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
    if (this.runTimer) clearTimeout(this.runTimer);
    this.ime?.dispose();
    this.ime = null;
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
