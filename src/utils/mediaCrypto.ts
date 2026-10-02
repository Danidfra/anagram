// Client-side encryption for NIP-17 kind 15 file messages.
// Blobs are encrypted with AES-256-GCM before upload; the key and nonce only travel inside the
// gift-wrapped rumor, never to the media server.

export const MEDIA_ENCRYPTION_ALGORITHM = 'aes-gcm';
export const MEDIA_KEY_BYTES = 32;
export const MEDIA_NONCE_BYTES = 12;
// Amethyst generates 16-byte nonces; WebCrypto accepts both lengths for AES-GCM.
export const ACCEPTED_MEDIA_NONCE_BYTES: readonly number[] = [12, 16];
export const AES_GCM_TAG_BYTES = 16;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export class MediaIntegrityError extends Error {
  constructor(message = 'Encrypted media hash does not match the message.') {
    super(message);
    this.name = 'MediaIntegrityError';
  }
}

export class MediaDecryptionError extends Error {
  constructor(message = 'Encrypted media could not be decrypted.') {
    super(message);
    this.name = 'MediaDecryptionError';
  }
}

export interface EncryptedMediaPayload {
  ciphertext: Uint8Array<ArrayBuffer>;
  key: string;
  nonce: string;
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto is required to encrypt media.');
  }

  return subtle;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('A secure random source is required to encrypt media.');
  }

  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[a-f0-9]+$/u.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function normalizeSha256Hex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return SHA256_HEX_PATTERN.test(normalized) ? normalized : null;
}

export function decodeMediaKey(value: unknown): Uint8Array<ArrayBuffer> {
  const bytes = hexToBytes(value);
  if (!bytes || bytes.length !== MEDIA_KEY_BYTES) {
    throw new MediaDecryptionError('Encrypted media key must be 32 hex-encoded bytes.');
  }

  return bytes;
}

export function decodeMediaNonce(value: unknown): Uint8Array<ArrayBuffer> {
  const bytes = hexToBytes(value);
  if (!bytes || !ACCEPTED_MEDIA_NONCE_BYTES.includes(bytes.length)) {
    throw new MediaDecryptionError('Encrypted media nonce must be 12 or 16 hex-encoded bytes.');
  }

  return bytes;
}

export function isValidMediaKeyHex(value: unknown): boolean {
  return hexToBytes(value)?.length === MEDIA_KEY_BYTES;
}

export function isValidMediaNonceHex(value: unknown): boolean {
  const length = hexToBytes(value)?.length;
  return typeof length === 'number' && ACCEPTED_MEDIA_NONCE_BYTES.includes(length);
}

export function generateMediaKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(MEDIA_KEY_BYTES);
}

export function generateMediaNonce(): Uint8Array<ArrayBuffer> {
  return randomBytes(MEDIA_NONCE_BYTES);
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await getSubtleCrypto().digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export async function verifySha256(
  data: Uint8Array<ArrayBuffer>,
  expectedSha256: unknown
): Promise<boolean> {
  const expected = normalizeSha256Hex(expectedSha256);
  if (!expected) {
    return false;
  }

  return (await sha256Hex(data)) === expected;
}

async function importAesGcmKey(
  keyBytes: Uint8Array<ArrayBuffer>,
  usage: 'encrypt' | 'decrypt'
): Promise<CryptoKey> {
  return getSubtleCrypto().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [usage]);
}

// Every call generates a new key and nonce, so a key+nonce pair never encrypts two plaintexts.
export async function encryptMediaBytes(
  plaintext: Uint8Array<ArrayBuffer>
): Promise<EncryptedMediaPayload> {
  const keyBytes = generateMediaKey();
  const nonceBytes = generateMediaNonce();
  const cryptoKey = await importAesGcmKey(keyBytes, 'encrypt');
  const ciphertext = await getSubtleCrypto().encrypt(
    { name: 'AES-GCM', iv: nonceBytes, tagLength: AES_GCM_TAG_BYTES * 8 },
    cryptoKey,
    plaintext
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    key: bytesToHex(keyBytes),
    nonce: bytesToHex(nonceBytes),
  };
}

export async function decryptMediaBytes(
  ciphertext: Uint8Array<ArrayBuffer>,
  keyHex: unknown,
  nonceHex: unknown
): Promise<Uint8Array<ArrayBuffer>> {
  const keyBytes = decodeMediaKey(keyHex);
  const nonceBytes = decodeMediaNonce(nonceHex);
  if (ciphertext.byteLength <= AES_GCM_TAG_BYTES) {
    throw new MediaDecryptionError('Encrypted media is too short.');
  }

  try {
    const cryptoKey = await importAesGcmKey(keyBytes, 'decrypt');
    const plaintext = await getSubtleCrypto().decrypt(
      { name: 'AES-GCM', iv: nonceBytes, tagLength: AES_GCM_TAG_BYTES * 8 },
      cryptoKey,
      ciphertext
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new MediaDecryptionError();
  }
}

// Verifies the ciphertext hash from the message before any decryption is attempted.
export async function verifyAndDecryptMediaBytes(
  ciphertext: Uint8Array<ArrayBuffer>,
  input: { sha256: unknown; key: unknown; nonce: unknown }
): Promise<Uint8Array<ArrayBuffer>> {
  if (!(await verifySha256(ciphertext, input.sha256))) {
    throw new MediaIntegrityError();
  }

  return decryptMediaBytes(ciphertext, input.key, input.nonce);
}
