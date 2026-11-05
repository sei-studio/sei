/**
 * The first-link intro's light (261106): soft colour gradients, glows and
 * waves, drawn per frame from an IntroFrame (introFrame.ts). Pure drawing:
 * the same frame always draws the same picture.
 *
 * Both canvases are small (FIELD_SCALE below the screen) and stretched to
 * the window, so every shape is blurred by the upscale and nothing has a
 * hard edge; additive blending ('lighter') makes the overlaps glow.
 *
 *  - drawBack: the field (behind her room and her) plus her halo.
 *  - drawFront: over everything: the swell of light on her as she forms and
 *    the one soft ring of light when she is linked.
 */
import type { IntroStyle } from '@shared/seilinkIntroTelemetry';
import { INTRO_PALETTES, type Box, type IntroFrame } from './introFrame';

/** Screen px per canvas px. */
export const FIELD_SCALE = 6;

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

/** A soft round glow (radial gradient to transparent). */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: RGB, a: number): void {
  if (a <= 0.002 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(c, a));
  g.addColorStop(0.45, rgba(c, a * 0.45));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** A soft ring: a gaussian-ish band of light at radius rr, width sigma. */
function ring(ctx: CanvasRenderingContext2D, x: number, y: number, rr: number, sigma: number, c: RGB, a: number): void {
  if (a <= 0.002 || rr <= 0) return;
  const R = rr + sigma * 2;
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  const at = (r: number): number => Math.max(0, Math.min(1, r / R));
  g.addColorStop(0, rgba(c, 0));
  g.addColorStop(at(rr - sigma * 2), rgba(c, 0));
  g.addColorStop(at(rr - sigma), rgba(c, a * 0.4));
  g.addColorStop(at(rr), rgba(c, a));
  g.addColorStop(at(rr + sigma), rgba(c, a * 0.4));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);
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

function aurora(ctx: CanvasRenderingContext2D, f: IntroFrame, w: number, h: number, hx: number, hy: number, lights: RGB[]): void {
  const k = f.field.clock;
  const a0 = f.field.opacity * (0.75 + 0.35 * f.field.swell);
  const hu = hx / w;
  // A low glow along the horizon the curtains rise from.
  glow(ctx, w * 0.5, h * 0.82, w * 0.6, lights[1], 0.34 * a0);
  for (let i = 0; i < 4; i++) {
    const c = lights[i % 3];
    const speed = 1 + 0.27 * i;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // Lean in toward her as she forms: the curtains dip down to her and brighten there.
      const pull = f.field.gather * Math.exp(-(((u - hu) / 0.42) ** 2));
      let yc = h * (0.3 + 0.09 * i) + h * 0.075 * Math.sin(u * Math.PI * 2.1 + k * 0.00042 * speed + i * 1.3) + h * 0.035 * Math.sin(u * Math.PI * 5.3 - k * 0.00071 * speed + i * 2.1);
      yc = mix(yc, hy + h * 0.05, pull * 0.7);
      const len = h * (0.36 + 0.12 * Math.sin(u * 7.1 + k * 0.0009 + i));
      // Rays shimmer: brightness ripples along the curtain.
      const shimmer = 0.6 + 0.4 * Math.sin(u * 9 + k * 0.0012 * speed + i * 4) ** 2;
      const fadeEdge = Math.min(1, Math.max(0, Math.min(u + 0.1, 1.1 - u) * 4));
      strip(ctx, x, yc - len * 0.9, 1, len, c, a0 * 0.5 * shimmer * fadeEdge * (1 + 0.5 * pull), 0.82);
    }
  }
}

function bloom(ctx: CanvasRenderingContext2D, f: IntroFrame, w: number, h: number, hx: number, hy: number, lights: RGB[]): void {
  const k = f.field.clock;
  const a0 = f.field.opacity;
  const g = f.field.gather;
  // The pulses come from the middle at first, then from where she sits.
  const cx = mix(w * 0.5, hx, Math.min(1, g * 1.5 + 0.35));
  const cy = mix(h * 0.5, hy, Math.min(1, g * 1.5 + 0.35));
  const breathe = 0.5 + 0.5 * Math.sin(k * 0.0021);
  glow(ctx, cx, cy, h * (0.42 + 0.08 * breathe) * (1 + 0.3 * f.field.swell), lights[0], a0 * (0.42 + 0.25 * breathe + 0.3 * f.field.swell));
  glow(ctx, cx, cy, h * 0.2, [255, 236, 220], a0 * (0.25 + 0.35 * f.field.swell));
  const rmax = Math.hypot(w, h) * 0.62;
  const n = 3;
  for (let i = 0; i < n; i++) {
    const s = (k / 2300 + i / n) % 1;
    // Out of the centre, or (gathered) back in toward her.
    const r = mix(s, 1 - s, g) * rmax;
    const life = Math.sin(Math.PI * s);
    ring(ctx, cx, cy, r, h * (0.14 + 0.12 * s), lights[i % 3], a0 * 0.42 * life);
  }
  // Two slow side blooms keep the edges from going flat.
  glow(ctx, w * (0.2 + 0.05 * Math.sin(k * 0.0005)), h * 0.3, h * 0.55, lights[2], a0 * 0.3);
  glow(ctx, w * (0.82 + 0.05 * Math.cos(k * 0.0004)), h * 0.72, h * 0.6, lights[1], a0 * 0.3);
}

function tide(ctx: CanvasRenderingContext2D, f: IntroFrame, w: number, h: number, hx: number, hy: number, lights: RGB[]): void {
  const k = f.field.clock;
  const a0 = f.field.opacity;
  const g = f.field.gather;
  for (let i = 0; i < 6; i++) {
    const bx = w * (0.5 + 0.4 * Math.sin(k * 0.00023 * (1 + 0.17 * i) + i * 1.7));
    const by = h * (0.5 + 0.32 * Math.cos(k * 0.00031 * (1 + 0.11 * i) + i * 2.3));
    const x = mix(bx, hx, g * 0.8);
    const y = mix(by, hy, g * 0.8);
    const r = h * (0.38 + 0.1 * Math.sin(k * 0.0008 + i)) * (1 - 0.35 * g);
    glow(ctx, x, y, r, lights[i % 3], a0 * (0.48 + 0.2 * f.field.swell));
  }
  // Waves wash across: soft bands that rise and fall along the screen.
  for (let b = 0; b < 3; b++) {
    const c = lights[(b + 1) % 3];
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const pull = g * Math.exp(-(((u - hx / w) / 0.5) ** 2));
      const yc = mix(h * (0.6 + 0.1 * b - 0.1) + h * 0.11 * Math.sin(u * Math.PI * 2.6 + k * 0.0013 + b * 2.1) + h * 0.04 * Math.sin(u * Math.PI * 6.4 - k * 0.0021 + b), hy, pull * 0.6);
      const bh = h * 0.34;
      strip(ctx, x, yc - bh / 2, 1, bh, c, a0 * 0.42 * (0.7 + 0.3 * Math.sin(u * 11 + k * 0.002 + b) ** 2), 0.5);
    }
  }
}

const FIELDS: Record<IntroStyle, typeof aurora> = { aurora, bloom, tide };

/** The field and her halo, behind the room. `ctx` is FIELD_SCALE smaller than the screen. */
export function drawBack(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box | null): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / Math.max(1, f.W);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  const c = herCentre(f, her);
  const hx = c.x * s;
  const hy = c.y * s;
  const lights = INTRO_PALETTES[f.style].lights;
  ctx.globalCompositeOperation = 'lighter';
  if (f.field.opacity > 0.002) FIELDS[f.style](ctx, f, w, h, hx, hy, lights);
  if (f.halo > 0.002) {
    const hr = (her ? her.h : f.H * 0.5) * s * 0.85;
    glow(ctx, hx, hy, hr, lights[0], 0.5 * f.halo);
    glow(ctx, hx, hy, hr * 0.55, [255, 255, 255], 0.28 * f.halo);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Over everything: the swell of light on her as she forms, and the linked ring. */
export function drawFront(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box | null): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / Math.max(1, f.W);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  const c = herCentre(f, her);
  const hx = c.x * s;
  const hy = c.y * s;
  const lights = INTRO_PALETTES[f.style].lights;
  ctx.globalCompositeOperation = 'lighter';
  if (f.field.swell > 0.002) {
    const hr = (her ? her.h : f.H * 0.5) * s * 0.6;
    glow(ctx, hx, hy, hr, [255, 255, 255], 0.3 * f.field.swell);
    glow(ctx, hx, hy, hr * 1.6, lights[1], 0.18 * f.field.swell);
  }
  if (f.pulse >= 0 && f.pulse < 1) {
    const p = f.pulse;
    const r = (0.08 + 0.9 * (1 - (1 - p) ** 2)) * Math.hypot(w, h) * 0.6;
    ring(ctx, hx, hy, r, h * (0.05 + 0.08 * p), lights[0], 0.35 * (1 - p) * Math.min(1, p * 6));
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** Background colours per style (the dark behind the light). */
export function voidGradient(style: IntroStyle): string {
  const [a, b] = INTRO_PALETTES[style].void;
  return `radial-gradient(120% 90% at 50% 46%, ${a} 0%, ${b} 72%)`;
}
