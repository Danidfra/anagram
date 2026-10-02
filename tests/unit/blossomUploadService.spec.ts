import {
  BlossomUploadError,
  ENCRYPTED_BLOB_CONTENT_TYPE,
  prepareEncryptedImage,
  sha256HexFromBlob,
  uploadBlossomMedia,
  uploadEncryptedImage,
  uploadPreparedEncryptedImage,
  validateBlossomMediaFile,
  validateEncryptedImageFile,
  validateOutgoingMediaFile,
} from 'src/services/blossomUploadService';
import { bytesToHex, decryptMediaBytes, sha256Hex } from 'src/utils/mediaCrypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const IMAGE_TEXT = 'PRIVATE-IMAGE-BYTES-'.repeat(8);

function imageFile(type = 'image/png', name = 'photo.png'): File {
  return new File([IMAGE_TEXT], name, { type });
}

function readRequestBody(init: RequestInit | undefined): Uint8Array<ArrayBuffer> {
  const body = init?.body;
  if (!(body instanceof Uint8Array)) {
    throw new Error('Expected a byte array upload body.');
  }
  return new Uint8Array(body);
}

function descriptorResponse(sha256: string, size: number): Response {
  return new Response(
    JSON.stringify({
      url: `https://blossom.example.com/${sha256}`,
      sha256,
      size,
      type: 'application/octet-stream',
      uploaded: 1780912800,
    }),
    { status: 201 }
  );
}

// Answers like a Blossom server: hashes the received body and echoes it in the descriptor.
function createBlossomFetchMock(failures: Array<number | 'network'> = []) {
  const queue = [...failures];
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const failure = queue.shift();
    if (failure === 'network') {
      throw new TypeError('Failed to fetch');
    }
    if (typeof failure === 'number') {
      return new Response('temporarily unavailable', { status: failure });
    }

    const body = readRequestBody(init);
    return descriptorResponse(await sha256Hex(body), body.byteLength);
  });
}

describe('blossomUploadService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates common media files for the upload flow', () => {
    expect(validateBlossomMediaFile(new File(['image'], 'image.png', { type: 'image/png' }))).toBe(
      null
    );
    expect(validateBlossomMediaFile(new File(['text'], 'note.txt', { type: 'text/plain' }))).toBe(
      'Only image, video, and audio files are supported.'
    );
    expect(validateBlossomMediaFile(new File([], 'empty.png', { type: 'image/png' }))).toBe(
      'The selected file is empty.'
    );
  });

  it('hashes blobs with SHA-256', async () => {
    await expect(sha256HexFromBlob(new Blob(['hello']))).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('uploads media to the configured server with server-scoped authentication', async () => {
    const file = new File(['hello'], 'hello.mp4', { type: 'video/mp4' });
    const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          url: 'https://cdn.example.com/hello.png',
          sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          size: 5,
          type: 'video/mp4',
          uploaded: 1780912800,
        }),
        { status: 201 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadBlossomMedia(file, {
      serverUrl: 'https://media.example.com/',
      signUploadAuthHeader,
    });

    expect(signUploadAuthHeader).toHaveBeenCalledWith({
      serverUrl: 'https://media.example.com',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.example.com/upload',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Nostr signed-auth',
          'Content-Type': 'video/mp4',
          'X-SHA-256': '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        },
        body: file,
      })
    );
    expect(result.attachment).toEqual({
      type: 'media',
      url: 'https://cdn.example.com/hello.png',
      mimeType: 'video/mp4',
      size: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      name: 'hello.mp4',
      service: 'media.example.com',
      uploadedAt: '2026-06-08T10:00:00.000Z',
    });
  });

  it('refuses to upload images through the plaintext path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadBlossomMedia(imageFile(), {
        serverUrl: 'https://media.example.com',
        signUploadAuthHeader: async () => 'Nostr auth',
      })
    ).rejects.toThrow('Images must be encrypted before upload.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates which images can be sent encrypted', () => {
    expect(validateEncryptedImageFile(imageFile('image/jpeg', 'a.jpg'))).toBeNull();
    expect(validateEncryptedImageFile(imageFile('image/webp', 'a.webp'))).toBeNull();
    expect(validateEncryptedImageFile(imageFile('image/svg+xml', 'a.svg'))).toBe(
      'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.'
    );
    expect(validateEncryptedImageFile(imageFile('image/heic', 'a.heic'))).toBe(
      'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.'
    );
    expect(validateOutgoingMediaFile(imageFile('image/svg+xml', 'a.svg'))).not.toBeNull();
    expect(validateOutgoingMediaFile(new File(['v'], 'a.mp4', { type: 'video/mp4' }))).toBeNull();
  });

  describe('encrypted image upload', () => {
    it('uploads only ciphertext as application/octet-stream', async () => {
      const fetchMock = createBlossomFetchMock();
      const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
      vi.stubGlobal('fetch', fetchMock);

      const result = await uploadEncryptedImage(imageFile(), {
        serverUrl: 'https://media.example.com',
        signUploadAuthHeader,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      const body = readRequestBody(init);
      const plaintext = new Uint8Array(new TextEncoder().encode(IMAGE_TEXT));
      const ciphertextHash = await sha256Hex(body);

      expect(url).toBe('https://media.example.com/upload');
      expect(init?.method).toBe('PUT');
      expect(init?.body).not.toBeInstanceOf(File);
      expect(init?.headers).toEqual({
        Authorization: 'Nostr signed-auth',
        'Content-Type': ENCRYPTED_BLOB_CONTENT_TYPE,
        'X-SHA-256': ciphertextHash,
      });
      expect(new TextDecoder().decode(body)).not.toContain('PRIVATE-IMAGE-BYTES');
      expect(bytesToHex(body)).not.toContain(bytesToHex(plaintext.subarray(0, 16)));
      expect(signUploadAuthHeader).toHaveBeenCalledWith({
        serverUrl: 'https://media.example.com',
        sha256: ciphertextHash,
      });

      const { attachment } = result;
      expect(attachment).toMatchObject({
        type: 'media',
        url: `https://blossom.example.com/${ciphertextHash}`,
        mimeType: 'image/png',
        size: body.byteLength,
        sha256: ciphertextHash,
        name: 'photo.png',
        service: 'media.example.com',
        uploadedAt: '2026-06-08T10:00:00.000Z',
        encryption: {
          algorithm: 'aes-gcm',
          originalSha256: await sha256Hex(plaintext),
        },
      });
      await expect(
        decryptMediaBytes(body, attachment.encryption?.key, attachment.encryption?.nonce)
      ).resolves.toEqual(plaintext);
    });

    it('never sends the key or nonce to the server', async () => {
      const fetchMock = createBlossomFetchMock();
      const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedImage(imageFile(), {
        serverUrl: 'https://media.example.com',
        signUploadAuthHeader,
      });
      const key = attachment.encryption?.key ?? '';
      const nonce = attachment.encryption?.nonce ?? '';
      const [url, init] = fetchMock.mock.calls[0];
      const outgoing = [
        url,
        JSON.stringify(init?.headers),
        JSON.stringify(signUploadAuthHeader.mock.calls),
        bytesToHex(readRequestBody(init)),
      ].join('\n');

      expect(key).toMatch(/^[a-f0-9]{64}$/u);
      expect(nonce).toMatch(/^[a-f0-9]{24}$/u);
      expect(outgoing).not.toContain(key);
      expect(outgoing).not.toContain(nonce);
    });

    it('strips JPEG metadata before encrypting', async () => {
      const exif = [
        0xff,
        0xe1,
        0x00,
        0x10,
        ...new TextEncoder().encode('Exif\0\0GPS-LEAK!!'),
      ].slice(0, 18);
      const scan = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
      const jpeg = new Uint8Array([0xff, 0xd8, ...exif, ...scan]);
      const prepared = await prepareEncryptedImage(
        new File([jpeg], 'gps.jpg', { type: 'image/jpeg' })
      );
      const plaintext = await decryptMediaBytes(prepared.ciphertext, prepared.key, prepared.nonce);

      expect(prepared.metadataStripped).toBe(true);
      expect(Array.from(plaintext)).toEqual([0xff, 0xd8, ...scan]);
      expect(prepared.originalSha256).toBe(await sha256Hex(plaintext));
      expect(prepared.sha256).toBe(await sha256Hex(prepared.ciphertext));
    });

    it('retries a failed PUT with the same ciphertext, hash, and authorization', async () => {
      const fetchMock = createBlossomFetchMock(['network', 503]);
      const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
      const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt');
      vi.stubGlobal('fetch', fetchMock);

      const result = await uploadEncryptedImage(imageFile(), {
        serverUrl: 'https://media.example.com',
        signUploadAuthHeader,
        retryDelayMs: 0,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(encryptSpy).toHaveBeenCalledTimes(1);
      expect(signUploadAuthHeader).toHaveBeenCalledTimes(1);
      const bodies = fetchMock.mock.calls.map(([, init]) => bytesToHex(readRequestBody(init)));
      const headers = fetchMock.mock.calls.map(([, init]) => JSON.stringify(init?.headers));
      expect(new Set(bodies).size).toBe(1);
      expect(new Set(headers).size).toBe(1);
      expect(result.attachment.sha256).toBe(
        await sha256Hex(readRequestBody(fetchMock.mock.calls[2][1]))
      );
      encryptSpy.mockRestore();
    });

    it('reuses a prepared ciphertext across separate upload attempts', async () => {
      const prepared = await prepareEncryptedImage(imageFile());
      vi.stubGlobal('fetch', createBlossomFetchMock([500]));
      const options = {
        serverUrl: 'https://media.example.com',
        signUploadAuthHeader: async () => 'Nostr auth',
        maxAttempts: 1,
      };

      await expect(
        uploadPreparedEncryptedImage(prepared, 'photo.png', options)
      ).rejects.toBeInstanceOf(BlossomUploadError);
      const retried = await uploadPreparedEncryptedImage(prepared, 'photo.png', options);

      expect(retried.attachment.sha256).toBe(prepared.sha256);
      expect(retried.attachment.encryption?.key).toBe(prepared.key);
      expect(retried.attachment.encryption?.nonce).toBe(prepared.nonce);
    });

    it('does not retry a rejected upload and reports the server reason', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('', {
            status: 415,
            headers: { 'X-Reason': 'Unsupported media type: application/octet-stream' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);

      const upload = uploadEncryptedImage(imageFile(), {
        serverUrl: 'https://media.example.com',
        signUploadAuthHeader: async () => 'Nostr auth',
        retryDelayMs: 0,
      });

      await expect(upload).rejects.toMatchObject({
        name: 'BlossomUploadError',
        status: 415,
        message: 'Unsupported media type: application/octet-stream',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a server descriptor whose hash does not match the uploaded ciphertext', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => descriptorResponse('f'.repeat(64), 10))
      );

      await expect(
        uploadEncryptedImage(imageFile(), {
          serverUrl: 'https://media.example.com',
          signUploadAuthHeader: async () => 'Nostr auth',
        })
      ).rejects.toThrow('media.example.com stored a blob with an unexpected hash.');
    });

    it('does not upload unsupported image types', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        uploadEncryptedImage(imageFile('image/svg+xml', 'x.svg'), {
          serverUrl: 'https://media.example.com',
          signUploadAuthHeader: async () => 'Nostr auth',
        })
      ).rejects.toThrow('Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
