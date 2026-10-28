// Small entries for the tabs of the database feature. Each heavy screen
// (console, connection form, DDL) loads with `import()` when its tab is shown.

import type { TabInput } from '../../core/types';
import type { DbObjectKind } from '../../ipc/db';
import type { DbHub } from './hub';
import { isIdeaId } from './idea-model';

// --- SQL console -------------------------------------------------------------------

export interface ConsoleSpec {
  connId: string;
  /** The connection of the first console tab id. The picker can change `connId` later; the tab id stays. */
  idConn?: string;
  n: number;
  /** Name of the connection, kept so a restored tab has a title before the IntelliJ list is read. */
  connName?: string;
  /** Text of the editor. */
  text?: string;
  database?: string | null;
  /** Run the text as soon as the console opens (Select Top 100). */
  autoRun?: boolean;
}

export const consoleTabId = (connId: string, n: number) => `sqlconsole:${connId}:${n}`;

export function consoleTitle(connName: string, n: number): string {
  return n === 1 ? connName : `${connName} #${n}`;
}

export function consoleTabInput(hub: DbHub, spec: ConsoleSpec): TabInput {
  const name = hub.find(spec.connId)?.name ?? spec.connName ?? 'Console';
  // The tab keeps this spec, so a restored tab gets the text back.
  let current: () => unknown = () => ({
    connId: spec.connId,
    idConn: spec.idConn ?? spec.connId,
    connName: spec.connName,
    n: spec.n,
    text: spec.text ?? '',
    database: spec.database ?? null,
  });
  return {
    id: consoleTabId(spec.idConn ?? spec.connId, spec.n),
    kind: 'sql-console',
    title: consoleTitle(name, spec.n),
    tooltip: 'SQL console',
    async create(host) {
      const { ConsoleContent } = await import('./console');
      const content = new ConsoleContent(hub, spec, host);
      current = () => content.serializeState();
      return content;
    },
    serialize: () => current(),
  };
}

export function restoreConsoleTab(hub: DbHub, data: unknown): TabInput | null {
  const d = data as Partial<ConsoleSpec> | null;
  if (!d || typeof d.connId !== 'string' || typeof d.n !== 'number') return null;
  // An IntelliJ connection is found later, when the list of the folder is read.
  if (!hub.find(d.connId) && !isIdeaId(d.connId)) return null;
  return consoleTabInput(hub, {
    connId: d.connId,
    idConn: typeof d.idConn === 'string' ? d.idConn : d.connId,
    connName: typeof d.connName === 'string' ? d.connName : undefined,
    n: d.n,
    text: typeof d.text === 'string' ? d.text : '',
    database: typeof d.database === 'string' ? d.database : null,
  });
}

/** Opens a console on the lowest free number for this connection. */
export function openConsole(hub: DbHub, spec: Omit<ConsoleSpec, 'n'>): void {
  let n = 1;
  while (hub.ctx.tabs.get(consoleTabId(spec.connId, n))) n++;
  hub.ctx.tabs.open(consoleTabInput(hub, { ...spec, n }));
}

// --- Connection form ------------------------------------------------------------------

export const connTabId = (id: string) => `dbconn:${id}`;

export function connTabInput(hub: DbHub, id: string): TabInput {
  const existing = hub.find(id);
  return {
    id: connTabId(id),
    kind: 'db-connection',
    title: existing ? `Connection: ${existing.name}` : 'New Connection',
    tooltip: 'Database connection',
    async create(host) {
      const { ConnectionForm } = await import('./conn-form');
      return new ConnectionForm(hub, id, host);
    },
    serialize: () => ({ id }),
  };
}

export function restoreConnTab(hub: DbHub, data: unknown): TabInput | null {
  const d = data as { id?: unknown } | null;
  return d && typeof d.id === 'string' ? connTabInput(hub, d.id) : null;
}

// --- DDL ----------------------------------------------------------------------------------

export interface DdlSpec {
  connId: string;
  database: string;
  name: string;
  kind: DbObjectKind;
}

export const ddlTabId = (s: Pick<DdlSpec, 'connId' | 'database' | 'name'>) => `ddl:${s.connId}:${s.database}.${s.name}`;

export function ddlTabInput(hub: DbHub, spec: DdlSpec): TabInput {
  return {
    id: ddlTabId(spec),
    kind: 'db-ddl',
    title: spec.name,
    description: spec.database,
    tooltip: `${spec.kind} ${spec.database}.${spec.name}`,
    async create(host) {
      const { DdlContent } = await import('./ddl');
      return new DdlContent(hub, spec, host);
    },
    serialize: () => spec,
  };
}

export function restoreDdlTab(hub: DbHub, data: unknown): TabInput | null {
  const d = data as Partial<DdlSpec> | null;
  if (!d || typeof d.connId !== 'string' || typeof d.database !== 'string' || typeof d.name !== 'string' || typeof d.kind !== 'string') return null;
  return ddlTabInput(hub, d as DdlSpec);
}
