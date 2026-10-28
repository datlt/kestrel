// Arguments of the hidden command `terminal.run`. Pure code, so tests can run it.
//
//   ctx.commands.execute('terminal.run', { command: 'npm test', title: 'Tests', cwd: '/path' })
//
// The command opens a new terminal tab and runs `command` in it. A plain string is
// the same as `{ command: string }`.

export interface RunArgs {
  /** The line to run. Kestrel sends it to the shell and presses Enter. */
  command: string;
  /** Name of the new tab. Empty or missing: the shell sets the name. */
  title?: string;
  /** Folder for the shell. Empty or missing: the workspace folder. */
  cwd?: string;
}

export type ParsedRun = { ok: true; value: RunArgs } | { ok: false; error: string };

/** Checks the arguments of `terminal.run`. Extra fields are ignored. */
export function parseRunArgs(arg: unknown): ParsedRun {
  const input = typeof arg === 'string' ? { command: arg } : arg;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'terminal.run needs { command: string, title?: string, cwd?: string }' };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.command !== 'string' || !o.command.trim()) {
    return { ok: false, error: 'terminal.run needs a "command" text' };
  }
  for (const key of ['title', 'cwd'] as const) {
    if (o[key] !== undefined && o[key] !== null && typeof o[key] !== 'string') {
      return { ok: false, error: `terminal.run: "${key}" must be a text` };
    }
  }
  const value: RunArgs = { command: o.command.replace(/[\r\n]+$/, '') };
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const cwd = typeof o.cwd === 'string' ? o.cwd.trim() : '';
  if (title) value.title = title;
  if (cwd) value.cwd = cwd;
  return { ok: true, value };
}

/** How long to wait for the shell, in milliseconds. */
export const READY_MAX_MS = 1000;
/** After the first output, the shell is ready when no more output comes for this long. */
export const READY_QUIET_MS = 100;

/**
 * Decides when to send the command to a new shell: after the first output (the
 * prompt) and a short quiet time, but at the latest `READY_MAX_MS` after the start.
 * Returns the wait in milliseconds from `now`, or 0 for "send now".
 * `firstOutputAt` and `lastOutputAt` are null while no output has come.
 */
export function readyDelay(startedAt: number, firstOutputAt: number | null, lastOutputAt: number | null, now: number): number {
  const deadline = startedAt + READY_MAX_MS;
  if (firstOutputAt === null || lastOutputAt === null) return Math.max(0, deadline - now);
  const quiet = lastOutputAt + READY_QUIET_MS;
  return Math.max(0, Math.min(quiet, deadline) - now);
}
