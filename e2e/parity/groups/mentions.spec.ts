import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  acceptFirstRequest,
  bootstrapUser,
  createGroup,
  deleteMessage,
  disposeUsers,
  editMessage,
  expectNoUnexpectedBrowserErrors,
  navigateToChat,
  openRequests,
  selectGroupInviteMembers,
  sendMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  threadMessage,
  waitForThreadMessage,
} from '../helpers';

async function sendMention(page: Page, displayName: string, text: string) {
  await page.getByTestId('message-composer-input').click();
  await page.keyboard.type('@');
  await page.getByTestId('message-mention-option').filter({ hasText: displayName }).first().click();
  await page.keyboard.type(` ${text}`);
  await page.getByTestId('message-send-button').click();
  await waitForThreadMessage(page, text);
}

test('group mentions show an @ indicator until read and follow edits and deletions', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mentionIndicatorAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.mentionIndicatorBob);

  try {
    const stamp = Date.now();
    const plain = `mention-plain-${stamp}`;
    const editedAway = `mention-edited-${stamp}`;
    const deleted = `mention-deleted-${stamp}`;
    const kept = `mention-kept-${stamp}`;
    const groupPublicKey = await createGroup(alice.page, {
      name: `Mentions ${stamp}`,
      about: 'Mention indicators',
    });
    const invite = await selectGroupInviteMembers(alice.page, [bob.session.publicKey]);
    await invite.getByRole('button', { name: 'Invite (1)', exact: true }).click();
    await expect(invite).toBeHidden();
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });

    // Bob reads another chat, so group arrivals are unread while the list stays visible.
    await navigateToChat(bob.page, bob.session.publicKey);
    const groupRow = bob.page.locator(
      `[data-testid="chat-item"][data-chat-public-key="${groupPublicKey}"]`,
    );
    const mentionBadge = groupRow.getByTestId('chat-unread-mention-badge');

    // Nostr timestamps are whole seconds; start after Bob's read boundary second.
    const readSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction(
      (second) => Math.floor(Date.now() / 1000) > second,
      readSecond,
    );
    await navigateToChat(alice.page, groupPublicKey);
    await sendMessage(alice.page, plain);
    await expect(groupRow).toContainText(plain);
    await expect(groupRow.locator('.badge')).toBeVisible();
    await expect(mentionBadge).toHaveCount(0);

    await sendMention(alice.page, bob.account.displayName, editedAway);
    await expect(mentionBadge).toBeVisible();
    await editMessage(alice.page, editedAway, `${editedAway} without mention`);
    await expect(mentionBadge).toHaveCount(0);

    await sendMention(alice.page, bob.account.displayName, deleted);
    await expect(mentionBadge).toBeVisible();
    await deleteMessage(alice.page, deleted);
    await expect(mentionBadge).toHaveCount(0);

    await sendMention(alice.page, bob.account.displayName, kept);
    await expect(mentionBadge).toHaveText('@');
    await expect(groupRow.locator('.badge')).toBeVisible();
    // The sender never sees their own mention highlighted.
    await expect(threadMessage(alice.page, kept)).not.toHaveAttribute('data-mentions-me');

    await navigateToChat(bob.page, groupPublicKey);
    await expect(threadMessage(bob.page, kept)).toHaveAttribute('data-mentions-me', 'true');
    await expect(threadMessage(bob.page, plain)).not.toHaveAttribute('data-mentions-me');
    await expect(
      threadMessage(bob.page, `${editedAway} without mention`),
    ).not.toHaveAttribute('data-mentions-me');

    await navigateToChat(bob.page, bob.session.publicKey);
    await expect(groupRow).toBeVisible();
    await expect(mentionBadge).toHaveCount(0);
    await expect(groupRow.locator('.badge')).toHaveCount(0);

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});

function overlaps(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

async function expectInView(page: Page, message: Locator) {
  const [box, viewport] = await Promise.all([
    message.boundingBox(),
    page.getByTestId('chat-thread').boundingBox(),
  ]);
  expect(
    box && viewport && box.y < viewport.y + viewport.height && box.y + box.height > viewport.y,
  ).toBe(true);
}

test('the mention navigator steps through mentions that were unread when the group opened', async ({
  browser,
}) => {
  test.slow();
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.mentionNavigatorAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.mentionNavigatorBob);

  try {
    const stamp = Date.now();
    const mentions = [1, 2, 3].map((index) => `navigator-mention-${index}-${stamp}`);
    const groupPublicKey = await createGroup(alice.page, {
      name: `Navigator ${stamp}`,
      about: 'Mention navigation',
    });
    const invite = await selectGroupInviteMembers(alice.page, [bob.session.publicKey]);
    await invite.getByRole('button', { name: 'Invite (1)', exact: true }).click();
    await expect(invite).toBeHidden();
    await openRequests(bob.page, { publicKey: groupPublicKey });
    await acceptFirstRequest(bob.page, { publicKey: groupPublicKey });
    await navigateToChat(bob.page, bob.session.publicKey);

    const readSecond = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction(
      (second) => Math.floor(Date.now() / 1000) > second,
      readSecond,
    );
    await navigateToChat(alice.page, groupPublicKey);
    // Filler between mentions makes each jump scroll the thread.
    for (const [round, mention] of mentions.entries()) {
      await sendMention(alice.page, bob.account.displayName, mention);
      await sendMessagesViaBridge(
        alice.page,
        groupPublicKey,
        Array.from({ length: 12 }, (_, index) => `filler-${round}-${index}-${stamp}`),
      );
    }
    const groupRow = bob.page.locator(
      `[data-testid="chat-item"][data-chat-public-key="${groupPublicKey}"]`,
    );
    await expect(groupRow.getByTestId('chat-unread-mention-badge')).toBeVisible();
    await expect(groupRow).toContainText(`filler-2-11-${stamp}`);

    await navigateToChat(bob.page, groupPublicKey);
    const navigator = bob.page.getByTestId('mention-navigator');
    const position = navigator.getByTestId('mention-navigator-position');
    const previous = navigator.getByTestId('mention-navigator-previous');
    const next = navigator.getByTestId('mention-navigator-next');
    // Opening the group marks it read, but the navigator keeps the mentions it had.
    await expect(position).toHaveText('@ 3');
    await expect(previous).toBeDisabled();

    await next.click();
    await expect(position).toHaveText('@ 1/3');
    const first = threadMessage(bob.page, mentions[0]);
    await expect(first).toHaveClass(/highlighted/);
    await expectInView(bob.page, first);
    // The navigation outline fades; the mention highlight stays.
    await expect(first).not.toHaveClass(/highlighted/, { timeout: 4000 });
    await expect(first).toHaveAttribute('data-mentions-me', 'true');

    // The navigator sits clear of jump-to-latest and the composer.
    const jumpLatest = bob.page.getByRole('button', { name: 'Jump to latest messages' });
    await expect(jumpLatest).toBeVisible();
    const [navigatorBox, jumpBox, composerBox] = await Promise.all([
      navigator.boundingBox(),
      jumpLatest.boundingBox(),
      bob.page.getByTestId('message-composer-input').boundingBox(),
    ]);
    expect(overlaps(navigatorBox!, jumpBox!)).toBe(false);
    expect(overlaps(navigatorBox!, composerBox!)).toBe(false);

    // Keyboard: the controls are ordinary buttons.
    await next.focus();
    await bob.page.keyboard.press('Enter');
    await expect(position).toHaveText('@ 2/3');
    await expectInView(bob.page, threadMessage(bob.page, mentions[1]));
    await bob.page.keyboard.press('Space');
    await expect(position).toHaveText('@ 3/3');
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(position).toHaveText('@ 2/3');
    await expectInView(bob.page, threadMessage(bob.page, mentions[1]));

    await navigator.getByTestId('mention-navigator-dismiss').click();
    await expect(navigator).toHaveCount(0);
    await navigateToChat(bob.page, bob.session.publicKey);
    await expect(groupRow.getByTestId('chat-unread-mention-badge')).toHaveCount(0);
    await navigateToChat(bob.page, groupPublicKey);
    await expect(threadMessage(bob.page, mentions[0])).toHaveAttribute('data-mentions-me', 'true');
    await expect(navigator).toHaveCount(0);

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
