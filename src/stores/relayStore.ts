import { createStore } from '#src/lib/state/store.svelte.ts';
import { DEFAULT_RELAYS } from '#src/constants/relays.ts';
import { createRelayListStoreSetup } from '#src/stores/relayListStoreFactory.svelte.ts';

export type { RelayListEntry } from '#src/stores/relayListStoreFactory.svelte.ts';

export const useRelayStore = createStore(
  'relayStore',
  createRelayListStoreSetup({
    storageKey: 'relays',
    defaultRelays: DEFAULT_RELAYS,
  })
);
