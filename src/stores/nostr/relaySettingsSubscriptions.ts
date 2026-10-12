import { toStore } from 'svelte/store';
import { untrack } from 'svelte';


export function watchRelaySettingsSubscriptions(options: {
  hydrate: () => void;
  signature: () => string;
  isRestoring: () => boolean;
  hasSessionSubscriptions: () => boolean;
  refresh: () => void;
}): (() => void) {
  // Hydration is local input to the startup owner, never a second refresh path.
  options.hydrate();
  let previous = options.signature();
  return toStore(options.signature).subscribe((signature) => {
    if (signature === previous) return;
    previous = signature;
    untrack(() => {
      if (!options.isRestoring() && options.hasSessionSubscriptions()) options.refresh();
    });
  });
}
