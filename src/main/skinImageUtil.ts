/**
 * PNG IHDR parser + legacy 64×32 → 64×64 Minecraft-skin normalizer.
 *
 * Pure-Node implementation (no `sharp`, no `pngjs` runtime dep). The only
 * consumer is mojangSkinLookup.ts: Mojang serves legacy 64×32 skins for
 * ancient accounts (Notch's skin was 64×32 until the 2014 model migration;
 * many older accounts never re-uploaded). applyPng gates strictly on 64×64,
 * so we normalize HERE — before applyPng ever sees the bytes — to keep the
 * legacy-account fallback working.
 *
 * Modern 64×64 layout vs legacy 64×32:
 *   - Modern has explicit left-leg + left-arm rectangles in the bottom half
 *     (y=32..63) that legacy 64×32 doesn't include. Vanilla MC fills the left
 *     side by mirroring the right side; we replicate that here so the bot
 *     renders correctly on the user's MC client.
 *   - Legacy right-leg block: source (0..15,  16..31) → modern left-leg block
 *     at dest (16..31, 48..63), horizontally mirrored (vanilla flips so the
 *     limb faces the correct direction).
 *   - Legacy right-arm block: source (40..55, 16..31) → modern left-arm block
 *     at dest (32..47, 48..63), horizontally mirrored.
 *   - All other bottom-half pixels are transparent (0,0,0,0).
 *
 * v1 only handles bit-depth 8 + color-type 6 (RGBA) — Mojang's
 * canonical skin format. Any other PNG combination throws a clear error
 * that mojangSkinLookup's error classifier converts to a MOJANG_LOOKUP_FAILED
 * prefix for the renderer.
 *
 * Sources:
 *   - https://minecraft.wiki/w/Skin#Versions (legacy vs modern dimensions)
 *   - https://minecraft.wiki/w/Skin#File_format (mirror rectangle coordinates)
 *   - PNG spec (RFC 2083) §11.2 IHDR, §9 Filter algorithms
 */
import { inflateSync, deflateSync } from 'node:zlib';

/** Parsed PNG header dims + format bytes. */
export interface PngHeader {
  width: number;
  height: number;
  /** PNG bit depth — 8 for Mojang skins. */
  bitDepth: number;
  /** PNG color type — 6 (RGBA) for Mojang skins. Other types: 0 grayscale, 2 RGB, 3 indexed, 4 GA. */
  colorType: number;
}

/** PNG signature bytes (RFC 2083 §3.1). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read the IHDR chunk that immediately follows the 8-byte PNG signature.
 *
 * Chunk layout: 4-byte length (must be 13 for IHDR) | 4-byte type ("IHDR")
 *               | 13-byte data (width 4 + height 4 + bitDepth 1 + colorType 1
 *                             + compression 1 + filter 1 + interlace 1)
 *               | 4-byte CRC32 (not validated — Mojang doesn't send corrupt PNGs)
 *
 * Throws clear errors on signature mismatch / wrong IHDR length / out-of-bounds.
 */
export function parsePngIhdr(buffer: Buffer): PngHeader {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('parsePngIhdr: input is not a Buffer');
  }
  if (buffer.length < 8 + 8 + 13) {
    throw new Error(`parsePngIhdr: buffer too short (${buffer.length} bytes) to contain PNG signature + IHDR`);
  }
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) {
      throw new Error('parsePngIhdr: not a PNG (signature mismatch)');
    }
  }
  // IHDR chunk header: length at offset 8, type at offset 12.
  const ihdrLength = buffer.readUInt32BE(8);
  if (ihdrLength !== 13) {
    throw new Error(`parsePngIhdr: first chunk has length ${ihdrLength}, expected 13 for IHDR`);
  }
  const type = buffer.slice(12, 16).toString('ascii');
  if (type !== 'IHDR') {
    throw new Error(`parsePngIhdr: first chunk type is '${type}', expected 'IHDR'`);
  }
  // IHDR data starts at offset 16 (after 8 sig + 4 length + 4 type).
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  return { width, height, bitDepth, colorType };
}

/**
 * Concatenate all IDAT chunks in a PNG buffer. The PNG spec allows splitting
 * the image data across multiple IDAT chunks; we re-assemble before inflating.
 */
function collectIdat(buffer: Buffer): Buffer {
  const idats: Buffer[] = [];
  let offset = 8; // skip signature
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`collectIdat: chunk '${type}' length ${length} runs past buffer end`);
    }
    if (type === 'IDAT') {
      idats.push(buffer.slice(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip past CRC
  }
  if (idats.length === 0) {
    throw new Error('collectIdat: PNG has no IDAT chunks');
  }
  return Buffer.concat(idats);
}

/**
 * Reverse PNG scanline filtering on an inflated RGBA8 image. For each row:
 *   filter byte (0..4) | width * 4 pixel bytes
 *
 * Filter types per RFC 2083 §9:
 *   0 None    : no transform (most Mojang skins)
 *   1 Sub     : add the previous pixel (left)
 *   2 Up      : add the pixel above (prior row)
 *   3 Average : add floor((left + above) / 2)
 *   4 Paeth   : add Paeth predictor of left/above/upper-left
 *
 * Returns a width*height*4 pixel buffer (no filter bytes).
 */
function unfilter(inflated: Buffer, width: number, height: number): Buffer {
  const bpp = 4; // RGBA8 = 4 bytes/pixel
  const rowBytes = width * bpp;
  const stride = 1 + rowBytes; // filter byte + row
  if (inflated.length !== stride * height) {
    throw new Error(
      `unfilter: inflated data is ${inflated.length} bytes, expected ${stride * height} for ${width}×${height} RGBA8`,
    );
  }
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    const rowStart = y * stride + 1;
    const outRowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[rowStart + x];
      const left = x >= bpp ? out[outRowStart + x - bpp] : 0;
      const up = y > 0 ? out[outRowStart - rowBytes + x] : 0;
      const upLeft = (y > 0 && x >= bpp) ? out[outRowStart - rowBytes + x - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0: val = raw; break;
        case 1: val = raw + left; break;
        case 2: val = raw + up; break;
        case 3: val = raw + Math.floor((left + up) / 2); break;
        case 4: val = raw + paethPredictor(left, up, upLeft); break;
        default:
          throw new Error(`unfilter: unsupported PNG filter type ${filter} at row ${y}`);
      }
      out[outRowStart + x] = val & 0xff;
    }
  }
  return out;
}

/** Paeth predictor (RFC 2083 §9.4). */
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** CRC32 (PNG variant, polynomial 0xEDB88320) — same as scripts/build-default-skins.mjs. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a PNG chunk: 4B length | 4B type | data | 4B CRC32(type+data). */
function buildChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode a 64×64 RGBA8 pixel buffer to a PNG.
 * Mirrors scripts/build-default-skins.mjs.buildPng exactly (filter byte 0 per
 * row, single IDAT chunk, IEND trailer). Output is a valid PNG that
 * applyPng's downstream magic+IHDR check will accept.
 */
function encodePng64x64(pixels: Buffer): Buffer {
  if (pixels.length !== 64 * 64 * 4) {
    throw new Error(`encodePng64x64: expected ${64 * 64 * 4} bytes, got ${pixels.length}`);
  }
  // IHDR: 13 bytes.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); // width
  ihdr.writeUInt32BE(64, 4); // height
  ihdr.writeUInt8(8, 8);     // bit depth
  ihdr.writeUInt8(6, 9);     // color type 6 (RGBA)
  ihdr.writeUInt8(0, 10);    // compression
  ihdr.writeUInt8(0, 11);    // filter
  ihdr.writeUInt8(0, 12);    // interlace

  // Scanlines: filter byte 0 (None) prepended to each row.
  const rowBytes = 64 * 4;
  const raw = Buffer.alloc(64 * (1 + rowBytes));
  for (let y = 0; y < 64; y++) {
    raw[y * (1 + rowBytes)] = 0;
    pixels.copy(raw, y * (1 + rowBytes) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Normalize a Mojang skin PNG to 64×64.
 *
 *   - 64×64 input → returns the input unchanged (zero-copy fast path; modern skins).
 *   - 64×32 input → upscales to 64×64 via the canonical legacy → modern conversion
 *     (mirror right leg/arm into the left-side slots, fill remaining bottom-half
 *     pixels transparent). Returns a NEW PNG buffer.
 *   - Anything else → throws `normalize64x64: unsupported dimensions ...`.
 *
 * Only handles bit depth 8 + color type 6 (RGBA) — Mojang's canonical format.
 * Throws on any other format combo so the renderer can surface a clean error.
 *
 * mojangSkinLookup calls this BEFORE returning bytes to the renderer,
 * ensuring applyPng's strict 64×64 gate never rejects an ancient-account skin.
 */
export function normalize64x64(buffer: Buffer): Buffer {
  const header = parsePngIhdr(buffer);
  const { width, height, bitDepth, colorType } = header;

  if (width === 64 && height === 64) {
    // Modern skin — return as-is.
    return buffer;
  }
  if (width === 64 && height === 32) {
    // Legacy skin — perform the canonical mirror conversion.
    if (bitDepth !== 8 || colorType !== 6) {
      throw new Error(
        `normalize64x64: legacy skin must be 8-bit RGBA (got bitDepth=${bitDepth}, colorType=${colorType})`,
      );
    }
    const idatBytes = collectIdat(buffer);
    const inflated = inflateSync(idatBytes);
    const srcPixels = unfilter(inflated, width, height); // 64×32 RGBA buffer

    // Destination is 64×64 transparent (Buffer.alloc zero-fills, so alpha = 0 everywhere).
    const dst = Buffer.alloc(64 * 64 * 4);

    // 1) Copy entire 64×32 source into rows 0..31 of dest.
    srcPixels.copy(dst, 0, 0, srcPixels.length);

    // 2) Mirror legacy right leg (src 0..15, 16..31) → modern left leg (dst 16..31, 48..63).
    //    Source pixel (sx, sy) lands at (31 - sx, sy + 32). Verify: sx=0 → dx=31; sx=15 → dx=16.
    for (let sy = 16; sy < 32; sy++) {
      for (let sx = 0; sx < 16; sx++) {
        const dx = 31 - sx;
        const dy = sy + 32;
        const srcOff = (sy * 64 + sx) * 4;
        const dstOff = (dy * 64 + dx) * 4;
        dst[dstOff]     = srcPixels[srcOff];
        dst[dstOff + 1] = srcPixels[srcOff + 1];
        dst[dstOff + 2] = srcPixels[srcOff + 2];
        dst[dstOff + 3] = srcPixels[srcOff + 3];
      }
    }

    // 3) Mirror legacy right arm (src 40..55, 16..31) → modern left arm (dst 32..47, 48..63).
    //    Source pixel (sx, sy) lands at (87 - sx, sy + 32). Verify: sx=40 → dx=47; sx=55 → dx=32.
    for (let sy = 16; sy < 32; sy++) {
      for (let sx = 40; sx < 56; sx++) {
        const dx = 87 - sx;
        const dy = sy + 32;
        const srcOff = (sy * 64 + sx) * 4;
        const dstOff = (dy * 64 + dx) * 4;
        dst[dstOff]     = srcPixels[srcOff];
        dst[dstOff + 1] = srcPixels[srcOff + 1];
        dst[dstOff + 2] = srcPixels[srcOff + 2];
        dst[dstOff + 3] = srcPixels[srcOff + 3];
      }
    }

    return encodePng64x64(dst);
  }

  throw new Error(`normalize64x64: unsupported dimensions ${width}×${height}; expected 64×64 or 64×32`);
}
