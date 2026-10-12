import { createStore } from '#src/lib/state/store.svelte.ts';
import { createRelayListStoreSetup } from '#src/stores/relayListStoreFactory.svelte.ts';

export type { RelayListEntry } from '#src/stores/relayListStoreFactory.svelte.ts';

export const useNip65RelayStore = createStore(
  'nip65RelayStore',
  createRelayListStoreSetup({
    storageKey: 'nip65_relays',
  })
);
