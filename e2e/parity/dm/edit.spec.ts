// Behavioral scenarios ported from original Anagram; Svelte helpers, unlimited hydration.
import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  editMessage,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  reloadAndWaitForApp,
  replyToMessage,
  sendMessage,
  TEST_ACCOUNTS,
  threadMessage,
  waitForNoThreadMessage,
  waitForThreadMessage,
  waitForThreadMessageCount,
} from '../helpers';

// Each scenario owns its accounts; a failure must not skip other coverage.

test('encrypted DM edit replaces the original without duplicate messages', async ({ browser }) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.editAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.editBob);

  try {
    const originalText = `dm-before-edit-${Date.now()}`;
    const editedText = `dm-after-edit-${Date.now()}`;
    const preservedDraft = `unsent-draft-${Date.now()}`;

    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(alice.page, bob.session.publicKey);
    await sendMessage(alice.page, originalText, {
      chatId: bob.session.publicKey,
    });
    await waitForThreadMessage(bob.page, originalText, {
      chatId: alice.session.publicKey,
    });

    await alice.page.getByTestId('message-composer-input').fill(preservedDraft);
    await editMessage(alice.page, originalText, editedText, {
      chatId: bob.session.publicKey,
    });
    await expect(alice.page.getByTestId('message-composer-input')).toHaveValue(preservedDraft);
    await expect(
      threadMessage(alice.page, editedText).getByTestId('message-edited-label'),
    ).toBeVisible();

    await waitForThreadMessage(bob.page, editedText, {
      chatId: alice.session.publicKey,
    });
    await waitForNoThreadMessage(bob.page, originalText, {
      chatId: alice.session.publicKey,
      refresh: false,
    });
    await waitForThreadMessageCount(bob.page, editedText, 1, {
      chatId: alice.session.publicKey,
    });
    await expect(
      threadMessage(bob.page, editedText).getByTestId('message-edited-label'),
    ).toBeVisible();

    for (const user of [alice, bob])
      await expect(threadMessage(user.page, editedText).locator('.reply-preview')).toHaveCount(0);

    // Simulate metadata saved by the old parser, then load that row again.
    const editedId = await threadMessage(bob.page, editedText).getAttribute('data-event-id');
    await bob.page.evaluate(
      async ({ eventId, originalText }) => {
        const { chatDataService } = await import('/src/services/chatDataService.ts');
        const row = await chatDataService.getMessageByEventId(eventId!);
        if (!row) throw new Error('Edited message missing');
        const edited = row.meta.edited as { previousEventIds: string[] };
        await chatDataService.updateMessageMeta(row.id, {
          ...row.meta,
          reply: { eventId: edited.previousEventIds[0], text: originalText, authorName: 'Alice' },
        });
      },
      { eventId: editedId, originalText },
    );
    await reloadAndWaitForApp(bob.page);
    await waitForNoThreadMessage(bob.page, originalText, {
      chatId: alice.session.publicKey,
      refresh: false,
    });
    await waitForThreadMessageCount(bob.page, editedText, 1, {
      chatId: alice.session.publicKey,
    });
    await expect(threadMessage(bob.page, editedText).locator('.reply-preview')).toHaveCount(0);

    const reply = `real-reply-${Date.now()}`;
    const editedReply = `revised-reply-${Date.now()}`;
    await replyToMessage(bob.page, editedText, reply);
    await waitForThreadMessage(alice.page, reply, { chatId: bob.session.publicKey });
    await editMessage(bob.page, reply, editedReply);
    await waitForThreadMessage(alice.page, editedReply, { chatId: bob.session.publicKey });
    for (const user of [alice, bob]) {
      const message = threadMessage(user.page, editedReply);
      await expect(message.getByTestId('message-edited-label')).toBeVisible();
      await expect(message.locator('.reply-preview')).toContainText(editedText);
    }
    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
