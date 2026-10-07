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
