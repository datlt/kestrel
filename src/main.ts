// Startup. Owner: window. Error reporting, the dev browser backend, then the
// window manager (src/window) builds the workbenches.

import './styles/vars.css';
import './styles/base.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appLog } from './ipc/app';
import { startWindow } from './window';

function reportError(where: string, err: unknown) {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(where, err);
  appLog('error', `${where}: ${text}`);
}

window.addEventListener('error', (e) => reportError('window.onerror', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportError('unhandledrejection', e.reason));

async function start() {
  // Dev only: in a normal browser (no Tauri), use the Node bridge in scripts/dev-bridge.mjs.
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
    await (await import('./dev/browser-backend')).installBrowserBackend();
  }
  await startWindow(reportError);
}

start().catch((e) => {
  reportError('startup', e);
  getCurrentWindow().show();
});
