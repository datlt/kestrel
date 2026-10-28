// Reads the `:line` and `:line:column` ending of a query, like `BookService:42:7`.

export interface ParsedQuery {
  /** The query without the line ending, with its spaces (a trailing space means the name ends there). */
  name: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
}

const LINE_RE = /^(.*?):(\d{1,9})(?::(\d{1,9}))?\s*$/;

export function parseLineSuffix(query: string): ParsedQuery {
  const m = LINE_RE.exec(query);
  if (!m) return { name: query };
  const line = Number(m[2]);
  if (!(line >= 1)) return { name: query };
  const column = m[3] !== undefined ? Number(m[3]) : undefined;
  return { name: m[1], line, column: column !== undefined && column >= 1 ? column : undefined };
}
