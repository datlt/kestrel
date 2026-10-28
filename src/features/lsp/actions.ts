// Features that are not in the library, or that we do in our own way:
// find references (quick pick), rename (also in files that are not open), workspace symbols.
import { LSPPlugin, type LSPClient } from '@codemirror/lsp-client';
import type { EditorView } from '@codemirror/view';
import type { AppContext, QuickPickItem } from '../../core/types';
import { lspReadLines } from '../../ipc/lsp';
import { uriToPath } from './uri';
import type { KestrelWorkspace } from './workspace';

interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}
interface Location {
  uri: string;
  range: Range;
}
interface TextEdit {
  range: Range;
  newText: string;
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

interface LocationItem extends QuickPickItem {
  path: string;
  line: number;
  column: number;
}

const MAX_REFERENCES = 3000;

export async function findReferences(view: EditorView, ctx: AppContext): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const { client } = plugin;
  client.sync();
  let locations: Location[] | null;
  try {
    locations = await client.request<unknown, Location[] | null>('textDocument/references', {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(view.state.selection.main.head),
      context: { includeDeclaration: true },
    });
  } catch (e) {
    ctx.ui.notify(`Find references failed: ${errorText(e)}`, { kind: 'error' });
    return;
  }
  if (!locations || locations.length === 0) {
    ctx.ui.notify('No references found.');
    return;
  }
  const workspace = client.workspace as KestrelWorkspace;
  const found = locations
    .slice(0, MAX_REFERENCES)
    .map((loc) => ({ loc, path: uriToPath(loc.uri) }))
    .filter((x): x is { loc: Location; path: string } => x.path !== null)
    .sort((a, b) => a.path.localeCompare(b.path) || a.loc.range.start.line - b.loc.range.start.line);

  // Text of each line: from the open editor when the file is open, else from disk.
  const texts: string[] = new Array(found.length).fill('');
  const fromDisk = new Map<string, number[]>();
  found.forEach((f, i) => {
    const open = workspace.getFile(f.loc.uri);
    const doc = open ? (open.getView()?.state.doc ?? open.doc) : null;
    const line = f.loc.range.start.line + 1;
    if (doc) texts[i] = line <= doc.lines ? doc.line(line).text.trim() : '';
    else fromDisk.set(f.path, [...(fromDisk.get(f.path) ?? []), f.loc.range.start.line]);
  });
  if (fromDisk.size) {
    const requests = [...fromDisk.entries()].map(([path, lines]) => ({ path, lines }));
    try {
      const result = await lspReadLines(requests);
      const byPath = new Map<string, Map<number, string>>();
      requests.forEach((r, i) => byPath.set(r.path, new Map(r.lines.map((l, j) => [l, result[i]?.[j] ?? '']))));
      found.forEach((f, i) => {
        const text = byPath.get(f.path)?.get(f.loc.range.start.line);
        if (text !== undefined) texts[i] = text;
      });
    } catch {
      // The list still works without the line text.
    }
  }

  const items: LocationItem[] = found.map((f, i) => ({
    id: String(i),
    label: texts[i] || '(empty line)',
    description: `${ctx.workspace.relative(f.path)}:${f.loc.range.start.line + 1}`,
    path: f.path,
    line: f.loc.range.start.line + 1,
    column: f.loc.range.start.character + 1,
  }));
  ctx.ui.quickPick<LocationItem>({
    placeholder: `${items.length} reference${items.length === 1 ? '' : 's'}. Type to filter.`,
    items,
    onAccept: (item) => void ctx.editors.openFile(item.path, { line: item.line, column: item.column }),
  });
}

/**
 * The references of the name at a position (1-based line and column, UTF-16 units),
 * with the declaration. The Usages panel calls this through `lsp.referencesAt`.
 * Errors are thrown. The caller decides what to do.
 */
export async function referencesAt(view: EditorView, line: number, column: number): Promise<Location[] | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const doc = view.state.doc;
  const text = doc.line(Math.min(Math.max(line, 1), doc.lines));
  const pos = Math.min(text.from + Math.max(column - 1, 0), text.to);
  const { client } = plugin;
  client.sync();
  const locations = await client.request<unknown, Location[] | null>('textDocument/references', {
    textDocument: { uri: plugin.uri },
    position: plugin.toPosition(pos),
    context: { includeDeclaration: true },
  });
  return locations ?? [];
}

/** An LSP `CallHierarchyItem`. We keep it as the server sent it and send it back for the next level. */
export interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  [key: string]: unknown;
}

export interface IncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface IncomingCallsResult {
  item: CallHierarchyItem;
  calls: IncomingCall[];
}

/**
 * Callers of a method. Pass `item` for a deeper level, or a position
 * (`view` plus 1-based line and column) for the root.
 * Returns null when the server has no call hierarchy or finds no method at the position.
 */
export async function incomingCalls(
  client: LSPClient,
  target: { item: CallHierarchyItem } | { view: EditorView; line: number; column: number },
): Promise<IncomingCallsResult | null> {
  if (!client.serverCapabilities?.callHierarchyProvider) return null;
  client.sync();
  let item: CallHierarchyItem | undefined;
  if ('item' in target) {
    item = target.item;
  } else {
    const plugin = LSPPlugin.get(target.view);
    if (!plugin) return null;
    const doc = target.view.state.doc;
    const text = doc.line(Math.min(Math.max(target.line, 1), doc.lines));
    const pos = Math.min(text.from + Math.max(target.column - 1, 0), text.to);
    const items = await client.request<unknown, CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(pos),
    });
    item = items?.[0];
  }
  if (!item) return null;
  const calls = await client.request<unknown, IncomingCall[] | null>('callHierarchy/incomingCalls', { item });
  return { item, calls: calls ?? [] };
}

interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string }; edits: TextEdit[] } | { kind: string })[];
}

function collectEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => out.set(uri, [...(out.get(uri) ?? []), ...edits]);
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const dc of edit.documentChanges ?? []) {
    if ('textDocument' in dc) add(dc.textDocument.uri, dc.edits.filter((e) => 'range' in e));
  }
  return out;
}

export async function renameSymbol(view: EditorView, ctx: AppContext): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const word = view.state.wordAt(view.state.selection.main.head);
  if (!word) {
    ctx.ui.notify('Put the cursor on a name to rename it.');
    return;
  }
  const oldName = view.state.sliceDoc(word.from, word.to);
  const newName = await ctx.ui.prompt({
    title: 'Rename symbol',
    value: oldName,
    selection: [0, oldName.length],
    validate: (v) => (v.trim() ? null : 'Enter a name.'),
  });
  if (!newName || newName === oldName) return;

  const { client } = plugin;
  client.sync();
  const workspace = client.workspace as KestrelWorkspace;
  try {
    let files = 0;
    await client.withMapping(async (mapping) => {
      const edit = await client.request<unknown, WorkspaceEdit | null>('textDocument/rename', {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(word.from),
        newName: newName.trim(),
      });
      if (!edit) return;
      for (const [uri, edits] of collectEdits(edit)) {
        if (edits.length === 0) continue;
        const file = await workspace.requestFile(uri);
        const target = file?.getView();
        const targetPlugin = target && LSPPlugin.get(target);
        if (!file || !target || !targetPlugin) continue;
        // For files that were open before the request, positions follow later typing.
        // Files that we just opened have no mapping: their text is still the text on disk.
        const toOffset = (p: Position): number => {
          try {
            return mapping.mapPosition(file.uri, p);
          } catch {
            return targetPlugin.fromPosition(p);
          }
        };
        target.dispatch({
          changes: edits.map((e) => ({ from: toOffset(e.range.start), to: toOffset(e.range.end), insert: e.newText })),
          userEvent: 'rename',
        });
        files++;
      }
    });
    if (files > 1) ctx.ui.notify(`Renamed in ${files} files. The changed files are not saved yet.`);
  } catch (e) {
    ctx.ui.notify(`Rename failed: ${errorText(e)}`, { kind: 'error' });
  }
}

const SYMBOL_KINDS = [
  '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum',
  'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null',
  'Enum member', 'Struct', 'Event', 'Operator', 'Type parameter',
];

interface SymbolItem extends QuickPickItem {
  path: string;
  line: number;
  column: number;
}

interface SymbolResult {
  name: string;
  kind: number;
  containerName?: string;
  location: { uri: string; range?: Range };
}

export function workspaceSymbols(client: LSPClient, ctx: AppContext): void {
  ctx.ui.quickPick<SymbolItem>({
    placeholder: 'Type the name of a class, function or other symbol',
    emptyText: 'No symbols found.',
    items: async (query, signal) => {
      if (!query.trim()) return [];
      let result: SymbolResult[] | null;
      try {
        client.sync();
        result = await client.request<unknown, SymbolResult[] | null>('workspace/symbol', { query });
      } catch (e) {
        if (!signal.aborted) ctx.ui.notify(`Symbol search failed: ${errorText(e)}`, { kind: 'error' });
        return [];
      }
      if (signal.aborted || !result) return [];
      const items: SymbolItem[] = [];
      for (const s of result.slice(0, 300)) {
        const path = uriToPath(s.location.uri);
        if (!path) continue;
        const line = (s.location.range?.start.line ?? 0) + 1;
        items.push({
          id: String(items.length),
          label: s.name,
          description: s.containerName || undefined,
          detail: `${ctx.workspace.relative(path)}:${line}`,
          hint: SYMBOL_KINDS[s.kind] || undefined,
          path,
          line,
          column: (s.location.range?.start.character ?? 0) + 1,
        });
      }
      return items;
    },
    onAccept: (item) => void ctx.editors.openFile(item.path, { line: item.line, column: item.column }),
  });
}
