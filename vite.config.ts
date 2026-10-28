import { defineConfig } from 'vite';
// Dev only: lets the frontend run in a normal browser with real files (see src/dev/README.md).
import devBridge from './scripts/dev-bridge.mjs';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  plugins: [devBridge()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**', '**/target-*/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: ['es2022', 'safari16', 'chrome110'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 800,
  },
});
