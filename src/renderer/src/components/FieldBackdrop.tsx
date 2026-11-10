/**
 * FieldBackdrop — the window's one background (quiet register, product call
 * 261110): the Windows update window's field, scaled to the app.
 *
 * Layers, bottom to top:
 *   1. the near-black (or theme) base, --field-base
 *   2. a soft copy of the glow patch (low alpha)
 *   3. the same glow seen only through a 5px dot grid (the halftone)
 *   4. a faint dot texture everywhere, so the field reads as one material
 *   5. a dark pocket behind the screen's main text block, and an edge vignette
 *
 * The glow geometry is the update card's (resources/update-progress/
 * update-progress.ps1, card 460x224), ONE patch per screen at an edge. Where it
 * sits comes from lib/fieldGlow (`useFieldGlow` in each screen).
 *
 * Cost model (the app runs next to games): static, painted once into two
 * quarter-resolution canvases (glow, pocket + vignette) and repainted only on
 * resize, theme change or a new placement. The dots are CSS: a mask on a
 * second copy of the glow canvas, and a background-image texture. No blur
 * filters, no animation, nothing per frame.
 */
import React, { useEffect, useRef } from 'react';
import { FIELD_GLOWS, useFieldGlowStore, type FieldGlowSpec } from '../lib/fieldGlow';
import styles from './FieldBackdrop.module.css';

type Palette = {
  core: string;
  green: string;
  halo: string;
  indigo: string;
  fill: string;
  hot: string;
  ribbon: [string, string, string, string];
  /** Pocket ink (rgb triple) and how much stronger the pocket is than the dark spec. */
  pocket: string;
  pocketScale: number;
  /** Vignette ink (rgb triple) and whether the theme has one. */
  vignette: string | null;
};

// update-progress.ps1 $palettes, as-is.
const PALETTES: Record<string, Palette> = {
  midnight: {
    core: '#3A6CFF', green: '#14B084', halo: '#7860FF', indigo: '#3A60E6', fill: '#5064F0', hot: '#96ECD6',
    ribbon: ['#28C896', '#3CBED2', '#6E96FF', '#8C6EFF'],
    pocket: '2,4,11', pocketScale: 1, vignette: '1,2,6',
  },
  ice: {
    core: '#7FB0FF', green: '#5CCB93', halo: '#A497FF', indigo: '#6F8FE8', fill: '#8FA8F5', hot: '#9DE3D2',
    ribbon: ['#5CCB93', '#6CC8DC', '#7FB0FF', '#A497FF'],
    pocket: '243,248,255', pocketScale: 1.1, vignette: null,
  },
  acorn: {
    core: '#E2B98A', green: '#B7C99A', halo: '#E8A98C', indigo: '#C9A27A', fill: '#D9B48C', hot: '#F3DEC0',
    ribbon: ['#B7C99A', '#E2C29A', '#D9A57E', '#C9967A'],
    pocket: '248,243,234', pocketScale: 1.1, vignette: null,
  },
  mint: {
    core: '#6CC79A', green: '#57B47C', halo: '#7FB0FF', indigo: '#7FD0C0', fill: '#A6DCB8', hot: '#B5E8D5',
    ribbon: ['#57B47C', '#7FD0C0', '#8FC4F0', '#7FB0FF'],
    pocket: '239,248,242', pocketScale: 1.1, vignette: null,
  },
};

/** Canvas px per CSS px. The glow is all soft gradients, so the upscale is invisible. */
const SCALE = 0.25;

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function blob(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  hex: string, a0: number, a1: number, rot = 0,
): void {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(w / 2, h / 2);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hex, a0));
  g.addColorStop(0.45, rgba(hex, a1));
  g.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The four-colour ribbon, faded out radially on its own canvas so its mask cannot cut the blobs. */
function ribbon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  hexes: Palette['ribbon'], alpha: number, rot: number, unit: number,
): void {
  const t = document.createElement('canvas');
  t.width = Math.max(2, Math.ceil(w * unit));
  t.height = Math.max(2, Math.ceil(h * unit));
  const c = t.getContext('2d');
  if (!c) return;
  const lg = c.createLinearGradient(0, 0, t.width, 0);
  [0, 0.38, 0.7, 1].forEach((o, k) => lg.addColorStop(o, rgba(hexes[k], alpha)));
  c.fillStyle = lg;
  c.fillRect(0, 0, t.width, t.height);
  c.globalCompositeOperation = 'destination-in';
  c.translate(t.width / 2, t.height / 2);
  c.scale(t.width / 2, t.height / 2);
  const m = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  m.addColorStop(0.2, 'rgba(0,0,0,1)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = m;
  c.fillRect(-1, -1, 2, 2);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(t, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** One patch: the update card's glow geometry (460 x 224 units), placed and scaled. */
function paintGlow(ctx: CanvasRenderingContext2D, W: number, H: number, spec: FieldGlowSpec, pal: Palette): void {
  const p = spec.patch;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(p.x * W, p.y * H);
  const sx = (p.w * W) / 460;
  const sy = (p.h * H) / 224;
  ctx.scale(sx, sy);
  if (p.flip) {
    ctx.translate(460, 0);
    ctx.scale(-1, 1);
  }
  ctx.globalAlpha = p.strength;
  blob(ctx, -92, -90, 276, 207, pal.indigo, 0.62, 0.3);
  blob(ctx, 267, -99, 322, 224, pal.halo, 0.85, 0.4);
  blob(ctx, 285, 49, 258, 139, pal.fill, 0.6, 0.3);
  blob(ctx, -110, 103, 340, 215, pal.green, 0.95, 0.5);
  blob(ctx, 138, 130, 414, 215, pal.core, 1, 0.55);
  ribbon(ctx, -64, 112, 589, 58, pal.ribbon, 0.8, -14, Math.max(sx, sy));
  blob(ctx, 120, 157, 138, 45, pal.hot, 0.8, 0.35, -14);
  ctx.restore();
}

/** The pocket behind the words and the edge vignette. */
function paintShade(ctx: CanvasRenderingContext2D, W: number, H: number, spec: FieldGlowSpec, pal: Palette): void {
  ctx.clearRect(0, 0, W, H);
  const k = spec.pocket;
  const a = Math.min(0.85, k.a * pal.pocketScale);
  ctx.save();
  ctx.translate(k.cx * W, k.cy * H);
  ctx.scale(k.rx * W, k.ry * H);
  const r = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  r.addColorStop(0, `rgba(${pal.pocket},${a})`);
  r.addColorStop(0.55, `rgba(${pal.pocket},${a * 0.5})`);
  r.addColorStop(1, `rgba(${pal.pocket},0)`);
  ctx.fillStyle = r;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
  if (pal.vignette) {
    ctx.save();
    ctx.translate(W * 0.5, H * 0.55);
    ctx.scale(W * 0.75, H * 0.85);
    const v = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    v.addColorStop(0.5, `rgba(${pal.vignette},0)`);
    v.addColorStop(1, `rgba(${pal.vignette},${spec.vignette})`);
    ctx.fillStyle = v;
    ctx.fillRect(-1.5, -1.5, 3, 3);
    ctx.restore();
  }
}

export function FieldBackdrop(): React.ReactElement {
  const glowRef = useRef<HTMLCanvasElement | null>(null);
  const dotsRef = useRef<HTMLCanvasElement | null>(null);
  const shadeRef = useRef<HTMLCanvasElement | null>(null);
  const glowName = useFieldGlowStore((s) => s.glow);

  useEffect(() => {
    const glow = glowRef.current;
    const dots = dotsRef.current;
    const shade = shadeRef.current;
    if (!glow || !dots || !shade) return;
    const root = document.documentElement;
    const paint = (): void => {
      const w = Math.max(1, Math.ceil(glow.clientWidth * SCALE));
      const h = Math.max(1, Math.ceil(glow.clientHeight * SCALE));
      const pal = PALETTES[root.dataset.theme ?? 'midnight'] ?? PALETTES.midnight;
      const spec = FIELD_GLOWS[glowName];
      for (const c of [glow, dots, shade]) {
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
      }
      const g = glow.getContext('2d');
      const d = dots.getContext('2d');
      const s = shade.getContext('2d');
      if (!g || !d || !s) return;
      paintGlow(g, w, h, spec, pal);
      d.clearRect(0, 0, w, h);
      d.drawImage(glow, 0, 0);
      paintShade(s, w, h, spec, pal);
    };
    paint();
    const ro = new ResizeObserver(() => paint());
    ro.observe(glow);
    const mo = new MutationObserver(() => paint());
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [glowName]);

  return (
    <div className={styles.root} aria-hidden="true" data-field-glow={glowName}>
      <canvas ref={glowRef} className={`${styles.layer} ${styles.soft}`} />
      <canvas ref={dotsRef} className={`${styles.layer} ${styles.dots}`} />
      <div className={`${styles.layer} ${styles.texture}`} />
      <canvas ref={shadeRef} className={styles.layer} />
    </div>
  );
}
