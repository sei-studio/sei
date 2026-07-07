// Deterministic-chain end-to-end test, no API required.
// Simulates a Nano Banana atlas output by degrading a real skin (8x upscale,
// black background, blur, noise), then checks the pipeline reconstructs the
// original skin.
import sharp from 'sharp';
import { characterToSkin } from '../src/pipeline.js';
import { loadRgba } from '../src/validate.js';
import { usedGrid, SKIN_SIZE } from '../src/layout.js';

// clawd-skin.png is the wide (classic) example; sui/lyra are slim.
const SRC = new URL('../examples/clawd-skin.png', import.meta.url).pathname;
const MOCK = 'out/mock-atlas.png';
const OUT = 'out/mock-skin.png';

// 1. Build the degraded fake "generated atlas".
const big = await sharp(SRC)
  .flatten({ background: '#000000' }) // opaque black bg like the prompt asks
  .resize(512, 512, { kernel: 'nearest' })
  .blur(0.8)
  .toBuffer();

// add per-pixel noise
const { data, info } = await sharp(big).raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i++) {
  const n = (Math.random() - 0.5) * 24;
  data[i] = Math.max(0, Math.min(255, data[i] + n));
}
await sharp(data, { raw: info }).png().toFile(MOCK);

// 2. Run the pipeline in mock mode.
const res = await characterToSkin('unused.png', OUT, { mockAtlas: MOCK, branch: 'atlas' });
console.log('pipeline result:', JSON.stringify(res, null, 2));

// 3. Compare reconstruction vs original over rendered pixels.
const orig = await loadRgba(SRC);
const got = await loadRgba(OUT);
const base = usedGrid('classic', 'base');
const any = usedGrid('classic', 'both');
let checked = 0;
let colorDiff = 0;
let alphaDiff = 0;
let maxD = 0;
for (let y = 0; y < SKIN_SIZE; y++) {
  for (let x = 0; x < SKIN_SIZE; x++) {
    if (!any[y][x]) continue;
    const i = (y * SKIN_SIZE + x) * 4;
    const oa = orig[i + 3] >= 128;
    const ga = got[i + 3] >= 128;
    if (!base[y][x]) {
      // overlay: check transparency decision matches
      checked++;
      if (oa !== ga) alphaDiff++;
      if (!oa || !ga) continue;
    } else {
      checked++;
    }
    const d = Math.hypot(orig[i] - got[i], orig[i + 1] - got[i + 1], orig[i + 2] - got[i + 2]);
    maxD = Math.max(maxD, d);
    if (d > 40) colorDiff++;
  }
}
console.log(
  `rendered pixels checked=${checked} colorDiff(>40)=${colorDiff} overlayAlphaMismatch=${alphaDiff} maxColorDist=${maxD.toFixed(1)}`
);
const pass = colorDiff / checked < 0.02 && alphaDiff / checked < 0.03;
console.log(pass ? 'MOCK E2E: PASS' : 'MOCK E2E: FAIL');
process.exit(pass ? 0 : 1);
