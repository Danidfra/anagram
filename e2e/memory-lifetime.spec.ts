import { test, expect } from '@playwright/test';
import { monitorResources } from './resource-usage';
import { generateSecretKey, getPublicKey, nip59 } from 'nostr-tools';
import {
  bootstrapUser,
  disposeUsers,
  navigateInApp,
  navigateToChat,
  pauseRelayService,
  unpauseRelayService,
  TEST_ACCOUNTS,
} from './parity/helpers';

// Playwright tracing itself retains DOM snapshots; exclude it from heap measurements.
test.use({ trace: 'off' });

test('message rendering, profile discovery and repeated navigation settle after collection', async ({
  browser,
}, info) => {
  test.slow();
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.memoryLifetime);
  const { page } = user;
  const peer = 'a'.repeat(64);
  const cdp = await user.context.newCDPSession(page);
  const resources = await monitorResources(page);
  const resourceSamples: Array<Awaited<ReturnType<typeof resources.sample>>> = [];
  const samples: Array<{ heap: number; nodes: number; listeners: number; messages: number }> = [];
  async function sample() {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    return {
      heap: usedSize,
      nodes: dom.nodes,
      listeners: dom.jsEventListeners,
      messages: await page.getByTestId('message-bubble').count(),
    };
  }
  function expectSettled(baseline: (typeof samples)[number], last: (typeof samples)[number]) {
    expect(last.messages).toBeLessThanOrEqual(300);
    expect(last.nodes).toBeLessThanOrEqual(baseline.nodes + 200);
    expect(last.listeners).toBeLessThanOrEqual(baseline.listeners + 20);
    expect(last.heap).toBeLessThan(baseline.heap + 6 * 1024 * 1024);
  }
  try {
    await page.evaluate(async (peer) => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
      await chatDataService.createChat({
        public_key: peer,
        name: 'Memory exercise',
        meta: { inbox_state: 'accepted' },
      });
      await useChatStore().reload();
    }, peer);
    for (let round = 0; round < 8; round++) {
      await navigateToChat(page, peer);
      await page.evaluate(
        async ({ peer, round }) => {
          const { chatDataService } = await import('/src/services/chatDataService.ts');
          const { useMessageStore } = await import('/src/stores/messageStore.svelte.ts');
          const { rememberPublicProfile } = await import('/src/lib/state/publicProfiles.ts');
          const store = useMessageStore();
          for (let n = 0; n < 320; n++) {
            const row = await chatDataService.createMessage({
              chat_public_key: peer,
              author_public_key: peer,
              message: `Memory message ${round * 320 + n}`,
              created_at: new Date(1700000000000 + (round * 320 + n) * 1000).toISOString(),
              meta: {},
            });
            if (row) await store.upsertPersistedMessage(row);
          }
          for (let n = 0; n < 6000; n++)
            rememberPublicProfile(
              (1 + round * 6000 + n).toString(16).padStart(64, '0'),
              { name: `Public profile ${round}-${n}` },
              1,
            );
        },
        { peer, round },
      );
      await expect(page.getByTestId('message-bubble').last()).toContainText(
        `Memory message ${round * 320 + 319}`,
      );
      expect(await page.getByTestId('message-bubble').count()).toBeLessThanOrEqual(300);
      // Repeated mounting must release the prior UI's observers/listeners.
      await navigateInApp(page, '/settings/profile');
      await expect(page.getByTestId('chat-thread')).toHaveCount(0);
      await page.waitForTimeout(500); // Let the 16ms UI coalescers and observers settle.
      samples.push(await sample());
      resourceSamples.push(await resources.sample(`hydrate and navigate ${round + 1}`));
    }
    // Compare after warm-up; disk history keeps growing while live state stays bounded.
    expectSettled(samples[2], samples.at(-1)!);
    // Leave an actual conversation open across background watchdog/recheck ticks.
    await navigateToChat(page, peer);
    await page.waitForTimeout(1500);
    const idleBaseline = await sample();
    samples.push(idleBaseline);
    await resources.sample('warm-up');
    for (let tick = 0; tick < 2; tick++) {
      await page.waitForTimeout(20000);
      const usage = await resources.sample(`chat idle ${tick + 1}`);
      resourceSamples.push(usage);
      expect(usage.mainThreadCpuPercent).toBeLessThan(5);
      expect(usage.browserCpuPercent).toBeLessThan(10);
      const idle = await sample();
      samples.push(idle);
      expectSettled(idleBaseline, idle);
    }
    for (const usage of resourceSamples) {
      expect(usage.longestTask, usage.name).toBeLessThan(500);
      expect(usage.longestDelay, usage.name).toBeLessThan(1000);
    }
  } finally {
    console.log('Memory samples:', JSON.stringify(samples));
    console.log('Resource samples:', JSON.stringify(resourceSamples));
    await info.attach('resource-samples', {
      body: JSON.stringify(resourceSamples, null, 2),
      contentType: 'application/json',
    });
    await info.attach('memory-samples', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    await resources.stop();
    await cdp.detach();
    await disposeUsers(user);
  }
});

test('navigation and relay recovery return to low idle CPU', async ({ browser }, info) => {
  test.slow();
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.resourceNavigation);
  const { page } = user;
  const resources = await monitorResources(page);
  const samples: Array<Awaited<ReturnType<typeof resources.sample>>> = [];
  try {
    const routes = [
      '/contacts',
      '/settings/profile',
      '/settings/relays',
      '/settings/notifications',
      '/settings/media-data-storage',
      '/settings/theme',
      '/settings/language',
      '/chats',
    ];
    // Warm up lazy modules separately from repeated mounting and teardown.
    for (const route of routes) await navigateInApp(page, route);
    await page.waitForTimeout(1000);
    await resources.sample('warm-up');
    for (let round = 0; round < 3; round++) {
      for (const route of routes) {
        const start = Date.now();
        await navigateInApp(page, route);
        await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
        expect(Date.now() - start, route).toBeLessThan(2000);
      }
      samples.push(await resources.sample(`navigation ${round + 1}`));
    }
    for (const offline of [true, false]) {
      // Disconnect the actual relay. Chromium's emulated-offline network timer
      // can itself spin in the browser process and contaminate CPU measurements.
      if (offline) await pauseRelayService('relay');
      else await unpauseRelayService('relay');
      await page.waitForTimeout(3000);
      await resources.sample('connection change');
      await page.waitForTimeout(20000);
      const usage = await resources.sample(
        offline ? 'disconnected relay idle' : 'reconnected idle',
      );
      samples.push(usage);
      expect(usage.mainThreadCpuPercent, usage.name).toBeLessThan(5);
      expect(usage.browserCpuPercent, usage.name).toBeLessThan(10);
    }
    for (const usage of samples) {
      expect(usage.longestTask, usage.name).toBeLessThan(500);
      expect(usage.longestDelay, usage.name).toBeLessThan(1000);
    }
    expect(user.browserErrors).toEqual([]);
  } finally {
    await unpauseRelayService('relay');
    console.log('Navigation resource samples:', JSON.stringify(samples));
    await info.attach('navigation-resource-samples', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    await resources.stop();
    await disposeUsers(user);
  }
});

test('large history paging and encrypted arrivals stay responsive while composing', async ({
  browser,
}, info) => {
  test.slow();
  const user = await bootstrapUser(browser, TEST_ACCOUNTS.resourceHistory);
  const { page } = user;
  const secret = generateSecretKey(),
    peer = getPublicKey(secret);
  const wrapped = Array.from({ length: 128 }, (_, index) =>
    nip59.wrapEvent(
      {
        kind: 14,
        created_at: Math.floor(Date.now() / 1000) + index,
        tags: [['p', user.session.publicKey]],
        content: `Resource burst ${index}`,
      },
      secret,
      user.session.publicKey,
    ),
  );
  let resources: Awaited<ReturnType<typeof monitorResources>> | undefined;
  const samples: Array<
    Awaited<ReturnType<Awaited<ReturnType<typeof monitorResources>>['sample']>>
  > = [];
  try {
    await page.evaluate(async (peer) => {
      const { chatDataService } = await import('/src/services/chatDataService.ts');
      const { useChatStore } = await import('/src/stores/chatStore.svelte.ts');
      await chatDataService.createChat({
        public_key: peer,
        name: 'Large resource history',
        meta: { inbox_state: 'accepted' },
      });
      const db = await chatDataService.getDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        for (let index = 0; index < 20000; index++)
          tx.objectStore('messages').add({
            chat_public_key: peer,
            author_public_key: peer,
            message: `Cached resource row ${index}`,
            created_at: new Date(1700000000000 + index * 1000).toISOString(),
            meta: {},
          });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      await useChatStore().reload();
    }, peer);
    resources = await monitorResources(page);
    await navigateToChat(page, peer);
    await expect(page.getByTestId('message-bubble').last()).toContainText(
      'Cached resource row 19999',
    );
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      await page.getByTestId('thread-load-older').click();
      await expect(page.getByTestId('thread-load-older')).toBeEnabled();
      expect(await page.getByTestId('message-bubble').count()).toBeLessThanOrEqual(300);
    }
    samples.push(await resources.sample('20,000-message history: open and page eight times'));
    const receiving = page.evaluate(
      async ({ wrapped, own }) => {
        const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
        return Promise.all(
          wrapped.map((event) =>
            useNostrStore().ingestAndroidRelayNotificationEvent({
              event,
              ownerPubkey: own,
              relayUrl: 'ws://127.0.0.1:7777/',
            }),
          ),
        );
      },
      { wrapped, own: user.session.publicKey },
    );
    // Real keyboard events contend with decryption, persistence and rendering.
    const composer = page.getByTestId('message-composer-input');
    await composer.pressSequentially('Typing during encrypted message hydration', { delay: 10 });
    await expect(composer).toHaveValue('Typing during encrypted message hydration');
    expect((await receiving).filter(Boolean)).toHaveLength(128);
    samples.push(await resources.sample('128 encrypted arrivals while typing'));
    await page.waitForTimeout(1500);
    await resources.sample('settle');
    await page.waitForTimeout(20000);
    const idle = await resources.sample('idle after paging and hydration');
    samples.push(idle);
    expect(idle.mainThreadCpuPercent).toBeLessThan(5);
    expect(idle.browserCpuPercent).toBeLessThan(10);
    for (const usage of samples) {
      expect(usage.longestTask, usage.name).toBeLessThan(500);
      expect(usage.longestDelay, usage.name).toBeLessThan(1000);
    }
    expect(user.browserErrors).toEqual([]);
  } finally {
    console.log('History resource samples:', JSON.stringify(samples));
    await info.attach('history-resource-samples', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    });
    await resources?.stop();
    await disposeUsers(user);
  }
});
