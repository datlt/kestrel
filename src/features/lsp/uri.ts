// Conversion between file paths and `file://` URIs. No imports on purpose:
// the functions are pure, so tests can run them without a browser.
//
// Paths are the native form that Rust gives us: `/Users/me/a b.kt` or `C:\work\a.kt`
// (also `\\server\share\a.kt`). URIs look like `file:///Users/me/a%20b.kt`
// and `file:///C:/work/a.kt`.

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function encodePath(path: string): string {
  // Encode every segment, keep the slashes.
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Absolute native path to a `file://` URI. */
export function pathToUri(path: string): string {
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    // UNC path: the host is the first segment.
    const parts = path.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    const host = parts.shift() ?? '';
    return `file://${host}/${encodePath(parts.join('/'))}`;
  }
  if (WINDOWS_DRIVE.test(path)) {
    const p = path.replace(/\\/g, '/');
    // Keep `C:` as it is. Some servers fail on `C%3A`.
    return `file:///${p.slice(0, 2)}${encodePath(p.slice(2))}`;
  }
  return `file://${encodePath(path)}`;
}

/** `file://` URI to an absolute native path. Returns null for other schemes. */
export function uriToPath(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) return null;
  const host = decode(m[1] ?? '');
  const rest = decode(m[2] ?? '/');
  if (host && host.toLowerCase() !== 'localhost') {
    return `\\\\${host}${rest.replace(/\//g, '\\')}`;
  }
  // `/C:/work/a.kt` or `/c:/work/a.kt`
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(rest);
  if (drive) return `${drive[1]!.toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  return rest;
}

/**
 * One form for the same file. Servers can write a URI in other ways than we do
 * (`file:///c%3A/x` and `file:///C:/x`), so compare URIs only after this.
 */
export function normalizeUri(uri: string): string {
  const path = uriToPath(uri);
  if (path === null) return uri;
  const out = pathToUri(path);
  return WINDOWS_DRIVE.test(path) ? out.replace(/^file:\/\/\/([A-Z])/, (_, d: string) => `file:///${d.toLowerCase()}`) : out;
}

/** LSP language id for an editor language id. */
export function lspLanguageId(languageId: string): string {
  switch (languageId) {
    case 'jsx':
      return 'javascriptreact';
    case 'tsx':
      return 'typescriptreact';
    default:
      return languageId;
  }
}
