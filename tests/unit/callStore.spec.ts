import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetStores } from '#src/lib/state/store.svelte.ts';
import { useCallStore } from '#src/stores/callStore.ts';
import { CALL_PROTOCOL, type CallSignal } from '#src/types/call.ts';

const mocks = vi.hoisted(() => ({
  room: { busy: false },
  start: vi.fn(),
  receiveSignal: vi.fn(),
  syncClosedAndroidCalls: vi.fn(),
}));
vi.mock('#src/stores/callRoomStore.ts', () => ({ useCallRoomStore: () => mocks.room }));
vi.mock('#src/services/androidCallNotificationService.ts', () => ({
  syncClosedAndroidCalls: mocks.syncClosedAndroidCalls,
}));
vi.mock('#src/stores/nostr/callRuntime.svelte.ts', () => ({
  createCallRuntime: () => ({
    error: '',
    start: mocks.start,
    receiveSignal: mocks.receiveSignal,
    get session() {
      return mocks.start.mock.calls.length ? { phase: 'inviting' } : null;
    },
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.room.busy = false;
  mocks.syncClosedAndroidCalls.mockImplementation(() => {
    // Fail promptly if a future wrapper accidentally re-enters itself.
    if (mocks.syncClosedAndroidCalls.mock.calls.length > 1) throw new Error('Recursive invite');
  });
});
afterEach(resetStores);

it('starts through the store exactly once and keeps runtime state getters live', async () => {
  const store = useCallStore();
  expect(store.session).toBeNull();
  await store.start('peer', 'audio');
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith('peer', 'audio');
  expect(store.session?.phase).toBe('inviting');
});

it('synchronizes Android invites before forwarding signals through the store once', async () => {
  const signal: CallSignal = {
    protocol: CALL_PROTOCOL,
    action: 'invite',
    callId: 'test-call',
    mode: 'audio',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await useCallStore().receiveSignal('peer', signal);
  expect(mocks.syncClosedAndroidCalls).toHaveBeenCalledOnce();
  expect(mocks.receiveSignal).toHaveBeenCalledExactlyOnceWith('peer', signal);
  expect(mocks.syncClosedAndroidCalls.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.receiveSignal.mock.invocationCallOrder[0],
  );
  await useCallStore().receiveSignal('peer', { ...signal, action: 'end' });
  expect(mocks.syncClosedAndroidCalls).toHaveBeenCalledOnce();
  expect(mocks.receiveSignal).toHaveBeenCalledTimes(2);
});

it('still prevents starting a direct call while a group call is active', async () => {
  mocks.room.busy = true;
  const store = useCallStore();
  await store.start('peer', 'video');
  expect(mocks.start).not.toHaveBeenCalled();
  expect(store.error).toBe('room.error.busy');
});
