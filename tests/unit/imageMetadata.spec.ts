import {
  buildOrientationOnlyExifSegment,
  readExifOrientation,
  stripImageMetadata,
  stripJpegMetadata,
  stripPngMetadata,
} from 'src/utils/imageMetadata';
import { describe, expect, it } from 'vitest';

const ascii = (value: string): number[] => Array.from(value, (char) => char.charCodeAt(0));

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

// EXIF APP1 payload (little-endian) with orientation and a fake GPS marker string in the IFD data.
function exifPayload(orientation: number): number[] {
  return [
    ...ascii('Exif'),
    0x00,
    0x00,
    ...ascii('II'),
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x02,
    0x00,
    0x0f,
    0x01,
    0x02,
    0x00,
    0x04,
    0x00,
    0x00,
    0x00,
    ...ascii('GPS!'),
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...ascii('SECRET-GPS-48.8584N'),
  ];
}

const APP0 = segment(0xe0, [
  ...ascii('JFIF'),
  0x00,
  0x01,
  0x01,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
]);
const DQT = segment(0xdb, [0x00, ...Array.from({ length: 64 }, (_, index) => index + 1)]);
const ICC = segment(0xe2, [...ascii('ICC_PROFILE'), 0x00, 0x01, 0x01, 0x10, 0x20]);
const ADOBE = segment(0xee, [...ascii('Adobe'), 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]);
const SCAN = [
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0x00, 0x56, 0xff,
  0xd9,
];

function jpeg(parts: number[][]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, ...parts.flat(), ...SCAN]);
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  return new TextDecoder('latin1').decode(bytes).includes(text);
}

function crcPlaceholder(): number[] {
  return [0xde, 0xad, 0xbe, 0xef];
}

function pngChunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...ascii(type),
    ...data,
    ...crcPlaceholder(),
  ];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('imageMetadata', () => {
  it('removes EXIF, XMP, IPTC, and comments from JPEGs while keeping image segments', () => {
    const xmp = segment(0xe1, [
      ...ascii('http://ns.adobe.com/xap/1.0/'),
      0x00,
      ...ascii('<x:xmpmeta>creator</x:xmpmeta>'),
    ]);
    const iptc = segment(0xed, [...ascii('Photoshop 3.0'), 0x00, ...ascii('IPTC-CITY')]);
    const comment = segment(0xfe, ascii('taken at home'));
    const input = jpeg([APP0, segment(0xe1, exifPayload(1)), xmp, iptc, comment, ICC, ADOBE, DQT]);

    const output = stripJpegMetadata(input);

    expect(output).not.toBeNull();
    const result = output as Uint8Array;
    expect(containsAscii(result, 'SECRET-GPS')).toBe(false);
    expect(containsAscii(result, 'Exif')).toBe(false);
    expect(containsAscii(result, 'xmpmeta')).toBe(false);
    expect(containsAscii(result, 'IPTC-CITY')).toBe(false);
    expect(containsAscii(result, 'taken at home')).toBe(false);
    expect(Array.from(result)).toEqual([0xff, 0xd8, ...APP0, ...ICC, ...ADOBE, ...DQT, ...SCAN]);
  });

  it('keeps only the orientation tag when the photo is rotated', () => {
    const input = jpeg([APP0, segment(0xe1, exifPayload(6)), DQT]);

    const result = stripJpegMetadata(input) as Uint8Array;

    expect(containsAscii(result, 'SECRET-GPS')).toBe(false);
    expect(Array.from(result)).toEqual([
      0xff,
      0xd8,
      ...APP0,
      ...buildOrientationOnlyExifSegment(6),
      ...DQT,
      ...SCAN,
    ]);
    expect(readExifOrientation(buildOrientationOnlyExifSegment(6).subarray(4))).toBe(6);
  });

  it('reads orientation from big-endian and little-endian EXIF', () => {
    expect(readExifOrientation(new Uint8Array(exifPayload(8)))).toBe(8);
    expect(readExifOrientation(buildOrientationOnlyExifSegment(3).subarray(4))).toBe(3);
    expect(readExifOrientation(new Uint8Array(ascii('not exif data')))).toBeNull();
  });

  it('copies scan data verbatim, including bytes that look like markers', () => {
    const input = jpeg([DQT]);

    expect(Array.from(stripJpegMetadata(input) as Uint8Array)).toEqual(Array.from(input));
  });

  it('refuses malformed JPEGs instead of guessing', () => {
    expect(stripJpegMetadata(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, ...DQT]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0x12, 0x34]))).toBeNull();
  });

  it('removes textual, EXIF, and time chunks from PNGs', () => {
    const ihdr = pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const idat = pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x01]);
    const iend = pngChunk('IEND', []);
    const input = new Uint8Array([
      ...PNG_SIGNATURE,
      ...ihdr,
      ...pngChunk('tEXt', ascii('Author\u0000Alice')),
      ...pngChunk('eXIf', ascii('MM-SECRET-GPS')),
      ...pngChunk('iTXt', ascii('XML:com.adobe.xmp\u0000')),
      ...pngChunk('zTXt', ascii('Comment\u0000\u0000x')),
      ...pngChunk('tIME', [7, 234, 10, 2, 13, 0, 0]),
      ...idat,
      ...iend,
    ]);

    const result = stripPngMetadata(input) as Uint8Array;

    expect(Array.from(result)).toEqual([...PNG_SIGNATURE, ...ihdr, ...idat, ...iend]);
  });

  it('refuses truncated PNGs', () => {
    const ihdr = pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    expect(stripPngMetadata(new Uint8Array([...PNG_SIGNATURE, ...ihdr]))).toBeNull();
    expect(stripPngMetadata(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it('passes unsupported or malformed images through unchanged', () => {
    const webp = new Uint8Array(ascii('RIFF....WEBPVP8 '));
    const brokenJpeg = new Uint8Array([0xff, 0xd8, 0x00]);

    expect(stripImageMetadata(webp, 'image/webp')).toEqual({ bytes: webp, stripped: false });
    expect(stripImageMetadata(brokenJpeg, 'image/jpeg')).toEqual({
      bytes: brokenJpeg,
      stripped: false,
    });
    expect(stripImageMetadata(jpeg([DQT]), 'IMAGE/JPEG').stripped).toBe(true);
  });
});
