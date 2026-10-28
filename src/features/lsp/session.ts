// A session is one language server process for one (server id, project root).
import type { LSPClient } from '@codemirror/lsp-client';
import type { LspServerConfig } from '../../core/types';
import { IpcTransport } from './transport';

export type SessionState = 'starting' | 'ready' | 'error' | 'stopped';

export const MAX_LOG_LINES = 2000;

export class Session {
  state: SessionState = 'starting';
  /** Text for the user when `state` is `error`. */
  message = '';
  /** True when the program was not found. */
  missing = false;
  /** Key of the running process in Rust. */
  key: string | null = null;
  /** Counts starts. Events of an older process carry an older number and are ignored. */
  generation = 0;
  logs: string[] = [];
  /** Set right after creation by the runtime (it needs the lazy library). */
  client!: LSPClient;
  readonly transport: IpcTransport;

  constructor(
    readonly id: string,
    readonly serverId: string,
    readonly root: string,
    public config: LspServerConfig,
    onSendError: (session: Session, error: unknown) => void,
  ) {
    this.transport = new IpcTransport((e) => onSendError(this, e));
  }

  addLogs(lines: string[]): void {
    this.logs.push(...lines);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
  }

  get program(): string {
    return this.config.command[0] ?? this.serverId;
  }
}
