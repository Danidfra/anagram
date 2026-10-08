import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  sendMessage,
  replyToMessage,
  deleteMessage,
  navigateToChat,
} from './parity/helpers';
test('private deletion replaces existing reply text on both clients and after reload', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.deletedQuoteAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.deletedQuoteBob);
  try {
    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, 'Original confidential content');
    await replyToMessage(bob.page, 'Original confidential content', 'A reply that should remain');
    const quotes = (page: typeof alice.page) =>
      page
        .getByTestId('message-bubble')
        .filter({ hasText: 'A reply that should remain' })
        .locator('.reply-preview');
    await expect(quotes(alice.page)).toContainText('Original confidential content');
    await deleteMessage(alice.page, 'Original confidential content');
    for (const user of [alice, bob]) {
      await expect(quotes(user.page)).toContainText('Message deleted');
      await expect(user.page.getByRole('log', { name: 'Messages' })).not.toContainText(
        'Original confidential content',
      );
      await user.page.reload();
      await navigateToChat(
        user.page,
        user === alice ? bob.session.publicKey : alice.session.publicKey,
      );
      await expect(quotes(user.page)).toContainText('Message deleted');
    }
  } finally {
    await disposeUsers(alice, bob);
  }
});
