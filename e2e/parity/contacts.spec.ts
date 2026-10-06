import { test, expect } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { WebSocket } from 'ws';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  E2E_RELAY_URL,
  establishAcceptedDirectChat,
  publishOwnProfile,
  expectPrivateContactListMember,
} from './helpers';
import { PRIVATE_CONTACT_LIST_D_TAG } from '../../src/stores/nostr/constants';
async function publish(event: ReturnType<typeof finalizeEvent>) {
  const ws = new WebSocket(E2E_RELAY_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (raw) => {
      const [type, id, ok] = JSON.parse(String(raw));
      if (type === 'OK' && id === event.id) ok ? resolve() : reject(new Error('Fixture rejected'));
    });
  });
  ws.close();
}
test('fresh login restores an old encrypted contact list and its metadata without manual refresh', async ({
  browser,
}) => {
  const owner = generateSecretKey(),
    peers = [generateSecretKey(), generateSecretKey()],
    created_at = Math.floor(Date.now() / 1000) - 400 * 86400;
  for (const [i, key] of peers.entries())
    await publish(
      finalizeEvent(
        {
          kind: 0,
          created_at,
          tags: [],
          content: JSON.stringify({ name: `Old contact ${i + 1}` }),
        },
        key,
      ),
    );
  await publish(
    finalizeEvent(
      {
        kind: 30000,
        created_at,
        tags: [['d', PRIVATE_CONTACT_LIST_D_TAG]],
        content: nip44.v2.encrypt(
          JSON.stringify(peers.map((key) => ['p', getPublicKey(key)])),
          nip44.v2.utils.getConversationKey(owner, getPublicKey(owner)),
        ),
      },
      owner,
    ),
  );
  const user = await bootstrapUser(browser, {
    privateKey: Buffer.from(owner).toString('hex'),
    displayName: 'Old list owner',
  });
  try {
    for (const peer of peers) await expectPrivateContactListMember(user.page, getPublicKey(peer));
    await user.page.goto('/contacts');
    await expect(user.page.getByText('Old contact 1', { exact: true })).toBeVisible();
    await expect(user.page.getByText('Old contact 2', { exact: true })).toBeVisible();
  } finally {
    await disposeUsers(user);
  }
});
test('contact refresh fetches a changed remote name and biography', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.profileAlice),
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.profileBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    await publishOwnProfile(bob.page, {
      name: 'Updated remote profile',
      about: 'Updated remote biography',
    });
    await alice.page.goto('/contacts');
    await alice.page.getByRole('button', { name: 'Refresh Contacts', exact: true }).click();
    await alice.page.goto(`/contacts/${bob.session.publicKey}`);
    await expect(alice.page.getByText('Updated remote biography', { exact: true })).toBeVisible();
    await expect(
      alice.page.getByText('Updated remote profile', { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await disposeUsers(alice, bob);
  }
});
test('opening an unknown public profile can create its chat and save the contact', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.unknownProfileAlice),
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.unknownProfileBob);
  try {
    await alice.page.goto(`/contacts/${bob.session.publicKey}`);
    await alice.page.getByRole('button', { name: 'Open Chat', exact: true }).click();
    await expect(alice.page).toHaveURL(new RegExp(`/chats/${bob.session.publicKey}$`));
    await expectPrivateContactListMember(alice.page, bob.session.publicKey);
  } finally {
    await disposeUsers(alice, bob);
  }
});
