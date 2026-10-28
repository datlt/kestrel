// The part of the LSP feature that needs `@codemirror/lsp-client`.
// `manager.ts` loads this file with `import()` when the first matching file opens,
// so the library stays out of the startup bundle.
import { autocompletion } from '@codemirror/autocomplete';
import type { Language } from '@codemirror/language';
import {
  LSPClient,
  LSPPlugin,
  formatDocument,
  hoverTooltips,
  jumpToDefinition,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
} from '@codemirror/lsp-client';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { AppContext } from '../../core/types';
import { findReferences, renameSymbol, workspaceSymbols } from './actions';
import type { LspManager } from './manager';
import type { Session } from './session';
import { pathToUri } from './uri';
import { KestrelWorkspace } from './workspace';

const REQUEST_TIMEOUT_MS = 90_000;
const LOG_LEVELS = ['', 'error', 'warn', 'info', 'log'];

/** Removes scripts, event handlers and script links from HTML that a server sent. */
export function sanitizeHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const blocked = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META', 'BASE', 'FORM', 'SVG', 'MATH']);
  for (const el of [...template.content.querySelectorAll('*')]) {
    if (blocked.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // eslint-disable-next-line no-control-regex
      const value = attr.value.replace(/[\u0000- ]/g, '').toLowerCase();
      const isLink = name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'formaction';
      if (
        name.startsWith('on') ||
        name === 'style' ||
        name === 'srcdoc' ||
        (isLink && value.startsWith('javascript:')) ||
        (name === 'src' && !value.startsWith('data:image/'))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return template.innerHTML;
}

export function createClient(session: Session, ctx: AppContext, manager: LspManager): LSPClient {
  const languages = new Map<string, Language>();
  const loading = new Set<string>();
  // The library asks for a language at once, but loading is async. The first call
  // starts the load and gives null. Later calls get the language.
  const highlightLanguage = (name: string): Language | null => {
    const key = name.toLowerCase();
    const hit = languages.get(key);
    if (hit) return hit;
    if (!loading.has(key)) {
      loading.add(key);
      ctx.editors
        .loadLanguage(key)
        .then((l) => l && languages.set(key, l))
        .catch(() => {});
    }
    return null;
  };

  return new LSPClient({
    rootUri: pathToUri(session.root),
    initializationOptions: session.config.initializationOptions,
    // Servers like jdtls and kotlin-lsp need a long time to start.
    timeout: REQUEST_TIMEOUT_MS,
    workspace: (client) => new KestrelWorkspace(client, ctx),
    sanitizeHTML: sanitizeHtml,
    highlightLanguage,
    notificationHandlers: {
      // We keep a copy for the Problems panel. Returning false lets the library show the marks in the editor.
      'textDocument/publishDiagnostics': (_client, params) => {
        manager.diagnostics.set(session.id, params.uri, params.diagnostics ?? []);
        return false;
      },
      'window/logMessage': (_client, params) => {
        manager.log(session, [`[${LOG_LEVELS[params.type] ?? 'log'}] ${params.message}`]);
        return true;
      },
    },
    extensions: [
      serverCompletion(),
      hoverTooltips(),
      signatureHelp(),
      serverDiagnostics(),
      { clientCapabilities: { workspace: { symbol: {} } } },
    ],
  });
}

/** The CodeMirror extensions for one file editor. */
export function editorExtension(
  session: Session,
  uri: string,
  languageId: string,
  ctx: AppContext,
): Extension {
  const modKey = ctx.platform === 'macos' ? 'metaKey' : 'ctrlKey';
  return [
    session.client.plugin(uri, languageId),
    // serverCompletion() only adds a source. The popup needs this extension.
    autocompletion(),
    lintGutter(),
    keymap.of([
      { key: 'F12', run: jumpToDefinition, preventDefault: true },
      { key: 'Shift-F12', run: (v) => runAsync(v, () => findReferences(v, ctx)), preventDefault: true },
      { key: 'F2', run: (v) => runAsync(v, () => renameSymbol(v, ctx)), preventDefault: true },
      { key: 'Shift-Alt-f', run: formatDocument, preventDefault: true },
    ]),
    // Mod-click goes to the definition.
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !event[modKey] || event.shiftKey || event.altKey) return false;
        if (!LSPPlugin.get(view)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        view.dispatch({ selection: { anchor: pos } });
        jumpToDefinition(view);
        event.preventDefault();
        return true;
      },
    }),
  ];
}

function runAsync(view: EditorView, fn: () => Promise<void>): boolean {
  if (!LSPPlugin.get(view)) return false;
  void fn();
  return true;
}

/** Commands that the palette and the global keys call with the active editor view. */
export const actions = {
  gotoDefinition: (view: EditorView): boolean => jumpToDefinition(view),
  findReferences: (view: EditorView, ctx: AppContext): boolean => runAsync(view, () => findReferences(view, ctx)),
  rename: (view: EditorView, ctx: AppContext): boolean => runAsync(view, () => renameSymbol(view, ctx)),
  format: (view: EditorView): boolean => formatDocument(view),
  workspaceSymbols,
};

/** Removes the marks of old diagnostics from all open editors of a session. */
export function clearEditorDiagnostics(session: Session): void {
  const workspace = session.client.workspace as KestrelWorkspace;
  for (const view of workspace.views()) {
    try {
      view.dispatch(setDiagnostics(view.state, []));
    } catch {
      // The editor is gone.
    }
  }
}
