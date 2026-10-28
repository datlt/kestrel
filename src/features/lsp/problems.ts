// Diagnostics store and the Problems panel (view id `problems`).
import { createElement, TriangleAlert } from 'lucide';
import type { AppContext, ViewDescriptor, ViewInstance } from '../../core/types';
import { h, clear } from '../../core/dom';
import { debounce, basename } from '../../core/util';
import { uriToPath, normalizeUri } from './uri';

/** LSP severity: 1 error, 2 warning, 3 information, 4 hint. */
export interface Problem {
  path: string;
  /** 0-based. */
  line: number;
  character: number;
  severity: number;
  message: string;
  source?: string;
  code?: string;
}

interface LspDiagnostic {
  range: { start: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

/** Diagnostics of all sessions, by session and file. */
export class DiagnosticsStore {
  private bySession = new Map<string, Map<string, { path: string; items: Problem[] }>>();
  private listeners = new Set<() => void>();

  set(sessionId: string, uri: string, diagnostics: LspDiagnostic[]): void {
    const path = uriToPath(uri);
    if (!path) return;
    let files = this.bySession.get(sessionId);
    if (!files) this.bySession.set(sessionId, (files = new Map()));
    const key = normalizeUri(uri);
    if (diagnostics.length === 0) {
      if (!files.delete(key)) return;
    } else {
      files.set(key, {
        path,
        items: diagnostics.map((d) => ({
          path,
          line: d.range.start.line,
          character: d.range.start.character,
          severity: d.severity ?? 1,
          message: d.message,
          source: d.source,
          code: d.code === undefined ? undefined : String(d.code),
        })),
      });
    }
    this.emit();
  }

  clearSession(sessionId: string): void {
    if (this.bySession.delete(sessionId)) this.emit();
  }

  clearAll(): void {
    if (this.bySession.size === 0) return;
    this.bySession.clear();
    this.emit();
  }

  /** Files with problems, sorted by path. Problems are sorted by position. */
  groups(): { path: string; items: Problem[] }[] {
    const merged = new Map<string, Problem[]>();
    for (const files of this.bySession.values()) {
      for (const { path, items } of files.values()) merged.set(path, [...(merged.get(path) ?? []), ...items]);
    }
    return [...merged.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, items]) => ({
        path,
        items: items.sort((a, b) => a.line - b.line || a.character - b.character),
      }));
  }

  counts(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const files of this.bySession.values())
      for (const { items } of files.values())
        for (const p of items) {
          if (p.severity === 1) errors++;
          else if (p.severity === 2) warnings++;
        }
    return { errors, warnings };
  }

  onChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

type Row = { kind: 'file'; path: string; count: number; collapsed: boolean } | { kind: 'problem'; problem: Problem };

const ROW_HEIGHT = 22;
const OVERSCAN = 8;
const SEVERITY_CLASS = ['', 'error', 'warning', 'info', 'hint'];

export function createProblemsView(ctx: AppContext, store: DiagnosticsStore): ViewDescriptor {
  return {
    id: 'problems',
    title: 'Problems',
    location: 'panel',
    order: 10,
    icon: () => createElement(TriangleAlert),
    create(host): ViewInstance {
      const collapsed = new Set<string>();
      let rows: Row[] = [];
      const summary = h('div', { class: 'lsp-problems-summary' });
      const spacer = h('div', { class: 'lsp-rows-spacer' });
      const scroller = h('div', { class: 'lsp-rows' }, spacer);
      const empty = h('div', { class: 'lsp-empty' }, 'No problems found.');
      host.classList.add('lsp-problems');
      host.append(summary, scroller, empty);

      const buildRows = () => {
        rows = [];
        for (const g of store.groups()) {
          const isCollapsed = collapsed.has(g.path);
          rows.push({ kind: 'file', path: g.path, count: g.items.length, collapsed: isCollapsed });
          if (!isCollapsed) for (const p of g.items) rows.push({ kind: 'problem', problem: p });
        }
        const { errors, warnings } = store.counts();
        summary.textContent = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
        empty.style.display = rows.length === 0 ? '' : 'none';
        scroller.style.display = rows.length === 0 ? 'none' : '';
        spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
      };

      const render = () => {
        const top = scroller.scrollTop;
        const height = scroller.clientHeight || 200;
        const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
        clear(spacer);
        for (let i = first; i < last; i++) spacer.append(rowElement(rows[i]!, i));
      };

      const rowElement = (row: Row, index: number): HTMLElement => {
        const style = `top:${index * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`;
        if (row.kind === 'file') {
          const rel = ctx.workspace.relative(row.path);
          return h(
            'div',
            {
              class: 'lsp-row lsp-row-file',
              style,
              title: row.path,
              onclick: () => {
                if (collapsed.has(row.path)) collapsed.delete(row.path);
                else collapsed.add(row.path);
                refresh();
              },
            },
            h('span', { class: 'lsp-twisty' }, row.collapsed ? '▸' : '▾'),
            h('span', { class: 'lsp-file-name' }, basename(row.path)),
            h('span', { class: 'lsp-file-dir' }, rel === basename(row.path) ? '' : rel),
            h('span', { class: 'lsp-count' }, String(row.count)),
          );
        }
        const p = row.problem;
        return h(
          'div',
          {
            class: 'lsp-row lsp-row-problem',
            style,
            title: p.message,
            onclick: () => void ctx.editors.openFile(p.path, { line: p.line + 1, column: p.character + 1 }),
          },
          h('span', { class: `lsp-dot lsp-dot-${SEVERITY_CLASS[p.severity] ?? 'error'}` }, '●'),
          h('span', { class: 'lsp-message' }, p.message.split('\n')[0] ?? ''),
          h('span', { class: 'lsp-source' }, [p.source, p.code].filter(Boolean).join(' ')),
          h('span', { class: 'lsp-pos' }, `[${p.line + 1}, ${p.character + 1}]`),
        );
      };

      const refresh = () => {
        buildRows();
        render();
      };
      const refreshSoon = debounce(refresh, 100);

      scroller.addEventListener('scroll', render, { passive: true });
      const resize = new ResizeObserver(() => requestAnimationFrame(() => render()));
      resize.observe(scroller);
      const sub = store.onChange(refreshSoon);
      refresh();

      return {
        onShow: refresh,
        dispose() {
          sub.dispose();
          resize.disconnect();
        },
      };
    },
  };
}
