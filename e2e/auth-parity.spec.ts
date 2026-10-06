import { test, expect } from '@playwright/test';
import { finishOnboarding } from './auth-helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  });
});

test('registration downloads the secret without rendering it and continues through onboarding', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  const downloadButton = page.getByRole('button', { name: 'Download Account Secret', exact: true });
  await expect(downloadButton).toBeVisible();
  expect((await page.locator('body').innerText()).includes('nsec1')).toBe(false);
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  expect(download.suggestedFilename()).toBe('anagram-account-secret.txt');
  await page.getByRole('button', { name: 'Login Now', exact: true }).click();
  await finishOnboarding(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});

test('signer tabs, pairing QR, cancellation and key warning match the original flow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await expect(page.getByRole('button', { name: 'Login with Extension', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Login with Remote Signer', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Bunker URL', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Nostr Connect', exact: true }).click();
  await page.getByTestId('auth-remote-signer-relay-input').fill('ws://127.0.0.1:7777/');
  await page.getByTestId('auth-remote-signer-create-nostrconnect-button').click();
  await expect(page.getByTestId('auth-remote-signer-nostrconnect-qr')).toBeVisible();
  await expect(page.getByTestId('auth-remote-signer-nostrconnect-uri')).toHaveValue(
    /^nostrconnect:\/\//,
  );
  await page.getByTestId('auth-remote-signer-cancel-button').click();
  await expect(page.getByTestId('auth-remote-signer-nostrconnect-qr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByTestId('auth-open-key-button').click();
  await expect(page.locator('.key-warning')).toBeVisible();
  await expect(page.getByTestId('auth-private-key-input')).toHaveAttribute('type', 'password');
});
