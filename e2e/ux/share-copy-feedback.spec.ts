import { expect, test, type Page } from '@playwright/test';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  navigateInApp,
  openDirectChatFromIdentifier,
  TEST_ACCOUNTS,
} from '../parity/helpers';

async function copyFromShareDialog(page: Page) {
  await page.getByTestId('contact-profile-share-button').click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Public Key copied.');
}

test('copying from a share dialog confirms inside the dialog', async ({ browser }) => {
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.shareCopyUser);
  try {
    const { page, context } = user;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await navigateInApp(page, '/settings/profile');
    await copyFromShareDialog(page);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^nostr:npub1/);
    await page.keyboard.press('Escape');

    const contact = getPublicKey(generateSecretKey());
    await navigateInApp(page, '/chats');
    await openDirectChatFromIdentifier(page, contact, 'Share copy contact');
    await navigateInApp(page, `/contacts/${contact}`);
    await copyFromShareDialog(page);
  } finally {
    await disposeUsers(user);
  }
});
