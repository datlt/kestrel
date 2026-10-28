// Transport for @codemirror/lsp-client over the Tauri IPC.
// It has no import of the library at run time, so it stays in the startup bundle at a tiny size.
import type { Transport } from '@codemirror/lsp-client';
import { lspSend } from '../../ipc/lsp';

type Handler = (value: string) => void;

/**
 * One transport per session. It stays the same object when the server
 * restarts: `attach` gives it the key of the new process.
 */
export class IpcTransport implements Transport {
  private handlers = new Set<Handler>();
  /** Messages that came before the client subscribed. */
  private early: string[] = [];
  private key: string | null = null;
  /** Sends go one after the other, so the server gets them in the same order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly onSendError: (error: unknown) => void) {}

  attach(key: string): void {
    this.key = key;
  }

  detach(): void {
    this.key = null;
  }

  /** Called with every message from the server process. */
  deliver(message: string): void {
    if (this.handlers.size === 0) {
      this.early.push(message);
      return;
    }
    for (const h of [...this.handlers]) {
      try {
        h(message);
      } catch (e) {
        console.error('[lsp] message handler failed', e);
      }
    }
  }

  /** Messages sent while no process runs are dropped. */
  send(message: string): void {
    const key = this.key;
    if (!key) return;
    this.chain = this.chain.then(() => lspSend(key, message)).catch(this.onSendError);
  }

  subscribe(handler: Handler): void {
    this.handlers.add(handler);
    const early = this.early;
    this.early = [];
    for (const m of early) this.deliver(m);
  }

  unsubscribe(handler: Handler): void {
    this.handlers.delete(handler);
  }
}
