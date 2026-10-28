// The tree of the Database view as plain data. No DOM code, so tests can
// import it. The view keeps the nodes and calls `flatten` to get the rows
// that are visible. Only those rows get DOM elements.

import type { DbColumnInfo, DbConnectionConfig, DbIdeaDataSource, DbIndexInfo, DbObject, DbObjectKind, DbObjects } from '../../ipc/db';

/** `idea-group` is the header row "IntelliJ: <folder>" above the IntelliJ connections. */
export type NodeKind = 'idea-group' | 'connection' | 'database' | 'group' | 'object' | 'column' | 'index';

export type LoadState = 'idle' | 'loading' | 'error';

/** State of an IntelliJ connection row. It is set when the connection is opened. */
export type ConnState = 'connecting' | 'connected' | 'error';

/** What an IntelliJ connection row needs besides its config. */
export type IdeaInfo = Pick<DbIdeaDataSource, 'supported' | 'reason' | 'passwordSource'>;

export interface TreeNode {
  /** Unique in the tree. Also used to keep the open state when the tree is rebuilt. */
  id: string;
  kind: NodeKind;
  label: string;
  /** Grey text after the label (type, row estimate, ...). */
  detail?: string;
  connId: string;
  database?: string;
  /** `object` nodes: what it is. `group` nodes: the kind of its children. */
  objectKind?: DbObjectKind;
  /** `object` and `column` nodes: table (or routine, trigger) name. */
  name?: string;
  /** Column and index rows: small badges, for example `PK`. */
  tags?: string[];
  /** `connection` nodes only. */
  config?: DbConnectionConfig;
  /** IntelliJ `connection` nodes only. */
  idea?: IdeaInfo;
  /** IntelliJ `connection` nodes only: what the last connect did. */
  conn?: ConnState;
  /** null: cannot have children. undefined: not loaded yet. */
  children?: TreeNode[] | null;
  expanded: boolean;
  state: LoadState;
  error?: string;
}

export type Row =
  | { type: 'node'; node: TreeNode; depth: number }
  | { type: 'loading'; depth: number; parent: TreeNode }
  | { type: 'error'; depth: number; parent: TreeNode; message: string }
  | { type: 'empty'; depth: number; parent: TreeNode };

/** Nodes that can show a chevron. */
export function expandable(n: TreeNode): boolean {
  if (n.children === null) return false;
  if (n.kind === 'column' || n.kind === 'index') return false;
  if (n.kind === 'object') return n.objectKind === 'table' || n.objectKind === 'view';
  return true;
}

export function flatten(roots: readonly TreeNode[]): Row[] {
  const rows: Row[] = [];
  const walk = (n: TreeNode, depth: number) => {
    rows.push({ type: 'node', node: n, depth });
    if (!n.expanded || !expandable(n)) return;
    if (n.state === 'loading') {
      rows.push({ type: 'loading', depth: depth + 1, parent: n });
    } else if (n.state === 'error') {
      rows.push({ type: 'error', depth: depth + 1, parent: n, message: n.error ?? 'Error' });
    } else if (n.children) {
      if (n.children.length === 0) rows.push({ type: 'empty', depth: depth + 1, parent: n });
      for (const c of n.children) walk(c, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

const SYSTEM_SCHEMAS = new Set(['mysql', 'sys', 'information_schema', 'performance_schema']);

export function isSystemSchema(name: string): boolean {
  return SYSTEM_SCHEMAS.has(name.toLowerCase());
}

export function visibleDatabases(names: readonly string[], showSystem: boolean): string[] {
  return showSystem ? [...names] : names.filter((n) => !isSystemSchema(n));
}

function base(partial: Partial<TreeNode> & Pick<TreeNode, 'id' | 'kind' | 'label' | 'connId'>): TreeNode {
  return { expanded: false, state: 'idle', ...partial };
}

export function connectionNode(config: DbConnectionConfig, idea?: IdeaInfo): TreeNode {
  return base({
    id: `c:${config.id}`,
    kind: 'connection',
    label: config.name,
    detail: idea && !idea.supported ? (idea.reason ?? undefined) : `${config.host}:${config.port}`,
    connId: config.id,
    config,
    idea,
    // A source that Kestrel cannot use has nothing to open.
    children: idea && !idea.supported ? null : undefined,
  });
}

/** The header row of the IntelliJ group. `error` is the text when the files cannot be read. */
export function ideaGroupNode(label: string, children: TreeNode[], error: string | null): TreeNode {
  return base({
    id: 'i:group',
    kind: 'idea-group',
    label,
    connId: '',
    children,
    expanded: true,
    state: error ? 'error' : 'idle',
    error: error ?? undefined,
  });
}

export function databaseNodes(connId: string, names: readonly string[]): TreeNode[] {
  return names.map((name) => base({ id: `d:${connId}/${name}`, kind: 'database', label: name, connId, database: name }));
}

export const GROUPS: { key: keyof DbObjects; kind: DbObjectKind; title: string }[] = [
  { key: 'tables', kind: 'table', title: 'Tables' },
  { key: 'views', kind: 'view', title: 'Views' },
  { key: 'procedures', kind: 'procedure', title: 'Procedures' },
  { key: 'functions', kind: 'function', title: 'Functions' },
  { key: 'triggers', kind: 'trigger', title: 'Triggers' },
];

function objectDetail(o: DbObject): string | undefined {
  if (o.kind === 'table' && o.rowsEstimate != null) return `~${o.rowsEstimate.toLocaleString('en-US')}`;
  if (o.kind === 'trigger' && o.detail) return `on ${o.detail}`;
  return undefined;
}

export function objectNode(connId: string, database: string, o: DbObject): TreeNode {
  const hasColumns = o.kind === 'table' || o.kind === 'view';
  return base({
    id: `o:${connId}/${database}/${o.kind}/${o.name}`,
    kind: 'object',
    label: o.name,
    detail: objectDetail(o),
    connId,
    database,
    objectKind: o.kind,
    name: o.name,
    children: hasColumns ? undefined : null,
  });
}

/** The five groups of a database. A group with no objects has no chevron. */
export function groupNodes(connId: string, database: string, objects: DbObjects): TreeNode[] {
  return GROUPS.map((g) => {
    const list = objects[g.key];
    return base({
      id: `g:${connId}/${database}/${g.kind}`,
      kind: 'group',
      label: `${g.title} (${list.length})`,
      connId,
      database,
      objectKind: g.kind,
      children: list.length === 0 ? null : list.map((o) => objectNode(connId, database, o)),
    });
  });
}

/** Columns, then indexes, of a table or view. */
export function tableChildren(
  connId: string,
  database: string,
  table: string,
  columns: readonly DbColumnInfo[],
  indexes: readonly DbIndexInfo[],
): TreeNode[] {
  const out: TreeNode[] = columns.map((c) =>
    base({
      id: `col:${connId}/${database}/${table}/${c.name}`,
      kind: 'column',
      label: c.name,
      detail: c.type + (c.nullable ? '' : ' NOT NULL'),
      tags: c.key ? [c.key] : undefined,
      connId,
      database,
      name: c.name,
      children: null,
    }),
  );
  for (const ix of indexes) {
    out.push(
      base({
        id: `idx:${connId}/${database}/${table}/${ix.name}`,
        kind: 'index',
        label: ix.name,
        detail: `${ix.columns.join(', ')}${ix.type && ix.type !== 'BTREE' ? ` (${ix.type})` : ''}`,
        tags: ix.unique ? ['UNIQUE'] : undefined,
        connId,
        database,
        name: ix.name,
        children: null,
      }),
    );
  }
  return out;
}

/** Closes and clears the whole tree below a node (for Refresh). */
export function reset(n: TreeNode): void {
  if (n.children === null) return;
  n.children = undefined;
  n.state = 'idle';
  n.error = undefined;
}

/** All nodes with `expanded` set, found by id, so a rebuilt tree can keep them open. */
export function collectOpen(roots: readonly TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (n: TreeNode) => {
    if (n.expanded) ids.add(n.id);
    n.children?.forEach(walk);
  };
  roots.forEach(walk);
  return ids;
}

/** SQL for "Select Top 100". */
export function selectTopSql(database: string, table: string, limit = 100): string {
  const q = (s: string) => '`' + s.replace(/`/g, '``') + '`';
  return `SELECT * FROM ${q(database)}.${q(table)} LIMIT ${limit};`;
}
