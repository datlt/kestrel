// A recorder for input events of the terminal, to find out what an input method
// really sends. It is OFF by default, because the terminal can receive passwords.
// The user starts it with the command "Terminal: Record Input Events (60 seconds)".
// It keeps the last 400 events in memory, and "Terminal: Copy Input Event Log"
// copies them as plain text, one event per line. Nothing is written to disk.

export const MAX_LOG_EVENTS = 400;
export const RECORD_MS = 60_000;

/** Shows control characters as `\x7f`, `\r`, `\n`, `\t`, `\e`, and quotes the text. */
export function escapeControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (c === 0x1b) out += '\\e';
    else if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

export interface LogEntry {
  /** Milliseconds since the start. */
  t: number;
  text: string;
  /** What the textarea held after the event was handled. */
  after?: string;
}

export class InputLog {
  private entries: LogEntry[] = [];
  private startedAt = 0;
  private _active = false;

  get active(): boolean {
    return this._active;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Starts a new recording. The old log is dropped. */
  start(now: number): void {
    this.entries = [];
    this.startedAt = now;
    this._active = true;
  }

  stop(): void {
    this._active = false;
  }

  /** Adds one line. Does nothing when no recording runs. */
  add(now: number, text: string): LogEntry | null {
    if (!this._active) return null;
    const entry: LogEntry = { t: Math.round(now - this.startedAt), text };
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_EVENTS) this.entries.shift();
    return entry;
  }

  /** The log as text, one event per line. */
  toText(): string {
    return this.entries
      .map((e) => `${String(e.t).padStart(6)} ms  ${e.text}${e.after !== undefined ? `  => ${e.after}` : ''}`)
      .join('\n');
  }
}

/** The one recorder of the window. The terminal that has the focus writes to it. */
export const inputLog = new InputLog();
