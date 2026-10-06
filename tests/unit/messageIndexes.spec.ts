import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { chatDataService } from '#src/services/chatDataService.ts';

afterEach(async () => {
  await chatDataService.clearAllData();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('upgrades existing history, indexes edit/reaction references and pages equal timestamps', async () => {
  const database = new IDBFactory();
  vi.stubGlobal('window', { indexedDB: database });
  const peer = 'a'.repeat(64),
    current = 'b'.repeat(64),
    previous = 'c'.repeat(64),
    reaction = 'd'.repeat(64);
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = database.open('chat-data-indexeddb-v2', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chats', { keyPath: 'public_key' });
      request.result.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = old.transaction(['chats', 'messages'], 'readwrite');
    tx.objectStore('chats').put({
      public_key: peer,
      type: 'direct',
      name: 'Existing',
      last_message: 'cached',
      last_message_at: null,
      unread_count: 0,
      meta: {},
    });
    for (let id = 1; id <= 800; id++)
      tx.objectStore('messages').put({
        id,
        chat_public_key: peer,
        author_public_key: peer,
        message: `Existing ${id}`,
        created_at: '2026-01-01T00:00:00.000Z',
        ...(id === 400 ? { event_id: current } : {}),
        meta:
          id === 400
            ? { edited: { previousEventIds: [previous] }, reactions: [{ eventId: reaction }] }
            : {},
      });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  old.close();
  await chatDataService.init();
  const upgraded = await chatDataService.getDatabase();
  expect(upgraded.version).toBe(5);
  const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  expect((await chatDataService.getMessageByEventIdOrEditReference(previous))?.id).toBe(400);
  expect((await chatDataService.findMessageByReactionEventId(reaction))?.id).toBe(400);
  expect(await chatDataService.getMessageByEventIdOrEditReference('e'.repeat(64))).toBeNull();
  expect(
    (
      await chatDataService.listMessagesBefore(
        peer,
        { id: 400, created_at: '2026-01-01T00:00:00.000Z' },
        50,
      )
    ).rows.map((row) => row.id),
  ).toEqual(Array.from({ length: 50 }, (_, n) => 350 + n));
  expect(
    (
      await chatDataService.listMessagesAfter(
        peer,
        { id: 400, created_at: '2026-01-01T00:00:00.000Z' },
        50,
      )
    ).rows.map((row) => row.id),
  ).toEqual(Array.from({ length: 50 }, (_, n) => 401 + n));
  const migratedReactions = [];
  for await (const batch of chatDataService.reactionMessageBatches(peer))
    migratedReactions.push(...batch);
  expect(migratedReactions.map((row) => row.id)).toEqual([400]);
  await chatDataService.updateMessageMeta(400, { reactions: [{ eventId: 'f'.repeat(64) }] });
  expect(await chatDataService.findMessageByReactionEventId(reaction)).toBeNull();
  expect((await chatDataService.findMessageByReactionEventId('f'.repeat(64)))?.id).toBe(400);
  await chatDataService.updateMessageMeta(400, { deleted: { at: '2026-01-01T00:00:01.000Z' } });
  expect(
    (await chatDataService.findDeletedMessageInSecond(peer, peer, '2026-01-01T00:00:00.999Z'))?.id,
  ).toBe(400);
  expect(
    await chatDataService.findDeletedMessageInSecond(peer, peer, '2026-01-01T00:00:01.000Z'),
  ).toBeNull();
  expect(getAll).not.toHaveBeenCalled();
});
