// Minecraft 64x64 skin UV layout, computed from box-unwrap geometry.
// Unwrap of a box (w,h,d) at origin (ox,oy):
//   top(ox+d,oy,w,d) bottom(ox+d+w,oy,w,d)
//   right(ox,oy+d,d,h) front(ox+d,oy+d,w,h) left(ox+d+w,oy+d,d,h) back(ox+2d+w,oy+d,w,h)
// Spec: https://github.com/minotar/skin-spec + Minecraft 1.8 64x64 extensions.

export const SKIN_SIZE = 64;

function unwrap(ox, oy, w, h, d) {
  return {
    top: { x: ox + d, y: oy, w, h: d },
    bottom: { x: ox + d + w, y: oy, w, h: d },
    right: { x: ox, y: oy + d, w: d, h },
    front: { x: ox + d, y: oy + d, w, h },
    left: { x: ox + d + w, y: oy + d, w: d, h },
    back: { x: ox + 2 * d + w, y: oy + d, w, h },
  };
}

// armWidth: 4 (classic) or 3 (slim)
export function parts(variant = 'classic') {
  const aw = variant === 'slim' ? 3 : 4;
  return {
    head: {
      dims: { w: 8, h: 8, d: 8 },
      base: unwrap(0, 0, 8, 8, 8),
      overlay: unwrap(32, 0, 8, 8, 8),
    },
    body: {
      dims: { w: 8, h: 12, d: 4 },
      base: unwrap(16, 16, 8, 12, 4),
      overlay: unwrap(16, 32, 8, 12, 4),
    },
    rightArm: {
      dims: { w: aw, h: 12, d: 4 },
      base: unwrap(40, 16, aw, 12, 4),
      overlay: unwrap(40, 32, aw, 12, 4),
    },
    leftArm: {
      dims: { w: aw, h: 12, d: 4 },
      base: unwrap(32, 48, aw, 12, 4),
      overlay: unwrap(48, 48, aw, 12, 4),
    },
    rightLeg: {
      dims: { w: 4, h: 12, d: 4 },
      base: unwrap(0, 16, 4, 12, 4),
      overlay: unwrap(0, 32, 4, 12, 4),
    },
    leftLeg: {
      dims: { w: 4, h: 12, d: 4 },
      base: unwrap(16, 48, 4, 12, 4),
      overlay: unwrap(0, 48, 4, 12, 4),
    },
  };
}

export function faceRects(variant = 'classic', layer = 'both') {
  const out = [];
  for (const [part, def] of Object.entries(parts(variant))) {
    for (const l of ['base', 'overlay']) {
      if (layer !== 'both' && layer !== l) continue;
      for (const [face, r] of Object.entries(def[l])) {
        out.push({ part, layer: l, face, ...r });
      }
    }
  }
  return out;
}

// 64x64 boolean grid: true = pixel is rendered (belongs to some face).
export function usedGrid(variant = 'classic', layer = 'both') {
  const grid = Array.from({ length: SKIN_SIZE }, () => new Array(SKIN_SIZE).fill(false));
  for (const r of faceRects(variant, layer)) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = true;
  }
  return grid;
}
