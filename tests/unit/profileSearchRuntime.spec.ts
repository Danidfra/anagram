import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NostrClient, { ClientEvent, nip19 } from '#src/lib/nostr/client.ts';
import { searchRelayProfiles } from '#src/stores/nostr/profileSearchRuntime.ts';
const key = 'a'.repeat(64),
  other = 'b'.repeat(64);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const client = new NostrClient();
  const requests: Array<{ filter: any; options: any; stop: ReturnType<typeof vi.fn> }> = [];
  vi.spyOn(client, 'subscribe').mockImplementation((filter, options) => {
    const stop = vi.fn();
    requests.push({ filter, options, stop });
    return { stop } as any;
  });
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    onResults: vi.fn(),
    isBlocked: () => false,
    resolveNip05: vi.fn(),
  };
  return { client, requests, controller, options };
}
function event(client: NostrClient, pubkey = key, created_at = 10, name = 'Alice') {
  return new ClientEvent(client, {
    kind: 0,
    pubkey,
    created_at,
    id: String(created_at).padStart(64, '0'),
    content: JSON.stringify({ name, picture: 'https://image.test/a.png' }),
    tags: [],
  });
}
it('streams matching profiles before EOSE, selects newest metadata and bounds silent relays', async () => {
  const f = fixture();
  const done = searchRelayProfiles(
    f.client,
    'alice',
    ['wss://one.test', 'wss://silent.test'],
    f.options,
  );
  expect(f.requests[0].filter).toEqual({ kinds: [0], search: 'alice', limit: 20 });
  f.requests[0].options.onEvent(event(f.client));
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ publicKey: key, name: 'Alice' }),
  ]);
  f.requests[0].options.onEvent(event(f.client, key, 5, 'Alice stale'));
  f.requests[0].options.onEvent(event(f.client, other, 10, 'Unrelated'));
  expect(f.options.onResults).toHaveBeenCalledTimes(1);
  f.requests[0].options.onEvent(event(f.client, key, 20, 'Alice latest'));
  f.requests[0].options.onEose();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await done).toBe('complete');
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'Alice latest' }),
  ]);
  expect(f.requests.every((r) => r.stop.mock.calls.length === 1)).toBe(true);
});
it('cancels subscriptions and ignores results from an old search', async () => {
  const f = fixture();
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test'], f.options);
  f.controller.abort();
  f.requests[0].options.onEvent(event(f.client));
  expect(await done).toBe('complete');
  expect(f.options.onResults).not.toHaveBeenCalled();
  expect(f.requests[0].stop).toHaveBeenCalledOnce();
});
it('resolves exact NIP-05 addresses authoritatively and follows their relay hints', async () => {
  const f = fixture();
  f.options.resolveNip05.mockResolvedValue({
    isValid: true,
    normalizedPubkey: key,
    relays: ['wss://hint.test'],
  });
  const done = searchRelayProfiles(f.client, 'alice@example.com', ['wss://one.test'], f.options);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0].filter).toEqual({ kinds: [0], authors: [key], limit: 1 });
  f.requests[0].options.onEvent(event(f.client, other));
  expect(f.options.onResults).toHaveBeenCalledTimes(1);
  f.requests[0].options.onEvent(event(f.client));
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ publicKey: key, nip05: 'alice@example.com', name: 'Alice' }),
  ]);
  f.controller.abort();
  await done;
});
it('does not send private keys to relays or NIP-05 endpoints, and supports public identifiers', async () => {
  const f = fixture();
  const secret = nip19.nsecEncode(new Uint8Array(32).fill(1));
  expect(await searchRelayProfiles(f.client, secret, ['wss://one.test'], f.options)).toBe(
    'invalid',
  );
  expect(f.requests).toHaveLength(0);
  expect(f.options.resolveNip05).not.toHaveBeenCalled();
  const done = searchRelayProfiles(
    f.client,
    nip19.nprofileEncode({ pubkey: key, relays: ['wss://hint.test'] }),
    [],
    f.options,
  );
  expect(f.requests[0].filter.authors).toEqual([key]);
  f.controller.abort();
  await done;
});

it('finds matching profiles through a bounded ordinary read when search is rejected', async () => {
  const f = fixture();
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test'], f.options);
  expect(f.requests[1].filter).toEqual({ kinds: [0], limit: 100 });
  f.requests[0].options.onClose(); // CLOSED: unrecognised filter item: search
  f.requests[1].options.onEvent(event(f.client, other, 10, 'Unrelated'));
  f.requests[1].options.onEvent(event(f.client));
  f.requests[1].options.onEose();
  expect(await done).toBe('complete');
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'Alice' }),
  ]);
  expect(f.requests.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
});

const account = 'c'.repeat(64);
function follows(client: NostrClient, keys: string[], created_at = 10, pubkey = account) {
  return new ClientEvent(client, {
    kind: 3,
    pubkey,
    created_at,
    id: String(created_at).padStart(64, '0'),
    content: '',
    tags: keys.map((key) => ['p', key]),
  });
}
it('streams followed profiles above relay matches without waiting for a silent relay', async () => {
  const f = fixture();
  const onFollowList = vi.fn(),
    onFollowProfile = vi.fn();
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test', 'wss://silent.test'], {
    ...f.options,
    account,
    onFollowList,
    onFollowProfile,
  });
  f.requests[0].options.onEvent(event(f.client, other, 10, 'Alice'));
  const list = f.requests.find((r) => r.filter.kinds.includes(3))!;
  list.options.onEvent(follows(f.client, [key]));
  const hydration = f.requests.find(
    (r) => r.filter.kinds.includes(0) && r.filter.authors?.includes(key),
  )!;
  hydration.options.onEvent(event(f.client, key, 10, 'Alice followed'));
  expect(f.options.onResults.mock.lastCall![0].map((p: any) => [p.publicKey, p.following])).toEqual(
    [
      [key, true],
      [other, false],
    ],
  );
  // A second copy of the same profile must not create a second result.
  f.requests[0].options.onEvent(event(f.client, key, 10, 'Alice followed'));
  expect(f.options.onResults.mock.lastCall![0]).toHaveLength(2);
  expect(onFollowList).toHaveBeenCalledOnce();
  expect(onFollowProfile).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await done).toBe('complete');
  expect(f.requests.every((r) => r.stop.mock.calls.length === 1)).toBe(true);
});
it('shows account-scoped cached follows before relay discovery finishes', async () => {
  const f = fixture();
  const options = {
    ...f.options,
    account,
    followList: follows(f.client, [key]).rawEvent(),
    cachedProfile: () => ({ name: 'Alice cached', picture: '' }),
  };
  const done = searchRelayProfiles(f.client, 'alice', new Promise<string[]>(() => {}), options);
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ publicKey: key, name: 'Alice cached', following: true }),
  ]);
  expect(f.requests).toHaveLength(0);
  f.controller.abort();
  await done;
  const otherAccount = fixture();
  const empty = searchRelayProfiles(otherAccount.client, 'alice', [], {
    ...options,
    ...otherAccount.options,
    account: other,
  });
  expect(await empty).toBe('unavailable');
  expect(otherAccount.options.onResults).not.toHaveBeenCalled();
});
it('keeps the latest follow list, handles unfollows, and ignores cancelled replies', async () => {
  const f = fixture();
  const cached = follows(f.client, [key], 20);
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test'], {
    ...f.options,
    account,
    followList: cached.rawEvent(),
    cachedProfile: () => ({ name: 'Alice cached', picture: '' }),
  });
  const list = f.requests.find((r) => r.filter.kinds.includes(3))!;
  list.options.onEvent(follows(f.client, [], 10));
  list.options.onEvent(follows(f.client, [], 30, other));
  expect(f.options.onResults.mock.lastCall![0][0].following).toBe(true);
  list.options.onEvent(follows(f.client, [], 30));
  expect(f.options.onResults.mock.lastCall![0][0].following).toBe(false);
  const calls = f.options.onResults.mock.calls.length;
  f.controller.abort();
  list.options.onEvent(follows(f.client, [key], 40));
  expect(f.options.onResults).toHaveBeenCalledTimes(calls);
  await done;
});
it('does not let public result limits hide a followed match and still excludes blocked profiles', async () => {
  const f = fixture();
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test'], {
    ...f.options,
    account,
    isBlocked: (k) => k === other,
  });
  for (let i = 1; i <= 40; i++)
    f.requests[0].options.onEvent(
      event(f.client, i.toString(16).padStart(64, '0'), 10, `Alice ${i}`),
    );
  f.requests
    .find((r) => r.filter.kinds.includes(3))!
    .options.onEvent(follows(f.client, [key, other]));
  const hydration = f.requests.find((r) => r.filter.authors?.includes(key))!;
  expect(hydration.filter.authors).toEqual([key]);
  hydration.options.onEvent(event(f.client, key, 10, 'Alice followed'));
  expect(f.options.onResults.mock.lastCall![0][0]).toMatchObject({
    publicKey: key,
    following: true,
  });
  f.controller.abort();
  await done;
});
