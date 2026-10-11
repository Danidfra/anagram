import { describe, it, expect } from 'vitest';
import { MessageInbox } from '#src/lib/nostr/inbox.ts';
describe('durable message hydration inbox', () => {
  it('separates accounts, deduplicates events and prioritizes foreground work', async () => {
    const inbox = new MessageInbox();
    const account = crypto.randomUUID();
    const event = {
      pubkey: 'a'.repeat(64),
      kind: 1059,
      created_at: 1,
      tags: [],
      content: 'ciphertext',
    };
    for (let n = 0; n < 80; n++)
      await inbox.put({ account, id: String(n), event, priority: 1, queuedAt: n, throttle: 0 });
    await inbox.put({ account, id: 'urgent', event, priority: 0, queuedAt: 99, throttle: 0 });
    await inbox.put({
      account: 'other-' + account,
      id: 'foreign',
      event,
      priority: 0,
      queuedAt: 0,
      throttle: 0,
    });
    await inbox.put({ account, id: 'urgent', event, priority: 0, queuedAt: 99, throttle: 0 });
    const page = await inbox.next(account);
    expect(page).toHaveLength(32);
    expect(page[0].id).toBe('urgent');
    expect(page.every((row) => row.account === account)).toBe(true);
    await inbox.remove(account, 'urgent');
    expect((await new MessageInbox().next(account))[0].id).toBe('0');
  });
});

it('batches a burst into bounded transactions and acknowledges only committed ciphertext', async () => {
  const { vi } = await import('vitest');
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  const event = {
    pubkey: 'a'.repeat(64),
    kind: 1059,
    created_at: 1,
    tags: [],
    content: 'ciphertext',
  };
  await inbox.next(account); // Open before counting transactions.
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
  const results = await Promise.all(
    Array.from({ length: 130 }, (_, n) =>
      inbox.put({ account, id: String(n), event, priority: 1, queuedAt: n, throttle: 0 }),
    ),
  );
  expect(results).toHaveLength(130);
  expect(
    transaction.mock.calls.filter((args) => args[0] === 'inbox' && args[1] === 'readwrite'),
  ).toHaveLength(3);
  transaction.mockRestore();
  expect(await inbox.next(account, 200)).toHaveLength(130);
});

it('rejects an aborted batch without acknowledging it and accepts a later retry', async () => {
  const { vi } = await import('vitest');
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  const event = {
    pubkey: 'a'.repeat(64),
    kind: 1059,
    created_at: 1,
    tags: [],
    content: 'ciphertext',
  };
  const record = { account, id: 'retry', event, priority: 1, queuedAt: 1, throttle: 0 };
  await inbox.next(account);
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (...args) {
    const request = original.apply(this, args);
    this.transaction.abort();
    return request;
  });
  await expect(inbox.put(record)).rejects.toBeDefined();
  put.mockRestore();
  expect(await inbox.next(account)).toHaveLength(0);
  await inbox.put(record);
  expect(await inbox.next(account)).toHaveLength(1);
});

it('retains retry ciphertext until completion, and deduplicates completed wrappers across instances per account', async () => {
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  const record = {
    account,
    id: 'wrap',
    event: { pubkey: 'a'.repeat(64), kind: 1059, content: 'ciphertext', tags: [], created_at: 1 },
    priority: 0,
    queuedAt: 1,
    throttle: 0,
  };
  await inbox.put(record);
  expect(await inbox.hasProcessed(account, 'wrap')).toBe(false);
  expect(await new MessageInbox().next(account)).toHaveLength(1);
  await inbox.complete(account, 'wrap');
  const restarted = new MessageInbox();
  expect(await restarted.next(account)).toHaveLength(0);
  expect(await restarted.hasProcessed(account, 'wrap')).toBe(true);
  expect(await restarted.hasProcessed('another-' + account, 'wrap')).toBe(false);
});

it('an aborted completion leaves ciphertext retryable without a completion receipt', async () => {
  const { vi } = await import('vitest');
  const inbox = new MessageInbox(),
    account = crypto.randomUUID();
  await inbox.put({
    account,
    id: 'wrap',
    event: { kind: 1059, pubkey: '', content: 'ciphertext', tags: [], created_at: 1 },
    priority: 0,
    queuedAt: 1,
    throttle: 0,
  });
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (...args) {
    const request = original.apply(this, args);
    this.transaction.abort();
    return request;
  });
  await expect(inbox.complete(account, 'wrap')).rejects.toBeDefined();
  put.mockRestore();
  expect(await inbox.hasProcessed(account, 'wrap')).toBe(false);
  expect(await inbox.next(account)).toHaveLength(1);
});

it('pages pending ciphertext by account and epoch, including existing version-2 records', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { vi } = await import('vitest');
  vi.stubGlobal('indexedDB', new IDBFactory());
  const epoch = 'd'.repeat(64);
  const record = (account: string, id: string, recipient = epoch) => ({
    account,
    id,
    priority: 1,
    queuedAt: 1,
    throttle: 0,
    event: {
      kind: 1059,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      content: 'ciphertext',
      tags: [['p', recipient]],
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('anagram-hydration-inbox', 2);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('inbox', { keyPath: ['account', 'id'] });
        store.createIndex('priority', ['account', 'priority', 'queuedAt', 'id']);
        for (let n = 0; n < 40; n++) store.put(record('own', String(n)));
        store.put(record('other', 'foreign'));
        store.put(record('own', 'other-epoch', 'e'.repeat(64)));
        request.result.createObjectStore('processed', { keyPath: ['account', 'id'] });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const inbox = new MessageInbox();
    const page = await inbox.next('own', 32, new Set(), epoch);
    expect(page).toHaveLength(32);
    expect(page.every((row) => row.account === 'own' && row.event.tags[0][1] === epoch)).toBe(true);
    const remainder = await inbox.next('own', 32, new Set(page.map((row) => row.id)), epoch);
    expect(remainder).toHaveLength(8);
    const write = inbox.put(record('own', 'new'));
    expect((await inbox.next('own', 64, new Set(), epoch)).some((row) => row.id === 'new')).toBe(
      true,
    );
    await write;
    await inbox.put({
      ...record('own', 'future'),
      event: { ...record('own', 'future').event, created_at: 30 },
    });
    await inbox.put({
      ...record('own', 'middle'),
      event: { ...record('own', 'middle').event, created_at: 20 },
    });
    const timed = await inbox.next('own', 4, new Set(), epoch, 20);
    expect(timed).toHaveLength(4);
    expect(timed[0].id).toBe('middle');
    expect(timed.some((row) => row.id === 'future' || row.account !== 'own')).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
