/**
 * Static foam rings on the water: a soft wash and a wobbly, broken white band
 * around each floating hull and each corner buoy. They are flat textured
 * planes drawn once, so they never ask the on-demand scene for a frame.
 *
 * Colors are 3D art-asset values (literal by design, like the chess scene).
 */

import * as THREE from 'three';
import type { TabletopStage } from '../../tabletop/TabletopStage';

const PX_PER_UNIT = 96;

/** Deterministic 0..1 noise so every ring of a size looks the same. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A stadium path (or a circle when w equals h), centred on the canvas. */
function stadium(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2 + r, cy - h / 2);
  ctx.lineTo(cx + w / 2 - r, cy - h / 2);
  ctx.arc(cx + w / 2 - r, cy, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(cx - w / 2 + r, cy + h / 2);
  ctx.arc(cx - w / 2 + r, cy, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
}

/** Point and outward normal at arc length s along a w by h stadium (w >= h). */
function stadiumAt(w: number, h: number, s: number): { x: number; y: number; nx: number; ny: number } {
  const r = h / 2;
  const flat = w - h;
  const arc = Math.PI * r;
  if (s < flat) return { x: -flat / 2 + s, y: -r, nx: 0, ny: -1 };
  s -= flat;
  if (s < arc) {
    const a = -Math.PI / 2 + s / r;
    return { x: flat / 2 + Math.cos(a) * r, y: Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
  }
  s -= arc;
  if (s < flat) return { x: flat / 2 - s, y: r, nx: 0, ny: 1 };
  s -= flat;
  const a = Math.PI / 2 + s / r;
  return { x: -flat / 2 + Math.cos(a) * r, y: Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
}

/**
 * A ring texture for an outline of w by h units (plus a margin for the soft
 * wash). Returned with the plane size it should be drawn at.
 */
function ringTexture(w: number, h: number, seed: number): { tex: THREE.CanvasTexture; pw: number; ph: number } {
  const margin = 0.22;
  const pw = w + margin * 2;
  const ph = h + margin * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(pw * PX_PER_UNIT);
  canvas.height = Math.ceil(ph * PX_PER_UNIT);
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  if (!ctx) return { tex, pw, ph };
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const u = PX_PER_UNIT;

  // A soft, faint wash hugging the hull: the water it pushes aside.
  ctx.filter = `blur(${Math.round(u * 0.07)}px)`;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
  ctx.lineWidth = u * 0.2;
  stadium(ctx, cx, cy, w * u, h * u);
  ctx.stroke();
  ctx.filter = 'none';

  // The foam line: a hand-drawn, slightly wobbly band whose width swells and
  // thins, with a few gaps, so it reads as foam rather than a selection mark.
  const next = rand(seed);
  const ww = Math.max(w, h);
  const hh = Math.min(w, h);
  const perimeter = 2 * (ww - hh) + Math.PI * hh;
  const phase = [next() * 6.283, next() * 6.283, next() * 6.283];
  const waves = [Math.max(2, Math.round(perimeter / 0.9)), Math.max(3, Math.round(perimeter / 0.6))];
  const gaps: Array<[number, number]> = [];
  const gapCount = 2 + Math.floor(next() * 2);
  for (let i = 0; i < gapCount; i++) {
    const at = ((i + 0.2 + next() * 0.6) / gapCount) * perimeter;
    gaps.push([at, at + 0.06 + next() * 0.1]);
  }
  const inGap = (s: number): number => {
    // 1 inside a gap, easing to 0 over 0.05 units at its edges.
    let g = 0;
    for (const [a, b] of gaps) {
      const d = Math.max(a - s, s - b, 0);
      g = Math.max(g, 1 - Math.min(1, d / 0.05));
    }
    return g;
  };
  const steps = Math.ceil(perimeter * u * 0.5);
  const outer: Array<[number, number]> = [];
  const inner: Array<[number, number]> = [];
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  const flush = (): void => {
    if (outer.length > 1) {
      ctx.beginPath();
      ctx.moveTo(outer[0][0], outer[0][1]);
      for (const [x, y] of outer) ctx.lineTo(x, y);
      for (let i = inner.length - 1; i >= 0; i--) ctx.lineTo(inner[i][0], inner[i][1]);
      ctx.closePath();
      ctx.fill();
    }
    outer.length = 0;
    inner.length = 0;
  };
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * perimeter;
    const t = (s / perimeter) * Math.PI * 2;
    const p = stadiumAt(ww, hh, s);
    const off = 0.025 * Math.sin(t * waves[0] + phase[0]) + 0.007 * Math.sin(t * waves[1] + phase[1]);
    const half = (0.028 + 0.018 * Math.sin(t * waves[1] * 0.5 + phase[2])) * (1 - inGap(s));
    if (half < 0.004) {
      flush();
      continue;
    }
    // Swap axes when the ring is taller than wide, so h stays along canvas y.
    const px = w >= h ? p.x : p.y;
    const py = w >= h ? p.y : p.x;
    const nx = w >= h ? p.nx : p.ny;
    const ny = w >= h ? p.ny : p.nx;
    const o = off + half;
    const n = off - half;
    outer.push([cx + (px + nx * o) * u, cy + (py + ny * o) * u]);
    inner.push([cx + (px + nx * n) * u, cy + (py + ny * n) * u]);
  }
  flush();

  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, pw, ph };
}

export class FoamRings {
  private readonly cache = new Map<string, { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial }>();
  private readonly stage: TabletopStage;

  constructor(stage: TabletopStage) {
    this.stage = stage;
  }

  /**
   * A flat ring mesh lying on the water (local XZ plane, centred), w along X
   * and h along Z. Meshes of the same size share geometry and texture.
   */
  ring(w: number, h: number): THREE.Mesh {
    const key = `${w.toFixed(2)}x${h.toFixed(2)}`;
    let r = this.cache.get(key);
    if (!r) {
      const { tex, pw, ph } = ringTexture(w, h, Math.round(w * 131 + h * 977));
      const own = this.stage.own.bind(this.stage);
      const geo = own(new THREE.PlaneGeometry(pw, ph));
      geo.rotateX(-Math.PI / 2);
      const mat = own(
        new THREE.MeshBasicMaterial({ map: own(tex), transparent: true, depthWrite: false, toneMapped: false }),
      );
      r = { geo, mat };
      this.cache.set(key, r);
    }
    const mesh = new THREE.Mesh(r.geo, r.mat);
    mesh.renderOrder = -4;
    return mesh;
  }
}
