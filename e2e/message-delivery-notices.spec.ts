import { expect, test } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { finishOnboarding } from './auth-helpers';
import { E2E_RELAY_URL } from './parity/helpers';

test('relay rejection stays on the message status bar without a popup; other send errors still notify', async ({
  page,
}) => {
  // Intercept only after onboarding; all other relay traffic continues normally.
  let rejectMessages = false;
  await page.routeWebSocket(E2E_RELAY_URL, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const [type, event] = JSON.parse(String(raw));
      if (rejectMessages && type === 'EVENT' && event.kind === 1059)
        socket.send(JSON.stringify(['OK', event.id, false, 'blocked: test relay rejection']));
      else server.send(raw);
    });
  });
  await page.addInitScript((url) => {
    const relays = JSON.stringify([{ url, read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  }, E2E_RELAY_URL);
  const key = generateSecretKey();
  await page.goto('/');
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  await page
    .locator(`[data-testid="chat-item"][data-chat-public-key="${getPublicKey(key)}"]`)
    .click();
  rejectMessages = true;
  const composer = page.getByTestId('message-composer-input');
  await composer.fill('Keep the failed message visible');
  await page.getByTestId('message-send-button').click();
  const message = page
    .getByTestId('message-bubble')
    .filter({ hasText: 'Keep the failed message visible' });
  const status = message.getByTestId('message-relay-status');
  await expect(status.locator('.bubble__status-segment--red')).toBeVisible();
  await expect(composer).toHaveValue('Keep the failed message visible');
  await expect(page.locator('.notices .error')).toHaveCount(0);
  await status.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('blocked: test relay rejection');
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(async () => {
    const { useMessageStore } = await import('/src/stores/messageStore.ts');
    useMessageStore().sendMessage = async () => {
      throw new Error('Failed to persist outbound message.');
    };
  });
  await composer.fill('Local save failure');
  await page.getByTestId('message-send-button').click();
  await expect(page.locator('.notices .error')).toContainText(
    'Failed to persist outbound message.',
  );
});
