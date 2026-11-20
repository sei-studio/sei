/**
 * Drawing weather and ambience particles (261105, room catalog). The
 * simulation is shared and pure (src/shared/seilinkParticles.ts); this file
 * draws fields onto the room's fx canvas, which sits between the back
 * canvas and her avatar.
 *
 *  - 'outside' particles (a view's rain, snow, petals) and the rain drops on
 *    the glass are drawn first, clipped to the view box, then cut to the
 *    room's GLASS mask (in place; through a scratch during a crossfade):
 *    the view box minus everything the room draws over it (walls, frame,
 *    curtains), built once per cached time of day
 *    (buildGlassMask), optionally narrowed by the shell's own `glass` file.
 *    So the rain is outside, behind the window, and a curtain pulled across
 *    hides it.
 *  - 'scene' particles (fireflies in the clearing, embers over the fire)
 *    draw straight onto the fx canvas in their area.
 *
 * Cost per frame: a clear, one step per particle, a few batched paths (rain
 * is 3 strokes, snow 3 fills) and one sprite blit per glow particle, plus
 * one masked composite per frame. Nothing allocates per frame.
 */
import type { ParticleLayer } from '@shared/seilinkDraw';
import type { RoomBox } from '@shared/seilinkRoom';
import { particleAlpha, type Particle, type ParticleField } from '@shared/seilinkParticles';
import { ctx2d, makeCanvas, type AnyCanvas, type AnyContext2D } from './roomImages';

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(3)})`;
}

const sprites = new Map<string, AnyCanvas>();

/** A soft round glow sprite (fireflies, embers), drawn once per colour. */
function glowSprite(colour: string): AnyCanvas {
  let c = sprites.get(colour);
  if (c) return c;
  const s = 64;
  c = makeCanvas(s, s);
  const ctx = ctx2d(c);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255, 255, 255, 1)');
  g.addColorStop(0.12, rgba(colour, 1));
  g.addColorStop(0.35, rgba(colour, 0.35));
  g.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  sprites.set(colour, c);
  return c;
}

/** A rain drop on glass: a dark rim, a light lens, a bright highlight. */
function dropSprite(): AnyCanvas {
  let c = sprites.get('drop');
  if (c) return c;
  const s = 48;
  c = makeCanvas(s, s);
  const ctx = ctx2d(c);
  const g = ctx.createRadialGradient(s * 0.5, s * 0.55, 0, s * 0.5, s * 0.5, s * 0.5);
  g.addColorStop(0, 'rgba(235, 242, 255, 0.45)');
  g.addColorStop(0.6, 'rgba(200, 215, 235, 0.3)');
  g.addColorStop(0.85, 'rgba(40, 50, 70, 0.5)');
  g.addColorStop(1, 'rgba(40, 50, 70, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(s / 2, s / 2, s / 2, s / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.ellipse(s * 0.4, s * 0.36, s * 0.09, s * 0.06, -0.6, 0, Math.PI * 2);
  ctx.fill();
  sprites.set('drop', c);
  return c;
}

const BANDS = 3;
const bandOf = (p: Particle): number => Math.min(BANDS - 1, Math.floor(((p.depth - 0.35) / 0.65) * BANDS));

/** Draw one field. ctx's transform maps canvas px to its pixels; `alpha` fades it (a time crossfade). */
export function drawField(ctx: AnyContext2D, field: ParticleField, alpha: number): void {
  if (alpha <= 0.003) return;
  const ps = field.particles;
  switch (field.kind) {
    case 'rain': {
      ctx.lineCap = 'round';
      for (let b = 0; b < BANDS; b++) {
        ctx.beginPath();
        let n = 0;
        let width = 0;
        let a = 0;
        for (const p of ps) {
          if (bandOf(p) !== b) continue;
          // A streak as long as the drop moves in ~36 ms (motion blur).
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 36, p.y - p.vy * 36);
          width += p.size;
          a += particleAlpha(field, p);
          n++;
        }
        if (!n) continue;
        ctx.lineWidth = width / n;
        ctx.strokeStyle = rgba(field.colour, Math.min(1, (a / n) * alpha));
        ctx.stroke();
      }
      break;
    }
    case 'snow':
    case 'dust': {
      for (let b = 0; b < BANDS; b++) {
        ctx.beginPath();
        let n = 0;
        let a = 0;
        for (const p of ps) {
          if (bandOf(p) !== b) continue;
          ctx.moveTo(p.x + p.size, p.y);
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          a += particleAlpha(field, p);
          n++;
        }
        if (!n) continue;
        ctx.fillStyle = rgba(field.colour, Math.min(1, (a / n) * alpha));
        ctx.fill();
      }
      break;
    }
    case 'petals': {
      for (let b = 0; b < BANDS; b++) {
        ctx.beginPath();
        let n = 0;
        for (const p of ps) {
          if (bandOf(p) !== b) continue;
          // Tumbling: the short axis breathes with the phase.
          const rx = p.size;
          const ry = p.size * (0.25 + 0.3 * Math.abs(Math.sin(p.phase * 1.7)));
          const rot = p.phase * 0.8;
          ctx.moveTo(p.x + rx * Math.cos(rot), p.y + rx * Math.sin(rot));
          ctx.ellipse(p.x, p.y, rx, ry, rot, 0, Math.PI * 2);
          n++;
        }
        if (!n) continue;
        ctx.fillStyle = rgba(field.colour, (0.7 + 0.1 * b) * alpha);
        ctx.fill();
      }
      break;
    }
    case 'fireflies':
    case 'embers': {
      const sprite = glowSprite(field.colour);
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      for (const p of ps) {
        const a = particleAlpha(field, p) * alpha;
        if (a <= 0.01) continue;
        const r = p.size * (field.kind === 'fireflies' ? 3 : 2.2);
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = prev;
      break;
    }
  }
  if (field.drops.length) {
    const sprite = dropSprite();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.strokeStyle = 'rgba(215, 228, 245, 0.24)';
    for (const d of field.drops) {
      const r = d.size;
      if (d.vy > 0) {
        // The wet trail a sliding drop leaves above it.
        ctx.lineWidth = r * 0.5;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - r);
        ctx.lineTo(d.x - Math.sin(d.phase) * 2, d.y - r - Math.min(60, (d.age - d.hold) * 0.04));
        ctx.stroke();
      }
      ctx.drawImage(sprite, d.x - r, d.y - r * 1.1, r * 2, r * 2.2);
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * The glass of the room over a view, at `res` device px per canvas px, as an
 * alpha mask over `box` (the view's box): white where the view shows through
 * the cached back layers drawn above it. `drawAbove` paints those layers
 * onto the context it is given (destination-out cuts them away).
 */
export function buildGlassMask(
  box: RoomBox,
  res: number,
  drawAbove: (ctx: AnyContext2D) => void,
  glass?: { image: ImageBitmap; rect: RoomBox } | null,
): AnyCanvas {
  const [x, y, w, h] = box;
  const c = makeCanvas(Math.max(1, Math.round(w * res)), Math.max(1, Math.round(h * res)));
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(res, 0, 0, res, -x * res, -y * res);
  ctx.globalCompositeOperation = 'destination-out';
  drawAbove(ctx);
  if (glass) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(glass.image, glass.rect[0], glass.rect[1], glass.rect[2], glass.rect[3]);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

/**
 * Draw particle layers onto the fx context (transform identity, device px).
 * `fieldOf` gives each layer's live field; `glass` the time's glass mask
 * for 'outside' layers (null: drawn unmasked in the view box).
 *
 * `blank` (the fx canvas was just cleared and nothing else goes on it this
 * frame before these layers): the outside layers are drawn straight onto
 * it and cut with one destination-in of the glass mask, then the scene
 * layers go on top. Otherwise (a time crossfade: two masks) they go
 * through a scratch first. The scratch costs a full blit of a canvas that
 * changed this frame, measured 50x the direct path on a software GPU
 * (7.3 ms against 0.14 ms for a 740x720 view box).
 */
export function drawParticleLayers(
  ctx: AnyContext2D,
  layers: readonly ParticleLayer[],
  res: number,
  alpha: number,
  fieldOf: (l: ParticleLayer) => ParticleField | null,
  glass: { box: RoomBox; mask: AnyCanvas } | null,
  still = false,
  showsStill: (kind: ParticleLayer['spec']['kind']) => boolean = () => true,
  blank = false,
): void {
  const shown = (l: ParticleLayer): ParticleField | null => (still && !showsStill(l.spec.kind) ? null : fieldOf(l));
  const outside = layers.filter((l) => l.where === 'outside');
  const scene = layers.filter((l) => l.where === 'scene');
  if (outside.length && (!glass || glass.box[2] > 0)) {
    const box = glass?.box ?? outside[0].area;
    if (blank) drawOutsideDirect(ctx, outside, box, res, alpha, shown, glass);
    else drawOutsideScratch(ctx, outside, box, res, alpha, shown, glass);
  }
  ctx.save();
  ctx.setTransform(res, 0, 0, res, 0, 0);
  for (const l of scene) {
    const f = shown(l);
    if (f) drawField(ctx, f, alpha);
  }
  ctx.restore();
}

function drawOutsideDirect(
  ctx: AnyContext2D,
  outside: readonly ParticleLayer[],
  box: RoomBox,
  res: number,
  alpha: number,
  shown: (l: ParticleLayer) => ParticleField | null,
  glass: { box: RoomBox; mask: AnyCanvas } | null,
): void {
  const [bx, by, bw, bh] = box;
  const px: RoomBox = [Math.round(bx * res), Math.round(by * res), Math.max(1, Math.round(bw * res)), Math.max(1, Math.round(bh * res))];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(px[0], px[1], px[2], px[3]);
  ctx.clip();
  ctx.setTransform(res, 0, 0, res, 0, 0);
  let drew = false;
  for (const l of outside) {
    const f = shown(l);
    if (!f) continue;
    drawField(ctx, f, alpha);
    drew = true;
  }
  ctx.restore();
  if (!drew || !glass) return;
  // Clipped to the box: destination-in would otherwise touch (clear) the
  // whole canvas, which measured as most of the frame's raster time.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(px[0], px[1], px[2], px[3]);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(glass.mask, 0, 0, glass.mask.width, glass.mask.height, px[0], px[1], px[2], px[3]);
  ctx.restore();
}

/**
 * The glass mask cropped to where it lets anything through, with its box
 * (canvas px). Read once per cached time of day; it keeps the per-frame
 * masked composite to the panes instead of the whole view box (in the cozy
 * room about half of it). Fully covered glass gives an empty box.
 */
export function tightenGlass(box: RoomBox, mask: AnyCanvas): { box: RoomBox; mask: AnyCanvas } {
  const { width: mw, height: mh } = mask;
  const d = ctx2d(mask, { willReadFrequently: true }).getImageData(0, 0, mw, mh).data;
  let x0 = mw;
  let y0 = mh;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (d[(y * mw + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const kx = box[2] / mw;
  const ky = box[3] / mh;
  if (x1 < 0) return { box: [box[0], box[1], 0, 0], mask: makeCanvas(1, 1) };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w === mw && h === mh) return { box, mask };
  const c = makeCanvas(w, h);
  ctx2d(c).drawImage(mask, x0, y0, w, h, 0, 0, w, h);
  return { box: [box[0] + x0 * kx, box[1] + y0 * ky, w * kx, h * ky], mask: c };
}

let outsideScratch: { c: AnyCanvas; ctx: AnyContext2D } | null = null;

function drawOutsideScratch(
  ctx: AnyContext2D,
  outside: readonly ParticleLayer[],
  box: RoomBox,
  res: number,
  alpha: number,
  shown: (l: ParticleLayer) => ParticleField | null,
  glass: { box: RoomBox; mask: AnyCanvas } | null,
): void {
  const [bx, by, bw, bh] = box;
  const pw = Math.max(1, Math.round(bw * res));
  const ph = Math.max(1, Math.round(bh * res));
  if (!outsideScratch || outsideScratch.c.width < pw || outsideScratch.c.height < ph) {
    const c = makeCanvas(Math.max(pw, outsideScratch?.c.width ?? 0), Math.max(ph, outsideScratch?.c.height ?? 0));
    outsideScratch = { c, ctx: ctx2d(c) };
  }
  const sc = outsideScratch.ctx;
  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.globalAlpha = 1;
  sc.clearRect(0, 0, pw, ph);
  sc.beginPath();
  sc.rect(0, 0, pw, ph);
  sc.clip();
  sc.setTransform(res, 0, 0, res, -bx * res, -by * res);
  let drew = false;
  for (const l of outside) {
    const f = shown(l);
    if (!f) continue;
    drawField(sc, f, alpha);
    drew = true;
  }
  sc.setTransform(1, 0, 0, 1, 0, 0);
  if (drew && glass) {
    sc.globalCompositeOperation = 'destination-in';
    sc.drawImage(glass.mask, 0, 0, glass.mask.width, glass.mask.height, 0, 0, pw, ph);
  }
  sc.restore();
  if (drew) ctx.drawImage(outsideScratch.c, 0, 0, pw, ph, Math.round(bx * res), Math.round(by * res), pw, ph);
}
