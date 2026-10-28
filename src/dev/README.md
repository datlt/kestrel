# Browser dev harness

This folder lets you run the real Kestrel frontend in a normal Chrome tab. No Tauri
is involved. The page uses real files and real `git` on your disk. Use it to test the
UI with screenshots and clicks, because the Tauri webview cannot be screenshotted.

It is for development only. `src/main.ts` loads it only when `import.meta.env.DEV` is
true and `window.__TAURI_INTERNALS__` is missing. The Vite plugin uses `apply: 'serve'`,
so a production build never contains it.

## Run

```
KESTREL_DEV_ROOT=/some/folder npx vite
```

Then open http://localhost:1420.

- `KESTREL_DEV_ROOT` is the folder (or file) that opens at start. It is optional.
- `KESTREL_DEV_STATE` is the folder for settings and app data (recent folders,
  sessions, global state). The default is `<tmpdir>/kestrel-devbridge`. Your real
  Kestrel settings are never touched.
- `?root=/some/folder` in the URL opens that folder (the same as a new window).

`vite.config.ts` must contain `plugins: [devBridge()]` with
`import devBridge from './scripts/dev-bridge.mjs'`.

## How it works

- `src/dev/browser-backend.ts` installs a fake `window.__TAURI_INTERNALS__`.
  `app_*`, `fs_*`, `ws_*`, `search_*`, `git_*`, `md_*`, `preview_*` and `lsp_*`
  commands go to `POST /__kestrel/invoke/<cmd>`.
- `scripts/dev-bridge.mjs` runs inside Vite (Node). It answers the commands, serves
  local files at `/__kestrel/file/<absolute path>` and sends events through
  Server-Sent Events at `/__kestrel/events`.
- Channels (`search_text`) and events (`kestrel://fs-changed`,
  `kestrel://search-index`) travel through that event stream.
- Window, webview, dialog and opener calls are answered in the browser.
  Open-folder asks for a path with `window.prompt`. Zoom uses CSS `zoom`.
- `preview://localhost/...` URLs are rewritten to `/__kestrel/file/...`.

## Differences from the real app

- Markdown comes from a small JavaScript renderer, not comrak. Rare syntax can differ.
- Language servers do not start (`lsp_start` fails with `server_missing`).
- Files save as UTF-8 or UTF-16 LE only. Other encodings fail with `invalid_input`.
- Delete moves to `~/.Trash` on macOS (no trash crate).
- Closing the window does nothing. In the console, `__kestrelDev.closeRequested()`
  sends the close-requested event.
- A tab can hold several open folders. `ws_open` adds a watcher and keeps the others.
  `ws_close` with a `root` closes only that folder. Without a `root` it closes all of them.
  Every `kestrel://fs-changed` payload has the `root` of its folder.
- `fs_list_dir` with `compact: true` joins single-child folder chains with the same
  rules as `crates/kestrel-fs/src/dir.rs` (`compact`, `compactStyle`).
- `git_log`, `git_commit_info` and `git_blame` run real `git log --follow` and
  `git blame --porcelain`, and parse the output like `history.rs`.
- Files under `/__kestrel/file/` get no `Access-Control-Allow-Origin` header, except
  `null` for `.js .mjs .cjs .woff .woff2 .ttf .otf` (the same as the Rust protocol).
- Anyone who can reach the dev server can read your files. Keep Vite on localhost.
