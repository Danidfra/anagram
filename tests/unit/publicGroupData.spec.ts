import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { PublicGroupData } from '#src/services/publicGroupData.ts';
import { parsePublicRoom, roomTags } from '#src/stores/nostr/publicGroups.ts';
it('keeps account stores isolated and pages equal-timestamp messages without overlap', async () => {
  const key = generateSecretKey(),
    account = getPublicKey(key),
    other = getPublicKey(generateSecretKey());
  const a = new PublicGroupData(account),
    b = new PublicGroupData(other);
  const room = parsePublicRoom(
    finalizeEvent(
      {
        kind: 34550,
        created_at: 1,
        content: '',
        tags: roomTags({
          slug: 'test',
          name: 'Test',
          about: '',
          picture: '',
          relays: ['wss://relay.example.org'],
          trusted: [],
          blocked: [],
        }),
      },
      key,
    ),
  );
  await a.save({ address: room.address, room, joined: true, updated: 1 });
  expect(await b.list()).toEqual([]);
  const events = Array.from({ length: 75 }, (_, i) =>
    finalizeEvent(
      { kind: 9, created_at: 2, tags: [['a', room.address]], content: `message ${i}` },
      key,
    ),
  );
  for (const event of events) await a.put(room.address, event);
  const recent = await a.page(room.address),
    earlier = await a.page(room.address, { created_at: recent[0].created_at, id: recent[0].id! });
  expect(recent).toHaveLength(50);
  expect(earlier).toHaveLength(25);
  const forward = await a.page(
    room.address,
    {
      created_at: earlier.at(-1)!.created_at,
      id: earlier.at(-1)!.id!,
    },
    50,
    'next',
  );
  expect(forward.map((e) => e.id)).toEqual(recent.map((e) => e.id));
  expect(new Set([...recent, ...earlier].map((e) => e.id)).size).toBe(75);
  expect(await b.page(room.address)).toEqual([]);
  await a.put(room.address, events[0]);
  expect(await a.page(room.address, undefined, 100)).toHaveLength(75);
  await a.close();
  await b.close();
});

it('retains older fetched history beyond 2000 rows while keeping reads bounded', async () => {
  const key = generateSecretKey();
  const db = new PublicGroupData(getPublicKey(key));
  const template = finalizeEvent(
    { kind: 9, created_at: 1, content: 'Stored history', tags: [] },
    key,
  );
  // This test exercises storage retention and paging, not signature validation.
  const events = Array.from({ length: 2010 }, (_, i) => ({
    ...template,
    id: i.toString(16).padStart(64, '0'),
    created_at: i + 1,
  }));
  await db.putMany('retained', events);
  expect((await db.message('retained', events[0].id))?.id).toBe(events[0].id);
  expect(await db.page('retained')).toHaveLength(50);
  const oldest = await db.page('retained', { created_at: 11, id: events[10].id });
  expect(oldest.map((event) => event.id)).toEqual(events.slice(0, 10).map((event) => event.id));
  await db.close();
});

it('merges batched duplicate receipts without erasing publish evidence on replay', async () => {
  const key = generateSecretKey(),
    account = getPublicKey(key);
  const db = new PublicGroupData(account);
  const event = finalizeEvent({ kind: 9, content: 'status', tags: [], created_at: 1 }, key);
  const status = (relay_url: string) => ({
    relay_url,
    direction: 'inbound' as const,
    scope: 'subscription' as const,
    status: 'received' as const,
    updated_at: new Date().toISOString(),
  });
  await db.put('room', {
    ...event,
    relay_statuses: [
      {
        ...status('wss://one.example/'),
        direction: 'outbound',
        scope: 'recipient',
        status: 'published',
      },
    ],
  });
  await db.putMany('room', [
    { ...event, relay_statuses: [status('wss://one.example/')] },
    { ...event, relay_statuses: [status('wss://two.example/')] },
  ]);
  await db.put('room', event);
  expect((await db.message('room', event.id))?.relay_statuses).toHaveLength(3);
  expect(await db.message('other', event.id)).toBeUndefined();
  await db.close();
});

it('searches the room cursor newest first with normalized text, a result cap and cancellation', async () => {
  const key = generateSecretKey();
  const db = new PublicGroupData(getPublicKey(key));
  const events = Array.from({ length: 125 }, (_, i) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: i + 1,
        content: `Needle\n  MATCH ${i}`,
        tags: [],
      },
      key,
    ),
  );
  await db.putMany('search-room', events);
  await db.put('other-room', events[0]);
  const results = await db.search('search-room', ' needle MATCH ', (event) => event.content);
  expect(results).toHaveLength(100);
  expect(results[0].messageId).toBe(events[124].id);
  expect(results.at(-1)!.messageId).toBe(events[25].id);
  expect(await db.search('other-room', 'match', (event) => event.content)).toHaveLength(1);
  expect(await db.search('missing-room', 'match', (event) => event.content)).toEqual([]);
  const controller = new AbortController();
  let visited = 0;
  expect(
    await db.search(
      'search-room',
      'match',
      (event) => {
        visited++;
        controller.abort();
        return event.content;
      },
      controller.signal,
    ),
  ).toEqual([]);
  expect(visited).toBe(1);
  await db.close();
});

it('upgrades the existing public cache without losing messages and isolates action lookups by account, room and author', async () => {
  const key = generateSecretKey(),
    account = getPublicKey(key),
    foreign = generateSecretKey();
  const original = finalizeEvent(
    { kind: 9, created_at: 1, tags: [['a', 'room']], content: 'Saved before upgrade' },
    key,
  );
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(`anagram-public-groups-${account}`, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('rooms', { keyPath: 'address' });
      request.result
        .createObjectStore('messages', { keyPath: ['room', 'id'] })
        .createIndex('timeline', ['room', 'created_at', 'id']);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction('messages', 'readwrite');
      tx.objectStore('messages').put({ ...original, room: 'room' });
      tx.oncomplete = () => {
        request.result.close();
        resolve();
      };
    };
  });
  const db = new PublicGroupData(account),
    other = new PublicGroupData(getPublicKey(generateSecretKey()));
  expect((await db.page('room'))[0].content).toBe('Saved before upgrade');
  const forged = Array.from({ length: 130 }, (_, i) =>
    finalizeEvent({ kind: 5, created_at: i + 2, content: '', tags: [['e', original.id]] }, foreign),
  );
  const actual = finalizeEvent(
    { kind: 5, created_at: 140, content: '', tags: [['e', original.id]] },
    key,
  );
  await db.putActions(
    'room',
    [...forged, actual].map((event) => ({ event, targets: [original.id] })),
  );
  const actions = await db.actionsFor('room', [original.id], new Map([[original.id, account]]));
  expect(actions.map((event) => event.id)).toEqual([actual.id]);
  expect(await other.actionsFor('room', [original.id])).toEqual([]);
  expect(await db.actionsFor('different-room', [original.id])).toEqual([]);
  expect(await db.action('room', actual.id)).not.toHaveProperty('targets');
  await db.close();
  await other.close();
});

it('journals bounded pages, merges replica receipts, and resumes after reopening', async () => {
  const key = generateSecretKey(),
    account = getPublicKey(key);
  const db = new PublicGroupData(account);
  const events = Array.from({ length: 300 }, (_, i) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: i + 1,
        tags: [['a', 'room']],
        content: `pending ${i}`,
      },
      key,
    ),
  );
  const receipt = (relay_url: string) => ({
    relay_url,
    direction: 'inbound' as const,
    scope: 'subscription' as const,
    status: 'received' as const,
    updated_at: '2026-10-14T12:00:00Z',
  });
  await Promise.all(
    events.flatMap((event) =>
      ['wss://one.example/', 'wss://two.example/'].map((url) =>
        db.enqueue('room', { ...event, relay_statuses: [receipt(url)] }, true),
      ),
    ),
  );
  const first = await db.inboxPage('room');
  expect(first).toHaveLength(64);
  expect(first[0].event.id).toBe(events[0].id);
  expect(first[0].event.relay_statuses).toHaveLength(2);
  // A new receipt during processing must not be deleted by an older completion.
  await db.enqueue(
    'room',
    { ...events[0], relay_statuses: [receipt('wss://three.example/')] },
    false,
  );
  await db.completeInbox(first);
  await db.close();
  const reopened = new PublicGroupData(account);
  const other = new PublicGroupData(getPublicKey(generateSecretKey()));
  expect(await other.inboxPage('room')).toEqual([]);
  expect(await reopened.inboxPage('other-room')).toEqual([]);
  const pending = await reopened.inboxPage('room');
  expect(pending[0].event.relay_statuses).toHaveLength(3);
  expect(pending[0].timeline).toBe(true);
  let drained = 0;
  for (let batch = pending; batch.length; batch = await reopened.inboxPage('room')) {
    expect(batch.length).toBeLessThanOrEqual(64);
    drained += batch.length;
    await reopened.completeInbox(batch);
  }
  expect(drained).toBe(237);
  await reopened.close();
  await other.close();
});

it('upgrades version 3 without rebuilding or losing stored public messages', async () => {
  const key = generateSecretKey(),
    account = getPublicKey(key);
  const event = finalizeEvent(
    { kind: 9, created_at: 1, tags: [], content: 'Saved before upgrade' },
    key,
  );
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(`anagram-public-groups-${account}`, 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('rooms', { keyPath: 'address' });
      const messages = request.result.createObjectStore('messages', { keyPath: ['room', 'id'] });
      messages.createIndex('timeline', ['room', 'created_at', 'id']);
      messages.put({ ...event, room: 'room' });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const db = new PublicGroupData(account);
  expect((await db.page('room'))[0].id).toBe(event.id);
  await db.enqueue('room', event, true);
  expect(await db.inboxPage('room')).toHaveLength(1);
  await db.close();
});
