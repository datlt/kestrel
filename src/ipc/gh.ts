// IPC for GitHub through the GitHub CLI (`gh`). Owner: integrator (contract).
// Rust side: src-tauri/src/cmd/gh.rs and crates/kestrel-gh. See docs/DESIGN.md, section 12.
//
// Kestrel never sees a token. `gh` keeps the tokens in the system keychain and
// adds them to each request. Errors: `gh_missing` (gh is not installed),
// `gh_auth` (no login for the host, or HTTP 401), `not_found` (HTTP 404),
// `gh_error` (other GitHub errors), `cancelled`.

import { invoke } from './invoke';

export interface GhAccount {
  /** For example `github.com` or a GitHub Enterprise host. */
  host: string;
  login: string;
  /** The account that `gh` uses for this host. */
  active: boolean;
  /** `success`: the token works. `error`: gh says the login is broken (the text is in `error`). */
  state: 'success' | 'error' | 'timeout';
  scopes: string[];
  error?: string;
}

export interface GhStatus {
  installed: boolean;
  /** `gh` version, like `2.97.0`. null when not installed. */
  version: string | null;
  accounts: GhAccount[];
}

/** Runs `gh auth status --json hosts`. Never fails because of a broken login: that account gets `state: error`. */
export function ghStatus(): Promise<GhStatus> {
  return invoke<GhStatus>('gh_status');
}

/** `gh auth switch --hostname <host> --user <login>`. */
export function ghSwitch(host: string, login: string): Promise<void> {
  return invoke<void>('gh_switch', { host, login });
}

/** `gh auth logout --hostname <host> --user <login>`. The UI asks first. */
export function ghLogout(host: string, login: string): Promise<void> {
  return invoke<void>('gh_logout', { host, login });
}

/**
 * The terminal command to log in (the login is interactive, so it runs in the
 * Kestrel terminal): `gh auth login --hostname <host> --web --git-protocol https`.
 */
export function ghLoginCommand(host: string): string {
  return `gh auth login --hostname ${host} --web --git-protocol https`;
}

export interface GhApiRequest {
  /** Must be a host with a `gh` login. */
  host: string;
  /** REST path without the host and without a leading slash, like `repos/o/r/pulls/1`. A query string is allowed. */
  path: string;
  /** Default `GET`. */
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body for POST, PATCH and PUT. */
  body?: unknown;
  /** GET only: read all pages and join them (the answer must be an array). */
  paginate?: boolean;
}

let nextId = 1;
/** A new id for the calls below (to cancel them). */
export function newGhRequestId(): number {
  return nextId++;
}

/** A REST call. Returns the parsed JSON (null for an empty answer, like HTTP 204). */
export function ghApi<T>(id: number, request: GhApiRequest): Promise<T> {
  return invoke<T>('gh_api', { id, request });
}

/** A file at a commit, as text: `GET repos/<owner>/<repo>/contents/<path>?ref=<sha>` with the raw media type. Binary files reject with `binary`. */
export function ghFileText(id: number, host: string, owner: string, repo: string, path: string, ref: string): Promise<string> {
  return invoke<string>('gh_file_text', { id, host, owner, repo, path, ref });
}

/**
 * A GraphQL call. Returns `data`. When GitHub answers with `errors`, it
 * rejects with `gh_error` and the joined messages.
 */
export function ghGraphql<T>(id: number, host: string, query: string, variables: Record<string, unknown>): Promise<T> {
  return invoke<T>('gh_graphql', { id, host, query, variables });
}

/** Stops a running call. It then rejects with `cancelled`. */
export function ghCancel(id: number): Promise<void> {
  return invoke<void>('gh_cancel', { id });
}

export interface GhRepoRef {
  host: string;
  owner: string;
  name: string;
  /** The git remote that points to it (`origin` first). */
  remote: string;
}

/**
 * The GitHub repository of a folder, from its git remotes (https and ssh
 * forms). Only hosts with a `gh` login count. null when there is none.
 */
export function ghRepoOf(root: string): Promise<GhRepoRef | null> {
  return invoke<GhRepoRef | null>('gh_repo_of', { root });
}

/**
 * Checks out the branch of a pull request in the folder (`gh pr checkout <n>`).
 * Returns the output of gh. Git refuses when local changes would be lost:
 * then it rejects with `gh_error` and the git message.
 */
export function ghPrCheckout(root: string, number: number): Promise<string> {
  return invoke<string>('gh_pr_checkout', { root, number });
}
