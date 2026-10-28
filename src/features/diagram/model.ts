// Pure helpers for the diagram data: stereotypes, member lines, search,
// merging results, hidden nodes and keyboard moves. No DOM here.

import type { DiagramEdge, DiagramMember, DiagramNode, DiagramResult, TypeKind, Visibility } from '../../ipc/code';
import type { MembersMode } from './options';

// --- Names and stereotypes ---------------------------------------------------

const KIND_STEREOTYPE: Partial<Record<TypeKind, string>> = {
  interface: 'interface',
  enum: 'enum',
  record: 'record',
  annotation: 'annotation',
  object: 'object',
  struct: 'struct',
  protocol: 'protocol',
  actor: 'actor',
  extension: 'extension',
  typeAlias: 'typealias',
};

/** Modifiers that name a kind of class, in the order we prefer them. */
const CLASS_MODIFIER_STEREOTYPES = ['abstract', 'data', 'sealed', 'value'];

/** Annotation text as a short name: `@jp.x.Service("a")` becomes `Service`. */
export function annotationName(a: string): string {
  let s = a.trim();
  if (s.startsWith('@')) s = s.slice(1);
  const paren = s.indexOf('(');
  if (paren >= 0) s = s.slice(0, paren);
  const colon = s.indexOf(':'); // Kotlin use-site target, like `field:Inject`
  if (colon >= 0) s = s.slice(colon + 1);
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  return s.trim();
}

/** The stereotype text of the type kind (and modifiers), without the guillemets. `null` for a plain class. */
export function kindStereotype(node: Pick<DiagramNode, 'kind' | 'modifiers'>): string | null {
  const byKind = KIND_STEREOTYPE[node.kind];
  if (byKind) return byKind;
  for (const m of CLASS_MODIFIER_STEREOTYPES) if (node.modifiers.includes(m)) return m;
  return null;
}

/** Lines above the name: the kind first, then at most 2 annotations. Each line has the guillemets. */
export function stereotypeLines(node: Pick<DiagramNode, 'kind' | 'modifiers' | 'annotations'>, maxAnnotations = 2): string[] {
  const out: string[] = [];
  const k = kindStereotype(node);
  if (k) out.push(`«${k}»`);
  const seen = new Set<string>();
  for (const a of node.annotations) {
    const n = annotationName(a);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (seen.size > maxAnnotations) break;
    out.push(`«${n}»`);
  }
  return out;
}

/** `<T, R>` or an empty text. */
export function typeParamsText(node: Pick<DiagramNode, 'typeParams'>): string {
  return node.typeParams.length ? `<${node.typeParams.join(', ')}>` : '';
}

/** The name with type parameters, for lists and the tab title. */
export function displayName(node: Pick<DiagramNode, 'name' | 'typeParams'>): string {
  return node.name + typeParamsText(node);
}

export function langLabel(lang: DiagramNode['lang']): string | null {
  return lang === 'kotlin' ? 'Kt' : lang === 'java' ? 'Java' : lang === 'swift' ? 'Swift' : null;
}

// --- Members -----------------------------------------------------------------

export function visibilityMark(v: Visibility): string {
  switch (v) {
    case 'public':
      return '+';
    case 'private':
      return '-';
    case 'protected':
      return '#';
    default:
      return '~'; // internal and package
  }
}

/**
 * Is the member shown in the "Public" mode? Swift code is `internal` by
 * default, so Swift keeps `internal` members too.
 */
export function isPublicMember(m: DiagramMember, lang: DiagramNode['lang']): boolean {
  if (m.visibility === 'public') return true;
  return lang === 'swift' && m.visibility === 'internal';
}

export interface MemberLists {
  fields: DiagramMember[];
  methods: DiagramMember[];
}

export function visibleMembers(node: DiagramNode, mode: MembersMode): MemberLists {
  if (mode === 'none') return { fields: [], methods: [] };
  if (mode === 'all') return { fields: node.fields, methods: node.methods };
  return {
    fields: node.fields.filter((m) => isPublicMember(m, node.lang)),
    methods: node.methods.filter((m) => isPublicMember(m, node.lang)),
  };
}

/** One text row for a member, in UML style: `+ name(params): Type`. */
export function memberLine(m: DiagramMember, maxChars = 64): string {
  let text: string;
  if (m.kind === 'method' || m.kind === 'constructor') {
    text = `${m.name}(${m.params})`;
    if (m.type) text += `: ${m.type}`;
  } else if (m.kind === 'enumCase') {
    text = m.params ? `${m.name}(${m.params})` : m.name;
  } else {
    text = m.type ? `${m.name}: ${m.type}` : m.name;
  }
  text = `${visibilityMark(m.visibility)} ${text.replace(/\s+/g, ' ')}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// --- Search ------------------------------------------------------------------

/** Capital letters of a name: `FooServiceImpl` gives `FSI`. */
function initials(name: string): string {
  let out = '';
  for (const c of name) if (c >= 'A' && c <= 'Z') out += c;
  return out;
}

/** Score of one node for a query. 0 means no match. Higher is better. */
export function matchScore(node: Pick<DiagramNode, 'name' | 'id' | 'container'>, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = node.name.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80 - Math.min(20, name.length - q.length);
  if (initials(node.name).toLowerCase().startsWith(q) && q.length >= 2) return 60;
  if (name.includes(q)) return 50;
  if (`${node.container}.${node.name}`.toLowerCase().includes(q)) return 30;
  return 0;
}

/** Nodes that match the query, best first. Equal scores keep the order of `nodes`. */
export function searchNodes<T extends Pick<DiagramNode, 'name' | 'id' | 'container'>>(nodes: readonly T[], query: string): T[] {
  const scored: { n: T; s: number; i: number }[] = [];
  nodes.forEach((n, i) => {
    const s = matchScore(n, query);
    if (s > 0) scored.push({ n, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.n);
}

// --- Graph helpers -----------------------------------------------------------

export function edgeKey(e: Pick<DiagramEdge, 'from' | 'to' | 'kind'>): string {
  return `${e.from}\u0000${e.to}\u0000${e.kind}`;
}

/** Joins two results of one diagram (used by "Add Supertypes" and "Add Subtypes"). `base` wins for equal ids. */
export function mergeResults(
  base: DiagramResult,
  extra: DiagramResult,
  maxNodes: number,
  /** The node that the user expanded, and the direction. Its hidden count is lowered by the nodes that came in. */
  expanded?: { id: string; direction: 'in' | 'out' },
): DiagramResult {
  const nodes = [...base.nodes];
  const ids = new Set(nodes.map((n) => n.id));
  let truncated = base.truncated || extra.truncated;
  for (const n of extra.nodes) {
    if (ids.has(n.id)) continue;
    if (nodes.length >= maxNodes) {
      truncated = true;
      continue;
    }
    ids.add(n.id);
    nodes.push(n);
  }
  const keys = new Set<string>();
  const edges: DiagramEdge[] = [];
  for (const e of [...base.edges, ...extra.edges]) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const k = edgeKey(e);
    if (keys.has(k)) continue;
    keys.add(k);
    edges.push(e);
  }
  if (expanded) {
    const baseIds = new Set(base.nodes.map((n) => n.id));
    const fresh = new Set<string>();
    for (const e of edges) {
      const other = expanded.direction === 'in' ? (e.to === expanded.id ? e.from : null) : e.from === expanded.id ? e.to : null;
      if (other && !baseIds.has(other)) fresh.add(other);
    }
    const idx = nodes.findIndex((n) => n.id === expanded.id);
    if (idx >= 0) {
      const key = expanded.direction === 'in' ? 'hiddenIn' : 'hiddenOut';
      const left = Math.max(0, (nodes[idx][key] ?? 0) - fresh.size);
      const copy = { ...nodes[idx] };
      if (left > 0) copy[key] = left;
      else delete copy[key];
      nodes[idx] = copy;
    }
  }
  return { nodes, edges, focus: base.focus.filter((id) => ids.has(id)), truncated, index: extra.index };
}

/** The result without hidden nodes and the edges of those nodes. */
export function withoutHidden(result: DiagramResult, hidden: ReadonlySet<string>): DiagramResult {
  if (hidden.size === 0) return result;
  const nodes = result.nodes.filter((n) => !hidden.has(n.id));
  const edges = result.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to));
  return { ...result, nodes, edges, focus: result.focus.filter((id) => !hidden.has(id)) };
}

/** For each node id, the ids of nodes joined by an edge (both directions). */
export function neighborMap(edges: readonly DiagramEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let s = map.get(a);
    if (!s) map.set(a, (s = new Set()));
    s.add(b);
  };
  for (const e of edges) {
    if (e.from === e.to) continue;
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return map;
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
export interface Point {
  x: number;
  y: number;
}

/**
 * The neighbor to select after an arrow key. It takes the candidate whose
 * direction is closest to the arrow, within 60 degrees. Returns null when no
 * neighbor lies that way.
 */
export function pickNeighbor(from: Point, candidates: readonly { id: string; x: number; y: number }[], key: ArrowKey): string | null {
  const dir = key === 'ArrowUp' ? { x: 0, y: -1 } : key === 'ArrowDown' ? { x: 0, y: 1 } : key === 'ArrowLeft' ? { x: -1, y: 0 } : { x: 1, y: 0 };
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const cos = (dx * dir.x + dy * dir.y) / len;
    if (cos < 0.5) continue;
    // A closer neighbor wins when the angles are alike.
    const score = cos - len / 10000;
    if (score > bestScore) {
      bestScore = score;
      best = c.id;
    }
  }
  return best;
}

// --- Tab title ---------------------------------------------------------------

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Title of the diagram tab: the start type, or the file or folder name when
 * the scope is a file or a folder.
 */
export function tabTitle(scope: { kind: string; path?: string }, focusNodes: readonly Pick<DiagramNode, 'name'>[]): string {
  if (scope.kind === 'file' || scope.kind === 'folder') return baseName(scope.path ?? '') || 'Class Diagram';
  if (focusNodes.length === 0) return scope.path ? baseName(scope.path) : 'Class Diagram';
  if (focusNodes.length === 1) return focusNodes[0].name;
  if (focusNodes.length === 2) return `${focusNodes[0].name}, ${focusNodes[1].name}`;
  return `${focusNodes[0].name} +${focusNodes.length - 1}`;
}

/** The scope that keeps exactly these nodes (external types cannot be start types). */
export function scopeOfNodes(nodes: readonly Pick<DiagramNode, 'id' | 'external'>[]): { kind: 'types'; ids: string[] } {
  return { kind: 'types', ids: nodes.filter((n) => !n.external).map((n) => n.id) };
}
