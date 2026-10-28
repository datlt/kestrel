// Pure helpers: pull request references, tab ids and state keys.

export interface PullRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/;

function make(host: string, owner: string, repo: string, n: string): PullRef | null {
  const number = Number(n);
  if (!HOST.test(host) || !NAME.test(owner) || !NAME.test(repo) || !Number.isInteger(number) || number < 1) return null;
  return { host: host.toLowerCase(), owner, repo, number };
}

/**
 * Reads what the user typed in "Open Pull Request":
 * - `https://<host>/<owner>/<repo>/pull/<n>` (also with `/files` or `#...` after it)
 * - `<owner>/<repo>#<n>` (uses `defaultHost`)
 * - `<host>/<owner>/<repo>#<n>` (the form of the tab id, without `pr:`)
 * Returns null when the text is none of these.
 */
export function parsePullRef(input: string, defaultHost: string): PullRef | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
    return m ? make(url.host, m[1], m[2], m[3]) : null;
  }
  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (short) return make(defaultHost, short[1], short[2], short[3]);
  const full = /^([^/\s#]+)\/([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (full) return make(full[1], full[2], full[3], full[4]);
  return null;
}

/** Tab id: `pr:<host>/<owner>/<repo>#<n>`. */
export const prTabId = (r: PullRef) => `pr:${r.host}/${r.owner}/${r.repo}#${r.number}`;

/** Text of a reference for titles: `owner/repo#n`. */
export const prShort = (r: PullRef) => `${r.owner}/${r.repo}#${r.number}`;

/** Reads a tab id back. */
export function parsePrTabId(id: string): PullRef | null {
  return id.startsWith('pr:') ? parsePullRef(id.slice(3), '') : null;
}

/** Key in `globalState` for the drafts of one pull request. */
export const draftsKey = (r: PullRef) => `github.drafts:${r.host}/${r.owner}/${r.repo}#${r.number}`;

/** Key in `globalState` for the "viewed" files of one pull request at one head commit. */
export const viewedKey = (r: PullRef, headSha: string) => `github.viewed:${r.host}/${r.owner}/${r.repo}#${r.number}@${headSha}`;

/** Address of the pull request in the browser. */
export const prWebUrl = (r: PullRef) => `https://${r.host}/${r.owner}/${r.repo}/pull/${r.number}`;
