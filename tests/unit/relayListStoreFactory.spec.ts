import { afterEach, expect, it, vi } from 'vitest';
import { createRelayListStoreSetup } from '#src/stores/relayListStoreFactory.ts';

afterEach(() => vi.unstubAllGlobals());
function setup(defaultRelays = ['wss://default.example']) {
  const saved = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  return { saved, store: createRelayListStoreSetup({ storageKey: 'relays', defaultRelays })() };
}
it('clears account relays at logout and restores defaults on the next initialization', () => {
  const { store, saved } = setup();
  store.init();
  store.replaceRelayEntries([{ url: 'wss://previous-account.example', read: true, write: true }]);
  store.clear();
  expect(store.relays.value).toEqual([]);
  expect(saved.has('relays')).toBe(false);
  store.init();
  expect(store.relays.value).toEqual(['wss://default.example']);
  expect(JSON.parse(saved.get('relays')!)).toEqual([
    { url: 'wss://default.example', read: true, write: true },
  ]);
});
it('loads the next account’s stored relays after clearing and respects an intentionally empty list', () => {
  const { store, saved } = setup();
  store.init();
  store.clear();
  saved.set(
    'relays',
    JSON.stringify([{ url: 'wss://next-account.example', read: true, write: false }]),
  );
  store.init();
  expect(store.relays.value).toEqual(['wss://next-account.example']);
  store.replaceRelayEntries([]);
  store.init();
  expect(store.relays.value).toEqual([]);
});
it('does not add app defaults to relay stores that have no defaults', () => {
  const { store } = setup([]);
  store.init();
  store.clear();
  store.init();
  expect(store.relays.value).toEqual([]);
});
