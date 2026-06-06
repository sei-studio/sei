#!/usr/bin/env node
/**
 * Generate three deterministic 64×64 PNG skins for the three bundled default
 * personas (Sui, Mochineko, Clawd). Writes them to `resources/skins/<id>.png`.
 *
 * Why hand-rolled: shipping a runtime image-encoding dependency (sharp,
 * pngjs, jimp) just to emit three placeholder squares would bloat the
 * Electron build for zero payoff. The PNG spec is short enough to inline.
 * Output is exactly Steve-format-compatible 64×64 RGBA — CustomSkinLoader
 * accepts these as legal skins and the 3D preview renders them.
 *
 * Real art ships in a later quick task. The placeholders use distinguishable
 * per-persona color schemes so the user can tell them apart in-game.
 *
 * Encoding details:
 *   - Color type 6 (RGBA), bit depth 8.
 *   - One IDAT chunk holding the zlib-deflated scanlines with filter byte 0
 *     (None) prepended to each row.
 *   - PNG CRC32 is the standard ISO/IEC 13239 polynomial 0xEDB88320.
 *
 * Run:
 *   node scripts/build-default-skins.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'resources', 'skins');
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Per-persona color schemes. Modern (post-1.8) MC skin layout is 64×64; the
 * head front face occupies x=8..15, y=8..15. We fill the whole canvas with
 * the body color and stamp the head front in the head color so each skin
 * has a visibly distinct face in the 3D preview.
 *
 * Colors are RGBA bytes [r, g, b, a]. Alpha is 255 (opaque) everywhere —
 * MC accepts transparency only on the outer (overlay) layers and we're not
 * using those here.
 */
const PALETTES = {
  sui:       { body: [225, 188, 226, 255], head: [255, 215,   0, 255] }, // peach body, gold head
  mochineko: { body: [120, 100,  90, 255], head: [255, 245, 230, 255] }, // muted brown body, cream head
  clawd:     { body: [ 80,  90, 110, 255], head: [110, 130, 150, 255] }, // slate body, lighter slate head
};

// -------------------------------------------------------------------------- //
// CRC32 (PNG variant)                                                        //
// -------------------------------------------------------------------------- //

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// -------------------------------------------------------------------------- //
// PNG chunk helpers                                                          //
// -------------------------------------------------------------------------- //

/** Build a PNG chunk: 4B length || 4B type || data || 4B CRC32(type+data). */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode a 64×64 RGBA pixel buffer to a PNG file. `pixels` length must be
 * 64 * 64 * 4. Returns a Buffer ready to write to disk.
 */
function buildPng(pixels) {
  if (pixels.length !== 64 * 64 * 4) {
    throw new Error(`expected 64×64×4 = ${64 * 64 * 4} bytes, got ${pixels.length}`);
  }

  // PNG signature (8 bytes).
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR: 13 bytes
  //   width(4) height(4) bitdepth(1) colortype(1) compression(1) filter(1) interlace(1)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);   // width
  ihdr.writeUInt32BE(64, 4);   // height
  ihdr.writeUInt8(8, 8);       // bit depth
  ihdr.writeUInt8(6, 9);       // color type 6 (truecolor + alpha)
  ihdr.writeUInt8(0, 10);      // compression: deflate
  ihdr.writeUInt8(0, 11);      // filter: adaptive
  ihdr.writeUInt8(0, 12);      // interlace: none

  // IDAT: each scanline gets a filter byte (0 = None) prepended.
  const rowBytes = 64 * 4;
  const raw = Buffer.alloc(64 * (1 + rowBytes));
  for (let y = 0; y < 64; y++) {
    raw[y * (1 + rowBytes)] = 0; // filter byte
    pixels.copy(raw, y * (1 + rowBytes) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------------- //
// Per-persona pixel buffers                                                  //
// -------------------------------------------------------------------------- //

function buildPersonaPixels(palette) {
  const pixels = Buffer.alloc(64 * 64 * 4);
  const body = Buffer.from(palette.body);
  const head = Buffer.from(palette.head);

  // 1. fill the entire image with body color.
  for (let i = 0; i < pixels.length; i += 4) {
    body.copy(pixels, i, 0, 4);
  }

  // 2. stamp the head front face at x=8..15, y=8..15 (modern MC skin layout).
  for (let y = 8; y < 16; y++) {
    for (let x = 8; x < 16; x++) {
      const off = (y * 64 + x) * 4;
      head.copy(pixels, off, 0, 4);
    }
  }

  return pixels;
}

// -------------------------------------------------------------------------- //
// Main                                                                       //
// -------------------------------------------------------------------------- //

let wrote = 0;
for (const [name, palette] of Object.entries(PALETTES)) {
  const pixels = buildPersonaPixels(palette);
  const png = buildPng(pixels);
  const outPath = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(outPath, png);
  wrote++;
  // Sanity-check the magic on what we just wrote.
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4E || png[3] !== 0x47) {
    throw new Error(`bad PNG magic in ${outPath}`);
  }
  console.log(`[build-default-skins] wrote ${outPath} (${png.length} bytes)`);
}
console.log(`[build-default-skins] done — ${wrote} skins`);
