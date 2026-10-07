import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  type Event,
} from 'nostr-tools';
import NostrClient, {
  ClientEvent,
  NostrPrivateKeySigner,
  type NostrFilter,
  type NostrSubscriptionOptions,
  type NostrSubscription,
} from '#src/lib/nostr/client.ts';
import { PublicGroupData } from '#src/services/publicGroupData.ts';
import { createPublicGroupRuntime } from '#src/stores/nostr/publicGroupRuntime.ts';
import { parsePublicRoom, roomTags, encodeRoomLink } from '#src/stores/nostr/publicGroups.ts';
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((f) => f());
  vi.useRealTimers();
});
function setup(
  events: Event[],
  key = generateSecretKey(),
  eose: boolean | ((url: string) => boolean) = true,
) {
  let account: string | null = getPublicKey(key);
  const listeners = new Set<{
    filters: NostrFilter[];
    options: NostrSubscriptionOptions;
    stop: () => void;
  }>();
  const subscriptions: NostrFilter[][] = [];
  const failures = new Set<string>();
  const client = {
    subscribe(filters: NostrFilter[], options: NostrSubscriptionOptions) {
      subscriptions.push(filters);
      const sub = {
        filters,
        options,
        stop: () => {
          listeners.delete(sub);
          options.onClose?.();
        },
      };
      listeners.add(sub);
      queueMicrotask(() => {
        if (!listeners.has(sub)) return;
        const seen = new Set<string>();
        for (const filter of filters) {
          const matches = events
            .filter((e) => matchFilters([filter], e))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit ?? events.length);
          for (const e of matches)
            if (!seen.has(e.id)) {
              seen.add(e.id);
              options.onEvent?.(new ClientEvent(undefined, e), {
                url: options.relayUrls?.[0],
              } as never);
            }
        }
        if (typeof eose === 'function' ? eose(options.relayUrls?.[0] ?? '') : eose)
          options.onEose?.();
      });
      return sub as unknown as NostrSubscription;
    },
    pool: {
      getRelay: (url: string) => ({
        url,
        connect: async () => {},
        publish: async (event: ClientEvent) => {
          if (failures.has(url)) throw new Error('Relay rejected this event');
          if (url.includes('stalled')) return new Promise(() => {});
          events.push(event.rawEvent() as Event);
        },
      }),
    },
  } as unknown as NostrClient;
  const runtime = createPublicGroupRuntime({
    client,
    account: () => account,
    signer: async () => new NostrPrivateKeySigner(key),
    relays: async () => ['wss://relay.example.org/'],
    containsSecret: () => false,
  });
  stops.push(runtime.stop);
  return {
    runtime,
    events,
    listeners,
    subscriptions,
    failures,
    setAccount: (value: string | null) => (account = value),
  };
}
function room(key: Uint8Array, slug: string, extra: string[][] = [], created_at = 10) {
  return finalizeEvent(
    {
      kind: 34550,
      created_at,
      content: '',
      tags: [
        ...roomTags({
          slug,
          name: slug,
          about: '',
          picture: '',
          relays: ['wss://relay.example.org/'],
          trusted: [],
          blocked: [],
        }),
        ...extra,
      ],
    },
    key,
  );
}
it('requires signed two-sided handover, switches policy, and pins accepted transfers', async () => {
  const old = generateSecretKey(),
    next = generateSecretKey(),
    evil = generateSecretKey();
  const source = `34550:${getPublicKey(old)}:old`,
    target = `34550:${getPublicKey(next)}:new`;
  const from = room(old, 'old', [['successor', target, 'wss://relay.example.org/']]);
  const destination = room(next, 'new', [
    ['predecessor', source],
    ['blocked', getPublicKey(evil)],
  ]);
  const { runtime, events } = setup([from, destination]);
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room?.owner).toBe(getPublicKey(next));
  expect(get(runtime.state).room?.blocked).toEqual([getPublicKey(evil)]);
  expect(get(runtime.state).ancestors).toHaveLength(1);
  events.splice(0, 1, room(old, 'old', [['successor', `34550:${getPublicKey(evil)}:evil`]], 11));
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room?.owner).toBe(getPublicKey(next));
});
it('rejects a target with no acknowledgement and does not join it', async () => {
  const old = generateSecretKey(),
    next = generateSecretKey();
  const from = room(old, 'old', [['successor', `34550:${getPublicKey(next)}:new`]]);
  const { runtime } = setup([from, room(next, 'new')]);
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).error).toMatch(/not accepted/);
  expect(get(runtime.state).rooms).toEqual([]);
});
it('rejects cycles', async () => {
  const a = generateSecretKey(),
    b = generateSecretKey();
  const aa = `34550:${getPublicKey(a)}:a`,
    bb = `34550:${getPublicKey(b)}:b`;
  const first = room(a, 'a', [
    ['successor', bb],
    ['predecessor', bb],
  ]);
  const { runtime } = setup([
    first,
    room(b, 'b', [
      ['successor', aa],
      ['predecessor', aa],
    ]),
  ]);
  await runtime.open(encodeRoomLink(parsePublicRoom(first)));
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).error).toMatch(/chain/);
});
it('does not turn a relay timeout into a verified empty policy', async () => {
  vi.useFakeTimers();
  const event = room(generateSecretKey(), 'timeout');
  const { runtime } = setup([event], undefined, false);
  const loading = runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(10001);
  await loading;
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).stale).toBe(true);
});
it('denies management by a non-owner and isolates state after account replacement', async () => {
  const event = room(generateSecretKey(), 'owned');
  const { runtime, setAccount } = setup([event]);
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await expect(runtime.update({ trusted: ['a'.repeat(64)] }, event.id)).rejects.toThrow(
    /Only the current owner/,
  );
  setAccount(getPublicKey(generateSecretKey()));
  await runtime.init();
  expect(get(runtime.state).rooms).toEqual([]);
  expect(get(runtime.state).room).toBeNull();
});

it('never falls back to a previously joined target after an invalid handover', async () => {
  const a = generateSecretKey(),
    b = generateSecretKey();
  const target = room(b, 'existing');
  const from = room(a, 'source', [['successor', parsePublicRoom(target).address]]);
  const { runtime } = setup([target, from]);
  await runtime.open(encodeRoomLink(parsePublicRoom(target)));
  expect(get(runtime.state).room?.name).toBe('existing');
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).error).toMatch(/not accepted/);
});

it('ignores late subscription events after leaving and rejoins only when explicitly opened', async () => {
  const key = generateSecretKey();
  const event = room(key, 'leave');
  const { runtime, listeners } = setup([event]);
  const link = encodeRoomLink(parsePublicRoom(event));
  await runtime.open(link);
  const live = [...listeners].find((entry) =>
    entry.filters.some((filter) => filter.kinds?.includes(9)),
  )!;
  expect(live).toBeDefined();
  await runtime.leave(parsePublicRoom(event).address);
  live.options.onEvent?.(new ClientEvent(undefined, room(key, 'leave', [], 11)));
  await Promise.resolve();
  expect(get(runtime.state).rooms).toEqual([]);
  expect(get(runtime.state).room).toBeNull();
  expect(listeners.size).toBe(0);
  await runtime.open(link);
  expect(get(runtime.state).rooms).toHaveLength(1);
});

it('cancels an in-flight room lookup when the account changes', async () => {
  const event = room(generateSecretKey(), 'switch');
  const { runtime, listeners, setAccount } = setup([event], undefined, false);
  const opening = runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  setAccount(getPublicKey(generateSecretKey()));
  await runtime.init();
  await opening;
  expect(get(runtime.state).rooms).toEqual([]);
  expect(get(runtime.state).room).toBeNull();
  expect(listeners.size).toBe(0);
});

it('opens and posts through a completed replica without waiting for a stalled relay', async () => {
  const key = generateSecretKey();
  const event = room(key, 'replicas', [['relay', 'wss://stalled.example.org/']]);
  const { runtime, listeners } = setup([event], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  expect(get(runtime.state).stale).toBe(false);
  expect(get(runtime.state).error).toBe('');
  expect(listeners.size).toBe(1); // Only the live listener survives discovery.
  await runtime.send('A healthy relay is sufficient for public chat');
  expect(get(runtime.state).messages.at(-1)?.content).toBe(
    'A healthy relay is sufficient for public chat',
  );
});

it('shows cached messages immediately, hydrates during refresh and keeps posting locked without real EOSE', async () => {
  const key = generateSecretKey();
  const event = room(key, 'cached');
  let complete = true;
  const { runtime, events, listeners } = setup([event], key, () => complete);
  const link = encodeRoomLink(parsePublicRoom(event));
  await runtime.open(link);
  await runtime.send('Already saved');
  runtime.stopView();
  complete = false;
  const later = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      tags: [['a', parsePublicRoom(event).address]],
      content: 'Arrived during refresh',
    },
    key,
  );
  events.push(later);
  const opening = runtime.open(link);
  await vi.waitFor(() => expect(get(runtime.state).room?.name).toBe('cached'));
  expect(get(runtime.state).refreshing).toBe(true);
  await vi.waitFor(() =>
    expect(get(runtime.state).messages.some((e) => e.content === 'Already saved')).toBe(true),
  );
  await vi.waitFor(() =>
    expect(get(runtime.state).messages.some((e) => e.id === later.id)).toBe(true),
  );
  await expect(runtime.send('Not yet')).rejects.toThrow(/unavailable/);
  const lookup = [...listeners].find((l) => !l.filters.some((f) => f.kinds?.includes(9)))!;
  lookup.options.onEose?.();
  await opening;
  expect(get(runtime.state).stale).toBe(false); // Replacing a live listener is not a disconnect.
  expect(get(runtime.state).error).toBe('');
  await runtime.send('Now verified');
});

it('owner edits still refuse incomplete relay coverage', async () => {
  const key = generateSecretKey();
  const event = room(key, 'strict-write', [['relay', 'wss://stalled.example.org/']]);
  const { runtime } = setup([event], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  vi.useFakeTimers();
  const updating = runtime.update({ name: 'Unsafe overwrite' }, event.id);
  const rejected = expect(updating).rejects.toThrow(/complete/);
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  expect(get(runtime.state).room?.name).toBe('strict-write');
});

it('never downgrades cached moderation when a replica replays an old room', async () => {
  const key = generateSecretKey();
  const blocked = getPublicKey(generateSecretKey());
  const current = room(key, 'policy', [['blocked', blocked]], 20);
  const { runtime, events } = setup([current], key);
  const link = encodeRoomLink(parsePublicRoom(current));
  await runtime.open(link);
  events.splice(0, events.length, room(key, 'policy', [], 10));
  await runtime.open(link);
  expect(get(runtime.state).room?.blocked).toEqual([blocked]);
  expect(get(runtime.state).stale).toBe(true);
  expect(get(runtime.state).error).toMatch(/older/);
});

it('pages history through a healthy replica without a stalled replica blocking a full page', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'history-replicas', [['relay', 'wss://stalled.example.org/']]);
  const address = parsePublicRoom(definition).address;
  const events = Array.from({ length: 150 }, (_, n) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: 100 + n,
        content: `Message ${n}`,
        tags: [['a', address]],
      },
      key,
    ),
  );
  const { runtime } = setup([definition, ...events], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(50));
  await runtime.older();
  expect(get(runtime.state).messages[0].content).toBe('Message 50');
  expect(get(runtime.state).messages).toHaveLength(100);
  expect(get(runtime.state).more).toBe(true);
  expect(get(runtime.state).error).toBe('');
});

it('bounds pending query events across all replicas, even before EOSE', async () => {
  const key = generateSecretKey();
  const event = room(key, 'bounded', [['relay', 'wss://second.example.org/']]);
  const { runtime, listeners } = setup([], key, false);
  const opening = runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await vi.waitFor(() => expect(listeners.size).toBe(2));
  const replicas = [...listeners];
  for (let n = 0; n < 33; n++)
    replicas[n % 2].options.onEvent?.(new ClientEvent(undefined, room(key, 'bounded', [], n + 10)));
  await opening;
  expect(get(runtime.state).error).toMatch(/Too many/);
  expect(listeners.size).toBe(0);
});

it('keeps one live subscription on cached reentry and batches burst hydration without losing notes', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'batched');
  const address = parsePublicRoom(definition);
  const { runtime, listeners, subscriptions } = setup([definition], key);
  await runtime.open(encodeRoomLink(address));
  runtime.stopView();
  subscriptions.length = 0;
  const sidebarUpdates = vi.fn();
  const stopSidebar = runtime.sidebar.subscribe(sidebarUpdates);
  const put = vi.spyOn(PublicGroupData.prototype, 'putMany');
  const list = vi.spyOn(PublicGroupData.prototype, 'list');
  try {
    await runtime.open(encodeRoomLink(address));
    const live = [...listeners].filter((l) => l.filters.some((f) => f.kinds?.includes(9)));
    expect(live).toHaveLength(1);
    expect(
      subscriptions.filter((filters) => filters.some((f) => f.kinds?.includes(9))),
    ).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    sidebarUpdates.mockClear();
    const events = Array.from({ length: 128 }, (_, i) =>
      finalizeEvent(
        { kind: 9, created_at: 100 + i, tags: [['a', address.address]], content: `burst ${i}` },
        key,
      ),
    );
    for (const event of events) live[0].options.onEvent?.(new ClientEvent(undefined, event));
    await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(128));
    expect(put).toHaveBeenCalledTimes(2);
    expect(sidebarUpdates).not.toHaveBeenCalled();
    const db = new PublicGroupData(getPublicKey(key));
    expect(await db.page(address.address, undefined, 200)).toHaveLength(128);
    await db.close();
    runtime.stopView();
    live[0].options.onEvent?.(
      new ClientEvent(
        undefined,
        finalizeEvent(
          { kind: 9, created_at: 999, tags: [['a', address.address]], content: 'late' },
          key,
        ),
      ),
    );
    expect(get(runtime.state).messages).toHaveLength(128);
    expect(listeners.size).toBe(0);
  } finally {
    stopSidebar();
    put.mockRestore();
    list.mockRestore();
  }
});

it('persists ACKs, failures and replica receipts and retries the original signed public message', async () => {
  const key = generateSecretKey();
  const bad = 'wss://second.example.org/';
  const definition = room(key, 'relay-stats', [['relay', bad]]);
  const address = parsePublicRoom(definition);
  const { runtime, listeners, failures, events, setAccount } = setup([definition], key);
  await runtime.open(encodeRoomLink(address));
  failures.add(bad);
  await runtime.send('delivery test');
  await vi.waitFor(() =>
    expect(
      get(runtime.state).messages[0]?.relay_statuses?.filter((s) => s.direction === 'outbound'),
    ).toHaveLength(2),
  );
  await vi.waitFor(() =>
    expect(
      get(runtime.state).messages[0].relay_statuses?.find((s) => s.relay_url === bad)?.status,
    ).toBe('failed'),
  );
  const sent = get(runtime.state).messages[0];
  expect(sent.relay_statuses?.find((s) => s.relay_url === bad)?.status).toBe('failed');
  expect(sent.relay_statuses?.find((s) => s.relay_url !== bad)?.status).toBe('published');
  const live = [...listeners].find((l) => l.filters.some((f) => f.kinds?.includes(9)))!;
  for (const url of address.relays)
    live.options.onEvent?.(new ClientEvent(undefined, sent), { url } as never);
  await vi.waitFor(() => expect(get(runtime.state).messages[0].relay_statuses).toHaveLength(4));
  failures.clear();
  await runtime.retryMessage(sent.id!, bad);
  expect(events.filter((e) => e.id === sent.id)).toHaveLength(2);
  expect(events.filter((e) => e.id === sent.id).every((e) => e.sig === sent.sig)).toBe(true);
  expect(get(runtime.state).messages).toHaveLength(1);
  expect(
    get(runtime.state).messages[0].relay_statuses?.filter((s) => s.status === 'published'),
  ).toHaveLength(2);
  runtime.stopView();
  await runtime.open(encodeRoomLink(address));
  await vi.waitFor(() => expect(get(runtime.state).messages[0]?.relay_statuses).toHaveLength(4));
  await expect(runtime.retryMessage(sent.id!, 'wss://unrelated.example.org/')).rejects.toThrow(
    'Relay is not used',
  );
  setAccount(getPublicKey(generateSecretKey()));
  await expect(runtime.retryMessage(sent.id!, bad)).rejects.toThrow('Account changed');
});

it('redacts links before signing normal-user posts', async () => {
  const owner = generateSecretKey(),
    member = generateSecretKey();
  const definition = room(owner, 'no-links');
  const { runtime, events } = setup([definition], member);
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await runtime.send('Look https://example.org/post and www.example.org');
  expect(events.find((e) => e.kind === 9)?.content).toBe('Look [link removed] and [link removed]');
});
