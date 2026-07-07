// Fallback branch tests, no API needed.
//  1. Real character image: valid skin, byte-identical across runs.
//  2. Synthetic figure with known colors: the top colors must route to the
//     right template slots (primary -> shirt, secondary -> pants,
//     tertiary -> hair).
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { characterToSkin } from '../src/pipeline.js';
import { fallbackAtlas, extractColors } from '../src/fallback.js';
import { parts, SKIN_SIZE } from '../src/layout.js';

const SRC = new URL('../examples/sui-input.png', import.meta.url).pathname;
const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

// 1. Real image: valid + deterministic.
const r1 = await characterToSkin(SRC, 'out/fallback-a.png', { branch: 'fallback' });
const r2 = await characterToSkin(SRC, 'out/fallback-b.png', { branch: 'fallback' });
const [a, b] = await Promise.all([readFile('out/fallback-a.png'), readFile('out/fallback-b.png')]);
check('valid skin', r1.valid && r2.valid);
check('deterministic', a.equals(b));
check('fallback branch reported', r1.branch === 'fallback');

// 2. Synthetic fixture: green (largest area), then blue, then red, on a
// plain background that must be excluded from extraction.
const w = 200, h = 400;
const buf = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = [232, 232, 236]; // background
    if (x >= 40 && x < 160 && y >= 60 && y < 210) c = [40, 170, 60]; // green, largest
    else if (x >= 60 && x < 140 && y >= 210 && y < 340) c = [40, 70, 200]; // blue
    else if (x >= 80 && x < 120 && y >= 10 && y < 60) c = [200, 40, 40]; // red
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }
await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile('out/fixture-colors.png');

const colors = await extractColors('out/fixture-colors.png');
check('primary is green', colors[0][1] > colors[0][0] && colors[0][1] > colors[0][2], colors[0].join(','));
check('secondary is blue', colors[1][2] > colors[1][0] && colors[1][2] > colors[1][1], colors[1].join(','));
check('tertiary is red', colors[2][0] > colors[2][1] && colors[2][0] > colors[2][2], colors[2].join(','));

const P = parts('classic');
const atlas = await fallbackAtlas('out/fixture-colors.png');
const at = (rect, x, y) => {
  const i = AIDX(rect.x + x, rect.y + y);
  return [atlas[i], atlas[i + 1], atlas[i + 2]];
};
const shirtPx = at(P.body.base.front, 4, 6);
const pantsPx = at(P.rightLeg.base.front, 2, 5);
const hairPx = at(P.head.base.top, 4, 4);
check('shirt recolored green', shirtPx[1] > shirtPx[0] && shirtPx[1] > shirtPx[2], shirtPx.join(','));
check('pants recolored blue', pantsPx[2] > pantsPx[0] && pantsPx[2] > pantsPx[1], pantsPx.join(','));
check('hair recolored red', hairPx[0] > hairPx[1] && hairPx[0] > hairPx[2], hairPx.join(','));

console.log(failures === 0 ? 'FALLBACK: PASS' : `FALLBACK: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
