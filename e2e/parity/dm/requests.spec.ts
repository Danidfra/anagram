// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  acceptFirstRequest,
  bootstrapUser,
  deleteFirstRequest,
  disposeUsers,
  expectNoUnexpectedBrowserErrors,
  openDirectChatFromIdentifier,
  openRequests,
  sendMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  waitForNoRequests,
  waitForThreadMessage,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

for (const width of [1280, 390]) {
  test(`accepting a first-contact DM opens the conversation and supports reply at ${width}px`, async ({
    browser,
  }) => {
    const alice = await bootstrapUser(browser, TEST_ACCOUNTS[`requestAlice${width}`]);
    const bob = await bootstrapUser(browser, TEST_ACCOUNTS[`requestBob${width}`]);

    try {
      await bob.page.setViewportSize({ width, height: 844 });
      const openingMessage = `hello-from-alice-${Date.now()}`;
      const replyMessage = `reply-from-bob-${Date.now()}`;

      await openDirectChatFromIdentifier(
        alice.page,
        bob.session.publicKey,
        bob.account.displayName,
      );
      await sendMessage(alice.page, openingMessage, {
        chatId: bob.session.publicKey,
      });

      await openRequests(bob.page);
      await expect(bob.page.getByTestId('chat-request-item')).toContainText(openingMessage);
      await acceptFirstRequest(bob.page);

      await expect(bob.page).toHaveURL(new RegExp(`/chats/${alice.session.publicKey}$`));
      await waitForThreadMessage(bob.page, openingMessage, { chatId: alice.session.publicKey });
      await expect(bob.page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await sendMessage(bob.page, replyMessage, {
        chatId: alice.session.publicKey,
      });
      await waitForThreadMessage(alice.page, replyMessage, {
        chatId: bob.session.publicKey,
      });
      await expectNoUnexpectedBrowserErrors([alice, bob]);
    } finally {
      await disposeUsers(alice, bob);
    }
  });
}

test('deleting a first-contact DM request keeps later messages in requests instead of accepted chats', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.blockAlice);
  let bob = await bootstrapUser(browser, TEST_ACCOUNTS.blockBob);

  try {
    const openingMessage = `deleted-request-open-${Date.now()}`;
    const followupMessage = `deleted-request-followup-${Date.now()}`;
    const openingCreatedAt = new Date(Date.now() - 10_000).toISOString();
    const followupCreatedAt = new Date(Date.parse(openingCreatedAt) + 5_000).toISOString();

    await openDirectChatFromIdentifier(
      alice.page,
      bob.session.publicKey,
      TEST_ACCOUNTS.blockBob.displayName,
    );
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, [openingMessage], {
      createdAts: [openingCreatedAt],
    });
    await waitForThreadMessage(alice.page, openingMessage, {
      chatId: bob.session.publicKey,
    });

    await openRequests(bob.page);
    await expect(bob.page.getByTestId('chat-request-item')).toContainText(openingMessage);
    await deleteFirstRequest(bob.page);
    await waitForNoRequests(bob.page);

    await sendMessagesViaBridge(alice.page, bob.session.publicKey, [followupMessage], {
      createdAts: [followupCreatedAt],
    });
    await waitForThreadMessage(alice.page, followupMessage, {
      chatId: bob.session.publicKey,
    });
    await openRequests(bob.page);
    await expect(bob.page.getByTestId('chat-request-item')).toContainText(followupMessage);
    await bob.page.goto('/chats');
    await expect(bob.page.getByTestId('chat-item')).toHaveCount(2);

    await bob.context.close();
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.blockBob);
    await openRequests(bob.page);
    await expect(bob.page.getByTestId('chat-request-item')).toContainText(followupMessage);
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
