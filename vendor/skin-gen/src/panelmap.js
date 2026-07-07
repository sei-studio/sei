// Branch B: map a canonical dual-panel (front|back) Minecraft-style character
// render onto the 64x64 skin atlas.
//
// Panel contract (see PANEL_PROMPT): square image, front view centered in the
// left half, back view centered in the right half, plain light background,
// character standing straight, arms at sides.
//
// Method: find the character's bounding box in each half, sample it onto a
// 16x32 cell grid (the same canvas geometry renderView uses), then invert
// renderView's placement to write the front/back faces of every part.
// Side/top/bottom faces are synthesized from the adjacent front/back edges.
import sharp from 'sharp';
import { SKIN_SIZE, parts } from './layout.js';
import { dominantCell } from './downsample.js';

const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;

// --- panel loading ---------------------------------------------------------

async function loadRaw(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// Estimate the background color from the image border pixels (modal bucket).
function borderBackground(img) {
  const { data, w, h } = img;
  const buckets = new Map();
  let transparent = 0;
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) { transparent++; return; }
    const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  // If transparency dominates the border, the background IS transparency —
  // opaque border pixels are just the character touching the edge.
  if (!best || transparent > best.n) return null;
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

function isForeground(data, w, x, y, bg, tol = 40) {
  const i = (y * w + x) * 4;
  if (data[i + 3] < 128) return false;
  if (!bg) return true;
  const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  return d > tol;
}

function bbox(img, x0, x1, bg, y0 = 0, y1 = null) {
  const { data, w, h } = img;
  const yEnd = y1 == null ? h : Math.min(h, y1);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = x0; x < x1; x++) {
      if (isForeground(data, w, x, y, bg)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('no character found in panel half');
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Sample a bbox region onto a cw x ch cell grid with dominant color.
// Background-colored dominant cells come back transparent.
function gridSample(img, box, cw, ch, bg) {
  const { data, w } = img;
  const grid = Buffer.alloc(cw * ch * 4);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const px0 = box.x + Math.floor((cx * box.w) / cw);
      const px1 = Math.max(px0 + 1, box.x + Math.floor(((cx + 1) * box.w) / cw));
      const py0 = box.y + Math.floor((cy * box.h) / ch);
      const py1 = Math.max(py0 + 1, box.y + Math.floor(((cy + 1) * box.h) / ch));
      // dominant color over the cell, counting bg-ish pixels as transparent
      const buckets = new Map();
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          const fg = isForeground(data, w, x, y, bg);
          const i = (y * w + x) * 4;
          const key = fg ? `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}` : 'T';
          let b = buckets.get(key);
          if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
          b.n++;
          if (fg) { b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; }
        }
      }
      let best = null, bestKey = null;
      for (const [key, b] of buckets) if (!best || b.n > best.n) { best = b; bestKey = key; }
      const o = (cy * cw + cx) * 4;
      if (bestKey === 'T') { grid[o + 3] = 0; continue; }
      grid[o] = Math.round(best.r / best.n);
      grid[o + 1] = Math.round(best.g / best.n);
      grid[o + 2] = Math.round(best.b / best.n);
      grid[o + 3] = 255;
    }
  }
  return grid;
}

// --- eye-anchored head detection -------------------------------------------
//
// The uniform sampler above assumes the head is exactly the top 8/32 of the
// head-to-feet bbox. Tall hair, cat ears, horns or hats break that: the crown
// is an ear tip, so the face slides down into the body rows and the eyes end up
// stamped on the chest. To fix the aim we locate the eyes directly and anchor
// the head cube on them.
//
// White pixels alone are ambiguous (eye sclera vs. white ear fur vs. a white
// collar), so we classify each light blob by CONTEXT: an eye is a small light
// blob sitting in skin tone, next to a dark/colored iris, and paired
// symmetrically with the other eye. Fur sits in hair; a collar is a wide band
// in dark clothing. No confident pair -> caller falls back to uniform sampling.

const vsat = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return { v: mx / 255, sat: mx - mn };
};
// eye sclera: near-pure white. Measured: real sclera min-channel >= 250, while
// even the lightest beige plaid tops out at min-channel ~183, so this cleanly
// rejects warm clothing that merely looks "light".
const isSclera = (r, g, b) => Math.min(r, g, b) >= 225;
// warm mid/high value, low-ish saturation, R>=G>=B: human-ish skin.
const isSkin = (r, g, b) => {
  const { v, sat } = vsat(r, g, b);
  return v >= 0.5 && v <= 0.98 && sat <= 80 && r >= g - 8 && g >= b - 10;
};

// Flood-fill connected components inside a rect whose pixels are foreground and
// satisfy `pred(r,g,b)`. Returns blobs with centroid, area and bounds.
function components(img, rect, bg, pred) {
  const { data, w } = img;
  const { x0, x1, y0, y1 } = rect;
  const seen = new Set();
  const key = (x, y) => y * w + x;
  const ok = (x, y) => {
    const i = (y * w + x) * 4;
    return isForeground(data, w, x, y, bg) && pred(data[i], data[i + 1], data[i + 2]);
  };
  const blobs = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (seen.has(key(x, y)) || !ok(x, y)) continue;
      let sx = 0, sy = 0, n = 0, minX = x, maxX = x, minY = y, maxY = y;
      const stack = [[x, y]];
      seen.add(key(x, y));
      while (stack.length) {
        const [cx, cy] = stack.pop();
        sx += cx; sy += cy; n++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          if (seen.has(key(nx, ny)) || !ok(nx, ny)) continue;
          seen.add(key(nx, ny));
          stack.push([nx, ny]);
        }
      }
      blobs.push({ cx: sx / n, cy: sy / n, n, minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  }
  return blobs;
}

// Fraction of foreground pixels in a ring around a blob that are skin.
function skinSurround(img, blob, bg) {
  const { data, w, h } = img;
  const pad = Math.max(2, Math.round(0.8 * Math.max(blob.w, blob.h)));
  const rx0 = Math.max(0, blob.minX - pad), rx1 = Math.min(w - 1, blob.maxX + pad);
  const ry0 = Math.max(0, blob.minY - pad), ry1 = Math.min(h - 1, blob.maxY + pad);
  let fg = 0, skin = 0;
  for (let y = ry0; y <= ry1; y++)
    for (let x = rx0; x <= rx1; x++) {
      if (x >= blob.minX && x <= blob.maxX && y >= blob.minY && y <= blob.maxY) continue;
      if (!isForeground(data, w, x, y, bg)) continue;
      fg++;
      const i = (y * w + x) * 4;
      if (isSkin(data[i], data[i + 1], data[i + 2])) skin++;
    }
  return fg ? skin / fg : 0;
}

// Skin fraction along the horizontal gap between two blobs (the nose bridge).
// This is what separates a real eye pair (skin between) from two ear-fur tufts
// (hair between) or two plaid squares (cloth between).
function betweenSkin(img, a, c) {
  const { data, w } = img;
  const [L, R] = a.cx < c.cx ? [a, c] : [c, a];
  const xs = L.maxX + 1, xe = R.minX - 1;
  if (xe < xs) return 0;
  const yc = Math.round((a.cy + c.cy) / 2);
  let n = 0, skin = 0;
  for (let y = Math.max(0, yc - 1); y <= yc + 1; y++)
    for (let x = xs; x <= xe; x++) {
      const i = (y * w + x) * 4;
      n++;
      if (isSkin(data[i], data[i + 1], data[i + 2])) skin++;
    }
  return n ? skin / n : 0;
}

// Has a dark pupil or saturated iris pixel near the sclera blob. The iris can
// sit a few px to the side of the white (sclera-then-iris), so search a radius
// scaled to the blob, not just a 1px border.
function hasIris(img, b) {
  const { data, w, h } = img;
  const pad = Math.max(2, Math.round(0.8 * Math.max(b.w, b.h)));
  const y0 = Math.max(0, b.minY - pad), y1 = Math.min(h - 1, b.maxY + pad);
  const x0 = Math.max(0, b.minX - pad), x1 = Math.min(w - 1, b.maxX + pad);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], bl = data[i + 2];
      if (isSclera(r, g, bl)) continue;
      const { v, sat } = vsat(r, g, bl);
      if (v < 0.45 || sat > 70) return true; // dark pupil/lashes or a saturated iris
    }
  return false;
}

// Detect the eye pair directly and return a square head box anchored on it.
// An eye is a small light (sclera) blob with an adjacent iris, sitting in skin;
// the two eyes share a height, are symmetric, and have skin BETWEEN them. That
// between-skin bridge is the key test that rejects ear fur, collars and plaid.
// Null -> caller falls back to uniform top-8/32 sampling.
function detectFrontHead(img, box, bg) {
  const rect = {
    x0: box.x, x1: box.x + box.w,
    y0: box.y, y1: Math.round(box.y + 0.55 * box.h), // eyes live in the upper body
  };
  const cands = [];
  for (const b of components(img, rect, bg, isSclera)) {
    if (b.n < 2) continue;
    if (b.w > 0.14 * box.w || b.h > 0.10 * box.h) continue;   // too big for one eye
    if (!hasIris(img, b)) continue;
    if (skinSurround(img, b, bg) < 0.35) continue;
    cands.push(b);
  }
  let best = null;
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i], c = cands[j];
      const dy = Math.abs(a.cy - c.cy), dx = Math.abs(a.cx - c.cx);
      if (dy > 0.05 * box.h) continue;                        // same row
      if (dx < 0.06 * box.w || dx > 0.38 * box.w) continue;   // plausible eye spacing
      const ar = Math.max(a.n, c.n) / Math.min(a.n, c.n);
      if (ar > 4) continue;
      const bridge = betweenSkin(img, a, c);
      if (bridge < 0.5) continue;                             // must be a skin nose-bridge
      const high = 1 - ((a.cy + c.cy) / 2 - box.y) / box.h;   // prefer upper (real eyes)
      const s = bridge + high - dy / (0.05 * box.h) * 0.4 - (ar - 1) * 0.15;
      if (!best || s > best.s) best = { s, a, c, dx };
    }
  if (!best) return null;
  const fx = (best.a.cx + best.c.cx) / 2;
  const fy = (best.a.cy + best.c.cy) / 2;
  // Put the eyes just below the centre of the 8px head cube (~row 4.5). Start
  // from the canonical quarter-height, but CAP the size so the head top never
  // has to rise above the crown (box.y): when the eyes sit high in the figure
  // (short forehead / big anime eyes), a full-size head would clamp to the crown
  // and the eyes would ride up to the top rows. Capping keeps them centred.
  const EYE_FRAC = 0.56;
  let size = Math.round(0.25 * box.h);
  const cap = Math.round((fy - box.y) / EYE_FRAC);            // head top stays >= crown
  size = Math.min(size, cap);
  size = Math.max(Math.round(0.14 * box.h), Math.min(size, Math.round(0.30 * box.h)));
  let top = Math.round(fy - EYE_FRAC * size);
  top = Math.max(box.y, Math.min(top, box.y + box.h - size));
  let left = Math.round(fx - 0.5 * size);
  left = Math.max(box.x, Math.min(left, box.x + box.w - size));
  return { x: left, y: top, w: size, h: size, eyes: { fx, fy }, face: null };
}

// Build the cw x 32 sampling grid with the head sourced from an explicit head
// box (rows 0-7) and the body/legs from the neck-to-feet stripe (rows 8-31).
function anchoredGrid(img, box, headBox, cw, bg) {
  const aw = (cw - 8) / 2;
  const grid = Buffer.alloc(cw * 32 * 4);
  const head = gridSample(img, headBox, 8, 8, bg);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const s = (y * 8 + x) * 4, d = (y * cw + (aw + x)) * 4;
      grid[d] = head[s]; grid[d + 1] = head[s + 1]; grid[d + 2] = head[s + 2]; grid[d + 3] = head[s + 3];
    }
  }
  const neckY = headBox.y + headBox.h;
  const feetY = box.y + box.h;
  let bodyBox;
  try {
    bodyBox = bbox(img, box.x, box.x + box.w, bg, neckY, feetY);
  } catch {
    bodyBox = { x: box.x, y: neckY, w: box.w, h: Math.max(1, feetY - neckY) };
  }
  const body = gridSample(img, bodyBox, cw, 24, bg);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 4, d = ((8 + y) * cw + x) * 4;
      grid[d] = body[s]; grid[d + 1] = body[s + 1]; grid[d + 2] = body[s + 2]; grid[d + 3] = body[s + 3];
    }
  }
  return grid;
}

// --- atlas writing ---------------------------------------------------------

// Same placement as renderView: where each part's front/back face sits on the
// 16x32 (classic) canvas grid.
function viewPlacement(side, variant) {
  const P = parts(variant);
  const aw = P.rightArm.dims.w;
  const bodyX = aw;
  const [armL, armR, legL, legR] =
    side === 'front'
      ? [P.rightArm, P.leftArm, P.rightLeg, P.leftLeg]
      : [P.leftArm, P.rightArm, P.leftLeg, P.rightLeg];
  return [
    { rect: P.head[side === 'front' ? 'base' : 'base'][side], part: P.head, dx: bodyX, dy: 0 },
    { rect: P.body.base[side], part: P.body, dx: bodyX, dy: 8 },
    { rect: armL.base[side], part: armL, dx: 0, dy: 8 },
    { rect: armR.base[side], part: armR, dx: bodyX + 8, dy: 8 },
    { rect: legL.base[side], part: legL, dx: bodyX, dy: 20 },
    { rect: legR.base[side], part: legR, dx: bodyX + 4, dy: 20 },
  ];
}

function writeFace(atlas, grid, cw, rect, dx, dy) {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const g = ((dy + y) * cw + dx + x) * 4;
      const a = AIDX(rect.x + x, rect.y + y);
      atlas[a] = grid[g];
      atlas[a + 1] = grid[g + 1];
      atlas[a + 2] = grid[g + 2];
      atlas[a + 3] = grid[g + 3] ? 255 : 0;
    }
  }
}

// Synthesize a side face by tiling the edge column of a source face.
function synthSide(atlas, srcRect, srcEdgeX, dstRect, { darken = 0.9 } = {}) {
  for (let y = 0; y < dstRect.h; y++) {
    const s = AIDX(srcRect.x + srcEdgeX, srcRect.y + Math.min(y, srcRect.h - 1));
    for (let x = 0; x < dstRect.w; x++) {
      const d = AIDX(dstRect.x + x, dstRect.y + y);
      atlas[d] = Math.round(atlas[s] * darken);
      atlas[d + 1] = Math.round(atlas[s + 1] * darken);
      atlas[d + 2] = Math.round(atlas[s + 2] * darken);
      atlas[d + 3] = atlas[s + 3];
    }
  }
}

// Synthesize top/bottom by tiling a source row.
function synthCap(atlas, srcRect, srcEdgeY, dstRect, { darken = 1 } = {}) {
  for (let y = 0; y < dstRect.h; y++) {
    for (let x = 0; x < dstRect.w; x++) {
      const s = AIDX(srcRect.x + Math.min(x, srcRect.w - 1), srcRect.y + srcEdgeY);
      const d = AIDX(dstRect.x + x, dstRect.y + y);
      atlas[d] = Math.round(atlas[s] * darken);
      atlas[d + 1] = Math.round(atlas[s + 1] * darken);
      atlas[d + 2] = Math.round(atlas[s + 2] * darken);
      atlas[d + 3] = atlas[s + 3];
    }
  }
}

// Test/debug hook: report the detected front bbox and eye-anchored head box.
export async function _debugFrontHead(panelImage) {
  const img = await loadRaw(panelImage);
  const bg = borderBackground(img);
  const frontBox = bbox(img, 0, Math.floor(img.w / 2), bg);
  return { img, bg, frontBox, head: detectFrontHead(img, frontBox, bg) };
}

/**
 * Convert a dual-panel (front|back) render into a 64x64 skin atlas buffer.
 */
export async function panelToAtlas(panelImage, { variant = 'classic' } = {}) {
  const img = await loadRaw(panelImage);
  const bg = borderBackground(img);
  const half = Math.floor(img.w / 2);
  const P = parts(variant);
  const aw = P.rightArm.dims.w;
  const cw = 8 + 2 * aw;
  const ch = 32;

  const atlas = Buffer.alloc(SKIN_SIZE * SKIN_SIZE * 4);
  // Anchor the head on the eyes detected in the front view, then reuse the same
  // head fraction for the back so the two views stay aligned.
  const frontBox = bbox(img, 0, half, bg);
  const frontHead = detectFrontHead(img, frontBox, bg);
  const headFrac = frontHead
    ? { top: (frontHead.y - frontBox.y) / frontBox.h, size: frontHead.h / frontBox.h }
    : null;
  for (const [side, x0, x1] of [
    ['front', 0, half],
    ['back', half, img.w],
  ]) {
    const box = side === 'front' ? frontBox : bbox(img, x0, x1, bg);
    let grid;
    if (side === 'front' && frontHead) {
      grid = anchoredGrid(img, box, frontHead, cw, bg);
    } else if (side === 'back' && headFrac) {
      const size = Math.round(headFrac.size * box.h);
      const hb = {
        x: Math.round(box.x + box.w / 2 - size / 2),
        y: Math.round(box.y + headFrac.top * box.h),
        w: size, h: size,
      };
      grid = anchoredGrid(img, box, hb, cw, bg);
    } else {
      grid = gridSample(img, box, cw, ch, bg); // uniform fallback (no confident eyes)
    }
    for (const p of viewPlacement(side, variant)) {
      writeFace(atlas, grid, cw, p.rect, p.dx, p.dy);
    }
  }

  // Synthesize the unseen faces per part from front/back edges.
  for (const [name, part] of Object.entries(P)) {
    const f = part.base.front;
    const b = part.base.back;
    // right face: front's left edge; left face: front's right edge
    synthSide(atlas, f, 0, part.base.right, { darken: 0.85 });
    synthSide(atlas, f, f.w - 1, part.base.left, { darken: 0.85 });
    // top: head gets front top row (hair); others darkened
    synthCap(atlas, f, 0, part.base.top, { darken: name === 'head' ? 0.95 : 0.8 });
    synthCap(atlas, f, f.h - 1, part.base.bottom, { darken: 0.7 });
    void b;
  }
  return atlas;
}
