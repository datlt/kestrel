// Matches the `files.exclude` globs (VS Code style) against paths relative to the root.

const cache = new Map<string, RegExp>();

/** Converts a glob to a RegExp. Supports `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  // A pattern without a slash matches the name at any depth.
  if (!g.includes('/')) g = '**/' + g;
  let out = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      braces++;
      out += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      out += ')';
    } else if (c === ',' && braces > 0) {
      out += '|';
    } else {
      out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$');
}

export type ExcludeMatcher = (relativePath: string) => boolean;

export function createExcludeMatcher(globs: readonly string[]): ExcludeMatcher {
  const list: RegExp[] = [];
  for (const glob of globs) {
    try {
      let re = cache.get(glob);
      if (!re) {
        re = globToRegExp(glob);
        cache.set(glob, re);
      }
      list.push(re);
    } catch {
      // A bad pattern is skipped.
    }
  }
  return (rel) => list.some((re) => re.test(rel));
}
