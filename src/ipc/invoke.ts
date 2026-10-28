import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

/** Error codes sent by Rust (crates/kestrel-common/src/error.rs). */
export type ErrorCode =
  | 'not_found'
  | 'permission_denied'
  | 'already_exists'
  | 'conflict'
  | 'too_large'
  | 'binary'
  | 'unmappable'
  | 'not_a_repo'
  | 'git_missing'
  | 'server_missing'
  | 'cancelled'
  | 'invalid_input'
  | 'io'
  | 'internal';

export class IpcError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/** Calls a Rust command. Rejects with IpcError. */
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
      throw new IpcError(String((e as any).code), String((e as any).message), cmd);
    }
    throw new IpcError('internal', typeof e === 'string' ? e : String(e), cmd);
  }
}

export function isIpcError(e: unknown, code?: ErrorCode): e is IpcError {
  return e instanceof IpcError && (code === undefined || e.code === code);
}
