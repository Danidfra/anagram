import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import {
  bootstrapUser,
  TEST_ACCOUNTS,
  openDirectChatFromIdentifier,
  navigateToChat,
  confirmGroupBackup,
  disposeUsers,
} from './parity/helpers.ts';
// The example is the interoperability fixture: real signed events and encrypted callbacks.
import { PollBot } from '../bot-example/poll/bot.js';
import { Network, State, sign } from '../bot-example/poll/vendor/runtime.js';
import { relay } from '../bot-example/poll/test/relay.js';
import { COMMAND_TAG, keyboardTag } from '../bot-example/poll/vendor/botKeyboardProtocol.ts';

test('poll keyboards work privately in DMs, private groups and public groups, including reload and mobile', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const local = await relay();
  const dir = mkdtempSync(join(tmpdir(), 'anagram-poll-browser-'));
  const store = new State(dir);
  const bot = new PollBot({ store, net: new Network([local.url]), cooldown: 0, log() {} });
  let user;
  try {
    await bot.start();
    await bot.net.publish(
      sign(bot.key, 0, [], JSON.stringify({ name: bot.name, bot: true })),
      [local.url],
      bot.key,
    );
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botOwner, { relayUrls: [local.url] });
    const page = user.page;
    const npub = nip19.npubEncode(bot.pubkey);
    async function voteAndReload(rowId: string, question: string) {
      const rows = page.getByTestId(rowId);
      const keyboard = page.getByTestId('bot-keyboard');
      await expect(keyboard).toBeVisible();
      await expect(keyboard.getByRole('button', { name: 'Tea', exact: true })).toBeVisible();
      const command = rows.filter({ hasText: `${question}\nTea\nCoffee` });
      await expect(command).toHaveCount(0);
      const card = rows.filter({ has: keyboard });
      await card.locator('.message-content').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Show original command', exact: true }).click();
      await expect(command).toBeVisible();
      await card.locator('.message-content').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Hide original command', exact: true }).click();
      await expect(command).toHaveCount(0);
      const before = await rows.count();
      await keyboard.getByRole('button', { name: 'View results', exact: true }).click();
      await expect(keyboard.getByTestId('bot-personal-response')).toHaveText(
        `${question}\nTea: 0\nCoffee: 0\n0 vote(s)`,
      );
      await keyboard.getByRole('button', { name: 'Tea', exact: true }).click();
      const personal = keyboard.getByTestId('bot-personal-response');
      await expect(personal).toHaveText(`${question}\nTea: 1\nCoffee: 0\n1 vote(s)`);
      await expect(personal.locator('strong').first()).toHaveText(question);
      await expect(personal.locator('em')).toHaveText('1 vote(s)');
      await expect(keyboard).toHaveText(`${question}\nTea: 1\nCoffee: 0\n1 vote(s)`);
      await expect(keyboard.getByRole('button')).toHaveCount(0);
      await expect(rows).toHaveCount(before);
      await expect(keyboard.getByRole('status')).toBeHidden();
      await page.reload();
      await expect(keyboard).toHaveText(`${question}\nTea: 1\nCoffee: 0\n1 vote(s)`);
      await expect(keyboard.getByRole('button')).toHaveCount(0);
      await expect(rows).toHaveCount(before);
      await expect(command).toHaveCount(0);
      await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
      await page.getByRole('textbox', { name: 'Search messages', exact: true }).fill('Coffee');
      await expect(command).toBeVisible();
      await expect(command).toBeInViewport();
      await page.getByRole('button', { name: 'Close search', exact: true }).click();
      await card.locator('.message-content').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Hide original command', exact: true }).click();
      await expect(command).toHaveCount(0);
    }
    await openDirectChatFromIdentifier(page, npub, bot.name);
    await navigateToChat(page, bot.pubkey);
    async function expectFormat(composerName: string) {
      await page.getByRole('textbox', { name: composerName, exact: true }).fill(`nostr:${npub}`);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const help = page
        .locator('[data-testid="message-bubble"], [data-testid="public-message"]')
        .filter({ hasText: 'Bot expects format:' });
      await expect(help).toBeVisible();
      await expect(help.locator('strong')).toHaveText('Bot expects format:');
      await expect(help).toContainText(`@${bot.handle} What should we watch?`);
      await expect(help).toContainText('The Wire');
      await expect(help).toContainText('The Sopranos');
      await expect(page.getByTestId('bot-keyboard')).toHaveCount(0);
    }
    await expectFormat('Message');
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Direct drinks?\nTea\nCoffee');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await voteAndReload('message-bubble', 'Direct drinks?');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New private group', exact: true }).click();
    await page.getByRole('button', { name: 'Generate new group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Private polls');
    await page.getByLabel('Members', { exact: true }).fill(npub);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await confirmGroupBackup(page);
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => Object.keys(store.data.groups).length).toBe(1);
    await expectFormat('Message');
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`@${bot.handle} Private drinks?\nTea\nCoffee`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await voteAndReload('message-bubble', 'Private drinks?');

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('button', { name: 'New public group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Public polls');
    await page.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(page).toHaveURL(/\/public\/naddr/);
    await page.getByRole('button', { name: 'Public group settings' }).click();
    await page.getByRole('tab', { name: 'Trusted', exact: true }).click();
    await page.getByRole('button', { name: 'Add trusted users', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trusted users' });
    await picker.getByLabel('Search people').fill(npub);
    await picker
      .locator('[data-testid="profile-search-result"], [data-testid="invite-contact-result"]')
      .click();
    await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Public group settings' })).toBeHidden();
    await expect.poll(() => Object.keys(store.data.rooms).length).toBe(1);
    await expectFormat('Public message');
    await page
      .getByRole('textbox', { name: 'Public message', exact: true })
      .fill(`@${bot.handle} Public drinks?\nTea\nCoffee`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await voteAndReload('public-message', 'Public drinks?');
    const unrelatedText = 'This ordinary conversation must stay visible.';
    await page.getByRole('textbox', { name: 'Public message', exact: true }).fill(unrelatedText);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() =>
        [...local.events.values()].some((e) => e.kind === 9 && e.content === unrelatedText),
      )
      .toBe(true);
    const unrelated = [...local.events.values()].find(
      (e) => e.kind === 9 && e.content === unrelatedText,
    )!;
    const hostile = sign(
      bot.key,
      9,
      [
        ['a', unrelated.tags.find((t) => t[0] === 'a')![1]],
        [COMMAND_TAG, '1', unrelated.id],
        keyboardTag({ inline_keyboard: [[{ text: 'Bogus button', callback_data: 'bogus' }]] }),
      ],
      'A malicious bot claims it handled this message',
    );
    await bot.net.publish(hostile, [local.url], bot.key);
    const hostileRow = page.getByTestId('public-message').filter({ hasText: hostile.content });
    await expect(hostileRow).toBeVisible();
    await expect(
      page.getByTestId('public-message').filter({ hasText: unrelatedText }),
    ).toBeVisible();
    await hostileRow.locator('.message-content').click({ button: 'right' });
    await expect(
      page.getByRole('menuitem', { name: 'Show original command', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a public keyboard discovers a separate bot inbox without creating a DM contact', async ({
  browser,
}) => {
  const roomRelay = await relay(),
    inboxRelay = await relay();
  const inboxNetwork = new Network([inboxRelay.url]);
  const dir = mkdtempSync(join(tmpdir(), 'anagram-poll-routing-'));
  const bot = new PollBot({
    store: new State(dir),
    net: new Network([roomRelay.url, inboxRelay.url]),
    cooldown: 0,
    log() {},
  });
  let user;
  try {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools');
    const { acceptRoom, publicMessage } =
      await import('../bot-example/poll/vendor/public-groups.js');
    const owner = generateSecretKey(),
      address = `34550:${getPublicKey(owner)}:routing`;
    const room = sign(owner, 34550, [
      ['d', 'routing'],
      ['name', 'Routing poll'],
      ['anagram-room', '1'],
      ['relay', roomRelay.url],
      ['trusted', bot.pubkey],
    ]);
    roomRelay.emit(room);
    roomRelay.emit(sign(bot.key, 10050, [['relay', inboxRelay.url]]));
    await bot.start();
    // Only the separate inbox receives personal callback requests.
    bot.watches.get('inbox')?.();
    bot.watches.set(
      'inbox',
      inboxNetwork.watch(
        [inboxRelay.url],
        () => ({ kinds: [1059], '#p': [bot.pubkey], limit: 1000 }),
        (event) => bot.receive(event, bot.key),
        bot.key,
      ),
    );
    acceptRoom(bot, room, true);
    publicMessage(
      bot,
      sign(
        owner,
        9,
        [
          ['a', address],
          ['p', bot.pubkey],
        ],
        '/poll Route choice? | Tea | Coffee',
      ),
      address,
    );
    await bot.flush();
    user = await bootstrapUser(browser, TEST_ACCOUNTS.botVoter, { relayUrls: [roomRelay.url] });
    const page = user.page;
    const link = nip19.naddrEncode({
      kind: 34550,
      pubkey: getPublicKey(owner),
      identifier: 'routing',
      relays: [roomRelay.url],
    });
    await page.goto(`/public/${link}`);
    const keyboard = page.getByTestId('bot-keyboard');
    await expect(keyboard).toBeVisible();
    const contactExists = () =>
      page.evaluate(async (pubkey) => {
        const { contactsService } = await import('/src/services/contactsService.ts');
        return !!(await contactsService.getContactByPublicKey(pubkey));
      }, bot.pubkey);
    expect(await contactExists()).toBe(false);
    await keyboard.getByRole('button', { name: 'Tea', exact: true }).click();
    await expect
      .poll(
        () =>
          [...inboxRelay.events.values()].filter(
            (event) =>
              event.kind === 1059 &&
              event.tags.some((tag) => tag[0] === 'p' && tag[1] === bot.pubkey),
          ).length,
        { message: 'callback reaches the advertised bot inbox' },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() => Object.keys(bot.state.callbacks).length, {
        message: 'bot authenticates and processes the callback',
      })
      .toBe(1);
    await expect(keyboard.getByTestId('bot-personal-response')).toContainText('Tea: 1');
    expect(await contactExists()).toBe(false);
    expect(user.browserErrors).toEqual([]);
  } finally {
    if (user) await disposeUsers(user);
    await bot.close();
    inboxNetwork.close();
    await roomRelay.close();
    await inboxRelay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
