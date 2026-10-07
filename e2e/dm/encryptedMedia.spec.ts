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
  // Every upload request body, including the ones answered with an error.
  const uploadAttempts: { body: Buffer; contentType: string }[] = [];
  const state = { failUploads: false };

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
      uploadAttempts.push({ body, contentType: headers['content-type'] ?? '' });
      if (state.failUploads) {
        await route.fulfill({
          status: 503,
          headers: CORS_HEADERS,
          body: 'unavailable',
        });
        return;
      }
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
    uploadAttempts,
    state,
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
  await fileChooser.setFiles({
    name: file.name,
    mimeType: 'image/png',
    buffer: file.buffer,
  });
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
    await sendImageFromComposer(alice.page, {
      name: 'holiday.png',
      buffer: png,
    });
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
      return {
        type: blob.type,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      };
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
    await waitForThreadMessage(alice.page, 'lazy-filler-39', {
      chatId: bob.session.publicKey,
    });
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

// A real, playable 1 second mono 16-bit PCM WAV (440 Hz tone).
function buildWavTone(seconds = 1, sampleRate = 8000): Buffer {
  const samples = seconds * sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((index / sampleRate) * 440 * 2 * Math.PI) * 8000;
    data.writeInt16LE(Math.round(value), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Records a short, real WebM clip in the browser, so the test needs no binary fixture.
async function recordWebmClip(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(15), {
      mimeType: 'video/webm',
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    for (let frame = 0; frame < 12; frame += 1) {
      if (context) {
        context.fillStyle = `hsl(${frame * 30}, 80%, 50%)`;
        context.fillRect(0, 0, 64, 48);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    recorder.stop();
    await stopped;
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  return Buffer.from(bytes);
}

// Opens the media picker. The encryption notice is expected unless it was dismissed earlier.
async function sendPrivateMedia(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  options: { expectNotice: boolean; dontShowAgain?: boolean }
) {
  await page.getByTestId('message-composer-menu').click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByText('Photo or Video', { exact: true }).click();
  if (options.expectNotice) {
    await expect(page.getByText(/end-to-end encrypted on your device/u)).toBeVisible();
    if (options.dontShowAgain) {
      await page.getByTestId('composer-media-notice-dont-show').click();
    }
    await page.getByRole('button', { name: 'OK', exact: true }).click();
  } else {
    await expect(page.getByTestId('composer-media-notice-dont-show')).toHaveCount(0);
  }
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(file);
}

interface PlayerSnapshot {
  width: number;
  height: number;
  src: string;
  duration: number;
  currentTime: number;
  paused: boolean;
}

function readPlayer(page: Page, testId: string): Promise<PlayerSnapshot> {
  return page
    .getByTestId(testId)
    .last()
    .evaluate((element: HTMLMediaElement) => {
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        src: element.src,
        duration: element.duration,
        currentTime: element.currentTime,
        paused: element.paused,
      };
    });
}

async function expectUsablePlayer(page: Page, testId: string): Promise<PlayerSnapshot> {
  const player = page.getByTestId(testId).last();
  await expect(player).toHaveAttribute('src', /^blob:/u, { timeout: 30_000 });
  await expect(player).toHaveAttribute('controls', '');
  await expect
    .poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState), {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  const snapshot = await readPlayer(page, testId);
  // Regression: the player used to collapse to a 0px wide box, hiding its native controls.
  expect(snapshot.width).toBeGreaterThan(200);
  expect(snapshot.height).toBeGreaterThan(20);
  return snapshot;
}

test('private audio and video are encrypted, decrypt locally and play with native controls', async ({
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
    const startingBlobCount = blossom.blobs.size;

    // Audio: the notice is shown the first time and dismissed for good.
    const wav = buildWavTone();
    await sendPrivateMedia(
      alice.page,
      { name: 'tone.wav', mimeType: 'audio/wav', buffer: wav },
      { expectNotice: true, dontShowAgain: true }
    );
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(startingBlobCount + 1);
    const audioUpload = blossom.uploadAttempts.at(-1);
    expect(audioUpload?.contentType).toBe('application/octet-stream');
    expect(audioUpload?.body.length).toBe(wav.length + 16);
    expect(audioUpload?.body.includes(Buffer.from('RIFF'))).toBe(false);
    expect(audioUpload?.body.includes(Buffer.from('WAVE'))).toBe(false);

    // Own media is trusted, so it decrypts on its own once visible and shows a real player.
    const audio = alice.page.getByTestId('message-encrypted-audio').last();
    const aliceAudio = await expectUsablePlayer(alice.page, 'message-encrypted-audio');
    expect(aliceAudio.duration).toBeCloseTo(1, 1);
    const decryptedAudio = await audio.evaluate(async (element: HTMLMediaElement) => {
      const blob = await (await fetch(element.src)).blob();
      return {
        type: blob.type,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      };
    });
    expect(decryptedAudio.type).toBe('audio/wav');
    expect(Buffer.from(decryptedAudio.bytes).equals(wav)).toBe(true);

    // Play, pause, seek and replay through the native element.
    await audio.evaluate((element: HTMLMediaElement) => element.play());
    await expect
      .poll(async () => (await readPlayer(alice.page, 'message-encrypted-audio')).currentTime)
      .toBeGreaterThan(0);
    await audio.evaluate((element: HTMLMediaElement) => element.pause());
    expect((await readPlayer(alice.page, 'message-encrypted-audio')).paused).toBe(true);
    await audio.evaluate((element: HTMLMediaElement) => {
      element.currentTime = 0.5;
    });
    await expect
      .poll(async () => (await readPlayer(alice.page, 'message-encrypted-audio')).currentTime)
      .toBeCloseTo(0.5, 1);
    await audio.evaluate((element: HTMLMediaElement) => element.play());
    await expect
      .poll(() => audio.evaluate((element: HTMLMediaElement) => element.ended), { timeout: 10_000 })
      .toBe(true);
    await audio.evaluate((element: HTMLMediaElement) => element.play());
    await expect
      .poll(async () => (await readPlayer(alice.page, 'message-encrypted-audio')).paused)
      .toBe(false);
    await audio.evaluate((element: HTMLMediaElement) => element.pause());

    // Video: the notice stays dismissed and the picker opens directly.
    const webm = await recordWebmClip(alice.page);
    await sendPrivateMedia(
      alice.page,
      { name: 'clip.webm', mimeType: 'video/webm', buffer: webm },
      { expectNotice: false }
    );
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(startingBlobCount + 2);
    const videoUpload = blossom.uploadAttempts.at(-1);
    expect(videoUpload?.contentType).toBe('application/octet-stream');
    expect(videoUpload?.body.subarray(0, 4).equals(webm.subarray(0, 4))).toBe(false);
    await expectUsablePlayer(alice.page, 'message-encrypted-video');

    // The recipient has not trusted the sender: nothing is downloaded until they press play.
    blossom.downloads.length = 0;
    await navigateToChat(bob.page, alice.session.publicKey);
    await expect(bob.page.getByTestId('message-encrypted-media-placeholder')).toHaveCount(2, {
      timeout: 30_000,
    });
    await bob.page.waitForTimeout(1500);
    expect(blossom.downloads).toHaveLength(0);

    await bob.page.getByTestId('message-encrypted-media-load').first().click();
    const bobAudio = await expectUsablePlayer(bob.page, 'message-encrypted-audio');
    expect(bobAudio.duration).toBeCloseTo(1, 1);
    await bob.page.getByTestId('message-encrypted-media-load').first().click();
    await expectUsablePlayer(bob.page, 'message-encrypted-video');
    const video = bob.page.getByTestId('message-encrypted-video').last();
    await video.evaluate((element: HTMLMediaElement) => element.play());
    await expect
      .poll(async () => (await readPlayer(bob.page, 'message-encrypted-video')).paused)
      .toBe(false);
    await video.evaluate((element: HTMLMediaElement) => element.pause());
    expect((await readPlayer(bob.page, 'message-encrypted-video')).paused).toBe(true);

    // The decrypted object URL is released once the thread is no longer shown.
    const bobAudioUrl = (await readPlayer(bob.page, 'message-encrypted-audio')).src;
    await bob.page.goto('/#/settings/media-data-storage');
    await expect(bob.page.getByTestId('settings-private-media-input')).toBeVisible();
    const isRevoked = await bob.page.evaluate(async (url) => {
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    }, bobAudioUrl);
    expect(isRevoked).toBe(true);

    // With the notice dismissed, upload failures still surface with retry and change-server, and
    // a retry re-sends the identical ciphertext. Plaintext is never offered or uploaded.
    blossom.state.failUploads = true;
    const attemptsBeforeFailure = blossom.uploadAttempts.length;
    await sendPrivateMedia(
      alice.page,
      { name: 'tone-again.wav', mimeType: 'audio/wav', buffer: wav },
      { expectNotice: false }
    );
    await expect(alice.page.getByTestId('composer-media-upload-retry')).toBeVisible({
      timeout: 30_000,
    });
    await expect(alice.page.getByTestId('composer-media-upload-change-server')).toBeVisible();
    await expect(alice.page.getByText(/plaintext|unencrypted/iu)).toHaveCount(0);
    const failedAttempt = blossom.uploadAttempts.at(-1);
    expect(blossom.uploadAttempts.length).toBe(attemptsBeforeFailure + 1);
    expect(failedAttempt?.contentType).toBe('application/octet-stream');
    expect(failedAttempt?.body.includes(Buffer.from('RIFF'))).toBe(false);

    blossom.state.failUploads = false;
    await alice.page.getByTestId('composer-media-upload-retry').click();
    await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(startingBlobCount + 3);
    expect(blossom.uploadAttempts.at(-1)?.body.equals(failedAttempt?.body ?? Buffer.alloc(0))).toBe(
      true
    );

    // Settings shares the "Don't show this again" preference: it starts OFF here, turning it
    // back ON restores the notice, and turning it OFF skips it again. Either way the upload is
    // the same encrypted, ciphertext-only upload.
    const sendAndExpectCiphertext = async (expectNotice: boolean, blobCount: number) => {
      await navigateToChat(alice.page, bob.session.publicKey);
      await sendPrivateMedia(
        alice.page,
        {
          name: `tone-${blobCount}.wav`,
          mimeType: 'audio/wav',
          buffer: buildWavTone(blobCount),
        },
        { expectNotice }
      );
      await expect.poll(() => blossom.blobs.size, { timeout: 30_000 }).toBe(blobCount);
      const upload = blossom.uploadAttempts.at(-1);
      expect(upload?.contentType).toBe('application/octet-stream');
      expect(upload?.body.includes(Buffer.from('RIFF'))).toBe(false);
    };
    const noticeToggle = alice.page.getByTestId('settings-private-media-notice-toggle');

    await alice.page.goto('/#/settings/media-data-storage');
    await expect(noticeToggle).toHaveAttribute('aria-checked', 'false');
    await noticeToggle.click();
    await expect(noticeToggle).toHaveAttribute('aria-checked', 'true');
    await sendAndExpectCiphertext(true, startingBlobCount + 4);

    await alice.page.goto('/#/settings/media-data-storage');
    await expect(noticeToggle).toHaveAttribute('aria-checked', 'true');
    await noticeToggle.click();
    await expect(noticeToggle).toHaveAttribute('aria-checked', 'false');
    await sendAndExpectCiphertext(false, startingBlobCount + 5);

    await expectNoUnexpectedBrowserErrors([alice, bob], {
      allowPatterns: [
        /503/u,
        /Failed to upload media to Blossom/u,
        /unavailable/u,
        // The deliberate fetch of the revoked object URL above.
        /ERR_FILE_NOT_FOUND/u,
      ],
    });
  } finally {
    await disposeUsers(alice, bob);
  }
});
