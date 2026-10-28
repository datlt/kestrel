#!/usr/bin/env node
// A fake `gh` (GitHub CLI) for tests and for browser testing. It never uses the
// network and knows no token. It answers from the fixtures folder
// (env KESTREL_FAKE_GH_DIR, default: ./fixtures next to this file).
// The layout is in README.md. Use it with:
//   KESTREL_GH_PROGRAM=<repo>/scripts/fake-gh/gh.mjs
// (the file is executable and starts with `#!/usr/bin/env node`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.KESTREL_FAKE_GH_DIR || path.join(here, 'fixtures');
const delayMs = Number(process.env.KESTREL_FAKE_GH_DELAY_MS || 0);

const argv = process.argv.slice(2);

function out(text) {
  process.stdout.write(text);
}
function fail(message, code = 1) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}
function appendLog(file, line) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), line + '\n');
}
function readFileIf(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}
function readJsonIf(file) {
  const buf = readFileIf(file);
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}
function readStdin() {
  try {
    return fs.readFileSync(0).toString('utf8');
  } catch {
    return '';
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REASONS = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 422: 'Unprocessable Entity', 500: 'Internal Server Error' };

/** Prints an answer like `gh api` does: with -i, the status line and headers come first. */
function answer({ include, status, body, contentType = 'application/json; charset=utf-8' }) {
  if (include) {
    out(`HTTP/2.0 ${status} ${REASONS[status] ?? 'Status'}\r\n`);
    out(`Content-Type: ${contentType}\r\n`);
    out(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
    out('X-Github-Request-Id: FAKE\r\n\r\n');
  }
  process.stdout.write(body);
  if (status >= 400) {
    let message = REASONS[status] ?? 'Error';
    try {
      message = JSON.parse(body.toString()).message ?? message;
    } catch {}
    fail(`gh: ${message} (HTTP ${status})`);
  }
}

// --- Commands --------------------------------------------------------------------------

if (argv[0] === '--version' || argv[0] === 'version') {
  out('gh version 2.97.0 (2026-07-31)\nhttps://github.com/cli/cli/releases/tag/v2.97.0\n');
  process.exit(0);
}

const authStatus = () => readJsonIf(path.join(dir, 'auth-status.json')) ?? { hosts: {} };

if (argv[0] === 'auth') {
  if (argv[1] === 'status') {
    out(JSON.stringify(authStatus()));
    process.exit(0);
  }
  if (argv[1] === 'switch' || argv[1] === 'logout') {
    appendLog('gh.log', `auth ${argv[1]} ${argv.slice(2).join(' ')}`);
    process.exit(0);
  }
  fail(`fake gh: unknown command: ${argv.join(' ')}`);
}

if (argv[0] === 'pr' && argv[1] === 'checkout') {
  appendLog('gh.log', `pr checkout ${argv[2]} in ${process.cwd()}`);
  const errorText = readFileIf(path.join(dir, 'pr-checkout-error.txt'));
  if (errorText) fail(errorText.toString('utf8'));
  process.stderr.write(`Switched to branch 'pr-${argv[2]}'\n`);
  out(`checked out pull request ${argv[2]}\n`);
  process.exit(0);
}

if (argv[0] === 'api') {
  await api(argv.slice(1));
  process.exit(0);
}

fail(`fake gh: unknown command: ${argv.join(' ')}`);

// --- gh api ----------------------------------------------------------------------------

async function api(args) {
  const o = { headers: [], include: false, paginate: false, host: '', method: 'GET', input: null, endpoint: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--hostname') o.host = args[++i];
    else if (a === '-X' || a === '--method') o.method = args[++i].toUpperCase();
    else if (a === '-H' || a === '--header') o.headers.push(args[++i]);
    else if (a === '-i' || a === '--include') o.include = true;
    else if (a === '--paginate') o.paginate = true;
    else if (a === '--slurp') continue;
    else if (a === '--input') o.input = args[++i];
    else if (!a.startsWith('-') && o.endpoint === null) o.endpoint = a;
  }
  if (o.endpoint === null) fail('fake gh: missing endpoint');
  const hosts = Object.keys(authStatus().hosts ?? {}).map((h) => h.toLowerCase());
  if (o.host && !hosts.includes(o.host.toLowerCase())) {
    fail(`You are not logged into any GitHub hosts for ${o.host}. To log in, run: gh auth login --hostname ${o.host}`, 4);
  }
  const raw = o.input === '-' ? readStdin() : '';
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  if (delayMs) await sleep(delayMs);

  if (o.endpoint === 'graphql') return graphql(o, body);

  const [pathPart, query = ''] = o.endpoint.split('?');
  const name = pathPart
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('__');
  if (o.method !== 'GET') {
    appendLog('writes.log', JSON.stringify({ method: o.method, path: pathPart, body }));
    const fixture = readJsonIf(path.join(dir, 'rest', o.method, name + '.json'));
    if (fixture) return sendFixture(o, fixture);
    if (o.method === 'DELETE') return answer({ include: o.include, status: 204, body: '' });
    return answer({ include: o.include, status: 201, body: '{}' });
  }

  // Raw file text: rest/GET/<name>@<ref>.txt, then <name>.txt (also .bin).
  const wantsRaw = o.headers.some((h) => /application\/vnd\.github\.raw/i.test(h));
  if (wantsRaw) {
    const ref = new URLSearchParams(query).get('ref');
    const candidates = [];
    for (const base of ref ? [`${name}@${ref}`, name] : [name]) for (const ext of ['.txt', '.bin']) candidates.push(base + ext);
    for (const c of candidates) {
      const buf = readFileIf(path.join(dir, 'rest', 'GET', c));
      if (buf) return answer({ include: o.include, status: 200, body: buf, contentType: 'text/plain; charset=utf-8' });
    }
  }

  const file = path.join(dir, 'rest', 'GET', name + '.json');
  const first = readJsonIf(file);
  if (first === null) {
    return answer({ include: o.include, status: 404, body: JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }) });
  }
  if (o.paginate) {
    const pages = [first];
    for (let n = 2; ; n++) {
      const next = readJsonIf(path.join(dir, 'rest', 'GET', `${name}.${n}.json`));
      if (next === null) break;
      pages.push(next);
    }
    if (first && typeof first === 'object' && '$status' in first) return sendFixture(o, first);
    return answer({ include: false, status: 200, body: JSON.stringify(pages) });
  }
  return sendFixture(o, first);
}

/** A fixture is the JSON body (status 200), or { "$status": 500, "$body": ... } for another status. */
function sendFixture(o, fixture) {
  if (fixture && typeof fixture === 'object' && '$status' in fixture) {
    const body = fixture.$body === undefined ? '' : JSON.stringify(fixture.$body);
    return answer({ include: o.include && !o.paginate, status: Number(fixture.$status), body });
  }
  return answer({ include: o.include && !o.paginate, status: 200, body: JSON.stringify(fixture) });
}

function graphql(o, body) {
  const query = String(body?.query ?? '');
  const m = /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  if (!m) fail('fake gh: the GraphQL query needs a name, like `query KestrelSomething`');
  const [, kind, op] = m;
  if (kind === 'mutation') appendLog('writes.log', JSON.stringify({ method: 'POST', path: 'graphql', body }));
  const fixture = readJsonIf(path.join(dir, 'graphql', op + '.json'));
  if (fixture === null) {
    answer({ include: o.include, status: 200, body: JSON.stringify({ errors: [{ message: `fake gh: no fixture graphql/${op}.json` }] }) });
    process.exit(1);
  }
  if (fixture && typeof fixture === 'object' && '$status' in fixture) return sendFixture(o, fixture);
  answer({ include: o.include, status: 200, body: JSON.stringify(fixture) });
  // Real gh exits with 1 when the answer has `errors`.
  if (fixture && Array.isArray(fixture.errors) && fixture.errors.length) process.exit(1);
}
