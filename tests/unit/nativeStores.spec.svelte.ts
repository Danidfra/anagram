import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, tick } from 'svelte';
import { toStore } from 'svelte/store';
import { createStore, resetStores } from '#src/lib/state/store.svelte.ts';
import { useChatStore } from '#src/stores/chatStore.svelte.ts';
import type { Chat } from '#src/types/chat.ts';

afterEach(resetStores);

it('batches nested chat changes in the Svelte flush without a bridge timer', async () => {
  const chats = useChatStore();
  const seen = vi.fn();
  const stop = toStore(() => chats.selectedChat?.name).subscribe(seen);
  try {
    chats.chats = [{ id: 'alice', name: 'Alice', meta: {}, type: 'user' } as Chat];
    chats.selectedChatId = 'alice';
    await tick();
    expect(seen).toHaveBeenLastCalledWith('Alice');
    const previousCalls = seen.mock.calls.length;
    chats.chats[0].name = 'New';
    chats.chats[0].name = 'New name';
    await tick();
    expect(seen).toHaveBeenLastCalledWith('New name');
    expect(seen).toHaveBeenCalledTimes(previousCalls + 1);
    chats.chats = [];
    chats.selectedChatId = null;
    await tick();
    expect(seen).toHaveBeenLastCalledWith(undefined);
  } finally {
    stop();
  }
});

it('keeps a singleton alive after its first consumer leaves and disposes owned subscriptions', () => {
  const observed = vi.fn();
  const useCounter = createStore('native-lifetime-test', (onDispose) => {
    let count = $state(0);
    onDispose(toStore(() => count).subscribe(observed));
    return {
      increment: () => count++,
      get count() {
        return count;
      },
    };
  });
  const disposeConsumer = $effect.root(() => {
    useCounter();
  });
  const counter = useCounter();
  disposeConsumer();
  counter.increment();
  flushSync();
  expect(useCounter()).toBe(counter);
  expect(observed).toHaveBeenLastCalledWith(1);
  resetStores();
  const calls = observed.mock.calls.length;
  counter.increment();
  flushSync();
  expect(observed).toHaveBeenCalledTimes(calls);
  expect(useCounter().count).toBe(0);
});
