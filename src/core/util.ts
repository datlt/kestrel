import type { Platform } from './types';

export const platform: Platform = (() => {
  const p = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(p)) return 'macos';
  if (/Windows/.test(p)) return 'windows';
  return 'linux';
})();

export const isMac = platform === 'macos';

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args: A) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** Runs `fn` at most once per animation frame, with the latest arguments. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void) {
  let frame = 0;
  let last: A;
  return (...args: A) => {
    last = args;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn(...last);
    });
  };
}

// --- Paths --------------------------------------------------------------
// Absolute paths come from Rust in the native form (`C:\x\y` on Windows).
// These helpers accept both separators.

export function sep(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || parts[parts.length - 2] || path;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return path.slice(0, 1);
  // Keep `C:\` as a root.
  if (i === 2 && path[1] === ':') return path.slice(0, 3);
  return path.slice(0, i);
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

export function joinPath(dir: string, ...parts: string[]): string {
  const s = sep(dir);
  let out = dir.replace(/[\\/]+$/, '');
  for (const p of parts) {
    if (!p) continue;
    out += s + p.replace(/^[\\/]+/, '').replace(/[\\/]/g, s);
  }
  return out;
}

/** Same path? Case-insensitive on Windows and macOS (default file systems). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** True when `path` is `dir` or inside `dir`. */
export function isInside(path: string, dir: string): boolean {
  const norm = (p: string) => {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'linux' ? n : n.toLowerCase();
  };
  const p = norm(path);
  const d = norm(dir);
  return p === d || p.startsWith(d + '/');
}

/** Escapes text for use inside HTML. Use it every time you build HTML from data. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
