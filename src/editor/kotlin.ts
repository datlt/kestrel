// Kotlin tokenizer for CodeMirror (a StreamLanguage).
//
// It reads one line at a time. The state keeps what must cross lines:
// block comments (they can nest), strings, raw strings and open brackets.
// Token names are Lezer tag names, so the shared theme colors apply.

import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import { docTagTag, interpolationTag } from './tags';

type Stream = Parameters<NonNullable<StreamParser<unknown>['token']>>[0];

type Mode = 'code' | 'string' | 'raw' | 'comment' | 'doc';
type FrameKind = '(' | '[' | '{' | '$' | '$raw';
/** What the last token was. Some rules (`get`, `.5`, `<`) depend on it. */
type Prev = 'none' | 'ident' | 'dot' | 'op' | 'close' | 'lit' | 'kw' | 'string';
/** The next name belongs to a declaration. */
type Decl = 'none' | 'fun' | 'class' | 'val' | 'destruct' | 'import';

interface Frame {
  kind: FrameKind;
  /** Indent of the line where the bracket opened. */
  indent: number;
}

export interface KotlinState {
  mode: Mode;
  /** Nesting depth of block comments. */
  comment: number;
  stack: Frame[];
  parens: number;
  /** Open `<` of type arguments. */
  angle: number;
  prev: Prev;
  decl: Decl;
}

const CONTROL = new Set([
  'if', 'else', 'when', 'for', 'while', 'do', 'return', 'break', 'continue', 'throw', 'try', 'catch', 'finally',
]);
const DEFINITION = new Set(['class', 'interface', 'object', 'fun', 'val', 'var', 'typealias']);
const OPERATOR_WORDS = new Set(['as', 'is', 'in']);
const MODULE = new Set(['package', 'import']);
// Words that can only be a modifier when a declaration follows.
const MODIFIERS = new Set([
  'abstract', 'actual', 'annotation', 'companion', 'const', 'crossinline', 'data', 'enum', 'expect', 'external',
  'final', 'infix', 'inline', 'inner', 'internal', 'lateinit', 'noinline', 'open', 'operator', 'out', 'override',
  'private', 'protected', 'public', 'reified', 'sealed', 'suspend', 'tailrec', 'vararg', 'value',
]);
const PARAM_MODIFIERS = new Set(['vararg', 'noinline', 'crossinline']);
const OTHER_KEYWORDS = new Set(['by', 'where', 'typeof']);
const JUMPS = new Set(['return', 'break', 'continue', 'this', 'super']);

const IDENT = /^(?:[\p{L}_][\p{L}\p{N}_]*|`[^`\n]+`)/u;
const DECL_AFTER_MODIFIER = new RegExp(
  '^\\s+(?:@|(?:' + [...MODIFIERS, 'class', 'interface', 'object', 'fun', 'val', 'var', 'typealias', 'constructor', 'init', 'get', 'set'].join('|') + ')\\b)',
);
const PARAM_AFTER_MODIFIER = /^\s+[\p{L}_`][\p{L}\p{N}_`]*\s*:/u;
const GENERIC_ARGS = /^<[\p{L}\p{N}_.,<>?*\s-]+>/u;

function startState(): KotlinState {
  return { mode: 'code', comment: 0, stack: [], parens: 0, angle: 0, prev: 'none', decl: 'none' };
}

function copyState(s: KotlinState): KotlinState {
  return { ...s, stack: s.stack.slice() };
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** `MAX_SIZE`, `ID`: at least two letters, all upper case. */
function isConstantName(word: string): boolean {
  return word.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(word) && /[A-Z]{2}/.test(word.replace(/[0-9_]/g, ''));
}

function rest(stream: Stream): string {
  return stream.string.slice(stream.pos);
}

// --- Comments ---------------------------------------------------------------

function blockComment(stream: Stream, state: KotlinState): string {
  const doc = state.mode === 'doc';
  const start = stream.pos;
  while (!stream.eol()) {
    if (stream.match('*/')) {
      state.comment--;
      if (state.comment <= 0) {
        state.comment = 0;
        state.mode = 'code';
        return doc ? 'docComment' : 'blockComment';
      }
      continue;
    }
    if (stream.match('/*')) {
      state.comment++;
      continue;
    }
    if (doc && stream.peek() === '@') {
      const before = stream.string[stream.pos - 1];
      const tagStart = stream.pos === 0 || before === ' ' || before === '\t' || before === '*';
      if (tagStart && /^@\w/.test(rest(stream))) {
        if (stream.pos > start) return 'docComment';
        stream.match(/^@\w+/);
        return 'docTag';
      }
    }
    stream.next();
  }
  return doc ? 'docComment' : 'blockComment';
}

// --- Strings ------------------------------------------------------------------

function stringToken(stream: Stream, state: KotlinState, raw: boolean): string {
  const ch = stream.peek();
  if (!raw && ch === '"') {
    stream.next();
    state.mode = 'code';
    state.prev = 'string';
    return 'string';
  }
  if (raw && stream.match('"""')) {
    while (stream.eat('"'));
    state.mode = 'code';
    state.prev = 'string';
    return 'string';
  }
  if (!raw && ch === '\\') {
    stream.next();
    if (stream.eat('u')) stream.match(/^[0-9a-fA-F]{1,4}/);
    else stream.next();
    return 'escape';
  }
  if (ch === '$') {
    if (stream.match('${')) {
      state.stack.push({ kind: raw ? '$raw' : '$', indent: 0 });
      state.mode = 'code';
      state.prev = 'none';
      return 'interpolation';
    }
    if (stream.match(/^\$[\p{L}_][\p{L}\p{N}_]*/u)) return 'interpolation';
    stream.next();
    return 'string';
  }
  while (!stream.eol()) {
    const c = stream.peek();
    if (c === '$' || (!raw && (c === '"' || c === '\\'))) break;
    if (raw && c === '"' && stream.match('"""', false)) break;
    stream.next();
  }
  return 'string';
}

// --- Identifiers and keywords ---------------------------------------------------

function wordToken(stream: Stream, state: KotlinState): string {
  const word = stream.current();
  const next = stream.peek();
  const after = rest(stream);
  const nonSpace = after.replace(/^\s+/, '');
  const prev = state.prev;
  const afterDot = prev === 'dot';
  const decl = state.decl;
  const bare = word.startsWith('`') ? word.slice(1, -1) : word;
  const cap = isUpper(bare[0] ?? '');

  state.prev = 'ident';

  // Label definition: `loop@ for (...)`.
  if (next === '@' && !afterDot && !JUMPS.has(word)) {
    stream.next();
    return 'labelName';
  }

  // Names in `import a.b.C` and `package a.b`.
  if (decl === 'import') {
    if (word === 'as') {
      state.prev = 'kw';
      return 'operatorKeyword';
    }
    return cap ? 'typeName' : 'namespace';
  }

  // Member after `.`, `?.` or `::`.
  if (afterDot) {
    if (decl === 'fun' && next === '(') {
      state.decl = 'none';
      return 'variableName.function.definition';
    }
    if (decl === 'val') {
      state.decl = 'none';
      return 'variableName.definition';
    }
    if (word === 'class') {
      state.prev = 'kw';
      return 'keyword';
    }
    if (next === '(') return cap ? 'className' : 'variableName.function';
    if (!cap && /^\{/.test(nonSpace)) return 'variableName.function';
    if (isConstantName(bare)) return 'variableName.constant';
    return cap ? 'typeName' : 'propertyName';
  }

  // The name that a declaration introduces.
  if (decl === 'class' && !OTHER_KEYWORDS.has(word) && !DEFINITION.has(word) && !MODIFIERS.has(word)) {
    state.decl = 'none';
    return 'className.definition';
  }
  if (decl === 'val' && !/^[.<]/.test(nonSpace)) {
    state.decl = 'none';
    return 'variableName.definition';
  }
  if (decl === 'destruct') return 'variableName.definition';
  if (decl === 'fun' && state.angle === 0 && !DEFINITION.has(word)) {
    if (nonSpace.startsWith('(')) {
      state.decl = 'none';
      return 'variableName.function.definition';
    }
    // Receiver type or type parameter: the name comes later.
    return cap ? 'typeName' : 'variableName';
  }

  // Hard keywords.
  if (MODULE.has(word)) {
    state.prev = 'kw';
    state.decl = 'import';
    return 'moduleKeyword';
  }
  if (DEFINITION.has(word)) {
    state.prev = 'kw';
    state.decl = word === 'fun' ? 'fun' : word === 'val' || word === 'var' ? 'val' : 'class';
    return 'definitionKeyword';
  }
  if (CONTROL.has(word)) {
    state.prev = 'kw';
    return 'controlKeyword';
  }
  if (OPERATOR_WORDS.has(word)) {
    state.prev = 'kw';
    return 'operatorKeyword';
  }
  if (word === 'true' || word === 'false') return 'bool';
  if (word === 'null') return 'null';
  if (word === 'this' || word === 'super') {
    state.prev = 'kw';
    return 'self';
  }
  if (OTHER_KEYWORDS.has(word)) {
    state.prev = 'kw';
    return 'keyword';
  }

  // Soft keywords: only keywords in the right place.
  if (word === 'init' && /^\{/.test(nonSpace)) return 'keyword';
  if (word === 'constructor' && /^\(/.test(nonSpace)) return 'keyword';
  if ((word === 'get' || word === 'set') && state.parens === 0 && /^\(|^$/.test(nonSpace) && prev !== 'op' && prev !== 'kw') {
    return 'keyword';
  }
  if (MODIFIERS.has(word)) {
    const inTypeArgs = state.angle > 0 && (word === 'out' || word === 'reified');
    const isModifier =
      inTypeArgs ||
      DECL_AFTER_MODIFIER.test(after) ||
      (word === 'suspend' && /^\s*\(/.test(after)) ||
      (PARAM_MODIFIERS.has(word) && PARAM_AFTER_MODIFIER.test(after));
    if (isModifier) return 'modifier';
  }
  if (word === 'it') return 'variableName.special';

  // Parameter name: `name: Type` inside parentheses.
  if (state.parens > 0 && /^:(?!:)/.test(nonSpace)) return 'variableName.definition';

  if (next === '(') return cap ? 'className' : 'variableName.function';
  if (isConstantName(bare)) return 'variableName.constant';
  return cap ? 'typeName' : 'variableName';
}

// --- Code -----------------------------------------------------------------------

function codeToken(stream: Stream, state: KotlinState): string | null {
  const ch = stream.peek()!;

  if (stream.sol() && stream.match('#!')) {
    stream.skipToEnd();
    return 'lineComment';
  }
  if (stream.match('//')) {
    stream.skipToEnd();
    return 'lineComment';
  }
  if (stream.match('/*')) {
    state.comment = 1;
    state.mode = stream.peek() === '*' && stream.string[stream.pos + 1] !== '/' ? 'doc' : 'comment';
    return blockComment(stream, state);
  }

  if (ch === '"') {
    if (stream.match('"""')) {
      state.mode = 'raw';
      return 'string';
    }
    stream.next();
    state.mode = 'string';
    return 'string';
  }
  if (ch === "'") {
    state.prev = 'lit';
    if (stream.match(/^'(?:[^'\\\n]|\\u[0-9a-fA-F]{4}|\\.)'/)) return 'character';
    stream.next();
    return null;
  }

  if (ch === '@') {
    const before = stream.string[stream.pos - 1];
    if (state.prev === 'kw' && before !== undefined && /[\p{L}\p{N}_]/u.test(before)) {
      if (stream.match(/^@[\p{L}_][\p{L}\p{N}_]*/u)) return 'labelName';
    }
    if (stream.match(/^@(?:[a-z]+:)?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/u)) {
      state.prev = 'none';
      return 'annotation';
    }
    stream.next();
    return 'annotation';
  }

  // Numbers. A leading dot (`.5`) is a number only where an operand can start.
  const leadingDot =
    ch === '.' && /\d/.test(stream.string[stream.pos + 1] ?? '') && !['ident', 'close', 'lit', 'string'].includes(state.prev);
  if (/\d/.test(ch) || leadingDot) {
    stream.match(/^0[xX][0-9a-fA-F_]+[uUlL]*/) ||
      stream.match(/^0[bB][01_]+[uUlL]*/) ||
      stream.match(/^\.\d[\d_]*(?:[eE][+-]?\d+)?[fF]?/) ||
      stream.match(/^\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?[fFuUlL]*/);
    state.prev = 'lit';
    return 'number';
  }

  if (stream.match(IDENT)) return wordToken(stream, state);

  // Brackets.
  switch (ch) {
    case '(':
      stream.next();
      state.stack.push({ kind: '(', indent: stream.indentation() });
      state.parens++;
      if (state.decl === 'val') state.decl = 'destruct';
      else if (state.decl === 'fun' || state.decl === 'class') state.decl = 'none';
      state.prev = 'op';
      return 'paren';
    case ')': {
      stream.next();
      const top = state.stack[state.stack.length - 1];
      if (top?.kind === '(') {
        state.stack.pop();
        state.parens--;
      }
      if (state.decl === 'destruct') state.decl = 'none';
      state.prev = 'close';
      return 'paren';
    }
    case '[':
      stream.next();
      state.stack.push({ kind: '[', indent: stream.indentation() });
      state.prev = 'op';
      return 'squareBracket';
    case ']': {
      stream.next();
      if (state.stack[state.stack.length - 1]?.kind === '[') state.stack.pop();
      state.prev = 'close';
      return 'squareBracket';
    }
    case '{':
      stream.next();
      state.stack.push({ kind: '{', indent: stream.indentation() });
      state.angle = 0;
      state.decl = 'none';
      state.prev = 'op';
      return 'brace';
    case '}': {
      stream.next();
      const top = state.stack[state.stack.length - 1];
      state.angle = 0;
      if (top && (top.kind === '$' || top.kind === '$raw')) {
        state.stack.pop();
        state.mode = top.kind === '$' ? 'string' : 'raw';
        return 'interpolation';
      }
      if (top?.kind === '{') state.stack.pop();
      state.prev = 'close';
      return 'brace';
    }
  }

  // Generic type arguments: `List<String>`, `listOf<Int>()`, `fun <T> foo()`.
  if (ch === '<') {
    const before = stream.string[stream.pos - 1] ?? ' ';
    const adjacent = /[\p{L}\p{N}_`]/u.test(before);
    const nextChar = stream.string[stream.pos + 1] ?? ' ';
    const typeStart = state.decl === 'fun' && !adjacent;
    const lookslikeType =
      adjacent && state.prev === 'ident' && GENERIC_ARGS.test(rest(stream)) && (isUpper(before) || isUpper(nextChar) || nextChar === '*');
    if (typeStart || lookslikeType) {
      stream.next();
      state.angle++;
      state.prev = 'op';
      return 'angleBracket';
    }
  }
  if (ch === '>' && state.angle > 0 && !stream.match('>=', false)) {
    stream.next();
    state.angle--;
    state.prev = 'close';
    return 'angleBracket';
  }

  // Operators and punctuation.
  if (stream.match('..<') || stream.match('..') || stream.match('?:') || stream.match('->') || stream.match('!!')) {
    state.prev = 'op';
    return 'operator';
  }
  if (stream.match('?.') || stream.match('::') || stream.match('.')) {
    state.prev = 'dot';
    return 'derefOperator';
  }
  if (ch === ',' || ch === ';') {
    stream.next();
    state.prev = 'op';
    if (ch === ';') {
      state.angle = 0;
      state.decl = 'none';
    }
    return 'separator';
  }
  if (ch === ':') {
    stream.next();
    state.prev = 'op';
    if (state.decl === 'class') state.decl = 'none';
    return 'punctuation';
  }
  if (stream.match(/^(?:===|!==|&&|\|\||[=!<>+\-*/%]=|\+\+|--)/) || stream.match(/^[=+\-*/%<>!&|^~?]/)) {
    const op = stream.current();
    state.prev = op === '++' || op === '--' ? 'close' : 'op';
    if (op === '=') {
      state.angle = 0;
      state.decl = 'none';
    }
    return 'operator';
  }

  stream.next();
  return null;
}

function token(stream: Stream, state: KotlinState): string | null {
  if (stream.sol()) {
    if (state.mode === 'string') state.mode = 'code';
    if (state.decl !== 'destruct') state.decl = 'none';
    if (state.prev !== 'dot') state.prev = 'none';
    if (state.parens === 0) state.angle = 0;
  }
  switch (state.mode) {
    case 'comment':
    case 'doc':
      return blockComment(stream, state);
    case 'string':
      return stringToken(stream, state, false);
    case 'raw':
      return stringToken(stream, state, true);
  }
  if (stream.eatSpace()) return null;
  return codeToken(stream, state);
}

function indent(state: KotlinState, textAfter: string, cx: { unit: number }): number | null {
  if (state.mode !== 'code') return null;
  const top = state.stack[state.stack.length - 1];
  if (!top || top.kind === '$' || top.kind === '$raw') return null;
  return top.indent + (/^[)\]}]/.test(textAfter) ? 0 : cx.unit);
}

export const kotlinParser: StreamParser<KotlinState> = {
  name: 'kotlin',
  startState,
  copyState,
  token,
  indent,
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  },
  tokenTable: {
    interpolation: interpolationTag,
    docTag: docTagTag,
  },
};

export const kotlinLanguage = StreamLanguage.define(kotlinParser);

export function kotlin(): LanguageSupport {
  return new LanguageSupport(kotlinLanguage);
}
