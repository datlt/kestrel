<p align="center">
  <img src="docs/images/icon.png" width="112" alt="Kestrel icon">
</p>

<h1 align="center">Kestrel</h1>

<p align="center">
  A small, fast code editor.<br>
  Read, review and fix code in the age of AI agents.
</p>

Kestrel is a code editor for the daily work of a developer: read, review and
fix code. It has what that work needs and leaves out the rest. You can change
it, and **feature requests are welcome** (see [Feature requests](#feature-requests)).

## Why Kestrel

IntelliJ IDEA is a great IDE, but it is heavy. It takes a long time to start,
indexes the whole project before it is useful, and uses gigabytes of memory.
You pay that price every time you want to look at code.

With AI agents, more and more code is written by the agent. Your day moves from
typing code to **reading it**: you review what the agent changed, follow the
diff and the history, read the plans and docs it wrote in Markdown, check the
data in the database, and make small fixes. Kestrel is built for this work,
and its goal is to replace IntelliJ IDEA for it:

- It opens in about half a second and the app process uses about 30 MB.
- Several repositories stay open side by side as workspace tabs.
- Diff, file history and blame are one key away.
- Markdown, HTML and CSV files open as rendered views as well as text.
- A database console for MySQL and Trino is built in, with transactions, DDL
  and CSV download.
- Language servers give you completion and go to definition when you need them.

## Why the name

<p align="center">
  <img src="docs/images/kestrel.jpg" width="640" alt="A common kestrel in the air, about to drop on its prey">
  <br>
  <sub>
    Common kestrel (<i>Falco tinnunculus</i>). Photo by Andy Morffew,
    <a href="https://commons.wikimedia.org/wiki/File:A_kestrel_prepares_to_swoop_down_on_its_next_meal_(54297184736).jpg">Wikimedia Commons</a>,
    <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>.
  </sub>
</p>

A [kestrel](https://en.wikipedia.org/wiki/Common_kestrel) is a small falcon.
It weighs about 200 grams. It can hang still in the wind above a field, watch
the ground for a long time, and then drop on its target in a second. The editor
tries to work the same way: light, able to hover over a big codebase so you see
the whole picture, and quick when you go down to the exact line.

## Features

- **Workspace tabs.** Open several folders in one window. Each folder is a tab
  in the title bar and keeps its own editors, git state and language servers.
  Switching tabs is instant.
- **Big files and big folders.** Directory walk, search, git and markdown
  rendering run in Rust threads. Long lists only draw the visible rows.
- **Syntax colors** for Kotlin, Java, Swift, JavaScript, TypeScript, Python,
  HTML, CSS, SQL, JSON, Markdown, XML, YAML, Rust, Go, C++, Groovy and more.
- **Viewers.** Markdown and HTML preview (code, split or preview mode), CSV and
  TSV as a sortable table, images.
- **Git.** Changes view, side-by-side and unified diff, compare with any branch,
  file history, blame, and changed lines in the editor gutter. Switch or create
  a branch in two key presses (Mod-Shift-b); Kestrel offers to stash your
  changes when git refuses.
- **GitHub pull requests** through the GitHub CLI (`gh`): your accounts, the
  pull requests that wait for your review and your own, the code changes with
  the review comments in the diff, new comments, replies, and Approve or
  Request Changes. See [GitHub pull requests](#github-pull-requests).
- **MySQL and Trino.** Saved connections (password in the OS keychain, SSH
  tunnel for MySQL, browser login for Trino), schema tree, SQL console with
  auto-commit on or off, commit and rollback, result grid, CSV download, DDL
  viewer, and run-the-statement for `.sql` files. See
  [Database](#database-mysql-and-trino).
- **IntelliJ data sources.** Open a project that has `.idea/dataSources.xml`
  and its MySQL and Trino data sources appear in the Database view and connect
  by themselves. Nothing to set up again.
- **Terminal** in the bottom panel: several terminal tabs, and each tab splits
  into panes side by side or above each other.
- **Web tabs.** Open web apps such as mail, calendar and chat as tabs next to
  your code (Web view on the left). You log in once inside Kestrel; it keeps
  the login. Kestrel cannot use the login of Chrome, because Chrome keeps its
  cookies in its own encrypted store.
- **Class diagrams** for Kotlin, Java and Swift. Pick the relations you want
  to see: inheritance, interfaces, composition, aggregation, dependencies,
  nested types. Copy the diagram as Mermaid or PlantUML. See
  [Class diagrams and Find Usages](#class-diagrams-and-find-usages).
- **Find Usages** (Alt-F7) like IntelliJ, grouped into imports, supertypes,
  new instances, type uses and calls. It works without a language server.
- **Call Hierarchy** (Mod-Shift-h): the callers of a method, then their
  callers, as deep as you open the tree.
- **Find in Files and Replace in Files** like IntelliJ (Mod-Shift-f,
  Mod-Shift-r): a popup with a preview, scopes (project, module, folder, open
  or changed files, production or test files), a file mask, and filters for
  comments and string literals. See [Search](#search).
- **Search Everywhere** (Shift twice), **Go to Class** (Mod-Shift-o) and **Go
  to Symbol** (Mod-Alt-o): camel hump search like `NABS` for
  `NewArrivalBookService`.
- **Language servers (LSP)** for Kotlin, Java, Swift, JavaScript and TypeScript:
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

You need macOS 11 or newer, and the tools in "Build from source" below.

### Build the app

```sh
npm install
npm run app
```

`npm run app` makes a release build of `Kestrel.app` (no DMG) and puts the
newest copy in the repository folder: `./Kestrel.app`. Open it from Finder or
with `open Kestrel.app`. Run the command again after you change the code; it
replaces the old copy.

`npm run app:open` does the same, then quits a running Kestrel and starts the
new build.

To keep a copy in Applications:

```sh
cp -R Kestrel.app /Applications/
```

The app is signed ad hoc, not with an Apple Developer ID. An app you build on
your own Mac opens without a warning. If you copy it to another Mac (for
example by chat or a download), macOS blocks the first start with "Apple could
not verify Kestrel". On that Mac, right-click the app, choose **Open**, then
**Open** again. Or run:

```sh
xattr -dr com.apple.quarantine /Applications/Kestrel.app
```

### Open a folder from Terminal

macOS passes the folder to Kestrel with `open`:

```sh
open -na ~/work/editor/Kestrel.app --args ~/work/my-project
```

Add this function to `~/.zshrc` to type `kestrel .` like `code .`
(change the path if your copy is in another place):

```sh
kestrel() { open -na ~/work/editor/Kestrel.app --args "$(cd "${1:-.}" && pwd)"; }
```

### Installers for other people

`npm run tauri build` also makes a DMG in `target/release/bundle/dmg/`. For an
app that runs on Apple Silicon and Intel Macs:

```sh
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

### Uninstall

Delete `Kestrel.app`. To remove the settings and the saved state too, delete
`~/Library/Application Support/dev.kestrel.editor/` and
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
git clone https://github.com/datlt/kestrel.git
cd kestrel
npm install
npm run tauri dev      # run with live reload
npm run app            # build ./Kestrel.app (macOS)
npm run tauri build    # build the app and the installers
```

## Language servers

Kestrel does not include the language servers. Install the ones you need:

| Language | Install |
|----------|---------|
| Kotlin | `brew install JetBrains/utils/kotlin-lsp` (needs Java 17+) |
| Java | `brew install jdtls` (needs Java 21+) |
| JavaScript, TypeScript | `npm install -g typescript typescript-language-server` |
| Swift | Nothing to install when you have Xcode (`sourcekit-lsp` is part of it) |

Kestrel finds them in the PATH of your login shell, also when you start it from
the Dock. Details, settings and troubleshooting are in
[docs/LSP.md](docs/LSP.md).

## Class diagrams and Find Usages

Kestrel reads the Kotlin, Java and Swift files of the open folder itself, so
both features work without a language server and without a build. The first
use reads the whole folder: about 1 second for 16,000 Kotlin files. After
that, a diagram or a search takes milliseconds to less than a second, and
Kestrel reads only the files that change.

### Class diagram

Put the cursor on a class, interface, enum, object, struct or protocol and
press **Mod-Alt-u** (or right-click, Show Class Diagram). You can also
right-click a file or a folder in the Explorer: the diagram then shows all
types in it.

The toolbar decides what you see:

| Control | Meaning |
|---------|---------|
| Extends, Implements | Superclasses, interfaces and protocols |
| Composition | A field or property holds one object of the other type |
| Aggregation | A field or property holds a list, set, map or array of the other type |
| Dependency | Parameters, return types and code in method bodies use the other type |
| Nested | Types declared inside the type |
| Depth | How many steps Kestrel follows from the start type (default 1) |
| Follow | Supertypes and parts, subtypes and users, or both |
| Members | Fields and methods in each box: none, public, all |
| Library types | Also show types from the JDK and other libraries (grey boxes) |

A type that many other types hold or use (a logger, a clock) gets a badge
like **+306**. Kestrel does not draw those types at first, so the diagram
stays readable. Right-click the box and choose Show More to add them.

In the diagram: drag or scroll to move, Mod-scroll or pinch to zoom, click a
box to see its relations, double-click to open the file. Right-click a box
for Focus on This Type, Add Supertypes, Add Subtypes, Hide and Find Usages.
**Export** copies the diagram as Mermaid or PlantUML text (for wiki pages)
or saves it as an SVG file.

### Find Usages

Put the cursor on a name and press **Alt-F7** (or right-click, Find Usages).
The Usages panel lists the results by kind: declarations, imports,
supertypes, new instances, type uses, calls and other uses. Press F4 and
Shift-F4 to go to the next and the previous usage.

- **Types**: Kestrel checks the imports and the package of each file, so a
  class with the same name in another package does not count.
- **Methods and fields**: Kestrel matches the name in the files that use the
  type, its supertypes and its subtypes. Matches in other files go into the
  group "Same name, maybe other symbols", which starts closed.
- **Local variables and parameters**: Kestrel searches the file. Press
  "Search all files" to search the whole folder.

When a language server is running for the file (Kotlin or Java), Find Usages
asks it first and shows "Language server" in the panel. The button next to it
switches to the Kestrel index. Shift-F12 also opens the Usages panel when no
language server is running.

### Call Hierarchy

Put the cursor on a method, constructor or function and press **Mod-Shift-h**
(or right-click, Show Call Hierarchy). The Call Hierarchy panel shows the
methods that call it. Open a caller to see where it calls and who calls that
caller, and so on up the tree. Each level takes some milliseconds.

- Callers in test code get a "test" tag. "Hide test code" removes them.
- Callers that Kestrel matched only by the name (for example `execute` of a
  framework interface) go into a closed group "Same name, maybe other
  methods" under each node.
- A caller that is already on the path to the root is marked "recursive".
- **Expand All** opens three levels (at most 500 callers).

## Search

### Find in Files (Mod-Shift-f)

The popup searches as you type and shows a preview of the selected match.

- **Match Case**, **Words** and **Regex**: the buttons in the field, or
  Alt-C, Alt-O, Alt-X.
- **File mask**: for example `*.kt, *.java` or `!*Test.kt` to leave files out.
- **Filter** (funnel button): Anywhere, In Comments, In String Literals,
  Except Comments, Except String Literals, Except Comments and String
  Literals. Kestrel reads the comments and strings of Kotlin, Java and Swift
  files.
- **Scope**: In Project, Module (Gradle, Maven, npm, Swift, Cargo or Go
  modules), Directory (with or without sub folders), or Scope: Open Files,
  Changed Files, Current File, Production Files, Test Files.
- Enter opens the match, Mod-Enter keeps the popup open, Alt-Down shows the
  history. The pin button keeps the popup open when you click elsewhere.
  **Open in Find Window** moves the results to the Search view on the left.

### Replace in Files (Mod-Shift-r)

The same popup with a Replace field. Each row shows the old text struck
through and the new text. Press Delete (or the X button) to leave a match or
a file out. **Replace** changes the selected match, **Replace All** asks
first. In regex mode `$1`, `$<name>` and `\n` work. **Preserve Case** keeps
`FOO`, `Foo` and `foo`. Open files change in their editor, so Mod-z undoes the
change; Kestrel does not touch a file that changed on disk after the search.

### Search Everywhere (Shift twice)

The tabs are All, Classes, Files, Symbols, Actions and Text. Tab switches
between them.

| Keys | Opens |
|------|-------|
| Shift, Shift | All |
| Mod-Shift-o | Classes (Go to Class) |
| Mod-Alt-o or Mod-t | Symbols (methods, fields, functions) |
| Mod-Shift-a | Actions (commands) |

- Type the capital letters of a name (`NABS`), parts of it (`newArr serv`), or
  a package before it (`cart.Service`). `*` matches anything. A space at the
  end means the name ends there.
- `Type#method` or `Type.method` finds a method of a type.
- `Name:42` opens at line 42.
- The filter button limits Classes and Symbols to some kinds or languages, or
  hides test code.
- With an empty query you see the classes and files that you opened last.

## GitHub pull requests

Kestrel uses the GitHub CLI. It never sees your token: `gh` keeps it in the
macOS keychain. Install and log in once:

```sh
brew install gh
gh auth login --hostname github.com       # or your GitHub Enterprise host
```

Open the **Pull Requests** view (the pull request icon on the left):

- **Accounts**: every `gh` login, with Switch and Log Out. The "+" button
  starts `gh auth login` in the Kestrel terminal.
- **Review Requested**, **My Pull Requests** and **This Repository** (the
  repository of the open folder). The lists refresh every 5 minutes while the
  view is open.

Click a pull request to open it in a tab:

- **Overview**: the description, the comments and reviews, and a box for a
  new comment.
- **Files**: the changed files and the diff of each file, side by side or in
  one column (the button in the diff toolbar). Review comments show under
  their lines. Hover a line and click **+** (or drag over line numbers for
  several lines) to write a comment. **Add to Review** keeps it as a draft;
  **Comment Now** posts it at once. `]` and `[` go to the next and previous
  file, `n` and `p` to the next and previous change. Mark files as viewed
  with the check box.
- **Finish Review**: sends your drafts with Comment, Approve or Request
  Changes. Kestrel asks before Approve and Request Changes. Drafts stay after
  a restart until you send or delete them.
- **Check Out** (when the open folder is this repository) runs
  `gh pr checkout`.

Comments from other people are shown without raw HTML, and links open in your
browser.

## Database (MySQL and Trino)

Open the **Database** view with Ctrl-Shift-d (or the database icon on the left).

1. Click **+**, choose the **Driver** (MySQL or Trino) and fill in the
   connection: host, port, user, password, default database, TLS mode.
   - **Save password in keychain** keeps the password in the macOS Keychain
     (Windows Credential Manager, Linux Secret Service). Without it, Kestrel
     asks for the password once per session. Passwords are never written to
     `settings.json`.
   - **SSH tunnel**: Kestrel runs your system `ssh`, so `~/.ssh/config`, keys
     and the ssh agent work. Password login for ssh is not supported.
   - **Production database** shows a red bar in the console and asks before
     statements that change data. **Read-only** makes every session read only.
     For Trino, Kestrel refuses every statement except SELECT, WITH, SHOW,
     DESCRIBE, EXPLAIN and VALUES.
2. Click **Test Connection**, then **Save**.
3. Expand the connection to see databases, tables, columns, indexes, views,
   procedures, functions and triggers. Right-click a table or view:
   - **Select Top 100** runs `SELECT * FROM <table> LIMIT 100` at once.
   - **Generate SELECT** writes the same statement into the SQL console you
     used last (or a new one) and selects it, so you can add a WHERE first.
   - **Copy SELECT** puts the statement on the clipboard.
   - **New SQL Console** and **Show DDL**.

**Trino.** Choose Trino as the driver, then set the **Catalog** (for example
`hive`) and, if you want, a default **Schema**. TLS "Required" means https.
**Login** has three choices:

- **None: only the user name**: Kestrel sends the user name in the
  `X-Trino-User` header and no password.
- **Password (HTTPS)**: the Trino password or LDAP login. Kestrel refuses to
  send a password over http.
- **OAuth2: login in the browser**: Kestrel opens the Trino login page in your
  browser and waits up to 3 minutes for you to log in. It keeps the login
  while Kestrel runs, so other consoles of the same connection do not ask
  again.

Trino has no transactions in Kestrel: every statement commits at once, and the
console hides Auto-commit, Commit and Rollback. Trino connections show tables
and views, but no procedures, functions, triggers or indexes. SSH tunnels are
for MySQL only.

**IntelliJ data sources.** When the open folder has `.idea/dataSources.xml`,
the Database view shows a group "IntelliJ: <folder>" with its data sources and
connects to the MySQL and Trino ones when the view opens (settings `db.idea.enabled` and
`db.idea.autoConnect`). The password comes from the JDBC URL in the file, or
from the IntelliJ entry in the keychain. It stays in the Rust side of Kestrel.
Names with `real`, `prod` or `live` count as production. PostgreSQL and other
drivers are listed but not supported yet. Right-click a source and choose
**Copy to My Connections** to change it (for example to use the browser login
for Trino).

In a SQL console:

| Action | Keys |
|--------|------|
| Run the selection or the statement at the cursor | Mod-Enter |
| Run the whole script | Mod-Shift-Enter |
| Cancel the running statement | Mod-. |
| New SQL console | Mod-Alt-n |

- **Auto-commit** is on by default. Turn it off to work in a transaction; the
  toolbar shows a **TRANSACTION** badge and enables **Commit** and
  **Rollback**. Closing a console with an open transaction asks Commit,
  Rollback or Cancel.
- UPDATE or DELETE without WHERE always asks first.
- Each result set gets its own tab. Right-click the grid to copy rows as TSV,
  JSON or INSERT statements. The **Messages** tab lists every statement with
  its time, rows and errors.
- **Download CSV** (button above the result, or right-click the grid) saves
  the result as a UTF-8 CSV file with a header row. Excel opens it with the
  right characters. When the result was cut off at the row limit, Kestrel asks:
  - **Rows shown** saves only the rows in the grid.
  - **All rows** runs the query again and writes every row straight into the
    file, with no row limit. This works only for statements that only read
    data. You can cancel it while it runs.
- In a `.sql` file of your project, choose a connection in the status bar and
  press Mod-Enter to run the statement at the cursor.

To try it without a real database, `scripts/dev-mysql.sh start` runs a local
MySQL 8 in Docker on 127.0.0.1:13306 with sample data (the user and the test
password are in the script). `scripts/dev-mysql.sh stop` removes it.

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
| `lsp.servers` | Kotlin, Java, Swift, TypeScript | Server commands, see [docs/LSP.md](docs/LSP.md) |
| `db.maxRows` | `1000` | Rows fetched per result in a SQL console |
| `db.confirmWrites` | `"production"` | Ask before data changes: `"production"`, `"always"` or `"never"` |
| `db.showSystemSchemas` | `false` | Show `mysql`, `sys`, `information_schema`, `performance_schema` |
| `db.idea.enabled`, `db.idea.autoConnect` | `true`, `true` | Show and connect the IntelliJ data sources of the open folder |
| `terminal.shell` | `""` | Shell for new terminals (empty: your login shell) |
| `terminal.fontSize` | `0` | Terminal font size (0: same as the editor) |
| `terminal.highlightCommands` | `true` | Color the zsh command line while you type (commands, options, strings, variables) |
| `web.bookmarks` | `[]` | Pages in the Web view |

## Keyboard shortcuts

`Mod` is Cmd on macOS and Ctrl on Windows and Linux.

| Action | Keys |
|--------|------|
| Command palette | Mod-Shift-p, F1 |
| Quick open (find a file) | Mod-p |
| Find in files, replace in files | Mod-Shift-f, Mod-Shift-r |
| Search Everywhere, Go to Class, Go to Symbol, actions | Shift Shift, Mod-Shift-o, Mod-Alt-o (or Mod-t), Mod-Shift-a |
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
| Find usages, next or previous usage | Alt-F7, F4, Shift-F4 |
| Class diagram of the type at the cursor | Mod-Alt-u |
| Call hierarchy of the method at the cursor | Mod-Shift-h |
| Switch branch | Mod-Shift-b (or click the branch in the status bar) |
| Rename symbol | F2 |
| Format document | Shift-Alt-f |
| Database view | Ctrl-Shift-d |
| Terminal: show or hide, new terminal | Ctrl-`, Ctrl-Shift-` |
| Terminal: split right, split down (in a terminal) | Mod-\\, Mod-Shift-\\ |
| Terminal: next or previous pane, close pane, clear (in a terminal) | Mod-Alt-Right, Mod-Alt-Left, Mod-w, Mod-k |
| Web tab: back, forward, reload | Mod-[, Mod-], Mod-Alt-r |
| Run SQL statement, run script | Mod-Enter, Mod-Shift-Enter |

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
- `scripts/dev-mysql.sh` starts a test MySQL server. `KESTREL_TEST_MYSQL=127.0.0.1:13306 cargo test -p kestrel-db`
  runs the database tests against it.
- `src/dev/README.md` explains how to run the UI in a normal browser with real
  files (useful for UI tests with browser tools). For database features also
  run `cargo run -p kestrel-db --example dev_http`.

Project layout:

```
src/            Web view code (TypeScript)
  core/         Event bus, commands, settings, shared types
  window/       Workspace tabs and the window
  shell/        Layout, editor tabs, status bar, quick pick, palette
  editor/       CodeMirror editors, languages, drafts, auto save
  features/     files, search, git, lsp, preview, settings, db, terminal, web
  ui/           File type icons
  ipc/          Typed wrappers of the Rust commands
src-tauri/      The Tauri app (Rust): thin command layer
crates/         Rust logic without Tauri (common, fs, search, git, lsp, markdown, db, term)
docs/           Design and guides
scripts/        Test fixtures, measuring, dev bridge
```

The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Measured speed

Release build on an Apple Silicon Mac (macOS 26), opening a small git repo.

| What | Result |
|------|--------|
| App size (frontend inside) | 10 MB |
| Start to visible window (warm) | 350 to 600 ms, depending on the load of the machine; about 245 ms of it is macOS starting the web view |
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
- MySQL TLS modes `preferred` and `required` encrypt the connection but do not
  check the server certificate. Trino over https checks the certificate
  against the system CA store.
- Cancel during a Trino browser login only stops the wait in Kestrel. If you
  finish the login in the browser later, Kestrel closes that session.
- Copy as INSERT uses MySQL backticks, also for Trino results.
- There is no debugger and no extension system.
- Web tabs are native web views over the editor. While a page has the focus,
  macOS sends Cmd shortcuts to the page, so click outside the page first.
  Web tabs are not tested on Windows and Linux yet.
- On Windows and Linux, Ctrl-w, Ctrl-k and Ctrl-\\ inside a terminal are
  Kestrel shortcuts, not shell keys.

## Feature requests

If something is missing, slow or in your way, open an issue at
<https://github.com/datlt/kestrel/issues>. Please write:

- what you want to do (for example "review a pull request branch"),
- what you do today instead, and
- a screenshot or an example file when it helps.

Pull requests are welcome too. Read [docs/DESIGN.md](docs/DESIGN.md) first: it
explains the parts and the rules that keep Kestrel small and fast.

## License

MIT
