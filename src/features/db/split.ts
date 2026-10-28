// Splits SQL text into statements, finds the statement at a cursor position
// and tells what kind of statement it is. No DOM code, so tests can import it.
//
// The splitter knows about:
// - quotes '...' and "..." (backslash escapes and doubled quotes)
// - backticks `...` (doubled backticks)
// - comments: `-- ` (a space, tab or line end must follow), `#` and /* ... */
// - MySQL executable comments (/*! ... */), which count as code
// - lines such as `DELIMITER $$` that change the statement end marker

export interface Stmt {
  /** The statement text, without leading comments and without the delimiter. */
  text: string;
  /** Offset of the first character of `text` in the source. */
  from: number;
  /** Offset after the last character of `text`. */
  to: number;
  /** Offset after the delimiter (or the end of the source). */
  end: number;
}

const DELIMITER_LINE = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i;

/** Skips a quoted text that starts at `i`. Returns the offset after the closing quote. */
function skipQuoted(src: string, i: number, backslash: boolean): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (backslash && c === '\\') {
      j += 2;
    } else if (c === q) {
      if (src[j + 1] === q) j += 2;
      else return j + 1;
    } else {
      j++;
    }
  }
  return src.length;
}

function lineCommentAt(src: string, i: number): boolean {
  if (src[i] === '#') return true;
  if (src[i] === '-' && src[i + 1] === '-') {
    const next = src[i + 2];
    return next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r';
  }
  return false;
}

function skipLine(src: string, i: number): number {
  const nl = src.indexOf('\n', i);
  return nl < 0 ? src.length : nl + 1;
}

export function splitStatements(src: string): Stmt[] {
  const out: Stmt[] = [];
  let delimiter = ';';
  let i = 0;
  let hasCode = false;
  let first = 0;
  let last = 0;
  const n = src.length;

  const code = (from: number, to: number) => {
    if (!hasCode) {
      hasCode = true;
      first = from;
    }
    last = to;
  };
  const finish = (end: number) => {
    if (hasCode) out.push({ text: src.slice(first, last), from: first, to: last, end });
    hasCode = false;
  };

  while (i < n) {
    const c = src[i];
    // A DELIMITER line is only a command when no statement text is pending.
    if (!hasCode && (i === 0 || src[i - 1] === '\n')) {
      const m = DELIMITER_LINE.exec(src.slice(i, i + 200));
      if (m) {
        delimiter = m[1];
        i += m[0].length;
        continue;
      }
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (src.startsWith(delimiter, i)) {
      i += delimiter.length;
      finish(i);
    } else if (c === "'" || c === '"') {
      const j = skipQuoted(src, i, true);
      code(i, j);
      i = j;
    } else if (c === '`') {
      const j = skipQuoted(src, i, false);
      code(i, j);
      i = j;
    } else if (lineCommentAt(src, i)) {
      i = skipLine(src, i);
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const j = close < 0 ? n : close + 2;
      if (src[i + 2] === '!') code(i, j);
      i = j;
    } else {
      code(i, i + 1);
      i++;
    }
  }
  finish(n);
  return out;
}

/**
 * The statement the cursor is in or next to. The cursor may stand right after
 * the delimiter. In the gap between two statements the previous one wins.
 * Returns null when the text has no statement.
 */
export function statementAt(src: string, pos: number): Stmt | null {
  const list = splitStatements(src);
  if (list.length === 0) return null;
  for (const s of list) {
    if (s.from <= pos && pos <= s.end) return s;
  }
  let before: Stmt | null = null;
  for (const s of list) if (s.end < pos) before = s;
  return before ?? list[0];
}

// --- Statement kinds -------------------------------------------------------

export type StmtKind =
  /** SELECT, SHOW, DESCRIBE, EXPLAIN: does not change data. */
  | 'read'
  /** Changes data or schema, or we do not know. */
  | 'write'
  /** USE, SET, BEGIN, COMMIT...: changes only the session. */
  | 'session'
  | 'empty';

export interface StmtInfo {
  kind: StmtKind;
  /** First keyword in upper case ('' when empty). For WITH it is the verb after the CTE list. */
  verb: string;
  /** UPDATE or DELETE without a WHERE clause. */
  noWhere: boolean;
}

interface Word {
  word: string;
  depth: number;
}

/** Keywords of the statement outside quotes and comments, with their bracket depth. */
function words(sql: string): Word[] {
  const out: Word[] = [];
  let depth = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"') i = skipQuoted(sql, i, true);
    else if (c === '`') i = skipQuoted(sql, i, false);
    else if (lineCommentAt(sql, i)) i = skipLine(sql, i);
    else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      // `t.select` and `@select` are names, not keywords.
      const prev = i > 0 ? sql[i - 1] : '';
      if (prev !== '.' && prev !== '@' && prev !== '$') out.push({ word: sql.slice(i, j).toUpperCase(), depth });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

const READ_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES']);
const SESSION_VERBS = new Set(['USE', 'SET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const DML_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

export function classify(sql: string): StmtInfo {
  const ws = words(sql);
  if (ws.length === 0) {
    // Text such as `/*!40101 SET x */` has code but no keyword we can read: treat it as a write.
    return { kind: sql.trim() === '' ? 'empty' : 'write', verb: '', noWhere: false };
  }
  const top = ws.filter((w) => w.depth === 0);
  let verb = top[0]?.word ?? '';
  if (verb === 'WITH') {
    verb = top.find((w) => DML_VERBS.has(w.word))?.word ?? 'WITH';
  } else if (verb === 'EXPLAIN' && top[1]?.word === 'ANALYZE') {
    // EXPLAIN ANALYZE runs the statement.
    const inner = top.find((w, i) => i > 1 && DML_VERBS.has(w.word));
    if (inner && inner.word !== 'SELECT') verb = inner.word;
  }
  const noWhere = (verb === 'UPDATE' || verb === 'DELETE') && !top.some((w) => w.word === 'WHERE');
  let kind: StmtKind = 'write';
  if (READ_VERBS.has(verb)) kind = 'read';
  else if (SESSION_VERBS.has(verb)) kind = 'session';
  return { kind, verb, noWhere };
}

/** Text of a statement on one line, cut to `max` characters. For messages and tabs. */
export function oneLine(sql: string, max = 80): string {
  const t = sql.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** 1-based line number of an offset. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}
