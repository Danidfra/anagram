import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { contactsService } from '#src/services/contactsService.ts';
import { clearPublicProfiles, getPublicProfile } from '#src/lib/state/publicProfiles.ts';
afterEach(async () => {
  await contactsService.clearAllData();
  vi.unstubAllGlobals();
});
it('restores historical authors without creating contacts, and preserves newer snapshots across competing writes', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const publicKey = 'b'.repeat(64);
  await Promise.all([
    contactsService.savePublicProfile(publicKey, {
      name: 'New',
      picture: 'https://images.test/new',
      createdAt: 20,
      eventId: 'a',
    }),
    contactsService.savePublicProfile(publicKey, {
      name: 'Old',
      picture: '',
      createdAt: 10,
      eventId: 'b',
    }),
  ]);
  clearPublicProfiles();
  await contactsService.restorePublicProfiles([publicKey]);
  expect(getPublicProfile(publicKey)).toMatchObject({
    name: 'New',
    picture: 'https://images.test/new',
  });
  expect(await contactsService.listContacts()).toEqual([]);
  await contactsService.clearAllData();
  expect(getPublicProfile(publicKey)).toBeUndefined();
});
