// Dominant-color downsample: any square image → 64x64.
// For each target pixel, look at the source cell and pick the modal color
// (colors bucketed to 4 bits/channel to tolerate generation noise), then
// average the actual pixels in the winning bucket.
import sharp from 'sharp';
import { SKIN_SIZE } from './layout.js';

export async function toGrid(input, gridSize = SKIN_SIZE) {
  let img = sharp(input).ensureAlpha();
  const meta = await img.metadata();
  const side = Math.min(meta.width, meta.height);
  if (meta.width !== meta.height) {
    img = img.extract({ left: 0, top: 0, width: side, height: side });
  }
  // Normalize to a multiple of gridSize so cells align.
  const cell = Math.max(1, Math.floor(side / gridSize));
  const norm = cell * gridSize;
  const { data } = await img
    .resize(norm, norm, { kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, size: norm, cell };
}

function bucketKey(r, g, b, a) {
  if (a < 128) return 'T';
  return `${r >> 4},${g >> 4},${b >> 4}`;
}

export function dominantCell(data, size, cell, cx, cy) {
  const buckets = new Map();
  for (let y = cy * cell; y < (cy + 1) * cell; y++) {
    for (let x = cx * cell; x < (cx + 1) * cell; x++) {
      const i = (y * size + x) * 4;
      const key = bucketKey(data[i], data[i + 1], data[i + 2], data[i + 3]);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++;
      if (key !== 'T') {
        b.r += data[i];
        b.g += data[i + 1];
        b.b += data[i + 2];
      }
    }
  }
  let best = null;
  let bestKey = null;
  for (const [key, b] of buckets) {
    if (!best || b.n > best.n) {
      best = b;
      bestKey = key;
    }
  }
  if (bestKey === 'T') return [0, 0, 0, 0];
  return [
    Math.round(best.r / best.n),
    Math.round(best.g / best.n),
    Math.round(best.b / best.n),
    255,
  ];
}

/** Downsample an image to a 64x64 RGBA buffer using per-cell dominant color. */
export async function downsampleToSkin(input) {
  const { data, size, cell } = await toGrid(input);
  const out = Buffer.alloc(SKIN_SIZE * SKIN_SIZE * 4);
  for (let cy = 0; cy < SKIN_SIZE; cy++) {
    for (let cx = 0; cx < SKIN_SIZE; cx++) {
      const [r, g, b, a] = dominantCell(data, size, cell, cx, cy);
      const o = (cy * SKIN_SIZE + cx) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

export async function writeSkinPng(rgba, outFile) {
  await sharp(rgba, { raw: { width: SKIN_SIZE, height: SKIN_SIZE, channels: 4 } })
    .png()
    .toFile(outFile);
  return outFile;
}
