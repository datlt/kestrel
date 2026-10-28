// Options of a class diagram, their defaults, and the request that Rust gets.
// Pure code: no DOM and no Tauri here, so it is easy to test.

import type { DiagramRequest, DiagramScope, RelationKind } from '../../ipc/code';
import { ALL_RELATIONS } from '../../ipc/code';

export type MembersMode = 'none' | 'public' | 'all';
export type LayoutDirection = 'TB' | 'LR';
export type WalkDirection = 'out' | 'in' | 'both';

export interface DiagramOptions {
  /** The relation kinds to follow and to show, in the order of `ALL_RELATIONS`. */
  relations: RelationKind[];
  /** 0 to 5. */
  depth: number;
  /** `out`: supertypes and parts. `in`: subtypes and users. */
  direction: WalkDirection;
  members: MembersMode;
  /** Show types that are not in the project (JDK, libraries). */
  external: boolean;
  layout: LayoutDirection;
}

export const DEFAULT_OPTIONS: Readonly<DiagramOptions> = {
  relations: ['extends', 'implements', 'composition', 'aggregation'],
  depth: 1,
  direction: 'both',
  members: 'public',
  external: false,
  layout: 'TB',
};

/** Stop after this many nodes. The layout must stay under 300 ms for 150 nodes. */
export const MAX_NODES = 150;
/** A type with more neighbors than this in one direction is a hub (Rust does not follow it). */
export const DEFAULT_FAN = 20;
/** "Show more" on a hub node. */
export const SHOW_MORE_FAN = 500;
export const SHOW_MORE_MAX_NODES = 200;
/** Ask before adding more than this many types. */
export const SHOW_MORE_CONFIRM_ABOVE = 100;
export const MAX_DEPTH = 5;
export const OPTIONS_KEY = 'diagram.options';

export function copyOptions(o: DiagramOptions): DiagramOptions {
  return { ...o, relations: [...o.relations] };
}

/** Reads saved options (from settings or a restored tab). Bad or missing values get the default. */
export function normalizeOptions(raw: unknown): DiagramOptions {
  const d = DEFAULT_OPTIONS;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const relations = Array.isArray(o.relations)
    ? ALL_RELATIONS.filter((k) => (o.relations as unknown[]).includes(k))
    : [...d.relations];
  const depth = typeof o.depth === 'number' && Number.isFinite(o.depth) ? Math.min(MAX_DEPTH, Math.max(0, Math.round(o.depth))) : d.depth;
  return {
    relations,
    depth,
    direction: o.direction === 'out' || o.direction === 'in' || o.direction === 'both' ? o.direction : d.direction,
    members: o.members === 'none' || o.members === 'public' || o.members === 'all' ? o.members : d.members,
    external: typeof o.external === 'boolean' ? o.external : d.external,
    layout: o.layout === 'TB' || o.layout === 'LR' ? o.layout : d.layout,
  };
}

/** The same options with one relation kind switched on or off. */
export function toggleRelation(o: DiagramOptions, kind: RelationKind): DiagramOptions {
  const on = o.relations.includes(kind);
  const relations = ALL_RELATIONS.filter((k) => (k === kind ? !on : o.relations.includes(k)));
  return { ...o, relations };
}

export function buildRequest(root: string, scope: DiagramScope, o: DiagramOptions, maxNodes = MAX_NODES, maxFan = DEFAULT_FAN): DiagramRequest {
  return {
    root,
    scope,
    relations: ALL_RELATIONS.filter((k) => o.relations.includes(k)),
    depth: o.depth,
    direction: o.direction,
    includeExternal: o.external,
    maxNodes,
    maxFan,
  };
}

/**
 * True when Rust must answer again. A change of members or layout direction
 * only needs a new layout of the data we already have.
 */
export function needsNewRequest(a: DiagramOptions, b: DiagramOptions): boolean {
  return (
    a.depth !== b.depth ||
    a.direction !== b.direction ||
    a.external !== b.external ||
    a.relations.length !== b.relations.length ||
    a.relations.some((k, i) => k !== b.relations[i])
  );
}

/** The scope without the editor text (the text must not be saved in the session). */
export function scopeForSession(scope: DiagramScope): DiagramScope {
  if (scope.kind === 'cursor') return { kind: 'cursor', path: scope.path, line: scope.line, column: scope.column };
  if (scope.kind === 'file') return { kind: 'file', path: scope.path };
  if (scope.kind === 'types') return { kind: 'types', ids: [...scope.ids] };
  return { ...scope };
}

/** Checks a scope read from a saved session. */
export function normalizeScope(raw: unknown): DiagramScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (s.kind === 'cursor' && str(s.path) && num(s.line) && num(s.column)) {
    return { kind: 'cursor', path: s.path, line: s.line, column: s.column };
  }
  if (s.kind === 'file' && str(s.path)) return { kind: 'file', path: s.path };
  if (s.kind === 'folder' && str(s.path)) return { kind: 'folder', path: s.path };
  if (s.kind === 'types' && Array.isArray(s.ids) && s.ids.every((i) => typeof i === 'string')) {
    return { kind: 'types', ids: s.ids as string[] };
  }
  return null;
}

export const DIRECTION_LABELS: Record<WalkDirection, string> = {
  out: 'Supertypes and parts',
  in: 'Subtypes and users',
  both: 'Both',
};

export const MEMBERS_LABELS: Record<MembersMode, string> = { none: 'None', public: 'Public', all: 'All' };

export const RELATION_LABELS: Record<RelationKind, string> = {
  extends: 'Extends',
  implements: 'Implements',
  composition: 'Composition',
  aggregation: 'Aggregation',
  dependency: 'Dependency',
  nested: 'Nested',
};

export const RELATION_HINTS: Record<RelationKind, string> = {
  extends: 'Class extends class (hollow triangle)',
  implements: 'Class implements interface or protocol (dashed, hollow triangle)',
  composition: 'Field holds one part (filled diamond at the owner)',
  aggregation: 'Field holds many parts (hollow diamond at the owner)',
  dependency: 'Uses a type in parameters, results or code (dashed, open arrow)',
  nested: 'Nested type (circle with a plus at the outer type)',
};
