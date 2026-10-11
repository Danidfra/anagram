import { afterEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { contactsService } from '#src/services/contactsService.ts';
afterEach(async () => {
  await contactsService.clearAllData();
  vi.unstubAllGlobals();
});
it('persists public follows per account without creating contacts and never rolls back newer lists', async () => {
  vi.stubGlobal('window', { indexedDB });
  const key = generateSecretKey(),
    other = generateSecretKey();
  const list = (created_at: number, keys: string[], signer = key) =>
    finalizeEvent({ kind: 3, created_at, content: '', tags: keys.map((k) => ['p', k]) }, signer);
  const old = list(10, [getPublicKey(other)]),
    current = list(20, []),
    second = list(15, [getPublicKey(key)], other);
  await contactsService.savePublicFollowList(old);
  await Promise.all([
    contactsService.savePublicFollowList(current),
    contactsService.savePublicFollowList(old),
    contactsService.savePublicFollowList(second),
  ]);
  expect(await contactsService.getPublicFollowList(getPublicKey(key))).toEqual(
    JSON.parse(JSON.stringify(current)),
  );
  expect(await contactsService.getPublicFollowList(getPublicKey(other))).toEqual(
    JSON.parse(JSON.stringify(second)),
  );
  expect(await contactsService.listContacts()).toEqual([]);
});
