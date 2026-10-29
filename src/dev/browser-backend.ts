// Dev only. Fake Tauri backend for a normal browser tab (no Tauri).
//
// main.ts calls installBrowserBackend() when import.meta.env.DEV is true and
// window.__TAURI_INTERNALS__ is missing. It installs a fake __TAURI_INTERNALS__.
// App commands go to the Vite plugin in scripts/dev-bridge.mjs through fetch.
// Events and channel messages come back through Server-Sent Events.
// Plugin commands (window, dialog, opener) are answered here, in the browser.

const BASE = '/__kestrel';
const WINDOW_LABEL = 'main';
const APP_COMMAND = /^(app|fs|ws|search|git|md|preview|lsp|db|web|term|code|gh|notes)_/;
/** Commands that answer with raw bytes instead of JSON. */
const RAW_RESPONSE = new Set(['fs_read_file', 'git_show']);
const CHANNEL_PREFIX = '__CHANNEL__:';

type Callback = (data: unknown) => unknown;
type InvokeOptions = { headers?: Record<string, string> } | undefined;

interface BridgeError {
  code: string;
  message: string;
}

/**
 * One id per page load. A reloaded page must not reuse the old id: the plugin
 * numbers channel messages per client, and a new page that starts again at 0
 * would wait for message 0 forever (terminals stayed empty after a reload).
 * The plugin forgets the old client after a short time and stops its shells.
 */
function clientId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function installBrowserBackend(): Promise<void> {
  const client = clientId();

  // --- Callbacks (used by Channel and by event listeners) -------------------
  const callbacks = new Map<number, Callback>();
  let nextCallbackId = 1;
  const transformCallback = (cb?: Callback, once = false): number => {
    const id = nextCallbackId++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return cb?.(data);
    });
    return id;
  };
  const unregisterCallback = (id: number) => void callbacks.delete(id);
  const runCallback = (id: number, data: unknown) => {
    const cb = callbacks.get(id);
    if (cb) cb(data);
    else console.warn(`[dev-backend] no callback with id ${id}`);
  };

  // --- Events -----------------------------------------------------------------
  // All listeners live here. The label is always `main`, so every listener
  // gets every event, whatever its target is.
  const listeners = new Map<string, Set<number>>();
  const dispatch = (event: string, payload: unknown) => {
    for (const handler of [...(listeners.get(event) ?? [])]) runCallback(handler, { event, id: handler, payload });
  };

  // --- Server events (SSE) ----------------------------------------------------
  const source = new EventSource(`${BASE}/events?client=${encodeURIComponent(client)}`);
  source.onmessage = (e) => {
    let m: { t: string; id?: number; data?: unknown; event?: string; payload?: unknown };
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.t === 'channel' && m.id !== undefined) runCallback(m.id, m.data);
    else if (m.t === 'event' && m.event) dispatch(m.event, m.payload);
  };
  // Wait until the stream is open, so no channel message is lost. The plugin
  // also keeps messages for a stream that is not connected yet.
  await new Promise<void>((resolve) => {
    source.onopen = () => resolve();
    setTimeout(resolve, 2000);
  });

  // --- Calls to the plugin ---------------------------------------------------
  async function callBridge(cmd: string, args: unknown, options: InvokeOptions): Promise<unknown> {
    const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
    const headers: Record<string, string> = { 'x-kestrel-client': client, ...(options?.headers ?? {}) };
    let body: BodyInit;
    if (raw) {
      headers['content-type'] = 'application/octet-stream';
      body = args as BodyInit;
    } else {
      headers['content-type'] = 'application/json';
      // A Channel serializes to "__CHANNEL__:<id>". The plugin finds it by that prefix.
      body = JSON.stringify(args ?? {});
    }
    let res: Response;
    try {
      res = await fetch(`${BASE}/invoke/${cmd}`, { method: 'POST', headers, body });
    } catch (e) {
      throw { code: 'io', message: `dev bridge is not reachable: ${e}` } satisfies BridgeError;
    }
    if (!res.ok) {
      let err: BridgeError;
      try {
        err = (await res.json()) as BridgeError;
      } catch {
        err = { code: 'internal', message: `dev bridge: HTTP ${res.status}` };
      }
      throw err;
    }
    if (RAW_RESPONSE.has(cmd)) return res.arrayBuffer();
    return res.json();
  }

  // --- Plugin commands (answered in the browser) ------------------------------
  const warned = new Set<string>();
  let windowCounter = 0;

  async function pluginCommand(cmd: string, args: any): Promise<unknown> {
    switch (cmd) {
      case 'plugin:event|listen': {
        const event = String(args.event);
        let set = listeners.get(event);
        if (!set) listeners.set(event, (set = new Set()));
        set.add(args.handler);
        // Same as the Tauri mock: the handler id is also the event id.
        return args.handler;
      }
      case 'plugin:event|unlisten':
        listeners.get(String(args.event))?.delete(args.eventId);
        callbacks.delete(args.eventId);
        return null;
      case 'plugin:event|emit':
      case 'plugin:event|emit_to':
        dispatch(String(args.event), args.payload);
        return null;

      case 'plugin:window|show':
      case 'plugin:window|set_focus':
      case 'plugin:window|hide':
        return null;
      case 'plugin:window|set_title':
        document.title = String(args.value ?? '');
        return null;
      case 'plugin:window|destroy':
      case 'plugin:window|close':
        console.info('[dev-backend] window close requested (ignored in a browser tab)');
        return null;
      case 'plugin:webview|set_webview_zoom':
        (document.documentElement.style as any).zoom = String(args.value ?? 1);
        return null;

      case 'plugin:dialog|open': {
        const o = args.options ?? {};
        const what = o.directory ? 'folder' : 'file';
        const picked = window.prompt(`${o.title ?? 'Open'}: type the absolute path of a ${what}`, '');
        if (!picked) return null;
        return o.multiple ? [picked] : picked;
      }
      case 'plugin:dialog|save': {
        const picked = window.prompt(`${args.options?.title ?? 'Save'}: type the absolute path`, args.options?.defaultPath ?? '');
        return picked || null;
      }
      case 'plugin:dialog|message':
      case 'plugin:dialog|ask':
      case 'plugin:dialog|confirm':
        return window.confirm(String(args.message ?? ''));

      case 'plugin:opener|open_url':
        window.open(String(args.url), '_blank', 'noopener');
        return null;
      case 'plugin:opener|open_path':
      case 'plugin:opener|reveal_item_in_dir':
        console.info(`[dev-backend] ${cmd}`, args.paths ?? args.path);
        return null;

      default:
        if (!warned.has(cmd)) {
          warned.add(cmd);
          console.warn(`[dev-backend] unknown plugin command ${cmd}, answering null`);
        }
        return null;
    }
  }

  // --- invoke -----------------------------------------------------------------
  async function invoke(cmd: string, args?: unknown, options?: InvokeOptions): Promise<unknown> {
    if (cmd.startsWith('plugin:')) return pluginCommand(cmd, args);
    if (cmd === 'ws_new_window') {
      // A new browser tab plays the role of a new window.
      const root = (args as { root?: string | null } | undefined)?.root;
      window.open(root ? `/?root=${encodeURIComponent(root)}` : '/', '_blank');
      return `win-${++windowCounter}`;
    }
    if (APP_COMMAND.test(cmd)) return callBridge(cmd, args, options);
    if (!warned.has(cmd)) {
      warned.add(cmd);
      console.warn(`[dev-backend] unknown command ${cmd}, answering null`);
    }
    return null;
  }

  const w = window as any;
  w.__TAURI_INTERNALS__ = {
    ...(w.__TAURI_INTERNALS__ ?? {}),
    invoke,
    transformCallback,
    unregisterCallback,
    runCallback,
    callbacks,
    metadata: {
      currentWindow: { label: WINDOW_LABEL },
      currentWebview: { windowLabel: WINDOW_LABEL, label: WINDOW_LABEL },
    },
    // Files are served by the plugin at /__kestrel/file/<absolute path>.
    convertFileSrc: (filePath: string) => fileUrl(filePath),
    plugins: { path: { sep: '/', delimiter: ':' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    ...(w.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {}),
    unregisterListener: (_event: string, id: number) => unregisterCallback(id),
  };
  // Handy in the browser console: pretend that the user closed the window.
  w.__kestrelDev = { closeRequested: () => dispatch('tauri://close-requested', null) };

  installPreviewRewrite();
}

/** URL of a local file on the dev server. */
function fileUrl(absPath: string): string {
  const slash = absPath.replace(/\\/g, '/');
  const encoded = slash.split('/').map(encodeURIComponent).join('/');
  return `${location.origin}${BASE}/file${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

// --- preview:// in a normal browser ---------------------------------------------
// The frontend builds `preview://localhost/<path>` URLs (src/ipc/preview.ts). A
// browser cannot load them. This code rewrites them to the dev server URL when
// they go into `src`, `href` or `srcdoc`. The reverse rewrite keeps link clicks
// in the Markdown preview working: `a.href` inside the frame gives back a
// preview URL, which the app turns into a file path.

const PREVIEW_URL = /preview:\/\/localhost\/|http:\/\/preview\.localhost\//g;

function installPreviewRewrite(): void {
  const origin = `${location.origin}${BASE}/file/`;
  const rewrite = (s: string) => s.replace(PREVIEW_URL, origin);
  const reverse = (s: string) => (s.startsWith(origin) ? 'preview://localhost/' + s.slice(origin.length) : s);

  const patchSetter = (proto: object, name: string, after?: (el: any) => void) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d?.set) return;
    Object.defineProperty(proto, name, {
      ...d,
      set(this: any, v: unknown) {
        d.set!.call(this, typeof v === 'string' ? rewrite(v) : v);
        after?.(this);
      },
    });
  };

  // Inside a Markdown preview frame: report anchor links as preview URLs again.
  const patchFrameLinks = (frame: HTMLIFrameElement) => {
    frame.addEventListener(
      'load',
      () => {
        try {
          const win = frame.contentWindow as any;
          const d = Object.getOwnPropertyDescriptor(win.HTMLAnchorElement.prototype, 'href');
          if (!d?.get || win.__kestrelPatched) return;
          win.__kestrelPatched = true;
          Object.defineProperty(win.HTMLAnchorElement.prototype, 'href', {
            ...d,
            get(this: any) {
              return reverse(d.get!.call(this));
            },
          });
        } catch {
          // A frame from another origin: leave it alone.
        }
      },
      { once: true },
    );
  };

  patchSetter(HTMLImageElement.prototype, 'src');
  patchSetter(HTMLSourceElement.prototype, 'src');
  patchSetter(HTMLMediaElement.prototype, 'src');
  patchSetter(HTMLIFrameElement.prototype, 'src');
  patchSetter(HTMLIFrameElement.prototype, 'srcdoc', patchFrameLinks);

  // Elements built from HTML text (innerHTML) get fixed afterwards.
  const fixAttrs = (el: Element) => {
    for (const name of ['src', 'href', 'poster']) {
      const v = el.getAttribute(name);
      if (v && PREVIEW_URL.test(v)) el.setAttribute(name, rewrite(v));
      PREVIEW_URL.lastIndex = 0;
    }
  };
  const fixTree = (node: Node) => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    fixAttrs(el);
    el.querySelectorAll('[src],[href],[poster]').forEach(fixAttrs);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') fixAttrs(r.target as Element);
      else r.addedNodes.forEach(fixTree);
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'poster'],
  });
}
