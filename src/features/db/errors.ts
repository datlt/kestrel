// Reads errors that come from the Rust side (see src/ipc/db.ts for the codes).
// No DOM code, so tests can import it.

export type DbErrorKind = 'server' | 'connect' | 'busy' | 'lost' | 'cancelled' | 'other';

export interface DbErrorInfo {
  kind: DbErrorKind;
  /** MySQL error number for `server` errors (for example 1146). */
  number: number | null;
  sqlstate: string | null;
  /** Message to show. For server errors the "<number> (<sqlstate>): " prefix stays. */
  text: string;
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
}

const SERVER_PREFIX = /^(\d+) \(([0-9A-Za-z]{5})\): /;

export function describeError(e: unknown): DbErrorInfo {
  const err = (e && typeof e === 'object' ? e : {}) as ErrorLike;
  const code = typeof err.code === 'string' ? err.code : '';
  const text = typeof err.message === 'string' ? err.message : e instanceof Error ? e.message : String(e);
  switch (code) {
    case 'db_error': {
      const m = SERVER_PREFIX.exec(text);
      return { kind: 'server', number: m ? Number(m[1]) : null, sqlstate: m ? m[2] : null, text };
    }
    case 'db_connect':
      return { kind: 'connect', number: null, sqlstate: null, text };
    case 'db_busy':
      return { kind: 'busy', number: null, sqlstate: null, text };
    case 'db_lost':
      return { kind: 'lost', number: null, sqlstate: null, text };
    case 'cancelled':
      return { kind: 'cancelled', number: null, sqlstate: null, text };
    default:
      return { kind: 'other', number: null, sqlstate: null, text };
  }
}

/** The server refused the user name or the password (MySQL error 1045, or a text that says so). */
export function isAuthError(e: unknown): boolean {
  const info = describeError(e);
  if (info.kind !== 'connect' && info.kind !== 'server') return false;
  return info.number === 1045 || /\b1045\b/.test(info.text) || /access denied/i.test(info.text);
}
