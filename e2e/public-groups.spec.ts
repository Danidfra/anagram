import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from 'nostr-tools';
import { WebSocket } from 'ws';
import { finishOnboarding } from './auth-helpers';
import { navigateInApp } from './parity/helpers';
const relay = 'ws://127.0.0.1:7777/';
async function login(page: Page) {
  const key = generateSecretKey();
  await page.addInitScript((url) => {
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
async function publish(event: ReturnType<typeof finalizeEvent>) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relay);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Relay timeout'));
    }, 5000);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timer);
        ws.close();
        msg[2] ? resolve() : reject(new Error(msg[3]));
      }
    });
  });
}
async function create(page: Page, name = 'Public lounge') {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('button', { name: 'New public group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New public group' });
  await dialog.getByLabel('Group name', { exact: true }).fill(name);
  await dialog.getByLabel('Description', { exact: true }).fill('Everyone welcome');
  await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
  await expect(page).toHaveURL(/\/public\/naddr/);
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(name);
  const naddr = page.url().split('/public/')[1];
  const decoded = nip19.decode(naddr);
  if (decoded.type !== 'naddr') throw new Error();
  return {
    naddr,
    address: `34550:${decoded.data.pubkey}:${decoded.data.identifier}`,
    slug: decoded.data.identifier,
  };
}
test('create, share, edit and moderate public groups without rich hydration for strangers', async ({
  page,
}, info) => {
  const owner = await login(page);
  const room = await create(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy public group link' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`/public/${room.naddr}`);
  await expect(page.getByRole('button', { name: 'Attach public media' })).toBeVisible();
  const stranger = generateSecretKey(),
    pk = getPublicKey(stranger);
  let mediaRequests = 0;
  await page.route('https://public-media.example.org/**', (r) => {
    mediaRequests++;
    return r.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.getByLabel('Public message', { exact: true }).fill('**Owner formatting**');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.locator('[data-testid="public-message"] strong').filter({ hasText: 'Owner formatting' }),
  ).toBeVisible();
  const text =
    '**stranger formatting** https://public-media.example.org/picture.png <img src=x onerror=alert(1)>';
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', room.address],
        ['imeta', 'url https://public-media.example.org/hidden.png', 'm image/png'],
      ],
      content: text,
    },
    stranger,
  );
  await publish(event);
  const message = page.getByTestId('public-message').filter({ hasText: 'stranger formatting' });
  await expect(message).toBeVisible();
  await expect(message.locator('a,img,video,iframe')).toHaveCount(0);
  await expect(message).toContainText('[link removed]');
  await expect(message).not.toContainText('https://public-media.example.org');
  await message.getByTestId('message-relay-status').click();
  const relayDialog = page.locator('dialog.relay-dialog');
  await expect(relayDialog).toContainText(relay);
  await page.getByRole('button', { name: 'Close relay details', exact: true }).click();
  expect(mediaRequests).toBe(0);
  // A foreign account cannot replace this room's policy by copying its slug.
  await publish(
    finalizeEvent(
      {
        kind: 34550,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [
          ['d', room.slug],
          ['anagram-room', '1'],
          ['name', 'Forged group'],
          ['relay', relay],
          ['trusted', pk],
        ],
      },
      stranger,
    ),
  );
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Public lounge',
  );
  await page.getByRole('button', { name: 'Public group settings' }).click();
  let dialog = page.getByRole('dialog', { name: 'Public group settings' });
  await dialog.getByLabel('Group name', { exact: true }).fill('Renamed public group');
  await dialog.getByLabel('Picture URL').fill('https://public-media.example.org/avatar.png');
  await dialog.getByRole('button', { name: 'Save group profile' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Renamed public group',
  );
  async function add(list: 'Trusted' | 'Blocked') {
    await page.getByRole('button', { name: 'Public group settings' }).click();
    const d = page.getByRole('dialog', { name: 'Public group settings' });
    await d.getByRole('button', { name: list, exact: true }).click();
    await d.getByRole('button', { name: `Add ${list.toLowerCase()} users` }).click();
    const picker = page.getByRole('dialog', { name: `Add ${list.toLowerCase()} users` });
    await picker.getByLabel('Search people').fill(pk);
    await picker.getByTestId('profile-search-result').click();
    await picker.getByRole('button', { name: 'Add (1)', exact: true }).click();
    await expect(picker).not.toBeVisible();
  }
  await add('Trusted');
  await expect(message.locator('img')).toHaveCount(2);
  await expect(message).not.toContainText('[link removed]');
  await expect.poll(() => mediaRequests).toBeGreaterThan(0);
  await add('Blocked');
  await expect(message).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Renamed public group',
  );
  await expect(
    page.getByTestId('public-message').filter({ hasText: 'stranger formatting' }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('public-group-mobile.png') });
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Renamed public group Public group/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Renamed public group Public group/ }).click();
  await expect(page.getByLabel('Public message', { exact: true })).toBeVisible();
  expect(owner.pubkey).toBe(
    nip19.decode(room.naddr).type === 'naddr' ? room.address.split(':')[1] : '',
  );
});

test('public renderer remains responsive', async ({ page }) => {
  page.on('pageerror', (e) => console.log(e.message));
  await page.goto('/');
  await page.evaluate(async () => {
    const { mount } = await import('/node_modules/.vite/deps/svelte.js');
    const { default: Component } = await import('/src/lib/components/public/PublicMessage.svelte');
    const target = document.createElement('div');
    document.body.append(target);
    mount(Component, {
      target,
      props: {
        trusted: true,
        event: {
          kind: 9,
          content: '**Owner formatting**',
          tags: [],
          created_at: 1,
          pubkey: 'a'.repeat(64),
        },
      },
    });
  });
  await expect(page.locator('strong').filter({ hasText: 'Owner formatting' })).toBeVisible();
});

test('owners hand over through signed successor and predecessor, with historical reading', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const alice = await a.newPage(),
    bob = await b.newPage();
  try {
    await login(alice);
    const first = await create(alice, 'Original room');
    await alice.getByLabel('Public message', { exact: true }).fill('Before the handover');
    await alice.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(alice.getByTestId('public-message')).toContainText('Before the handover');
    await login(bob);
    await bob.getByRole('button', { name: 'Chat options' }).click();
    await bob.getByRole('button', { name: 'New public group', exact: true }).click();
    const dialog = bob.getByRole('dialog', { name: 'New public group' });
    await dialog.getByLabel('Group name', { exact: true }).fill('Successor room');
    await dialog.getByText('Continue a group from another owner', { exact: true }).click();
    await dialog.getByLabel('Previous group link').fill(first.naddr);
    await dialog.getByRole('button', { name: 'Create public group', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Successor room',
    );
    const successor = bob.url().split('/public/')[1];
    await alice.getByRole('button', { name: 'Public group settings' }).click();
    const settings = alice.getByRole('dialog', { name: 'Public group settings' });
    await settings.getByRole('button', { name: 'Ownership', exact: true }).click();
    await settings.getByLabel('Successor group link').fill(successor);
    await settings.getByRole('checkbox').check();
    await settings.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    await expect(settings).not.toBeVisible();
    await expect(alice.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Successor room',
    );
    await alice.getByRole('combobox').selectOption(first.address);
    await expect(alice.getByTestId('public-message')).toContainText('Before the handover');
    await expect(alice.getByLabel('Public message', { exact: true })).toBeDisabled();
    await alice.getByRole('combobox').selectOption('');
    await expect(alice.getByRole('button', { name: 'Attach public media' })).toHaveCount(0);
    await alice
      .getByLabel('Public message', { exact: true })
      .fill('**Former owner is plain text**');
    await alice.getByRole('button', { name: 'Send', exact: true }).click();
    const message = alice
      .getByTestId('public-message')
      .filter({ hasText: 'Former owner is plain text' });
    await expect(message).toContainText('**Former owner is plain text**');
    await expect(
      message.locator('strong').filter({ hasText: 'Former owner is plain text' }),
    ).toHaveCount(0);
    await alice.reload();
    await expect(alice.getByRole('button', { name: 'Public group settings' })).toContainText(
      'Successor room',
    );
    await alice.getByRole('button', { name: 'Public group settings' }).click();
    await expect(
      alice.getByRole('dialog').getByRole('button', { name: 'Ownership', exact: true }),
    ).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});

test('public history uses private-group scroll gestures and leaving lives in settings', async ({
  page,
}) => {
  await login(page);
  const room = await create(page, 'History room');
  await navigateInApp(page, '/chats');
  const author = generateSecretKey();
  const now = Math.floor(Date.now() / 1000) - 1000;
  for (let n = 0; n < 110; n++)
    await publish(
      finalizeEvent(
        {
          kind: 9,
          created_at: now + n,
          tags: [['a', room.address]],
          content: `History item ${n}`,
        },
        author,
      ),
    );
  await navigateInApp(page, `/public/${room.naddr}`);
  const log = page.getByRole('log', { name: 'Public group messages' });
  await expect(log.getByTestId('public-message').last()).toContainText('History item 109');
  await expect(log.getByTestId('public-message').first()).toContainText('History item 60');
  await expect(log.getByTestId('public-message')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave public group', exact: true })).toHaveCount(
    0,
  );
  await log.evaluate((node) => {
    node.scrollTop = 0;
  });
  await log.hover();
  await page.mouse.wheel(0, -120);
  await expect(log.getByTestId('public-message').first()).toContainText('History item 10');
  expect(await log.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Public group settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Public group settings' });
  await expect(settings.getByRole('heading', { name: 'History room' })).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(settings).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Public group settings' }).click();
  await expect(settings).toBeVisible();
  const bounds = await settings.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await settings.getByRole('button', { name: 'Leave public group', exact: true }).click();
  await settings.getByRole('button', { name: 'Leave group', exact: true }).click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('button', { name: /History room Public group/ })).toHaveCount(0);
});

test('a stalled replica does not block opening, posting or cached re-entry', async ({ page }) => {
  await page.routeWebSocket('wss://stalled.example.org/**', () => {});
  const owner = await login(page);
  const slug = crypto.randomUUID();
  const event = finalizeEvent(
    {
      kind: 34550,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['d', slug],
        ['anagram-room', '1'],
        ['name', 'Fast room'],
        ['relay', relay],
        ['relay', 'wss://stalled.example.org/'],
      ],
    },
    owner.key,
  );
  await publish(event);
  const naddr = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: slug,
    relays: [relay, 'wss://stalled.example.org/'],
  });
  await navigateInApp(page, `/public/${naddr}`);
  await expect(page.getByLabel('Public message', { exact: true })).toBeEnabled({ timeout: 3000 });
  await page.getByLabel('Public message', { exact: true }).fill('Fast post');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('public-message')).toContainText('Fast post', { timeout: 3000 });
  await expect(page.getByLabel('Public message', { exact: true })).toHaveValue('', {
    timeout: 3000,
  });
  // Stop the room listener, then simulate a completely offline policy lookup.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await page.evaluate(async () => {
    const { useNostrStore } = await import('/src/stores/nostrStore.ts');
    const runtime = useNostrStore().publicGroups;
    runtime.stopView();
  });
  await page.context().setOffline(true);
  await page.getByRole('button', { name: /Fast room Public group/ }).click();
  await expect(page.getByRole('button', { name: 'Public group settings' })).toContainText(
    'Fast room',
    { timeout: 1500 },
  );
  await expect(page.getByTestId('public-message')).toContainText('Fast post', { timeout: 1500 });
});

test('uses cached author photos and shared media rendering for redirected Blossom uploads', async ({
  page,
}) => {
  const owner = await login(page);
  const stranger = generateSecretKey();
  const strangerKey = getPublicKey(stranger);
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  let strangerRequests = 0;
  await page.route('https://avatars.example.org/**', (route) => {
    if (route.request().url().endsWith('/stranger.png')) strangerRequests++;
    return route.fulfill({ contentType: 'image/png', body: image });
  });
  await page.evaluate(
    async ({ owner, stranger }) => {
      const { rememberPublicProfile } = await import('/src/lib/state/publicProfiles.ts');
      rememberPublicProfile(owner, {
        name: 'Owner',
        picture: 'https://avatars.example.org/owner.png',
      });
      rememberPublicProfile(stranger, {
        name: 'Stranger',
        picture: 'https://avatars.example.org/stranger.png',
      });
    },
    { owner: owner.pubkey, stranger: strangerKey },
  );
  const room = await create(page, 'Media room');
  for (const dark of [false, true]) {
    await page.evaluate((dark) => {
      document.body.classList.toggle('body--dark', dark);
      document.body.dataset.accent = 'green';
      document.body.style.setProperty('--theme-accent-light', '#3e7140');
      document.body.style.setProperty('--theme-accent-dark', '#77aa79');
    }, dark);
    const row = page.getByTestId('public-chat-item');
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(row.locator('strong')).toHaveCSS('color', 'rgb(255, 255, 255)');
  }

  await page.route('**/upload', async (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers().authorization).toMatch(/^Nostr /);
    return route.fulfill({
      status: 201,
      json: {
        url: 'https://blossom.example.org/photo.png',
        type: 'image/png',
        size: image.length,
        sha256: route.request().headers()['x-sha-256'],
      },
    });
  });
  await page.route('https://blossom.example.org/photo.png', (route) =>
    route.fulfill({
      status: 307,
      headers: { location: new URL('/pwa/icon-192.png', page.url()).href },
    }),
  );

  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Upload and send', exact: true }).click();
  const message = page.getByTestId('public-message');
  await expect(message.locator('img[src="https://avatars.example.org/owner.png"]')).toBeVisible();
  const media = message.locator('img[src="https://blossom.example.org/photo.png"]');
  await expect
    .poll(() => media.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(message.getByRole('button', { name: 'Media options', exact: true })).toBeVisible();
  await message.getByTestId('message-relay-status').click();
  const statusDialog = page.locator('dialog.relay-dialog');
  await expect(statusDialog).toContainText(relay);
  await expect(statusDialog).toContainText('published');
  await expect(statusDialog.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close relay details', exact: true }).click();
  await expect(message.locator('.message-text')).toHaveCount(0);
  await media.click();
  await expect(page.getByRole('dialog', { name: 'Image attachment' })).toBeVisible();
  await page.getByRole('button', { name: 'Close image', exact: true }).click();
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', room.address]],
        content: 'Stranger message',
      },
      stranger,
    ),
  );
  const untrusted = page.getByTestId('public-message').filter({ hasText: 'Stranger message' });
  await expect(untrusted).toBeVisible();
  await expect(untrusted.locator('img')).toHaveCount(0);
  expect(strangerRequests).toBe(0);
});

test('public relay failures can retry the same message through the shared dialog', async ({
  page,
}) => {
  let rejectPosts = true;
  const secondary = 'wss://replica.example.org/';
  await page.routeWebSocket(secondary, (socket) =>
    socket.onMessage((raw) => {
      const data = JSON.parse(String(raw));
      if (data[0] === 'REQ') socket.send(JSON.stringify(['EOSE', data[1]]));
      if (data[0] === 'EVENT')
        socket.send(
          JSON.stringify([
            'OK',
            data[1].id,
            !rejectPosts,
            rejectPosts ? 'blocked: test rejection' : '',
          ]),
        );
    }),
  );
  const owner = await login(page);
  const definition = finalizeEvent(
    {
      kind: 34550,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['d', 'relay-retry'],
        ['anagram-room', '1'],
        ['name', 'Relay retry room'],
        ['relay', relay],
        ['relay', secondary],
      ],
    },
    owner.key,
  );
  await publish(definition);
  const link = nip19.naddrEncode({
    kind: 34550,
    pubkey: owner.pubkey,
    identifier: 'relay-retry',
    relays: [relay],
  });
  await navigateInApp(page, `/public/${link}`);
  const input = page.getByLabel('Public message', { exact: true });
  await expect(input).toBeEnabled();
  await input.fill('Retry this exact event');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const message = page.getByTestId('public-message').filter({ hasText: 'Retry this exact event' });
  await expect(message.locator('.bubble__status-segment--red')).toBeVisible();
  const id = await message.getAttribute('data-event-id');
  await message.getByTestId('message-relay-status').click();
  const dialog = page.locator('dialog.relay-dialog');
  await expect(dialog).toContainText(secondary);
  await expect(dialog).toContainText('blocked: test rejection');
  rejectPosts = false;
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(message.locator('.bubble__status-segment--red')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close relay details', exact: true }).click();
  await expect(message).toHaveAttribute('data-event-id', id!);
  await expect(page.getByTestId('public-message')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('public-message')).toHaveCount(1);
  await expect(page.getByTestId('message-relay-status')).toBeVisible();
});

test('sender names and avatars reuse the private-chat DM action on desktop and mobile', async ({
  page,
}) => {
  await login(page);
  const room = await create(page, 'Author links');
  const sender = generateSecretKey(),
    publicKey = getPublicKey(sender);
  await publish(
    finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['a', room.address]],
        content: 'Open my DM',
      },
      sender,
    ),
  );
  const message = page.getByTestId('public-message').filter({ hasText: 'Open my DM' });
  await expect(message).toBeVisible();
  await message.getByTestId('thread-author-name-link').click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const dmUrl = page.url();
  await expect(
    page.locator(`[data-testid="chat-thread"][data-chat-public-key="${publicKey}"]`),
  ).toBeVisible();
  await navigateInApp(page, `/public/${room.naddr}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(message).toBeVisible();
  await message.getByTestId('thread-author-profile-link').click();
  await expect(page).toHaveURL(dmUrl);
  await expect(
    page.locator(`[data-testid="chat-thread"][data-chat-public-key="${publicKey}"]`),
  ).toBeVisible();
});
