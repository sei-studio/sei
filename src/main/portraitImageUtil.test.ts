/**
 * Phase 11 Plan 11-06 Task 1 — Magic-byte + size + PNG-dim validation tests.
 *
 * Source: 11-06-PLAN.md <behavior> block (7 named behaviors). The PNG fixture
 * builder mirrors scripts/build-default-skins.mjs.buildPng so the test
 * exercises the real parsePngIhdr import — no stubbing.
 */

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  validatePortrait,
  PORTRAIT_MAX_BYTES,
  PORTRAIT_MAX_DIM,
} from './portraitImageUtil';

// ── PNG fixture helpers ────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Build a minimal valid PNG of the given dimensions (RGBA8 all-zero). */
function buildPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type RGBA
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace
  // Scanlines: filter byte 0 + 4*width zero RGBA bytes per row.
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  const idat = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Build a minimal JPEG-like buffer: SOI (FFD8FF) + filler so length >= 24. */
function buildJpegLike(): Buffer {
  const b = Buffer.alloc(64, 0);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  return b;
}

/** Build a minimal WebP buffer: RIFF + size + WEBP + filler. */
function buildWebp(): Buffer {
  const b = Buffer.alloc(64, 0);
  Buffer.from('RIFF', 'ascii').copy(b, 0);
  b.writeUInt32LE(56, 4); // size minus 8 (purely cosmetic for the magic check)
  Buffer.from('WEBP', 'ascii').copy(b, 8);
  Buffer.from('VP8 ', 'ascii').copy(b, 12);
  return b;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('validatePortrait — size gates', () => {
  it('rejects bytes longer than 500 KB with PORTRAIT_TOO_LARGE', () => {
    const tooBig = Buffer.alloc(PORTRAIT_MAX_BYTES + 1);
    expect(() => validatePortrait(tooBig)).toThrow(/PORTRAIT_TOO_LARGE: \d+ > 512000/);
  });

  it('rejects bytes shorter than 24 with PORTRAIT_TOO_SHORT', () => {
    const tooShort = Buffer.alloc(23);
    expect(() => validatePortrait(tooShort)).toThrow(/PORTRAIT_TOO_SHORT/);
  });
});

describe('validatePortrait — accepts valid magic', () => {
  it('accepts a valid 64×64 PNG and returns format png', () => {
    const png = buildPng(64, 64);
    expect(validatePortrait(png)).toEqual({ format: 'png' });
  });

  it('accepts a valid PNG at exactly 1024×1024 (boundary)', () => {
    const png = buildPng(PORTRAIT_MAX_DIM, PORTRAIT_MAX_DIM);
    // The buffer is mostly zeros so deflate compresses it well below 500 KB;
    // make sure the test's premise (size < cap) holds before asserting.
    expect(png.length).toBeLessThan(PORTRAIT_MAX_BYTES);
    expect(validatePortrait(png)).toEqual({ format: 'png' });
  });

  it('accepts a JPEG (FF D8 FF magic) and returns format jpeg', () => {
    expect(validatePortrait(buildJpegLike())).toEqual({ format: 'jpeg' });
  });

  it('accepts a WebP (RIFF...WEBP magic) and returns format webp', () => {
    expect(validatePortrait(buildWebp())).toEqual({ format: 'webp' });
  });
});

describe('validatePortrait — rejects bad magic and oversized PNG dimensions', () => {
  it('rejects bytes with no matching magic with PORTRAIT_BAD_MAGIC', () => {
    // Buffer.alloc zero-fills; first 4 bytes are 0x00 — match no known magic.
    const random = Buffer.alloc(64);
    // Make sure no accidental WEBP/RIFF/PNG/JPEG header appears.
    random[0] = 0x12;
    random[1] = 0x34;
    random[2] = 0x56;
    random[3] = 0x78;
    expect(() => validatePortrait(random)).toThrow(/PORTRAIT_BAD_MAGIC: must be PNG, JPEG, or WebP/);
  });

  it('rejects a PNG with width > 1024 with PORTRAIT_TOO_LARGE_DIM', () => {
    const png = buildPng(PORTRAIT_MAX_DIM + 1, 64);
    // Make sure the byte cap doesn't trip before the dim check.
    expect(png.length).toBeLessThan(PORTRAIT_MAX_BYTES);
    expect(() => validatePortrait(png)).toThrow(/PORTRAIT_TOO_LARGE_DIM: 1025x64/);
  });

  it('rejects a PNG with height > 1024 with PORTRAIT_TOO_LARGE_DIM', () => {
    const png = buildPng(64, PORTRAIT_MAX_DIM + 1);
    expect(png.length).toBeLessThan(PORTRAIT_MAX_BYTES);
    expect(() => validatePortrait(png)).toThrow(/PORTRAIT_TOO_LARGE_DIM: 64x1025/);
  });
});
