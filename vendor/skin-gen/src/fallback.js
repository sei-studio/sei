// Deterministic no-LLM fallback: a fixed template skin (default hair style,
// textured shirt and pants, Steve/Alex-like skin tone, fixed eyes and mouth)
// recolored with the character's top colors. Primary color becomes the shirt,
// secondary the pants, tertiary the hair. No API calls, no randomness: the
// same input always produces a byte-identical skin.
import sharp from 'sharp';
import { SKIN_SIZE, parts } from './layout.js';

const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const darken = (c, f) => c.map((v) => clamp(v * f));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const SKIN = [224, 172, 130]; // fixed skin tone, between Steve and Alex
const DEFAULTS = { shirt: [92, 120, 158], pants: [64, 72, 94], hair: [82, 60, 43] };

// --- color extraction --------------------------------------------------------

async function loadScaled(input, maxW = 128) {
  const meta = await sharp(input).metadata();
  let s = sharp(input).ensureAlpha();
  if (meta.width > maxW) {
    s = s.resize(maxW, Math.max(1, Math.round((meta.height * maxW) / meta.width)));
  }
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/**
 * Top distinct colors of the image, most frequent first, with background
 * colors (frequent border-ring buckets) excluded. Exported for tests.
 */
export async function extractColors(input, count = 3) {
  const { data, w, h } = await loadScaled(input);
  const bucketOf = (i) => `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;

  // Background = frequent buckets in the border ring.
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const ring = new Map();
  let ringTotal = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= m && x < w - m && y >= m && y < h - m) continue;
      ringTotal++;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      const key = bucketOf(i);
      ring.set(key, (ring.get(key) ?? 0) + 1);
    }
  const background = new Set();
  for (const [key, n] of ring) if (n >= ringTotal * 0.02) background.add(key);

  // Histogram of everything else.
  const buckets = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      const key = bucketOf(i);
      if (background.has(key)) continue;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    }

  // Greedy pick: most frequent buckets that are mutually distinct.
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const colors = [];
  for (const b of sorted) {
    const c = [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round);
    if (colors.every((p) => dist(p, c) >= 60)) colors.push(c);
    if (colors.length === count) break;
  }
  return colors;
}

// --- template painting -------------------------------------------------------

// Deterministic pixel hash for texture. No alternating patterns: a regular
// checker reads as PNG transparency at skin resolution.
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Cloth texture like the default Minecraft skins: mostly flat with scattered
// clusters of darker pixels.
function texMul(x, y, spots) {
  let m = 1 + ((hash2(x, y) % 5) - 2) * 0.01;
  if (spots) {
    const s = hash2(x + 101, y + 57) % 100;
    if (s < 10) m *= 0.84;
    else if (s < 18) m *= 0.92;
  }
  return m;
}

function fill(atlas, rect, color, mul = 1, spots = false) {
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const i = AIDX(rect.x + x, rect.y + y);
      const j = texMul(rect.x + x, rect.y + y, spots) * mul;
      atlas[i] = clamp(color[0] * j);
      atlas[i + 1] = clamp(color[1] * j);
      atlas[i + 2] = clamp(color[2] * j);
      atlas[i + 3] = 255;
    }
}

const rows = (r, y0, y1) => ({ x: r.x, y: r.y + y0, w: r.w, h: y1 - y0 });

function px(atlas, rect, x, y, color) {
  const i = AIDX(rect.x + x, rect.y + y);
  atlas[i] = clamp(color[0]);
  atlas[i + 1] = clamp(color[1]);
  atlas[i + 2] = clamp(color[2]);
  atlas[i + 3] = 255;
}

// Per-side brightness so the box shape reads in game.
const SIDE_MUL = { front: 1, back: 0.92, right: 0.85, left: 0.85 };

/**
 * Paint the recolored template onto a valid 64x64 skin atlas buffer.
 * Overlay layer is left fully transparent.
 */
export async function fallbackAtlas(characterImage, { variant = 'classic' } = {}) {
  const [primary, secondary, tertiary] = await extractColors(characterImage);
  const shirt = primary ?? DEFAULTS.shirt;
  const pants = secondary ?? darken(shirt, 0.55);
  const hair = tertiary ?? DEFAULTS.hair;

  const P = parts(variant);
  const atlas = Buffer.alloc(SKIN_SIZE * SKIN_SIZE * 4);

  // Head: default hair style. Full hair on top and back, hair over the upper
  // sides, and on the front a fringe with a center part plus side locks
  // framing the face.
  const H = P.head.base;
  fill(atlas, H.top, hair, 0.95);
  fill(atlas, H.back, hair, 0.92);
  for (const side of ['right', 'left']) {
    fill(atlas, rows(H[side], 0, 5), hair, SIDE_MUL[side]);
    fill(atlas, rows(H[side], 5, 8), SKIN, SIDE_MUL[side]);
  }
  fill(atlas, H.front, SKIN);
  fill(atlas, rows(H.front, 0, 2), hair);
  px(atlas, H.front, 0, 2, hair); px(atlas, H.front, 1, 2, hair); // fringe dip
  px(atlas, H.front, 6, 2, hair); px(atlas, H.front, 7, 2, hair);
  px(atlas, H.front, 0, 3, hair); px(atlas, H.front, 7, 3, hair); // side locks
  px(atlas, H.front, 0, 4, hair); px(atlas, H.front, 7, 4, hair);
  fill(atlas, H.bottom, SKIN, 0.7);
  // 3D hair layer: the hat overlay carries the same hair slightly lighter,
  // so it stands off the head in game.
  const HO = P.head.overlay;
  fill(atlas, HO.top, darken(hair, 1.08));
  fill(atlas, HO.back, hair, 0.96);
  for (const side of ['right', 'left']) fill(atlas, rows(HO[side], 0, 5), hair, 0.9);
  fill(atlas, rows(HO.front, 0, 2), darken(hair, 1.05));
  px(atlas, HO.front, 0, 2, hair); px(atlas, HO.front, 1, 2, hair);
  px(atlas, HO.front, 6, 2, hair); px(atlas, HO.front, 7, 2, hair);
  px(atlas, HO.front, 0, 3, hair); px(atlas, HO.front, 7, 3, hair);
  px(atlas, HO.front, 0, 4, hair); px(atlas, HO.front, 7, 4, hair);
  // Fixed face: eye whites, pupils, mouth.
  px(atlas, H.front, 1, 5, [245, 245, 245]);
  px(atlas, H.front, 6, 5, [245, 245, 245]);
  px(atlas, H.front, 2, 5, [38, 38, 48]);
  px(atlas, H.front, 5, 5, [38, 38, 48]);
  px(atlas, H.front, 3, 7, darken(SKIN, 0.55));
  px(atlas, H.front, 4, 7, darken(SKIN, 0.55));

  // Body: shirt with a collar row and a darker hem.
  const B = P.body.base;
  for (const side of ['front', 'back', 'right', 'left']) {
    const mul = SIDE_MUL[side];
    fill(atlas, B[side], shirt, mul, true);
    fill(atlas, rows(B[side], 0, 1), darken(shirt, 0.85), mul); // collar
    fill(atlas, rows(B[side], 11, 12), darken(shirt, 0.8), mul); // hem
  }
  fill(atlas, B.top, shirt, 0.9);
  fill(atlas, B.bottom, darken(shirt, 0.8), 0.9);

  // Arms: full sleeves with a cuff, bare hands.
  for (const arm of [P.rightArm, P.leftArm]) {
    const A = arm.base;
    for (const side of ['front', 'back', 'right', 'left']) {
      const mul = SIDE_MUL[side];
      fill(atlas, rows(A[side], 0, 9), shirt, mul, true);
      fill(atlas, rows(A[side], 9, 10), darken(shirt, 0.8), mul); // cuff
      fill(atlas, rows(A[side], 10, 12), SKIN, mul); // hands
    }
    fill(atlas, A.top, shirt, 0.9);
    fill(atlas, A.bottom, SKIN, 0.75);
  }

  // Legs: pants with a belt row and shoes.
  const shoe = darken(pants, 0.5);
  for (const leg of [P.rightLeg, P.leftLeg]) {
    const L = leg.base;
    for (const side of ['front', 'back', 'right', 'left']) {
      const mul = SIDE_MUL[side];
      fill(atlas, rows(L[side], 0, 1), darken(pants, 0.75), mul); // belt
      fill(atlas, rows(L[side], 1, 10), pants, mul, true);
      fill(atlas, rows(L[side], 10, 12), shoe, mul); // shoes
    }
    fill(atlas, L.top, pants, 0.9);
    fill(atlas, L.bottom, shoe, 0.9);
  }

  return atlas;
}
