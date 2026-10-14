import { test, expect } from '@playwright/test';
import {
  bootstrapUser,
  disposeUsers,
  TEST_ACCOUNTS,
  establishAcceptedDirectChat,
  sendMessage,
  threadMessage,
  createGroup,
  addGroupMemberAndPublish,
  openRequests,
  acceptFirstRequest,
  navigateToChat,
} from '../helpers';

for (const kind of ['DM', 'private group']) {
  test(`${kind} never fetches link previews, including own and media-trusted messages`, async ({
    browser,
  }) => {
    const alice = await bootstrapUser(browser, TEST_ACCOUNTS[`previewAlice-${kind}`]);
    const bob = await bootstrapUser(browser, TEST_ACCOUNTS[`previewBob-${kind}`]);
    const requests: string[] = [];
    try {
      for (const user of [alice, bob]) {
        await user.page.route(
          /^https:\/\/(?:api\.github\.com|github\.com|www\.youtube\.com|youtu\.be|publish\.x\.com|x\.com|preview\.example\.org)\//,
          (route) => {
            requests.push(route.request().url());
            return route.fulfill({
              contentType: 'text/html',
              body: '<title>Must not fetch</title>',
            });
          },
        );
      }
      await establishAcceptedDirectChat(alice, bob);
      await bob.page.evaluate(async (key) => {
        const { useTrustedMediaStore } = await import('/src/stores/trustedMediaStore.svelte.ts');
        useTrustedMediaStore().trustImageSender(key);
      }, alice.session.publicKey);
      if (kind === 'private group') {
        const group = await createGroup(alice.page, { name: 'Private links', about: '' });
        await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
        await openRequests(bob.page, { publicKey: group });
        await acceptFirstRequest(bob.page, { publicKey: group });
        await navigateToChat(alice.page, group);
        await navigateToChat(bob.page, group);
      }
      for (const text of [
        'Private links one https://github.com/lnbits/anagram https://youtu.be/jNQXAC9IVRw',
        'Private links two https://x.com/anagram/status/20 https://preview.example.org/article',
      ]) {
        await sendMessage(alice.page, text);
        for (const user of [alice, bob]) {
          const message = threadMessage(user.page, text);
          await expect(message).toBeVisible();
          await expect(message.getByTestId('message-url-link')).toHaveCount(2);
          await expect(message.locator('.preview-container')).toHaveCount(0);
          await expect(message.getByRole('button', { name: 'Load link preview' })).toHaveCount(0);
        }
      }
      await bob.page.setViewportSize({ width: 390, height: 844 });
      await bob.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(threadMessage(bob.page, 'Private links two')).toBeVisible();
      await expect(bob.page.locator('.preview-container')).toHaveCount(0);
      expect(requests).toEqual([]);
    } finally {
      await disposeUsers(alice, bob);
    }
  });
}

test('preview metadata rejects private targets and never follows redirects', async ({ page }) => {
  await page.goto('/');
  const privateRequests: string[] = [];
  await page.route(
    /^https:\/\/(?:127\.0\.0\.1|10\.0\.0\.1|169\.254\.169\.254)(?::\d+)?\//,
    (route) => {
      privateRequests.push(route.request().url());
      return route.abort();
    },
  );
  await page.route('https://preview.example.org/redirect-*', (route) =>
    route.fulfill({
      status: 302,
      headers: { location: 'https://127.0.0.1/private', 'access-control-allow-origin': '*' },
    }),
  );
  await page.route('https://preview.example.org/private-image', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'access-control-allow-origin': '*' },
      body: '<title>Safe text</title><meta property="og:image" content="https://169.254.169.254/latest/meta-data">',
    }),
  );
  const results = await page.evaluate(async () => {
    const { loadLinkPreview } = await import('/src/services/linkPreviewService.ts');
    return {
      metadataRedirect: await loadLinkPreview('https://preview.example.org/redirect-page'),
      local: await loadLinkPreview('https://127.0.0.1/private'),
      metadata: await loadLinkPreview('https://preview.example.org/private-image'),
    };
  });
  expect(results).toMatchObject({
    metadataRedirect: null,
    local: null,
    metadata: { title: 'Safe text' },
  });
  expect(privateRequests).toEqual([]);
});
