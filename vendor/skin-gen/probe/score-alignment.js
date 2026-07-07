// Score how well a generated atlas image aligns with the 64x64 skin layout.
// Measures, per face rect, the fraction of cells that are background vs
// textured, and reports faces that look empty (background-colored) — the
// signal for "the model drifted from the reference layout".
// Usage: node probe/score-alignment.js <atlas.png> [variant]
import { downsampleToSkin } from '../src/downsample.js';
import { estimateBackground, flatBaseFaces } from '../src/enforce.js';
import { faceRects, SKIN_SIZE, usedGrid } from '../src/layout.js';

const [, , file, variant = 'classic'] = process.argv;
if (!file) {
  console.error('usage: node probe/score-alignment.js <atlas.png> [variant]');
  process.exit(1);
}

const rgba = await downsampleToSkin(file);
const bg = estimateBackground(rgba, variant);
const idx = (x, y) => (y * SKIN_SIZE + x) * 4;

if (bg.transparentBg) {
  console.log('background: transparent');
} else {
  console.log(`background: rgb(${bg.color.map((c) => Math.round(c)).join(',')})`);
}

const isBg = (x, y) => {
  const i = idx(x, y);
  if (rgba[i + 3] < 128) return true;
  if (bg.transparentBg) return false;
  const d = Math.hypot(rgba[i] - bg.color[0], rgba[i + 1] - bg.color[1], rgba[i + 2] - bg.color[2]);
  return d <= 40;
};

// 1. Whitespace purity: never-rendered cells should be background.
const any = usedGrid(variant, 'both');
let wsTotal = 0, wsBg = 0;
for (let y = 0; y < SKIN_SIZE; y++)
  for (let x = 0; x < SKIN_SIZE; x++)
    if (!any[y][x]) { wsTotal++; if (isBg(x, y)) wsBg++; }

// 2. Base-face fill: base faces should NOT be background.
let baseTotal = 0, baseFilled = 0;
const weak = [];
for (const r of faceRects(variant, 'base')) {
  let filled = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) { n++; if (!isBg(x, y)) filled++; }
  baseTotal += n; baseFilled += filled;
  if (filled / n < 0.5) weak.push(`${r.part}.${r.face} (${Math.round((100 * filled) / n)}%)`);
}

const wsScore = wsBg / wsTotal;
const fillScore = baseFilled / baseTotal;
console.log(`whitespace purity: ${(100 * wsScore).toFixed(1)}% (background where nothing should render)`);
console.log(`base-face fill:    ${(100 * fillScore).toFixed(1)}% (texture where faces should be)`);
if (weak.length) console.log('weak faces:', weak.join(', '));
console.log('flat base faces:', flatBaseFaces(rgba, { variant }).join(', ') || 'none');
const aligned = wsScore > 0.85 && fillScore > 0.85;
console.log(aligned ? 'ALIGNMENT: GOOD' : 'ALIGNMENT: POOR');
