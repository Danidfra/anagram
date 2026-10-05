import {
  hasKnownImageSignature,
  uploadBlossomMedia,
  uploadEncryptedImage,
  validateBlossomMediaFile,
  validateEncryptedImageFile,
  validateOutgoingMediaFile,
} from 'src/services/blossomUploadService';
import { decryptMediaBytes, sha256Hex } from 'src/utils/mediaCrypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const IMAGE_TEXT = 'PRIVATE-IMAGE-BYTES-'.repeat(8);
const UPLOAD_OPTIONS = {
  serverUrl: 'https://media.example.com',
  signUploadAuthHeader: async () => 'Nostr signed-auth',
};

function imageFile(type = 'image/png', name = 'photo.png'): File {
  return new File([IMAGE_TEXT], name, { type });
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
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
function createBlossomFetchMock() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = readRequestBody(init);
    return descriptorResponse(await sha256Hex(body), body.byteLength);
  });
}

describe('blossomUploadService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  describe('plaintext path hardening', () => {
    const ascii = (value: string) => Array.from(value, (char) => char.charCodeAt(0));
    const ftyp = (brand: string) => [0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0];
    const imageSignatures: Array<[string, number[]]> = [
      ['JPEG', [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]],
      ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ['GIF', ascii('GIF89a')],
      ['WebP', [...ascii('RIFF'), 0x10, 0, 0, 0, ...ascii('WEBPVP8 ')]],
      ['AVIF', ftyp('avif')],
      ['HEIC', ftyp('heic')],
    ];

    it.each(
      imageSignatures
    )('refuses a %s image disguised as video before any upload', async (_label, signature) => {
      const fetchMock = vi.fn();
      const signUploadAuthHeader = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const disguised = new File([new Uint8Array([...signature, 1, 2, 3])], 'clip.mp4', {
        type: 'video/mp4',
      });

      await expect(
        uploadBlossomMedia(disguised, { ...UPLOAD_OPTIONS, signUploadAuthHeader })
      ).rejects.toThrow('Images must be encrypted before upload.');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(signUploadAuthHeader).not.toHaveBeenCalled();
    });

    it('refuses files that declare an image type', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadBlossomMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'Images must be encrypted before upload.'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['MP4', ftyp('isom')],
      ['QuickTime', ftyp('qt  ')],
      ['M4A audio', ftyp('M4A ')],
      ['MP3 with ID3', ascii('ID3\u0004\u0000')],
      ['MP3 frame', [0xff, 0xfb, 0x90, 0x00]],
      ['WebM', [0x1a, 0x45, 0xdf, 0xa3]],
      ['WAV', [...ascii('RIFF'), 0x10, 0, 0, 0, ...ascii('WAVEfmt ')]],
    ])('still accepts real %s media on the plaintext path', (_label, signature) => {
      expect(hasKnownImageSignature(new Uint8Array(signature))).toBe(false);
    });
  });

  describe('encrypted image upload', () => {
    it('uploads only ciphertext of the original bytes as application/octet-stream', async () => {
      const fetchMock = createBlossomFetchMock();
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedImage(imageFile(), UPLOAD_OPTIONS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      const body = readRequestBody(init);
      const plaintext = new Uint8Array(new TextEncoder().encode(IMAGE_TEXT));
      const ciphertextHash = await sha256Hex(body);

      expect(url).toBe('https://media.example.com/upload');
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toEqual({
        Authorization: 'Nostr signed-auth',
        'Content-Type': 'application/octet-stream',
        'X-SHA-256': ciphertextHash,
      });
      expect(new TextDecoder().decode(body)).not.toContain('PRIVATE-IMAGE-BYTES');

      // x and size describe the ciphertext; ox describes exactly the bytes that were encrypted,
      // which are the original file bytes.
      expect(attachment).toMatchObject({
        type: 'media',
        url: `https://blossom.example.com/${ciphertextHash}`,
        mimeType: 'image/png',
        size: plaintext.byteLength + 16,
        sha256: ciphertextHash,
        name: 'photo.png',
        service: 'media.example.com',
        uploadedAt: '2026-06-08T10:00:00.000Z',
        encryption: { algorithm: 'aes-gcm', originalSha256: await sha256Hex(plaintext) },
      });
      expect(body.byteLength).toBe(plaintext.byteLength + 16);
      await expect(
        decryptMediaBytes(body, attachment.encryption?.key, attachment.encryption?.nonce)
      ).resolves.toEqual(plaintext);
    });

    it('never sends the key or nonce to the server', async () => {
      const fetchMock = createBlossomFetchMock();
      const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedImage(imageFile(), {
        ...UPLOAD_OPTIONS,
        signUploadAuthHeader,
      });
      const key = attachment.encryption?.key ?? '';
      const nonce = attachment.encryption?.nonce ?? '';
      const [url, init] = fetchMock.mock.calls[0];
      const outgoing = [
        url,
        JSON.stringify(init?.headers),
        JSON.stringify(signUploadAuthHeader.mock.calls),
        hex(readRequestBody(init)),
      ].join('\n');

      expect(key).toMatch(/^[a-f0-9]{64}$/u);
      expect(nonce).toMatch(/^[a-f0-9]{24}$/u);
      expect(outgoing).not.toContain(key);
      expect(outgoing).not.toContain(nonce);
    });

    it('does not retry a visible rejection and reports the server reason', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('', {
            status: 415,
            headers: { 'X-Reason': 'Unsupported media type: application/octet-stream' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedImage(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'Unsupported media type: application/octet-stream'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([429, 503])('does not retry HTTP %s automatically', async (status) => {
      const fetchMock = vi.fn(async () => new Response('busy', { status }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedImage(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow('busy');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uploads the ciphertext once and explains an opaque network failure', async () => {
      // A rejection without CORS headers reaches the browser as a bare TypeError.
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedImage(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'Could not upload to media.example.com. The server may be unavailable or may not accept encrypted file uploads.'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows aborts unchanged', async () => {
      const controller = new AbortController();
      const abortError = new DOMException('Aborted', 'AbortError');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          controller.abort(abortError);
          throw abortError;
        })
      );

      await expect(
        uploadEncryptedImage(imageFile(), { ...UPLOAD_OPTIONS, signal: controller.signal })
      ).rejects.toBe(abortError);
    });

    it('rejects a server descriptor whose hash does not match the uploaded ciphertext', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => descriptorResponse('f'.repeat(64), 10))
      );

      await expect(uploadEncryptedImage(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'media.example.com stored a blob with an unexpected hash.'
      );
    });

    it('does not upload unsupported image types', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        uploadEncryptedImage(imageFile('image/svg+xml', 'x.svg'), UPLOAD_OPTIONS)
      ).rejects.toThrow('Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
