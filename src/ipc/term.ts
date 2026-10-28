// IPC for terminals. Owner: terminal agent.
// Rust side: src-tauri/src/cmd/term.rs.

import { Channel } from '@tauri-apps/api/core';
import { invoke } from './invoke';

export interface TermSpawnOptions {
  /** Start folder. When it does not exist, Rust uses the home folder. */
  cwd: string;
  cols: number;
  rows: number;
  /** Program (and arguments) to run. Empty or missing: the `terminal.shell` default of Rust. */
  shell?: string;
  /**
   * Setting `terminal.highlightCommands`. When true (the default) and the shell is
   * zsh, Rust starts zsh with the Kestrel ZDOTDIR and the command line colors.
   */
  highlight?: boolean;
}

/** A running shell. */
export interface TermSession {
  id: number;
  /** The program that runs in the terminal. */
  shell: string;
}

/**
 * Turns a channel message into bytes. Tauri sends an `ArrayBuffer`.
 * The dev bridge in the browser sends a base64 string.
 */
export function toBytes(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (Array.isArray(message)) return Uint8Array.from(message as number[]);
  if (typeof message === 'string') {
    const bin = atob(message);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(0);
}

/**
 * Starts a shell. `onData` gets raw output bytes. `onExit` gets the exit code once.
 * Both callbacks can run before this promise resolves.
 */
export async function termSpawn(
  opts: TermSpawnOptions,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number) => void,
): Promise<TermSession> {
  const channel = new Channel<unknown>();
  channel.onmessage = (m) => onData(toBytes(m));
  const events = new Channel<{ kind: string; code?: number }>();
  events.onmessage = (e) => {
    if (e.kind === 'exit') onExit(e.code ?? 0);
  };
  return invoke<TermSession>('term_spawn', {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    shell: opts.shell || null,
    highlight: opts.highlight ?? true,
    channel,
    events,
  });
}

/** Sends typed text to the shell. */
export function termWrite(id: number, data: string): Promise<void> {
  return invoke<void>('term_write', { id, data });
}

export function termResize(id: number, cols: number, rows: number): Promise<void> {
  return invoke<void>('term_resize', { id, cols, rows });
}

/** Stops the shell and its child programs. */
export function termKill(id: number): Promise<void> {
  return invoke<void>('term_kill', { id });
}
