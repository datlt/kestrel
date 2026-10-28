// IPC for the lsp feature. Owner: lsp agent.
// Rust side: src-tauri/src/cmd/lsp.rs.
import { Channel } from '@tauri-apps/api/core';
import { invoke } from './invoke';

/** Events from the server process (not LSP messages). */
export type LspEvent =
  /** New stderr lines. */
  | { kind: 'stderr'; lines: string[] }
  /** The process ended. `stopped` is true when `lspStop` caused it. */
  | { kind: 'exit'; code: number | null; signal: number | null; stopped: boolean };

export interface LspStartOptions {
  serverId: string;
  /** Absolute project root. It is the working folder of the server. */
  root: string;
  /** Program and arguments. The program is searched in the login-shell PATH. */
  command: string[];
  env?: Record<string, string>;
  /** Called for every JSON message from the server (no headers). */
  onMessage: (message: string) => void;
  onEvent: (event: LspEvent) => void;
}

/**
 * Starts a language server. Rejects with code `server_missing` when the
 * program is not installed.
 */
export async function lspStart(opts: LspStartOptions): Promise<{ key: string }> {
  const channel = new Channel<string>();
  channel.onmessage = opts.onMessage;
  const events = new Channel<LspEvent>();
  events.onmessage = opts.onEvent;
  return invoke<{ key: string }>('lsp_start', {
    serverId: opts.serverId,
    root: opts.root,
    command: opts.command,
    env: opts.env ?? {},
    channel,
    events,
  });
}

/** Sends one JSON message to the server. Rust adds the Content-Length header. */
export function lspSend(key: string, message: string): Promise<void> {
  return invoke<void>('lsp_send', { key, message });
}

/** Stops the server (shutdown, exit, kill after about 2 s). */
export function lspStop(key: string): Promise<void> {
  return invoke<void>('lsp_stop', { key });
}

/** The last stderr lines of a server (up to 2000). */
export function lspLogs(key: string): Promise<string[]> {
  return invoke<string[]>('lsp_logs', { key });
}

/** Nearest folder with a marker file, not above `workspaceRoot`. Null when there is none. */
export function lspFindRoot(file: string, markers: string[], workspaceRoot: string): Promise<string | null> {
  return invoke<string | null>('lsp_find_root', { file, markers, workspaceRoot });
}

/** Full path of a program in the login-shell PATH, or null. */
export function lspWhich(program: string): Promise<string | null> {
  return invoke<string | null>('lsp_which', { program });
}

/** Text of lines (0-based) in files. One result list per request. */
export function lspReadLines(requests: { path: string; lines: number[] }[]): Promise<string[][]> {
  return invoke<string[][]>('lsp_read_lines', { requests });
}
