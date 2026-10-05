import type { MessageAttachmentMetadata } from 'src/types/chat';
import {
  buildBlossomUploadUrl,
  getBlossomServerHost,
  requireBlossomServerUrl,
} from 'src/utils/blossomServer';
import { encryptMediaBytes, MEDIA_ENCRYPTION_ALGORITHM, sha256Hex } from 'src/utils/mediaCrypto';
import { resolveSafeInlineImageMimeType } from 'src/utils/messageAttachments';

export const BLOSSOM_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const ENCRYPTED_BLOB_CONTENT_TYPE = 'application/octet-stream';

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

const ASCII = (value: string): number[] => Array.from(value, (char) => char.charCodeAt(0));
const IMAGE_FTYP_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'mif1', 'msf1']);

function startsWithBytes(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

// Recognizes common image containers by their leading bytes, so an image with a misleading
// video/audio type or extension is never uploaded through the plaintext path.
export function hasKnownImageSignature(bytes: Uint8Array): boolean {
  if (
    startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ||
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWithBytes(bytes, ASCII('GIF8')) ||
    (startsWithBytes(bytes, ASCII('RIFF')) && startsWithBytes(bytes, ASCII('WEBP'), 8))
  ) {
    return true;
  }

  if (!startsWithBytes(bytes, ASCII('ftyp'), 4)) {
    return false;
  }

  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return IMAGE_FTYP_BRANDS.has(brand);
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

interface PutBlossomBlobInput {
  body: Blob | Uint8Array<ArrayBuffer>;
  contentType: string;
  sha256: string;
  serverUrl: string;
  serverHost: string;
  options: UploadBlossomMediaOptions;
  unreachableMessage?: string;
}

// A single PUT: the response is authoritative and failures are never retried automatically,
// so a rejected upload is not sent again.
async function putBlossomBlob(input: PutBlossomBlobInput): Promise<BlossomBlobDescriptor> {
  const { body, contentType, sha256, serverUrl, serverHost, options } = input;
  const authorization = await options.signUploadAuthHeader({ serverUrl, sha256 });
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
    // Browsers report a rejection without CORS headers as an opaque network error.
    if (input.unreachableMessage && !options.signal?.aborted) {
      throw new Error(input.unreachableMessage);
    }
    throw error;
  }

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await readUploadError(response, serverHost));
  }

  const descriptor = normalizeBlobDescriptor(await response.json().catch(() => null));
  if (!descriptor) {
    throw new Error(`${serverHost} returned an invalid upload response.`);
  }

  return descriptor;
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

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isImageMediaFile(file) || hasKnownImageSignature(bytes)) {
    throw new Error('Images must be encrypted before upload.');
  }

  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const sha256 = await sha256Hex(bytes);
  const descriptor = await putBlossomBlob({
    body: file,
    contentType: file.type,
    sha256,
    serverUrl,
    serverHost,
    options,
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

// Encrypts the original image bytes once and uploads only the ciphertext. The key and nonce
// stay on the client until they are placed in the gift-wrapped kind 15 rumor.
export async function uploadEncryptedImage(
  file: File,
  options: UploadBlossomMediaOptions
): Promise<BlossomUploadResult> {
  const validationError = validateEncryptedImageFile(file);
  const mimeType = resolveSafeInlineImageMimeType(file.type);
  if (validationError || !mimeType) {
    throw new Error(validationError ?? 'Unsupported image type.');
  }

  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const originalSha256 = await sha256Hex(plaintext);
  const { ciphertext, key, nonce } = await encryptMediaBytes(plaintext);
  const sha256 = await sha256Hex(ciphertext);
  const descriptor = await putBlossomBlob({
    body: ciphertext,
    contentType: ENCRYPTED_BLOB_CONTENT_TYPE,
    sha256,
    serverUrl,
    serverHost,
    options,
    unreachableMessage: `Could not upload to ${serverHost}. The server may be unavailable or may not accept encrypted file uploads.`,
  });

  if (descriptor.sha256 !== sha256) {
    throw new Error(`${serverHost} stored a blob with an unexpected hash.`);
  }

  const uploadedAt = descriptor.uploaded ? new Date(descriptor.uploaded * 1000).toISOString() : '';
  const name = file.name.trim();

  return {
    descriptor,
    attachment: {
      type: 'media',
      url: descriptor.url,
      mimeType,
      size: ciphertext.byteLength,
      sha256,
      ...(name ? { name } : {}),
      service: serverHost,
      ...(uploadedAt ? { uploadedAt } : {}),
      encryption: {
        algorithm: MEDIA_ENCRYPTION_ALGORITHM,
        key,
        nonce,
        originalSha256,
      },
    },
  };
}
