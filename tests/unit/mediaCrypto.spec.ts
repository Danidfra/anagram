import {
  AES_GCM_TAG_BYTES,
  bytesToHex,
  decodeMediaKey,
  decodeMediaNonce,
  decryptMediaBytes,
  encryptMediaBytes,
  hexToBytes,
  MEDIA_KEY_BYTES,
  MEDIA_NONCE_BYTES,
  MediaDecryptionError,
  MediaIntegrityError,
  sha256Hex,
  verifyAndDecryptMediaBytes,
  verifySha256,
} from 'src/utils/mediaCrypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

function plaintextBytes(text = 'a private photo'): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function flipByte(bytes: Uint8Array<ArrayBuffer>, index: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  copy[index] ^= 0x01;
  return copy;
}

describe('mediaCrypto', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips bytes through AES-256-GCM', async () => {
    const plaintext = plaintextBytes();
    const encrypted = await encryptMediaBytes(plaintext);

    await expect(
      decryptMediaBytes(encrypted.ciphertext, encrypted.key, encrypted.nonce)
    ).resolves.toEqual(plaintext);
  });

  it('produces ciphertext that differs from the plaintext and carries a GCM tag', async () => {
    const plaintext = plaintextBytes('x'.repeat(64));
    const encrypted = await encryptMediaBytes(plaintext);

    expect(encrypted.ciphertext.byteLength).toBe(plaintext.byteLength + AES_GCM_TAG_BYTES);
    expect(bytesToHex(encrypted.ciphertext)).not.toContain(bytesToHex(plaintext));
    expect(bytesToHex(encrypted.ciphertext.subarray(0, plaintext.byteLength))).not.toBe(
      bytesToHex(plaintext)
    );
  });

  it('encodes a 32-byte key and a 12-byte nonce as lowercase hex', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    expect(encrypted.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(encrypted.nonce).toMatch(/^[a-f0-9]{24}$/u);
    expect(hexToBytes(encrypted.key)?.length).toBe(MEDIA_KEY_BYTES);
    expect(hexToBytes(encrypted.nonce)?.length).toBe(MEDIA_NONCE_BYTES);
  });

  it('generates a fresh key and nonce for every encryption of the same bytes', async () => {
    const plaintext = plaintextBytes();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => encryptMediaBytes(plaintext))
    );

    expect(new Set(results.map((result) => result.key)).size).toBe(results.length);
    expect(new Set(results.map((result) => result.nonce)).size).toBe(results.length);
    expect(new Set(results.map((result) => bytesToHex(result.ciphertext))).size).toBe(
      results.length
    );
  });

  it('draws keys and nonces from crypto.getRandomValues', async () => {
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');

    await encryptMediaBytes(plaintextBytes());

    const requestedLengths = getRandomValues.mock.calls.map(
      ([array]) => (array as Uint8Array).length
    );
    expect(requestedLengths).toEqual([MEDIA_KEY_BYTES, MEDIA_NONCE_BYTES]);
  });

  it('rejects tampered ciphertext', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    await expect(
      decryptMediaBytes(flipByte(encrypted.ciphertext, 0), encrypted.key, encrypted.nonce)
    ).rejects.toBeInstanceOf(MediaDecryptionError);
  });

  it('rejects a tampered authentication tag', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const lastByte = encrypted.ciphertext.byteLength - 1;

    await expect(
      decryptMediaBytes(flipByte(encrypted.ciphertext, lastByte), encrypted.key, encrypted.nonce)
    ).rejects.toBeInstanceOf(MediaDecryptionError);
  });

  it('rejects ciphertext that is shorter than the tag', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    await expect(
      decryptMediaBytes(
        encrypted.ciphertext.slice(0, AES_GCM_TAG_BYTES),
        encrypted.key,
        encrypted.nonce
      )
    ).rejects.toBeInstanceOf(MediaDecryptionError);
  });

  it('rejects an incorrect key', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const other = await encryptMediaBytes(plaintextBytes());

    await expect(
      decryptMediaBytes(encrypted.ciphertext, other.key, encrypted.nonce)
    ).rejects.toBeInstanceOf(MediaDecryptionError);
  });

  it('rejects an incorrect nonce', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const other = await encryptMediaBytes(plaintextBytes());

    await expect(
      decryptMediaBytes(encrypted.ciphertext, encrypted.key, other.nonce)
    ).rejects.toBeInstanceOf(MediaDecryptionError);
  });

  it('decrypts AES-GCM blobs that use 16-byte nonces from other clients', async () => {
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const plaintext = plaintextBytes('from amethyst');
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, [
      'encrypt',
    ]);
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, plaintext)
    );

    await expect(
      decryptMediaBytes(ciphertext, bytesToHex(key), bytesToHex(nonce))
    ).resolves.toEqual(plaintext);
  });

  it.each([
    ['empty', ''],
    ['non-hex', 'z'.repeat(64)],
    ['odd length', 'a'.repeat(63)],
    ['too short', 'a'.repeat(62)],
    ['too long', 'a'.repeat(66)],
    ['not a string', 42],
  ])('rejects a malformed key (%s)', (_label, value) => {
    expect(() => decodeMediaKey(value)).toThrow(MediaDecryptionError);
  });

  it.each([
    ['empty', ''],
    ['non-hex', 'g'.repeat(24)],
    ['8 bytes', 'a'.repeat(16)],
    ['20 bytes', 'a'.repeat(40)],
    ['not a string', null],
  ])('rejects a malformed nonce (%s)', (_label, value) => {
    expect(() => decodeMediaNonce(value)).toThrow(MediaDecryptionError);
  });

  it('accepts uppercase hex for keys and nonces', () => {
    expect(decodeMediaKey('AB'.repeat(32)).length).toBe(32);
    expect(decodeMediaNonce('CD'.repeat(12)).length).toBe(12);
    expect(decodeMediaNonce('CD'.repeat(16)).length).toBe(16);
  });

  it('hashes and verifies SHA-256 digests', async () => {
    const hello = new Uint8Array(new TextEncoder().encode('hello'));
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

    await expect(sha256Hex(hello)).resolves.toBe(expected);
    await expect(verifySha256(hello, expected)).resolves.toBe(true);
    await expect(verifySha256(hello, expected.toUpperCase())).resolves.toBe(true);
    await expect(verifySha256(hello, '0'.repeat(64))).resolves.toBe(false);
    await expect(verifySha256(hello, 'not-a-hash')).resolves.toBe(false);
  });

  it('checks the ciphertext hash before attempting decryption', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const decryptSpy = vi.spyOn(globalThis.crypto.subtle, 'decrypt');

    await expect(
      verifyAndDecryptMediaBytes(encrypted.ciphertext, {
        sha256: '0'.repeat(64),
        key: encrypted.key,
        nonce: encrypted.nonce,
      })
    ).rejects.toBeInstanceOf(MediaIntegrityError);
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('decrypts once the ciphertext hash matches', async () => {
    const plaintext = plaintextBytes();
    const encrypted = await encryptMediaBytes(plaintext);

    await expect(
      verifyAndDecryptMediaBytes(encrypted.ciphertext, {
        sha256: await sha256Hex(encrypted.ciphertext),
        key: encrypted.key,
        nonce: encrypted.nonce,
      })
    ).resolves.toEqual(plaintext);
  });

  it('treats a matching hash with a failing GCM tag as a decryption failure', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const tampered = flipByte(encrypted.ciphertext, 2);

    await expect(
      verifyAndDecryptMediaBytes(tampered, {
        sha256: await sha256Hex(tampered),
        key: encrypted.key,
        nonce: encrypted.nonce,
      })
    ).rejects.toBeInstanceOf(MediaDecryptionError);
  });
});
