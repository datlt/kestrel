// IPC for the preview feature. Owner: preview agent.
import { invoke } from './invoke';

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);
}

/**
 * URL of a local file for the `preview://` protocol (docs/DESIGN.md 5.3).
 * macOS and Linux: `preview://localhost/Users/me/a%20b.png`.
 * Windows: `http://preview.localhost/C:/work/a.png`.
 * Every path segment is percent-encoded. `windows` is only for tests.
 */
export function previewUrl(path: string, windows: boolean = isWindows()): string {
  const slash = path.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:(\/|$)/.test(slash);
  const parts = slash.split('/');
  const encoded = parts.map((seg, i) => (drive && i === 0 ? seg : encodeURIComponent(seg)));
  let url = encoded.join('/');
  if (!url.startsWith('/')) url = '/' + url;
  return (windows ? 'http://preview.localhost' : 'preview://localhost') + url;
}

/** Folder URL with a trailing slash, for `<base href>`. */
export function previewDirUrl(dir: string, windows: boolean = isWindows()): string {
  return previewUrl(dir.replace(/[\\/]+$/, '') || '/', windows).replace(/\/+$/, '') + '/';
}

/**
 * Native path from a preview URL (the reverse of `previewUrl`).
 * Returns null when the URL is not a preview URL.
 */
export function pathFromPreviewUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const ok = u.protocol === 'preview:' || (u.protocol === 'http:' && u.hostname === 'preview.localhost');
  if (!ok) return null;
  let p: string;
  try {
    p = u.pathname.split('/').map((s) => decodeURIComponent(s)).join('/');
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:(\/|$)/.test(p)) {
    p = p.slice(1);
    return p.replace(/\//g, '\\');
  }
  return p;
}

/** Renders markdown in a Rust thread (comrak, GitHub flavor). */
export function mdRender(text: string): Promise<string> {
  return invoke<string>('md_render', { text });
}

/**
 * Renders markdown from other people (pull request comments) for the main
 * window: raw HTML is not rendered and unsafe links are dropped.
 */
export function mdRenderSafe(text: string): Promise<string> {
  return invoke<string>('md_render_safe', { text });
}

/** Lets the preview protocol serve files in the folder of `path`. */
export function previewAllowParent(path: string): Promise<void> {
  return invoke<void>('preview_allow_parent', { path });
}

/** Stores the text of an HTML preview with scripts on (see `preview_set_live` in Rust). */
export const previewSetLive = (id: string, html: string) => invoke<void>('preview_set_live', { id, html });
export const previewDropLive = (id: string) => invoke<void>('preview_drop_live', { id }).catch(() => {});
