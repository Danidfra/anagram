import { expect, test } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  navigateToChat,
  reloadAndWaitForApp,
  sendMessage,
  setAppVisibility,
  TEST_ACCOUNTS,
  waitForChatUnreadCount,
  waitForNoChatUnreadBadge,
} from '../helpers';

test('desktop app badge follows incoming unread messages, reading and logout', async ({
  browser,
}) => {
  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.badgeAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.badgeBob);
  try {
    await bob.page.addInitScript(() => {
      const calls: number[] = [];
      Object.assign(window, { badgeCalls: calls });
      Object.defineProperties(navigator, {
        setAppBadge: {
          configurable: true,
          value: async (count: number) => {
            calls.push(count);
          },
        },
        clearAppBadge: {
          configurable: true,
          value: async () => {
            calls.push(0);
          },
        },
      });
    });
    await reloadAndWaitForApp(bob.page);
    await establishAcceptedDirectChat(alice, bob);
    await navigateToChat(bob.page, alice.session.publicKey);
    const lastBadge = () =>
      bob.page.evaluate(() => (window as unknown as { badgeCalls: number[] }).badgeCalls.at(-1));
    await expect.poll(lastBadge).toBe(0);
    await setAppVisibility(bob.page, { visibilityState: 'hidden', hasFocus: false });
    const second = Math.floor(Date.now() / 1000);
    await alice.page.waitForFunction((second) => Math.floor(Date.now() / 1000) > second, second);
    await sendMessage(alice.page, 'Badge message one');
    await sendMessage(alice.page, 'Badge message two');
    await waitForChatUnreadCount(bob.page, 2, alice.account.displayName);
    await expect.poll(lastBadge).toBe(2);
    await setAppVisibility(bob.page, { visibilityState: 'visible', hasFocus: true });
    await waitForNoChatUnreadBadge(bob.page);
    await expect.poll(lastBadge).toBe(0);
    // Restored unread state should reach the OS too, and logout must clear it.
    await bob.page.evaluate(async (key) => {
      const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
      await useChatStore().setUnreadCount(key, 4);
    }, alice.session.publicKey);
    await expect.poll(lastBadge).toBe(4);
    await bob.page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      useNostrStore().stopAppLifecycleRuntime();
      await useNostrStore().logout();
    });
    await bob.page.goto('/');
    await expect(bob.page.getByTestId('auth-open-key-button')).toBeVisible();
    await expect.poll(lastBadge).toBe(0);
  } finally {
    await disposeUsers(alice, bob);
  }
});
