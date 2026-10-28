// Explorer view: a virtualized tree of the open folder.
// `createExplorer` builds the model and the event handling. The DOM exists only
// after the shell shows the view for the first time.

import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  createElement,
  type IconNode,
} from 'lucide';
import type { AppContext, GitFileStatus, MenuItem, ViewDescriptor, ViewInstance } from '../../core/types';
import { clear, h } from '../../core/dom';
import { debounce, dirname, isInside, joinPath, platform, rafThrottle } from '../../core/util';
import { fileIcon } from '../../ui/file-icons';
import { fsCreateDir, fsCreateFile, fsListDir } from '../../ipc/fs';
import { createExcludeMatcher, type ExcludeMatcher } from './exclude';
import { deleteEntry, renameEntry, validateName } from './ops';
import { TreeModel, type TreeNode } from './tree';
import './explorer.css';

const EXPANDED_KEY = 'explorer.expanded';
const OVERSCAN = 8;
const INDENT_PX = 12;
const BASE_PAD_PX = 6;

const STATUS_RANK: Record<GitFileStatus, number> = {
  untracked: 1,
  added: 2,
  renamed: 3,
  modified: 4,
  deleted: 5,
  conflict: 6,
};
const STATUS_LETTER: Record<GitFileStatus, string> = {
  untracked: 'U',
  added: 'A',
  renamed: 'R',
  modified: 'M',
  deleted: 'D',
  conflict: '!',
};

const iconCache = new Map<IconNode, Element>();
function icon(node: IconNode): Element {
  let proto = iconCache.get(node);
  if (!proto) {
    proto = createElement(node);
    iconCache.set(node, proto);
  }
  return proto.cloneNode(true) as Element;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const excludeList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const slash = (p: string) => (platform === 'windows' ? p.replace(/\\/g, '/') : p);

export interface Explorer {
  descriptor(): ViewDescriptor;
  hasSelection(): boolean;
  newFile(): Promise<void>;
  newFolder(): Promise<void>;
  rename(): void;
  delete(): Promise<void>;
  revealActive(): Promise<void>;
  refresh(): Promise<void>;
  collapseAll(): void;
}

interface Editing {
  node: TreeNode;
  mode: 'rename' | 'create';
  input: HTMLInputElement;
  row: HTMLElement;
}

export function createExplorer(ctx: AppContext): Explorer {
  let excluded: ExcludeMatcher = createExcludeMatcher(excludeList(ctx.settings.get('files.exclude')));
  let excludeKey = JSON.stringify(ctx.settings.get('files.exclude'));
  let compactOn = ctx.settings.get('explorer.compactFolders') !== false;
  const model = new TreeModel({
    // Rust joins folders that hold only one folder. It needs the exclude globs to ignore hidden entries.
    list: (dir, root) => fsListDir(dir, root, { compact: compactOn, exclude: excludeList(ctx.settings.get('files.exclude')) }),
    isExcluded: (rel) => excluded(rel),
    onError: (message, path) => ctx.ui.notify(`Cannot read ${path}: ${message}`, { kind: 'error' }),
  });

  let selectedPath: string | null = null;
  let activePath: string | null = null;
  let decor = new Map<string, GitFileStatus>();
  let dirDecor = new Map<string, GitFileStatus>();
  let ui: ViewUi | null = null;

  const render = rafThrottle(() => ui?.render(true));
  model.onChange = () => render();
  // Set by the view. Frees what the view created outside its own element.
  let teardownUi: (() => void) | null = null;

  // --- Helpers --------------------------------------------------------------

  const selectedNode = () => (selectedPath ? (model.byPath.get(selectedPath) ?? null) : null);

  function saveExpanded() {
    ctx.workspace.state.set(EXPANDED_KEY, model.expandedPaths());
  }

  function statusOf(n: TreeNode): GitFileStatus | undefined {
    return (n.isDir ? dirDecor : decor).get(slash(n.path));
  }

  function setDecorations(files: Record<string, GitFileStatus>) {
    decor = new Map();
    dirDecor = new Map();
    const rootPath = model.root ? slash(model.root.path) : null;
    for (const [p, st] of Object.entries(files)) {
      const key = slash(p);
      decor.set(key, st);
      let d = dirname(key);
      while (d && d !== key) {
        const cur = dirDecor.get(d);
        // Parents above this folder already have a status that is at least as strong.
        if (cur && STATUS_RANK[cur] >= STATUS_RANK[st]) break;
        dirDecor.set(d, st);
        if (d === rootPath) break;
        const up = dirname(d);
        if (up === d) break;
        d = up;
      }
    }
    render();
  }

  function pathOfTab(id: string | undefined): string | null {
    if (!id) return null;
    for (const prefix of ['file:', 'image:']) if (id.startsWith(prefix)) return id.slice(prefix.length);
    return null;
  }

  async function openNode(n: TreeNode, preview: boolean) {
    try {
      await ctx.editors.openFile(n.path, { preview });
      if (!preview) {
        const id = `file:${n.path}`;
        if (ctx.tabs.get(id)) ctx.tabs.pin(id);
      }
    } catch (e) {
      ctx.ui.notify(`Cannot open ${n.name}: ${errorText(e)}`, { kind: 'error' });
    }
  }

  async function toggle(n: TreeNode) {
    await model.toggle(n);
    saveExpanded();
  }

  function select(n: TreeNode | null, scroll = true) {
    selectedPath = n?.path ?? null;
    ui?.render(true);
    if (n && scroll) ui?.scrollTo(n);
  }

  function targetFolder(): TreeNode | null {
    const n = selectedNode();
    if (!n) return model.root;
    return n.isDir ? n : (n.parent ?? model.root);
  }

  // --- Actions --------------------------------------------------------------

  async function beginCreate(kind: 'file' | 'dir') {
    if (!model.root) return;
    ctx.views.show('explorer');
    const folder = targetFolder();
    if (!folder) return;
    if (folder !== model.root && !folder.expanded) await model.expand(folder);
    if (folder.children === null) await model.expand(folder);
    const ph = model.addPending(folder, kind);
    if (!ui) return;
    ui.startEdit(ph, 'create');
  }

  function beginRename() {
    const n = selectedNode();
    if (!n || n === model.root) return;
    ui?.startEdit(n, 'rename');
  }

  async function doDelete() {
    const n = selectedNode();
    if (!n || n === model.root) return;
    const idx = model.rows.indexOf(n);
    if (!(await deleteEntry(ctx, n.path, n.name, n.isDir))) return;
    await model.refresh([n.parent?.path ?? dirname(n.path)]);
    const next = model.rows[Math.min(idx, model.rows.length - 1)] ?? null;
    select(next);
  }

  async function commitEdit(ed: Editing, value: string): Promise<void> {
    const node = ed.node;
    if (ed.mode === 'rename') {
      const from = node.path;
      const to = joinPath(dirname(from), value);
      ui?.finishEdit();
      if (!(await renameEntry(ctx, from, to))) return;
      // A renamed folder can be part of a compact row. The listed parent is the node that knows.
      await model.refresh([node.parent?.path ?? dirname(from)]);
      selectedPath = to;
      ui?.render(true);
      return;
    }
    const folder = node.parent ?? model.root!;
    const path = joinPath(folder.path, ...value.split(/[\\/]/).filter(Boolean));
    ui?.finishEdit();
    try {
      if (node.pending === 'dir') await fsCreateDir(path);
      else await fsCreateFile(path);
    } catch (e) {
      ctx.ui.notify(`Cannot create: ${errorText(e)}`, { kind: 'error' });
      return;
    }
    await model.refresh([folder.path]);
    const created = await model.reveal(path);
    if (created) {
      select(created);
      saveExpanded();
      if (!created.isDir) await openNode(created, false);
    }
  }

  /** Returns an error text when `value` cannot be used for the edited row. */
  function checkName(ed: Editing, value: string): string | null {
    const err = validateName(value, ed.mode === 'create');
    if (err) return err;
    // The folder of a compact row has no siblings in the tree. The file system reports a name clash.
    const siblings = ed.node.chain ? [] : (ed.node.parent?.children ?? []);
    const first = value.split(/[\\/]/)[0].toLowerCase();
    const clash = siblings.some((s) => s !== ed.node && !s.pending && s.name.toLowerCase() === first);
    if (clash && !(ed.mode === 'rename' && first === ed.node.name.toLowerCase())) {
      return `A file or folder named '${value}' already exists here.`;
    }
    return null;
  }

  async function revealActive() {
    const p = pathOfTab(ctx.tabs.active()?.id);
    activePath = p;
    const root = model.root?.path;
    if (!p || !root || !isInside(p, root)) {
      ui?.render(true);
      return;
    }
    const node = await model.reveal(p);
    if (node && p === activePath) {
      selectedPath = node.path;
      saveExpanded();
      ui?.render(true);
      ui?.scrollTo(node);
    }
  }

  // --- Context menu ---------------------------------------------------------

  function revealLabel() {
    return platform === 'macos' ? 'Reveal in Finder' : platform === 'windows' ? 'Reveal in File Explorer' : 'Open Containing Folder';
  }

  function menuFor(n: TreeNode | null): MenuItem[] {
    const isRoot = !n || n === model.root;
    const path = (n ?? model.root)?.path ?? '';
    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
    const items: MenuItem[] = [
      { label: 'New File', run: () => void beginCreate('file') },
      { label: 'New Folder', run: () => void beginCreate('dir') },
    ];
    if (!isRoot) {
      items.push(
        { label: 'Rename', keybinding: 'F2', run: beginRename, separatorBefore: true },
        { label: 'Delete', keybinding: platform === 'macos' ? 'Mod-Backspace' : 'Delete', run: () => void doDelete() },
      );
    }
    items.push(
      { label: 'Copy Path', run: () => copy(path), separatorBefore: true },
      { label: 'Copy Relative Path', run: () => copy(ctx.workspace.relative(path)), disabled: isRoot },
      {
        label: revealLabel(),
        run: () =>
          void import('@tauri-apps/plugin-opener')
            .then((m) => m.revealItemInDir(path))
            .catch((e) => ctx.ui.notify(`Cannot reveal: ${errorText(e)}`, { kind: 'error' })),
      },
    );
    if (n && !n.isDir && ctx.commands.get('git.fileHistory')) {
      items.push({
        label: 'Show Git History',
        run: () => void ctx.commands.execute('git.fileHistory', path).catch((e) => ctx.ui.notify(`Cannot show history: ${errorText(e)}`, { kind: 'error' })),
        separatorBefore: true,
      });
    }
    const diagramCommand = !n || n.isDir ? 'diagram.showForFolder' : /\.(kt|kts|java|swift)$/i.test(n.name) ? 'diagram.showForFile' : null;
    if (diagramCommand && ctx.commands.get(diagramCommand)) {
      items.push({
        label: 'Show Class Diagram',
        run: () => void ctx.commands.execute(diagramCommand, path).catch((e) => ctx.ui.notify(`Cannot show the diagram: ${errorText(e)}`, { kind: 'error' })),
        separatorBefore: !(n && !n.isDir && ctx.commands.get('git.fileHistory')),
      });
    }
    if (!n || n.isDir) {
      items.push(
        {
          label: 'Open in New Workspace Tab',
          run: () => void ctx.window.openFolder(path).catch((e) => ctx.ui.notify(`Cannot open ${path}: ${errorText(e)}`, { kind: 'error' })),
          separatorBefore: true,
        },
        {
          label: 'Open Folder in New Window',
          run: () => void ctx.workspace.open(path, { newWindow: true }),
        },
      );
    }
    return items;
  }

  function pickFolder() {
    return ctx.window.pickFolder().catch((e) => ctx.ui.notify(`Cannot open folder: ${errorText(e)}`, { kind: 'error' }));
  }

  // --- View -----------------------------------------------------------------

  interface ViewUi {
    render(full: boolean): void;
    scrollTo(n: TreeNode): void;
    startEdit(n: TreeNode, mode: 'rename' | 'create'): void;
    finishEdit(): void;
  }

  function mount(host: HTMLElement): ViewInstance {
    const cssRow = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-height'));
    const rowH = cssRow > 0 ? cssRow : 22;

    const title = h('span', { class: 'explorer-title' });
    const button = (ic: IconNode, label: string, run: () => void) => {
      const b = h('button', { class: 'explorer-action', title: label, 'aria-label': label, type: 'button' });
      b.append(icon(ic));
      b.addEventListener('click', run);
      return b;
    };
    const actions = h(
      'div',
      { class: 'explorer-actions' },
      button(FolderOpen, 'Open Folder', () => void pickFolder()),
      button(FilePlus, 'New File', () => void beginCreate('file')),
      button(FolderPlus, 'New Folder', () => void beginCreate('dir')),
      button(RefreshCw, 'Refresh', () => void api.refresh()),
      button(ChevronsDownUp, 'Collapse All', () => api.collapseAll()),
    );
    const header = h('div', { class: 'explorer-header' }, title, actions);
    const spacer = h('div', { class: 'explorer-spacer' });
    const scroll = h('div', { class: 'explorer-scroll', tabindex: '0', role: 'tree' }, spacer);
    const empty = h('div', { class: 'explorer-empty' });
    const root = h('div', { class: 'explorer' }, header, scroll, empty);
    host.append(root);

    const pool = new Map<number, HTMLElement>();
    const nodeOf = new WeakMap<HTMLElement, TreeNode>();
    let editing: Editing | null = null;
    let recentShown = false;

    function fillRow(el: HTMLElement, n: TreeNode, i: number) {
      nodeOf.set(el, n);
      const st = n.pending ? undefined : statusOf(n);
      let cls = 'explorer-row';
      if (n.isDir) cls += ' explorer-dir';
      if (n.path === selectedPath) cls += ' explorer-selected';
      if (n.path === activePath) cls += ' explorer-active-file';
      if (n.ignored) cls += ' explorer-ignored';
      if (st) cls += ` explorer-git-${st}`;
      el.className = cls;
      el.style.top = `${i * rowH}px`;
      el.setAttribute('role', 'treeitem');
      el.setAttribute('aria-level', String(n.depth + 1));
      if (n.isDir) el.setAttribute('aria-expanded', String(n.expanded));
      el.title = n.pending ? '' : n.chain ? n.path : n.rel;
      if (editing?.node === n && editing.input.parentElement) return;
      clear(el);
      el.append(h('span', { class: 'explorer-indent', style: `width:${BASE_PAD_PX + n.depth * INDENT_PX}px` }));
      const twisty = h('span', { class: 'explorer-twisty' });
      if (n.isDir && !n.pending) twisty.append(icon(n.expanded ? ChevronDown : ChevronRight));
      el.append(twisty);
      const ic = h('span', { class: 'explorer-icon' });
      ic.append(fileIcon(n.name, { isDir: n.isDir, open: n.isDir && n.expanded }));
      el.append(ic);
      if (editing?.node === n) {
        el.append(h('span', { class: 'explorer-label' }, editing.input));
      } else {
        const label = h('span', { class: `explorer-label${n.loading ? ' explorer-loading' : ''}` });
        if (n.chain) {
          // Compact row: the names are joined by a dimmed separator.
          const sepChar = n.chainStyle === 'dot' ? '.' : '/';
          n.chain.forEach((part, k) => {
            if (k) label.append(h('span', { class: 'explorer-sep' }, sepChar));
            label.append(part);
          });
        } else {
          label.append(n.name);
        }
        el.append(label);
      }
      if (st) {
        el.append(
          h('span', { class: 'explorer-badge' }, n.isDir ? '●' : STATUS_LETTER[st]),
        );
      }
    }

    function renderEmpty() {
      clear(empty);
      empty.append(h('p', { class: 'explorer-empty-text' }, 'You have not opened a folder.'));
      empty.append(h('button', { class: 'explorer-empty-button', type: 'button', onclick: () => void pickFolder() }, 'Open Folder'));
      if (recentShown) return;
      recentShown = true;
      void ctx.workspace.recent().then((list) => {
        if (model.root || !list.length) return;
        const box = h('div', { class: 'explorer-recent' }, h('div', { class: 'explorer-recent-title' }, 'Recent'));
        for (const r of list.slice(0, 6)) {
          box.append(
            h('button', { class: 'explorer-recent-item', type: 'button', title: r.path, onclick: () => ctx.window.openFolder(r.path).catch((e) => ctx.ui.notify(`Cannot open ${r.path}: ${errorText(e)}`, { kind: 'error' })) }, r.name),
          );
        }
        empty.append(box);
      });
    }

    function render(full: boolean) {
      const rootNode = model.root;
      const hasRoot = !!rootNode;
      scroll.hidden = !hasRoot;
      actions.hidden = !hasRoot;
      empty.hidden = hasRoot;
      title.textContent = (ctx.workspace.name ?? rootNode?.name ?? 'Explorer').toUpperCase();
      if (!hasRoot) {
        recentShown = false;
        if (!empty.childElementCount) renderEmpty();
        for (const el of pool.values()) el.remove();
        pool.clear();
        return;
      }
      if (empty.childElementCount) clear(empty);

      const rows = model.rows;
      spacer.style.height = `${rows.length * rowH}px`;
      const viewH = scroll.clientHeight || 600;
      const start = Math.max(0, Math.floor(scroll.scrollTop / rowH) - OVERSCAN);
      const end = Math.min(rows.length, Math.ceil((scroll.scrollTop + viewH) / rowH) + OVERSCAN);

      const editIndex = editing ? rows.indexOf(editing.node) : -1;
      if (editing && editIndex < 0) {
        // The edited row is gone (for example its folder was collapsed).
        finishEdit();
        return;
      }
      for (const [i, el] of pool) {
        if (i < start || i >= end || i === editIndex) {
          el.remove();
          pool.delete(i);
        }
      }
      for (let i = start; i < end; i++) {
        if (i === editIndex) continue;
        const n = rows[i];
        let el = pool.get(i);
        if (!el) {
          el = h('div');
          pool.set(i, el);
          spacer.append(el);
          fillRow(el, n, i);
        } else if (full || nodeOf.get(el) !== n) {
          fillRow(el, n, i);
        }
      }
      if (editing && editIndex >= 0) {
        fillRow(editing.row, editing.node, editIndex);
        if (editing.row.parentElement !== spacer) spacer.append(editing.row);
      }
    }

    function scrollTo(n: TreeNode) {
      const i = model.rows.indexOf(n);
      if (i < 0) return;
      const top = i * rowH;
      const viewH = scroll.clientHeight;
      if (top < scroll.scrollTop) scroll.scrollTop = top;
      else if (top + rowH > scroll.scrollTop + viewH) scroll.scrollTop = top + rowH - viewH;
      render(false);
    }

    // --- Inline editing ---
    function startEdit(n: TreeNode, mode: 'rename' | 'create') {
      if (editing) finishEdit();
      const input = h('input', {
        class: 'explorer-input',
        type: 'text',
        spellcheck: 'false',
        autocomplete: 'off',
        autocapitalize: 'off',
      });
      input.value = mode === 'rename' ? n.name : '';
      const row = h('div');
      const ed: Editing = { node: n, mode, input, row };
      editing = ed;
      const check = () => {
        const v = input.value;
        const err = v.trim() ? checkName(ed, v.trim()) : null;
        input.classList.toggle('explorer-input-error', !!err);
        input.title = err ?? '';
        return err;
      };
      input.addEventListener('input', check);
      input.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey)) e.stopPropagation();
        // Enter and Escape during IME composition belong to the IME.
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value.trim();
          if (!v || (mode === 'rename' && v === n.name)) return cancelEdit();
          if (!check()) void commitEdit(ed, v);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        }
      });
      input.addEventListener('blur', () => {
        if (editing !== ed || !input.isConnected) return;
        const v = input.value.trim();
        if (!v || (mode === 'rename' && v === n.name) || check()) cancelEdit();
        else void commitEdit(ed, v);
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('dblclick', (e) => e.stopPropagation());
      render(true);
      scrollTo(n);
      input.focus();
      if (mode === 'rename') {
        const dot = n.isDir ? -1 : n.name.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : n.name.length);
      }
    }

    function finishEdit() {
      const ed = editing;
      if (!ed) return;
      editing = null;
      ed.row.remove();
      if (ed.node.pending) model.removePending(ed.node);
      scroll.focus({ preventScroll: true });
      render(true);
    }

    function cancelEdit() {
      finishEdit();
    }

    // --- Events ---
    scroll.addEventListener('scroll', rafThrottle(() => render(false)));
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => render(false)));
    resizeObserver.observe(scroll);

    const nodeFromEvent = (e: Event): TreeNode | null => {
      const row = (e.target as Element).closest<HTMLElement>('.explorer-row');
      return row ? (nodeOf.get(row) ?? null) : null;
    };

    spacer.addEventListener('click', (e) => {
      const n = nodeFromEvent(e);
      if (!n || n.pending) return;
      scroll.focus({ preventScroll: true });
      select(n, false);
      if (n.isDir) {
        if (e.detail <= 1) void toggle(n);
      } else {
        void openNode(n, true);
      }
    });
    spacer.addEventListener('dblclick', (e) => {
      const n = nodeFromEvent(e);
      if (n && !n.isDir && !n.pending) void openNode(n, false);
    });
    scroll.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const n = nodeFromEvent(e);
      if (n && !n.pending) select(n, false);
      ctx.ui.contextMenu(e, menuFor(n));
    });

    scroll.addEventListener('keydown', (e) => {
      if (editing || !model.root) return;
      const rows = model.rows;
      const cur = selectedNode();
      const idx = cur ? rows.indexOf(cur) : -1;
      const go = (i: number) => {
        const n = rows[Math.max(0, Math.min(rows.length - 1, i))];
        if (n) select(n);
      };
      const page = Math.max(1, Math.floor(scroll.clientHeight / rowH) - 1);
      let handled = true;
      switch (e.key) {
        case 'ArrowDown':
          go(idx + 1);
          break;
        case 'ArrowUp':
          go(idx < 0 ? 0 : idx - 1);
          break;
        case 'PageDown':
          go(idx + page);
          break;
        case 'PageUp':
          go(idx - page);
          break;
        case 'Home':
          go(0);
          break;
        case 'End':
          go(rows.length - 1);
          break;
        case 'ArrowRight':
          if (cur?.isDir) {
            if (!cur.expanded) void toggle(cur);
            else if (cur.children?.some((c) => !c.hidden && !c.pending)) go(idx + 1);
          }
          break;
        case 'ArrowLeft':
          if (cur?.isDir && cur.expanded) void toggle(cur);
          else if (cur?.parent && cur.parent !== model.root) select(cur.parent);
          break;
        case 'Enter':
          if (cur?.isDir) void toggle(cur);
          else if (cur) void openNode(cur, false);
          break;
        case 'F2':
          beginRename();
          break;
        case 'Delete':
          void doDelete();
          break;
        case 'Backspace':
          if (e.metaKey || e.ctrlKey) void doDelete();
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    ui = { render, scrollTo, startEdit, finishEdit };
    render(true);
    const dispose = () => {
      resizeObserver.disconnect();
      ui = null;
      teardownUi = null;
      root.remove();
    };
    teardownUi = dispose;
    return {
      onShow: () => render(true),
      focus: () => scroll.focus(),
      dispose,
    };
  }

  // --- Events from the app --------------------------------------------------

  ctx.bus.on('workspace:changed', ({ root }) => {
    selectedPath = null;
    activePath = null;
    decor = new Map();
    dirDecor = new Map();
    // Drop work that belongs to the old folder: a rename box and queued refreshes.
    ui?.finishEdit();
    flushChanges.cancel();
    pendingDirs.clear();
    pendingAll = false;
    void (async () => {
      await model.setRoot(root);
      if (!root) return;
      const saved = ctx.workspace.state.get<string[]>(EXPANDED_KEY);
      if (Array.isArray(saved) && saved.length) await model.restoreExpanded(saved.filter((s) => typeof s === 'string'));
      void revealActive();
    })();
  });

  ctx.bus.on('git:decorations', (e) => {
    if (model.root && e.root !== model.root.path) return;
    setDecorations(e.files);
  });

  /** Reads the tree again from the root and opens the same folders. Compact rows change shape, so the nodes are rebuilt. */
  async function reloadTree() {
    const rootPath = model.root?.path;
    if (!rootPath) return;
    const saved = model.expandedPaths();
    await model.setRoot(rootPath);
    await model.restoreExpanded(saved);
    saveExpanded();
  }

  ctx.bus.on('settings:changed', ({ settings }) => {
    const key = JSON.stringify(settings['files.exclude']);
    const compact = settings['explorer.compactFolders'] !== false;
    const compactChanged = compact !== compactOn;
    if (key === excludeKey && !compactChanged) return;
    excludeKey = key;
    compactOn = compact;
    excluded = createExcludeMatcher(excludeList(settings['files.exclude']));
    // The exclude globs also decide which folders Rust joins, so compact mode needs a new listing.
    if (compactOn || compactChanged) void reloadTree();
    else model.applyExclude();
  });

  const revealSoon = debounce(() => void revealActive(), 30);
  ctx.bus.on('tab:activated', revealSoon);

  // Refresh the folders that changed. Only folders that are loaded matter.
  const pendingDirs = new Set<string>();
  let pendingAll = false;
  const flushChanges = debounce(() => {
    const all = pendingAll;
    const dirs = [...pendingDirs];
    pendingAll = false;
    pendingDirs.clear();
    void (all ? model.refreshAll() : model.refresh(dirs));
  }, 150);
  ctx.bus.on('fs:changed', (e) => {
    if (!model.root) return;
    if (e.rescan) pendingAll = true;
    else {
      for (const p of e.paths) {
        const d = dirname(p);
        if (model.knows(d)) pendingDirs.add(d);
      }
      if (pendingDirs.size > 200) pendingAll = true;
    }
    if (pendingAll || pendingDirs.size) flushChanges();
  });

  // A visible workbench measures its rows again. A hidden one has no size.
  ctx.bus.on('workbench:activated', () => ui?.render(true));

  ctx.bus.on('workbench:disposing', () => {
    flushChanges.cancel();
    revealSoon.cancel();
    pendingDirs.clear();
    pendingAll = false;
    model.onChange = () => {};
    teardownUi?.();
  });

  const api: Explorer = {
    descriptor: () => ({
      id: 'explorer',
      title: 'Explorer',
      icon: () => createElement(Files),
      location: 'sidebar',
      order: 10,
      create: mount,
    }),
    hasSelection: () => !!selectedNode() && selectedNode() !== model.root,
    newFile: () => beginCreate('file'),
    newFolder: () => beginCreate('dir'),
    rename: beginRename,
    delete: doDelete,
    revealActive: async () => {
      ctx.views.show('explorer');
      await revealActive();
    },
    refresh: () => model.refreshAll(),
    collapseAll: () => {
      model.collapseAll();
      saveExpanded();
    },
  };
  return api;
}
