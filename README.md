# Kestrel

Kestrel is a small and fast code editor for big codebases.
It runs on macOS, Windows and Linux. It uses Tauri 2 (Rust and the web view of
the system) and CodeMirror 6. It does not ship its own Chromium, so the app is
8 MB and starts in about a third of a second.

## Features

- **Workspace tabs.** Open several folders in one window. Each folder is a tab
  in the title bar and keeps its own editors, git state and language servers.
  Switching tabs is instant.
- **Big files and big folders.** Directory walk, search, git and markdown
  rendering run in Rust threads. Long lists only draw the visible rows.
- **Syntax colors** for Kotlin, Java, JavaScript, TypeScript, Python, HTML,
  CSS, SQL, JSON, Markdown, XML, YAML, Rust, Go, C++, Groovy and more.
- **Viewers.** Markdown and HTML preview (code, split or preview mode), CSV and
  TSV as a sortable table, images.
- **Git.** Changes view, side-by-side and unified diff, compare with any branch,
  file history, blame, and changed lines in the editor gutter.
- **Language servers (LSP)** for Kotlin, Java, JavaScript and TypeScript:
  completion, hover, go to definition, references, rename, format, problems.
  See [docs/LSP.md](docs/LSP.md).
- **Explorer** with file type icons, git colors, and compact folders like
  IntelliJ (`src/main/java`, then `com.example.app`).
- **Drafts.** Press Mod-n or the "+" in the tab bar to get a new file without
  choosing a place first. Drafts save by themselves and come back after a
  restart.
- **Auto save** by default. You can switch to manual save in Settings.
- **UTF-8 by default.** Kestrel detects other encodings (Shift_JIS, EUC-KR,
  UTF-16, ...), keeps the BOM and the line endings, and can re-open or save a
  file with another encoding.
- Quick open, find in files, light and dark theme, zoom for the editor, the
  preview and the whole window.

## Install on macOS

You need macOS 11 or newer.

### From the DMG

1. Get `Kestrel_<version>_aarch64.dmg` (Apple Silicon). For an Intel Mac, see
   "Build an app for Intel Macs" below.
2. Open the DMG and drag **Kestrel** into **Applications**.
3. Start Kestrel from Launchpad or Spotlight.

The app is signed ad hoc, not with an Apple Developer ID. If you downloaded the
DMG (for example from a release page or a chat), macOS blocks the first start
with "Apple could not verify Kestrel". Do one of these once:

- In Finder, right-click **Kestrel** in Applications, choose **Open**, then
  **Open** again.
- Or open **System Settings > Privacy & Security**, scroll down, and click
  **Open Anyway** next to the Kestrel message.
- Or run this in Terminal:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Kestrel.app
  ```

### Build the app yourself

Install the requirements in "Build from source" first. Then:

```sh
npm install
npm run tauri build
```

The results are in `target/release/bundle/`:

| File | What it is |
|------|------------|
| `macos/Kestrel.app` | The app. Copy it to `/Applications`. |
| `dmg/Kestrel_<version>_aarch64.dmg` | Disk image to share with other people. |

To install the app you built:

```sh
cp -R target/release/bundle/macos/Kestrel.app /Applications/
```

### Build an app for Intel Macs

A universal app runs on Apple Silicon and Intel Macs:

```sh
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

The output is in `target/universal-apple-darwin/release/bundle/`.

### Open a folder from Terminal

macOS passes the folder to Kestrel with `open`:

```sh
open -na Kestrel --args ~/work/my-project
```

Add this function to `~/.zshrc` to type `kestrel .` like `code .`:

```sh
kestrel() { open -na Kestrel --args "$(cd "${1:-.}" && pwd)"; }
```

### Uninstall

Delete `/Applications/Kestrel.app`. To remove the settings and the saved state
too, delete `~/Library/Application Support/dev.kestrel.editor/` and
`~/Library/Caches/dev.kestrel.editor/`.

## Install on Windows and Linux

There is no ready-made installer yet. Build it from source (next section).
`npm run tauri build` makes these files in `target/release/bundle/`:

| System | Files |
|--------|-------|
| Windows | an `.msi` installer (`msi/`) and a `-setup.exe` installer (`nsis/`) |
| Linux | `.deb`, `.rpm` and `.AppImage` packages (`deb/`, `rpm/`, `appimage/`) |

Only macOS builds have been tested so far.

## Build from source

All systems need:

- [Rust](https://rustup.rs) (stable)
- Node.js 20 or newer
- `git` in your PATH (the Git features use it)

macOS:

```sh
xcode-select --install
```

Windows:

- Microsoft C++ Build Tools ("Desktop development with C++")
- WebView2. Windows 10 (recent updates) and Windows 11 already have it.

Linux (Debian or Ubuntu package names):

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
  build-essential curl wget file
```

For other Linux systems, see the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Then:

```sh
git clone <this repository>
cd kestrel
npm install
npm run tauri dev      # run with live reload
npm run tauri build    # build the app and the installers
```

## Language servers

Kestrel does not include the language servers. Install the ones you need:

| Language | Install |
|----------|---------|
| Kotlin | `brew install JetBrains/utils/kotlin-lsp` (needs Java 17+) |
| Java | `brew install jdtls` (needs Java 21+) |
| JavaScript, TypeScript | `npm install -g typescript typescript-language-server` |

Kestrel finds them in the PATH of your login shell, also when you start it from
the Dock. Details, settings and troubleshooting are in
[docs/LSP.md](docs/LSP.md).

## Settings

Open the Settings screen with **Mod-,** (or the gear at the bottom left). Each
change applies at once. The values are stored in `settings.json`. The command
"Open Settings (JSON)" opens that file; it allows comments and trailing commas.

| System | Folder of `settings.json` |
|--------|---------------------------|
| macOS | `~/Library/Application Support/dev.kestrel.editor/` |
| Windows | `%APPDATA%\dev.kestrel.editor\` |
| Linux | `~/.config/dev.kestrel.editor/` (or `$XDG_CONFIG_HOME/dev.kestrel.editor/`) |

Main settings:

| Key | Default | Meaning |
|-----|---------|---------|
| `theme` | `"system"` | `"system"`, `"light"` or `"dark"` |
| `editor.fontSize` | `13` | Editor font size |
| `editor.tabSize` | `4` | Spaces per tab |
| `editor.wordWrap` | `false` | Wrap long lines |
| `editor.largeFileMB` | `8` | Bigger files open in plain mode (no colors, no LSP) |
| `files.autoSave` | `"afterDelay"` | `"afterDelay"`, `"onFocusChange"`, or `"off"` to save by hand |
| `files.autoSaveDelayMs` | `1000` | Wait time before an auto save |
| `files.exclude` | `.git`, `.DS_Store`, `Thumbs.db` | Hidden in the Explorer |
| `explorer.compactFolders` | `true` | Show single-child folder chains as one row |
| `preview.markdownMode` | `"preview"` | Start mode of Markdown files: `"code"`, `"split"` or `"preview"` |
| `preview.htmlMode` | `"preview"` | Start mode of HTML files |
| `preview.htmlScripts` | `true` | Run scripts in the HTML preview (in a sandbox) |
| `preview.csvMode` | `"preview"` | Start mode of CSV and TSV files (`"code"` = raw text) |
| `git.gutter` | `true` | Show changed lines in the gutter |
| `lsp.enabled` | `true` | Turn language servers on or off |
| `lsp.servers` | Kotlin, Java, TypeScript | Server commands, see [docs/LSP.md](docs/LSP.md) |

## Keyboard shortcuts

`Mod` is Cmd on macOS and Ctrl on Windows and Linux.

| Action | Keys |
|--------|------|
| Command palette | Mod-Shift-p, F1 |
| Quick open (find a file) | Mod-p |
| Find in files | Mod-Shift-f |
| Find, replace in the file | Mod-f; Mod-Alt-f (macOS) or Mod-h |
| Go to line | Ctrl-g |
| New draft | Mod-n |
| Save, save as, save all | Mod-s, Mod-Shift-s, Mod-Alt-s |
| Close tab, reopen closed tab | Mod-w, Mod-Shift-t |
| Next or previous editor tab | Ctrl-Tab, Ctrl-Shift-Tab |
| Next or previous workspace tab | Mod-Shift-], Mod-Shift-[ |
| Workspace tab 1 to 9 | Mod-1 ... Mod-9 |
| Open folder (in a workspace tab) | Mod-o |
| Open recent folder | Mod-r |
| New window | Mod-Shift-n |
| Settings | Mod-, |
| Toggle sidebar, bottom panel | Mod-b, Mod-j |
| Show Explorer, Git | Mod-Shift-e, Ctrl-Shift-g |
| Editor zoom in, out, reset | Mod-=, Mod--, Mod-0 |
| Window zoom in, out, reset | Mod-Alt-=, Mod-Alt--, Mod-Alt-0 |
| Toggle word wrap | Alt-z |
| Code or preview, code or split | Mod-Shift-v, Mod-Alt-v |
| Diff of the active file | Mod-Alt-d |
| Git history of the active file | Mod-Alt-h |
| Toggle git blame | Mod-Alt-b |
| Next or previous change | Alt-F5, Shift-Alt-F5 |
| Go to definition | F12, Mod-click |
| Find references | Shift-F12 |
| Rename symbol | F2 |
| Format document | Shift-Alt-f |
| Workspace symbols | Mod-t |

All other commands are in the command palette.

## Development

```sh
npm run typecheck        # TypeScript
npm test                 # Vitest, src/**/*.test.ts
cargo test --workspace   # Rust
```

- `scripts/fixtures.sh <folder>` makes a test folder with sample files, big
  files and a git repository.
- `scripts/measure.sh` measures the start time and the memory of a release build.
- `src/dev/README.md` explains how to run the UI in a normal browser with real
  files (useful for UI tests with browser tools).

Project layout:

```
src/            Web view code (TypeScript)
  core/         Event bus, commands, settings, shared types
  window/       Workspace tabs and the window
  shell/        Layout, editor tabs, status bar, quick pick, palette
  editor/       CodeMirror editors, languages, drafts, auto save
  features/     files, search, git, lsp, preview, settings
  ui/           File type icons
  ipc/          Typed wrappers of the Rust commands
src-tauri/      The Tauri app (Rust): thin command layer
crates/         Rust logic without Tauri (common, fs, search, git, lsp, markdown)
docs/           Design and guides
scripts/        Test fixtures, measuring, dev bridge
```

The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Measured speed

Release build on an Apple Silicon Mac (macOS 26), opening a small git repo.

| What | Result |
|------|--------|
| App size (frontend inside) | 8 MB; DMG 4 MB |
| Start to visible window (warm) | about 350 ms; about 245 ms of it is macOS starting the web view |
| Memory of the app process (physical footprint) | about 30 MB |
| Quick open query, 300k files | 2 to 10 ms |

The web view runs in separate system processes (WebContent, GPU, Networking).
On macOS they use about 100 MB more.

## Known limits

- Kestrel runs `git` in every folder you open. Git can run programs from the
  repository config (for example `core.fsmonitor` or filters). Open only
  folders you trust.
- Scripts in HTML previews run by default, inside a sandboxed frame without
  access to the app. Turn them off with `preview.htmlScripts` if you open HTML
  files you do not trust.
- The app is not notarized by Apple (see "Install on macOS").
- There is no terminal, no debugger and no extension system.

## License

MIT
