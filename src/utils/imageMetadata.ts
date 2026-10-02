// Byte-level metadata stripping for outgoing images. Pixel data is copied verbatim, so there is
// no re-encode, quality loss, or color-profile change. Unsupported or malformed inputs are
// returned untouched: the bytes are still encrypted before upload.

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_APP0 = 0xe0;
const JPEG_APP1 = 0xe1;
const JPEG_APP13 = 0xed;
const JPEG_COM = 0xfe;
const EXIF_ORIENTATION_TAG = 0x0112;
const TIFF_SHORT_TYPE = 3;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

export interface StrippedImageMetadata {
  bytes: Uint8Array<ArrayBuffer>;
  stripped: boolean;
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
        0
    : ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
        0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

// Reads the EXIF orientation from an APP1 payload (the bytes after the 2-byte length field).
export function readExifOrientation(payload: Uint8Array): number | null {
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  if (payload.length < 14 || exifHeader.some((byte, index) => payload[index] !== byte)) {
    return null;
  }

  const tiff = payload.subarray(6);
  const byteOrder = String.fromCharCode(tiff[0], tiff[1]);
  if (byteOrder !== 'II' && byteOrder !== 'MM') {
    return null;
  }

  const littleEndian = byteOrder === 'II';
  if (readUint16(tiff, 2, littleEndian) !== 42) {
    return null;
  }

  const ifdOffset = readUint32(tiff, 4, littleEndian);
  if (ifdOffset + 2 > tiff.length) {
    return null;
  }

  const entryCount = readUint16(tiff, ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > tiff.length) {
      return null;
    }

    if (
      readUint16(tiff, entryOffset, littleEndian) === EXIF_ORIENTATION_TAG &&
      readUint16(tiff, entryOffset + 2, littleEndian) === TIFF_SHORT_TYPE
    ) {
      const orientation = readUint16(tiff, entryOffset + 8, littleEndian);
      return orientation >= 1 && orientation <= 8 ? orientation : null;
    }
  }

  return null;
}

// A minimal big-endian EXIF segment that carries only the orientation tag.
export function buildOrientationOnlyExifSegment(orientation: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff,
    JPEG_APP1,
    0x00,
    0x22,
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

// Drops APP1 (EXIF/XMP), APP13 (IPTC), and COM segments. Orientation is preserved so rotated
// camera photos still render upright.
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== JPEG_SOI) {
    return null;
  }

  const keptSegments: Uint8Array[] = [];
  let orientation: number | null = null;
  let offset = 2;
  let tail: Uint8Array | null = null;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }

    while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff) {
      offset += 1;
    }

    if (offset + 1 >= bytes.length) {
      return null;
    }

    const marker = bytes[offset + 1];
    if (marker === JPEG_SOS || marker === JPEG_EOI) {
      tail = bytes.subarray(offset);
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keptSegments.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    if (offset + 4 > bytes.length) {
      return null;
    }

    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segmentEnd = offset + 2 + segmentLength;
    if (segmentLength < 2 || segmentEnd > bytes.length) {
      return null;
    }

    const segment = bytes.subarray(offset, segmentEnd);
    if (marker === JPEG_APP1) {
      orientation ??= readExifOrientation(segment.subarray(4));
    } else if (marker !== JPEG_APP13 && marker !== JPEG_COM) {
      keptSegments.push(segment);
    }

    offset = segmentEnd;
  }

  if (!tail) {
    return null;
  }

  if (orientation !== null && orientation !== 1) {
    const insertAt = keptSegments[0]?.[1] === JPEG_APP0 ? 1 : 0;
    keptSegments.splice(insertAt, 0, buildOrientationOnlyExifSegment(orientation));
  }

  return concatBytes([bytes.subarray(0, 2), ...keptSegments, tail]);
}

// Drops textual, EXIF, and timestamp chunks. Remaining chunks keep their original CRCs.
export function stripPngMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (
    bytes.length < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    return null;
  }

  const keptChunks: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let sawEnd = false;

  while (offset + 12 <= bytes.length) {
    const dataLength = readUint32(bytes, offset, false);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > bytes.length) {
      return null;
    }

    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!PNG_METADATA_CHUNK_TYPES.has(type)) {
      keptChunks.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }

  return sawEnd ? concatBytes(keptChunks) : null;
}

export function stripImageMetadata(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string
): StrippedImageMetadata {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  let stripped: Uint8Array<ArrayBuffer> | null = null;
  try {
    if (normalizedMimeType === 'image/jpeg' || normalizedMimeType === 'image/jpg') {
      stripped = stripJpegMetadata(bytes);
    } else if (normalizedMimeType === 'image/png') {
      stripped = stripPngMetadata(bytes);
    }
  } catch {
    stripped = null;
  }

  return stripped ? { bytes: stripped, stripped: true } : { bytes, stripped: false };
}
