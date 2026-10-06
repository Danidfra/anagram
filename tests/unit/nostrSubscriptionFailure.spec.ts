import { describe, expect, it, vi } from 'vitest';
import NostrClient, { NostrRelayStatus } from '#src/lib/nostr/client.ts';

async function setup(urls: string[], auth = false) {
  const client = new NostrClient();
  const handlers = new Map<string, any>();
  for (const url of urls) vi.spyOn(client.pool.getRelay(url, false), 'connect').mockResolvedValue();
  vi.spyOn(client.transport, 'getExistingRelay').mockImplementation(
    (url) =>
      ({
        connected: true,
        onauth: auth ? vi.fn() : undefined,
        subscribe: (_filters: unknown, options: unknown) => {
          handlers.set(url, options);
          return { close: vi.fn() };
        },
      }) as never,
  );
  const onClose = vi.fn(),
    onEose = vi.fn(),
    onEvent = vi.fn();
  const subscription = client.subscribe(
    { kinds: [1059] },
    { relayUrls: urls, onClose, onEose, onEvent },
  );
  await vi.waitFor(() => expect(handlers.size).toBe(urls.length));
  return { client, handlers, subscription, onClose, onEose, onEvent };
}

describe('relay subscription failure propagation', () => {
  it('does not bypass a deferred connection and inflate relay retry backoff', async () => {
    const client = new NostrClient();
    const url = 'wss://cooling-down.example/';
    vi.spyOn(client.pool.getRelay(url, false), 'connect').mockResolvedValue();
    const ensure = vi.spyOn(client.transport, 'ensureRelay');
    const onClose = vi.fn(),
      onEose = vi.fn();
    client.subscribe({ kinds: [1059] }, { relayUrls: [url], onClose, onEose });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(ensure).not.toHaveBeenCalled();
    expect(onEose).not.toHaveBeenCalled();
  });
  it('releases a failed history request immediately without reporting EOSE', async () => {
    const url = 'wss://broken.example/';
    const { handlers, subscription, onClose, onEose } = await setup([url]);
    handlers.get(url).onclose('auth-required: unavailable');
    expect(subscription.closed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onEose).not.toHaveBeenCalled();
    subscription.stop();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('retains healthy deliveries when a different relay closes', async () => {
    const bad = 'wss://broken.example/',
      good = 'wss://healthy.example/';
    const { handlers, subscription, onClose, onEose, onEvent } = await setup([bad, good]);
    handlers.get(bad).onclose('auth-required: unavailable');
    handlers.get(good).onevent({
      id: 'message',
      kind: 1059,
      tags: [],
      content: 'ciphertext',
      created_at: 1,
      pubkey: 'a'.repeat(64),
    });
    handlers.get(good).oneose();
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(onEose).not.toHaveBeenCalled(); // A failed relay is never complete coverage.
    subscription.stop();
  });
});

it('reissues only the auth-rejected relay after AUTH succeeds, with the original filters', async () => {
  const publicRelay = 'wss://public.example/',
    privateRelay = 'wss://inbox.example/';
  const { client, handlers, subscription, onEose, onEvent } = await setup(
    [publicRelay, privateRelay],
    true,
  );
  const rejected = handlers.get(privateRelay);
  rejected.onclose('auth-required: authenticate first');
  handlers.get(publicRelay).oneose();
  expect(onEose).not.toHaveBeenCalled();
  const relay = client.pool.getRelay(privateRelay, false);
  relay.status = NostrRelayStatus.AUTHENTICATED;
  relay.emit('authed');
  await vi.waitFor(() => expect(handlers.get(privateRelay)).not.toBe(rejected));
  handlers.get(privateRelay).onevent({
    id: 'incoming',
    kind: 1059,
    tags: [],
    content: 'ciphertext',
    created_at: 1,
    pubkey: 'a'.repeat(64),
  });
  handlers.get(privateRelay).oneose();
  expect(onEvent).toHaveBeenCalledOnce();
  expect(onEose).toHaveBeenCalledOnce();
  subscription.stop();
});

it('does not retry an auth-denied request indefinitely or claim completed coverage', async () => {
  const url = 'wss://denied.example/';
  const { client, handlers, subscription, onClose, onEose } = await setup([url], true);
  handlers.get(url).onclose('auth-required: authenticate');
  const relay = client.pool.getRelay(url, false);
  relay.status = NostrRelayStatus.AUTHENTICATED;
  relay.emit('authed');
  handlers.get(url).onclose('auth-required: access still denied');
  expect(subscription.closed).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onEose).not.toHaveBeenCalled();
});

it('cancels an authentication wait when its owner closes the subscription', async () => {
  const url = 'wss://cancelled.example/';
  const { client, handlers, subscription, onEose } = await setup([url], true);
  const rejected = handlers.get(url);
  rejected.onclose('auth-required: authenticate');
  subscription.stop();
  client.pool.getRelay(url, false).emit('authed');
  expect(handlers.get(url)).toBe(rejected);
  expect(onEose).not.toHaveBeenCalled();
});

it('restores a dropped relay subscription when it reconnects alongside a healthy relay', async () => {
  const good = 'wss://always-connected.example/',
    reconnecting = 'wss://reconnecting.example/';
  const { client, handlers, subscription, onEvent } = await setup([good, reconnecting]);
  const dropped = handlers.get(reconnecting),
    healthy = handlers.get(good);
  dropped.onclose('connection closed');
  expect(subscription.closed).toBe(false);
  client.pool.emit('relay:connect', client.pool.getRelay(reconnecting, false));
  await vi.waitFor(() => expect(handlers.get(reconnecting)).not.toBe(dropped));
  expect(handlers.get(good)).toBe(healthy);
  handlers
    .get(reconnecting)
    .onevent({
      id: 'recovered-live',
      kind: 1059,
      tags: [],
      content: 'ciphertext',
      created_at: 1,
      pubkey: 'a'.repeat(64),
    });
  expect(onEvent).toHaveBeenCalledOnce();
  subscription.stop();
});
