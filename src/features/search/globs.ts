// Glob helpers: the file mask, the test file globs, and a small glob matcher.
//
// The Rust search takes globs in the style of .gitignore. A glob without a
// slash matches at any depth. A glob with a slash starts at the search root.
// A folder name also matches everything inside it. The matcher below follows
// the same rules, so the frontend can filter results the same way.

import { splitGlobs } from './query';

/** Test files. Same idea as `CallerNode.test` in the code index. */
export const TEST_GLOBS = [
  '**/test/**',
  '**/tests/**',
  '**/testByKotest/**',
  '**/testFixtures/**',
  '**/androidTest/**',
  '**/*Tests/**',
  '**/*Test.*',
  '**/*Tests.*',
  '**/*Spec.*',
];

export interface FileMask {
  include: string[];
  exclude: string[];
}

/** `*.kt, *.java, !*Test.kt` gives include `*.kt`, `*.java` and exclude `*Test.kt`. */
export function parseFileMask(mask: string): FileMask {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const g of splitGlobs(mask)) {
    if (g.startsWith('!')) {
      const rest = g.slice(1).trim();
      if (rest) exclude.push(rest);
    } else {
      include.push(g);
    }
  }
  return { include, exclude };
}

/** Escapes the characters that have a meaning in a glob, for a real folder name. */
export function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]{}!]/g, '\\$&');
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Turns the inside of `{a,b}` or a glob part into a regular expression source. */
function translate(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more folders. Other `**` match anything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1]);
      i += 2;
    } else if (c === '{') {
      let depth = 0;
      let j = i;
      for (; j < glob.length; j++) {
        if (glob[j] === '{') depth++;
        else if (glob[j] === '}' && --depth === 0) break;
      }
      if (j >= glob.length) {
        out += escapeRegex(c);
        i++;
      } else {
        const parts = splitTop(glob.slice(i + 1, j));
        out += '(?:' + parts.map(translate).join('|') + ')';
        i = j + 1;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) {
        out += escapeRegex(c);
        i++;
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        out += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = end + 1;
      }
    } else {
      out += escapeRegex(c);
      i++;
    }
  }
  return out;
}

/** Splits at commas that are not inside nested braces. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const cache = new Map<string, RegExp | null>();

/** Compiles one glob. Returns null when it is empty or broken. */
export function globToRegExp(glob: string): RegExp | null {
  const hit = cache.get(glob);
  if (hit !== undefined) return hit;
  let g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  let re: RegExp | null = null;
  if (g) {
    const rooted = g.startsWith('/');
    if (rooted) g = g.slice(1);
    const anchored = rooted || g.includes('/');
    try {
      re = new RegExp('^' + (anchored ? '' : '(?:.*/)?') + translate(g) + '(?:/.*)?$');
    } catch {
      re = null;
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(glob, re);
  return re;
}

/** `rel` is a path below the search root with `/` separators. */
export function matchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    const re = globToRegExp(g);
    if (re?.test(rel)) return true;
  }
  return false;
}
