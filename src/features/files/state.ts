// JSON key-value stores for per-folder state and global state.

import type { StateStore } from '../../core/types';

export interface ManagedStore extends StateStore {
  /** Replaces all data. Does not call `onChange`. */
  replace(data: Record<string, unknown>): void;
  /** A copy of all data (shallow). */
  snapshot(): Record<string, unknown>;
  /** Keys changed since the last call. Removed keys have the value `null`. */
  takeDirty(): Record<string, unknown>;
}

export function createStore(onChange: (key: string) => void): ManagedStore {
  let data: Record<string, unknown> = {};
  const dirty = new Set<string>();
  return {
    get<T>(key: string): T | undefined {
      return data[key] as T | undefined;
    },
    set(key, value) {
      if (value === undefined) delete data[key];
      else data[key] = value;
      dirty.add(key);
      onChange(key);
    },
    replace(next) {
      data = { ...next };
      dirty.clear();
    },
    snapshot() {
      return { ...data };
    },
    takeDirty() {
      const out: Record<string, unknown> = {};
      for (const k of dirty) out[k] = data[k] ?? null;
      dirty.clear();
      return out;
    },
  };
}
