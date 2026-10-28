// Quick open (Mod-p): fuzzy file search in the Rust index.

import type { AppContext, QuickPickHandle, QuickPickItem } from '../../core/types';
import { joinPath, samePath } from '../../core/util';
import { fileIcon } from '../../ui/file-icons';
import { onIndexReady, searchFiles, type FileHit } from '../../ipc/search';
import { parseGoto } from './query';

const RECENT_KEY = 'search.recent';
const RECENT_MAX = 50;
const RESULT_LIMIT = 100;
/** While the index builds, the list refreshes at this interval to show the file count. */
const BUILDING_REFRESH_MS = 400;

interface FileItem extends QuickPickItem {
  kind: 'file' | 'goto' | 'status';
  /** Path relative to the root, for `kind: 'file'`. */
  rel?: string;
}

export interface QuickOpen {
  open(): void;
  /** Called when an index build ends. */
  indexReady(root: string): void;
}

export function createQuickOpen(ctx: AppContext): QuickOpen {
  let handle: QuickPickHandle | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  // Remember opened files per folder (newest first, as relative paths).
  ctx.bus.on('file:opened', ({ path }) => {
    if (!ctx.workspace.root || path.startsWith('untitled:')) return;
    const rel = ctx.workspace.relative(path);
    if (rel === path) return; // outside the root
    const list = (ctx.workspace.state.get<string[]>(RECENT_KEY) ?? []).filter((p) => p !== rel);
    list.unshift(rel);
    ctx.workspace.state.set(RECENT_KEY, list.slice(0, RECENT_MAX));
  });

  // The event goes to all windows and all workbenches. Other roots are ignored.
  let unlisten: (() => void) | null = null;
  let disposed = false;
  onIndexReady((e) => {
    if (ctx.workspace.root && samePath(e.root, ctx.workspace.root)) quickOpen.indexReady(e.root);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e) => console.warn('cannot listen for the search index', e));

  ctx.bus.on('workbench:disposing', () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
    handle?.close();
    closed();
  });

  function closed(): void {
    handle = null;
    clearTimeout(refreshTimer);
  }

  function toItem(hit: FileHit): FileItem {
    const slash = hit.path.lastIndexOf('/');
    return {
      id: hit.path,
      kind: 'file',
      icon: () => fileIcon(hit.path.slice(slash + 1)),
      rel: hit.path,
      label: hit.path.slice(slash + 1),
      description: slash > 0 ? hit.path.slice(0, slash) : undefined,
      labelHighlights: hit.indices.filter((i) => i > slash).map((i) => i - slash - 1),
      descriptionHighlights: hit.indices.filter((i) => i < slash),
    };
  }

  function recentItems(): FileItem[] {
    const list = ctx.workspace.state.get<string[]>(RECENT_KEY) ?? [];
    return list.map((rel) => toItem({ path: rel, indices: [] }));
  }

  async function items(query: string, signal: AbortSignal): Promise<FileItem[]> {
    const root = ctx.workspace.root;
    if (!root) return [];
    const g = parseGoto(query);
    if (!g.name) {
      if (g.line) {
        return [{ id: 'goto', kind: 'goto', label: `Go to line ${g.line}${g.column ? `, column ${g.column}` : ''}` }];
      }
      const recent = recentItems();
      if (recent.length) return recent;
    }
    const res = await searchFiles(root, g.name, RESULT_LIMIT);
    if (signal.aborted) return [];
    if (res.state === 'building' && res.items.length === 0) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => handle?.refresh(), BUILDING_REFRESH_MS);
      return [{ id: 'status', kind: 'status', label: `Indexing… ${res.count.toLocaleString()} files` }];
    }
    return res.items.map(toItem);
  }

  function accept(item: FileItem, query: string): void {
    closed();
    const g = parseGoto(query);
    if (item.kind === 'status') return;
    if (item.kind === 'goto') {
      ctx.editors.active()?.revealLine(g.line ?? 1, g.column);
      return;
    }
    const root = ctx.workspace.root;
    if (!root || !item.rel) return;
    ctx.editors.openFile(joinPath(root, item.rel), { line: g.line, column: g.column }).catch((e) => {
      ctx.ui.notify(`Cannot open ${item.rel}: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    });
  }

  const quickOpen: QuickOpen = {
    open() {
      if (!ctx.workspace.root) {
        ctx.ui.notify('Open a folder first.', { kind: 'info' });
        return;
      }
      handle?.close();
      closed();
      handle = ctx.ui.quickPick<FileItem>({
        placeholder: 'Go to file (add :line to jump to a line)',
        items,
        onAccept: accept,
        onCancel: closed,
        emptyText: 'No matching files',
      });
    },
    indexReady() {
      handle?.refresh();
    },
  };
  return quickOpen;
}
