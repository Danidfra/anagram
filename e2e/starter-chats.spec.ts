import { test, expect } from '@playwright/test';
import { bootstrapUser, disposeUsers, TEST_ACCOUNTS } from './parity/helpers';

for (const width of [1280, 390]) {
  test(`starter public group and self-chat appear once and respect removal at ${width}px`, async ({
    browser,
  }) => {
    const user = await bootstrapUser(browser, TEST_ACCOUNTS[`starter${width}`]);
    const page = user.page;
    try {
      await page.setViewportSize({ width, height: 844 });
      // Starter rows are local data; opening the supplied public room can use its
      // signed cached profile even when its external relays are unavailable.
      await page.routeWebSocket(/^wss:/, (socket) => socket.close());
      const own = page.locator(
        `[data-testid="chat-item"][data-chat-public-key="${user.session.publicKey}"]`,
      );
      const group = page.getByTestId('public-chat-item').filter({ hasText: 'Anagram rants' });
      await expect(page.getByTestId('chat-item')).toHaveCount(1);
      await expect(own).toContainText('My Self');
      await expect(group).toHaveCount(1);
      await page.reload();
      await expect(page.getByTestId('chat-item')).toHaveCount(1);
      await expect(group).toHaveCount(1);
      await own.click();
      await expect(page).toHaveURL(new RegExp(`/chats/${user.session.publicKey}$`));
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await expect(page.locator('.self-chat-quote')).toBeVisible();
      if (width === 390)
        await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
      const ownRow = page.locator('.chat-row').filter({ has: own });
      await ownRow.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await ownRow.getByRole('menuitem', { name: 'Delete Chat', exact: true }).click();
      await expect(own).toHaveCount(0);
      await group.click();
      await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
        'Anagram rants',
      );
      await page.getByRole('button', { name: 'Public group settings' }).click();
      await page.getByRole('button', { name: 'Leave public group', exact: true }).click();
      await page.getByRole('button', { name: 'Leave group', exact: true }).click();
      await expect(group).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
      await expect(page.getByTestId('chat-item')).toHaveCount(0);
      await expect(group).toHaveCount(0);
      expect(user.browserErrors).toEqual([]);
    } finally {
      await disposeUsers(user);
    }
  });
}
