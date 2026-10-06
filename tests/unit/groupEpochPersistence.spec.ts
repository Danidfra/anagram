import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { chatDataService } from '#src/services/chatDataService.ts';

afterEach(async () => {
  await chatDataService.clearAllData();
  vi.unstubAllGlobals();
});

it('profile and older-ticket writes cannot erase recovered epochs or roll back the writable key', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = 'a'.repeat(64);
  const entry = (epoch: number) => ({
    epoch_number: epoch,
    epoch_public_key: epoch.toString(16).padStart(64, '0'),
    epoch_private_key_encrypted: `encrypted-${epoch}`,
    invitation_created_at: '2026-01-02T00:00:00.000Z',
  });
  await chatDataService.createChat({ public_key: group, type: 'group', name: 'Group' });
  const beforeTicket = (await chatDataService.getChatByPublicKey(group))!.meta;
  await chatDataService.updateChat(group, { meta: { group_epoch_keys: [entry(21)] } });
  // Profile hydration started before the ticket, finishes afterwards.
  await chatDataService.updateChat(group, {
    name: 'Restored name',
    meta: { ...beforeTicket, picture: 'https://example.test/picture' },
  });
  // Two restores took the same snapshot, and complete in reverse epoch order.
  await Promise.all(
    [20, 19].map((epoch) =>
      chatDataService.updateChatMeta(group, {
        group_epoch_keys: [entry(epoch)],
        current_epoch_public_key: entry(epoch).epoch_public_key,
      }),
    ),
  );
  const restored = (await chatDataService.getChatByPublicKey(group))!;
  expect(restored.meta.group_epoch_keys).toEqual([entry(21), entry(20), entry(19)]);
  expect(restored.meta.current_epoch_public_key).toBe(entry(21).epoch_public_key);
  expect(restored.meta.current_epoch_private_key_encrypted).toBe(
    entry(21).epoch_private_key_encrypted,
  );
  // Older copies of a reissued ticket cannot move its timestamp backwards.
  await chatDataService.updateChatMeta(group, {
    ...restored.meta,
    group_epoch_keys: [{ ...entry(21), invitation_created_at: '2026-01-01T00:00:00.000Z' }],
  });
  expect((await chatDataService.getChatByPublicKey(group))!.meta.group_epoch_keys).toEqual([
    entry(21),
    entry(20),
    entry(19),
  ]);
});

it('keeps epoch tickets when owner/profile restoration creates the same group concurrently', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = 'f'.repeat(64);
  const ticket = {
    epoch_number: 4,
    epoch_public_key: 'd'.repeat(64),
    epoch_private_key_encrypted: 'encrypted epoch',
  };
  await Promise.all([
    chatDataService.createChat({
      public_key: group,
      type: 'group',
      name: 'Owner backup',
      meta: { inbox_state: 'accepted' },
    }),
    chatDataService.createChat({
      public_key: group,
      type: 'group',
      name: 'Epoch ticket',
      meta: { group_epoch_keys: [ticket] },
    }),
  ]);
  const restored = (await chatDataService.getChatByPublicKey(group))!;
  expect(restored.meta.group_epoch_keys).toEqual([ticket]);
  expect(restored.meta.current_epoch_public_key).toBe(ticket.epoch_public_key);
  expect(restored.name).toBe('Owner backup');
  expect(restored.meta.inbox_state).toBe('accepted');
});
