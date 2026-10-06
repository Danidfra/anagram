import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  sendMessage,
  threadMessage,
  refreshSession,
} from '../helpers';
test('message healing preserves the open image viewer and download filename', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.imageAlice),
    bob = await bootstrapUser(browser, TEST_ACCOUNTS.imageBob);
  const url = 'https://media.example.test/e2e-image.svg';
  try {
    await alice.page.route(url, (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        headers: { 'access-control-allow-origin': '*' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>',
      }),
    );
    await establishAcceptedDirectChat(alice, bob);
    await sendMessage(alice.page, 'Image viewer fixture');
    await alice.page.evaluate(
      async ({ chatId, url }) =>
        window.__appE2E__!.setStoredMessageAttachments({
          chatId,
          messageText: 'Image viewer fixture',
          attachments: [
            { type: 'media', url, mimeType: 'image/svg+xml', size: 128, name: 'e2e-image.svg' },
          ],
        }),
      { chatId: bob.session.publicKey, url },
    );
    await threadMessage(alice.page, 'Image viewer fixture')
      .getByRole('img', { name: 'e2e-image.svg' })
      .click();
    const viewer = alice.page.getByRole('dialog', { name: 'Image attachment' });
    await expect(viewer).toBeVisible();
    await refreshSession(alice.page, bob.session.publicKey);
    await expect(viewer).toBeVisible();
    await alice.page.evaluate(() => window.__appE2E__!.startManualReconnectHealing());
    await expect
      .poll(() => alice.page.evaluate(() => window.__appE2E__!.isReconnectHealing()))
      .toBe(false);
    await expect(viewer).toBeVisible();
    const downloaded = alice.page.waitForEvent('download');
    await viewer.getByRole('button', { name: 'Download image', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('e2e-image.svg');
    await viewer.getByRole('button', { name: 'Close image' }).click();
    await expect(viewer).toBeHidden();
  } finally {
    await disposeUsers(alice, bob);
  }
});
