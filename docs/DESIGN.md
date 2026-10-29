# Kestrel: design

Kestrel is a small, fast code editor. It uses Tauri 2 (Rust backend, system
web view) and CodeMirror 6. This document is the contract between all parts
of the app. Read it fully before you change code.

## 1. Goals

| Goal | How we reach it |
|------|-----------------|
| Small and fast | System web view (no bundled Chromium). No UI framework. CodeMirror 6 instead of Monaco. Every heavy module loads lazily with `import()`. |
| Starts fast | The window is hidden until the first paint. Only the active tab loads at startup. The file tree reads one folder level at a time. |
| Fast with big repos and big files | All heavy work runs in Rust threads: directory walk, fuzzy file search, text search, git, markdown. Big results stream through `tauri::ipc::Channel`. Big file contents travel as raw bytes, not JSON. Every long list is virtualized. |
| Markdown and HTML viewer | Markdown renders in Rust (comrak, GitHub flavor). Previews run in sandboxed iframes. Files have three modes: code, split, preview. |
| Good syntax colors | CodeMirror Lezer grammars for Java, JS/TS, Python, HTML, SQL, CSS, JSON, Markdown, XML, YAML, Rust, Go, C++. A hand-written Kotlin tokenizer. One rich color theme for light and dark. |
| Git diff in big repos | The `git` command line (fast, supports fsmonitor, sparse checkout, LFS). Side-by-side and unified diff views. Diff against any branch (merge base, like a pull request). Changes in the editor gutter. |
| LSP for Kotlin, Java, JS/TS | Rust starts the servers and moves JSON-RPC messages. The frontend uses `@codemirror/lsp-client`. |
| Switch folders fast | Recent folder picker (Mod-r). Each folder keeps its own session (tabs, cursor, tree state). New window per folder. |
| UTF-8 by default | Rust detects the encoding (BOM, UTF-8, then chardetng), keeps BOM and line endings on save, and can re-open or save with another encoding. |
| Smooth zoom | Editor font zoom (Mod-=, Mod--, Mod-0, Ctrl/pinch + wheel), preview zoom, and window zoom. |
| Cross platform | macOS, Windows, Linux. Paths, process spawning (no console window on Windows), and the login-shell PATH on macOS/Linux are handled in `kestrel-common`. |

Performance budgets (release build, M1 or similar):

- Window visible: under 300 ms after launch.
- Idle memory of the app process (Rust side): under 60 MB with one folder open.
- Open a 10 MB file: under 300 ms. Typing stays at 60 fps in a 100k-line file.
- Quick open on a repo with 300k files: first result under 50 ms after the index is ready.
- `git status` on a big repo: never blocks the UI; the UI shows the old state until the new one arrives.

## 2. Architecture

```
┌──────────────────────── Web view (TypeScript, src/) ───────────────────────┐
│ main.ts ─ builds AppContext                                                │
│   core/      bus, commands, settings, types (contracts), dom, util         │
│   shell/     layout, tabs, sidebar/panel views, status bar, quick pick,    │
│              palette, dialogs, menus, theme, key dispatch                  │
│   editor/    CodeMirror file editors, languages, colors, zoom, preview host│
│   features/  files · search · git · lsp · preview                          │
│   ipc/       typed wrappers around Tauri commands, one file per feature    │
└──────────────┬───────────────────────────────────────────────▲─────────────┘
               │ invoke (JSON or raw bytes)                    │ Channel / events
┌──────────────▼──────────── Rust (src-tauri/) ──────────────────────────────┐
│ lib.rs ─ plugins, protocol, menu, routing by command prefix (cmd/mod.rs)   │
│ cmd/app.rs  cmd/fs.rs  cmd/search.rs  cmd/git.rs  cmd/lsp.rs  cmd/preview.rs│
│        thin Tauri layer: argument parsing, threads, channels               │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ plain Rust calls
┌──────────────▼──────────── crates/ (no Tauri) ─────────────────────────────┐
│ kestrel-common  error type, login-shell env, process spawn, roots, paths   │
│ kestrel-fs      read/write with encodings, list dirs, watcher, sessions    │
│ kestrel-search  file index + fuzzy match, text search (ripgrep crates)     │
│ kestrel-git     git CLI wrapper: status, show, diff names, branches        │
│ kestrel-lsp     language server processes and JSON-RPC framing             │
│ kestrel-markdown comrak rendering, mime types for preview://               │
└────────────────────────────────────────────────────────────────────────────┘
```

Why the crates have no Tauri dependency: you can unit test them fast with
`cargo test -p <crate>`, and several people can work on different crates at
the same time without breaking each other's build.

## 3. Ownership

Each file has one owner. Only the owner edits it. You may read every file.
If you need a change in a file you do not own, describe the exact change in
your final report. The integrator applies it.

| Area | Owner | Files |
|------|-------|-------|
| Kernel and wiring | integrator | `src/main.ts`, `src/core/**`, `src/ipc/invoke.ts`, `src/ipc/app.ts`, `src/styles/**`, `index.html`, `package.json`, `vite.config.ts`, `tsconfig.json`, `Cargo.toml` (root), `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/**`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/src/cmd/mod.rs`, `src-tauri/src/cmd/app.rs`, `crates/kestrel-common/**`, `docs/DESIGN.md` |
| Shell | shell | `src/shell/**` |
| Editor engine | engine | `src/editor/**` |
| Files and workspace | files | `src/features/files/**`, `src/ipc/fs.ts`, `src-tauri/src/cmd/fs.rs`, `crates/kestrel-fs/**` |
| Search | search | `src/features/search/**`, `src/ipc/search.ts`, `src-tauri/src/cmd/search.rs`, `crates/kestrel-search/**` |
| Git | git | `src/features/git/**`, `src/ipc/git.ts`, `src-tauri/src/cmd/git.rs`, `crates/kestrel-git/**` |
| LSP | lsp | `src/features/lsp/**`, `src/ipc/lsp.ts`, `src-tauri/src/cmd/lsp.rs`, `crates/kestrel-lsp/**` |
| Preview | preview | `src/features/preview/**`, `src/ipc/preview.ts`, `src-tauri/src/cmd/preview.rs`, `crates/kestrel-markdown/**` |
| Docs, CI, scripts, tests of core | packaging | `README.md`, `.github/**`, `scripts/**`, `docs/*.md` except DESIGN.md, `src/core/*.test.ts`, `vitest.config.ts` |

A crate owner may add dependencies to their own crate's `Cargo.toml`.
Nobody runs `npm install`, `npm add` or edits `package.json`: all frontend
packages are already installed. If you need one more, ask in your report.

## 4. Rules for everybody

### 4.1 Working in parallel

- Several people build this repo at the same time. Builds of other parts can
  fail while you work. Only fix errors in your own files.
- Rust crate tests: use your own target folder so you do not wait for others:
  `CARGO_TARGET_DIR=$SCRATCH/target-<area> cargo test -p kestrel-<area>`
  (`$SCRATCH` is the scratch folder given in your task).
- Rust app crate: `cargo check -p kestrel` (shared `target/`, it may wait for
  a lock; that is normal). Errors in another owner's `cmd/*.rs` are not yours.
- Frontend: `npx tsc --noEmit -p . 2>&1 | grep '<your folder>'`.
- Do not run `npm run tauri dev`, `tauri build`, `npm install` or `git commit`.
  The integrator runs the full app.

### 4.2 Rust

- Command names start with the prefix of your module (table in
  `src-tauri/src/cmd/mod.rs`). Your `cmd/<area>.rs` keeps the four exported
  functions: `handler()`, `setup()`, `on_window_destroyed()`, `on_exit()`.
  Remove the `*_ping` placeholder command when you add real commands.
- Commands return `kestrel_common::Result<T>`. The frontend receives errors as
  `{ code, message }`. Use the codes in `kestrel_common::error::codes`.
- Never block the main thread. Slow commands are `async` and use
  `tauri::async_runtime::spawn_blocking` (or a thread) for file system,
  process and CPU work.
- Stream big or slow results with `tauri::ipc::Channel<T>` (batches, about
  every 50 ms). Support cancel by id.
- Start child processes only with `kestrel_common::process::command()`. It
  applies the login-shell PATH and hides the console window on Windows.
- Manage per-feature state with `app.manage(...)` inside your `setup()`.
  State that belongs to a window is keyed by the window label and cleaned up
  in `on_window_destroyed()`.
- Paths: accept and return absolute native paths. Paths relative to a
  workspace root use `/` (`kestrel_common::paths::relative_slash`).
- Tests: unit tests in the crate (`tempfile` for folders). Test edge cases:
  empty files, non-UTF-8, CRLF, spaces and non-ASCII in paths, Windows
  separators where it matters.
- Comments: plain English, short sentences, only where the code does not
  explain itself.

### 4.3 TypeScript

- No UI framework. Build DOM with `h()` from `core/dom.ts` or with
  `document.createElement`. Never put file names, file content, git output or
  server messages into `innerHTML` without `escapeHtml()` from `core/util.ts`.
- Use only the theme variables from `src/styles/vars.css` for colors, so
  light and dark themes work. Put your CSS in a `.css` file next to your code
  and import it from your TS file. Prefix your class names with your area
  (`.explorer-*`, `.git-*`, `.search-*`, `.lsp-*`, `.preview-*`, `.shell-*`,
  `.editor-*`).
- Load heavy modules lazily (`await import('@codemirror/merge')`), the first
  time a user needs them. The startup bundle must stay small.
- Lists that can have more than 200 rows must be virtualized (render only
  visible rows). Debounce input and refreshes. No polling loops.
- Icons: `import { createElement, FolderOpen } from 'lucide'`, then
  `createElement(FolderOpen)`. Size them with CSS (16px).
- Use only the services in `AppContext` (`src/core/types.ts`) to talk to other
  parts. Talk to Rust only through your own `src/ipc/<area>.ts`.
- Startup order (main.ts): bus, commands, settings, then `createShell` (tabs,
  views, status, ui), then `createEditorService`, then
  `createWorkspaceService`, then the feature `init*` functions, then
  `shell.mount()`, then `workspace.restoreInitial()`. A factory may use only
  services created before it. `init*` functions may use all services.
- Settings: read with `ctx.settings.get(key)`, react to `settings:changed`.
  New keys: declaration merging (see `Settings` in types.ts) plus
  `ctx.settings.registerDefaults`.
- Per-folder state: `ctx.workspace.state`; shared state:
  `ctx.workspace.globalState`. Prefix keys with your area (`explorer.expanded`).
- Errors from Rust are `IpcError` with a `code` (see `src/ipc/invoke.ts`).
  Show user errors with `ctx.ui.notify(message, { kind: 'error' })`.

## 5. Cross-part contracts

The TypeScript interfaces in `src/core/types.ts` are the main contract. These
extra contracts cross the Rust/TS line or connect two features.

### 5.1 Reading and writing files (files ↔ engine)

`src/ipc/fs.ts` documents `fsReadFile`, `fsWriteFile` and `fsStat`. Summary:

- `fs_read_file(path, encoding?, maxBytes)` returns a raw `tauri::ipc::Response`:
  `[u32 LE header length][header JSON][UTF-8 text]`. The header has the fields
  of `ReadFileResult` without `text` (camelCase).
  Detection order: forced `encoding` → BOM (UTF-8, UTF-16LE/BE) → NUL bytes
  in the first 8 KB mean binary → valid UTF-8 → `chardetng` guess. The text is
  not changed (line endings stay as they are; CodeMirror normalizes them).
  After a successful read, call `kestrel_common::roots::allow(parent folder)`.
- `fs_write_file` takes a raw body (UTF-8 text with `\n`) and headers
  `x-path` (URI-encoded), `x-encoding`, `x-bom`, `x-line-ending`,
  `x-expected-mtime`. It converts `\n` to the line ending, encodes the text
  (error `unmappable` when the encoding cannot store a character), checks the
  mtime (error `conflict`), and writes safely (temp file + rename in the same
  folder, keeping permissions; write in place when the target is a symlink).
  Returns `{ mtimeMs, size }`.
- `fs_stat(path)` returns `{ exists, isDir, size, mtimeMs, readonly }`.
- mtime is an integer number of milliseconds since the Unix epoch.

### 5.2 Watcher (files → everybody)

The files feature watches the open root of each window. Rust emits the Tauri
event `kestrel://fs-changed` to that window only. The payload is
`FsChangeEvent` (types.ts). The files frontend forwards it to the bus as
`fs:changed`. Rules: debounce about 200 ms; paths are absolute; changes inside
`.git/` only set `gitChanged: true` (for `HEAD`, `index`, `refs/**`,
`packed-refs`, `MERGE_HEAD`) and are not listed in `paths`; more than 5000
paths in one batch: send `rescan: true` and an empty `paths`.

### 5.3 Preview protocol (preview, files)

`preview://localhost/<path>` serves a local file (on Windows the web view
uses `http://preview.localhost/<path>`). `<path>` is the absolute path with
`/` separators, each segment percent-encoded (`/Users/me/My%20Docs/a.png`,
`/C:/work/a.png`). It serves only paths where
`kestrel_common::roots::is_allowed(path)` is true. The files feature calls
`roots::allow(root)` in `ws_open` and `roots::disallow(root)` when the window
closes the folder. Build URLs in TS with the helper `previewUrl(path)` in
`src/ipc/preview.ts`.

### 5.4 Git decorations (git → files explorer, shell tabs)

The bus event `git:decorations` (types.ts). The explorer colors file names
and shows the color on parent folders. Colors: `--git-*` variables.

### 5.5 Code highlighting for previews (engine → preview)

`ctx.editors.highlightToHtml(code, lang)` returns HTML with `tok-*` classes.
`ctx.editors.highlightCss()` returns CSS for those classes with the colors of
the current theme (resolved values, so it works inside an iframe).

## 6. Commands and keys

Use these ids and keys. `Mod` = Cmd on macOS, Ctrl elsewhere. Keys marked
"editor" are CodeMirror key bindings (active only when the editor has focus).

| Id | Key | Owner |
|----|-----|-------|
| `workbench.commandPalette` | Mod-Shift-p, F1 | shell |
| `workbench.toggleSidebar` | Mod-b | shell |
| `workbench.togglePanel` | Mod-j | shell |
| `workbench.closeTab` | Mod-w | shell |
| `workbench.closeAllTabs` | (palette) | shell |
| `workbench.reopenClosedTab` | Mod-Shift-t | shell |
| `workbench.nextTab` / `workbench.prevTab` | Ctrl-Tab / Ctrl-Shift-Tab | shell |
| `workbench.showExplorer` | Mod-Shift-e | shell |
| `workbench.showSearch` | (palette) | shell → runs `search.showFindWindow` (sidebar Search view) |
| `workbench.showGit` | Ctrl-Shift-g | shell |
| `view.zoomIn` / `view.zoomOut` / `view.zoomReset` | Mod-=, Mod-Shift-= / Mod-- / Mod-0 | shell (calls active tab `zoom()`, else `ctx.editors.zoom()`) |
| `view.uiZoomIn` / `view.uiZoomOut` / `view.uiZoomReset` | Mod-Alt-= / Mod-Alt-- / Mod-Alt-0 | shell |
| `view.toggleTheme` | (palette) | shell |
| `file.save` | Mod-s | engine |
| `file.saveAs` | Mod-Shift-s | engine |
| `file.saveAll` | Mod-Alt-s | engine |
| `file.revert` | (palette) | engine |
| `editor.gotoLine` | Ctrl-g | engine |
| `editor.toggleWordWrap` | Alt-z | engine |
| `editor.changeLanguage` | (palette, status bar) | engine |
| `editor.reopenWithEncoding` / `editor.saveWithEncoding` | (palette, status bar) | engine |
| `editor.toggleLineEnding` | (palette, status bar) | engine |
| `editor.togglePreview` | Mod-Shift-v | engine (code ↔ preview) |
| `editor.toggleSplitPreview` | Mod-Alt-v | engine (code ↔ split) |
| find / replace in file | Mod-f / Mod-Alt-f (macOS), Mod-h (others) | engine, editor |
| `workspace.openFolder` | Mod-o | files |
| `workspace.openRecent` | Mod-r | files |
| `workspace.newWindow` | Mod-Shift-n | files |
| `workspace.closeFolder` | (palette) | files |
| `workspace.openSettingsJson` | (palette; Mod-, opens the Settings screen, see 8.3) | files |
| `explorer.revealActiveFile` | (palette) | files |
| `explorer.newFile` / `explorer.newFolder` / `explorer.rename` / `explorer.delete` | in explorer: F2 rename, Delete / Mod-Backspace delete | files |
| `search.quickOpen` | Mod-p | search |
| `search.findInFiles` | Mod-Shift-f (macOS also Ctrl-Shift-f) | search (popup, 13.2) |
| `search.replaceInFiles` | Mod-Shift-r (macOS also Ctrl-Shift-r) | search (popup, 13.3) |
| `goto.everywhere` / `goto.class` / `goto.symbol` / `goto.action` | Shift Shift / Mod-Shift-o (macOS also Ctrl-Shift-o) / Mod-Alt-o, Mod-t / Mod-Shift-a | goto |
| `git.refresh` | (palette) | git |
| `git.openChanges` | Mod-Alt-d | git (diff of the active file) |
| `git.compareWithBranch` | (palette) | git |
| `git.nextChange` / `git.prevChange` | Alt-F5 / Shift-Alt-F5 | git |
| `lsp.gotoDefinition` | F12, Mod-click | lsp, editor |
| `lsp.findReferences` | Shift-F12 | lsp, editor |
| `lsp.rename` | F2 | lsp, editor |
| `lsp.format` | Shift-Alt-f | lsp, editor |
| `lsp.workspaceSymbols` | (palette; Mod-t is `goto.symbol`) | lsp |
| `lsp.restart` | (palette) | lsp |
| `usages.find` | Alt-F7 (Shift-F12 without a ready server) | usages |
| `usages.next` / `usages.prev` | F4 / Shift-F4 | usages |
| `diagram.showForCursor` | Mod-Alt-u | diagram |
| `diagram.showForFile` / `diagram.showForFolder` | (palette, explorer menu) | diagram |
| `callHierarchy.show` | Mod-Shift-h | usages |
| `git.switchBranch` | Mod-Shift-b, click on `git.branch` | git |
| `github.showPullRequests` / `github.refresh` / `github.openPullRequest` | (palette) | github-ui |
| `terminal.run` | (hidden, `{ command, title?, cwd? }`) | terminal |
| `graph.show` / `graph.showLocal` / `graph.showFolder` | Mod-Alt-g / Mod-Shift-Alt-g / (palette, explorer menu) | graph-view |

View ids: sidebar `explorer` (order 10), `search` (20), `git` (30);
panel `problems` (10), `usages` (15), `call-hierarchy` (16), `lsp-output` (20); sidebar `github` (40).

Status bar ids: left `git.branch` (100), `lsp.status` (50);
right `editor.cursor` (100), `editor.indent` (90), `editor.encoding` (80),
`editor.eol` (70), `editor.language` (60), `preview.info` (40).

Tab kinds and ids: `file` (`file:<path>`), `diff` (`diff:<base>:<path>`),
`image` (`image:<path>`), `diagram` (`diagram:<n>`), `pr` (`pr:<host>/<owner>/<repo>#<n>`),
`graph` (`graph:<n>`).

## 7. Feature specs

Each feature lists what it must do. "Done" means: it works, it is fast on a
big repo, it handles errors, and the owner verified it with the commands in
section 4.1.

### 7.1 Shell (`src/shell/**`)

- Layout: activity bar (left) | sidebar (resizable, width in
  `globalState 'shell.layout'`) | editor area (tab bar + content) | bottom
  panel (resizable, toggled) | status bar. Drag handles use pointer events
  and `rafThrottle`.
- `TabService` as in types.ts: lazy `create`, preview tabs (italic, replaced
  by the next preview open, pinned on double click or when dirty), dirty dot,
  close button, middle click closes, drag to reorder, horizontal scroll,
  MRU order for Ctrl-Tab, reopen closed tab (keep the last 20 serialized
  inputs), same title in two tabs shows the parent folder as description,
  context menu (Close, Close Others, Close to the Right, Close All, Copy Path).
  Closing a dirty tab asks Save / Don't Save / Cancel.
- Window close: `getCurrentWindow().onCloseRequested`: if tabs are dirty ask
  first; then `await ctx.workspace.saveSession()`.
- `ViewRegistry`: activity bar icons with badges; one sidebar view at a time;
  clicking the active icon hides the sidebar. Panel: tab strip of panel views.
  Views may register before `mount()`.
- `StatusBar`, `UiService` (quick pick with fuzzy filter and highlights for
  static items, virtualized list, keyboard navigation, async items with
  AbortSignal and debounce; toasts; confirm and prompt modals; context menu).
- Command palette: all commands that are not hidden and whose `when` passes,
  with category and key label; recently used commands first.
- Key dispatch: one `keydown` listener on `window` (bubble phase). Skip events
  with `defaultPrevented`. Run `ctx.commands.matchEvent(e)`, then
  `preventDefault()` and execute.
- Theme: `data-theme` on `<html>` from setting `theme` (`system` follows
  `prefers-color-scheme` live). Emit `theme:changed`.
- Zoom: `view.zoom*` commands, and Ctrl+wheel / trackpad pinch over the
  editor area (accumulate `deltaY`, one step per about 50 px) call the active
  tab `zoom()` or `ctx.editors.zoom()`. Window zoom uses
  `getCurrentWebview().setZoom()` and the setting `ui.zoom`.
- Empty editor area: logo, "Open Folder", recent folders
  (`ctx.workspace.recent()`), and main key hints.
- After `file:saved` for `ctx.settings.path()`, call `ctx.settings.reload()`.
- Block the web view defaults that do not fit an editor: the browser context
  menu (except in inputs), dropping files on the page (the files feature uses
  Tauri drag-drop events instead), Mod-r reload, backspace navigation.

### 7.2 Editor engine (`src/editor/**`)

- `EditorService` and `FileEditor` as in types.ts. Tab kind `file`, data
  `{ path, line, column, scrollTop, mode }` for session restore.
- CodeMirror setup: line numbers, fold gutter, history, multiple cursors,
  rectangular selection, bracket matching and auto close, indent on input,
  active line, selection match highlight, search panel (styled), autocomplete
  (words from the document, plus LSP when present), `indentWithTab`, comment
  toggle (Mod-/), move/copy lines, special characters.
- Languages, lazily loaded by id: kotlin, java, javascript, typescript, jsx,
  tsx, python, html, css, sql (dialect StandardSQL; MySQL for `.mysql`),
  json, markdown (with code blocks highlighted by language), xml, yaml, rust,
  go, cpp, shell, groovy (`.gradle`), properties, toml, dockerfile, diff. File
  names: `build.gradle.kts` → kotlin, `Dockerfile`, `Makefile`, `.env`, ...
- Kotlin: write a `StreamLanguage` tokenizer that is better than the legacy
  `clike` mode: keywords and soft keywords, annotations (`@Foo`, `@file:`),
  string templates (`$name`, `${expr}`) inside normal and raw (`"""`) strings,
  char literals, numbers with `_` and suffixes (`L`, `f`, `u`, hex, binary),
  function names after `fun`, type names (capitalized identifiers), `val`/`var`
  definitions, nested block comments, KDoc. Map tokens to Lezer tags so the
  same theme colors apply.
- Colors: one `HighlightStyle` that uses CSS variables `--tok-*` defined in
  `src/editor/tokens.css` for both themes. It must look good for Kotlin,
  Java, JS/TS, Python, HTML, SQL (keywords, control keywords, types, function
  names, definitions, properties, strings, numbers, comments, annotations,
  operators, tags, attributes, headings, links, ...).
- Large files: bigger than `editor.largeFileMB` → plain mode (no language, no
  extension providers, no selection-match highlight, no folding); status bar
  says so. Bigger than `editor.maxFileMB` or binary → do not open; notify
  (unless a `FileOpener` handled the file).
- Status bar items (ids in section 6). Clicking them runs the matching
  command (quick pick to change language, encoding, indentation, line ending).
- Saving: `file.save` etc. Handle `conflict` (ask Overwrite / Reload /
  Cancel), `unmappable` (offer Save as UTF-8), read-only files. Apply
  `files.trimTrailingWhitespace` and `files.insertFinalNewline`. Emit
  `file:saved`. Auto save per `files.autoSave`. Save As uses
  `@tauri-apps/plugin-dialog` `save()`.
- On `fs:changed`: for open files in `paths`, `fsStat`; if mtime differs:
  not dirty → reload and keep cursor and scroll; dirty → notify with actions
  "Reload" and "Keep mine". On `rescan`: check all open files.
- Zoom: `ctx.editors.zoom(step)` changes `editor.fontSize` (6..48) for all
  editors at once without layout jumps (CSS variable + CodeMirror
  `requestMeasure`), and saves the setting debounced.
- Preview host: for files with a matching `PreviewProvider`, the tab shows a
  small Code / Split / Preview switch. Split is resizable. The engine calls
  `update()` debounced (150 ms) and `revealLine()` on editor scroll
  (rAF-throttled). `zoom()` goes to the preview when it has focus.
- `FileOpener` registry: ask openers before reading a file as text.
- Emit `file:opened` and `file:closed`. Mark tabs dirty with
  `ctx.tabs.setDirty`. Edits pin preview tabs (`ctx.tabs.pin`).

### 7.3 Files and workspace

- Rust (`kestrel-fs`, `cmd/fs.rs`): `fs_read_file`, `fs_write_file`, `fs_stat`
  (section 5.1); `fs_list_dir(dir, root)` → entries sorted folders first,
  natural case-insensitive order, each `{ name, path, isDir, isSymlink,
  ignored }` (`ignored` = matched by .gitignore; use the `ignore` crate);
  `fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_delete` (to trash, with
  a `permanent` option), `ws_open(root)` → `{ root, name }` (normalizes the
  path, starts the watcher for the calling window, allows the root for the
  preview protocol), `ws_close()`, the watcher (section 5.2), recent folders,
  per-folder session and global state as JSON files in the app data folder,
  `ws_new_window(root?)` (new window, URL `index.html?root=<encoded>`),
  `ws_launch_args()` → folder or file given on the command line (main
  window only).
- Frontend: `WorkspaceService` (types.ts). `open()` flow: `saveSession()` of
  the old root → `ctx.tabs.closeAll()` (cancel stops the switch) →
  `workspace:will-change` → `ws_open` → load per-folder state → set window title →
  `workspace:changed` → `ctx.tabs.restore(saved tabs)`. Session saves
  (debounced) on tab changes and before the window closes.
  `restoreInitial()`: `?root=` from the URL, else launch args, else the last
  folder of the main window, else nothing (empty state).
- Explorer view (`explorer`): virtualized tree of visible rows; children load
  on expand; expanded folders saved per folder; keyboard navigation (arrows,
  Enter, F2, Delete); single click opens a preview tab, double click a normal
  tab; context menu (New File, New Folder, Rename, Delete, Copy Path, Copy
  Relative Path, Reveal in Finder/Explorer via `@tauri-apps/plugin-opener`,
  Open Folder in New Window); inline rename and create; refresh changed
  folders on `fs:changed`; reveal and highlight the active file; git colors
  from `git:decorations`; ignored files greyed; `files.exclude` hidden.
- Commands in section 6. Drag and drop of files or folders onto the window
  (Tauri `onDragDropEvent`): folder → open it, file → open it in a tab.

### 7.4 Search

- Rust (`kestrel-search`, `cmd/search.rs`): a file index per root (keep the
  last 4 roots): parallel walk with the `ignore` crate (respects .gitignore,
  includes dotfiles, skips `.git`), built in a background thread; updated from
  the frontend on `fs:changed` (`search_index_update(root, paths)`, or a full
  rebuild on rescan). Fuzzy query with `nucleo-matcher` (path-aware, prefers
  matches in the file name), top N with match positions for highlights,
  parallel scoring for big indexes. Text search with `grep-searcher` /
  `grep-regex` over a parallel walk: options regex, match case, whole word,
  include and exclude globs, max results; results stream through a `Channel`
  in batches; cancel by id. Match ranges in the result must be UTF-16 code
  unit offsets inside the line (JS strings), not byte offsets. Lines longer
  than about 300 characters are cut around the match.
- Frontend: quick open (`search.quickOpen`, Mod-p) with `ctx.ui.quickPick`;
  empty query shows recently opened files of this folder; `name:120` jumps to
  line 120; shows the index status while it builds. Search view (`search`):
  query input with toggles (match case, whole word, regex), include/exclude
  inputs, results grouped by file with highlighted matches (virtualized),
  result count, cancel on new query, click opens the file at the match and
  selects it. Mod-Shift-f fills the query from the editor selection.

### 7.5 Git

- Rust (`kestrel-git`, `cmd/git.rs`): run the `git` program
  (`kestrel_common::process`); error `git_missing` when it is not installed,
  `not_a_repo` outside a repo. Commands: `git_repo_info(root)` (top level,
  branch, HEAD sha, upstream, ahead/behind if cheap); `git_status(root)` (parse
  `git status --porcelain=v2 -z --branch`; staged, unstaged, untracked,
  conflicts, renames; one status at a time per root, newer requests win);
  `git_show(root, rev, path)` (raw bytes response; `rev` is `HEAD`, `:0` for
  the index, or any ref; missing file → empty with a flag);
  `git_diff_names(root, base, target?)` (name-status with renames between a
  ref and the working tree, or between two refs); `git_merge_base(root, a,
  b)`; `git_branches(root)` (local and remote). Use `-c core.quotepath=off`
  and `-z` so non-ASCII paths work. Never run git on the main thread.
- Frontend: Git view (`git`): branch and base ref ("Working tree vs HEAD" by
  default, or "vs branch X" which uses the merge base, like a pull request);
  groups Conflicts, Staged, Changes, Untracked; virtualized; badge with the
  number of changes; click opens a diff tab. Diff tab (`diff`): lazily loaded
  `@codemirror/merge` `MergeView` side by side, switch to unified view,
  collapse unchanged regions, next/previous change, syntax colors by
  language, "Open file" button; refresh after `file:saved`. Editor gutter
  (`ctx.editors.registerExtension`, setting `git.gutter`): added / modified /
  deleted markers against the index version, updated debounced while typing,
  `git.nextChange` / `git.prevChange`. Status bar `git.branch`. Emit
  `git:decorations`. Refresh on `workspace:changed`, `file:saved`,
  `fs:changed` and window focus; coalesce refreshes.

### 7.6 LSP

- Rust (`kestrel-lsp`, `cmd/lsp.rs`): start a server (`lsp_start` with the
  command from settings, the root, env, and a `Channel<String>` for messages
  from the server); `lsp_send(key, message)`; `lsp_stop(key)`; stderr kept in
  a ring buffer (`lsp_logs(key)`) and streamed for the output panel;
  `lsp_find_root(file, markers, workspaceRoot)`; error `server_missing` when
  the program is not found (`kestrel_common::process::find_program`).
  Content-Length framing in both directions. Stop: `shutdown` request,
  `exit` notification, kill after a timeout (kill the whole process group on
  Unix; `jdtls` starts `java` as a child). Stop all servers of a window in
  `on_window_destroyed`, all servers in `on_exit`. `jdtls` needs `-data
  <app cache dir>/jdtls/<hash of root>`.
- Frontend: a `Transport` for `@codemirror/lsp-client` over the IPC (lazy
  import). One client per (server id, project root). An editor extension
  provider adds LSP to file editors whose language a server handles:
  diagnostics (lint gutter and Problems panel view `problems`), completion,
  hover, signature help, go to definition (also in other files, through
  `ctx.editors.openFile`), find references, rename, format, workspace symbols
  (quick pick). Status bar `lsp.status`. Output panel view `lsp-output` with
  server logs. Missing server: notify once with install hints
  (kotlin: JetBrains `kotlin-lsp`; java: `jdtls`; JS/TS:
  `npm i -g typescript typescript-language-server`). Stop the clients on
  `workspace:will-change`.

### 7.7 Preview

- Rust (`kestrel-markdown`, `cmd/preview.rs`): `md_render(text)` with comrak:
  GitHub flavor (tables, task lists, strikethrough, autolinks, footnotes,
  alerts if supported), heading ids, front matter, raw HTML allowed (it runs
  in a sandbox without scripts), `data-sourcepos` attributes for scroll sync.
  The `preview://` protocol (section 5.3) with correct MIME types and HTTP
  range support for audio and video.
- Frontend: markdown `PreviewProvider` (`.md`, `.markdown`): iframe with
  `sandbox="allow-same-origin"` (no scripts), a `<base>` that points to the
  folder of the file through `preview://`, GitHub-like styles that follow the
  theme, code blocks highlighted with `ctx.editors.highlightToHtml`, update
  in place (keep the scroll position), two-way scroll sync with
  `data-sourcepos`, a copy button and a wrap button on each code block (they
  sit in a wrapper outside the scrolling `pre`), the text width from
  `preview.markdownWidth` (0 is full width; drag handles at both edges of the
  text change it, double-click sets the default), line wrap in code blocks from
  `preview.markdownCodeWrap`, links: `http(s)` opens in the system browser
  (`@tauri-apps/plugin-opener`), relative `.md` opens in Kestrel, `#anchor`
  scrolls. HTML `PreviewProvider` (`.html`, `.htm`): live render of the
  editor text through `srcdoc` plus `<base>`; scripts off unless
  `preview.htmlScripts` (then `sandbox="allow-scripts"` without
  `allow-same-origin`). Image `FileOpener` (png, jpg, jpeg, gif, webp, bmp,
  ico, avif) and an SVG preview: tab kind `image`, fit / 100% / zoom with
  wheel and pinch, size and dimensions in the status bar (`preview.info`).
  `previewUrl(path)` helper in `src/ipc/preview.ts`.

## 8. Round 2: workspace tabs and new features

### 8.1 Window, workspace tabs and workbenches

A window shows a strip of **workspace tabs**. Each tab is one **workbench**:
its own `AppContext` (bus, commands, shell, editors, workspace service,
features), mounted in its own host element. Only one workbench is visible;
the others are hidden with `display: none` and stay alive, so switching is
instant (LSP servers, git state, undo history and scroll stay).

- macOS: the strip is in the title bar (`titleBarStyle: Overlay`, traffic
  lights on the left, about 38 px high, empty parts have
  `data-tauri-drag-region`). Windows and Linux: native title bar, the strip
  is the first row inside the window.
- The window manager (`src/window/**`, `src/main.ts`) owns: the strip UI,
  creating workbenches (only the active one at startup, others lazily on
  first activation), one shared `SettingsService` for all workbenches (it
  sends `settings:changed` to every bus), the window title, the window close
  flow (dirty check across all workbenches, then `saveSession()` of each),
  and the saved list of tabs per window.
- `ctx.window` (`WindowApi` in types.ts) is the only way for a feature to
  open a folder in a tab (`openFolder`, `pickFolder`), to set the title
  (`setTitle`) and to ask whether it is visible (`isActive`).

Rules for every feature (they are bugs if broken):

1. No module-level state shared between workbenches. Keep state per `ctx`.
2. Listeners on `window`, `document`, Tauri `listen()`, `matchMedia`, and
   timers: UI-global actions (key shortcuts, file drops, window focus or
   blur, auto save on blur) run only when `ctx.window.isActive()`. Remove
   them on `workbench:disposing`.
3. Overlays (quick pick, menus, dialogs, toasts) render inside the root
   element of the workbench, not in `document.body`, so a hidden workbench
   never shows them.
4. Tauri events that carry a root (`kestrel://fs-changed`,
   `kestrel://search-index`): ignore events of other roots.
5. Closing a workspace tab: the window manager calls
   `ctx.workspace.close()` (tabs close, `workspace:will-change` stops
   servers), then emits `workbench:disposing`, then removes the DOM.
6. `workbench:activated` / `workbench:deactivated`: refresh cheap state
   when you become visible (for example git status), and do not do UI work
   while hidden.

The Rust side is keyed by window label. Things that belong to a folder are
keyed by (window label, root): the watcher (`ws_open(root)`,
`ws_close(root)`), git status runs, LSP sessions.

### 8.2 Ownership in round 2

| Area | Owner | Files |
|------|-------|-------|
| Window manager, title bar tabs | window | `src/main.ts`, `src/window/**` |
| Shell | shell | `src/shell/**` |
| Files, explorer, compact folders, watcher per root | files | as in section 3 |
| File type icons and colors | icons | `src/ui/**` |
| Git history, blame, diff fixes | git | as in section 3 |
| CSV/TSV, HTML defaults, preview protocol | preview | as in section 3 |
| Drafts, auto save | engine | `src/editor/**` |
| Settings screen | settings | `src/features/settings/**` |
| Search and LSP follow-ups | search | search and LSP rows of section 3 |
| Contracts, config | integrator | as in section 3 |

### 8.3 New commands and keys

| Id | Key | Owner |
|----|-----|-------|
| `window.nextWorkspaceTab` / `window.prevWorkspaceTab` | Mod-Shift-] / Mod-Shift-[ | window |
| `window.closeWorkspaceTab` | (palette, tab ×) | window |
| `window.newWorkspaceTab` | (palette, + menu) | window |
| `workspace.openFolder` | Mod-o (opens in a workspace tab via `ctx.window`) | files |
| `workspace.openSettingsJson` | (palette) | files (was `workspace.openSettings`) |
| `settings.open` | Mod-, | settings |
| `file.newDraft` | Mod-n (replaces `file.new`) | engine |
| `file.openDraft` | (palette) | engine |
| `git.fileHistory` | Mod-Alt-h | git |
| `git.toggleBlame` | Mod-Alt-b | git |

Tab kinds added: `settings` (`settings:ui`), `git-history`
(`history:<path>`). Drafts are normal `file` tabs whose path is inside the
drafts folder `<AppInfo.dataDir>/drafts/` (`appInfo()` in `src/ipc/app.ts`).

Settings changed in round 2 (core/settings.ts): `files.autoSave` default
`afterDelay`; `preview.htmlMode` default `preview`; `preview.htmlScripts`
default `true`; new `explorer.compactFolders` (true) and `preview.csvMode`
(`preview`).

## 9. Database feature (MySQL and Trino)

Goal: look at and change data in remote MySQL databases from the editor:
run queries, see results, control transactions, browse the schema, read DDL.
It must be safe for production databases.

### 9.1 Contract and ownership

`src/ipc/db.ts` is the contract (integrator). Error codes: `db_error`,
`db_connect`, `db_busy`, `db_lost`, `db_auth` (login refused: MySQL 1045 or
Trino 401), `cancelled`.

| Area | Owner | Files |
|------|-------|-------|
| Rust sessions, MySQL client, SSH tunnel, keychain | db-backend | `crates/kestrel-db/**`, `src-tauri/src/cmd/db.rs`, the `db_*` part of `scripts/dev-bridge.mjs` |
| UI: Database view, connection form, SQL console, result grid, DDL tab | db-frontend | `src/features/db/**`, the DB section of `src/features/settings/schema.ts` |
| Contract, settings keys, wiring | integrator | `src/ipc/db.ts`, `src/core/**`, `src/window/workbench.ts` |

Test server: `scripts/dev-mysql.sh start` runs MySQL 8 in Docker on
127.0.0.1:13306 with the sample data of `scripts/dev-mysql/seed.sql`
(databases `kestrel_demo` and `kestrel_logs`; the user and the test
password are in the script).

### 9.2 Rust (db-backend)

- `mysql_async` (tokio; rustls with the `ring` provider, so no cmake). Text
  protocol for statements. All logic in `kestrel-db` with an async
  `DbManager`; `cmd/db.rs` is a thin wrapper, keyed by window label.
- Values: text as sent by the server; binary columns as hex preview (see
  `DbValue`). Column type names from the column metadata (+ `UNSIGNED`).
- Big results: stop at `maxRows`, mark `truncated`, `KILL QUERY` from a side
  connection, drain, keep the session usable.
- Transactions: track `autocommit` and `inTransaction` from the server status
  flags of each OK/EOF packet.
- SSH tunnel: system `ssh` with `-N -L`, `BatchMode=yes`,
  `ExitOnForwardFailure=yes`, `ServerAliveInterval`; wait until the local port
  accepts; one tunnel per (window, connection) shared by its sessions
  (ref-counted); kill the process group on close. ssh stderr goes into the
  `db_connect` error.
- Passwords: `keyring` crate (macOS Keychain, Windows Credential Manager,
  Linux Secret Service), service `dev.kestrel.editor.db`.
- Trino (`src/trino.rs`): the Trino REST protocol over `ureq` (blocking, run
  in `spawn_blocking`; rustls with `ring`, system CA roots). Login `none`
  (only `X-Trino-User`), `password` (HTTP Basic, https only) or `oauth2`
  (open `x_redirect_server` in the browser, poll `x_token_server` for up to
  3 minutes; the token is kept per connection id). Sessions always
  auto-commit (`supportsTransactions: false`). No SSH tunnel. A read-only
  Trino connection refuses statements other than SELECT, WITH, SHOW,
  DESCRIBE, EXPLAIN, VALUES, TABLE and USE on the client.
- CSV export (`src/export.rs`, `db_export_csv`): runs one read-only statement
  and streams every row into a file (UTF-8 BOM, header row) with no row
  limit. It writes to a temp file next to the target and renames it at the
  end; on error or cancel it removes the temp file.
- `crates/kestrel-db/examples/dev_http.rs`: a dev-only HTTP server
  (127.0.0.1:1435) that exposes the same `DbManager` as `POST /invoke/<cmd>`
  JSON, so the browser dev bridge can forward `db_*` commands to real Rust
  code.

### 9.3 Frontend (db-frontend)

- Sidebar view `database` (order 40): connections (color dot, production
  badge, read-only badge) → databases → Tables / Views / Procedures /
  Functions / Triggers → table → columns (type, key, nullable) and indexes.
  The tree uses its own "meta" session per connection. Context menu: New SQL
  Console, Select Top 100, Generate SELECT (opens a console with
  `SELECT * FROM <table> LIMIT 100`), Copy SELECT, Show DDL, Copy Name,
  Refresh, Edit / Duplicate / Delete Connection. Trino connections show only
  Tables and Views.
- Connection form tab (`db-connection`): all fields of `DbConnectionConfig`,
  password with "save in keychain", Test button. Stored with
  `ctx.settings.update({ 'db.connections': ... })`.
- SQL console tab (`sql-console`): one session per tab (lazy connect on first
  run; restored tabs reconnect on demand). Toolbar: connection and database
  pickers, Run (Mod-Enter: selection or statement at the cursor), Run Script
  (Mod-Shift-Enter), Cancel, Auto-commit switch, Commit, Rollback,
  transaction badge (Trino consoles hide the transaction controls). Editor: `@codemirror/lang-sql` MySQL dialect with schema
  completion (`db_completion_schema`). Results below (resizable): one tab per
  result, virtualized grid (sticky header, row numbers, NULL greyed, numbers
  right, resizable columns, client sort, cell select and copy, copy rows as
  TSV / JSON / INSERT, cell viewer for long text and JSON), a Download CSV
  button (rows shown, or all rows through `db_export_csv`), plus a
  Messages tab (time, statement, rows, elapsed, errors). Console text is
  saved with the session.
- `.sql` files in the workspace: Mod-Enter runs the statement at the cursor
  on the connection chosen in the status bar item `db.connection`; results
  show in the bottom panel view `db-results`.
- DDL tab (`db-ddl`): read-only SQL with colors and a Copy button.
- Safety: production connections show a red bar in the console; with
  `db.confirmWrites` they ask before statements that are not read-only.
  UPDATE or DELETE without WHERE always asks. Closing a console with an open
  transaction asks Commit / Rollback / Cancel. Lost connection: tell the user;
  never re-run a statement by itself.
- Client statement splitter for scripts: quotes, backticks, `--`, `#` and
  `/* */` comments, `DELIMITER`. Unit tests.

## 10. Round 4: IntelliJ data sources, web tabs, terminal

### 10.1 Ownership

| Area | Owner | Files |
|------|-------|-------|
| IntelliJ data sources | db-idea | `crates/kestrel-db/**`, `src-tauri/src/cmd/db.rs`, `src/features/db/**` |
| Web tabs | web | `crates/kestrel-web/**` (if needed), `src-tauri/src/cmd/web.rs`, `src/ipc/web.ts`, `src/features/web/**`, and the `overlay:changed` emits in `src/shell/{quickpick,menu,dialogs}.ts` and `src/window/menu.ts` |
| Terminal | terminal | `crates/kestrel-term/**`, `src-tauri/src/cmd/term.rs`, `src/ipc/term.ts`, `src/features/terminal/**`, the `term_*` section at the end of `scripts/dev-bridge.mjs` |
| Contracts, settings, wiring | integrator | `src/ipc/db.ts`, `src/core/**`, `src/window/workbench.ts`, `src-tauri/src/lib.rs`, `cmd/mod.rs`, Cargo and npm manifests, settings schema |

### 10.2 IntelliJ data sources

`db_idea_list(projectRoot)` (contract in `src/ipc/db.ts`) reads
`.idea/dataSources.xml`, `.idea/dataSources.local.xml`, `.idea/sshConfigs.xml`
and the IntelliJ application SSH configs. The JDBC URL can hold the user and
the password (`jdbc:mysql://user:pass@host:port/db`). Passwords stay in Rust.
The Database view shows an "IntelliJ" group for the open folder (setting
`db.idea.enabled`) and connects its MySQL sources when the view opens
(`db.idea.autoConnect`). MySQL, MariaDB and Trino sources are supported;
Trino sources keep the IntelliJ catalog and log in with a password when they
have a user and use https, else with the user name only. For a browser
login, use "Copy to My Connections" and set the login to `oauth2`. Names with `real`, `prod` or `live` count as
production; the IntelliJ read-only flag makes the connection read-only.

### 10.3 Web tabs

Many web apps (mail, calendar, chat) do not allow iframes, so a web tab is a
native child web view (`Window::add_child`, Tauri feature `unstable`) placed
over the tab content area. It has its own label `web-<n>`, no access to
Kestrel commands (no capability lists remote URLs), and the navigation guard
in `lib.rs` lets `web-*` web views go anywhere. The frontend keeps the bounds
in sync (ResizeObserver, window resize, sidebar drag), hides the web view when
its tab, its workbench or the window is hidden, and while `overlay:changed`
says a popup is open. Logins are stored by the system web view (WebKit on
macOS), so the user logs in once. Chrome cookies cannot be shared.

### 10.4 Terminal

A PTY per session in Rust (`portable-pty`): the login shell (or
`terminal.shell`) in the workspace root, `TERM=xterm-256color`, UTF-8 locale.
Output goes to the frontend through a `Channel` in raw byte batches. The
frontend uses `@xterm/xterm` (lazy chunk) in the bottom panel view
`terminal`: several terminal tabs, and each tab can split into panes side by
side or above each other.

## 11. Round 5: class diagram, find usages, Swift

### 11.1 Ownership

| Area | Owner | Files |
|------|-------|-------|
| Kotlin and Java parsers | lang-jvm | `crates/kestrel-lang/src/{kotlin.rs, java.rs, jvm_lex.rs}` (and sub modules under `src/kotlin/`, `src/java/`), `crates/kestrel-lang/tests/{kotlin,java}*.rs`, `crates/kestrel-lang/tests/fixtures/{kotlin,java}/**` |
| Swift parser | lang-swift | `crates/kestrel-lang/src/swift.rs` (and sub modules under `src/swift/`), `crates/kestrel-lang/tests/swift*.rs`, `crates/kestrel-lang/tests/fixtures/swift/**` |
| Code index | code-index | `crates/kestrel-code/**`, `src-tauri/src/cmd/code.rs`, the `code_*` section at the end of `scripts/dev-bridge.mjs` |
| Class diagram UI | diagram | `src/features/diagram/**`, the "Show Class Diagram" items in `menuFor` of `src/features/files/explorer.ts` |
| Find usages UI | usages | `src/features/usages/**`, `src/editor/context-menu.ts` (new) and the line in `src/editor/setup.ts` that adds it, the `lsp.referencesAt` command and the Shift-F12 fallback in `src/features/lsp/{index.ts,actions.ts,runtime.ts}` |
| Contracts and wiring | integrator | `crates/kestrel-lang/src/{lib.rs, model.rs}`, `src/ipc/code.ts`, Cargo and npm manifests, `cmd/mod.rs`, `src/window/workbench.ts`, `src/core/**`, Swift language support |

The contracts are `crates/kestrel-lang/src/model.rs` (what a parser returns)
and `src/ipc/code.ts` (what the frontend gets). Read them first. If a
contract must change, describe the change in your report.

### 11.2 Parsers (`kestrel-lang`)

Hand-written, single pass, no regex, no allocations per token. They read
packages, imports, types, supertypes, members and the type names that bodies
use (`TypeDecl::used_types`). They skip the logic inside bodies. Target speed:
more than 100 MB of source per second on one core in a release build. They
must survive broken code, unclosed strings and comments, and files of 5 MB.

`find_identifiers(lang, text, name)` lists every use of one name in code
(not in comments or strings) with a `UsageKind` and the dotted qualifier
before it. It must be fast: files that do not contain the name as bytes are
not passed to it (the caller checks first).

Language notes:

- Kotlin: nested block comments; `"..."` with `${...}` templates, `"""` raw
  strings; backtick names; annotations with use-site targets; `data`,
  `sealed`, `value`, `enum`, `annotation`, `fun interface`, `object`,
  `companion object` (name `Companion` when it has none); primary
  constructor `val`/`var` parameters are properties; `: Base(args)` is
  `Extends`; `: I by x` is delegated; extension functions keep the
  receiver; `typealias`; generic bounds and `where`; top-level members.
- Java: `class`, `interface`, `enum` (constants are `EnumCase`), `record`
  (components are fields), `@interface`; `extends`, `implements`, interface
  `extends` (`Implements`), `permits` is ignored; text blocks `"""`;
  several fields in one declaration (`int a, b;`); arrays and varargs;
  anonymous and local classes are not types, but their names go to
  `used_types`.
- Swift: `class`, `struct`, `enum` (`case a, b(Int)`), `protocol`, `actor`,
  `extension` (kind `Extension`, name = extended type); attributes
  (`@objc`, `@MainActor`, `@Published`); `"..."` with `\(...)`, `"""`,
  raw strings `#"..."#` with any number of `#`; nested comments;
  inheritance list entries are `Unknown`; `[Foo]`, `[K: V]`, `Foo?`
  sugar (see `TypeRef::name`); computed properties; `init`, `subscript`
  (a method named `subscript`), `static` and `class` members.

### 11.3 Code index (`kestrel-code`, `cmd/code.rs`)

- One index per workspace root, shared by the windows that use the root
  (ref count by window label, freed by `code_index_drop` and
  `on_window_destroyed`). Built on the first diagram or usages request, in
  parallel (rayon), from the Kotlin, Java and Swift files under the root.
  The walk follows `.gitignore` (crate `ignore`, hidden files seen, no
  `.git`) and always skips `.gradle`, `.idea`, `node_modules`, `Pods`,
  `Carthage`, `DerivedData`, `.build`, `.swiftpm`, and `build`, `out` or
  `target` folders next to a `build.gradle(.kts)`, `pom.xml` or
  `Package.swift`. Files bigger than 5 MB are skipped.
- The index keeps the `FileModel` of each file and no file text. Memory
  goal: under 60 MB for 16,000 Kotlin files (120 MB of source).
- Name resolution, in this order: type parameters; nested types of the
  current type and its outer types; types of the same file; explicit
  imports (and aliases); the same package; wildcard imports; Kotlin
  default imports (`kotlin.*`, `kotlin.collections.*`) and `java.lang`
  for Java; for Swift and when nothing else matched: a unique simple name
  in the project, else the one with the longest common path with the file.
  Dotted names (`a.b.Foo`, `Outer.Inner`) resolve by their parts.
- Edges: `extends` / `implements` from supertypes (`Unknown` becomes
  `implements` when the target is an interface or protocol, else
  `extends`; for an unresolved Swift class the first entry is `extends`
  when its name does not end in `Protocol`, `Delegate`, `DataSource` or
  `able`, `ible`); `composition` and `aggregation` from field and property
  types (aggregation when the type is a collection, map, array or
  sequence of the part, see the type names in the code); `dependency` from
  parameter and return types and `used_types` when no other edge joins the
  two types; `nested` from `outer`. Swift extensions merge into their type.
  Edges to types that are not in the project only appear with
  `includeExternal`, and never to basic types (`String`, `Int`, `Long`,
  `Boolean`, `Any`, `Object`, `Unit`, `List` ...: see the list in the code).
- `code_diagram(id, request)`: start types from the scope, then a breadth
  first walk over the chosen relations up to `depth`, in the chosen
  direction, until `maxNodes`. Members are cut at 60 per list.
- `code_usages(id, request)`: finds the name at the position (identifier
  characters around the column, not in a comment or string), decides what
  it is (`UsageSymbol::kind`) and searches the files of the same language
  family (Kotlin with Java, Swift alone). The bytes of the name filter the
  files first (`memchr::memmem`), then `find_identifiers` runs. For types,
  a match counts when that file resolves the name to the same type (so
  `Foo` from another package without an import is not a match). For
  members, files that name the owner type or a related type are `likely`.
  Calls of a type name become `instantiation`. Other languages: a whole
  word search in files with the same extension, `exact: false`.
- Requests run on a blocking thread, keyed by (window label, id) for
  `code_cancel`. A request waits while the index builds.
- `code_index_update(root, paths, rescan)` parses only the changed files.
- Dev bridge: `crates/kestrel-code/examples/dev_http.rs` serves the same
  commands on 127.0.0.1:1436 (`KESTREL_CODE_DEV_PORT`), and
  `scripts/dev-bridge.mjs` passes `code_*` calls to it, like `db_*`.

### 11.4 Class diagram UI (`src/features/diagram/**`)

- Tab kind `diagram`, id `diagram:<n>`, restored with its scope and options.
  Title: the start type (`FooService`), the file name, or the folder name.
- Commands: `diagram.showForCursor` "Show Class Diagram" (Mod-Alt-u, for
  Kotlin, Java and Swift editors), `diagram.showForFile`,
  `diagram.showForFolder` (argument: folder path; also in the explorer
  menu of folders and of `.kt`, `.java`, `.swift` files).
- Toolbar: one toggle per relation kind (with its line style as the icon),
  depth (0 to 5), direction (Supertypes / Subtypes and users / Both),
  members (None / Public / All), library types on or off, layout direction
  (top to bottom, left to right), fit, zoom, search a type, and Export
  (Copy as Mermaid, Copy as PlantUML, Save as SVG). Options are kept in
  `globalState` `diagram.options` for the next diagram.
- Layout: `@dagrejs/dagre` (lazy chunk), supertypes above subtypes (the
  edge goes from the superclass rank down to the subclass rank). Drawing:
  SVG with UML markers (hollow triangle for extends, dashed line with
  hollow triangle for implements, filled diamond at the owner for
  composition, hollow diamond for aggregation, dashed open arrow for
  dependency, circle with a plus at the outer type for nested). Theme
  variables only. Pan with drag and the scroll wheel, zoom with
  Mod-wheel, pinch, and the tab `zoom()` keys.
- Nodes: stereotype line (`«interface»`, `«data»`, `«enum»`, `«object»`,
  `«protocol»`, `«struct»`, annotation names like `«Service»`), name, then
  fields and methods when the members option is on. The start types have
  an accent border. External types are grey. Click selects and highlights
  the edges of the node; double click opens the file at the line;
  context menu: Open, Focus on This Type (new start), Add Supertypes, Add
  Subtypes, Hide, Find Usages (`usages.find` with the path and line).
- Big results: a note when `truncated`, a spinner with Cancel while the
  index builds. The index follows `fs:changed` (only `.kt`, `.kts`,
  `.java`, `.swift` paths, debounced) through `codeIndexUpdate`, and
  `codeIndexDrop` runs on `workspace:will-change`.

### 11.5 Find usages UI (`src/features/usages/**`)

- Command `usages.find` "Find Usages" (Alt-F7). Optional argument
  `{ path, line, column }` (from the diagram), else the cursor of the active
  editor. It tries the language server first: hidden command
  `lsp.referencesAt` (`{ path, line, column }`, returns the LSP locations,
  or null when no server is ready for the file). With no ready server, an
  error, an empty answer, or no answer within 10 seconds, it uses
  `codeUsages`. Swift files use `codeUsages` first, because
  `sourcekit-lsp` only knows other files after a build.
- Bottom panel view `usages` (order 15, title "Usages"): header with the
  symbol, the count, the source ("Language server" or "Kestrel index"),
  an "exact" or "name only" note, Search Again, and a switch to the other
  source. A virtualized tree: groups by kind (Declaration, Imports,
  Supertypes, New instances, Type uses, Calls, Other), or by folder and
  file (a toggle), with the matched name in bold. Files with
  `likely: false` go into a closed group "Same name, maybe other symbols".
  A filter box, expand and collapse all, a history of the last 10
  searches. Enter or click opens the match; `usages.next` /
  `usages.prev` (F4 / Shift-F4) move through the matches in the editor.
- Shift-F12 (`lsp.findReferences`) runs `usages.find` when the file has no
  ready language server.
- Editor context menu (`src/editor/context-menu.ts`, the engine adds it to
  every file editor): Go to Definition, Find Usages, Show Class Diagram,
  Rename Symbol, Format Document (each only when its command exists and
  applies), then Cut, Copy, Paste, Select All.

### 11.6 Swift

- Language `swift` (`.swift`): colors from the CodeMirror legacy Swift mode.
- Default language server `swift`: `sourcekit-lsp` (part of Xcode and of
  the Swift toolchain), root markers `Package.swift`, `buildServer.json`,
  `compile_commands.json`, `.sourcekit-lsp`. Without a build server an Xcode
  project gets only single-file features, so find usages and the class
  diagram use the Kestrel index for Swift too.

## 12. Round 6: call hierarchy, GitHub pull requests, branches, terminal input

### 12.1 Ownership

| Area | Owner | Files |
|------|-------|-------|
| `Member::end_line` in the parsers | lang-jvm, lang-swift | as in 11.1 |
| Callers backend | code-index | as in 11.1 (`code_callers`) |
| Call hierarchy UI | usages | `src/features/usages/**` (a new `call-hierarchy*` module set is fine), `src/editor/context-menu.ts`, the LSP call hierarchy helpers in `src/features/lsp/{index.ts,actions.ts}` |
| GitHub backend | gh-backend | `crates/kestrel-gh/**`, `src-tauri/src/cmd/gh.rs`, the `gh_*` section of `scripts/dev-bridge.mjs` |
| GitHub UI | github-ui | `src/features/github/**` except `review-diff/` |
| Review diff | review-diff | `src/features/github/review-diff/**` except `types.ts` |
| Branch switcher | git | `src/features/git/**`, `src/ipc/git.ts`, `src-tauri/src/cmd/git.rs`, `crates/kestrel-git/**`, the `git_*` commands in `scripts/dev-bridge.mjs` |
| Terminal | terminal | as in 10.1, plus `terminal.run` |
| Contracts and wiring | integrator | `src/ipc/code.ts`, `src/ipc/gh.ts`, `src/features/github/review-diff/types.ts`, `model.rs`, error codes, `cmd/mod.rs`, `workbench.ts`, `md_render_safe` |

### 12.2 Call hierarchy

- Command `callHierarchy.show` "Show Call Hierarchy" (Mod-Shift-h, editor
  context menu). Bottom panel view `call-hierarchy` (order 16). The root is
  the method at the cursor; each node lists its callers one level at a time
  (`codeCallers`), loaded when the user opens the node. The tree can go up
  as many levels as the user opens. A caller that is already on the path to
  the root is marked "recursive" and does not open again.
- Each caller row: the caller (`Type.method(params)`), the package or folder
  in grey, the number of calls. Its children: the call sites (line and text),
  then its own callers. Toggles: hide test code (`CallerNode.test`), hide
  "same name" callers (`likely: false`). Expand All opens every node to a
  depth of 3 with a limit of 500 nodes.
- With a ready language server (not Swift), the root and the first levels use
  `textDocument/prepareCallHierarchy` and `callHierarchy/incomingCalls`
  through a hidden command `lsp.incomingCalls`, like `lsp.referencesAt`.
  Without one, or on error or after 10 seconds, it uses `codeCallers`.
- Backend: callers = the usages of the target (calls, references to method
  references, `instantiation` for constructors) mapped to the member whose
  `line..=end_line` holds the call. Code outside members is an
  `initializer` of its type (or of the file for top-level code).
  `Member::end_line` comes from the parsers; when it is 0, the next member's
  line is the limit.

### 12.3 GitHub backend (`kestrel-gh`, `cmd/gh.rs`)

- Every call runs the `gh` program (`kestrel_common::process::command`) with
  `GH_PROMPT_DISABLED=1`, `NO_COLOR=1`, `GH_NO_UPDATE_NOTIFIER=1`, and a
  timeout (30 s; 120 s for `paginate` and checkout). Kestrel never reads,
  stores, logs or returns a token. Never pass `--show-token`, and drop any
  `token` field from JSON before it goes to the frontend.
- `gh_api`: `gh api --hostname <host> -X <method> <path>` with
  `--input -` for the body, `--paginate` (and `--slurp` to get one array)
  when asked, `-i` to read the HTTP status. The host must be one of the
  logged-in hosts. The path must be relative (no `://`, no leading `/`, only
  URL path and query characters). 401 gives `gh_auth`, 404 `not_found`,
  other errors `gh_error` with the status and GitHub's `message`.
- `gh_graphql`: `gh api graphql` with the query and variables as a JSON body.
- `gh_file_text`: the contents API with `Accept: application/vnd.github.raw`;
  bytes that are not UTF-8 give `binary`. Files over 5 MB give `too_large`.
- `gh_status`, `gh_switch`, `gh_logout`, `gh_repo_of` (parse every remote,
  `https://host/o/r(.git)`, `git@host:o/r(.git)`, `ssh://git@host/o/r`),
  `gh_pr_checkout` (in the folder, `gh pr checkout <n>`), `gh_cancel`
  (running calls keyed by window label and id; kill the process).
- Dev bridge: the `gh_*` commands run `gh` from Node in the same way.

### 12.4 GitHub UI (`src/features/github/**`)

- Sidebar view `github` (order 40, lucide `GitPullRequest`, title "Pull
  Requests"). Top: the accounts (host and login, active mark) with Switch,
  Log Out (asks first) and "Add Account" (runs `ghLoginCommand(host)` with
  `terminal.run`; the user types the host). Sections, each with a count and a
  refresh button: "Review Requested" (`is:pr is:open review-requested:@me`),
  "My Pull Requests" (`is:pr is:open author:@me`), "This Repository" (open
  pull requests of `ghRepoOf(root)`). One GraphQL search per section per
  host of the accounts; refresh on show and every 5 minutes while the view is
  visible (pause when hidden). Rows: title, `owner/repo#n`, author, time,
  review state (approved, changes requested, review required), draft mark,
  checks (passed, failed, running).
- Pull request tab: kind `pr`, id `pr:<host>/<owner>/<repo>#<n>`, restored.
  Header: title, state, `head -> base`, author, reviewers and their state,
  labels, checks, buttons Open in Browser, Check Out (only when the open folder
  is this repository: `ghPrCheckout`, then the git view refreshes), Refresh.
  Parts: Overview (description with `mdRenderSafe`, then the timeline of
  comments and reviews, and a box to add a comment), Files (list with
  status and +/- counts and the comment count, a filter, "viewed" marks kept
  per head commit in `globalState`; a click shows the review diff for that
  file, with Next File and Previous File), and the review bar (always
  visible): the number of draft comments, Finish Review (Comment, Approve,
  Request Changes, with a text box). Drafts stay in `globalState` until they
  are submitted or deleted, so a restart does not lose them.
- Diff contents: base = the merge base of the pull request (compare API),
  head = `head.sha`, files from `pulls/<n>/files` (paginate), texts with
  `ghFileText`. Review threads from GraphQL `reviewThreads` (line,
  startLine, diffSide, isOutdated, isResolved, comments). New comments:
  `now` posts a review comment (REST `pulls/<n>/comments` with `commit_id`,
  `path`, `line`, `side`, `start_line`); `review` keeps a draft; Finish
  Review sends `pulls/<n>/reviews` with `event` and all drafts as
  `comments`. Replies: `pulls/<n>/comments/<id>/replies`. Resolve: GraphQL
  `resolveReviewThread` / `unresolveReviewThread`.
- Every action that writes to GitHub (comment, reply, review, approve,
  resolve) runs only from a click of the user, shows a spinner, and shows
  the GitHub error text on failure. Approve and Request Changes ask for
  confirmation in the dialog of the review bar.
- Comments from other people are untrusted: only `mdRenderSafe` HTML goes
  into the page, links open in the system browser, images load only from
  `https:` URLs of the same host.

### 12.5 Branch switcher

- Command `git.switchBranch` "Switch Branch..." (Mod-Shift-b and a click
  on the status bar item `git.branch`). Quick pick: "Create New Branch...",
  "Create New Branch From...", then local branches (recent first, the current
  one marked, ahead/behind counts), then remote branches that have no local
  branch. Accept: `git switch <branch>` (a remote branch: `git switch
  --track <remote>/<name>`). Fetch button or item: `git fetch --prune`.
- Local changes that block the switch: a dialog with "Stash and Switch"
  (`git stash push -u -m "Kestrel: before switching to <branch>"`, switch,
  then offer "Apply Stash" in a notification), "Cancel". Never discard
  changes. Untracked files that would be overwritten: show the git message.
- After a switch: refresh git status and decorations, reload open files that
  changed on disk (the files feature does this through `fs:changed`), and
  keep editors with unsaved changes as they are (warn first when any editor
  is dirty).

### 12.6 Terminal: colors and input

- Colors: a real ANSI palette for dark and light themes with distinct
  bright colors (not the UI colors), `minimumContrastRatio` 4.5, and
  `CLICOLOR=1` in the shell environment so BSD `ls` shows colors.
- Command line colors (setting `terminal.highlightCommands`, default true,
  zsh only): Kestrel starts zsh with its own `ZDOTDIR` folder whose files load
  the user's own files first (`$HOME/.zshenv`, `.zprofile`, `.zshrc`,
  `.zlogin`, or the user's own `ZDOTDIR`), then add a small `zle` highlighter:
  command names (green when found, red when not), options, strings,
  variables, comments. It does nothing when the user already loads
  `zsh-syntax-highlighting` or `fast-syntax-highlighting`.
- Input: Japanese (Kotoeri) and Vietnamese (Simple Telex) input methods of
  macOS work in the terminal: composition text shows at the cursor, the
  candidate window opens at the cursor, Enter that confirms a conversion does
  not run the command, no doubled or lost characters, and Backspace during a
  composition edits the composition only. UTF-8 output is decoded as a stream.
- Hidden command `terminal.run` (`{ command, title?, cwd? }`): opens a new
  terminal tab and runs the command in it.

## 13. Round 7: Find in Files and Search Everywhere (like IntelliJ)

### 13.1 Ownership

| Area | Owner | Files |
|------|-------|-------|
| `regions` in the parsers | lang-jvm, lang-swift | as in 11.1 |
| Type and symbol search | code-index | as in 11.1 (`code_find_types`, `code_find_symbols`) |
| Search backend | search-backend | `crates/kestrel-search/**`, `src-tauri/src/cmd/search.rs`, the `search_*` part of `scripts/dev-bridge.mjs` |
| Find in Files UI | search-ui | `src/features/search/**` |
| Search Everywhere UI | goto | `src/features/goto/**`, the `lsp.workspaceSymbolsQuery` hidden command and the Mod-t binding in `src/features/lsp/index.ts` |
| Contracts and wiring | integrator | `src/ipc/search.ts`, `src/ipc/code.ts`, `kestrel-lang` `lib.rs`/`model.rs`, `workbench.ts` |

Keys: on macOS `Mod` is Cmd. The user also asked for the Ctrl forms, so on
macOS the commands also get `Ctrl-Shift-f`, `Ctrl-Shift-r` and
`Ctrl-Shift-o` (on other systems they are the same keys).

### 13.2 Find in Files popup (`search.findInFiles`, Mod-Shift-f)

- A popup over the editor area (inside the workbench root, sends
  `overlay:changed`), centered, movable by its header and resizable by its
  edges and corners; size and place are kept in `globalState`. It keeps its
  state (query, options, scope, results, selection, scroll) until the next
  search, so opening it again shows the last results at once.
- Header: "Find in Files", the counts ("1,234 matches in 87 files", "+"
  when the limit cut them), a pin button (keeps the popup open when it
  loses focus), and a button "Open in Find Window" (Mod-Enter): the sidebar
  Search view gets the same query, options and results.
- Query field: starts with the editor selection (one line) or the last
  query; history of the last 30 queries (Alt-Down or the clock button).
  Toggles with keys that use `KeyboardEvent.code` (so they work on macOS
  with Alt): Match Case (Alt-C), Words (Alt-O), Regex (Alt-X). A wrong
  regex shows its error under the field.
- File mask: a check box and a field with history (`*.kt, *.java`,
  `!*Test.kt` to exclude).
- Filter menu (funnel icon): Anywhere, In Comments, In String Literals,
  Except Comments, Except String Literals, Except Comments and String
  Literals (`context`).
- Scope tabs: In Project; Module (a drop-down of `searchModules`);
  Directory (a path field with the folder of the active file at first, a
  "Recursive" toggle, and a Choose button); Scope (Open Files, Changed
  Files from `git:decorations`, Current File, Production Files, Test
  Files: test files use the rule of `CallerNode.test`, written as globs).
- Results: a virtualized list (one row per match: the line text with the
  matches in bold, the file name and line number on the right; a group by
  file toggle). Up and Down move; the preview shows the selection.
- Preview: a read-only CodeMirror view under the list (resizable split)
  with syntax colors, every match of the file marked and the selected one
  stronger, scrolled to it, with the file path above it. Double click in the
  preview or Enter in the list opens the file at the match and closes the
  popup (unless pinned). Mod-Enter in the list opens it and keeps the popup.
- Search runs as you type (debounced 150 ms, the old search is cancelled),
  streams results, and stops at `search.maxResults`.

### 13.3 Replace in Files (`search.replaceInFiles`, Mod-Shift-r)

- The same popup with a Replace field (history too) and a Preserve Case
  toggle. Rows show the old text struck through and the new text. Exclude
  a match or a file from the replace with the X button or Delete; excluded
  rows are grey. Buttons: Replace (the selected match), Replace All (asks
  "Replace N matches in M files?").
- The replacement uses JavaScript `RegExp` on the current text (`$1`,
  `$<name>`, `$&`, `\n` in regex mode). Open files change through their
  editor (one undoable transaction per file, then the normal auto save);
  other files are read and written through `src/ipc/fs.ts` with their
  encoding, BOM and line endings kept and `expectedMtimeMs` set, so a file
  that changed on disk is skipped and listed. After the replace the search
  runs again.

### 13.4 Search Everywhere (`src/features/goto/**`)

- A popup at the top of the editor area like IntelliJ, with the tabs All,
  Classes, Files, Symbols, Actions, Text. Tab and Shift-Tab switch tabs.
  Commands: `goto.everywhere` (Shift pressed twice), `goto.class`
  (Mod-Shift-o, opens the Classes tab), `goto.symbol` (Mod-Alt-o and Mod-t),
  `goto.action` (Mod-Shift-a). Mod-p stays the quick open of files.
- Each tab remembers its last query (selected, so typing replaces it). The
  query starts with the editor selection when it is one short line.
- Classes: `codeFindTypes`; rows: kind icon (class, interface, enum,
  object, record, annotation, struct, protocol, actor), the name with the
  matches in bold, the container in grey, a language badge, a "test" tag.
  For languages that the index does not read (TypeScript and others), the
  results of `lsp.workspaceSymbolsQuery` with class-like kinds are added
  when a server is ready. Filter menu: kinds, languages, "Hide test code".
- Symbols: `codeFindSymbols` plus LSP symbols; rows: kind icon, `name(params)`,
  `: type`, the owner in grey.
- Files: `searchFiles` (the file index of the search feature).
- Actions: the commands of `ctx.commands` with their key labels.
- Text: a short `searchText` (first 100 matches) with "Open in Find
  Window" to continue in the Find in Files popup.
- All: the best 5 of Classes, Files, Symbols and Actions, with a header
  per group and "more" that switches to that tab.
- `Name:42` or `Name:42:7` opens at that line. Enter opens, Shift-Enter
  opens in the background, Escape closes. Results arrive while you type
  (debounced 80 ms, stale requests cancelled with `codeCancel`). The first
  use shows "Reading the project's files..." while the index builds.

## 14. Round 8: Graph View of markdown files (like Obsidian)

The user wants the Graph View of Obsidian for the markdown files of the open
folder, and the folder tree must stay visible in it.

### 14.1 Ownership

| Area | Owner | Files |
|------|-------|-------|
| Note index | notes-backend | `crates/kestrel-notes/**`, `src-tauri/src/cmd/notes.rs`, the `notes` lines in `src-tauri/src/cmd/mod.rs`, the `kestrel-notes` lines in the root `Cargo.toml` and `src-tauri/Cargo.toml`, the `notes_*` section at the end of `scripts/dev-bridge.mjs`, `notes` in `APP_COMMAND` of `src/dev/browser-backend.ts` |
| Graph model | graph-model | `src/features/graph/model/**` (pure functions and their tests) |
| Graph view | graph-view | `src/features/graph/**` except `model/**` and `types.ts`, the graph items in `menuFor` of `src/features/files/explorer.ts` |
| Large CSV files | csv | `src/features/preview/csv*`, the large-file opt-in in `src/editor/**` and `src/core/types.ts` |
| Contracts and wiring | integrator | `src/ipc/notes.ts`, `src/features/graph/types.ts`, `src/window/workbench.ts`, wiki links in the markdown preview (`crates/kestrel-markdown`, `src/features/preview/markdown.ts`), npm packages |

New npm packages (installed): `d3-force`, `d3-quadtree`, `d3-hierarchy`,
`d3-polygon` and their `@types`.

### 14.2 Note index (`kestrel-notes`, `cmd/notes.rs`)

- One index per root, shared by the windows that use it (ref count by window
  label, like `CodeManager` in 11.3). Built on the first `notes_graph` or
  `notes_resolve` call, in parallel (rayon). Calls wait while it builds.
  `notes_index_update(root, paths, rescan)` reads only the changed files;
  `notes_index_drop` and `on_window_destroyed` free it. `notes_cancel(id)`
  stops a running `notes_graph` (key: window label and id).
- Walk: follow `.gitignore` (crate `ignore`, `require_git(false)`); never
  enter a folder whose name starts with `.` (`.git`, `.obsidian`, `.trash`,
  `.github`, `.claude` ...); skip `node_modules`, `Pods`, `Carthage`,
  `DerivedData`, and `build`, `out`, `target` folders next to a build file
  (rule of 11.3, plus `Cargo.toml` and `package.json`). Notes are `.md`,
  `.markdown` and `.mdx` files up to 5 MB (bigger ones are nodes without
  links). At most 20,000 notes (`truncated`). Other files are kept by path
  and by name for attachments, at most 200,000.
- The index keeps no text. Per note: rel path, title, tags, aliases, size,
  mtime and the raw links (target text, wiki or markdown, embed, line).
  Resolved links are computed again after files are added, removed or
  renamed (resolution depends on the names of all files); the result is
  cached until the next change.
- Reading a note (hand-written scanner, one pass, no regex):
  - Front matter: `---` on the first line up to `---` or `...`. Keys
    `title`, `tags`/`tag`, `aliases`/`alias`; values as a YAML list
    (`[a, b]` or `- a` lines) or one string (tags split by comma or space).
    `#` before a tag is dropped.
  - Not links: fenced code (```` ``` ```` or `~~~`, three or more, closed by
    the same character, at least as many), indented code (4 spaces or a tab
    after a blank line, outside lists), inline code spans (same number of
    backticks), HTML comments `<!-- -->`, Obsidian comments `%% %%`, math
    blocks `$$ $$`, and backslash escapes.
  - Wiki links: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
    `[[target#^block]]`, `[[folder/target]]`, embeds `![[target]]`;
    `\|` in tables is a pipe; `[[#heading]]` is a link to the same note
    (dropped). No line breaks inside.
  - Markdown links: `[text](dest)`, `[text](dest "title")`,
    `[text](<dest with spaces>)`, images `![alt](dest)`, reference
    definitions `[id]: dest` (each definition is one link). Destinations with
    a scheme (`http:`, `mailto:`, `obsidian:` ... any `[A-Za-z][A-Za-z0-9+.-]*:`)
    and `#anchor` only are not links. `#fragment` and `?query` are cut,
    then the text is percent-decoded. Parentheses inside need to balance.
  - Tags: `#tag` after the line start or a space; letters (any script,
    `#日本語`), digits, `_`, `-`, `/`; at least one character that is not a
    digit; not inside links or code. `# Heading` is not a tag.
  - Title: front matter `title`, else the first `# ` heading outside code.
- Resolving a link of note `N` (target `t` without `#...`):
  1. Markdown links: relative to the folder of `N` (a leading `/` means the
     root), then the same case-insensitive, then with `.md` added when `t`
     has no extension. Not found: step 3.
  2. Wiki links: relative to the folder of `N`, then from the root (each
     with `.md` added when `t` has no markdown extension).
  3. By name, case-insensitive: notes (or, when `t` has a non-markdown
     extension, files) whose rel path ends with `/t(.md)` or is `t(.md)`;
     then by front matter alias. Several candidates: the one in the folder
     of `N`, else the longest common folder prefix with `N`, else the
     shortest rel path, else the first by path.
  4. Not found: a `missing` node. Its path: for markdown links the joined
     path (plus `.md` when there is no extension); for wiki links with a `/`
     the path from the root; for other wiki links the folder of the first
     note (by path) that links to it. Missing nodes merge by their lower-case
     rel path (bare wiki links merge by lower-case name).
  Targets outside the root and folders are ignored. Links from a note to
  itself are dropped. Links to existing non-markdown files make
  `attachment` nodes.
- Speed (release, 8 cores): 10,000 notes of 5 KB build in under 1 s; one
  changed file updates in under 20 ms; `notes_graph` for 10,000 notes and
  50,000 links answers in under 100 ms.
- `notes_resolve(root, from, target, wiki)` uses the same rules (for the
  preview). Returns null for external URLs and for `#heading` only.
- Dev bridge: `crates/kestrel-notes/examples/dev_http.rs` serves the
  `notes_*` commands on 127.0.0.1:1437 (`KESTREL_NOTES_DEV_PORT`), and
  `scripts/dev-bridge.mjs` forwards them, like `code_*` (11.3).

### 14.3 Wiki links in the markdown preview (integrator)

comrak renders `[[target|alias]]` as a link with `data-wikilink`. A click
calls `notesResolve` and opens the note (markdown in preview mode) at the
heading; a missing note asks "Create note X.md?". Markdown links that do not
resolve as a path use the same call. In browser dev mode, `md_render` goes to the notes
dev_http (real comrak) when it runs, else to the small JS renderer of the
dev bridge. The hidden command `explorer.revealPath` (argument: a path)
selects a file or folder in the explorer for the graph.

### 14.4 Graph model (`src/features/graph/model/**`)

Pure functions, exported from `model/index.ts` with the names and types that
the file has now (see `src/features/graph/types.ts`). Unit tests for all of them.

- `buildFolderTree(graph, colorDepth, theme)`: the folders that hold nodes
  (notes, attachments, missing nodes), with counts and colors.
- `buildVisibleGraph(input)`, in this order:
  1. Scope: `project` = all; `folder` = the notes under the folder and the
     attachment and missing nodes they link to (the tree starts at that
     folder); `local` = breadth first from the center note over link edges
     (`incoming`, `outgoing`) up to `depth`, without `neighborLinks` only
     the edges found on the way. Tag nodes count as steps when `showTags` is on.
  2. Filters: `query` (on notes, attachments and missing nodes; a node of
     the local center always stays), `showAttachments`, `existingOnly`,
     hidden folders (all nodes below them).
  3. Tags: with `showTags`, one node per tag (lower case id, first spelling
     as the label) and `tag` edges from its notes. Nested tags link to
     their notes only (no tag tree).
  4. Collapsed folders: the folder becomes one node (`collapsed`, `weight` =
     notes inside); edges of the nodes inside move to it and merge (counts
     summed), edges inside the folder disappear. Works with `showFolders` off too.
  5. Folders: with `showFolders` (always in `radial` and `tree`), one node
     per folder that has visible nodes below it, and `tree` edges from each
     node to its folder (the root folder too). A parent comes before its
     children in `nodes`.
  6. Orphans: without `showOrphans`, nodes with `degree` 0 go (folder nodes
     are not orphans; a folder without visible nodes below it goes).
  7. `both` for pairs with links in both directions; `degree`; colors
     (first matching group, else `colorBy`: folder color of the folder at
     `colorDepth` on the path, or a stable color per first tag); labels.
  Stats and `emptyReason` ("No markdown files in this folder.", "Open a
  markdown file to see its local graph.", "No notes match the filter.").
- `compileQuery(text)`, like the Obsidian search (case-insensitive):
  words must all match the rel path (AND); `"exact phrase"`; `-term`
  excludes; `OR` between terms; `( )` groups; `path:`, `file:` (file
  name), `tag:` (`tag:#api` or `tag:api`, also matches `api/v2`),
  `title:`, `/regex/` on the rel path. A broken query sets `error`.
- `treeLayout(g, 'radial' | 'tree')`: d3-hierarchy over the folder tree
  (folders, then files). `radial`: leaves on circles (cluster layout), the
  radius grows with the number of leaves so labels do not overlap. `tree`:
  left to right, folders as columns. Tag nodes sit in a group of their own
  next to the root. Collapsed folders are leaves.
- `bundlePath(g, edge, pos, beta)`: hierarchical edge bundling. The
  control points go from the source up the folder chain to the lowest
  common folder and down to the target; `beta` pulls them toward the straight
  line (Holten 2006). The view draws them as a B-spline.
- `folderHulls(g, pos, padding)`: for each folder except the root that has
  at least one visible node below it, a padded convex hull (d3-polygon) of
  those nodes, with rounded corners (points on circles around the nodes).
  Deeper folders get less padding, so they stay inside their parents.
- `nodeRadius(node, nodeSize)`: grows with the square root of the degree;
  folders with their `weight`.
- Palettes for light and dark themes (12 colors with good contrast on the
  editor background); `normalizeOptions`, `normalizeFolderState`,
  `normalizeScope` check every field and clamp the numbers.
- Speed: `buildVisibleGraph` for 20,000 notes and 100,000 links under
  100 ms; `treeLayout` under 100 ms; `folderHulls` for 500 folders and 5,000
  nodes under 8 ms (the view calls it often during the simulation).

### 14.5 Graph view (`src/features/graph/**`)

- Tab kind `graph`, id `graph:<n>`, restored from the session with its
  `GraphTabState`. Title from `graphTitle`. Commands:
  - `graph.show` "Open Graph View" (Mod-Alt-g): whole project.
  - `graph.showLocal` "Open Local Graph" (Mod-Shift-Alt-g; argument: a file
    path; without it the active markdown file, and the graph follows the
    active editor).
  - `graph.showFolder` "Show Graph for Folder" (argument: folder path;
    explorer menu of folders). The explorer menu of markdown files gets
    "Show Local Graph".
- Data: `notesGraph` (shows "Reading notes..." while the index builds). The
  feature keeps the note index up to date like the diagram keeps the code
  index (11.3): `fs:changed` paths (all files, not only markdown) go to
  `notesIndexUpdate` (debounced 400 ms), then open graph tabs load the
  graph again and keep the positions of nodes they already have (new nodes
  start next to their folder or a linked node). `workspace:will-change`
  drops the index.
- Drawing: one `<canvas>` (device pixel ratio, redraw only when something
  changes), pan with drag on the background, zoom with the wheel and
  pinch (Mod-= / Mod-- / Mod-0 through the tab `zoom()`), a Fit button.
  Notes are circles, attachments small squares, missing notes hollow
  circles, tags small diamonds, folders rounded squares with the folder
  name (collapsed folders bigger, with the count). Tree edges are thin and
  faint, tag edges dotted, link edges solid (width from `linkThickness` and
  `count`), arrows with `arrows`. Labels fade in with the zoom
  (`textFade`), the hovered node and its neighbors always have labels.
  Folder outlines (`folderOutlines`) are filled with a light tint of the
  folder color and show the folder name at the top. Theme colors come from
  the CSS variables and change on `theme:changed`.
- Layouts: `force` runs d3-force in a Web Worker (link, many-body
  (Barnes-Hut), center, collide, and a folder force that pulls nodes to the
  center of their folder with `folderPull`; tree edges are springs too).
  Positions come back as a `Float32Array` per tick. The simulation cools
  down and stops; dragging a node pins it while it moves and warms the
  simulation. `radial` and `tree` use `treeLayout` and animate from the old
  positions to the new ones (300 ms); links are bundled (`bundling`).
- Hover: the node, its edges and neighbors stay bright, the rest dims
  (animated). Click a note or attachment: open it (markdown in the default
  mode). Mod-click: open in the background. Click a folder: highlight its
  nodes; double click: collapse or expand it. Click a missing note: ask
  "Create note X.md?", then create it with `# X` and open it. Right click:
  Open, Open Local Graph, Reveal in Explorer, Copy Path, Collapse / Expand
  Folder, Hide Folder.
- The node of the active editor is marked (ring). A local graph with
  `follow` moves its center when another markdown file becomes active.
- Toolbar: the scope ("Graph: docs" ...), layout switch (Force, Radial,
  Tree), search field (the query, with the error under it), counts
  ("123 notes, 456 links"), Fit, the Settings button, the Folders button.
- Settings panel (floating on the right, sections that fold, like
  Obsidian): Filters (search, Tags, Attachments, Existing files only,
  Orphans), Groups (query + color + delete, "New group"), Display (Arrows,
  Label: name or title, Text fade, Node size, Link thickness, Bundling),
  Forces (Center, Repel, Link force, Link distance, Folder pull), Folders
  (Show folders, Folder outlines, Color by: folder, tag, none, Color depth),
  Local graph (Depth, Incoming, Outgoing, Neighbor links, Follow active note).
  "Reset" puts the defaults back. Changes apply at once and are saved
  (`OPTIONS_KEY` in `globalState`, and the tab state).
- Folders panel (on the left, can be closed): the folder tree from
  `buildFolderTree` with a color dot, the note count, an eye button (hide)
  and a collapse button per folder. Hover a folder: its nodes light up;
  click: zoom to its nodes. The state is `FolderState`, saved in the tab
  and in `workspace.state` (`FOLDERS_KEY`) for the next graph of the project.
- Speed: 5,000 notes and 20,000 links stay smooth (60 fps while the
  simulation runs, no drawing when nothing moves); 20,000 notes stay usable
  (fewer labels, simpler shapes when zoomed out). Hit tests use d3-quadtree.
