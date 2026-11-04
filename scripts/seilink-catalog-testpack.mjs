#!/usr/bin/env node
/**
 * A test overlay of the bundled room packs for the 261105 catalog features
 * that have no shipped art yet (screenshots and perf runs only, never
 * shipped):
 *
 *   node scripts/seilink-catalog-testpack.mjs --out <dir> [--no-particles]
 *
 * <dir> gets cozy, gamer, forest and _shared, every file a symlink to
 * resources/seilink-packs, with these changes:
 *  - cozy: every view has weather by time of day (day petals, dusk rain with
 *    drops on the glass, night snow), and a `lights` slot with code-drawn
 *    placeholder fairy lights (tintable, colour cycle, glow lit in its colour);
 *  - gamer and forest: unchanged (forest already ships fireflies and embers).
 * `--no-particles` then strips every particle field from all three packs
 * (the perf baseline: the same rooms with weather and ambience off).
 * Then pass `--packs <dir>` to seilink-editor-shots.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'resources/seilink-packs');
const i = process.argv.indexOf('--out');
if (i < 0 || !process.argv[i + 1]) {
  console.error('usage: seilink-catalog-testpack.mjs --out <dir>');
  process.exit(2);
}
const OUT = path.resolve(process.argv[i + 1]);
const STRIP = process.argv.includes('--no-particles');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.symlinkSync(path.join(SRC, '_shared'), path.join(OUT, '_shared'));
for (const pack of ['cozy', 'gamer', 'forest']) {
  fs.mkdirSync(path.join(OUT, pack));
  for (const f of fs.readdirSync(path.join(SRC, pack))) {
    if (f === 'manifest.json') continue;
    fs.symlinkSync(path.join(SRC, pack, f), path.join(OUT, pack, f));
  }
  fs.copyFileSync(path.join(SRC, pack, 'manifest.json'), path.join(OUT, pack, 'manifest.json'));
}

// ── cozy: weather on every view ──
const cozyPath = path.join(OUT, 'cozy', 'manifest.json');
const cozy = JSON.parse(fs.readFileSync(cozyPath, 'utf8'));
for (const c of cozy.components) {
  if (c.slot !== 'view') continue;
  c.frames.day.particles = [{ kind: 'petals', density: 0.8 }];
  c.frames.dusk.particles = [{ kind: 'rain', glass: true }];
  c.frames.night.particles = [{ kind: 'snow' }];
}

// ── cozy: placeholder fairy lights along the left wall and over the bed ──
const [W, H] = cozy.canvas;
/** Points along a sagging string between a and b. */
function swag(a, b, sag, step) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.round(len / step));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + sag * 4 * t * (1 - t)]);
  }
  return pts;
}
const strings = [swag([20, 92], [462, 214], 60, 40), swag([470, 214], [1092, 80], 90, 40)];
const wire = strings.map((pts) => `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#3a3128" stroke-width="3" stroke-linejoin="round"/>`).join('');
const bulbs = strings.flatMap((pts) => pts.slice(1, -1));
const bulb = (fill, extra = '') =>
  bulbs.map(([x, y], k) => `<ellipse cx="${x.toFixed(1)}" cy="${(y + 11).toFixed(1)}" rx="${k % 2 ? 8 : 9}" ry="${k % 2 ? 11 : 12}" fill="${fill}" ${extra}/>`).join('');
const caps = bulbs.map(([x, y]) => `<rect x="${(x - 4).toFixed(1)}" y="${(y - 2).toFixed(1)}" width="8" height="6" rx="1" fill="#2d2924"/>`).join('');
const svg = (body, defs = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs>${body}</svg>`);
const shade = `<radialGradient id="g" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#bdbdbd"/></radialGradient>`;
const blur = `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>`;
await sharp(svg(wire + bulb('url(#g)') + caps, shade)).webp({ quality: 90 }).toFile(path.join(OUT, 'cozy', 'test_fairy.webp'));
await sharp(svg(bulb('#ffffff'))).webp({ lossless: true }).toFile(path.join(OUT, 'cozy', 'test_fairy_mask.webp'));
const glowBody = bulbs.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${(y + 12).toFixed(1)}" r="34" fill="#ffffff" fill-opacity="0.55"/>`).join('');
await sharp({ create: { width: W, height: H, channels: 4, background: '#000000ff' } })
  .composite([{ input: svg(`<g filter="url(#b)">${glowBody}</g>`, blur) }])
  .webp({ quality: 85 })
  .toFile(path.join(OUT, 'cozy', 'test_fairy_glow.webp'));

cozy.slots.lights = { z: 35, options: ['test_fairy_lights'], optional: true };
const frame = { src: 'test_fairy.webp', mask: 'test_fairy_mask.webp' };
cozy.components.push({
  id: 'test_fairy_lights',
  slot: 'lights',
  name: 'fairy lights',
  tintable: true,
  cycle: true,
  defaultTint: '#ffd27a',
  swatches: ['#ffd27a', '#fff3d6', '#ff8fb8', '#8fd0ff', '#a8ff9a', '#c9a6ff'],
  frames: {
    day: frame,
    dusk: { ...frame, glow: 'test_fairy_glow.webp', glowTint: true },
    night: { ...frame, glow: 'test_fairy_glow.webp', glowTint: true, effect: 'pulse' },
  },
});
fs.writeFileSync(cozyPath, JSON.stringify(cozy, null, 2) + '\n');

if (STRIP) {
  for (const pack of ['cozy', 'gamer', 'forest']) {
    const file = path.join(OUT, pack, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of m.components) for (const f of Object.values(c.frames)) delete f.particles;
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  }
}
console.log(OUT);
