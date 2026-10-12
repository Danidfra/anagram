import type { Readable } from 'svelte/store';

// Hydration can update state many times within one frame. Keep the initial value
// synchronous, then publish the latest snapshot once per frame-sized interval.
export function coalesceStore<T>(source: Readable<T>): Readable<T> & { flush(): void } {
  const flushers = new Set<() => void>();
  return {
    flush() {
      for (const flush of flushers) flush();
    },
    subscribe(run) {
      let initial = true;
      let latest: T;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        run(latest);
      };
      flushers.add(flush);
      const stop = source.subscribe((value) => {
        latest = value;
        if (initial) {
          initial = false;
          run(value);
        } else if (timer === undefined) {
          timer = setTimeout(flush, 16);
        }
      });
      return () => {
        clearTimeout(timer);
        flushers.delete(flush);
        stop();
      };
    },
  };
}
