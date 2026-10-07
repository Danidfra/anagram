import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { type BrowserContext, expect, type Page, type Route, test } from '@playwright/test';
import {
  type BootstrappedUser,
  bootstrapUser,
  disposeUsers,
  establishAcceptedDirectChat,
  expectNoUnexpectedBrowserErrors,
  getDeveloperDiagnosticsSnapshot,
  navigateToChat,
  reloadAndWaitForApp,
  sendMessage,
  sendMessagesViaBridge,
  TEST_ACCOUNTS,
  waitForThreadMessage,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

const BLOSSOM_ORIGIN = 'https://blossom.e2e.test';
const SECRET_METADATA = 'SECRET-METADATA-E2E-GPS';

interface StoredBlob {
  body: Buffer;
  contentType: string;
  declaredSha256: string;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

// A real, decodable 3x2 PNG that also carries a text chunk with "private" metadata.
function buildPngWithMetadata(): Buffer {
  const width = 3;
  const height = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      rows[rowStart + 1 + x * 3] = 0x00;
      rows[rowStart + 2 + x * 3] = 0xa6;
      rows[rowStart + 3 + x * 3] = 0x7e;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from(`Comment\u0000${SECRET_METADATA}`, 'latin1')),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256',
  'Cache-Control': 'no-store',
};

// An in-memory Blossom server shared by both browsers. It records exactly what was uploaded.
function createFakeBlossom() {
  const blobs = new Map<string, StoredBlob>();
  const downloads: string[] = [];

  async function handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    if (request.method() === 'PUT' && url.pathname === '/upload') {
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const headers = await request.allHeaders();
      const sha256 = createHash('sha256').update(body).digest('hex');
      blobs.set(sha256, {
        body,
        contentType: headers['content-type'] ?? '',
        declaredSha256: headers['x-sha-256'] ?? '',
      });
      await route.fulfill({
        status: 201,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${BLOSSOM_ORIGIN}/${sha256}`,
          sha256,
          size: body.length,
          type: headers['content-type'] ?? 'application/octet-stream',
          uploaded: Math.floor(Date.now() / 1000),
        }),
      });
      return;
    }

    const sha256 = url.pathname.slice(1);
    const blob = request.method() === 'GET' ? blobs.get(sha256) : undefined;
    if (!blob) {
      await route.fulfill({ status: 404, headers: CORS_HEADERS, body: '' });
      return;
    }

    downloads.push(request.url());
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/octet-stream' },
      body: blob.body,
    });
  }

  return {
    blobs,
    downloads,
    async install(context: BrowserContext): Promise<void> {
      await context.route(`${BLOSSOM_ORIGIN}/**`, handle);
    },
  };
}

async function useBlossomServer(user: BootstrappedUser, serverUrl: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await getDeveloperDiagnosticsSnapshot(user.page);
        return !snapshot.session.isRestoringStartupState;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await user.page.goto('/#/settings/media-data-storage');
  const serverInput = user.page.getByTestId('settings-private-media-input');
  await expect(serverInput).toBeVisible();
  await serverInput.fill(serverUrl);
  const saveButton = user.page.getByTestId('settings-private-media-save');
  // The preference is restored from the account's relays, so a rerun may already have it saved.
  if (await saveButton.isDisabled()) {
    await expect(serverInput).toHaveValue(serverUrl);
    return;
  }

  await saveButton.click();
  await expect(user.page.getByText('Encrypted media server saved.', { exact: true })).toBeVisible({
    timeout: 12_000,
  });
}

async function sendImageFromComposer(page: Page, file: { name: string; buffer: Buffer }) {
  await page.getByTestId('message-composer-menu').click();
  await page.getByText('Photo or Video', { exact: true }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: file.name, mimeType: 'image/png', buffer: file.buffer });
}

async function readRenderedImage(page: Page) {
  const image = page.getByTestId('message-image-preview').last();
  await expect(image).toHaveAttribute('src', /^blob:/u, { timeout: 30_000 });
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(3);
  return image;
}

test('private images are encrypted before upload and decrypted by the recipient', async ({
  browser,
}) => {
  test.slow();

  const alice = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedMediaAlice);
  const bob = await bootstrapUser(browser, TEST_ACCOUNTS.encryptedMediaBob);
  const blossom = createFakeBlossom();

  try {
    await blossom.install(alice.context);
    await blossom.install(bob.context);
    await establishAcceptedDirectChat(alice, bob);
    await useBlossomServer(alice, BLOSSOM_ORIGIN);
    await navigateToChat(alice.page, bob.session.publicKey);

    const png = buildPngWithMetadata();
    await sendImageFromComposer(alice.page, { name: 'holiday.png', buffer: png });
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(1);

    // What the server received: ciphertext only, declared as an opaque blob.
    const [[storedSha256, stored]] = [...blossom.blobs.entries()];
    expect(stored.contentType).toBe('application/octet-stream');
    expect(stored.declaredSha256).toBe(storedSha256);
    expect(stored.body.includes(png.subarray(0, 8))).toBe(false);
    expect(stored.body.includes(Buffer.from('IHDR'))).toBe(false);
    expect(stored.body.includes(Buffer.from(SECRET_METADATA))).toBe(false);
    expect(stored.body.includes(Buffer.from('holiday'))).toBe(false);

    // The sender renders the image from a decrypted blob URL; copy/open-link actions are hidden.
    await readRenderedImage(alice.page);
    await expect(alice.page.getByTestId('message-image-copy-link')).toHaveCount(0);

    // The recipient decrypts it locally after revealing it.
    await navigateToChat(bob.page, alice.session.publicKey);
    await expect(bob.page.getByTestId('message-image-attachment').last()).toBeVisible({
      timeout: 30_000,
    });
    const reveal = bob.page.getByTestId('message-image-show').last();
    if (await reveal.isVisible()) {
      await reveal.click();
    }
    const bobImage = await readRenderedImage(bob.page);
    expect(blossom.downloads.every((url) => url === `${BLOSSOM_ORIGIN}/${storedSha256}`)).toBe(
      true
    );

    // The recipient gets back exactly the original image; its metadata travelled encrypted.
    const decrypted = await bobImage.evaluate(async (element) => {
      const blob = await (await fetch((element as HTMLImageElement).src)).blob();
      return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
    });
    expect(decrypted.type).toBe('image/png');
    expect(Buffer.from(decrypted.bytes).equals(png)).toBe(true);
    expect(stored.body.length).toBe(png.length + 16);

    // Replies show the encrypted image from a decrypted blob URL, never the ciphertext URL.
    const ciphertextUrl = `${BLOSSOM_ORIGIN}/${storedSha256}`;
    await alice.page
      .locator('.bubble')
      .filter({ has: alice.page.getByTestId('message-image-attachment') })
      .last()
      .click({ button: 'right', position: { x: 4, y: 4 } });
    await alice.page.getByText('Reply', { exact: true }).click();
    await expect(alice.page.getByTestId('composer-reply-preview-image')).toHaveAttribute(
      'src',
      /^blob:/u,
      { timeout: 30_000 }
    );
    const replyText = `encrypted-image-reply-${Date.now()}`;
    await sendMessage(alice.page, replyText, { chatId: bob.session.publicKey });
    await expect(alice.page.getByTestId('message-reply-preview-image').last()).toHaveAttribute(
      'src',
      /^blob:/u,
      { timeout: 30_000 }
    );
    await expect(alice.page.locator(`img[src="${ciphertextUrl}"]`)).toHaveCount(0);

    // Images far from the viewport are not downloaded until the user scrolls near them.
    const fillerTexts = Array.from(
      { length: 40 },
      (_, index) => `lazy-filler-${index}\nline two\nline three\nline four`
    );
    await sendMessagesViaBridge(alice.page, bob.session.publicKey, fillerTexts);
    await reloadAndWaitForApp(alice.page);
    blossom.downloads.length = 0;
    await navigateToChat(alice.page, bob.session.publicKey);
    await waitForThreadMessage(alice.page, 'lazy-filler-39', { chatId: bob.session.publicKey });
    const pendingImage = alice.page.getByTestId('message-image-pending').first();
    await expect(pendingImage).toBeAttached();
    await alice.page.waitForTimeout(1500);
    expect(blossom.downloads).toHaveLength(0);
    await pendingImage.scrollIntoViewIfNeeded();
    await readRenderedImage(alice.page);
    expect(blossom.downloads.length).toBeGreaterThan(0);

    // A blob that no longer matches the message hash is never rendered.
    stored.body[0] ^= 0xff;
    await reloadAndWaitForApp(bob.page);
    await navigateToChat(bob.page, alice.session.publicKey);
    const revealAfterReload = bob.page.getByTestId('message-image-show').last();
    if (await revealAfterReload.isVisible().catch(() => false)) {
      await revealAfterReload.click();
    }
    await expect(bob.page.getByTestId('message-image-unavailable').last()).toBeVisible({
      timeout: 30_000,
    });
    await expect(bob.page.getByTestId('message-image-preview')).toHaveCount(0);

    await expectNoUnexpectedBrowserErrors([alice, bob]);
  } finally {
    await disposeUsers(alice, bob);
  }
});
