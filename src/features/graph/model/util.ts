// Small path helpers for the graph model. Rel paths use `/` and have no slash at the start or end.

/** Folder part of a rel path: `docs/api/Auth.md` gives `docs/api`, `Auth.md` gives `''`. */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** Last part of a path. Handles `\` and a slash at the end. */
export function lastSegment(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Absolute path of a rel path under the root. */
export function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  return root.endsWith('/') || root.endsWith('\\') ? root + rel : `${root}/${rel}`;
}

/** Rel path of an absolute folder path under the root, or null when it is outside the root. */
export function relUnderRoot(root: string, path: string): string | null {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p === r) return '';
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  return null;
}

/** Order of folders: by name without case, then by code point. */
export function compareNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Order of folder rel paths where a parent comes before its children and the
 * children come right after it (`a`, `a/b`, `a-b`).
 */
export function compareRels(a: string, b: string): number {
  return compareNames(a.replace(/\//g, '\0'), b.replace(/\//g, '\0'));
}

/** Small stable hash of a string (FNV-1a), for tag colors. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
