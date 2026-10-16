import { expect, test } from '@playwright/test';
import { startRelay } from '../scripts/release-smoke/relay.mjs';
import { finishOnboarding } from './auth-helpers';

test('restores the live encrypted inbox after the relay drops its connections', async ({
  page,
}) => {
  const relay = await startRelay();
  try {
    await page.addInitScript((url) => {
      const entries = JSON.stringify([{ url, read: true, write: true }]);
      localStorage.setItem('relays', entries);
      localStorage.setItem('nip65_relays', entries);
    }, relay.url);
    await page.goto('/');
    await page.getByTestId('auth-open-key-button').click();
    await page.getByTestId('auth-private-key-input').fill(relay.nsec);
    await page.getByTestId('auth-login-button').click();
    await finishOnboarding(page);
    await page.locator(`[data-testid="chat-item"][data-chat-public-key="${relay.pubkey}"]`).click();
    await expect.poll(() => relay.hasLiveInboxSubscription()).toBe(true);
    relay.deliver('Before disconnect');
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'Before disconnect' }),
    ).toBeVisible();
    // Let the ten-second watchdog complete a healthy check before disconnecting.
    // Its synchronous path must not leave recovery permanently marked as running.
    await page.waitForTimeout(12000);
    const before = relay.stats.connections;
    relay.disconnect();
    await expect
      .poll(() => relay.stats.connections > before && relay.hasLiveInboxSubscription(), {
        timeout: 45000,
      })
      .toBe(true);
    relay.deliver('After disconnect');
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: 'After disconnect' }),
    ).toBeVisible();
  } finally {
    await relay.close();
  }
});
