import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { readFile } from 'node:fs/promises';
import { finishOnboarding } from './auth-helpers';
const relay = 'ws://127.0.0.1:7777/';
async function login(page: Page) {
  const key = generateSecretKey();
  await page.addInitScript((url) => {
    if (!localStorage.getItem('relays'))
      for (const name of ['relays', 'nip65_relays'])
        localStorage.setItem(name, JSON.stringify([{ url, read: true, write: true }]));
  }, relay);
  await page.goto('/');
  await page.getByTestId('auth-open-login-button').click();
  await page.getByTestId('auth-open-key-button').click();
  await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
  await page.getByTestId('auth-login-button').click();
  await finishOnboarding(page);
  return { key, pubkey: getPublicKey(key) };
}

test('settings routes, mobile back navigation, appearance and language persist', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  for (const id of [
    'profile',
    'relays',
    'notifications',
    'media-data-storage',
    'theme',
    'language',
    'developer',
    'logout',
  ])
    await expect(page.getByTestId(`settings-${id}-item`)).toBeVisible();
  await page.getByTestId('settings-theme-item').click();
  await page.getByRole('switch', { name: 'Dark mode', exact: true }).uncheck();
  await page.getByTestId('settings-desktop-message-layout-toggle').selectOption('bubbles');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Dark mode', exact: true })).not.toBeChecked();
  await expect(page.locator('body')).not.toHaveClass(/body--dark/);
  await expect(page.getByTestId('settings-desktop-message-layout-toggle')).toHaveValue('bubbles');
  const splitter = page.getByRole('separator', { name: 'Resize left panel' });
  const previousWidth = Number(await splitter.getAttribute('aria-valuenow'));
  await splitter.press('ArrowRight');
  await expect(splitter).toHaveAttribute('aria-valuenow', String(previousWidth + 16));
  await page.getByRole('button', { name: 'chats', exact: true }).click();
  await expect(page.getByRole('separator', { name: 'Resize left panel' })).toHaveAttribute(
    'aria-valuenow',
    String(previousWidth + 16),
  );
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByTestId('settings-language-item').click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('de-DE');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
  expect(errors).toEqual([]);
});

test('full profile fields publish together and sharing contains only public identity', async ({
  page,
}) => {
  const account = await login(page);
  await page.goto('/settings/profile');
  await page.getByTestId('profile-name').fill('Parity profile');
  await page.getByTestId('profile-nip05').fill('parity@example.com');
  await page.getByText('Extra Metadata Fields (NIP-24)', { exact: true }).click();
  await page.getByTestId('profile-display_name').fill('Parity display');
  await page.getByTestId('profile-website').fill('https://example.com');
  await page.getByLabel('Bot', { exact: true }).check();
  await page.getByLabel('Year', { exact: true }).fill('1995');
  await page.getByTestId('contact-profile-publish-button').click();
  await expect(page.getByRole('status')).toContainText('Profile metadata published.');
  await page.reload();
  await expect(page.getByTestId('profile-name')).toHaveValue('Parity profile');
  await page.getByText('Extra Metadata Fields (NIP-24)', { exact: true }).click();
  await expect(page.getByTestId('profile-display_name')).toHaveValue('Parity display');
  await expect(page.getByTestId('profile-website')).toHaveValue('https://example.com');
  await expect(page.getByLabel('Bot', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue('1995');
  await page.getByTestId('contact-profile-share-button').click();
  await expect(page.getByRole('dialog')).toContainText(nip19.npubEncode(account.pubkey));
  const dialog = await page.getByRole('dialog').textContent();
  expect(dialog).not.toContain(nip19.nsecEncode(account.key));
  expect(dialog).not.toContain(Buffer.from(account.key).toString('hex'));
});

test('personal, app and Iroh relay settings remain separate and validate input', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings/relays');
  await page.getByTestId('settings-relays-app-tab').click();
  await page.getByTestId('relay-editor-new-relay-input').fill('ws://user:secret@127.0.0.1:7778');
  await page.getByTestId('relay-editor-add-relay-button').click();
  await expect(page.getByRole('alert')).toContainText('valid');
  await page.getByTestId('relay-editor-new-relay-input').fill('ws://127.0.0.1:7778/');
  await page.getByTestId('relay-editor-add-relay-button').click();
  await expect(page.getByTestId('settings-relays-app-panel')).toContainText('ws://127.0.0.1:7778/');
  await page.getByTestId('settings-relays-my-tab').click();
  await expect(page.getByTestId('settings-relays-my-panel')).not.toContainText(
    'ws://127.0.0.1:7778/',
  );
  await page.getByTestId('settings-relays-my-panel').getByLabel('Write', { exact: true }).uncheck();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('nip65_relays')!)[0].write))
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('relays')!)[0].write))
    .toBe(true);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByTestId('settings-relays-iroh-tab').click();
  await expect(page.getByTestId('iroh-mode-custom')).toBeDisabled();
  await page.getByTestId('iroh-new-relay').fill('http://invalid.example/path');
  await expect(page.getByTestId('iroh-add-relay')).toBeDisabled();
  await page.getByTestId('iroh-new-relay').fill('https://calls.example.com');
  await page.getByTestId('iroh-add-relay').click();
  await expect(page.getByTestId('iroh-mode-pool-custom')).toBeChecked();
  await expect(page.getByTestId('iroh-mode-custom')).toBeEnabled();
  await page.getByTestId('iroh-mode-custom').check();
  await expect(page.getByTestId('iroh-relay-row')).toHaveCount(1);
  await expect(
    page.getByTestId('iroh-relay-row').getByRole('button', { name: 'Delete relay' }),
  ).toBeDisabled();
  await page.reload();
  await page.getByTestId('settings-relays-iroh-tab').click();
  await expect(page.getByTestId('iroh-mode-custom')).toBeChecked();
  await page.getByTestId('iroh-default-relays').click();
  await expect(page.getByTestId('iroh-mode-pool')).toBeChecked();
});

test('notifications can be disabled, media validates, diagnostics redact and logout confirms', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  const account = await login(page);
  await page.goto('/settings/notifications');
  await page.getByTestId('settings-notifications-toggle').check();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('ui-browser-notifications')))
    .toBe('1');
  await page.getByTestId('settings-notifications-toggle').uncheck();
  await page.reload();
  await expect(page.getByTestId('settings-notifications-toggle')).not.toBeChecked();
  await page.getByTestId('settings-media-data-storage-item').click();
  await page.getByTestId('settings-blossom-server-input').fill('https://user:password@example.com');
  await expect(page.getByTestId('settings-blossom-save')).toBeDisabled();
  await page.getByTestId('settings-blossom-server-input').fill('https://media.example.com');
  await page.getByTestId('settings-blossom-save').click();
  await expect(page.getByTestId('settings-blossom-save')).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('saved');
  await page.reload();
  await expect(page.getByTestId('settings-blossom-server-input')).toHaveValue(
    'https://media.example.com',
  );
  await page.getByTestId('settings-developer-item').click();
  await expect(page.getByLabel('Replay lookback (minutes)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restart DM Subscription', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('settings-diagnostics-download').click();
  const download = await downloadPromise;
  const json = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(json).diagnostics.privateMessagesSubscription).toBeTruthy();
  expect(json).not.toContain(nip19.nsecEncode(account.key));
  expect(json).not.toContain(Buffer.from(account.key).toString('hex'));
  await page.getByTestId('settings-force-refresh-button').click();
  await expect(page.getByRole('dialog')).toContainText('server is reachable');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('settings-logout-item').click();
  await expect(page.getByRole('dialog')).toContainText('remove your saved key');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.getByTestId('settings-logout-item').click();
  await page.getByTestId('settings-logout-confirm').click();
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('npub'))).toBeNull();
  await expect(page).toHaveURL(/\/$/);
});

test('failed private preference saves keep previous values and never surface secret errors', async ({
  page,
}) => {
  const account = await login(page);
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByTestId('settings-media-data-storage-item').click();
  await expect(page.getByTestId('settings-blossom-server-input')).toBeEnabled();
  const original = await page.getByTestId('settings-blossom-server-input').inputValue();
  await page.evaluate(async (secret) => {
    const { useNostrStore } = await import('/src/stores/nostrStore.ts');
    const store = useNostrStore();
    store.saveBlossomServerUrl = async () => {
      throw new Error(secret);
    };
    store.saveIrohRelaySettings = async () => {
      throw new Error(secret);
    };
  }, nip19.nsecEncode(account.key));
  await page.getByTestId('settings-blossom-server-input').fill('https://failed.example.com');
  await page.getByTestId('settings-blossom-save').click();
  await expect(page.getByRole('alert')).toContainText('save');
  expect(await page.locator('body').textContent()).not.toContain(nip19.nsecEncode(account.key));
  await page.getByTestId('settings-theme-item').click();
  await page.getByTestId('settings-media-data-storage-item').click();
  await expect(page.getByTestId('settings-blossom-server-input')).toHaveValue(original);
  await page.getByTestId('settings-relays-item').click();
  await page.getByTestId('settings-relays-iroh-tab').click();
  await page.getByTestId('iroh-new-relay').fill('https://failed.example.com');
  await page.getByTestId('iroh-add-relay').click();
  await expect(page.getByRole('alert')).toContainText('previous settings are still active');
  await expect(page.getByTestId('iroh-mode-pool')).toBeChecked();
  await expect(page.getByTestId('iroh-mode-custom')).toBeDisabled();
  expect(await page.locator('body').textContent()).not.toContain(nip19.nsecEncode(account.key));
});

test('force refresh preserves account data and contacts navigation works from settings', async ({
  page,
}) => {
  const account = await login(page);
  const peer = getPublicKey(generateSecretKey());
  await page.evaluate(
    async ({ peer }) => {
      const { contactsService } = await import('/src/services/contactsService.ts');
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      await contactsService.createContact({
        public_key: peer,
        name: 'Settings contact',
        meta: { name: 'Settings contact' },
        relays: [],
      });
      await chatDataService.createChat({
        public_key: peer,
        name: 'Settings contact',
        meta: { inbox_state: 'accepted' },
      });
    },
    { peer },
  );
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByRole('button', { name: 'contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: /Settings contact/ })).toBeVisible();
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByTestId('settings-force-refresh-button').click();
  await page.getByTestId('settings-force-refresh-confirm').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('settings-profile-item')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('npub'))).toBe(account.pubkey);
  await page.getByRole('button', { name: 'contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: /Settings contact/ })).toBeVisible();
});

test('messages received while viewing settings remain unread until the chat is visible', async ({
  page,
}) => {
  const account = await login(page),
    peerKey = generateSecretKey(),
    peer = getPublicKey(peerKey);
  await page.evaluate(async (peer) => {
    const { contactsService } = await import('/src/services/contactsService.ts');
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    await contactsService.createContact({
      public_key: peer,
      name: 'Unread peer',
      meta: {},
      relays: [{ url: 'ws://127.0.0.1:7777/', read: true, write: true }],
    });
    await chatDataService.createChat({
      public_key: peer,
      name: 'Unread peer',
      meta: { inbox_state: 'accepted', accepted_at: new Date().toISOString() },
    });
  }, peer);
  await page.goto(`/chats/${peer}`);
  await expect(page.getByTestId('message-composer-input')).toBeVisible();
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await expect(page.getByTestId('settings-profile-item')).toBeVisible();
  const { nip59 } = await import('nostr-tools');
  const { default: WebSocket } = await import('ws');
  const event = nip59.wrapEvent(
    { kind: 14, tags: [['p', account.pubkey]], content: 'New message while in settings' },
    peerKey,
    account.pubkey,
  );
  const socket = new WebSocket(relay);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('message', (raw) => {
        const response = JSON.parse(String(raw));
        if (response[0] === 'OK' && response[1] === event.id)
          response[2] ? resolve() : reject(new Error('Fixture rejected'));
      });
      socket.send(JSON.stringify(['EVENT', event]));
    });
  } finally {
    socket.close();
  }
  await expect(
    page.getByRole('button', { name: 'chats', exact: true }).locator('.nav-badge'),
  ).toHaveText('1');
  await page.getByRole('button', { name: 'chats', exact: true }).click();
  await expect(
    page.getByTestId('message-bubble').filter({ hasText: 'New message while in settings' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'chats', exact: true }).locator('.nav-badge'),
  ).toHaveCount(0);
});
