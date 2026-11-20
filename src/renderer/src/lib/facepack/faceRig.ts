/**
 * Face-set rig geometry (261116, product call 261116), pure. A face set is
 * flat pictures (a base per expression and head pose, eye and mouth patches),
 * so her idle life is drawn as a gentle WARP of those pictures (facepackGl.ts):
 * the head tilts about the neck, turns and nods by sliding the face's
 * features inside its outline, and the irises move inside the eye openings.
 * This file works out where those parts are, from what every pack already
 * has: the eye and mouth patch boxes, and the eye patches themselves.
 *
 *  - `faceRigFor(manifest)`: neck pivot, the head band (where the warp fades
 *    out toward the shoulders) and the face ellipse, from the default pose's
 *    eye and mouth boxes (anime proportions: the chin a little over half the
 *    eye-to-mouth distance below the mouth).
 *  - `findEyes(open, closed, w, h)`: the two eye openings, as ellipses in
 *    the eye box, from the difference between the base (eyes open) and the
 *    closed-eye patch. Where they differ strongly is the open eye; the two
 *    biggest blobs side by side are her eyes. Null when the pack does not
 *    show two clear openings (an LED face, eyes under a fringe), so nothing
 *    pretends to have irises it does not have.
 *  - `irisVisible`: whether there is anything to move inside the opening.
 *    A flat-colour chibi eye (the vector Sui pack: one purple shape, no
 *    white, no pupil) would only wobble its outline, so it gets no iris
 *    motion; her gaze then shows through the head alone.
 */
import type { FacepackBox, FacepackManifest } from '@shared/facepack';

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface FaceRig {
  /** Pack canvas size. */
  w: number;
  h: number;
  /** Pivot of a head tilt or nod (pack px). */
  neckX: number;
  neckY: number;
  /** The head moves fully above `bandTop`, not at all below `bandBottom` (smooth between). */
  bandTop: number;
  bandBottom: number;
  /** Face: features inside it slide for a turn or a nod; its outline mostly stays. */
  face: Ellipse;
  /** Eye-to-mouth distance (a size unit for the face). */
  unit: number;
}

function boxCentre(b: FacepackBox): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** The rig for a pack, from its default expression's default pose; null when it has no eye or mouth boxes. */
export function faceRigFor(m: FacepackManifest): FaceRig | null {
  const [w, h] = m.canvas;
  const exprName = m.expressions[m.default_expression ?? 'neutral'] ? (m.default_expression ?? 'neutral') : Object.keys(m.expressions)[0];
  const e = exprName ? m.expressions[exprName] : undefined;
  if (!e) return null;
  const pose = e.poses[m.default_pose ?? 'c'] ?? e.poses.c ?? Object.values(e.poses)[0];
  const eyes = pose?.eyes?.box;
  const mouth = pose?.mouth?.box;
  if (!eyes || !mouth) return null;
  const [ex, ey] = boxCentre(eyes);
  const [mx, my] = boxCentre(mouth);
  const unit = Math.max(8, my - ey);
  const cx = m.anchor?.face?.[0] ?? (ex + mx) / 2;
  const chin = Math.min(h, my + unit * 0.55);
  const eyeW = Math.max(unit, eyes[2] - eyes[0]);
  return {
    w,
    h,
    neckX: cx,
    neckY: Math.min(h, chin + unit * 0.3),
    bandTop: chin - unit * 0.15,
    bandBottom: Math.min(h, chin + unit * 0.75),
    face: {
      cx,
      cy: (ey + chin) / 2 + unit * 0.05,
      rx: eyeW * 0.62,
      ry: (chin - (ey - unit * 0.45)) / 2,
    },
    unit,
  };
}

/** Squared RGB distance of two pixels, scaled to 0..1 (premultiplied by alpha). */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray, i: number): number {
  const aa = a[i + 3] / 255;
  const ba = b[i + 3] / 255;
  const dr = a[i] * aa - b[i] * ba;
  const dg = a[i + 1] * aa - b[i + 1] * ba;
  const db = a[i + 2] * aa - b[i + 2] * ba;
  return (dr * dr + dg * dg + db * db) / (3 * 255 * 255);
}

/**
 * Eye openings (box-local px) from the base cropped to the eye box (`open`)
 * and the closed-eye patch (`closed`), both RGBA `w` x `h`. Works on a coarse
 * grid (cells of `cell` px): strong-difference cells, closed then opened so
 * hair strands that moved between the two renders drop out, then the two
 * biggest 4-connected blobs.
 */
export function findEyes(open: Uint8ClampedArray, closed: Uint8ClampedArray, w: number, h: number, cell = 4): [Ellipse, Ellipse] | null {
  if (open.length < w * h * 4 || closed.length < w * h * 4 || w < 16 || h < 8) return null;
  const gw = Math.floor(w / cell);
  const gh = Math.floor(h / cell);
  const grid = new Uint8Array(gw * gh);
  // A cell is "eye" when most of its pixels differ strongly. Margins (2 cells) are ignored: a patch edge.
  for (let gy = 2; gy < gh - 2; gy++) {
    for (let gx = 2; gx < gw - 2; gx++) {
      let n = 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const i = ((gy * cell + y) * w + gx * cell + x) * 4;
          if (diff(open, closed, i) > 0.035) n++;
        }
      }
      if (n * 2 >= cell * cell) grid[gy * gw + gx] = 1;
    }
  }
  // Morphological open (erode then dilate, 1 cell) drops thin strands.
  const erode = new Uint8Array(gw * gh);
  for (let y = 1; y < gh - 1; y++)
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      erode[i] = grid[i] && grid[i - 1] && grid[i + 1] && grid[i - gw] && grid[i + gw] ? 1 : 0;
    }
  const opened = new Uint8Array(gw * gh);
  for (let y = 1; y < gh - 1; y++)
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      opened[i] = erode[i] || erode[i - 1] || erode[i + 1] || erode[i - gw] || erode[i + gw] ? 1 : 0;
    }
  // Connected blobs.
  const label = new Int32Array(gw * gh);
  const blobs: Array<{
    n: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }> = [];
  const stack: number[] = [];
  for (let s = 0; s < gw * gh; s++) {
    if (!opened[s] || label[s]) continue;
    const id = blobs.length + 1;
    const b = { n: 0, x0: gw, y0: gh, x1: 0, y1: 0 };
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % gw;
      const y = (i - x) / gw;
      b.n++;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      for (const j of [i - 1, i + 1, i - gw, i + gw]) {
        if (j < 0 || j >= gw * gh || label[j] || !opened[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === gw - 1)) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    blobs.push(b);
  }
  blobs.sort((a, b) => b.n - a.n);
  if (blobs.length < 2) return null;
  const [a, b] = blobs;
  const total = gw * gh;
  // Two eyes: each a real patch of the box, of similar size, side by side, not overlapping in x.
  if (b.n < total * 0.01 || b.n < a.n * 0.35) return null;
  if (!(a.x1 < b.x0 || b.x1 < a.x0)) return null;
  const toEllipse = (q: (typeof blobs)[number]): Ellipse => ({
    cx: ((q.x0 + q.x1 + 1) / 2) * cell,
    cy: ((q.y0 + q.y1 + 1) / 2) * cell,
    rx: ((q.x1 - q.x0 + 1) / 2) * cell,
    ry: ((q.y1 - q.y0 + 1) / 2) * cell,
  });
  const ea = toEllipse(a);
  const eb = toEllipse(b);
  if (Math.abs(ea.cy - eb.cy) > Math.max(ea.ry, eb.ry) * 1.5) return null;
  return ea.cx < eb.cx ? [ea, eb] : [eb, ea];
}

/**
 * Whether the inside of an opening has detail to move (an iris on a white,
 * a pupil, highlights): the luminance spread inside the inner part of the
 * ellipse. A flat-colour eye has almost none.
 */
export function irisVisible(open: Uint8ClampedArray, w: number, e: Ellipse): boolean {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  const x0 = Math.max(0, Math.floor(e.cx - e.rx * 0.7));
  const x1 = Math.floor(e.cx + e.rx * 0.7);
  const y0 = Math.max(0, Math.floor(e.cy - e.ry * 0.7));
  const y1 = Math.floor(e.cy + e.ry * 0.7);
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const dx = (x - e.cx) / (e.rx * 0.7);
      const dy = (y - e.cy) / (e.ry * 0.7);
      if (dx * dx + dy * dy > 1) continue;
      const i = (y * w + x) * 4;
      if (i + 3 >= open.length) continue;
      const l = (0.299 * open[i] + 0.587 * open[i + 1] + 0.114 * open[i + 2]) / 255;
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  if (n < 12) return false;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return sd > 0.09;
}
