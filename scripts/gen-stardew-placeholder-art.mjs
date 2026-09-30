#!/usr/bin/env node
// scripts/gen-stardew-placeholder-art.mjs
//
// Renders the Sei companion's DEFAULT ART for the Stardew Valley mod
// (native/stardew-mod/SeiCompanion/Assets/{companion,portrait}.png): an
// original, deliberately simple pixel character in Sei's periwinkle, drawn
// here procedurally so nothing in the repo is copied from the game. Layout is
// the standard character sheet the game's AnimatedSprite expects for an NPC:
// 16x32 frames, four rows (down, right, up, left), four walk frames per row,
// 64x128 total. The portrait sheet is 128x128 (two 64x64 faces).
//
// Runs with plain node (a hand-rolled PNG encoder over zlib). Re-run after
// changing the pixels below; the PNGs are committed.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'native', 'stardew-mod', 'SeiCompanion', 'Assets');

// ── PNG encoder ─────────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Canvas ──────────────────────────────────────────────────────────────────
class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 4); }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = a;
  }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
}

// Palette: Sei periwinkle shirt, dark hair, warm skin, navy trousers.
const P = {
  hair: [58, 44, 74], hairHi: [92, 72, 118],
  skin: [244, 212, 176], skinSh: [214, 170, 132],
  eye: [40, 34, 52], mouth: [190, 100, 110],
  shirt: [127, 176, 255], shirtSh: [84, 128, 204],
  pants: [46, 52, 90], boot: [72, 48, 36],
  outline: [30, 24, 40],
};

// One 16x32 frame. dir: 0 down, 1 right, 2 up, 3 left. step: 0..3 walk cycle.
function drawFrame(c, ox, oy, dir, step) {
  const legShift = [0, 1, 0, -1][step]; // alternate legs
  const bob = step % 2 === 1 ? 1 : 0;   // body bob on the stride frames
  const top = oy + 2 + bob;
  // hair + head (6 wide, 7 tall at x 5..10)
  c.rect(ox + 5, top, 6, 2, P.hair);
  c.rect(ox + 4, top + 1, 8, 5, P.skin);
  c.rect(ox + 4, top + 1, 8, 1, P.hair);
  c.rect(ox + 4, top + 1, 1, 4, P.hair);
  c.rect(ox + 11, top + 1, 1, 4, P.hair);
  c.rect(ox + 6, top, 2, 1, P.hairHi);
  if (dir === 2) {
    // back of the head: all hair
    c.rect(ox + 4, top + 1, 8, 5, P.hair);
    c.rect(ox + 6, top + 2, 3, 1, P.hairHi);
  } else if (dir === 0) {
    c.set(ox + 6, top + 3, P.eye); c.set(ox + 9, top + 3, P.eye);
    c.set(ox + 7, top + 5, P.mouth); c.set(ox + 8, top + 5, P.mouth);
  } else {
    const ex = dir === 1 ? ox + 9 : ox + 6;
    c.set(ex, top + 3, P.eye);
    c.rect(dir === 1 ? ox + 4 : ox + 10, top + 1, 2, 5, P.hair);
  }
  // neck + shirt (torso 8 wide)
  c.rect(ox + 6, top + 6, 4, 1, P.skinSh);
  c.rect(ox + 4, top + 7, 8, 7, P.shirt);
  c.rect(ox + 4, top + 12, 8, 2, P.shirtSh);
  // arms swing opposite to legs
  const armY = top + 8 + (step === 1 ? 1 : step === 3 ? -1 : 0);
  c.rect(ox + 3, armY, 1, 4, P.shirtSh);
  c.rect(ox + 12, top + 8 - (step === 1 ? 1 : step === 3 ? -1 : 0), 1, 4, P.shirtSh);
  c.set(ox + 3, armY + 4, P.skin);
  c.set(ox + 12, top + 12 - (step === 1 ? 1 : step === 3 ? -1 : 0), P.skin);
  // pants + boots, legs offset by the stride
  c.rect(ox + 5, top + 14, 6, 6, P.pants);
  const ly = top + 20;
  c.rect(ox + 5, ly + Math.max(0, legShift), 2, 4 - Math.max(0, legShift), P.pants);
  c.rect(ox + 9, ly + Math.max(0, -legShift), 2, 4 - Math.max(0, -legShift), P.pants);
  c.rect(ox + 5, ly + 4, 2, 2, P.boot);
  c.rect(ox + 9, ly + 4, 2, 2, P.boot);
  // a subtle outline under the feet
  c.rect(ox + 5, ly + 6, 6, 1, [0, 0, 0, 40]);
}

function drawPortrait(c, ox, oy, happy) {
  // 64x64 face: big head, shoulders at the bottom.
  c.rect(ox + 14, oy + 6, 36, 8, P.hair);
  c.rect(ox + 12, oy + 12, 40, 30, P.skin);
  c.rect(ox + 12, oy + 12, 40, 4, P.hair);
  c.rect(ox + 12, oy + 12, 5, 22, P.hair);
  c.rect(ox + 47, oy + 12, 5, 22, P.hair);
  c.rect(ox + 20, oy + 7, 10, 3, P.hairHi);
  c.rect(ox + 22, oy + 24, 5, 5, P.eye);
  c.rect(ox + 37, oy + 24, 5, 5, P.eye);
  c.set(ox + 23, oy + 25, [255, 255, 255]);
  c.set(ox + 38, oy + 25, [255, 255, 255]);
  if (happy) {
    c.rect(ox + 26, oy + 34, 12, 2, P.mouth);
    c.set(ox + 25, oy + 33, P.mouth); c.set(ox + 38, oy + 33, P.mouth);
  } else {
    c.rect(ox + 28, oy + 34, 8, 2, P.mouth);
  }
  c.rect(ox + 26, oy + 42, 12, 4, P.skinSh);
  c.rect(ox + 10, oy + 46, 44, 18, P.shirt);
  c.rect(ox + 10, oy + 58, 44, 6, P.shirtSh);
}

const sheet = new Canvas(64, 128);
for (let dir = 0; dir < 4; dir++) for (let step = 0; step < 4; step++) drawFrame(sheet, step * 16, dir * 32, dir, step);
const portrait = new Canvas(128, 128);
drawPortrait(portrait, 0, 0, false);
drawPortrait(portrait, 64, 0, true);

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'companion.png'), encodePng(64, 128, sheet.px));
writeFileSync(path.join(OUT, 'portrait.png'), encodePng(128, 128, portrait.px));
console.log(`wrote ${path.relative(ROOT, OUT)}/companion.png (64x128) and portrait.png (128x128)`);
