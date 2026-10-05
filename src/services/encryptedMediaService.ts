import type { MessageAttachmentMetadata } from 'src/types/chat';
import { verifyAndDecryptMediaBytes } from 'src/utils/mediaCrypto';
import {
  isEncryptedAttachment,
  normalizeEncryptedMediaUrl,
  resolveSafeInlineImageMimeType,
} from 'src/utils/messageAttachments';

const ENCRYPTED_MEDIA_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

interface ObjectUrlEntry {
  refs: number;
  promise: Promise<string>;
  objectUrl: string | null;
  released: boolean;
}

interface EncryptedMediaServiceDeps {
  fetch: typeof globalThis.fetch;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

function buildCacheKey(attachment: MessageAttachmentMetadata): string {
  const encryption = attachment.encryption;
  return `${attachment.sha256 ?? ''}:${encryption?.key ?? ''}:${encryption?.nonce ?? ''}`;
}

async function readLimitedBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > ENCRYPTED_MEDIA_MAX_DOWNLOAD_BYTES) {
    throw new Error('Encrypted media is too large to download.');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > ENCRYPTED_MEDIA_MAX_DOWNLOAD_BYTES) {
    throw new Error('Encrypted media is too large to download.');
  }

  return bytes;
}

export function createEncryptedMediaService(deps: EncryptedMediaServiceDeps) {
  const objectUrlEntries = new Map<string, ObjectUrlEntry>();

  // Downloads the ciphertext, checks it against the message's x hash, then decrypts. Nothing is
  // returned unless both checks pass, so raw downloaded bytes are never exposed.
  async function fetchDecryptedMediaBlob(attachment: MessageAttachmentMetadata): Promise<Blob> {
    if (!isEncryptedAttachment(attachment)) {
      throw new Error('Attachment is not encrypted.');
    }

    const mimeType = resolveSafeInlineImageMimeType(attachment.mimeType);
    if (!mimeType) {
      throw new Error('This encrypted attachment type cannot be displayed.');
    }

    const url = normalizeEncryptedMediaUrl(attachment.url);
    if (!url) {
      throw new Error('Encrypted media URL must use HTTPS.');
    }

    const response = await deps.fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      throw new Error(`Encrypted media download failed with HTTP ${response.status}.`);
    }

    const ciphertext = await readLimitedBody(response);
    const plaintext = await verifyAndDecryptMediaBytes(ciphertext, {
      sha256: attachment.sha256,
      key: attachment.encryption.key,
      nonce: attachment.encryption.nonce,
    });

    return new Blob([plaintext], { type: mimeType });
  }

  // Reference-counted object URLs shared by every view of the same attachment.
  function acquireDecryptedObjectUrl(attachment: MessageAttachmentMetadata): Promise<string> {
    const cacheKey = buildCacheKey(attachment);
    const existing = objectUrlEntries.get(cacheKey);
    if (existing) {
      existing.refs += 1;
      return existing.promise;
    }

    const entry: ObjectUrlEntry = {
      refs: 1,
      objectUrl: null,
      released: false,
      promise: Promise.resolve(''),
    };
    entry.promise = fetchDecryptedMediaBlob(attachment).then(
      (blob) => {
        const objectUrl = deps.createObjectURL(blob);
        if (entry.released) {
          deps.revokeObjectURL(objectUrl);
          throw new Error('Encrypted media was released before it finished loading.');
        }
        entry.objectUrl = objectUrl;
        return objectUrl;
      },
      (error: unknown) => {
        // Failed loads are not cached so a later view can retry.
        if (objectUrlEntries.get(cacheKey) === entry) {
          objectUrlEntries.delete(cacheKey);
        }
        throw error;
      }
    );
    objectUrlEntries.set(cacheKey, entry);
    return entry.promise;
  }

  function releaseDecryptedObjectUrl(attachment: MessageAttachmentMetadata): void {
    const cacheKey = buildCacheKey(attachment);
    const entry = objectUrlEntries.get(cacheKey);
    if (!entry) {
      return;
    }

    entry.refs -= 1;
    if (entry.refs > 0) {
      return;
    }

    entry.released = true;
    objectUrlEntries.delete(cacheKey);
    if (entry.objectUrl) {
      deps.revokeObjectURL(entry.objectUrl);
      entry.objectUrl = null;
    }
  }

  return {
    acquireDecryptedObjectUrl,
    fetchDecryptedMediaBlob,
    releaseDecryptedObjectUrl,
  };
}

export const encryptedMediaService = createEncryptedMediaService({
  fetch: (input, init) => globalThis.fetch(input, init),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});
