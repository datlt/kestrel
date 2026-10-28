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
| `workbench.showSearch` | Mod-Shift-f | shell → runs `search.findInFiles` |
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
| `search.findInFiles` | (via Mod-Shift-f) | search |
| `git.refresh` | (palette) | git |
| `git.openChanges` | Mod-Alt-d | git (diff of the active file) |
| `git.compareWithBranch` | (palette) | git |
| `git.nextChange` / `git.prevChange` | Alt-F5 / Shift-Alt-F5 | git |
| `lsp.gotoDefinition` | F12, Mod-click | lsp, editor |
| `lsp.findReferences` | Shift-F12 | lsp, editor |
| `lsp.rename` | F2 | lsp, editor |
| `lsp.format` | Shift-Alt-f | lsp, editor |
| `lsp.workspaceSymbols` | Mod-t | lsp |
| `lsp.restart` | (palette) | lsp |

View ids: sidebar `explorer` (order 10), `search` (20), `git` (30);
panel `problems` (10), `lsp-output` (20).

Status bar ids: left `git.branch` (100), `lsp.status` (50);
right `editor.cursor` (100), `editor.indent` (90), `editor.encoding` (80),
`editor.eol` (70), `editor.language` (60), `preview.info` (40).

Tab kinds and ids: `file` (`file:<path>`), `diff` (`diff:<base>:<path>`),
`image` (`image:<path>`).

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
  `data-sourcepos`, links: `http(s)` opens in the system browser
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
