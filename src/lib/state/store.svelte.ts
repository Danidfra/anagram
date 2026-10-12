import { untrack } from 'svelte';

const instances = new Map<string, { value: object; dispose: () => void }>();

// A store belongs to the application, not the component that first opens it.
export function createStore<T extends object>(
  id: string,
  setup: (onDispose: (stop: () => void) => void) => T,
): () => T {
  return () => {
    let instance = instances.get(id);
    if (!instance) {
      let value: T;
      const dispose = $effect.root(() => {
        const cleanups: Array<() => void> = [];
        value = untrack(() => setup((stop) => cleanups.push(stop)));
        return () => {
          for (const stop of cleanups) stop();
        };
      });
      instance = { value: value!, dispose };
      instances.set(id, instance);
    }
    return instance.value as T;
  };
}

export function resetStores(): void {
  for (const instance of instances.values()) instance.dispose();
  instances.clear();
}
