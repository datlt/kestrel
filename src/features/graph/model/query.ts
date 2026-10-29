// The search filter of the graph, like the search of Obsidian (docs/DESIGN.md 14.4).
//
//   word         the rel path contains the word (all words must match)
//   "a phrase"   the rel path contains the phrase
//   -term        the term must not match
//   a OR b       one of them matches (`OR` in capital letters)
//   ( ... )      group
//   path:x       the rel path contains x
//   file:x       the file name contains x
//   title:x      the title (or the name when there is no title) contains x
//   tag:x        a tag is x or starts with `x/` (`tag:#api` and `tag:api` are the same)
//   /regex/      the rel path matches the regular expression (also after a key: `file:/^a/`)
//
// Everything is case-insensitive. `compileQuery` never throws.

import type { CompiledQuery, NoteNode } from '../types';

type Test = (n: NoteNode) => boolean;

class QueryError extends Error {}

interface Token {
  t: 'lp' | 'rp' | 'or' | 'not' | 'term';
  key: string | null;
  regex: boolean;
  value: string;
}

const KEYS = ['path', 'file', 'title', 'tag'];
const MAX_DEPTH = 64;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  // Reads a quoted phrase, a /regex/ or a plain word at `i`.
  const readValue = (): { regex: boolean; value: string } => {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new QueryError('Unclosed quote');
      const value = text.slice(i + 1, end);
      i = end + 1;
      return { regex: false, value };
    }
    if (c === '/') {
      let j = i + 1;
      while (j < n && text[j] !== '/') j += text[j] === '\\' ? 2 : 1;
      if (j >= n) throw new QueryError('Unclosed regular expression');
      const value = text.slice(i + 1, j);
      i = j + 1;
      return { regex: true, value };
    }
    let j = i;
    while (j < n && !isSpace(text[j]) && text[j] !== '(' && text[j] !== ')') j++;
    const value = text.slice(i, j);
    i = j;
    return { regex: false, value };
  };

  while (i < n) {
    const c = text[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '(') {
      tokens.push({ t: 'lp', key: null, regex: false, value: '' });
      i++;
    } else if (c === ')') {
      tokens.push({ t: 'rp', key: null, regex: false, value: '' });
      i++;
    } else if (c === '-') {
      const next = text[i + 1];
      if (next !== undefined && !isSpace(next) && next !== ')') tokens.push({ t: 'not', key: null, regex: false, value: '' });
      i++;
    } else if (c === '"' || c === '/') {
      const v = readValue();
      tokens.push({ t: 'term', key: null, ...v });
    } else {
      // A key such as `tag:` only counts when it is one of the known keys.
      const colon = text.indexOf(':', i);
      const prefix = colon > i ? text.slice(i, colon).toLowerCase() : '';
      if (KEYS.includes(prefix)) {
        i = colon + 1;
        const v = readValue();
        tokens.push({ t: 'term', key: prefix, ...v });
      } else {
        const v = readValue();
        if (v.value === 'OR') tokens.push({ t: 'or', key: null, regex: false, value: '' });
        else tokens.push({ t: 'term', key: null, ...v });
      }
    }
  }
  return tokens;
}

// The test functions read lower-case parts of the node. This small cache keeps
// them for the node that is tested right now.
interface Parts {
  node: NoteNode | null;
  rel: string;
  file: string;
  title: string;
}

function makeRegex(source: string): RegExp {
  try {
    return new RegExp(source, 'i');
  } catch {
    throw new QueryError(`Bad regular expression: /${source}/`);
  }
}

function buildTerm(tok: Token, parts: () => Parts): Test | null {
  const value = tok.value.trim().toLowerCase();
  if (!tok.value.trim()) return null;
  const re = tok.regex ? makeRegex(tok.value) : null;
  const match = (s: string): boolean => (re ? re.test(s) : s.includes(value));
  switch (tok.key) {
    case 'file':
      return () => match(parts().file);
    case 'title':
      return () => match(parts().title);
    case 'tag': {
      if (re) return (n) => n.tags.some((t) => re.test(t));
      const wanted = value.replace(/^#+/, '');
      if (!wanted) return null;
      return (n) =>
        n.tags.some((t) => {
          const lower = t.toLowerCase();
          return lower === wanted || lower.startsWith(`${wanted}/`);
        });
    }
    default:
      // `path:` and words without a key.
      return () => match(parts().rel);
  }
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private tokens: Token[],
    private parts: () => Parts,
  ) {}

  parse(): Test | null {
    const t = this.parseOr();
    if (this.pos < this.tokens.length) throw new QueryError('Unexpected )');
    return t;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): Test | null {
    const parts: Test[] = [];
    const first = this.parseAnd();
    if (first) parts.push(first);
    while (this.peek()?.t === 'or') {
      this.pos++;
      const next = this.parseAnd();
      if (next) parts.push(next);
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return (n) => parts.some((p) => p(n));
  }

  private parseAnd(): Test | null {
    const items: Test[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.t === 'or' || tok.t === 'rp') break;
      const u = this.parseUnary();
      if (u) items.push(u);
    }
    if (items.length === 0) return null;
    if (items.length === 1) return items[0];
    return (n) => items.every((p) => p(n));
  }

  private parseUnary(): Test | null {
    const tok = this.tokens[this.pos++];
    if (tok.t === 'not') {
      const inner = this.peek() && this.peek()!.t !== 'rp' && this.peek()!.t !== 'or' ? this.parseUnary() : null;
      return inner ? (n) => !inner(n) : null;
    }
    if (tok.t === 'lp') {
      if (++this.depth > MAX_DEPTH) throw new QueryError('Too many nested parentheses');
      const inner = this.parseOr();
      this.depth--;
      if (this.peek()?.t !== 'rp') throw new QueryError('Missing )');
      this.pos++;
      return inner;
    }
    return buildTerm(tok, this.parts);
  }
}

/** Compiles the search filter. Never throws: a broken query sets `error` and matches everything. */
export function compileQuery(text: string): CompiledQuery {
  const all = (): boolean => true;
  try {
    const cache: Parts = { node: null, rel: '', file: '', title: '' };
    const parts = (): Parts => cache;
    const tokens = tokenize(String(text ?? ''));
    const test = new Parser(tokens, parts).parse();
    if (!test) return { empty: true, error: null, test: all };
    return {
      empty: false,
      error: null,
      test(node: NoteNode): boolean {
        if (cache.node !== node) {
          cache.node = node;
          cache.rel = node.rel.toLowerCase();
          const slash = cache.rel.lastIndexOf('/');
          cache.file = slash < 0 ? cache.rel : cache.rel.slice(slash + 1);
          cache.title = (node.title ?? node.name).toLowerCase();
        }
        return test(node);
      },
    };
  } catch (e) {
    const error = e instanceof QueryError ? e.message : 'Bad query';
    return { empty: false, error, test: all };
  }
}
