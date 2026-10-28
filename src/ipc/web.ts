// IPC for web tabs. Owner: web agent. See docs/DESIGN.md section 10.3.
//
// A web tab is a native web view that Rust creates (src-tauri/src/cmd/web.rs).
// Bounds are in logical pixels, relative to the top left corner of the window content.

import { invoke } from './invoke';

/**
 * True when the real Kestrel app runs. The browser dev bridge (src/dev/browser-backend.ts)
 * has no native web views. It sets `window.__kestrelDev`.
 */
export function webSupported(): boolean {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __kestrelDev?: unknown };
  return !!w.__TAURI_INTERNALS__ && !w.__kestrelDev;
}

export interface WebBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Creates the web view and returns its label (`web-<n>`). */
export function webOpen(url: string, bounds: WebBounds): Promise<string> {
  return invoke<string>('web_open', { url, ...bounds });
}
export function webSetBounds(label: string, bounds: WebBounds): Promise<void> {
  return invoke<void>('web_set_bounds', { label, ...bounds });
}
export function webShow(label: string): Promise<void> {
  return invoke<void>('web_show', { label });
}
export function webHide(label: string): Promise<void> {
  return invoke<void>('web_hide', { label });
}
export function webNavigate(label: string, url: string): Promise<void> {
  return invoke<void>('web_navigate', { label, url });
}
export function webBack(label: string): Promise<void> {
  return invoke<void>('web_back', { label });
}
export function webForward(label: string): Promise<void> {
  return invoke<void>('web_forward', { label });
}
export function webReload(label: string): Promise<void> {
  return invoke<void>('web_reload', { label });
}
export function webZoom(label: string, factor: number): Promise<void> {
  return invoke<void>('web_zoom', { label, factor });
}
export function webClose(label: string): Promise<void> {
  return invoke<void>('web_close', { label });
}

// ---- Events -----------------------------------------------------------------------------------

/** Events that Rust sends to the owning window as `kestrel://web`. */
export type WebEvent =
  | { kind: 'url'; label: string; url: string }
  | { kind: 'title'; label: string; title: string }
  | { kind: 'loading'; label: string; loading: boolean; url: string }
  | { kind: 'popup'; label: string; url: string }
  | { kind: 'download'; label: string; state: 'started' | 'done' | 'failed'; name: string; path: string | null };

type Handler = (e: WebEvent) => void;

// One Tauri listener for the whole window. It sends each event to the handler of
// its web view label. Labels are unique in the app, so workbenches do not mix.
const handlers = new Map<string, Handler>();
let listening: Promise<void> | null = null;

function ensureListener(): Promise<void> {
  listening ??= (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    // Only events for this window. Rust sends them with this label as target.
    await listen<WebEvent>('kestrel://web', (e) => handlers.get(e.payload.label)?.(e.payload), {
      target: { kind: 'AnyLabel', label: getCurrentWindow().label },
    });
  })().catch((err) => {
    listening = null;
    throw err;
  });
  return listening;
}

/** Receives the events of one web view. Returns a function that stops it. */
export function onWebEvent(label: string, fn: Handler): () => void {
  handlers.set(label, fn);
  void ensureListener().catch((err) => console.error('web events failed to start', err));
  return () => {
    if (handlers.get(label) === fn) handlers.delete(label);
  };
}
