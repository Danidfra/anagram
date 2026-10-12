import { afterEach, expect, it, vi } from 'vitest';
import type { createCallRoomRuntime } from '#src/stores/nostr/callRoomRuntime.svelte.ts';
const fixture = vi.hoisted(() => ({
  own: 'a'.repeat(64),
  identity: undefined as undefined | Parameters<typeof createCallRoomRuntime>[0]['getIdentity'],
}));
vi.mock('#src/stores/nostr/callRoomRuntime.svelte.ts', () => ({
  createCallRoomRuntime: (deps: Parameters<typeof createCallRoomRuntime>[0]) => {
    fixture.identity = deps.getIdentity;
    return {};
  },
}));
vi.mock('#src/stores/nostrStore.svelte.ts', () => ({
  useNostrStore: () => ({
    getLoggedInPublicKeyHex: () => fixture.own,
    listPrivateMessageReadRelayUrls: async () => ['wss://relay.example'],
  }),
}));
vi.mock('#src/stores/callStore.ts', () => ({ useCallStore: () => ({ session: null }) }));
vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: {
    getContactByPublicKey: async () => ({
      name: 'Profile name',
      meta: { nip05: 'person@example.com' },
    }),
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
});
it('sends the current account’s chosen name with NIP-05 fallback, never its local CSS', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const { groupCallNames, saveGroupCallName } = await import('#src/lib/state/groupCallNames.ts');
  const { get } = await import('svelte/store');
  const { useCallRoomStore } = await import('#src/stores/callRoomStore.ts');
  useCallRoomStore();
  const preferences = get(groupCallNames(fixture.own));
  saveGroupCallName(fixture.own, {
    ...preferences,
    name: '  My chosen name  ',
    cssEnabled: true,
    css: '.customname { color:red; }',
  });
  expect(await fixture.identity!()).toEqual({
    name: 'My chosen name',
    relays: ['wss://relay.example'],
  });
  saveGroupCallName(fixture.own, { ...preferences, name: '   ' });
  expect((await fixture.identity!()).name).toBe('person@example.com');
  fixture.own = 'b'.repeat(64);
  expect((await fixture.identity!()).name).toBe('person@example.com');
});
