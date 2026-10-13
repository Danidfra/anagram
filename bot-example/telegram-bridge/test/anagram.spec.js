import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import { bootstrapUser, TEST_ACCOUNTS, disposeUsers } from '../../../e2e/parity/helpers.ts';
import { TelegramBridge } from '../bridge.js';
import { Network, State, now } from '../runtime.js';
import { FakeTelegram, chat } from './telegram-fixture.js';
import { relay } from './relay.js';

test('trusted Telegram Bridge shows incoming messages and sends an Anagram UI reply to the original Telegram message', async ({
  browser,
}) => {
  const local = await relay();
  const dir = mkdtempSync(join(tmpdir(), 'telegram-bridge-browser-'));
  const store = new State(dir);
  const telegram = new FakeTelegram();
  let user, bot;
  try {
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Telegram bridge test');
    await page.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(page).toHaveURL(/\/public\/naddr/);
    bot = new TelegramBridge({
      store,
      net: new Network([local.url]),
      telegram,
      publicGroup: page.url(),
      telegramChat: '@public_test',
      log() {},
    });
    await bot.start();
    expect(bot.active).toBe(false);
    await page.getByRole('button', { name: 'Public group settings' }).click();
    await page.getByRole('tab', { name: 'Trusted', exact: true }).click();
    await page.getByRole('button', { name: 'Add trusted users', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trusted users' });
    await picker.getByLabel('Search people').fill(nip19.npubEncode(bot.pubkey));
    await picker
      .locator('[data-testid="profile-search-result"], [data-testid="invite-contact-result"]')
      .click();
    await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect.poll(() => bot.active).toBe(true);
    telegram.updates = [
      {
        update_id: 1,
        message: {
          message_id: 42,
          date: now(),
          chat,
          from: { id: 456, first_name: 'Alice' },
          text: 'Hello from Telegram',
        },
      },
    ];
    await bot.poll();
    await bot.submit('flush', () => bot.flush());
    const incoming = page.getByTestId('public-message').filter({ hasText: 'Hello from Telegram' });
    await expect(incoming).toBeVisible();
    await expect(incoming.locator('.message-text')).toHaveText(
      'Alice said:\n"Hello from Telegram"',
    );
    await page.getByLabel('Public message', { exact: true }).fill('Ordinary Anagram message');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await incoming.hover();
    await incoming.locator('.message-content').click({ position: { x: 5, y: 5 } });
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    await page.getByLabel('Public message', { exact: true }).fill('Hello back from Anagram');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => store.data.outbox.filter((item) => item.direction === 'telegram').length)
      .toBe(1);
    await bot.submit('flush', () => bot.flush());
    const sends = telegram.calls.filter((call) => call.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0].body.reply_parameters).toEqual({
      message_id: 42,
      allow_sending_without_reply: false,
    });
    expect(sends[0].body.text).toContain('replied:\n&quot;Hello back from Anagram"');
    expect(sends[0].body.text).toContain(
      `Join the group at <a href="${bot.link}">anagram.chat</a>`,
    );
    await page.reload();
    await expect(
      page
        .getByTestId('public-message')
        .filter({ hasText: 'Hello back from Anagram' })
        .locator('.reply-preview'),
    ).toContainText('Hello from Telegram');
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    if (bot) await bot.close();
    else store.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
