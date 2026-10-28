// The search pattern as a JavaScript RegExp, and the replacement text.
//
// Rust finds the matches. For Replace we find them again on the current text
// with this RegExp, so the groups (`$1`, `$<name>`) work and the text is the
// text that is in the file now. The RegExp works on one line at a time, like
// the Rust search.

export interface PatternOptions {
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
}

export type CompiledPattern = { ok: true; re: RegExp } | { ok: false; error: string };

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Letters, digits and `_` in any language. Needs the `u` flag.
const WORD = '[\\p{L}\\p{N}_]';
// Fallback without the `u` flag: ASCII word characters and everything from U+00C0 up.
const WORD_LOOSE = '[\\w\\u00C0-\\uFFFF]';

/** Builds the RegExp. The flag `g` is set, so use `matchesInLine` to read it. */
export function compilePattern(o: PatternOptions): CompiledPattern {
  if (!o.query) return { ok: false, error: 'The query is empty.' };
  const source = o.regex ? o.query : escapeRegExp(o.query);
  const flags = (o.matchCase ? '' : 'i') + 'g';
  const wrap = (src: string, word: string) =>
    o.wholeWord ? `(?<!${word})(?:${src})(?!${word})` : src;
  try {
    return { ok: true, re: new RegExp(wrap(source, WORD), flags + 'u') };
  } catch (first) {
    if (!o.regex) return { ok: false, error: first instanceof Error ? first.message : String(first) };
    // Some patterns are fine without the `u` flag only (for example `\-`).
    try {
      return { ok: true, re: new RegExp(wrap(source, WORD_LOOSE), flags) };
    } catch {
      return { ok: false, error: first instanceof Error ? first.message : String(first) };
    }
  }
}

/** All non-empty matches in one line, from left to right. */
export function matchesInLine(line: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[0] === '') {
      // An empty match cannot be replaced in a useful way. Step over it.
      re.lastIndex++;
      continue;
    }
    out.push(m);
  }
  re.lastIndex = 0;
  return out;
}

export interface ReplaceOptions {
  /** The text of the Replace field. */
  template: string;
  /** Regex mode: `$1`, `$<name>`, `$&` and `\n` have a meaning. Plain mode: the text is used as it is. */
  regex: boolean;
  preserveCase: boolean;
}

/**
 * Expands the template for one match.
 * `$&` is the whole match, `$1` to `$99` are groups, `$<name>` is a named
 * group, `$$` is a dollar sign. `\n`, `\t` and `\\` are escapes.
 * A group that did not take part gives an empty text.
 */
export function expandTemplate(template: string, m: RegExpExecArray): string {
  const groupCount = m.length - 1;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '\\' && i + 1 < template.length) {
      const n = template[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '\\') out += '\\';
      else if (n === '$') out += '$';
      else out += c + n;
      i++;
    } else if (c === '$' && i + 1 < template.length) {
      const n = template[i + 1];
      if (n === '$') {
        out += '$';
        i++;
      } else if (n === '&') {
        out += m[0];
        i++;
      } else if (n === '<') {
        const end = template.indexOf('>', i + 2);
        const name = end < 0 ? '' : template.slice(i + 2, end);
        if (end >= 0 && m.groups && name in m.groups) {
          out += m.groups[name] ?? '';
          i = end;
        } else {
          out += c;
        }
      } else if (n >= '0' && n <= '9') {
        const two = template.slice(i + 1, i + 3);
        if (/^\d\d$/.test(two) && Number(two) >= 1 && Number(two) <= groupCount) {
          out += m[Number(two)] ?? '';
          i += 2;
        } else if (Number(n) >= 1 && Number(n) <= groupCount) {
          out += m[Number(n)] ?? '';
          i++;
        } else {
          out += c;
        }
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();
const hasLetter = (s: string) => /\p{L}/u.test(s);

/**
 * Preserve Case. All letters of the match are upper case: the replacement is
 * upper case. The match starts with an upper case letter: the first letter of
 * the replacement is upper case. Otherwise the replacement stays as typed.
 */
export function applyPreserveCase(matched: string, replacement: string): string {
  if (!replacement || !hasLetter(matched)) return replacement;
  if (matched === matched.toUpperCase() && matched !== matched.toLowerCase()) return replacement.toUpperCase();
  const first = [...matched][0];
  if (first && isUpper(first)) {
    const [head, ...rest] = [...replacement];
    return head.toUpperCase() + rest.join('');
  }
  return replacement;
}

/** The replacement text for one match. */
export function replacementFor(m: RegExpExecArray, o: ReplaceOptions): string {
  const text = o.regex ? expandTemplate(o.template, m) : o.template;
  return o.preserveCase ? applyPreserveCase(m[0], text) : text;
}
