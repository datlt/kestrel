// Contracts between the frontend parts of Kestrel.
//
// Each service below has exactly one owner (see docs/DESIGN.md, "Ownership").
// Other parts use the service only through these interfaces.
// Do not change a signature here without the integrator: other parts depend on it.
//
// Rule for all services: a factory (createShell, createEditorService, ...) must
// not call other services while it runs. Call them later, in event handlers
// or in methods. `main.ts` builds the context in steps, so some fields are not
// set yet while the factories run.

import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Language } from '@codemirror/language';

export interface Disposable {
  dispose(): void;
}

export type Platform = 'macos' | 'windows' | 'linux';

// ---------------------------------------------------------------------------
// Events (core/bus.ts)
// ---------------------------------------------------------------------------

export interface FsChangeEvent {
  /** Workspace root that the watcher watches. */
  root: string;
  /** Absolute paths that were created, changed or removed (batched, deduplicated). */
  paths: string[];
  /** True when something in `.git` changed that can change git status (HEAD, index, refs). */
  gitChanged: boolean;
  /** True when the watcher lost events. Consumers must re-read everything they cache. */
  rescan: boolean;
}

/** Git state of one file, for colors in the explorer and tabs. */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface AppEvents {
  /** Sent after all tabs of the old folder closed, before the folder changes. The old root is still active. */
  'workspace:will-change': { from: string | null; to: string | null };
  /** Sent after the folder changed and per-workspace state was loaded. */
  'workspace:changed': { root: string | null };
  'fs:changed': FsChangeEvent;
  'file:opened': { path: string };
  'file:saved': { path: string };
  'file:closed': { path: string };
  'tab:activated': { tabId: string | null };
  /** Tabs were opened, closed, moved, pinned or renamed (for session saving). */
  'tabs:changed': Record<string, never>;
  'settings:changed': { settings: Readonly<Settings>; previous: Readonly<Settings> };
  'theme:changed': { theme: 'light' | 'dark' };
  /**
   * Sent by the git feature after each status refresh. `files` maps absolute
   * file paths to their status and replaces the previous map completely.
   * Empty map when the folder is not a git repo.
   */
  'git:decorations': { root: string; files: Record<string, GitFileStatus> };
  /**
   * A popup over the editor area opened or closed (quick pick, palette, menu,
   * dialog). Native web views sit above the page, so the web tabs hide while
   * `open` is true.
   */
  'overlay:changed': { open: boolean };
  /** This workbench became the visible workspace tab of the window. */
  'workbench:activated': Record<string, never>;
  /** Another workspace tab became visible. This workbench stays alive in the background. */
  'workbench:deactivated': Record<string, never>;
  /**
   * The workspace tab is closing for good (after `workspace.close()`).
   * Remove every listener on `window`, `document` and Tauri events, stop timers,
   * and free Rust resources that belong to this workbench.
   */
  'workbench:disposing': Record<string, never>;
}

export interface EventBus {
  on<K extends keyof AppEvents>(type: K, fn: (e: AppEvents[K]) => void): Disposable;
  emit<K extends keyof AppEvents>(type: K, e: AppEvents[K]): void;
}

// ---------------------------------------------------------------------------
// Commands and keys (core/commands.ts)
// ---------------------------------------------------------------------------

export interface Command {
  /** Unique id, for example `file.save`. Use the prefix of your feature. */
  id: string;
  /** Text in the command palette. */
  title: string;
  /** Group name shown before the title in the palette, for example `Git`. */
  category?: string;
  /**
   * Key binding in CodeMirror notation: `Mod-Shift-p`, `Alt-z`, `F12`, `Mod-=`.
   * `Mod` is Cmd on macOS and Ctrl on Windows and Linux.
   * The shell runs the command when the key is pressed and nobody handled the
   * event before (`event.defaultPrevented` is false). CodeMirror key maps inside
   * the editor run first.
   */
  keybinding?: string | string[];
  /** When it returns false, the key binding is ignored and the palette hides it. */
  when?: () => boolean;
  /** Hide from the command palette (default: shown). */
  hidden?: boolean;
  run: (...args: any[]) => unknown;
}

export interface CommandRegistry {
  register(cmd: Command): Disposable;
  registerMany(cmds: Command[]): Disposable;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
  get(id: string): Command | undefined;
  list(): Command[];
  /** The command bound to this key event whose `when` passes, if any. */
  matchEvent(e: KeyboardEvent): Command | undefined;
  /** Text to show for a binding: `⌘⇧P` on macOS, `Ctrl+Shift+P` elsewhere. */
  keyLabel(binding: string): string;
}

// ---------------------------------------------------------------------------
// Settings (core/settings.ts)
// ---------------------------------------------------------------------------

export type ViewMode = 'code' | 'split' | 'preview';

export interface LspServerConfig {
  /** Program and arguments, for example `["typescript-language-server", "--stdio"]`. */
  command: string[];
  /** Language ids (see EditorService.languageIdFor) this server handles. */
  languages: string[];
  /** Files whose presence marks a project root, for example `build.gradle.kts`. */
  rootMarkers?: string[];
  /** Sent as `initializationOptions`. */
  initializationOptions?: unknown;
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  enabled?: boolean;
}

/**
 * All settings. Keys are flat, like VS Code. A feature can add keys with
 * declaration merging in its own file:
 *
 *   declare module '../../core/types' { interface Settings { 'git.foo': boolean } }
 *
 * and then call `ctx.settings.registerDefaults({ 'git.foo': true })` in its init.
 */
export interface Settings {
  'theme': 'system' | 'light' | 'dark';
  /** Zoom of the whole window (webview zoom). 1 = 100%. */
  'ui.zoom': number;
  'editor.fontFamily': string;
  'editor.fontSize': number;
  'editor.lineHeight': number;
  'editor.tabSize': number;
  'editor.insertSpaces': boolean;
  /** Detect tabs/spaces and indent size from the file content. */
  'editor.detectIndentation': boolean;
  'editor.wordWrap': boolean;
  'editor.lineNumbers': boolean;
  'editor.highlightActiveLine': boolean;
  /** Files bigger than this open in plain mode: no syntax tree, no LSP, no git gutter. */
  'editor.largeFileMB': number;
  /** Files bigger than this do not open. */
  'editor.maxFileMB': number;
  'files.exclude': string[];
  /** `afterDelay` (default) and `onFocusChange` save by themselves; `off` = save by hand (Mod-s). */
  'files.autoSave': 'off' | 'afterDelay' | 'onFocusChange';
  'files.autoSaveDelayMs': number;
  'files.trimTrailingWhitespace': boolean;
  'files.insertFinalNewline': boolean;
  /** Default encoding for new files. Existing files keep their own encoding. */
  'files.encoding': string;
  /** Show a chain of folders that each have only one child folder as one row (like IntelliJ). */
  'explorer.compactFolders': boolean;
  'preview.markdownMode': ViewMode;
  'preview.htmlMode': ViewMode;
  /** Run scripts in the HTML preview (inside a sandboxed frame). */
  'preview.htmlScripts': boolean;
  /** CSV and TSV files: `preview` shows a table, `code` shows the raw text. */
  'preview.csvMode': ViewMode;
  'git.enabled': boolean;
  'git.gutter': boolean;
  'lsp.enabled': boolean;
  'lsp.servers': Record<string, LspServerConfig>;
  'search.maxResults': number;
  /** Saved database connections (no passwords; see src/ipc/db.ts). */
  'db.connections': import('../ipc/db').DbConnectionConfig[];
  /** Rows to fetch per result set in SQL consoles. */
  'db.maxRows': number;
  /** Ask before statements that change data: on production connections only, always, or never. */
  'db.confirmWrites': 'production' | 'always' | 'never';
  /** Show mysql, sys, information_schema and performance_schema in the database tree. */
  'db.showSystemSchemas': boolean;
  /** Show the data sources of `.idea/dataSources.xml` of the open folder in the Database view. */
  'db.idea.enabled': boolean;
  /** Connect to the IntelliJ data sources when the Database view opens. */
  'db.idea.autoConnect': boolean;
  /** Web pages that open as tabs inside Kestrel (Web view). */
  'web.bookmarks': string[];
  /** Shell program for new terminals. Empty: the login shell ($SHELL, or PowerShell on Windows). */
  'terminal.shell': string;
  /** Terminal font size in px. 0: same as the editor. */
  'terminal.fontSize': number;
  /** Lines kept above the screen. */
  'terminal.scrollback': number;
  'terminal.cursorBlink': boolean;
}

export interface SettingsService {
  get<K extends keyof Settings>(key: K): Settings[K];
  all(): Readonly<Settings>;
  /** Writes the keys to settings.json and sends `settings:changed`. */
  update(patch: Partial<Settings>): Promise<void>;
  /** Adds defaults for keys that a feature declared. */
  registerDefaults(defaults: Partial<Settings>): void;
  /** Absolute path of settings.json (for the "Open Settings" command). */
  path(): string;
  /** Reads settings.json again (the shell calls it after the file is saved). */
  reload(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Persistent state (owner: files feature, src/features/files)
// ---------------------------------------------------------------------------

/** JSON key-value store. Writes are saved to disk later (debounced). */
export interface StateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// Tabs (owner: shell, src/shell)
// ---------------------------------------------------------------------------

export interface TabContent {
  focus(): void;
  dispose(): void;
  onShow?(): void;
  onHide?(): void;
  isDirty?(): boolean;
  /** Saves the content. Returns false when the user cancelled or saving failed. */
  save?(): Promise<boolean>;
  /**
   * Asks the user before the tab closes (not called for forced closes).
   * Return false to keep the tab open. When a tab has this hook, the shell
   * does not show its own Save / Don't Save dialog for it.
   */
  confirmClose?(): Promise<boolean>;
  /** Zoom step: 1 = in, -1 = out, 0 = reset. Return true when handled. */
  zoom?(step: 1 | -1 | 0): boolean;
}

export interface TabInput {
  /**
   * Unique key. Opening a tab with an id that is already open activates that tab.
   * Examples: `file:/abs/path`, `diff:HEAD:/abs/path`, `image:/abs/path`.
   */
  id: string;
  /** Kind used to restore the tab in the next session (see TabService.registerKind). */
  kind: string;
  title: string;
  /** Small grey text after the title (for example the parent folder). */
  description?: string;
  tooltip?: string;
  /**
   * Builds the content. The shell calls it lazily, the first time the tab is
   * shown, so restoring 30 tabs stays fast. `host` is an empty element that
   * fills the editor area.
   */
  create(host: HTMLElement): TabContent | Promise<TabContent>;
  /** Data to restore this tab later (JSON). Return null to not restore it. */
  serialize?(): unknown;
}

export interface Tab {
  readonly id: string;
  readonly input: TabInput;
  readonly title: string;
  readonly dirty: boolean;
  /** Preview tabs (italic title) are replaced by the next preview open. */
  readonly preview: boolean;
  /** null until the tab was shown once. */
  readonly content: TabContent | null;
}

export interface OpenTabOptions {
  /** Default true. */
  activate?: boolean;
  /** Open as a preview tab. The tab becomes normal on edit or double click. */
  preview?: boolean;
}

export interface SessionTabs {
  tabs: { id: string; kind: string; title: string; data: unknown }[];
  activeId: string | null;
}

export interface TabService {
  open(input: TabInput, opts?: OpenTabOptions): Tab;
  get(id: string): Tab | undefined;
  list(): Tab[];
  active(): Tab | null;
  activate(id: string): void;
  /** Asks to save when the tab is dirty (unless `force`). Returns false when the user cancelled. */
  close(id: string, opts?: { force?: boolean }): Promise<boolean>;
  closeAll(opts?: { force?: boolean }): Promise<boolean>;
  setDirty(id: string, dirty: boolean): void;
  setTitle(id: string, title: string, description?: string): void;
  /** Turns a preview tab into a normal tab. */
  pin(id: string): void;
  /** Rebuilds a TabInput from serialized data when a session is restored. */
  registerKind(kind: string, restore: (data: unknown) => TabInput | null): Disposable;
  snapshot(): SessionTabs;
  /** Opens the tabs of a saved session. Only the active tab is created at once. */
  restore(session: SessionTabs): Promise<void>;
}

// ---------------------------------------------------------------------------
// Views: sidebar and bottom panel (owner: shell)
// ---------------------------------------------------------------------------

export interface ViewInstance {
  onShow?(): void;
  onHide?(): void;
  focus?(): void;
  dispose?(): void;
}

export interface ViewDescriptor {
  id: string;
  title: string;
  /** Returns a new icon element (use lucide `createElement`). */
  icon: () => Element;
  location: 'sidebar' | 'panel';
  /** Lower comes first. Explorer 10, Search 20, Git 30. Panel: Problems 10, Output 20. */
  order: number;
  /** Called lazily the first time the view is shown. */
  create(host: HTMLElement): ViewInstance;
}

export interface ViewRegistry {
  register(view: ViewDescriptor): Disposable;
  /** Shows the view (opens the sidebar or panel when needed). */
  show(id: string, opts?: { focus?: boolean }): void;
  isVisible(id: string): boolean;
  /** Small text on the activity bar icon, for example the number of git changes. */
  setBadge(id: string, text: string | null): void;
  toggleSidebar(force?: boolean): void;
  togglePanel(force?: boolean): void;
}

// ---------------------------------------------------------------------------
// Status bar (owner: shell)
// ---------------------------------------------------------------------------

export interface StatusItem {
  id: string;
  align: 'left' | 'right';
  /** Higher priority is closer to the outer edge. */
  priority: number;
  text: string;
  tooltip?: string;
  /** Command to run on click. */
  command?: string;
  args?: unknown[];
}

export interface StatusBar {
  set(item: StatusItem): void;
  remove(id: string): void;
}

// ---------------------------------------------------------------------------
// UI helpers (owner: shell)
// ---------------------------------------------------------------------------

export interface QuickPickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  /** Character indexes in `label` to show in bold (fuzzy match). */
  labelHighlights?: number[];
  descriptionHighlights?: number[];
  /** Small text on the right, for example a key binding. */
  hint?: string;
  /** Icon before the label (for example `() => fileIcon(name)` from src/ui/file-icons.ts). */
  icon?: () => Element;
}

export interface QuickPickOptions<T extends QuickPickItem = QuickPickItem> {
  placeholder?: string;
  value?: string;
  /**
   * Static list: the shell filters it with its own fuzzy matcher.
   * Function: the shell calls it for each query change (debounced) and shows
   * the result as it is. Use `signal` to stop old requests.
   */
  items: T[] | ((query: string, signal: AbortSignal) => T[] | Promise<T[]>);
  onAccept(item: T, query: string): void;
  /** Called when the selected row changes (use it to preview). */
  onActive?(item: T | null): void;
  onCancel?(): void;
  /** Text when there are no items. */
  emptyText?: string;
}

export interface QuickPickHandle {
  close(): void;
  /** Runs the items function again (for example when the index finished loading). */
  refresh(): void;
}

export interface MenuItem {
  label: string;
  run(): void;
  keybinding?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface NotifyOptions {
  kind?: 'info' | 'warn' | 'error';
  actions?: { label: string; run(): void }[];
  /** 0 = stays until closed. Default 5000 (errors: 0). */
  timeoutMs?: number;
}

export interface UiService {
  quickPick<T extends QuickPickItem>(opts: QuickPickOptions<T>): QuickPickHandle;
  notify(message: string, opts?: NotifyOptions): void;
  /** In-app modal (never window.confirm). Returns the clicked button text, or null on Escape. */
  confirm(opts: { title: string; message?: string; buttons: string[] }): Promise<string | null>;
  prompt(opts: {
    title: string;
    value?: string;
    placeholder?: string;
    /** Return an error text to block OK, or null when the value is fine. */
    validate?(value: string): string | null;
    /** Select this range of `value` at start, for example the name without extension. */
    selection?: [number, number];
  }): Promise<string | null>;
  contextMenu(e: MouseEvent, items: MenuItem[]): void;
}

// ---------------------------------------------------------------------------
// Editors (owner: editor engine, src/editor)
// ---------------------------------------------------------------------------

export type LineEnding = 'lf' | 'crlf' | 'cr';

export interface FileMeta {
  /** encoding_rs name in lower case: `utf-8`, `utf-16le`, `shift_jis`, `euc-kr`, ... */
  encoding: string;
  bom: boolean;
  lineEnding: LineEnding;
  /** File modification time in ms, used to detect changes on disk. 0 for new files. */
  mtimeMs: number;
  size: number;
  readonly: boolean;
  /** Bigger than `editor.largeFileMB`: plain mode. */
  large: boolean;
}

export interface OpenFileOptions {
  /** 1-based line to reveal. */
  line?: number;
  /** 1-based column. */
  column?: number;
  /** Open as a preview tab (single click in a list). */
  preview?: boolean;
  /** Default true. */
  activate?: boolean;
  /** Code, split or preview, for files that have a preview provider. */
  mode?: ViewMode;
}

export interface FileEditor {
  /** Absolute path. Drafts live in the app drafts folder (see `isDraft`). */
  readonly path: string;
  readonly tabId: string;
  /** Language id, see EditorService.languageIdFor. */
  readonly languageId: string;
  readonly meta: FileMeta;
  /** The CodeMirror view. It exists as soon as `openFile` resolves. */
  readonly view: EditorView;
  getText(): string;
  isDirty(): boolean;
  save(): Promise<boolean>;
  /** True for drafts: files that Kestrel keeps in its own drafts folder (see EditorService.newDraft). */
  readonly isDraft: boolean;
  /** Reads the file again from disk. `encoding` re-decodes it with another encoding. */
  reload(opts?: { encoding?: string }): Promise<void>;
  /** 1-based line and column. Moves the cursor there and scrolls it to the center. */
  revealLine(line: number, column?: number): void;
  getMode(): ViewMode;
  setMode(mode: ViewMode): void;
  /** Called after every document change (not debounced). */
  onDidChange(fn: () => void): Disposable;
  focus(): void;
}

/**
 * Adds CodeMirror extensions to file editors (git gutter, LSP, ...).
 * Called once per file editor that is not in large-file mode. Return null to skip.
 */
export type EditorExtensionProvider = (editor: FileEditor) => Extension | null | Promise<Extension | null>;

export interface PreviewInstance {
  /** New text. The engine calls it once at start, then debounced (about 150 ms) after edits. */
  update(text: string): void;
  /** Editor scrolled: 1-based line at the top of the editor viewport. */
  revealLine?(line: number): void;
  zoom?(step: 1 | -1 | 0): void;
  dispose(): void;
}

export interface PreviewProvider {
  id: string;
  matches(path: string, languageId: string): boolean;
  /** Mode to use when the file opens and the caller gave no mode. */
  defaultMode(path: string): ViewMode;
  /**
   * `host` is an empty element next to (split) or instead of (preview) the code.
   * Call `editor.revealLine` when the user scrolls the preview (scroll sync).
   */
  create(host: HTMLElement, editor: FileEditor): PreviewInstance;
}

/**
 * Opens files that are not text, for example images.
 * The engine asks openers (by `priority`, higher first) before it reads a file as text.
 */
export interface FileOpener {
  id: string;
  priority: number;
  matches(path: string): boolean;
  /** Returns true when it opened the file. */
  open(path: string, opts: OpenFileOptions): Promise<boolean>;
}

export interface EditorService {
  /** Opens (or activates) the file in a tab. Returns null for files that an opener handled or that failed to open. */
  openFile(path: string, opts?: OpenFileOptions): Promise<FileEditor | null>;
  get(path: string): FileEditor | undefined;
  /** File editor of the active tab, if the active tab is a file editor. */
  active(): FileEditor | null;
  all(): FileEditor[];
  /**
   * Creates a draft: a new file in the app drafts folder, so the user does not
   * pick a place first. Drafts are saved like other files (auto save) and
   * come back after a restart. "Save As" moves a draft to a real place.
   */
  newDraft(): Promise<FileEditor | null>;
  registerExtension(provider: EditorExtensionProvider): Disposable;
  registerPreview(provider: PreviewProvider): Disposable;
  registerOpener(opener: FileOpener): Disposable;
  /**
   * Language id from the file name: `kotlin`, `java`, `javascript`, `typescript`,
   * `jsx`, `tsx`, `python`, `html`, `css`, `sql`, `json`, `markdown`, `xml`,
   * `yaml`, `rust`, `go`, `cpp`, `shell`, `groovy`, `properties`, `toml`,
   * `dockerfile`, `diff`, `plaintext`.
   */
  languageIdFor(path: string): string;
  /** Loads a CodeMirror language by id or alias (`kt`, `js`, `py`, `ts`...). */
  loadLanguage(idOrAlias: string): Promise<Language | null>;
  /** Highlights code to HTML with `tok-*` classes (for code blocks in previews). */
  highlightToHtml(code: string, idOrAlias: string): Promise<string>;
  /** CSS for the `tok-*` classes with the colors of the current theme. */
  highlightCss(): string;
  /** The syntax color extension of file editors, for other CodeMirror views (diff views). */
  highlightExtension(): Extension;
  /** Editor font zoom. 1 = bigger, -1 = smaller, 0 = reset. */
  zoom(step: 1 | -1 | 0): void;
}

// ---------------------------------------------------------------------------
// Workspace (owner: files feature)
// ---------------------------------------------------------------------------

export interface RecentFolder {
  path: string;
  name: string;
  lastOpenedMs: number;
}

export interface WorkspaceService {
  /** Absolute path of the open folder, or null. */
  readonly root: string | null;
  /** Folder name of the root. */
  readonly name: string | null;
  /**
   * Opens a folder in this window: saves the session of the old folder,
   * closes its tabs, sends `workspace:will-change` and `workspace:changed`,
   * then restores the tabs of the new folder.
   */
  open(root: string, opts?: { newWindow?: boolean }): Promise<void>;
  close(): Promise<void>;
  /** Native folder dialog, then `open`. */
  pickAndOpen(opts?: { newWindow?: boolean }): Promise<void>;
  recent(): Promise<RecentFolder[]>;
  /** Path relative to the root with `/` separators. Returns the input when it is outside the root. */
  relative(path: string): string;
  /** State saved per folder (expanded tree nodes, git base ref, ...). Reloaded before `workspace:changed`. */
  readonly state: StateStore;
  /** State shared by all folders (layout, last folder, ...). */
  readonly globalState: StateStore;
  saveSession(): Promise<void>;
  /**
   * Called once by the window manager after all features of this workbench
   * started: opens `root` (or no folder) and restores its saved tabs.
   */
  restoreInitial(root: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Window and workspace tabs (owner: window manager, src/window)
// ---------------------------------------------------------------------------

/**
 * One window shows several workspace tabs (in the title bar). Each tab is a
 * separate workbench: its own AppContext, shell, editors and folder. Only one
 * workbench is visible. Hidden workbenches stay alive, so switching is instant.
 */
export interface WindowApi {
  /** Unique id of this workbench in the window. */
  readonly workbenchId: string;
  /**
   * True while this workbench is the visible tab. Only the active workbench may
   * handle global keys, file drops, window focus events and the window title.
   */
  isActive(): boolean;
  /**
   * Opens `root` in a workspace tab of this window. If a tab has this folder
   * already, it becomes active. If the current tab has no folder, it is used.
   */
  openFolder(root: string): Promise<void>;
  /** Native folder dialog, then `openFolder`. */
  pickFolder(): Promise<void>;
  /** Window title for this workbench. Applied when this workbench is active. */
  setTitle(title: string): void;
}

// ---------------------------------------------------------------------------
// Shell factory result (owner: shell)
// ---------------------------------------------------------------------------

export interface Shell {
  readonly tabs: TabService;
  readonly views: ViewRegistry;
  readonly status: StatusBar;
  readonly ui: UiService;
  /** Builds the layout inside `root`. main.ts calls it after all services exist. */
  mount(root: HTMLElement): void;
}

// ---------------------------------------------------------------------------
// The context passed to every part
// ---------------------------------------------------------------------------

export interface AppContext {
  readonly platform: Platform;
  readonly window: WindowApi;
  /** Tauri label of this window. */
  readonly windowLabel: string;
  readonly bus: EventBus;
  readonly commands: CommandRegistry;
  readonly settings: SettingsService;
  readonly tabs: TabService;
  readonly views: ViewRegistry;
  readonly status: StatusBar;
  readonly ui: UiService;
  readonly editors: EditorService;
  readonly workspace: WorkspaceService;
}
