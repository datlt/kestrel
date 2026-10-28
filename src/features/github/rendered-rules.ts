// Pure rules for HTML that comes from other people (after `mdRenderSafe`).
// The DOM part is in `rendered.ts`.

/**
 * An image may load only from `https:` and only from the host of the pull
 * request. Anything else (other hosts, `http:`, `data:`, relative paths that
 * we cannot place) is removed.
 */
export function isAllowedImage(src: string | null | undefined, prHost: string): boolean {
  if (!src) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.host.toLowerCase() === prHost.toLowerCase();
}

/**
 * The address to open in the system browser for a link, or null when the link
 * must do nothing (no address, `javascript:`, `file:`, only an anchor, ...).
 * Relative links are placed under `baseUrl` (the address of the pull request).
 */
export function externalLink(href: string | null | undefined, baseUrl: string): string | null {
  if (!href || href.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
}

/** Tags that never belong in a rendered comment. */
export const FORBIDDEN_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'svg', 'math', 'video', 'audio', 'source', 'picture'];
