# Fake gh

`gh.mjs` acts like the GitHub CLI for tests and for browser testing. It uses no network and no token. It reads answers from a fixtures folder (env `KESTREL_FAKE_GH_DIR`, default `scripts/fake-gh/fixtures`).

Use it with `KESTREL_GH_PROGRAM=/abs/path/to/scripts/fake-gh/gh.mjs` (the file is executable and needs `node` in PATH). The dev bridge and `kestrel-gh` both read this variable.

## Fixtures layout

```
fixtures/
  auth-status.json            output of `gh auth status --json hosts` (two fake accounts)
  rest/GET/<name>.json        answer of a GET (page 1 when paginated)
  rest/GET/<name>.2.json      page 2, then .3.json ... (only with paginate)
  rest/GET/<name>.txt         raw file text (Accept: application/vnd.github.raw)
  rest/GET/<name>@<ref>.txt   the same file at one commit (tried first). `.bin` is allowed too.
  rest/<METHOD>/<name>.json   answer of POST, PATCH, PUT, DELETE (default: 201 and {})
  graphql/<Operation>.json    answer of a GraphQL call (the full answer, with `data`)
  writes.log                  one JSON line per write: { method, path, body }  (written by the fake)
  gh.log                      lines for `auth switch`, `auth logout`, `pr checkout`  (written by the fake)
  pr-checkout-error.txt       if it exists, `pr checkout` fails with this text
```

- `<name>` is the REST path without the query, with `/` replaced by `__`. Example: `repos/o/r/pulls/1/files?per_page=100` uses `repos__o__r__pulls__1__files.json`. Path segments are decoded first (`%20` becomes a space).
- A missing GET fixture gives HTTP 404 with `{"message":"Not Found"}`.
- A fixture can set another status: `{ "$status": 500, "$body": { "message": "Server Error" } }`. Status 401 gives `gh_auth`, 404 `not_found`.
- With paginate, the fake prints an array of all pages (like `--paginate --slurp`). Each page is usually an array.
- For raw text, `<name>` is the contents path (`repos__o__r__contents__src__a.ts`) and `ref` comes from the query (`?ref=<sha>`).
- GraphQL: the fake reads the operation name from the query text (`query KestrelSomething` or `mutation KestrelSomething`). Every query must have a name. A mutation also goes to `writes.log`. A missing fixture gives an `errors` answer. A fixture with a non-empty `errors` list makes the fake exit with 1, like real `gh`.
- Hosts: calls with `--hostname` for a host that is not in `auth-status.json` fail like a missing login.
- `KESTREL_FAKE_GH_DELAY_MS=500` delays every `api` answer (to see spinners and to test cancel).
- Delete `writes.log` and `gh.log` before a test run when you read them.
