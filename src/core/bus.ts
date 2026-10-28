import type { AppEvents, Disposable, EventBus } from './types';

export function createBus(): EventBus {
  const handlers = new Map<keyof AppEvents, Set<(e: any) => void>>();
  return {
    on(type, fn) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(fn);
      return { dispose: () => set!.delete(fn) };
    },
    emit(type, e) {
      const set = handlers.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(e);
        } catch (err) {
          console.error(`handler for ${String(type)} failed`, err);
        }
      }
    },
  };
}

/** Collects disposables and disposes them together. */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  add<T extends Disposable>(d: T): T {
    this.items.push(d);
    return d;
  }
  dispose(): void {
    for (const d of this.items.splice(0)) {
      try {
        d.dispose();
      } catch (err) {
        console.error(err);
      }
    }
  }
}
