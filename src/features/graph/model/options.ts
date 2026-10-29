// Options, folder state and scope: defaults, checks and clamping.
// Values come from storage or from the session, so every field is checked.

import type { ColorBy, ColorGroup, FolderState, GraphLayout, GraphOptions, GraphScope } from '../types';
import { lastSegment } from './util';

/** `globalState` key: the last used options. */
export const OPTIONS_KEY = 'graph.options';
/** `workspace.state` key: the collapsed and hidden folders of this project. */
export const FOLDERS_KEY = 'graph.folders';

export const DEFAULT_OPTIONS: GraphOptions = {
  layout: 'force',
  query: '',
  showTags: false,
  showAttachments: false,
  existingOnly: false,
  showOrphans: true,
  showFolders: true,
  folderOutlines: true,
  folderPull: 0.3,
  colorBy: 'folder',
  colorDepth: 1,
  groups: [],
  arrows: false,
  labelBy: 'name',
  textFade: 0,
  nodeSize: 1,
  linkThickness: 1,
  bundling: 0.85,
  centerForce: 0.5,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250,
  depth: 1,
  incoming: true,
  outgoing: true,
  neighborLinks: true,
};

const MAX_GROUPS = 50;
const MAX_QUERY = 2000;
const MAX_FOLDERS = 20000;

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

function num(v: unknown, def: number, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  const c = Math.min(max, Math.max(min, v));
  return integer ? Math.round(c) : c;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

function str(v: unknown, def: string, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : def;
}

/** `#rgb` or `#rrggbb` gives `#rrggbb` in lower case. Anything else gives null. */
function hexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

function normalizeGroups(v: unknown): ColorGroup[] {
  if (!Array.isArray(v)) return [];
  const out: ColorGroup[] = [];
  for (const g of v) {
    if (out.length >= MAX_GROUPS) break;
    if (!g || typeof g !== 'object') continue;
    const color = hexColor((g as Record<string, unknown>).color);
    if (!color) continue;
    out.push({ query: str((g as Record<string, unknown>).query, '', MAX_QUERY), color });
  }
  return out;
}

/** Checks and fills a value from storage. Unknown or bad fields get the default. Never throws. */
export function normalizeOptions(v: unknown): GraphOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_OPTIONS;
  return {
    layout: oneOf<GraphLayout>(o.layout, ['force', 'radial', 'tree'], d.layout),
    query: str(o.query, d.query, MAX_QUERY),
    showTags: bool(o.showTags, d.showTags),
    showAttachments: bool(o.showAttachments, d.showAttachments),
    existingOnly: bool(o.existingOnly, d.existingOnly),
    showOrphans: bool(o.showOrphans, d.showOrphans),
    showFolders: bool(o.showFolders, d.showFolders),
    folderOutlines: bool(o.folderOutlines, d.folderOutlines),
    folderPull: num(o.folderPull, d.folderPull, 0, 1),
    colorBy: oneOf<ColorBy>(o.colorBy, ['folder', 'tag', 'none'], d.colorBy),
    colorDepth: num(o.colorDepth, d.colorDepth, 1, 4, true),
    groups: normalizeGroups(o.groups),
    arrows: bool(o.arrows, d.arrows),
    labelBy: oneOf(o.labelBy, ['name', 'title'] as const, d.labelBy),
    textFade: num(o.textFade, d.textFade, -3, 3),
    nodeSize: num(o.nodeSize, d.nodeSize, 0.2, 3),
    linkThickness: num(o.linkThickness, d.linkThickness, 0.2, 3),
    bundling: num(o.bundling, d.bundling, 0, 1),
    centerForce: num(o.centerForce, d.centerForce, 0, 1),
    repelForce: num(o.repelForce, d.repelForce, 0, 20),
    linkForce: num(o.linkForce, d.linkForce, 0, 1),
    linkDistance: num(o.linkDistance, d.linkDistance, 30, 500),
    depth: num(o.depth, d.depth, 1, 5, true),
    incoming: bool(o.incoming, d.incoming),
    outgoing: bool(o.outgoing, d.outgoing),
    neighborLinks: bool(o.neighborLinks, d.neighborLinks),
  };
}

function folderList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    // The root (`''`) cannot be collapsed or hidden.
    const rel = item.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (rel) seen.add(rel);
    if (seen.size >= MAX_FOLDERS) break;
  }
  return [...seen];
}

/** Keeps only strings, without duplicates and without the root. Never throws. */
export function normalizeFolderState(v: unknown): FolderState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { collapsed: folderList(o.collapsed), hidden: folderList(o.hidden) };
}

/** Null when the value is not a scope. */
export function normalizeScope(v: unknown): GraphScope | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (s.kind === 'project') return { kind: 'project' };
  if (s.kind === 'folder') {
    return typeof s.path === 'string' && s.path !== '' ? { kind: 'folder', path: s.path } : null;
  }
  if (s.kind === 'local') {
    return { kind: 'local', path: typeof s.path === 'string' && s.path !== '' ? s.path : null, follow: s.follow === true };
  }
  return null;
}

/** Tab title: "Graph", "Graph: docs", "Local Graph: Auth". */
export function graphTitle(scope: GraphScope, root: string | null): string {
  if (scope.kind === 'folder') {
    const name = lastSegment(scope.path) || (root ? lastSegment(root) : '');
    return name ? `Graph: ${name}` : 'Graph';
  }
  if (scope.kind === 'local') {
    const name = scope.path ? lastSegment(scope.path).replace(/\.(md|markdown|mdx)$/i, '') : '';
    return name ? `Local Graph: ${name}` : 'Local Graph';
  }
  return 'Graph';
}
