import { expect, test, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { bootstrapUser, TEST_ACCOUNTS, navigateInApp } from './parity/helpers';

test('position tracking stays bounded and retains fallback anchors', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { threadPosition } = await import('/src/lib/actions/threadPosition.ts');
    const node = document.createElement('div');
    node.style.cssText =
      'position:fixed;inset:0;z-index:99999;height:600px;overflow:auto;overflow-anchor:none;background:white';
    document.body.append(node);
    let reads = 0;
    for (let index = 0; index < 300; index++) {
      const row = document.createElement('div');
      row.className = 'message-row';
      row.id = `position-fixture-${index}`;
      row.style.height = `${60 + (index % 3) * 20}px`;
      const measure = row.getBoundingClientRect.bind(row);
      row.getBoundingClientRect = () => {
        reads++;
        return measure();
      };
      node.append(row);
    }
    const settle = async () => {
      for (let frame = 0; frame < 3; frame++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const offset = (row: Element) =>
      row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    const action = threadPosition(node, { chatId: 'fixture', onchange: () => {} });
    try {
      await settle();
      node.scrollTop = 12000;
      await settle();
      const visible = [...node.children].find(
        (row) => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 38,
      )!;
      const saved = offset(visible);
      reads = 0;
      (node.firstElementChild as HTMLElement).style.height = '300px';
      await settle();
      const resizeReads = reads;
      const resizeDrift = Math.abs(offset(visible) - saved);

      reads = 0;
      for (let update = 0; update < 20; update++)
        action.update({ chatId: 'fixture', onchange: () => {} });
      const unchangedReads = reads;

      // If the primary anchor disappears, the next message keeps its position.
      const neighbour = visible.nextElementSibling!;
      const neighbourOffset = offset(neighbour);
      visible.remove();
      await settle();
      const deletionDrift = Math.abs(offset(neighbour) - neighbourOffset);

      // Paging may evict all nearby anchors. A surviving boundary still anchors
      // the viewport, provided the replacement window has enough scroll range.
      const boundary = node.lastElementChild!;
      const boundaryOffset = offset(boundary);
      const replacement = document.createElement('div');
      replacement.style.height = '24000px';
      node.replaceChildren(replacement, boundary);
      await settle();
      const evictionDrift = Math.abs(offset(boundary) - boundaryOffset);
      reads = 0;
      await settle();
      return {
        resizeReads,
        unchangedReads,
        resizeDrift,
        deletionDrift,
        evictionDrift,
        idleReads: reads,
      };
    } finally {
      action.destroy();
      node.remove();
    }
  });
  expect(result.resizeReads).toBeLessThan(80);
  expect(result.unchangedReads).toBe(0);
  expect(result.idleReads).toBe(0);
  expect(result.resizeDrift).toBeLessThan(2);
  expect(result.deletionDrift).toBeLessThan(2);
  expect(result.evictionDrift).toBeLessThan(2);
});

async function anchor(page: Page) {
  return page.getByTestId('chat-thread').evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>('.message-row')].find(
      (row) => row.getBoundingClientRect().bottom > top + 38,
    )!;
    return { id: row.id, offset: row.getBoundingClientRect().top - top };
  });
}
async function expectAnchor(page: Page, saved: { id: string; offset: number }) {
  await expect
    .poll(() =>
      page.evaluate(({ id, offset }) => {
        const row = document.getElementById(id);
        const log = document.querySelector('[data-testid="chat-thread"]');
        if (!row || !log) return Infinity;
        return Math.abs(row.getBoundingClientRect().top - log.getBoundingClientRect().top - offset);
      }, saved),
    )
    .toBeLessThan(2);
}

for (const width of [1280, 390])
  for (const kind of ['private', 'public'] as const) {
    test(`${kind} hydration preserves the reading position while typing and scrolling at ${width}px`, async ({
      browser,
    }) => {
      const user = await bootstrapUser(browser, TEST_ACCOUNTS[`anchor-${kind}`]);
      const { page } = user;
      await page.setViewportSize({ width, height: 844 });
      const peer = getPublicKey(generateSecretKey());
      const start = Math.floor(Date.now() / 1000) - 10000;
      let inject: (index: number, content: string) => Promise<void>;
      try {
        if (kind === 'private') {
          await page.evaluate(
            async ({ peer, start }) => {
              const { chatDataService } = await import('/src/services/chatDataService.ts');
              await chatDataService.createChat({
                public_key: peer,
                name: 'Anchor chat',
                meta: { inbox_state: 'accepted' },
              });
              for (let index = 0; index < 45; index++)
                await chatDataService.createMessage({
                  chat_public_key: peer,
                  author_public_key: peer,
                  message: `Anchor row ${index}`,
                  event_id: index.toString(16).padStart(64, '0'),
                  created_at: new Date((start + index * 10) * 1000).toISOString(),
                  meta: {},
                });
            },
            { peer, start },
          );
          await navigateInApp(page, `/chats/${peer}`);
          inject = (index, content) =>
            page.evaluate(
              async ({ peer, start, index, content }) => {
                const { chatDataService } = await import('/src/services/chatDataService.ts');
                const { useMessageStore } = await import('/src/stores/messageStore.ts');
                const eventId = index.toString(16).padStart(64, '0');
                let row = await chatDataService.getMessageByEventId(eventId);
                if (row) {
                  // A late reply preview changes the height of an already-rendered row.
                  row = await chatDataService.updateMessageMeta(row.id, {
                    reply: {
                      eventId: 'f'.repeat(64),
                      text: content,
                      authorName: 'Restored author',
                    },
                  });
                } else
                  row = await chatDataService.createMessage({
                    chat_public_key: peer,
                    author_public_key: peer,
                    message: content,
                    event_id: eventId,
                    created_at: new Date((start + index * 10) * 1000).toISOString(),
                    meta: {},
                  });
                if (row) await useMessageStore().upsertPersistedMessage(row);
              },
              { peer, start, index, content },
            );
        } else {
          await page.getByRole('button', { name: 'Chat options' }).click();
          await page.getByRole('button', { name: 'New public group', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'New public group' });
          await dialog.getByLabel('Group name', { exact: true }).fill('Anchor public group');
          await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
          await expect(page.getByLabel('Public message', { exact: true })).toBeVisible();
          const address = await page.evaluate(async () => {
            const { useNostrStore } = await import('/src/stores/nostrStore.ts');
            return new Promise<string>((resolve) => {
              const off = useNostrStore().publicGroups.state.subscribe((state) =>
                resolve(state.room!.address),
              );
              off();
            });
          });
          const key = generateSecretKey();
          const events = Array.from({ length: 45 }, (_, index) =>
            finalizeEvent(
              {
                kind: 9,
                created_at: start + index * 10,
                tags: [['a', address]],
                content: `Anchor row ${index}`,
              },
              key,
            ),
          );
          await page.evaluate(async (events) => {
            const { useNostrStore } = await import('/src/stores/nostrStore.ts');
            useNostrStore().publicGroups.state.update((state) => ({
              ...state,
              messages: events,
              loading: false,
              refreshing: false,
            }));
          }, events);
          inject = async (index, content) => {
            const event = finalizeEvent(
              { kind: 9, created_at: start + index * 10, tags: [['a', address]], content },
              key,
            );
            await page.evaluate(
              async ({ event, oldId }) => {
                const { useNostrStore } = await import('/src/stores/nostrStore.ts');
                useNostrStore().publicGroups.state.update((state) => ({
                  ...state,
                  messages: [...state.messages.filter((message) => message.id !== oldId), event],
                }));
              },
              { event, oldId: events[index]?.id },
            );
          };
        }
        const thread = page.getByTestId('chat-thread');
        await expect(thread.locator('.message-row')).toHaveCount(45);
        await expect
          .poll(() =>
            thread.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThan(2);
        const input = page.getByTestId('message-composer-input');
        await input.fill('Keep my draft');
        let saved = await anchor(page);
        await inject(5, 'A delayed reply or body '.repeat(60));
        await expect(thread).toContainText('A delayed reply or body');
        await expectAnchor(page, saved);
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('Keep my draft');
        // A later message must not pull a reader down, including while at the old bottom.
        await inject(90, 'A later restored message');
        await expect(thread).toContainText('A later restored message');
        await expectAnchor(page, saved);
        await expect(page.getByRole('button', { name: 'Jump to latest messages' })).toBeVisible();

        await thread.hover();
        await page.mouse.wheel(0, -450);
        await expect.poll(async () => (await anchor(page)).id).not.toBe(saved.id);
        saved = await anchor(page);
        await input.focus();
        await input.press('Shift+Enter');
        await input.pressSequentially('More typing');
        await expect(input).toHaveValue('Keep my draft\nMore typing');
        await inject(6, 'Another late hydration '.repeat(60));
        await expect(thread).toContainText('Another late hydration');
        await expectAnchor(page, saved);
        await expect(input).toBeFocused();

        // Asynchronous media growth uses resize observation, not just message-count changes.
        await thread.evaluate((node) => {
          const media = document.createElement('div');
          media.dataset.testMedia = 'true';
          node.querySelector('.message-row')!.append(media);
        });
        await thread.locator('[data-test-media]').evaluate((node) => {
          node.style.height = '240px';
        });
        await expectAnchor(page, saved);
        // A delayed send completion must not override subsequent user navigation.
        await page.evaluate(async (kind) => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          (window as any).__releasePositionSend = release;
          if (kind === 'private') {
            const { useMessageStore } = await import('/src/stores/messageStore.ts');
            const store = useMessageStore();
            const original = store.sendMessage;
            store.sendMessage = async (chatId) => {
              await gate;
              store.sendMessage = original;
              return store.getMessages(chatId).at(-1) ?? null;
            };
          } else {
            const { useNostrStore } = await import('/src/stores/nostrStore.ts');
            const runtime = useNostrStore().publicGroups;
            const original = runtime.send;
            runtime.send = async () => {
              await gate;
              runtime.send = original;
            };
          }
        }, kind);
        await page.getByTestId('message-send-button').click();
        // Sending navigates immediately, even while relay publication is held.
        await expect
          .poll(() =>
            thread.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThan(2);
        saved = await anchor(page);
        const beforeSendScroll = await thread.evaluate((node) => node.scrollTop);
        await thread.hover();
        await page.mouse.wheel(0, -220);
        // A tall message can remain the visible anchor after an actual scroll.
        await expect
          .poll(() => thread.evaluate((node) => node.scrollTop))
          .toBeLessThan(beforeSendScroll);
        saved = await anchor(page);
        await page.evaluate(() => (window as any).__releasePositionSend());
        await expect(page.getByTestId('message-composer-input')).toHaveValue('');
        await expectAnchor(page, saved);
        await page.getByRole('button', { name: 'Jump to latest messages' }).click();
        await expect
          .poll(() =>
            thread.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
          )
          .toBeLessThan(2);
        expect(user.browserErrors).toEqual([]);
      } finally {
        await user.context.close();
      }
    });
  }
