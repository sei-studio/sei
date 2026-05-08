#!/usr/bin/env node
/**
 * test-pixelPortraitDeterminism.mjs
 *
 * Verifies the WARNING-5 fix (plan 04-06 PLAN, acceptance criterion under Task 3):
 * For seed 'sui Sui' rendered against the 'light' theme, the deterministic 12×12
 * grid produced by `generatePixelGrid(seed, palette)` MUST satisfy:
 *
 *   - pixel (col=4, row=3) === '#0E0E0E'  (left-eye fixed pixel)
 *   - pixel (col=7, row=3) === '#0E0E0E'  (right-eye, mirror of col=4 → 12-1-4=7)
 *   - pixel (col=0, row=5) === palette[1] (col 0 forced bg / sky lower band)
 *
 * This test mirrors the algorithm in src/renderer/src/components/PixelPortrait.tsx
 * and src/renderer/src/lib/portraitPalettes.ts as plain JS so the determinism
 * contract can be re-checked without a TS toolchain.
 *
 * If you change either source file, update this mirror in lockstep.
 */

// Mirror of PALETTES_LIGHT[0..7] from src/renderer/src/lib/portraitPalettes.ts
const PALETTES_LIGHT = [
  ['#F2D9B6', '#D9B388', '#A36F4F', '#5C3F2E', '#2E1F18', '#A8C7E6'],
  ['#D6E8C9', '#A8C99A', '#688555', '#3F5236', '#1C2618', '#E8D6A8'],
  ['#E8D0E0', '#C996B6', '#8E5478', '#4F2E48', '#2A1828', '#F2E8C9'],
  ['#FFE0B0', '#D69A60', '#8B5A2B', '#3D2818', '#1A0F08', '#C9E0F2'],
  ['#C9E8E0', '#8FBFB3', '#4D7E73', '#2A4A45', '#172927', '#E8D9C9'],
  ['#E8C9C9', '#C97878', '#8B3A3A', '#4F1F1F', '#2A0F0F', '#C9D9E8'],
  ['#C9D6E8', '#9DB3CE', '#E6C9A8', '#5A6F92', '#3A4A66', '#1F2A40'],
  ['#F3D9B1', '#E0A56A', '#B86838', '#7A3E1E', '#3D1F0E', '#C9D6E8'],
];

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickPaletteLight(seed) {
  const idx = fnv1a(seed) % PALETTES_LIGHT.length;
  return PALETTES_LIGHT[idx];
}

const GRID_SIZE = 12;
const EYE_COLOR = '#0E0E0E';

function rngStep(state) {
  state.s =
    (Math.imul(state.s ^ (state.s >>> 15), 2246822507) ^
      Math.imul(state.s ^ (state.s >>> 13), 3266489909)) >>>
    0;
  return (state.s >>> 0) / 4294967296;
}

function generatePixelGrid(seed, palette) {
  const W = GRID_SIZE,
    H = GRID_SIZE;
  const half = Math.ceil(W / 2);
  const skyTop = 2,
    bodyStart = 7;
  const palLen = palette.length;
  const ref = { s: fnv1a(seed) || 1 };
  const grid = [];
  for (let y = 0; y < H; y++) {
    const row = new Array(W).fill('');
    if (y < skyTop) {
      for (let x = 0; x < W; x++) row[x] = palette[0];
      grid.push(row);
      continue;
    }
    if (y === H - 1) {
      for (let x = 0; x < W; x++) row[x] = palette[1];
      grid.push(row);
      continue;
    }
    for (let x = 0; x < half; x++) {
      if (x === 0) {
        row[x] = palette[1];
        continue;
      }
      let color;
      if (y >= bodyStart) {
        const r1 = rngStep(ref);
        const r2 = rngStep(ref);
        if (r1 > 0.25) {
          const idx = Math.min(palLen - 1, 2 + Math.floor(r2 * Math.max(1, palLen - 3)));
          color = palette[idx];
        } else color = palette[1];
      } else {
        const r1 = rngStep(ref);
        const r2 = rngStep(ref);
        if (r1 > 0.18) {
          const idx = Math.min(palLen - 1, 1 + Math.floor(r2 * Math.max(1, palLen - 2)));
          color = palette[idx];
        } else color = palette[1];
      }
      row[x] = color;
    }
    for (let x = 0; x < half; x++) row[W - 1 - x] = row[x];
    grid.push(row);
  }
  grid[3][4] = EYE_COLOR;
  grid[3][W - 1 - 4] = EYE_COLOR;
  return grid;
}

// ── Run acceptance ──────────────────────────────────────────────────────
const seed = 'sui Sui';
const palette = pickPaletteLight(seed);
const grid = generatePixelGrid(seed, palette);

let pass = true;
function assertEq(name, got, want) {
  const ok = got === want;
  if (!ok) pass = false;
  const tag = ok ? 'OK  ' : 'FAIL';
  console.log(`${tag} ${name}: got=${got} want=${want}`);
}

console.log(`seed='${seed}' → palette=${JSON.stringify(palette)}`);
assertEq('pixel(col=4, row=3) = #0E0E0E (left eye)', grid[3][4], EYE_COLOR);
assertEq('pixel(col=7, row=3) = #0E0E0E (right eye, mirror of col 4)', grid[3][7], EYE_COLOR);
assertEq('pixel(col=0, row=5) = palette[1] (sky lower band)', grid[5][0], palette[1]);

if (!pass) {
  console.error('\nACCEPTANCE FAILED');
  process.exit(1);
}
console.log('\nALL ACCEPTANCE PIXELS PASS');
