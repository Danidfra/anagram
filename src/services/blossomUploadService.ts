import type { MessageAttachmentMetadata } from 'src/types/chat';
import {
  buildBlossomUploadUrl,
  getBlossomServerHost,
  requireBlossomServerUrl,
} from 'src/utils/blossomServer';
import { stripImageMetadata } from 'src/utils/imageMetadata';
import { encryptMediaBytes, MEDIA_ENCRYPTION_ALGORITHM, sha256Hex } from 'src/utils/mediaCrypto';
import { normalizeMimeType, resolveSafeInlineImageMimeType } from 'src/utils/messageAttachments';

export const BLOSSOM_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const ENCRYPTED_BLOB_CONTENT_TYPE = 'application/octet-stream';
export const BLOSSOM_UPLOAD_MAX_ATTEMPTS = 3;
const RETRYABLE_UPLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface BlossomUploadResult {
  attachment: MessageAttachmentMetadata;
  descriptor: BlossomBlobDescriptor;
}

interface BlossomBlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded?: number;
}

interface UploadBlossomMediaOptions {
  serverUrl: string;
  signal?: AbortSignal;
  signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.floor(numeric);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBlobDescriptor(value: unknown): BlossomBlobDescriptor | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = normalizeString(value.url);
  const sha256 = normalizeString(value.sha256).toLowerCase();
  const type = normalizeString(value.type);
  const size = normalizePositiveInteger(value.size);
  const uploaded = normalizePositiveInteger(value.uploaded);
  if (!url || !sha256 || !type || !size) {
    return null;
  }

  return {
    url,
    sha256,
    size,
    type,
    ...(uploaded ? { uploaded } : {}),
  };
}

export function isCommonBlossomMediaFile(file: File): boolean {
  return /^(image|video|audio)\//u.test(file.type);
}

export function isImageMediaFile(file: File): boolean {
  return /^image\//iu.test(file.type);
}

export function validateBlossomMediaFile(file: File): string | null {
  if (!isCommonBlossomMediaFile(file)) {
    return 'Only image, video, and audio files are supported.';
  }

  if (file.size <= 0) {
    return 'The selected file is empty.';
  }

  if (file.size > BLOSSOM_MEDIA_MAX_BYTES) {
    return 'Media uploads are limited to 20 MiB.';
  }

  return null;
}

export function validateEncryptedImageFile(file: File): string | null {
  const baseError = validateBlossomMediaFile(file);
  if (baseError) {
    return baseError;
  }

  if (!isImageMediaFile(file) || !resolveSafeInlineImageMimeType(file.type)) {
    return 'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.';
  }

  return null;
}

// Images are always sent encrypted; video and audio still use the plaintext upload path.
export function validateOutgoingMediaFile(file: File): string | null {
  return isImageMediaFile(file) ? validateEncryptedImageFile(file) : validateBlossomMediaFile(file);
}

export async function sha256HexFromBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class BlossomUploadError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'BlossomUploadError';
    this.status = status;
    this.retryable = retryable;
  }
}

async function readUploadError(response: Response, serverHost: string): Promise<string> {
  const reason = response.headers.get('X-Reason')?.trim();
  if (reason) {
    return reason;
  }

  const body = (await response.text().catch(() => '')).trim();
  if (body) {
    return body;
  }

  return `${serverHost} upload failed with HTTP ${response.status}.`;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface PutBlossomBlobInput {
  body: Blob | Uint8Array<ArrayBuffer>;
  contentType: string;
  sha256: string;
  serverUrl: string;
  serverHost: string;
  options: UploadBlossomMediaOptions;
  maxAttempts: number;
}

// The same body and authorization are reused for every attempt: a retry never re-reads,
// re-encrypts, or re-hashes the file.
async function putBlossomBlob(input: PutBlossomBlobInput): Promise<BlossomBlobDescriptor> {
  const { body, contentType, sha256, serverUrl, serverHost, options } = input;
  const authorization = await options.signUploadAuthHeader({ serverUrl, sha256 });
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(buildBlossomUploadUrl(serverUrl), {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'Content-Type': contentType,
          'X-SHA-256': sha256,
        },
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts) {
        await waitForRetry(retryDelayMs * attempt, options.signal);
        continue;
      }
      throw error;
    }

    if (response.status === 200 || response.status === 201) {
      const descriptor = normalizeBlobDescriptor(await response.json().catch(() => null));
      if (!descriptor) {
        throw new Error(`${serverHost} returned an invalid upload response.`);
      }
      return descriptor;
    }

    const retryable = RETRYABLE_UPLOAD_STATUSES.has(response.status);
    lastError = new BlossomUploadError(
      await readUploadError(response, serverHost),
      response.status,
      retryable
    );
    if (!retryable || attempt >= maxAttempts) {
      throw lastError;
    }
    await waitForRetry(retryDelayMs * attempt, options.signal);
  }

  throw lastError ?? new Error(`${serverHost} upload failed.`);
}

// Plaintext upload path, kept for video and audio. Images must use uploadEncryptedImage.
export async function uploadBlossomMedia(
  file: File,
  options: UploadBlossomMediaOptions
): Promise<BlossomUploadResult> {
  const validationError = validateBlossomMediaFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  if (isImageMediaFile(file)) {
    throw new Error('Images must be encrypted before upload.');
  }

  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const sha256 = await sha256HexFromBlob(file);
  const descriptor = await putBlossomBlob({
    body: file,
    contentType: file.type,
    sha256,
    serverUrl,
    serverHost,
    options,
    maxAttempts: options.maxAttempts ?? 1,
  });

  const uploadedAt = descriptor.uploaded ? new Date(descriptor.uploaded * 1000).toISOString() : '';

  return {
    descriptor,
    attachment: {
      type: 'media',
      url: descriptor.url,
      mimeType: descriptor.type,
      size: descriptor.size,
      sha256: descriptor.sha256,
      name: file.name,
      service: serverHost,
      ...(uploadedAt ? { uploadedAt } : {}),
    },
  };
}

export interface PreparedEncryptedImage {
  ciphertext: Uint8Array<ArrayBuffer>;
  sha256: string;
  originalSha256: string;
  mimeType: string;
  key: string;
  nonce: string;
  metadataStripped: boolean;
}

// Strips image metadata and encrypts the result once. The returned ciphertext is what gets
// uploaded; the key and nonce stay on the client until they are placed in the gift-wrapped rumor.
export async function prepareEncryptedImage(file: File): Promise<PreparedEncryptedImage> {
  const validationError = validateEncryptedImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const mimeType = resolveSafeInlineImageMimeType(file.type) ?? normalizeMimeType(file.type);
  const original = new Uint8Array(await file.arrayBuffer());
  const { bytes: plaintext, stripped } = stripImageMetadata(original, mimeType);
  const originalSha256 = await sha256Hex(plaintext);
  const encrypted = await encryptMediaBytes(plaintext);
  const sha256 = await sha256Hex(encrypted.ciphertext);

  return {
    ciphertext: encrypted.ciphertext,
    sha256,
    originalSha256,
    mimeType,
    key: encrypted.key,
    nonce: encrypted.nonce,
    metadataStripped: stripped,
  };
}

export async function uploadPreparedEncryptedImage(
  prepared: PreparedEncryptedImage,
  fileName: string,
  options: UploadBlossomMediaOptions
): Promise<BlossomUploadResult> {
  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const descriptor = await putBlossomBlob({
    body: prepared.ciphertext,
    contentType: ENCRYPTED_BLOB_CONTENT_TYPE,
    sha256: prepared.sha256,
    serverUrl,
    serverHost,
    options,
    maxAttempts: options.maxAttempts ?? BLOSSOM_UPLOAD_MAX_ATTEMPTS,
  });

  if (descriptor.sha256 !== prepared.sha256) {
    throw new Error(`${serverHost} stored a blob with an unexpected hash.`);
  }

  const uploadedAt = descriptor.uploaded ? new Date(descriptor.uploaded * 1000).toISOString() : '';
  const name = fileName.trim();

  return {
    descriptor,
    attachment: {
      type: 'media',
      url: descriptor.url,
      mimeType: prepared.mimeType,
      size: prepared.ciphertext.byteLength,
      sha256: prepared.sha256,
      ...(name ? { name } : {}),
      service: serverHost,
      ...(uploadedAt ? { uploadedAt } : {}),
      encryption: {
        algorithm: MEDIA_ENCRYPTION_ALGORITHM,
        key: prepared.key,
        nonce: prepared.nonce,
        originalSha256: prepared.originalSha256,
      },
    },
  };
}

export async function uploadEncryptedImage(
  file: File,
  options: UploadBlossomMediaOptions
): Promise<BlossomUploadResult> {
  const prepared = await prepareEncryptedImage(file);
  return uploadPreparedEncryptedImage(prepared, file.name, options);
}
