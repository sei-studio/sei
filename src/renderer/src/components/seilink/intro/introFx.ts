/**
 * The first-link intro's light (261106): the space aurora, drawn per frame
 * from an IntroFrame (introFrame.ts). Pure drawing: the same frame always
 * draws the same picture.
 *
 * The light canvases are small (FIELD_SCALE below the screen) and stretched
 * to the window, so every shape is blurred by the upscale and nothing has a
 * hard edge; additive blending ('lighter') makes the overlaps glow. The
 * stars have their own canvas at STAR_SCALE (fine enough for points, still
 * soft), and a still grain tile (grainUrl) over the dark keeps the smooth
 * gradients from banding on 8-bit displays and in the review videos.
 *
 *  - drawBack: the nebula haze, the aurora curtains and her halo, behind
 *    whatever she ends on and behind her.
 *  - drawStars: the starfield, slowly drifting, each star breathing a little.
 *  - drawFront: over everything: the climax's bloom, the swell of light on
 *    her as she forms and the soft breath of light when she is linked (glows
 *    only, no rings).
 *
 * The climax (`field.peak`, 261106 v4) makes the same curtains brighter,
 * longer, wider apart and edge to edge (the clock runs faster into it,
 * computeFrame), with a wide soft bloom over the middle: the screen fills
 * with light, then the view cuts it all to black.
 */
import { INTRO_PALETTE as PAL, type Box, type IntroFrame, type IntroPalette } from './introFrame';

/** Screen px per light canvas px. */
export const FIELD_SCALE = 6;
/** Screen px per star canvas px. */
export const STAR_SCALE = 2;

type RGB = [number, number, number];

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a)).toFixed(4)})`;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Her centre (screen px): her box's upper middle, or where she will sit. */
export function herCentre(f: IntroFrame, her: Box | null): { x: number; y: number } {
  if (her && her.h > 4) return { x: her.x + her.w / 2, y: her.y + her.h * 0.38 };
  return { x: f.W * 0.5, y: f.H * 0.6 };
}

/**
 * Skia dithers every gradient with a fine ordered pattern; on a canvas that
 * is stretched FIELD_SCALE times that pattern becomes a visible checker. One
 * small blur pass on the small canvas (cheap at this size) melts it; the
 * grain over the screen then dithers what is left.
 */
function melt(ctx: CanvasRenderingContext2D): void {
  try {
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = 'blur(1.2px)';
    ctx.drawImage(ctx.canvas, 0, 0);
  } catch {
    /* no canvas filter: keep the unblurred frame */
  } finally {
    ctx.restore();
  }
}

/** A soft round glow (radial gradient to transparent, eased so it has no visible rim). */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: RGB, a: number): void {
  if (a <= 0.002 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(c, a));
  g.addColorStop(0.25, rgba(c, a * 0.72));
  g.addColorStop(0.5, rgba(c, a * 0.36));
  g.addColorStop(0.75, rgba(c, a * 0.11));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** A vertical strip of light, brightest at `peak` (0 top .. 1 bottom), fading to nothing at both ends. */
function strip(ctx: CanvasRenderingContext2D, x: number, top: number, w: number, h: number, c: RGB, a: number, peak: number): void {
  if (a <= 0.002 || h <= 0) return;
  const g = ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, rgba(c, 0));
  g.addColorStop(Math.max(0.01, peak * 0.55), rgba(c, a * 0.35));
  g.addColorStop(peak, rgba(c, a));
  g.addColorStop(Math.min(0.99, peak + (1 - peak) * 0.6), rgba(c, a * 0.2));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x, top, w, h);
}

/** Two slow nebula clouds and a low glow, far behind the curtains. */
function haze(ctx: CanvasRenderingContext2D, f: IntroFrame, w: number, h: number, pal: IntroPalette): void {
  const k = f.field.clock;
  const a = f.space * (1 + 0.9 * f.field.peak);
  if (a <= 0.002) return;
  glow(ctx, w * (0.27 + 0.05 * Math.sin(k * 0.00011)), h * (0.34 + 0.04 * Math.cos(k * 0.00013)), w * 0.62, pal.haze[0], 0.42 * a);
  glow(ctx, w * (0.76 + 0.04 * Math.cos(k * 0.0001)), h * (0.66 + 0.04 * Math.sin(k * 0.00012)), w * 0.56, pal.haze[1], 0.36 * a);
  glow(ctx, w * 0.5, h * 0.92, w * 0.7, pal.lights[0], 0.16 * a * f.field.opacity);
}

/** Curtains of soft light that sway across, lean in toward her as she forms, then lift away. */
function aurora(ctx: CanvasRenderingContext2D, f: IntroFrame, w: number, h: number, hx: number, hy: number, pal: IntroPalette): void {
  const k = f.field.clock;
  const pk = f.field.peak;
  const a0 = f.field.opacity * (0.75 + 0.35 * f.field.swell) * (1 + 0.9 * pk);
  if (a0 <= 0.002) return;
  const hu = hx / w;
  for (let i = 0; i < 4; i++) {
    const c = pal.lights[i];
    const speed = 1 + 0.27 * i;
    // The climax spreads the curtains over the whole height (top to bottom) instead of the upper middle.
    const row = mix(0.3 + 0.09 * i, 0.16 + 0.22 * i, pk);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // Lean in toward her as she forms: the curtains dip down to her and brighten there.
      const pull = f.field.gather * Math.exp(-(((u - hu) / 0.42) ** 2));
      let yc =
        h * row +
        h * 0.075 * (1 + 0.6 * pk) * Math.sin(u * Math.PI * 2.1 + k * 0.00042 * speed + i * 1.3) +
        h * 0.035 * Math.sin(u * Math.PI * 5.3 - k * 0.00071 * speed + i * 2.1);
      yc = mix(yc, hy + h * 0.05, pull * 0.7);
      const len = h * (0.36 + 0.12 * Math.sin(u * 7.1 + k * 0.0009 + i)) * (1 + 0.75 * pk);
      // Rays shimmer: brightness ripples along the curtain.
      const shimmer = 0.6 + 0.4 * Math.sin(u * 9 + k * 0.0012 * speed + i * 4) ** 2;
      // The edges fade in a tenth of the width; at the peak the light runs edge to edge.
      const fadeEdge = Math.min(1, Math.max(0, Math.min(u + 0.1, 1.1 - u) * 4 * (1 + 3 * pk)));
      strip(ctx, x, yc - len * 0.9, 1, len, c, a0 * 0.46 * shimmer * fadeEdge * (1 + 0.3 * pull), 0.82);
    }
  }
}

/** The nebula, the curtains and her halo, behind her. `ctx` is FIELD_SCALE smaller than the screen. */
export function drawBack(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box | null): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / Math.max(1, f.W);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  const c = herCentre(f, her);
  const hx = c.x * s;
  const hy = c.y * s;
  const pal = PAL;
  ctx.globalCompositeOperation = 'lighter';
  haze(ctx, f, w, h, pal);
  aurora(ctx, f, w, h, hx, hy, pal);
  if (f.halo > 0.002) {
    const hr = (her ? her.h : f.H * 0.5) * s * 0.85;
    glow(ctx, hx, hy, hr, pal.halo, 0.5 * f.halo);
    glow(ctx, hx, hy, hr * 0.55, [255, 255, 255], 0.26 * f.halo);
  }
  ctx.globalCompositeOperation = 'source-over';
  melt(ctx);
}

// ── Stars ───────────────────────────────────────────────────────────────────

interface Star {
  x: number;
  y: number;
  /** Radius in star-canvas px at a 1080p screen. */
  r: number;
  /** Brightness. */
  b: number;
  /** Drift speed (parallax: nearer stars move a little more). */
  d: number;
  /** Twinkle phase and rate. */
  p: number;
  q: number;
}

/** A small seeded PRNG (mulberry32), so every frame and every run has the same sky. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let STARS: Star[] | null = null;

function stars(): Star[] {
  if (STARS) return STARS;
  const rnd = prng(0x5e11c);
  const out: Star[] = [];
  for (let i = 0; i < 260; i++) {
    const near = rnd() ** 3;
    out.push({ x: rnd(), y: rnd(), r: 0.55 + 1.1 * near, b: 0.25 + 0.75 * rnd() ** 2, d: 0.4 + 1.6 * near, p: rnd() * Math.PI * 2, q: 0.6 + 0.8 * rnd() });
  }
  STARS = out;
  return out;
}

/** The starfield, very faint and soft. `ctx` is STAR_SCALE smaller than the screen. */
export function drawStars(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  const a = f.space * (1 + 0.4 * f.field.peak);
  if (a <= 0.002) return;
  const pal = PAL;
  const k = f.field.clock;
  const unit = h / 540;
  ctx.globalCompositeOperation = 'lighter';
  for (const s of stars()) {
    // A slow drift to the left, wrapped (a still sky under reduced motion: the clock stands).
    const x = (((s.x - k * 0.0000045 * s.d) % 1) + 1) % 1;
    const twinkle = 0.72 + 0.28 * Math.sin(k * 0.0011 * s.q + s.p);
    glow(ctx, x * w, s.y * h, s.r * 2.2 * unit, pal.star, 0.7 * s.b * twinkle * a);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Over everything: the climax's bloom, the swell of light on her as she forms, and the soft breath when linked. */
export function drawFront(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box | null): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / Math.max(1, f.W);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  const c = herCentre(f, her);
  const hx = c.x * s;
  const hy = c.y * s;
  const pal = PAL;
  const hr = (her ? her.h : f.H * 0.5) * s;
  ctx.globalCompositeOperation = 'lighter';
  // The climax: a wide soft bloom over the middle that fills the screen with light (one rise, then the cut).
  const pk = f.field.peak * f.field.opacity;
  if (pk > 0.002) {
    glow(ctx, w * 0.5, h * 0.48, Math.hypot(w, h) * 0.62, pal.halo, 0.3 * pk);
    glow(ctx, w * 0.5, h * 0.46, Math.hypot(w, h) * 0.34, pal.lights[0], 0.2 * pk);
    glow(ctx, w * 0.5, h * 0.46, Math.hypot(w, h) * 0.2, [255, 255, 255], 0.16 * pk);
  }
  if (f.field.swell > 0.002) {
    glow(ctx, hx, hy, hr * 0.6, [255, 255, 255], 0.3 * f.field.swell);
    glow(ctx, hx, hy, hr * 1.6, pal.lights[1], 0.18 * f.field.swell);
  }
  // Linked: a wide soft glow that swells and fades (computeFrame leaves it out over the white ending).
  if (f.linkGlow > 0.002) {
    glow(ctx, hx, hy, hr * 1.9, pal.halo, 0.2 * f.linkGlow);
    glow(ctx, hx, hy, hr * 0.8, [255, 255, 255], 0.1 * f.linkGlow);
  }
  ctx.globalCompositeOperation = 'source-over';
  if (pk > 0.002 || f.field.swell > 0.002 || f.linkGlow > 0.002) melt(ctx);
}

/** Deep space behind the light. */
export function voidGradient(): string {
  const [a, b] = PAL.void;
  return `radial-gradient(120% 90% at 50% 46%, ${a} 0%, ${b} 72%)`;
}

let GRAIN: string | null = null;

/**
 * A still grain tile (a data URL): each pixel a faint black or white dot,
 * a couple of 8-bit steps either way, so the slow dark gradients dither
 * instead of banding. Seeded, made once.
 */
export function grainUrl(): string | null {
  if (GRAIN !== null) return GRAIN || null;
  try {
    const n = 160;
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d');
    const img = ctx.createImageData(n, n);
    const rnd = prng(0x9a1e);
    for (let i = 0; i < n * n; i++) {
      const v = rnd();
      const white = v >= 0.5;
      const a = Math.abs(v - 0.5) * 2;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = white ? 255 : 0;
      img.data[i * 4 + 3] = Math.round(a * 5);
    }
    ctx.putImageData(img, 0, 0);
    GRAIN = c.toDataURL('image/png');
  } catch {
    GRAIN = '';
  }
  return GRAIN || null;
}
