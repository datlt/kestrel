// Dev only. A Vite plugin that lets the real frontend run in a normal browser tab.
//
// The browser side is src/dev/browser-backend.ts. It sends every Rust command to
// `POST /__kestrel/invoke/<cmd>`. This file answers them with real files, the real
// `git` program and a small Markdown renderer. It also pushes events (file changes,
// search results) to the page through Server-Sent Events at `/__kestrel/events`.
//
// This plugin only runs with `vite serve` (apply: 'serve'). It never goes into a build.
// It uses only Node built-ins.
//
// Settings: KESTREL_DEV_ROOT (folder to open at start), KESTREL_DEV_STATE (folder for
// settings and app data, default: <tmpdir>/kestrel-devbridge).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PREFIX = '/__kestrel/';
const BINARY_CHECK_BYTES = 8192;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WATCH_PATHS = 5000;

// --- Errors ------------------------------------------------------------------

/** Error with a code that the frontend checks (crates/kestrel-common/src/error.rs). */
class KError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const notFound = (m) => new KError('not_found', m);
const invalid = (m) => new KError('invalid_input', m);

/** Turns a Node error into a KError with the same code that Rust would use. */
function toKError(e, what = '') {
  if (e instanceof KError) return e;
  const code =
    e?.code === 'ENOENT' || e?.code === 'ENOTDIR'
      ? 'not_found'
      : e?.code === 'EACCES' || e?.code === 'EPERM'
        ? 'permission_denied'
        : e?.code === 'EEXIST'
          ? 'already_exists'
          : 'io';
  return new KError(code, `${what ? what + ': ' : ''}${e?.message ?? e}`);
}

// --- State folders -----------------------------------------------------------

const stateDir = path.resolve(process.env.KESTREL_DEV_STATE || path.join(os.tmpdir(), 'kestrel-devbridge'));
const configDir = path.join(stateDir, 'config');
const dataDir = path.join(stateDir, 'data');
const cacheDir = path.join(stateDir, 'cache');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// --- Clients (one per browser tab) and event delivery ------------------------

/**
 * A client is one browser tab. It has an SSE connection, an open folder with its
 * watcher, and running searches.
 */
const clients = new Map();

function getClient(id) {
  let c = clients.get(id);
  if (!c) {
    c = { id, res: null, queue: [], watchers: new Map(), searches: new Map(), channelIdx: new Map(), timer: null };
    clients.set(id, c);
  }
  return c;
}

function sseWrite(c, obj) {
  if (c.res) c.res.write(`data: ${JSON.stringify(obj)}\n\n`);
  else if (c.queue.length < 2000) c.queue.push(obj);
}

function emitEvent(c, event, payload) {
  sseWrite(c, { t: 'event', event, payload });
}

function broadcastEvent(event, payload) {
  for (const c of clients.values()) emitEvent(c, event, payload);
}

/** A channel object for one command call. Messages get an index, like in Tauri. */
function makeChannel(c, id) {
  const next = () => {
    const i = c.channelIdx.get(id) ?? 0;
    c.channelIdx.set(id, i + 1);
    return i;
  };
  return {
    send: (message) => sseWrite(c, { t: 'channel', id, data: { index: next(), message } }),
    end: () => {
      sseWrite(c, { t: 'channel', id, data: { index: next(), end: true } });
      c.channelIdx.delete(id);
    },
  };
}

function closeClientState(c) {
  for (const w of c.watchers.values()) w?.close();
  c.watchers.clear();
  for (const s of c.searches.values()) s.cancelled = true;
  c.searches.clear();
}

function attachSse(c, req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  if (c.timer) clearTimeout(c.timer);
  c.timer = null;
  c.res?.end();
  c.res = res;
  for (const m of c.queue.splice(0)) sseWrite(c, m);
  const beat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(beat);
    if (c.res === res) {
      c.res = null;
      // A closed tab never comes back. Free its watcher after a short wait.
      c.timer = setTimeout(() => {
        closeClientState(c);
        clients.delete(c.id);
      }, 30000);
    }
  });
}

// --- Processes ---------------------------------------------------------------

/**
 * Runs a program and collects its output. `signal.kill` stops it.
 * Rejects with git_missing when the program does not exist.
 */
function run(cmd, args, { cwd, input, env, handle } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (handle) handle.child = child;
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (e.code === 'ENOENT' && cmd === 'git') reject(new KError('git_missing', 'git is not installed or not in PATH'));
      else reject(toKError(e));
    });
    child.on('close', (code) => {
      if (handle?.cancelled) return reject(new KError('cancelled', 'cancelled'));
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const git = (root, args, opts = {}) => run('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, ...opts });

function gitFailure(out) {
  const msg = out.stderr.trim();
  if (msg.includes('not a git repository')) return new KError('not_a_repo', 'not a git repository');
  return new KError('io', msg || `git exited with code ${out.code}`);
}

async function gitOk(root, args, opts) {
  await requireDir(root);
  const out = await git(root, args, opts);
  if (out.code !== 0) throw gitFailure(out);
  return out.stdout;
}

async function requireDir(dir) {
  let st;
  try {
    st = await fsp.stat(dir);
  } catch {
    throw notFound(`folder not found: ${dir}`);
  }
  if (!st.isDirectory()) throw notFound(`folder not found: ${dir}`);
}

// --- app_* -------------------------------------------------------------------

const settingsFile = path.join(configDir, 'settings.json');
const pkg = readJson(path.resolve(process.cwd(), 'package.json'), {});

const appCommands = {
  async app_settings_read() {
    try {
      return { path: settingsFile, text: await fsp.readFile(settingsFile, 'utf8') };
    } catch (e) {
      if (e.code === 'ENOENT') return { path: settingsFile, text: null };
      throw toKError(e);
    }
  },
  async app_settings_write({ text }) {
    await fsp.mkdir(configDir, { recursive: true });
    const tmp = settingsFile + '.tmp';
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, settingsFile);
    return null;
  },
  async app_info() {
    return {
      version: pkg.version ?? '0.0.0',
      platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
      configDir,
      dataDir,
      cacheDir,
    };
  },
  async app_log({ level, message }) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[web:${level}] ${message}`);
    return null;
  },
};

// --- fs_* --------------------------------------------------------------------

const mtimeMs = (st) => Math.floor(st.mtimeMs);

function detectLineEnding(text) {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) lf++;
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    }
  }
  const kinds = [lf, crlf, cr].filter((n) => n > 0).length;
  const ending = lf >= crlf && lf >= cr ? 'lf' : crlf >= cr ? 'crlf' : 'cr';
  return { ending, mixed: kinds > 1 };
}

/** Same wire format as Rust: [u32 LE header length][header JSON][text]. */
function wire(header, text) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(h.length, 0);
  return Buffer.concat([len, h, Buffer.from(text, 'utf8')]);
}

function bomOf(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { enc: 'utf-8', len: 3 };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf-16le', len: 2 };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf-16be', len: 2 };
  return null;
}

function decodeBytes(buf, label) {
  const bom = bomOf(buf);
  let enc = label ? label.trim().toLowerCase() : null;
  let skip = 0;
  if (bom && (!enc || enc === bom.enc || enc === 'utf8')) {
    enc = bom.enc;
    skip = bom.len;
  }
  const body = buf.subarray(skip);
  if (!enc || enc === 'utf8') enc = 'utf-8';
  let dec;
  try {
    dec = new TextDecoder(enc, { fatal: true, ignoreBOM: true });
  } catch (e) {
    if (e instanceof RangeError) throw invalid(`unknown encoding: ${label}`);
    dec = null;
  }
  let lossy = false;
  let text;
  try {
    text = dec.decode(body);
  } catch {
    lossy = true;
    text = new TextDecoder(enc, { ignoreBOM: true }).decode(body);
  }
  return { text, encoding: new TextDecoder(enc).encoding, bom: skip > 0, lossy };
}

async function fsReadFile({ path: p, encoding, maxBytes }) {
  let st;
  try {
    st = await fsp.stat(p);
  } catch (e) {
    throw toKError(e, `cannot read ${p}`);
  }
  if (st.isDirectory()) throw invalid(`${p} is a folder`);
  const header = {
    encoding: encoding ? new TextDecoder(encoding).encoding : 'utf-8',
    bom: false,
    lineEnding: 'lf',
    mixedLineEndings: false,
    mtimeMs: mtimeMs(st),
    size: st.size,
    readonly: !(st.mode & 0o200),
    binary: false,
    tooLarge: false,
    lossy: false,
  };
  if (st.size > maxBytes) {
    header.tooLarge = true;
    return wire(header, '');
  }
  const buf = await fsp.readFile(p).catch((e) => {
    throw toKError(e, `cannot read ${p}`);
  });
  if (!encoding && !bomOf(buf) && buf.subarray(0, BINARY_CHECK_BYTES).includes(0)) {
    header.binary = true;
    return wire(header, '');
  }
  const d = decodeBytes(buf, encoding || null);
  const le = detectLineEnding(d.text);
  header.encoding = d.encoding;
  header.bom = d.bom;
  header.lossy = d.lossy;
  header.lineEnding = le.ending;
  header.mixedLineEndings = le.mixed;
  return wire(header, d.text);
}

async function fsWriteFile(req, body) {
  const h = (name) => {
    const v = req.headers[name];
    if (v === undefined) throw invalid(`missing header ${name}`);
    return String(v);
  };
  const file = decodeURIComponent(h('x-path'));
  const encName = h('x-encoding').toLowerCase();
  const bom = h('x-bom') === '1';
  const le = h('x-line-ending');
  if (!['lf', 'crlf', 'cr'].includes(le)) throw invalid('bad x-line-ending');
  const expectedRaw = String(req.headers['x-expected-mtime'] ?? '');
  const expected = expectedRaw === '' ? null : Number(expectedRaw);
  if (expected !== null && !Number.isFinite(expected)) throw invalid('bad x-expected-mtime');

  let text = body.toString('utf8');
  if (le !== 'lf') text = text.replace(/\n/g, le === 'crlf' ? '\r\n' : '\r');
  let bytes;
  if (encName === 'utf-8' || encName === 'utf8') {
    bytes = Buffer.from(text, 'utf8');
    if (bom) bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  } else if (encName === 'utf-16le') {
    bytes = Buffer.from(text, 'utf16le');
    if (bom) bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
  } else {
    throw invalid(`cannot save with encoding ${encName} in the dev bridge (only utf-8 and utf-16le)`);
  }

  let st = null;
  try {
    st = await fsp.stat(file);
  } catch {}
  if (st && expected !== null && mtimeMs(st) !== expected) {
    throw new KError('conflict', `${file} changed on disk`);
  }
  if (st?.isDirectory()) throw invalid(`${file} is a folder`);
  if (st && !(st.mode & 0o200)) throw new KError('permission_denied', `${file} is read-only`);
  try {
    await fsp.writeFile(file, bytes);
  } catch (e) {
    throw toKError(e, `cannot write ${file}`);
  }
  const after = await fsp.stat(file);
  return { mtimeMs: mtimeMs(after), size: after.size };
}

/** Case-insensitive order where digit groups compare as numbers: a2 < a10. */
function naturalCmp(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const tx = x.replace(/^0+/, '');
      const ty = y.replace(/^0+/, '');
      if (tx.length !== ty.length) return tx.length - ty.length;
      if (tx !== ty) return tx < ty ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    } else {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
    }
  }
  return pa.length - pb.length;
}

/** Asks git which of these absolute paths are ignored. Not a repo: none is ignored. */
async function ignoredSet(dir, paths) {
  const set = new Set();
  if (paths.length === 0) return set;
  try {
    const out = await git(dir, ['check-ignore', '--no-index', '-z', '--stdin'], { input: paths.join('\0') + '\0' });
    if (out.code === 0 || out.code === 1) {
      for (const p of out.stdout.toString('utf8').split('\0')) if (p) set.add(path.resolve(dir, p));
    }
  } catch {}
  return set;
}

// --- Compact folders (same rules as crates/kestrel-fs/src/dir.rs) -----------------

const MAX_COMPACT_DIRS = 500;
const MAX_CHAIN = 32;
const SOURCE_ROOTS = ['java', 'kotlin', 'scala', 'groovy', 'resources'];

/** A path like src/main/java: the last name is a source root and two levels up is "src". */
function isSourceRoot(comps) {
  const n = comps.length;
  return n >= 3 && comps[n - 3] === 'src' && SOURCE_ROOTS.includes(comps[n - 1]);
}

/** Is the last folder a source root, or inside one? */
function inSourceRoot(comps) {
  for (let n = 3; n <= comps.length; n++) if (isSourceRoot(comps.slice(0, n))) return true;
  return false;
}

function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open < 0) return [glob];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  if (close < 0) return [glob];
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const starts = [open + 1, ...commas.map((x) => x + 1)];
  const ends = [...commas, close];
  return starts.flatMap((st, i) => expandBraces(head + glob.slice(st, ends[i]) + tail));
}

function matchName(pat, name) {
  if (pat.length === 0) return name.length === 0;
  if (pat[0] === '*') {
    for (let i = 0; i <= name.length; i++) if (matchName(pat.slice(1), name.slice(i))) return true;
    return false;
  }
  if (pat[0] === '?') return name.length > 0 && matchName(pat.slice(1), name.slice(1));
  return name[0] === pat[0] && matchName(pat.slice(1), name.slice(1));
}

function matchSegments(pat, segs) {
  if (pat.length === 0) return segs.length === 0;
  if (pat[0] === '**') {
    for (let i = 0; i <= segs.length; i++) if (matchSegments(pat.slice(1), segs.slice(i))) return true;
    return false;
  }
  return segs.length > 0 && matchName([...pat[0]], [...segs[0]]) && matchSegments(pat.slice(1), segs.slice(1));
}

/** The `files.exclude` matcher. `rel` is relative to the workspace root, with "/" separators. */
function makeExcluder(globs) {
  const patterns = [];
  for (const glob of globs ?? []) {
    let g = glob.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!g) continue;
    if (!g.includes('/')) g = `**/${g}`;
    for (const one of expandBraces(g)) patterns.push(one.split('/'));
  }
  const isExcluded = (rel) => patterns.length > 0 && patterns.some((p) => matchSegments(p, rel.split('/')));
  return (root, abs) => {
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return isExcluded(rel.split(path.sep).join('/'));
  };
}

/** The only visible child of dir when it is a real folder (not a link). Otherwise null. */
async function soleSubdir(dir, root, excluded) {
  let list;
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let found = null;
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (excluded(root, p)) continue;
    if (found) return null;
    // A link to a folder is not a folder here.
    if (!d.isDirectory()) return null;
    found = { name: d.name, path: p };
  }
  return found;
}

/** Follows the chain of only-child folders below start. parentComps start with the root name. */
async function followChain(start, parentComps, root, excluded) {
  const dot = inSourceRoot(parentComps);
  const comps = [...parentComps, path.basename(start)];
  // A source root never joins with what is inside it.
  if (!dot && isSourceRoot(comps)) return null;
  let cur = start;
  const names = [];
  while (names.length < MAX_CHAIN) {
    const next = await soleSubdir(cur, root, excluded);
    if (!next) break;
    comps.push(next.name);
    names.push(next.name);
    cur = next.path;
    if (!dot && isSourceRoot(comps)) break;
  }
  return names.length === 0 ? null : { names, deepest: cur, style: dot ? 'dot' : 'slash' };
}

/** Joins folders that hold only one folder. Same rules as add_chains in dir.rs. */
async function addChains(entries, dir, root, exclude) {
  if (entries.filter((e) => e.isDir).length > MAX_COMPACT_DIRS) return;
  const excluded = makeExcluder(exclude);
  const parentComps = [];
  if (path.basename(root)) parentComps.push(path.basename(root));
  const rel = path.relative(root, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) parentComps.push(...rel.split(path.sep));
  for (const e of entries) {
    if (!e.isDir || e.isSymlink || excluded(root, e.path)) continue;
    const chain = await followChain(e.path, parentComps, root, excluded);
    if (!chain) continue;
    if (!e.ignored) {
      // "ignored" of a joined row is the state of the deepest folder.
      const ign = await ignoredSet(path.dirname(chain.deepest), [chain.deepest]);
      e.ignored = ign.has(chain.deepest);
    }
    e.compact = chain.names;
    e.compactStyle = chain.style;
  }
}

async function fsListDir({ dir, root, compact, exclude }) {
  let names;
  try {
    names = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw toKError(e, `cannot read folder ${dir}`);
  }
  const entries = [];
  for (const d of names) {
    const p = path.join(dir, d.name);
    const isSymlink = d.isSymbolicLink();
    let isDir = d.isDirectory();
    if (isSymlink) isDir = await fsp.stat(p).then((s) => s.isDirectory(), () => false);
    entries.push({ name: d.name, path: p, isDir, isSymlink, ignored: false });
  }
  const ign = await ignoredSet(
    dir,
    entries.filter((e) => e.name !== '.git').map((e) => e.path),
  );
  for (const e of entries) e.ignored = ign.has(e.path);
  if (compact) await addChains(entries, dir, path.resolve(root ?? dir), exclude);
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || naturalCmp(a.name, b.name) || (a.name < b.name ? -1 : 1));
  return entries;
}

async function fsStat({ path: p }) {
  try {
    const st = await fsp.stat(p);
    return { exists: true, isDir: st.isDirectory(), size: st.size, mtimeMs: mtimeMs(st), readonly: !(st.mode & 0o200) };
  } catch {
    return { exists: false, isDir: false, size: 0, mtimeMs: 0, readonly: false };
  }
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

async function moveToTrash(p) {
  const trash = process.platform === 'darwin' ? path.join(os.homedir(), '.Trash') : path.join(stateDir, 'trash');
  await fsp.mkdir(trash, { recursive: true });
  let target = path.join(trash, path.basename(p));
  if (await exists(target)) target += `.${Date.now()}`;
  await fsp.rename(p, target);
}

const fsCommands = {
  fs_stat: fsStat,
  fs_list_dir: fsListDir,
  async fs_create_file({ path: p }) {
    try {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, '', { flag: 'wx' });
    } catch (e) {
      throw toKError(e, `cannot create ${p}`);
    }
    return null;
  },
  async fs_create_dir({ path: p }) {
    if (await exists(p)) throw new KError('already_exists', `${p} already exists`);
    try {
      await fsp.mkdir(p, { recursive: true });
    } catch (e) {
      throw toKError(e, `cannot create folder ${p}`);
    }
    return null;
  },
  async fs_rename({ from, to }) {
    if (!(await exists(from))) throw notFound(`${from} does not exist`);
    if (await exists(to)) {
      const [a, b] = await Promise.all([fsp.realpath(from), fsp.realpath(to)].map((p) => p.catch(() => null)));
      if (!a || a !== b) throw new KError('already_exists', `${to} already exists`);
    }
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
    } catch (e) {
      throw toKError(e, `cannot rename ${from}`);
    }
    return null;
  },
  async fs_delete({ path: p, permanent }) {
    let st;
    try {
      st = await fsp.lstat(p);
    } catch (e) {
      throw toKError(e, `cannot delete ${p}`);
    }
    try {
      if (permanent) await (st.isDirectory() ? fsp.rm(p, { recursive: true }) : fsp.unlink(p));
      else await moveToTrash(p);
    } catch (e) {
      throw toKError(e, `cannot delete ${p}`);
    }
    return null;
  },
};

// --- ws_* --------------------------------------------------------------------

const recentFile = path.join(dataDir, 'recent.json');
const globalFile = path.join(dataDir, 'state.json');
const sessionFile = (root) =>
  path.join(dataDir, 'sessions', createHash('sha1').update(root).digest('hex').slice(0, 16) + '.json');

/** Is this path inside .git, and can it change `git status`? null when it is not inside .git. */
function gitPathKind(p) {
  const parts = p.split(path.sep);
  const i = parts.indexOf('.git');
  if (i < 0) return null;
  const rest = parts.slice(i + 1);
  if (['HEAD', 'index', 'packed-refs', 'MERGE_HEAD'].includes(rest[0])) return rest.length === 1;
  if (rest[0] === 'refs') return rest.length > 1;
  return false;
}

function startWatcher(c, root) {
  let paths = new Set();
  let gitChanged = false;
  let timer = null;
  const flush = () => {
    timer = null;
    const list = [...paths];
    const change = { root, paths: list, gitChanged, rescan: false };
    paths = new Set();
    gitChanged = false;
    if (list.length === 0 && !change.gitChanged) return;
    if (list.length > MAX_WATCH_PATHS) {
      change.paths = [];
      change.rescan = true;
    } else change.paths.sort();
    emitEvent(c, 'kestrel://fs-changed', change);
  };
  try {
    return fs.watch(root, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const full = path.join(root, name.toString());
      const kind = gitPathKind(full);
      if (kind === null) paths.add(full);
      else if (kind) gitChanged = true;
      if (!timer) timer = setTimeout(flush, 100);
    });
  } catch (e) {
    console.warn(`[dev-bridge] cannot watch ${root}: ${e.message}`);
    return null;
  }
}

const wsCommands = {
  async ws_open({ root }, c) {
    const abs = path.resolve(root);
    await requireDir(abs).catch(() => {
      throw notFound(`${abs} is not a folder`);
    });
    // Opening the same folder again replaces its watcher. Other folders stay open.
    c.watchers.get(abs)?.close();
    c.watchers.set(abs, startWatcher(c, abs));
    const name = path.basename(abs) || abs;
    const list = readJson(recentFile, []).filter((r) => r.path !== abs);
    list.unshift({ path: abs, name, lastOpenedMs: Date.now() });
    writeJson(recentFile, list.slice(0, 30));
    return { root: abs, name };
  },
  async ws_close({ root } = {}, c) {
    // With a root, close only that folder. Without a root, close all folders of the tab.
    if (root) {
      const abs = path.resolve(root);
      c.watchers.get(abs)?.close();
      c.watchers.delete(abs);
    } else {
      for (const w of c.watchers.values()) w?.close();
      c.watchers.clear();
    }
    return null;
  },
  async ws_new_window() {
    // The browser side opens the tab itself. This is only a fallback.
    return 'win-1';
  },
  async ws_launch_args() {
    const target = process.env.KESTREL_DEV_ROOT;
    if (!target) return null;
    const abs = path.resolve(target);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return null;
    return { kind: st.isDirectory() ? 'folder' : 'file', path: abs };
  },
  async ws_recent_list() {
    return readJson(recentFile, []).filter((r) => {
      try {
        return fs.statSync(r.path).isDirectory();
      } catch {
        return false;
      }
    });
  },
  async ws_recent_remove({ path: p }) {
    writeJson(recentFile, readJson(recentFile, []).filter((r) => r.path !== p));
    return null;
  },
  async ws_session_load({ root }) {
    return readJson(sessionFile(root), null);
  },
  async ws_session_save({ root, session }) {
    writeJson(sessionFile(root), session);
    return null;
  },
  async ws_global_load() {
    return readJson(globalFile, {});
  },
  async ws_global_patch({ patch }) {
    const state = readJson(globalFile, {});
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v === null) delete state[k];
      else state[k] = v;
    }
    writeJson(globalFile, state);
    return null;
  },
};

// --- search_* ----------------------------------------------------------------

/** Relative paths (with `/`) of all files under root that git does not ignore. */
async function listFiles(root) {
  const out = await git(root, ['ls-files', '-co', '--exclude-standard', '-z']).catch(() => null);
  if (out && out.code === 0) {
    const seen = new Set();
    for (const f of out.stdout.toString('utf8').split('\0')) if (f) seen.add(f);
    return [...seen];
  }
  // Not a repo: walk the folder. Skip .git and node_modules.
  const files = [];
  const walk = async (dir, rel) => {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      if (d.name === '.git' || d.name === 'node_modules') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), r);
      else files.push(r);
    }
  };
  await walk(root, '');
  return files;
}

const indexes = new Map();

function startIndex(root, rebuild = false) {
  let idx = indexes.get(root);
  if (!idx) {
    idx = { files: [], state: 'building', building: false, timer: null };
    indexes.set(root, idx);
    rebuild = true;
  }
  if (rebuild && !idx.building) {
    idx.building = true;
    listFiles(root)
      .then((files) => {
        idx.files = files.sort();
        idx.state = 'ready';
      })
      .catch(() => {
        idx.state = 'ready';
      })
      .finally(() => {
        idx.building = false;
        broadcastEvent('kestrel://search-index', { root, count: idx.files.length });
      });
  }
  return idx;
}

const status = (idx) => ({ state: idx.state, count: idx.files.length });

/** Scores one path for a lowercase query. Returns null when it does not match. */
function fuzzyMatch(pathStr, q) {
  const lower = pathStr.toLowerCase();
  const nameStart = pathStr.lastIndexOf('/') + 1;
  const attempt = (from) => {
    const idx = [];
    let score = 0;
    let pos = from;
    let prev = -2;
    for (const ch of q) {
      const i = lower.indexOf(ch, pos);
      if (i < 0) return null;
      idx.push(...Array.from({ length: ch.length }, (_, k) => i + k));
      const boundary = i === 0 || '/._- '.includes(lower[i - 1]) || (/[a-z]/.test(pathStr[i - 1] ?? '') && /[A-Z]/.test(pathStr[i]));
      score += 10 + (i === prev + 1 ? 15 : 0) + (boundary ? 12 : 0) - Math.min(i - pos, 8);
      prev = i + ch.length - 1;
      pos = i + ch.length;
    }
    return { score, idx };
  };
  const inName = attempt(nameStart);
  if (inName) return { score: inName.score + 100 - pathStr.length / 20, indices: inName.idx };
  const whole = attempt(0);
  if (whole) return { score: whole.score - pathStr.length / 20, indices: whole.idx };
  return null;
}

function queryFiles(idx, query, limit) {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return idx.files.slice(0, limit).map((p) => ({ path: p, indices: [] }));
  const hits = [];
  for (const p of idx.files) {
    const m = fuzzyMatch(p, q);
    if (m) hits.push({ path: p, indices: m.indices, score: m.score });
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return hits.slice(0, limit).map(({ path: p, indices }) => ({ path: p, indices }));
}

const rootDirOrThrow = async (root) => {
  await requireDir(root).catch(() => {
    throw notFound(`not a folder: ${root}`);
  });
  return path.resolve(root);
};

/** Turns one glob (as in the search box) into a RegExp on a path relative to the root. */
function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!g) return null;
  const anywhere = !g.includes('/');
  g = g.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A folder name also matches everything inside it.
  return new RegExp(anywhere ? `(^|/)${re}(/|$)` : `^${re}(/|$)`);
}

function makeLineMatch(lineNo, raw, re) {
  const text = raw.replace(/[\r\n]+$/, '');
  re.lastIndex = 0;
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    found.push([m.index, m.index + m[0].length]);
  }
  if (found.length === 0) return null;
  const first = found[0][0];
  const lead = Math.min(text.length - text.trimStart().length, first);
  let begin = lead;
  let end = text.length;
  if (text.length - lead > 300) {
    begin = Math.max(lead, first - 40);
    end = Math.min(text.length, begin + 300);
  }
  const ranges = [];
  for (const [s, e] of found) {
    const s2 = Math.max(s, begin);
    const e2 = Math.min(e, end);
    if (s2 < e2) ranges.push([s2 - begin, e2 - begin]);
  }
  if (ranges.length === 0) return null;
  return { line: lineNo, text: text.slice(begin, end), ranges, offset: begin };
}

let searchCounter = 0;

async function runTextSearch(c, id, root, o, channel) {
  const state = c.searches.get(id);
  const started = Date.now();
  let total = 0;
  let filesWith = 0;
  let truncated = false;
  let batch = [];
  let batchLines = 0;
  let lastFlush = Date.now();
  const limit = o.maxResults > 0 ? o.maxResults : Infinity;
  const flush = () => {
    if (batch.length) channel.send({ type: 'batch', files: batch });
    batch = [];
    batchLines = 0;
    lastFlush = Date.now();
  };
  try {
    let source = o.query;
    if (!o.regex) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (o.wholeWord) source = `\\b(?:${source})\\b`;
    let re;
    try {
      re = new RegExp(source, o.matchCase ? 'gu' : 'giu');
    } catch {
      try {
        re = new RegExp(source, o.matchCase ? 'g' : 'gi');
      } catch (e) {
        throw invalid(`invalid pattern: ${e.message}`);
      }
    }
    const inc = (o.include ?? []).map(globToRegExp).filter(Boolean);
    const exc = (o.exclude ?? []).map(globToRegExp).filter(Boolean);
    const files = (await listFiles(root)).sort();
    for (const rel of files) {
      if (state.cancelled || total >= limit) break;
      if (inc.length && !inc.some((r) => r.test(rel))) continue;
      if (exc.some((r) => r.test(rel))) continue;
      const abs = path.join(root, rel);
      let buf;
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        buf = await fsp.readFile(abs);
      } catch {
        continue;
      }
      if (buf.subarray(0, BINARY_CHECK_BYTES).includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (total >= limit) {
          truncated = true;
          break;
        }
        const lm = makeLineMatch(i + 1, lines[i], re);
        if (lm) {
          matches.push(lm);
          total++;
        }
      }
      if (matches.length) {
        filesWith++;
        batch.push({ path: abs, matches });
        batchLines += matches.length;
        if (batchLines >= 400 || Date.now() - lastFlush >= 50) flush();
      }
    }
    if (total >= limit && !state.cancelled) truncated = true;
    flush();
    channel.send({
      type: 'done',
      totalMatches: total,
      filesWithMatches: filesWith,
      truncated,
      cancelled: !!state.cancelled,
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    flush();
    const k = toKError(e);
    channel.send({ type: 'error', code: k.code, message: k.message });
  } finally {
    c.searches.delete(id);
    channel.end();
  }
}

const searchCommands = {
  async search_files({ root, query, limit }) {
    const abs = await rootDirOrThrow(root);
    const idx = startIndex(abs);
    return { ...status(idx), items: queryFiles(idx, query, Math.min(Math.max(limit || 1, 1), 1000)) };
  },
  async search_index_status({ root }) {
    return status(startIndex(await rootDirOrThrow(root)));
  },
  async search_index_update({ root, paths, rescan }) {
    const abs = await rootDirOrThrow(root);
    const existing = indexes.get(abs);
    const idx = startIndex(abs);
    if (existing && (rescan || (paths && paths.length))) {
      // Rebuild after a short pause, so a burst of changes causes one scan.
      clearTimeout(idx.timer);
      idx.timer = setTimeout(() => startIndex(abs, true), 300);
    }
    return status(idx);
  },
  async search_text({ root, options, channel }, c) {
    if (!channel) throw invalid('search_text needs a channel');
    const abs = await rootDirOrThrow(root);
    const id = ++searchCounter;
    c.searches.set(id, { cancelled: false });
    void runTextSearch(c, id, abs, options, channel);
    return id;
  },
  async search_cancel({ id }, c) {
    const s = c.searches.get(id);
    if (s) s.cancelled = true;
    return null;
  },
};

// --- git_* -------------------------------------------------------------------

const runningStatus = new Map();

function parseStatus(buf) {
  const branch = { branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0 };
  const entries = [];
  const toks = buf.toString('utf8').split('\0');
  const entry = (p, orig, kind, xy, score) => {
    const index = xy[0] ?? '.';
    const worktree = xy[1] ?? '.';
    const tracked = kind === 'ordinary' || kind === 'renamed' || kind === 'copied';
    return {
      path: p,
      origPath: orig,
      kind,
      index,
      worktree,
      score,
      staged: tracked && index !== '.',
      unstaged: tracked && worktree !== '.',
    };
  };
  const field = (s, n) => {
    // Splits on the first n spaces. The last field keeps its spaces.
    const parts = [];
    let rest = s;
    for (let i = 0; i < n; i++) {
      const k = rest.indexOf(' ');
      if (k < 0) return null;
      parts.push(rest.slice(0, k));
      rest = rest.slice(k + 1);
    }
    parts.push(rest);
    return parts;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok) continue;
    switch (tok[0]) {
      case '#': {
        const m = /^# (\S+) (.*)$/.exec(tok);
        if (!m) break;
        const [, key, value] = m;
        if (key === 'branch.oid') branch.head = value === '(initial)' ? null : value;
        else if (key === 'branch.head') {
          if (value === '(detached)') branch.detached = true;
          else branch.branch = value;
        } else if (key === 'branch.upstream') branch.upstream = value;
        else if (key === 'branch.ab') {
          const [a, b] = value.split(' ');
          branch.ahead = parseInt(a.replace('+', ''), 10) || 0;
          branch.behind = parseInt(b.replace('-', ''), 10) || 0;
        }
        break;
      }
      case '1': {
        const f = field(tok, 8);
        if (f) entries.push(entry(f[8], null, 'ordinary', f[1], null));
        break;
      }
      case '2': {
        const f = field(tok, 9);
        if (!f) break;
        const orig = toks[++i] ?? null;
        const kind = f[8].startsWith('C') ? 'copied' : 'renamed';
        const score = parseInt(f[8].slice(1), 10);
        entries.push(entry(f[9], orig, kind, f[1], Number.isFinite(score) ? score : null));
        break;
      }
      case 'u': {
        const f = field(tok, 10);
        if (f) entries.push(entry(f[10], null, 'unmerged', f[1], null));
        break;
      }
      case '?':
        entries.push(entry(tok.slice(2), null, 'untracked', '??', null));
        break;
    }
  }
  return { branch, entries };
}

async function topLevel(root) {
  const out = await gitOk(root, ['rev-parse', '--show-toplevel']);
  return path.resolve(out.toString('utf8').replace(/[\r\n]+$/, ''));
}

function checkRev(rev) {
  if (!rev || rev.startsWith('-') || rev.includes('\0')) throw invalid(`bad revision: ${JSON.stringify(rev)}`);
}

const runningFetch = new Map();
const FETCH_TIMEOUT_MS = 120_000;
const STASH_PREFIX = 'Kestrel: before switching to';

/** Reads `%(upstream:track)`: `[ahead 2, behind 1]`, `[gone]` or an empty text. */
function parseTrack(text) {
  const s = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (s === 'gone') return { ahead: 0, behind: 0, gone: true };
  let ahead = 0;
  let behind = 0;
  for (const part of s.split(',')) {
    const m = /^\s*(ahead|behind)\s+(\d+)/.exec(part);
    if (m?.[1] === 'ahead') ahead = parseInt(m[2], 10);
    else if (m?.[1] === 'behind') behind = parseInt(m[2], 10);
  }
  return { ahead, behind, gone: false };
}

function gitText(out) {
  return [out.stdout.toString('utf8').trim(), out.stderr.trim()].filter(Boolean).join('\n');
}

/** True when git refuses because local changes or files are in the way. */
function blockedByChanges(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes('would be overwritten') ||
    m.includes('commit your changes or stash') ||
    m.includes('you have unmerged paths') ||
    m.includes('resolve your current index first') ||
    m.includes('needs merge')
  );
}

const gitCommands = {
  async git_repo_info({ root }) {
    const top = await topLevel(root);
    const info = { branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0 };
    const text = (o) => o.stdout.toString('utf8').trim();
    const sym = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
    if (sym.code === 0) info.branch = text(sym);
    else info.detached = true;
    const head = await git(root, ['rev-parse', '-q', '--verify', 'HEAD']);
    if (head.code === 0) info.head = text(head);
    else info.detached = false;
    if (info.branch) {
      const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      if (up.code === 0) {
        info.upstream = text(up);
        const ab = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
        if (ab.code === 0) {
          const [a, b] = text(ab).split(/\s+/).map((n) => parseInt(n, 10) || 0);
          info.ahead = a ?? 0;
          info.behind = b ?? 0;
        }
      }
    }
    return { topLevel: top, ...info };
  },
  async git_status({ root }, c) {
    // A newer call for the same tab and folder cancels the older one.
    const key = `${c.id}\0${root}`;
    runningStatus.get(key)?.kill?.();
    const handle = { cancelled: false, kill() {
      this.cancelled = true;
      this.child?.kill();
    } };
    runningStatus.set(key, handle);
    try {
      await requireDir(root);
      const top = await (async () => {
        const out = await git(root, ['rev-parse', '--show-toplevel'], { handle });
        if (out.code !== 0) throw gitFailure(out);
        return path.resolve(out.stdout.toString('utf8').replace(/[\r\n]+$/, ''));
      })();
      const out = await git(
        root,
        ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty'],
        { handle },
      );
      if (out.code !== 0) throw gitFailure(out);
      const { branch, entries } = parseStatus(out.stdout);
      return { topLevel: top, ...branch, entries };
    } finally {
      if (runningStatus.get(key) === handle) runningStatus.delete(key);
    }
  },
  async git_diff_names({ root, base, target }) {
    checkRev(base);
    if (target) checkRev(target);
    const hasHead = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])).code === 0;
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const b = base === 'HEAD' && !hasHead ? emptyTree : base;
    const args = ['diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff', b];
    if (target) args.push(target);
    args.push('--');
    const buf = await gitOk(root, args);
    const toks = buf.toString('utf8').split('\0');
    const list = [];
    for (let i = 0; i < toks.length; i++) {
      const st = toks[i];
      if (!st) continue;
      const status = st[0];
      const n = parseInt(st.slice(1), 10);
      const score = Number.isFinite(n) ? n : null;
      if (status === 'R' || status === 'C') {
        const old = toks[++i];
        const neu = toks[++i];
        if (neu === undefined) break;
        list.push({ status, score, path: neu, origPath: old });
      } else {
        const p = toks[++i];
        if (p === undefined) break;
        list.push({ status, score, path: p, origPath: null });
      }
    }
    return list;
  },
  async git_merge_base({ root, a, b }) {
    checkRev(a);
    checkRev(b);
    await requireDir(root);
    const out = await git(root, ['merge-base', a, b]);
    if (out.code === 0) return out.stdout.toString('utf8').trim();
    if (out.code === 1 && !out.stderr.trim()) throw notFound(`no common ancestor of ${a} and ${b}`);
    throw gitFailure(out);
  },
  async git_branches({ root }) {
    const buf = await gitOk(root, ['for-each-ref', '--format=%(HEAD)%00%(refname)%00%(objectname:short)', 'refs/heads', 'refs/remotes']);
    const list = [];
    for (const line of buf.toString('utf8').split('\n')) {
      const [head, full, sha] = line.split('\0');
      if (!full) continue;
      let name;
      let remote;
      if (full.startsWith('refs/heads/')) {
        name = full.slice('refs/heads/'.length);
        remote = false;
      } else if (full.startsWith('refs/remotes/')) {
        name = full.slice('refs/remotes/'.length);
        if (name.endsWith('/HEAD')) continue;
        remote = true;
      } else continue;
      list.push({ name, remote, current: head === '*', sha });
    }
    list.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || (a.name < b.name ? -1 : 1));
    return list;
  },
  async git_branch_list({ root }) {
    await requireDir(root);
    const format = '--format=%(HEAD)%00%(refname)%00%(objectname:short)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track)%00%(contents:subject)';
    const buf = await gitOk(root, ['for-each-ref', '--sort=-committerdate', format, 'refs/heads', 'refs/remotes']);
    const local = [];
    const remote = [];
    for (const line of buf.toString('utf8').split('\n')) {
      const f = line.split('\0');
      if (f.length < 7) continue;
      const [, full, sha, time, upstream, track, subject] = f;
      if (full.startsWith('refs/heads/')) {
        const { ahead, behind, gone } = parseTrack(track);
        local.push({
          name: full.slice('refs/heads/'.length),
          current: f[0] === '*',
          sha,
          time: parseInt(time, 10) || 0,
          subject,
          upstream: upstream || null,
          ahead,
          behind,
          gone,
        });
      } else if (full.startsWith('refs/remotes/')) {
        const name = full.slice('refs/remotes/'.length);
        if (name.endsWith('/HEAD') || !name.includes('/')) continue;
        remote.push({ name, remote: name.split('/')[0], sha, time: parseInt(time, 10) || 0, subject });
      }
    }
    const sym = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
    const current = sym.code === 0 ? sym.stdout.toString('utf8').trim() : null;
    const headOut = await git(root, ['rev-parse', '-q', '--verify', '--short', 'HEAD']);
    const head = headOut.code === 0 ? headOut.stdout.toString('utf8').trim() : null;
    for (const b of local) b.current = b.name === current;
    return { current, detached: current === null && head !== null, head, local, remote };
  },
  async git_switch({ root, branch, options }) {
    await requireDir(root);
    const o = options ?? {};
    const bad = (s, what) => {
      if (!s || s.startsWith('-') || s.includes('\0') || s.includes('\n')) throw invalid(`bad ${what}: ${JSON.stringify(s)}`);
    };
    const args = ['switch'];
    if (o.track) {
      bad(o.track, 'remote branch');
      args.push('--track');
      if (branch) {
        bad(branch, 'branch name');
        args.push('-c', branch);
      }
      args.push(o.track);
    } else if (o.create) {
      bad(branch, 'branch name');
      args.push('-c', branch);
      if (o.startPoint) {
        bad(o.startPoint, 'start point');
        args.push(o.startPoint);
      }
    } else {
      bad(branch, 'branch name');
      args.push(branch);
    }
    const out = await git(root, args);
    if (out.code === 0) return null;
    const msg = gitText(out);
    const low = msg.toLowerCase();
    if (blockedByChanges(msg)) throw new KError('conflict', msg);
    if (low.includes('already exists')) throw new KError('already_exists', msg);
    if (['invalid reference', 'invalid starting point', 'not a commit', 'unknown revision', 'a branch is expected'].some((t) => low.includes(t))) {
      throw notFound(msg);
    }
    throw gitFailure(out);
  },
  async git_stash_push({ root, message }) {
    await requireDir(root);
    if (String(message).includes('\0')) throw invalid('bad stash message');
    const out = await git(root, ['stash', 'push', '-u', '-m', message]);
    if (out.code !== 0) throw gitFailure(out);
    return { created: !out.stdout.toString('utf8').includes('No local changes to save') };
  },
  async git_stash_pop({ root }) {
    await requireDir(root);
    const list = await gitOk(root, ['stash', 'list', '--format=%gd%x00%gs']);
    let name = null;
    for (const line of list.toString('utf8').split('\n')) {
      const [ref, subject] = line.split('\0');
      if (subject?.includes(STASH_PREFIX)) {
        name = ref;
        break;
      }
    }
    if (!name) throw notFound('there is no stash made by Kestrel');
    const out = await git(root, ['stash', 'pop', name]);
    if (out.code === 0) return null;
    const msg = gitText(out);
    if (blockedByChanges(msg) || msg.toLowerCase().includes('conflict')) throw new KError('conflict', msg);
    throw gitFailure(out);
  },
  async git_fetch({ root }, c) {
    await requireDir(root);
    const key = `${c.id}\0fetch\0${root}`;
    runningFetch.get(key)?.kill();
    const handle = {
      cancelled: false,
      timedOut: false,
      kill() {
        this.cancelled = true;
        this.child?.kill();
      },
    };
    runningFetch.set(key, handle);
    const timer = setTimeout(() => {
      handle.timedOut = true;
      handle.kill();
    }, FETCH_TIMEOUT_MS);
    try {
      const out = await git(root, ['fetch', '--prune', '--all'], { handle });
      if (out.code !== 0) throw gitFailure(out);
      return null;
    } catch (e) {
      if (handle.timedOut) throw new KError('io', `git fetch took longer than ${FETCH_TIMEOUT_MS / 1000} seconds and was stopped.`);
      throw e;
    } finally {
      clearTimeout(timer);
      if (runningFetch.get(key) === handle) runningFetch.delete(key);
    }
  },
  async git_fetch_cancel({ root }, c) {
    runningFetch.get(`${c.id}\0fetch\0${root}`)?.kill();
    return null;
  },
  async git_validate_branch_name({ root, name }) {
    await requireDir(root);
    const bad = (m) => ({ valid: false, message: m });
    if (!String(name).trim()) return bad('Enter a branch name.');
    if (name.startsWith('-') || name.includes('\0') || name.includes('@{') || name === 'HEAD') return bad(`'${name}' is not a valid branch name.`);
    const out = await git(root, ['check-ref-format', '--branch', name]);
    if (out.code !== 0) {
      if (out.stderr.includes('not a git repository')) throw gitFailure(out);
      return bad(`'${name}' is not a valid branch name.`);
    }
    const exists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    if (exists.code === 0) return bad(`A branch named '${name}' already exists.`);
    return { valid: true, message: null };
  },
  async git_log({ root, path: file, limit, skip }) {
    cleanPath(file);
    const top = await topLevel(root);
    const lim = String(Math.min(Math.max(Number(limit) || 1, 1), 1000));
    const skp = String(Math.max(Number(skip) || 0, 0));
    const out = await git(top, [
      '--literal-pathspecs', 'log', '--follow', '-z', '--name-status', '-M', '--no-color', '--no-ext-diff',
      '--date-order', '-n', lim, '--skip', skp, LOG_FORMAT, '--', file,
    ]);
    if (out.code !== 0) {
      if (noCommits(out)) return [];
      throw gitFailure(out);
    }
    return parseLog(out.stdout, file);
  },
  async git_commit_info({ root, sha }) {
    checkRev(sha);
    await requireDir(root);
    const out = await git(root, ['log', '-1', '--no-color', '-z', LOG_FORMAT, sha, '--']);
    if (out.code !== 0) throw gitFailure(out);
    const first = parseLog(out.stdout, '')[0];
    if (!first) throw notFound(`unknown commit: ${sha}`);
    return first;
  },
  async git_blame({ root, path: file, contents }) {
    cleanPath(file);
    const top = await topLevel(root);
    const hasText = typeof contents === 'string';
    const args = ['--literal-pathspecs', 'blame', '--porcelain', '-M'];
    if (hasText) args.push('--contents', '-');
    args.push('--', file);
    const out = await git(top, args, hasText ? { input: contents } : {});
    if (out.code !== 0) {
      const e = out.stderr;
      if (e.includes('no such path') || e.includes('no such ref') || e.includes('does not have any commits')) {
        throw notFound(`not tracked by git: ${file}`);
      }
      throw gitFailure(out);
    }
    return parseBlame(out.stdout);
  },
};

// --- git history (same parsing as crates/kestrel-git/src/history.rs) --------------

const LOG_FORMAT = '--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b';

function cleanPath(p) {
  if (!p || String(p).includes('\0')) throw invalid(`bad path: ${JSON.stringify(p)}`);
}

function noCommits(out) {
  return out.stderr.includes('does not have any commits') || (out.stderr.includes('unknown revision') && out.stderr.includes('HEAD'));
}

function parseLog(buf, askedPath) {
  const list = [];
  // A merge commit has no changed paths with --follow, so it keeps the last known path.
  let current = askedPath;
  for (const rec of buf.toString('utf8').split('\x1e').slice(1)) {
    const f = rec.split('\0');
    if (f.length < 7) continue;
    // After the seven fields come the status (M, R050, ...) and one or two paths.
    const rest = f.slice(7).filter((x) => x.trim() !== '');
    let origPath = null;
    if (rest.length > 0) {
      current = rest[rest.length - 1].replace(/^\n+|\n+$/g, '');
      const status = rest[0].replace(/^\n+|\n+$/g, '');
      if (rest.length === 3 && (status.startsWith('R') || status.startsWith('C'))) origPath = rest[1];
    }
    list.push({
      sha: f[0],
      parents: f[1].split(/\s+/).filter(Boolean),
      authorName: f[2],
      authorEmail: f[3],
      authorTime: parseInt(f[4], 10) || 0,
      subject: f[5],
      body: f[6].trim(),
      path: current,
      origPath,
    });
  }
  return list;
}

function parseBlame(buf) {
  const metas = new Map();
  const ranges = [];
  let cur = null; // { sha, finalLine } of the entry being read
  for (const line of buf.toString('utf8').split('\n')) {
    if (cur) {
      if (line.startsWith('\t')) {
        // The text line ends the entry.
        const { sha, finalLine } = cur;
        const last = ranges[ranges.length - 1];
        if (last && last.sha === sha && last.startLine + last.lineCount === finalLine) last.lineCount += 1;
        else {
          const m = metas.get(sha);
          ranges.push({
            startLine: finalLine,
            lineCount: 1,
            sha,
            author: m?.author ?? '',
            authorEmail: (m?.mail ?? '').replace(/^<|>$/g, ''),
            authorTime: m?.time ?? 0,
            summary: m?.summary ?? '',
            previousSha: m?.previous?.[0] ?? null,
            previousPath: m?.previous?.[1] ?? null,
            uncommitted: /^0+$/.test(sha),
            boundary: m?.boundary ?? false,
            path: m?.path ?? '',
          });
        }
        cur = null;
        continue;
      }
      let meta = metas.get(cur.sha);
      if (!meta) {
        meta = { author: '', mail: '', time: 0, summary: '', previous: null, boundary: false, path: '' };
        metas.set(cur.sha, meta);
      }
      const i = line.indexOf(' ');
      const key = i < 0 ? line : line.slice(0, i);
      const val = i < 0 ? '' : line.slice(i + 1);
      if (key === 'author') meta.author = val;
      else if (key === 'author-mail') meta.mail = val;
      else if (key === 'author-time') meta.time = parseInt(val, 10) || 0;
      else if (key === 'summary') meta.summary = val;
      else if (key === 'previous') {
        const j = val.indexOf(' ');
        if (j >= 0) meta.previous = [val.slice(0, j), val.slice(j + 1)];
      } else if (key === 'boundary') meta.boundary = true;
      else if (key === 'filename') meta.path = val;
    } else {
      // Header: <sha> <orig line> <final line> [<group size>]
      const f = line.split(' ');
      if (f.length >= 3 && /^[0-9a-fA-F]{40,}$/.test(f[0])) cur = { sha: f[0], finalLine: parseInt(f[2], 10) || 0 };
    }
  }
  return ranges;
}

/** `git_show` returns raw bytes: a flag byte (1 = exists) and then the content. */
async function gitShow({ root, rev, path: file }) {
  checkRev(rev);
  await requireDir(root);
  const out = await git(root, ['cat-file', 'blob', `${rev}:${file}`]);
  if (out.code === 0) return Buffer.concat([Buffer.from([1]), out.stdout]);
  if (out.stderr.includes('not a git repository')) throw gitFailure(out);
  if (rev.startsWith(':')) return Buffer.from([0]);
  const tree = await git(root, ['rev-parse', '-q', '--verify', `${rev}^{tree}`]);
  if (tree.code === 0 || rev === 'HEAD') return Buffer.from([0]);
  throw invalid(`unknown revision: ${rev}`);
}

// --- Markdown ----------------------------------------------------------------
// A small fallback for the Rust renderer (comrak). It covers common GitHub
// Markdown. Block elements carry data-sourcepos="line:col-line:col".

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderInline(src) {
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = src;
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, ch) => hold(escHtml(ch)));
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code>${escHtml(code.replace(/\n/g, ' ').replace(/^ (.*[^ ].*) $/, '$1'))}</code>`));
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, u) => hold(`<a href="${escHtml(u)}">${escHtml(u)}</a>`));
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, (m) => hold(m));
  s = s.replace(/(?: {2,}|\\)\n/g, () => hold('<br />\n'));
  s = escHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, alt, url, title) =>
    hold(`<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ''} />`),
  );
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, text, url, title) =>
    hold(`<a href="${url}"${title ? ` title="${title}"` : ''}>${renderInline(unhold(text, stash))}</a>`),
  );
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, (_, pre, url) => `${pre}${hold(`<a href="${url}">${url}</a>`)}`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)__(?=\S)([\s\S]*?\S)__(?=\W|$)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>');
  s = s.replace(/(^|\W)_(?=[^\s_])([\s\S]*?[^\s_])_(?=\W|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return unhold(s, stash);
}

function unhold(s, stash) {
  let prev;
  do {
    prev = s;
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  } while (s !== prev && s.includes('\u0000'));
  return s;
}

const RE_FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`]*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RE_HR = /^ {0,3}([-*_])(?: ?\1){2,}\s*$/;
const RE_BULLET = /^( {0,3})([-*+])( +|$)/;
const RE_ORDERED = /^( {0,3})(\d{1,9})([.)])( +|$)/;
const RE_HTML = /^ {0,3}<(\/?[a-zA-Z][\w-]*|!--)/;
const RE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, '|'));
}

function slugify(text, seen) {
  const plain = text.replace(/[`*_~[\]()]|<[^>]+>/g, '');
  let slug = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
  const n = seen.get(slug) ?? 0;
  seen.set(slug, n + 1);
  if (n > 0) slug += `-${n}`;
  return slug;
}

function startsBlock(line) {
  if (RE_FENCE.test(line) || RE_HR.test(line) || /^ {0,3}#{1,6}(\s|$)/.test(line) || /^ {0,3}>/.test(line)) return true;
  if (RE_BULLET.test(line)) return true;
  const o = RE_ORDERED.exec(line);
  return !!o && o[2] === '1';
}

/** Renders lines to HTML. `line0` is the 1-based number of lines[0]; `col0` is the column offset. */
function renderBlocks(lines, line0, col0, seen, tight = false) {
  const out = [];
  const pos = (a, b, indent = 0) => `data-sourcepos="${line0 + a}:${col0 + 1 + indent}-${line0 + b}:${col0 + Math.max(lines[b].length, 1)}"`;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    // Fenced code.
    if ((m = RE_FENCE.exec(line))) {
      const fence = m[2];
      const info = m[3].trim().split(/\s+/)[0];
      let j = i + 1;
      const body = [];
      while (j < lines.length && !(lines[j].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(lines[j]))) {
        body.push(lines[j].slice(Math.min(m[1].length, lines[j].length - lines[j].trimStart().length)));
        j++;
      }
      const end = Math.min(j, lines.length - 1);
      const cls = info ? ` class="language-${escHtml(info)}"` : '';
      out.push(`<pre ${pos(i, end)}><code${cls}>${escHtml(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>\n`);
      i = j + 1;
      continue;
    }
    // Heading.
    if ((m = RE_ATX.exec(line))) {
      const level = m[1].length;
      const text = m[2] ?? '';
      const id = slugify(text, seen);
      out.push(`<h${level} ${pos(i, i)}><a href="#${id}" aria-hidden="true" class="anchor" id="${id}"></a>${renderInline(text)}</h${level}>\n`);
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      out.push(`<hr ${pos(i, i)} />\n`);
      i++;
      continue;
    }
    // Block quote.
    if (/^ {0,3}>/.test(line)) {
      let j = i;
      const inner = [];
      while (j < lines.length && lines[j].trim() && (/^ {0,3}>/.test(lines[j]) || (j > i && !startsBlock(lines[j])))) {
        inner.push(lines[j].replace(/^ {0,3}> ?/, ''));
        j++;
      }
      out.push(`<blockquote ${pos(i, j - 1)}>\n${renderBlocks(inner, line0 + i, col0 + 2, seen)}</blockquote>\n`);
      i = j;
      continue;
    }
    // Table.
    if (line.includes('|') && i + 1 < lines.length && RE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      if (head.length === delim.length) {
        const align = delim.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null));
        const cell = (tag, txt, k) => `<${tag}${align[k] ? ` align="${align[k]}"` : ''}>${renderInline(txt)}</${tag}>`;
        let j = i + 2;
        const rows = [];
        while (j < lines.length && lines[j].trim() && !startsBlock(lines[j])) {
          const cells = splitRow(lines[j]);
          rows.push(`<tr ${pos(j, j)}>\n${head.map((_, k) => cell('td', cells[k] ?? '', k)).join('\n')}\n</tr>\n`);
          j++;
        }
        const thead = `<thead>\n<tr ${pos(i, i)}>\n${head.map((t, k) => cell('th', t, k)).join('\n')}\n</tr>\n</thead>\n`;
        out.push(`<table ${pos(i, j - 1)}>\n${thead}${rows.length ? `<tbody>\n${rows.join('')}</tbody>\n` : ''}</table>\n`);
        i = j;
        continue;
      }
    }
    // Lists.
    const bullet = RE_BULLET.exec(line);
    const ordered = RE_ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      const marker = (l) => (isOrdered ? RE_ORDERED.exec(l) : RE_BULLET.exec(l));
      const sameType = (l) => {
        const mm = marker(l);
        return mm && (isOrdered ? mm[3] === ordered[3] : mm[2] === bullet[2]);
      };
      const items = [];
      let loose = false;
      let j = i;
      while (j < lines.length) {
        const mm = marker(lines[j]);
        if (!mm || !sameType(lines[j])) break;
        const markerLen = mm[0].length;
        const spaces = isOrdered ? mm[4].length : mm[3].length;
        const contentIndent = spaces > 4 || spaces === 0 ? markerLen - spaces + 1 : markerLen;
        const body = [lines[j].slice(contentIndent)];
        const start = j;
        j++;
        let blankSeen = false;
        while (j < lines.length) {
          const l = lines[j];
          if (!l.trim()) {
            blankSeen = true;
            body.push('');
            j++;
            continue;
          }
          const indent = l.length - l.trimStart().length;
          if (indent >= contentIndent) {
            body.push(l.slice(contentIndent));
          } else if (!blankSeen && !startsBlock(l) && !marker(l)) {
            body.push(l.trimStart());
          } else break;
          blankSeen = false;
          j++;
        }
        while (body.length > 1 && !body[body.length - 1].trim()) {
          body.pop();
          j--;
        }
        items.push({ body, start, end: j - 1, contentIndent });
        // A blank line between items makes the list loose.
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k > j && k < lines.length && marker(lines[k]) && sameType(lines[k])) {
          loose = true;
          j = k;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const startAttr = isOrdered && +ordered[2] !== 1 ? ` start="${ordered[2]}"` : '';
      const li = items.map((it) => {
        let first = it.body[0];
        let task = '';
        const t = /^\[([ xX])\]\s+/.exec(first);
        if (t) {
          task = `<input type="checkbox" ${t[1] === ' ' ? '' : 'checked="" '}disabled="" /> `;
          it.body[0] = first.slice(t[0].length);
        }
        let inner = renderBlocks(it.body, line0 + it.start, col0 + it.contentIndent, seen, !loose);
        if (task) inner = /^<p /.test(inner) ? inner.replace(/^<p [^>]*>/, (p) => p + task) : task + inner;
        return `<li ${pos(it.start, it.end)}>${loose || /<(ul|ol|pre|blockquote|table)\b/.test(inner.slice(0, 5)) ? '\n' : ''}${inner}</li>\n`;
      });
      out.push(`<${tag}${startAttr} ${pos(i, j - 1)}>\n${li.join('')}</${tag}>\n`);
      i = j;
      continue;
    }
    // HTML block.
    if (RE_HTML.test(line)) {
      let j = i;
      const raw = [];
      while (j < lines.length && lines[j].trim()) raw.push(lines[j++]);
      out.push(raw.join('\n') + '\n');
      i = j;
      continue;
    }
    // Indented code.
    if (/^( {4}|\t)/.test(line)) {
      let j = i;
      const body = [];
      while (j < lines.length && (/^( {4}|\t)/.test(lines[j]) || !lines[j].trim())) body.push(lines[j++].replace(/^( {4}|\t)/, ''));
      while (body.length && !body[body.length - 1].trim()) {
        body.pop();
        j--;
      }
      out.push(`<pre ${pos(i, j - 1)}><code>${escHtml(body.join('\n'))}\n</code></pre>\n`);
      i = j;
      continue;
    }
    // Paragraph (or setext heading).
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !startsBlock(lines[j]) && !/^ {0,3}(=+|-+)\s*$/.test(lines[j])) j++;
    const para = lines.slice(i, j);
    const setext = j < lines.length ? /^ {0,3}(=+|-+)\s*$/.exec(lines[j]) : null;
    if (setext) {
      const level = setext[1][0] === '=' ? 1 : 2;
      const text = para.map((l) => l.trim()).join('\n');
      const id = slugify(text, seen);
      out.push(`<h${level} ${pos(i, j)}><a href="#${id}" aria-hidden="true" class="anchor" id="${id}"></a>${renderInline(text)}</h${level}>\n`);
      i = j + 1;
      continue;
    }
    const html = renderInline(para.map((l) => l.trim()).join('\n').replace(/ +\n/g, (s) => (s.length >= 3 ? s : '\n')));
    out.push(tight ? `${html}\n` : `<p ${pos(i, j - 1)}>${html}</p>\n`);
    i = j;
  }
  return out.join('');
}

function renderMarkdown(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return renderBlocks(src.split('\n'), 1, 0, new Map());
}

// --- lsp_* -------------------------------------------------------------------

const lspCommands = {
  async lsp_start() {
    throw new KError('server_missing', 'language servers are not available in the browser dev bridge');
  },
  async lsp_send() {
    return null;
  },
  async lsp_stop() {
    return null;
  },
  async lsp_logs() {
    return [];
  },
  async lsp_which() {
    return null;
  },
  async lsp_find_root({ file, markers, workspaceRoot }) {
    const top = path.resolve(workspaceRoot);
    let dir = path.dirname(path.resolve(file));
    for (;;) {
      if (dir !== top && !dir.startsWith(top + path.sep)) return null;
      for (const m of markers) if (await exists(path.join(dir, m))) return dir;
      if (dir === top) return null;
      dir = path.dirname(dir);
    }
  },
  async lsp_read_lines({ requests }) {
    return Promise.all(
      requests.map(async (r) => {
        let all = [];
        try {
          const st = await fsp.stat(r.path);
          if (st.size <= 8 * 1024 * 1024) all = (await fsp.readFile(r.path, 'utf8')).split(/\r?\n/);
        } catch {}
        return r.lines.map((n) => (all[n] ?? '').trim().slice(0, 300));
      }),
    );
  },
};

// --- md_* and preview_* ------------------------------------------------------

const liveDocs = new Map();

const previewCommands = {
  async md_render({ text }) {
    return renderMarkdown(text ?? '');
  },
  // The real app drops raw HTML (comrak safe mode). Here we escape the whole
  // text, which is safe and good enough for dev tests.
  async md_render_safe({ text }) {
    const esc = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<p>${esc.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  },
  async preview_allow_parent() {
    return null;
  },
  async preview_set_live({ id, html }) {
    liveDocs.set(id, Buffer.from(html, 'utf8'));
    return null;
  },
  async preview_drop_live({ id }) {
    liveDocs.delete(id);
    return null;
  },
};

const MIME = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
};
const PLAIN = new Set(['ts', 'tsx', 'rs', 'kt', 'java', 'toml', 'yaml', 'yml', 'log', 'py', 'sh', 'c', 'h', 'cpp', 'go', 'rb']);

function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (PLAIN.has(ext)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Serves a local file (the dev replacement for the `preview://` protocol). */
const CORS_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'woff', 'woff2', 'ttf', 'otf']);

async function serveFile(req, res, url) {
  const reply = (status, text, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...headers });
    res.end(text);
  };
  let file;
  try {
    file = '/' + decodeURIComponent(url.pathname.slice((PREFIX + 'file/').length));
  } catch {
    return reply(400, 'bad path');
  }
  const liveId = url.searchParams.get('kestrel-live');
  if (liveId) {
    const body = liveDocs.get(liveId);
    if (!body) return reply(404, 'no live document');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
    });
    return res.end(body);
  }
  let st;
  try {
    st = await fsp.stat(file);
  } catch (e) {
    return reply(e.code === 'EACCES' ? 403 : 404, e.code === 'EACCES' ? 'permission denied' : 'not found');
  }
  if (!st.isFile()) return reply(404, 'not a file');
  const headers = {
    'content-type': mimeFor(file),
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    vary: 'Origin',
  };
  // Same rule as the Rust protocol: only module scripts and fonts need CORS.
  // They get "null", the origin of a previewed page. All other files get no header.
  if (CORS_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase())) headers['access-control-allow-origin'] = 'null';
  const range = /^bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
  if (range && st.size > 0) {
    let start;
    let end;
    if (range[1] === '') {
      start = Math.max(0, st.size - Number(range[2]));
      end = st.size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
    }
    if (!(start <= end) || start >= st.size) return reply(416, '', { 'content-range': `bytes */${st.size}` });
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  fs.createReadStream(file).pipe(res);
}

// --- db_* --------------------------------------------------------------------

// The database commands run in real Rust code. `crates/kestrel-db/examples/dev_http.rs`
// is a small HTTP server (127.0.0.1:1435) with the same DbManager as the app.
// Here we only pass each `db_*` call on to it. Start it with:
//   cargo run -p kestrel-db --example dev_http
const DB_HTTP_HOST = '127.0.0.1';
const DB_HTTP_PORT = Number(process.env.KESTREL_DB_DEV_PORT || 1435);
const DB_START_HINT = 'start: cargo run -p kestrel-db --example dev_http';
const DB_COMMANDS = [
  'db_test',
  'db_connect',
  'db_disconnect',
  'db_execute',
  'db_cancel',
  'db_set_autocommit',
  'db_commit',
  'db_rollback',
  'db_use',
  'db_databases',
  'db_objects',
  'db_columns',
  'db_indexes',
  'db_ddl',
  'db_completion_schema',
  'db_password_set',
  'db_password_delete',
  'db_password_exists',
  'db_idea_list',
  'db_export_csv',
];

/** Sends one command to the dev_http server. No timeout: a query can run for a long time. */
function forwardDb(cmd, args) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(args ?? {}), 'utf8');
    const req = http.request(
      {
        host: DB_HTTP_HOST,
        port: DB_HTTP_PORT,
        path: `/invoke/${cmd}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('error', (e) => reject(new KError('db_connect', `dev_http: ${e.message}`)));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new KError('internal', `dev_http sent an answer that is not JSON (status ${res.statusCode})`));
          }
          if (res.statusCode === 200) return resolve(json);
          reject(new KError(String(json?.code ?? 'internal'), String(json?.message ?? `dev_http status ${res.statusCode}`)));
        });
      },
    );
    req.on('error', (e) => {
      if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET' || e?.code === 'EHOSTUNREACH') {
        return reject(new KError('db_connect', DB_START_HINT));
      }
      reject(new KError('db_connect', `dev_http: ${e?.message ?? e}`));
    });
    req.end(body);
  });
}

const dbCommands = Object.fromEntries(DB_COMMANDS.map((cmd) => [cmd, (args) => forwardDb(cmd, args)]));

// --- code_* ------------------------------------------------------------------

// The code index (class diagram, find usages) runs in real Rust code.
// `crates/kestrel-code/examples/dev_http.rs` is a small HTTP server
// (127.0.0.1:1436) with the same CodeManager as the app. Start it with:
//   cargo run -p kestrel-code --example dev_http
const CODE_HTTP_HOST = '127.0.0.1';
const CODE_HTTP_PORT = Number(process.env.KESTREL_CODE_DEV_PORT || 1436);
const CODE_START_HINT = 'start: cargo run -p kestrel-code --example dev_http';
const CODE_COMMANDS = [
  'code_index_status',
  'code_index_update',
  'code_index_drop',
  'code_cancel',
  'code_diagram',
  'code_usages',
  'code_callers',
];

/** Sends one command to the dev_http server. No timeout: an index build can take long. */
function forwardCode(cmd, args) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(args ?? {}), 'utf8');
    const req = http.request(
      {
        host: CODE_HTTP_HOST,
        port: CODE_HTTP_PORT,
        path: `/invoke/${cmd}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('error', (e) => reject(new KError('internal', `code dev_http: ${e.message}`)));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new KError('internal', `code dev_http sent an answer that is not JSON (status ${res.statusCode})`));
          }
          if (res.statusCode === 200) return resolve(json);
          reject(new KError(String(json?.code ?? 'internal'), String(json?.message ?? `code dev_http status ${res.statusCode}`)));
        });
      },
    );
    req.on('error', (e) => {
      if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET' || e?.code === 'EHOSTUNREACH') {
        return reject(new KError('internal', CODE_START_HINT));
      }
      reject(new KError('internal', `code dev_http: ${e?.message ?? e}`));
    });
    req.end(body);
  });
}

const codeCommands = Object.fromEntries(CODE_COMMANDS.map((cmd) => [cmd, (args) => forwardCode(cmd, args)]));

// --- gh_* --------------------------------------------------------------------

// The GitHub commands run the `gh` program from Node, with the same rules as
// crates/kestrel-gh (docs/DESIGN.md section 12.3). Kestrel never sees a token.
// For tests, KESTREL_GH_PROGRAM can point to scripts/fake-gh/gh.mjs.
const GH_TIMEOUT_MS = 30_000;
const GH_LONG_TIMEOUT_MS = 120_000;
const GH_STATUS_TTL_MS = 10_000;
const GH_MAX_FILE_BYTES = 5 * 1024 * 1024;
const ghErr = (m) => new KError('gh_error', m);

/** Running calls: "<client>:<id>" -> { cancelled, child }. */
const ghRunning = new Map();
let ghStatusCache = null;

/** Never logs bodies or answers: only the command, host, method, path without query, status and time. */
function ghLog(...parts) {
  if (process.env.KESTREL_GH_LOG) console.debug('[gh]', ...parts);
}

/** Runs `gh` and collects its output. Kills it after the timeout or on cancel. */
function ghRun(args, { cwd, input, timeout = GH_TIMEOUT_MS, handle } = {}) {
  return new Promise((resolve, reject) => {
    if (handle?.cancelled) return reject(new KError('cancelled', 'cancelled'));
    const program = process.env.KESTREL_GH_PROGRAM || 'gh';
    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (handle) handle.child = child;
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') reject(new KError('gh_missing', 'gh is not installed or not in PATH'));
      else reject(toKError(e));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (handle?.cancelled) return reject(new KError('cancelled', 'cancelled'));
      if (timedOut) return reject(ghErr(`gh did not answer within ${timeout / 1000} s`));
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// ---- Parsing (same rules as crates/kestrel-gh/src/lib.rs) ----

function ghParseAccounts(buf) {
  let v;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw ghErr('gh auth status gave no JSON');
  }
  const accounts = [];
  for (const [host, entries] of Object.entries(v?.hosts ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      // Only these fields are copied, so a `token` field never goes on.
      const scopes = Array.isArray(e.scopes)
        ? e.scopes.filter((x) => typeof x === 'string')
        : typeof e.scopes === 'string'
          ? e.scopes.split(',').map((x) => x.trim()).filter(Boolean)
          : [];
      const account = {
        host: typeof e.host === 'string' ? e.host : host,
        login: typeof e.login === 'string' ? e.login : '',
        active: e.active === true,
        state: e.state === 'success' || e.state === 'timeout' ? e.state : 'error',
        scopes,
      };
      if (typeof e.error === 'string' && e.error) account.error = e.error;
      accounts.push(account);
    }
  }
  return accounts;
}

/** Splits `HTTP/2.0 200 OK`, the headers, an empty line and the body. Null when there is no status line. */
function ghSplitResponse(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== 'HTTP/') return null;
  const a = buf.indexOf('\r\n\r\n');
  const b = buf.indexOf('\n\n');
  let end = buf.length;
  let skip = 0;
  if (a >= 0 && (b < 0 || a <= b)) [end, skip] = [a, 4];
  else if (b >= 0) [end, skip] = [b, 2];
  const lines = buf.subarray(0, end).toString('utf8').split(/\r?\n/);
  const status = Number(lines[0].split(/\s+/)[1]);
  if (!Number.isInteger(status)) return null;
  const headers = lines
    .slice(1)
    .filter((l) => l.includes(':'))
    .map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]);
  return { status, headers, body: buf.subarray(end + skip) };
}

/** The error text of a GitHub JSON answer: `message`, then `errors`. */
function ghMessage(buf) {
  let v;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  let text = typeof v.message === 'string' ? v.message : '';
  let details = '';
  if (Array.isArray(v.errors)) {
    details = v.errors
      .map((e) =>
        typeof e === 'string'
          ? e
          : e && typeof e === 'object'
            ? (e.message ?? ['resource', 'field', 'code'].map((k) => e[k]).filter((x) => typeof x === 'string').join(' '))
            : '',
      )
      .filter(Boolean)
      .join('; ');
  } else if (typeof v.errors === 'string') details = v.errors;
  if (details) text = text ? `${text}: ${details}` : details;
  return text || null;
}

const GH_REASONS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

function ghStatusError(status, body) {
  const message = `HTTP ${status}: ${ghMessage(body) ?? GH_REASONS[status] ?? 'Error'}`;
  if (status === 401) return new KError('gh_auth', message);
  if (status === 404) return new KError('not_found', message);
  if (status === 403 && body.toString('utf8').includes('too_large')) return new KError('too_large', message);
  return ghErr(message);
}

function ghFirstLine(stderr) {
  const line = (stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/^gh: /, '');
  const i = line.lastIndexOf(' (HTTP ');
  return (i >= 0 ? line.slice(0, i) : line).slice(0, 500);
}

/** An error from the text `gh` wrote to stderr. */
function ghFailureMessage(out) {
  const text = out.stderr.trim().replace(/^gh: /, '').slice(0, 1000);
  const all = out.stderr.toLowerCase();
  if (all.includes('gh auth login') || all.includes('not logged in')) return new KError('gh_auth', text || 'not logged in');
  return ghErr(text || `gh exited with code ${out.code}`);
}

/** An error from a failed `gh api` run that has no status line in its output. */
function ghFailureFor(out) {
  const m = /\(HTTP (\d{3})\)/.exec(out.stderr);
  if (!m) return ghFailureMessage(out);
  const status = Number(m[1]);
  const e = ghStatusError(status, out.stdout);
  if (ghMessage(out.stdout) === null) {
    const line = ghFirstLine(out.stderr);
    if (line) e.message = `HTTP ${status}: ${line}`;
  }
  return e;
}

// ---- Input checks ----

const GH_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const GH_PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/;
const GH_QUERY_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%?[\]]*$/;

function ghCheckMethod(m) {
  const method = String(m ?? 'GET').trim().toUpperCase();
  if (!GH_METHODS.includes(method)) throw invalid(`unsupported HTTP method: ${method}`);
  return method;
}

function ghCheckPath(p) {
  if (typeof p !== 'string' || p === '') throw invalid('the path is empty');
  if (p.includes('://')) throw invalid('the path must not be a full address');
  if (p.startsWith('/')) throw invalid('the path must not start with /');
  if (p.startsWith('-')) throw invalid('the path must not start with -');
  const q = p.indexOf('?');
  const pathPart = q < 0 ? p : p.slice(0, q);
  if (!GH_PATH_CHARS.test(pathPart)) throw invalid('the path has a character that is not allowed');
  if (q >= 0 && !GH_QUERY_CHARS.test(p.slice(q + 1))) throw invalid('the query has a character that is not allowed');
  for (const seg of pathPart.split('/')) {
    const plain = seg.replace(/%2e/gi, '.');
    if (plain === '..' || plain === '.') throw invalid('the path must not have . or .. segments');
  }
}

function ghCheckLogin(l) {
  if (typeof l !== 'string' || !/^[A-Za-z0-9_.][A-Za-z0-9\-_.]{0,99}$/.test(l)) throw invalid(`not a valid login: ${l}`);
}

function ghCheckName(n) {
  if (typeof n !== 'string' || n === '.' || n === '..' || !/^[A-Za-z0-9\-_.]{1,200}$/.test(n)) {
    throw invalid(`not a valid owner or repository name: ${n}`);
  }
}

const ghEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// ---- Status and hosts ----

async function ghStatus(handle) {
  let version;
  try {
    const out = await ghRun(['--version'], { handle });
    version = /^gh version (\S+)/.exec(out.stdout.toString('utf8'))?.[1] ?? null;
  } catch (e) {
    if (e.code === 'gh_missing') return { installed: false, version: null, accounts: [] };
    throw e;
  }
  const out = await ghRun(['auth', 'status', '--json', 'hosts'], { handle });
  if (out.code !== 0) throw ghFailureMessage(out);
  const status = { installed: true, version, accounts: ghParseAccounts(out.stdout) };
  ghStatusCache = { at: Date.now(), status };
  return status;
}

/** Checks that the host has a `gh` login. Returns the host as `gh` writes it. */
async function ghLoginHost(host, handle) {
  const want = String(host ?? '').trim().toLowerCase();
  const find = (s) => s.accounts.find((a) => a.host.toLowerCase() === want)?.host;
  let status = ghStatusCache && Date.now() - ghStatusCache.at < GH_STATUS_TTL_MS ? ghStatusCache.status : await ghStatus(handle);
  if (!status.installed) throw new KError('gh_missing', 'gh is not installed or not in PATH');
  const found = find(status);
  if (found) return found;
  // The user may have logged in a moment ago. Look once more.
  status = await ghStatus(handle);
  const again = find(status);
  if (!again) throw invalid(`no gh login for the host: ${host}`);
  return again;
}

async function ghAuthChange(verb, { host, login }, handle) {
  ghCheckLogin(login);
  const h = await ghLoginHost(host, handle);
  const out = await ghRun(['auth', verb, '--hostname', h, '--user', login], { handle });
  ghStatusCache = null;
  ghLog('auth', verb, h, out.code === 0 ? 'ok' : 'failed');
  if (out.code !== 0) throw ghFailureMessage(out);
  return null;
}

// ---- gh api ----

/** Runs `gh api` and checks the HTTP status. Returns { status, headers, body }. */
async function ghExecApi(host, method, apiPath, { extra = [], body, paginate = false, handle }) {
  const started = Date.now();
  const args = ['api', '--hostname', host, '-X', method, ...extra, ...(paginate ? ['--paginate', '--slurp'] : ['-i'])];
  if (body !== undefined) args.push('--input', '-');
  args.push(apiPath);
  const logPath = apiPath.split('?')[0];
  let status = 'error';
  try {
    const out = await ghRun(args, { input: body, timeout: paginate ? GH_LONG_TIMEOUT_MS : GH_TIMEOUT_MS, handle });
    if (paginate) {
      if (out.code !== 0) throw ghFailureFor(out);
      status = 200;
      return { status: 200, headers: [], body: out.stdout };
    }
    const res = ghSplitResponse(out.stdout);
    if (!res) throw ghFailureFor(out);
    status = res.status;
    if (res.status >= 200 && res.status < 400) return res;
    throw ghStatusError(res.status, res.body);
  } catch (e) {
    if (status === 'error') status = e?.code ?? 'error';
    throw e;
  } finally {
    ghLog('api', host, method, logPath, status, `${Date.now() - started} ms`);
  }
}

function ghFlatten(v) {
  if (!Array.isArray(v)) return v;
  return v.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

async function ghApi({ request }, handle) {
  const r = request ?? {};
  const method = ghCheckMethod(r.method);
  ghCheckPath(r.path);
  const paginate = r.paginate === true;
  const hasBody = r.body !== undefined && r.body !== null;
  if (paginate && method !== 'GET') throw invalid('paginate works with GET only');
  if (hasBody && method === 'GET') throw invalid('a GET request has no body');
  const host = await ghLoginHost(r.host, handle);
  const res = await ghExecApi(host, method, r.path, { body: hasBody ? JSON.stringify(r.body) : undefined, paginate, handle });
  if (res.body.toString('utf8').trim() === '') return null;
  let value;
  try {
    value = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw ghErr(`HTTP ${res.status}: the answer is not JSON`);
  }
  return paginate ? ghFlatten(value) : value;
}

function ghGraphqlMessages(errors) {
  if (Array.isArray(errors)) return errors.map((e) => (typeof e === 'string' ? e : e?.message)).filter((x) => typeof x === 'string').join('; ');
  return typeof errors === 'string' ? errors : '';
}

async function ghGraphql({ host, query, variables }, handle) {
  const started = Date.now();
  const h = await ghLoginHost(host, handle);
  const out = await ghRun(['api', 'graphql', '--hostname', h, '--input', '-'], {
    input: JSON.stringify({ query, variables: variables ?? {} }),
    handle,
  });
  ghLog('graphql', h, out.code, `${Date.now() - started} ms`);
  let value = null;
  try {
    value = JSON.parse(out.stdout.toString('utf8'));
  } catch {}
  const text = ghGraphqlMessages(value?.errors);
  if (text) throw ghErr(text);
  if (out.code !== 0) throw ghFailureFor(out);
  if (value === null) throw ghErr('the answer is not JSON');
  return value.data ?? null;
}

async function ghFileText({ host, owner, repo, path: filePath, ref }, handle) {
  ghCheckName(owner);
  ghCheckName(repo);
  const p = String(filePath ?? '').replace(/^\/+/, '');
  if (!p || p.split('/').some((s) => s === '' || s === '.' || s === '..')) throw invalid('not a valid file path');
  if (!ref || String(ref).startsWith('-')) throw invalid('not a valid reference');
  const apiPath = `repos/${owner}/${repo}/contents/${p.split('/').map(ghEncode).join('/')}?ref=${ghEncode(String(ref))}`;
  const h = await ghLoginHost(host, handle);
  const res = await ghExecApi(h, 'GET', apiPath, { extra: ['-H', 'Accept: application/vnd.github.raw'], handle });
  const length = Number(res.headers.find(([k]) => k === 'content-length')?.[1]);
  if (res.body.length > GH_MAX_FILE_BYTES || length > GH_MAX_FILE_BYTES) throw new KError('too_large', 'the file is larger than 5 MB');
  if (res.body.includes(0)) throw new KError('binary', 'the file is binary');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(res.body);
  } catch {
    throw new KError('binary', 'the file is not UTF-8 text');
  }
}

// ---- Remotes of a folder ----

/** Parses one remote URL into { host, owner, name } (same forms as kestrel-gh). */
function ghParseRemoteUrl(url) {
  url = url.trim();
  let hostPart;
  let rest;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)\/(.*)$/.exec(url);
  if (m) {
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(m[1].toLowerCase())) return null;
    [hostPart, rest] = [m[2], m[3]];
  } else {
    const i = url.indexOf(':');
    if (i < 0) return null;
    hostPart = url.slice(0, i);
    rest = url.slice(i + 1);
    if (!hostPart || hostPart.includes('/') || hostPart.includes('\\') || hostPart.length === 1) return null;
  }
  const hostPort = hostPart.slice(hostPart.lastIndexOf('@') + 1);
  const host = hostPort.startsWith('[') ? hostPort.slice(1, hostPort.indexOf(']')) : hostPort.split(':')[0];
  if (!host) return null;
  let p = rest.replace(/^\/+|\/+$/g, '');
  if (p.endsWith('.git')) p = p.slice(0, -4);
  const parts = p.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { host: host.toLowerCase(), owner: parts[0], name: parts[1] };
}

/** `git remote -v` text to a list. `origin` first, each remote once. */
function ghParseRemotes(text) {
  const seen = new Set();
  const list = [];
  for (const line of text.split('\n')) {
    const [remote, url] = line.trim().split(/\s+/);
    if (!remote || !url || seen.has(remote)) continue;
    const parsed = ghParseRemoteUrl(url);
    if (!parsed) continue;
    seen.add(remote);
    list.push({ ...parsed, remote });
  }
  return [...list.filter((r) => r.remote === 'origin'), ...list.filter((r) => r.remote !== 'origin')];
}

async function ghRepoOf({ root }, handle) {
  await requireDir(root);
  let out;
  try {
    out = await run('git', ['remote', '-v'], { cwd: root, handle });
  } catch (e) {
    if (e.code === 'git_missing') return null;
    throw e;
  }
  if (out.code !== 0) return null;
  const remotes = ghParseRemotes(out.stdout.toString('utf8'));
  if (remotes.length === 0) return null;
  const status = ghStatusCache && Date.now() - ghStatusCache.at < GH_STATUS_TTL_MS ? ghStatusCache.status : await ghStatus(handle);
  const hit = remotes.find((r) => status.accounts.some((a) => a.host.toLowerCase() === r.host));
  return hit ? { host: hit.host, owner: hit.owner, name: hit.name, remote: hit.remote } : null;
}

async function ghPrCheckout({ root, number }, handle) {
  if (!Number.isInteger(number) || number <= 0) throw invalid('not a valid pull request number');
  await requireDir(root);
  const started = Date.now();
  const out = await ghRun(['pr', 'checkout', String(number)], { cwd: root, timeout: GH_LONG_TIMEOUT_MS, handle });
  ghLog('pr checkout', out.code, `${Date.now() - started} ms`);
  if (out.code !== 0) throw ghFailureMessage(out);
  return [out.stdout.toString('utf8').trim(), out.stderr.trim()].filter(Boolean).join('\n');
}

/** Runs a handler with a cancel handle that `gh_cancel` can reach (keyed by browser tab and id). */
async function ghCall(c, id, fn) {
  const handle = { cancelled: false, child: null };
  const key = id === undefined ? null : `${c.id}:${id}`;
  if (key) {
    ghRunning.get(key)?.child?.kill();
    if (ghRunning.has(key)) ghRunning.get(key).cancelled = true;
    ghRunning.set(key, handle);
  }
  try {
    return await fn(handle);
  } finally {
    if (key && ghRunning.get(key) === handle) ghRunning.delete(key);
  }
}

const ghCommands = {
  gh_status: (_a, c) => ghCall(c, undefined, (h) => ghStatus(h)),
  gh_switch: (a, c) => ghCall(c, undefined, (h) => ghAuthChange('switch', a, h)),
  gh_logout: (a, c) => ghCall(c, undefined, (h) => ghAuthChange('logout', a, h)),
  gh_api: (a, c) => ghCall(c, a.id, (h) => ghApi(a, h)),
  gh_graphql: (a, c) => ghCall(c, a.id, (h) => ghGraphql(a, h)),
  gh_file_text: (a, c) => ghCall(c, a.id, (h) => ghFileText(a, h)),
  gh_repo_of: (a, c) => ghCall(c, undefined, (h) => ghRepoOf(a, h)),
  gh_pr_checkout: (a, c) => ghCall(c, undefined, (h) => ghPrCheckout(a, h)),
  async gh_cancel({ id }, c) {
    const h = ghRunning.get(`${c.id}:${id}`);
    if (h) {
      h.cancelled = true;
      h.child?.kill();
    }
    return null;
  },
};

// --- Dispatch ----------------------------------------------------------------

const commands = {
  ...appCommands,
  ...fsCommands,
  ...wsCommands,
  ...searchCommands,
  ...gitCommands,
  ...lspCommands,
  ...previewCommands,
  ...dbCommands,
  ...codeCommands,
  ...ghCommands,
};

const CHANNEL_PREFIX = '__CHANNEL__:';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function handleInvoke(req, res, cmd) {
  const clientId = String(req.headers['x-kestrel-client'] || 'default');
  const c = getClient(clientId);
  try {
    const body = await readBody(req);
    let result;
    if (cmd === 'fs_write_file') {
      result = await fsWriteFile(req, body);
    } else {
      const handler = commands[cmd];
      let args = {};
      if (body.length) {
        try {
          args = JSON.parse(body.toString('utf8'));
        } catch {
          throw invalid('body is not valid JSON');
        }
      }
      // Channel arguments arrive as "__CHANNEL__:<id>". Give the handler a channel object.
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string' && v.startsWith(CHANNEL_PREFIX)) args[k] = makeChannel(c, Number(v.slice(CHANNEL_PREFIX.length)));
      }
      if (cmd === 'fs_read_file') result = await fsReadFile(args);
      else if (cmd === 'git_show') result = await gitShow(args);
      else if (handler) result = await handler(args, c);
      else throw invalid(`unknown command: ${cmd}`);
    }
    if (Buffer.isBuffer(result)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': result.length });
      res.end(result);
    } else sendJson(res, 200, result);
  } catch (e) {
    const k = e instanceof KError ? e : toKError(e);
    if (!(e instanceof KError)) console.error(`[dev-bridge] ${cmd}:`, e);
    sendJson(res, 400, { code: k.code, message: k.message });
  }
}

function localHostOnly(req) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]', ''].includes(host);
}

/** The Vite plugin. Add it to `plugins` in vite.config.ts. */
export default function devBridge() {
  return {
    name: 'kestrel-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
      server.config.logger.info(`  kestrel dev bridge: state in ${stateDir}`);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith(PREFIX)) return next();
        if (!localHostOnly(req)) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        const rest = url.pathname.slice(PREFIX.length);
        try {
          if (rest === 'ping') return sendJson(res, 200, { ok: true });
          if (rest === 'events') return attachSse(getClient(String(url.searchParams.get('client') || 'default')), req, res);
          if (rest.startsWith('file/')) return await serveFile(req, res, url);
          if (rest.startsWith('invoke/') && req.method === 'POST') return await handleInvoke(req, res, rest.slice('invoke/'.length));
          res.writeHead(404);
          res.end('not found');
        } catch (e) {
          console.error('[dev-bridge]', e);
          if (!res.headersSent) res.writeHead(500);
          res.end(String(e?.message ?? e));
        }
      });
      server.httpServer?.on('close', () => {
        for (const c of clients.values()) closeClientState(c);
      });
    },
  };
}

// --- term_* (owner: terminal agent) ----------------------------------------
// A real PTY without npm packages: Node starts `python3 -u -c <helper>`. The helper
// uses Python's `pty` module and passes bytes both ways:
//   stdin  -> the PTY (typed text)
//   stdout <- the PTY (output)
//   fd 3   -> resize commands, one line each: "<cols> <rows>\n"
// The exit code of the helper is the exit code of the shell.
// Output goes to the page as base64 text, because the bridge sends JSON.

const TERM_HELPER = String.raw`
import fcntl, os, pty, select, signal, struct, sys, termios

cols, rows, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
argv = sys.argv[4:]

def set_size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
    except OSError:
        pass
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        sys.stderr.write("cannot start %s: %s\n" % (argv[0], e))
        os._exit(127)

set_size(fd, cols, rows)
ctl_buf = b""
open_fds = {0: "stdin", fd: "pty", 3: "ctl"}
try:
    while fd in open_fds:
        ready, _, _ = select.select(list(open_fds), [], [])
        for r in ready:
            if r == fd:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    del open_fds[fd]
                else:
                    os.write(1, data)
            elif r == 0:
                data = os.read(0, 65536)
                if not data:
                    # The page or the bridge went away. Stop the shell.
                    os.kill(pid, signal.SIGHUP)
                    del open_fds[0]
                else:
                    os.write(fd, data)
            else:
                data = os.read(3, 4096)
                if not data:
                    del open_fds[3]
                    continue
                ctl_buf += data
                while b"\n" in ctl_buf:
                    line, ctl_buf = ctl_buf.split(b"\n", 1)
                    parts = line.split()
                    if len(parts) == 2:
                        try:
                            set_size(fd, int(parts[0]), int(parts[1]))
                        except (ValueError, OSError):
                            pass
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
`;

// The shell environment. It mirrors `crates/kestrel-term/src/env.rs`, so keep the
// two in step: CLICOLOR for BSD `ls`, a UTF-8 locale also when the environment has
// LANG=C or LC_ALL=C, and for zsh the Kestrel ZDOTDIR with the command line colors.

const isUtf8Locale = (name) => /utf-?8/i.test(name);

/** Copies the zsh files of the Rust crate to a temp folder and returns the folder. */
function installZshFiles() {
  const from = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'crates', 'kestrel-term', 'zsh');
  const to = path.join(os.tmpdir(), `kestrel-dev-zsh-${process.getuid?.() ?? 0}`);
  fs.mkdirSync(to, { recursive: true });
  for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'kestrel-highlight.zsh']) {
    const text = fs.readFileSync(path.join(from, name), 'utf8');
    const target = path.join(to, name);
    let old = null;
    try {
      old = fs.readFileSync(target, 'utf8');
    } catch {
      // Not written yet.
    }
    if (old !== text) {
      const temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text);
      fs.renameSync(temp, target);
    }
  }
  return to;
}

function termEnvironment(base, program, highlight) {
  const env = { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Kestrel' };
  if (env.CLICOLOR === undefined) env.CLICOLOR = '1';
  const all = env.LC_ALL || '';
  const effective = all || env.LC_CTYPE || env.LANG || '';
  if (!effective) {
    env.LANG = 'en_US.UTF-8';
  } else if (!isUtf8Locale(effective)) {
    env.LC_CTYPE = process.platform === 'darwin' ? 'UTF-8' : 'en_US.UTF-8';
    if (all) {
      delete env.LC_ALL;
      for (const key of ['LC_COLLATE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY']) {
        if (!env[key]) env[key] = all;
      }
    }
  }
  if (highlight && path.basename(program) === 'zsh') {
    try {
      const dir = installZshFiles();
      if (env.ZDOTDIR && env.ZDOTDIR !== dir) env.KESTREL_USER_ZDOTDIR = env.ZDOTDIR;
      else delete env.KESTREL_USER_ZDOTDIR;
      env.ZDOTDIR = dir;
      env.KESTREL_ZDOTDIR = dir;
      env.KESTREL_HIGHLIGHT = '1';
    } catch (e) {
      console.warn(`[term] cannot write the zsh files: ${e.message}`);
    }
  }
  return env;
}

/** Running terminals: "<client id>:<term id>" -> { proc, client }. */
const termSessions = new Map();
let termCounter = 0;

function killTerm(key) {
  const s = termSessions.get(key);
  if (!s) return;
  termSessions.delete(key);
  s.killed = true;
  try {
    s.proc.stdin.destroy();
    s.proc.kill('SIGHUP');
  } catch {
    // The process is gone already.
  }
  // Hard stop for a shell that ignores SIGHUP.
  setTimeout(() => s.proc.kill('SIGKILL'), 1000).unref();
}

// A closed browser tab never calls term_kill. The bridge forgets the client after
// a while (see closeClientState), so stop the shells of unknown clients.
setInterval(() => {
  for (const [key, s] of termSessions) if (!clients.has(s.clientId)) killTerm(key);
}, 10000).unref();
process.on('exit', () => {
  for (const key of [...termSessions.keys()]) killTerm(key);
});

const termCommands = {
  async term_spawn({ cwd, cols, rows, shell, highlight, channel, events }, c) {
    if (!channel || !events) throw invalid('term_spawn needs a channel and an events channel');
    const parts = String(shell || '').trim().split(/\s+/).filter(Boolean);
    const program = parts.length ? parts : [process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), '-l'];
    let dir = String(cwd || '');
    try {
      if (!(await fsp.stat(dir)).isDirectory()) throw new Error('not a folder');
    } catch {
      dir = os.homedir();
    }
    const env = termEnvironment(process.env, program[0], highlight !== false);

    const args = ['-u', '-c', TERM_HELPER, String(cols || 80), String(rows || 24), dir, ...program];
    const proc = spawn('python3', args, { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], env });
    await new Promise((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', (e) => reject(new KError('io', `cannot start python3 for the terminal: ${e.message}`)));
    });

    const id = ++termCounter;
    const key = `${c.id}:${id}`;
    const session = { proc, clientId: c.id, killed: false };
    termSessions.set(key, session);

    // Batch output: send at most every 8 ms, like the Rust side.
    let chunks = [];
    let timer = null;
    const flush = () => {
      timer = null;
      if (!chunks.length) return;
      channel.send(Buffer.concat(chunks).toString('base64'));
      chunks = [];
    };
    proc.stdout.on('data', (buf) => {
      chunks.push(buf);
      if (!timer) timer = setTimeout(flush, 8);
    });
    proc.stdin.on('error', () => {});
    proc.stdio[3].on('error', () => {});
    proc.once('close', (code) => {
      clearTimeout(timer);
      flush();
      termSessions.delete(key);
      events.send({ kind: 'exit', code: code ?? 0 });
      events.end();
      channel.end();
    });
    return { id, shell: program[0] };
  },

  async term_write({ id, data }, c) {
    const s = termSessions.get(`${c.id}:${id}`);
    if (!s) throw notFound(`terminal ${id} is not running`);
    s.proc.stdin.write(String(data ?? ''));
    return null;
  },

  async term_resize({ id, cols, rows }, c) {
    const s = termSessions.get(`${c.id}:${id}`);
    if (!s) throw notFound(`terminal ${id} is not running`);
    s.proc.stdio[3].write(`${Math.max(1, cols | 0)} ${Math.max(1, rows | 0)}\n`);
    return null;
  },

  async term_kill({ id }, c) {
    killTerm(`${c.id}:${id}`);
    return null;
  },
};
Object.assign(commands, termCommands);

// --- web_* -------------------------------------------------------------------
// Web tabs are native web views. A normal browser cannot show them, so the
// bridge has no web_* commands (they reject with "not available in the browser").
