// Pure helpers for addresses and bookmark titles. No DOM, so they are easy to test.

/** Text in the address field -> a full http(s) address, or null when it is not an address. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let candidate = text;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  // `localhost:3000` looks like a scheme, but it is a host with a port.
  const hostWithPort = /^[^/?#:]+:\d+([/?#]|$)/.test(text);
  if (scheme && !hostWithPort) {
    const s = scheme[1].toLowerCase();
    if (s !== 'http' && s !== 'https') return null;
  } else {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text);
    candidate = `${local ? 'http' : 'https'}://${text}`;
  }
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Host name for a title, without `www.`. Returns the text itself when it is not an address. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** Title of a bookmark: the last page title that we saw, or the host name. */
export function bookmarkTitle(url: string, titles: Readonly<Record<string, string>>): string {
  const known = titles[url]?.trim();
  return known || hostOf(url);
}

/** Two addresses are the same when they differ only by a trailing slash at the end of the path. */
export function sameUrl(a: string, b: string): boolean {
  const strip = (u: string) => u.replace(/\/(?=(#|\?|$))/, '');
  return a === b || strip(a) === strip(b);
}

/** Adds a bookmark at the end. Keeps the list as it is when the address is there already. */
export function addBookmark(list: readonly string[], url: string): string[] {
  return list.some((u) => sameUrl(u, url)) ? [...list] : [...list, url];
}

export function removeBookmark(list: readonly string[], url: string): string[] {
  return list.filter((u) => !sameUrl(u, url));
}
