/**
 * The first-link intro's two effect canvases (261105, T337): `back` sits
 * behind the room (grid, wireframe box, data rain, light tunnel), `front`
 * over it (scan beams, portal rim, projector ring, data streams, motes,
 * monitor outline). Everything is drawn from an IntroFrame and hash01, never
 * Math.random, so the same t draws the same picture.
 */
import { ease, hash01, span } from '../../../lib/seilink/introTimeline';
import type { Box, IntroFrame } from './introFrame';

const GLOW = '127, 176, 255';
const HOT = '236, 244, 255';
const MAGENTA = '255, 64, 160';
const CYAN = '64, 230, 255';
const GLYPHS = '0123456789ABCDEFｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ';

function rgba(c: string, a: number): string {
  return `rgba(${c}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** Where the room's own frame is now (the stage transform applied to the full window). */
export function stageBox(f: IntroFrame): Box {
  const w = f.W * f.stage.scale;
  const h = f.H * f.stage.scale;
  return { x: (f.W - w) / 2 + f.stage.tx, y: (f.H - h) / 2 + f.stage.ty, w, h };
}

export function drawBack(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const { W, H } = f;
  ctx.clearRect(0, 0, W, H);
  if (f.fx.grid > 0) drawGrid(ctx, f);
  if (f.fx.wire > 0) drawWireBox(ctx, f);
  if (f.fx.rain > 0) drawRain(ctx, f, f.fx.rain);
  if (f.fx.tunnel > 0) drawTunnel(ctx, f);
  if (f.fx.ripple >= 0) drawRipple(ctx, f);
}

export function drawFront(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box | null): void {
  const { W, H } = f;
  ctx.clearRect(0, 0, W, H);
  if (f.fx.beam >= 0) drawBeam(ctx, f);
  if (f.fx.rim > 0 && f.fx.portalR > 0) drawRim(ctx, f);
  if (f.style === 'tunnel' && f.fx.window > 0 && f.fx.window < 1) drawWindowEdge(ctx, f);
  if (her) {
    if (f.fx.ring > 0) drawRing(ctx, her, f.fx.ring, f.t);
    if (f.fx.herScan >= 0) drawHerScan(ctx, her, f.fx.herScan, f.t);
    if (f.fx.stream >= 0) drawStreams(ctx, f, her);
    if (f.fx.motes >= 0) drawMotes(ctx, f, her);
  }
  if (f.fx.outline > 0 && f.fx.outline < 1.0001) drawOutline(ctx, f);
  if (f.fx.linkedPulse > 0) drawPulse(ctx, f);
}

// ── holo ────────────────────────────────────────────────────────────────────

function drawGrid(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const { W, H, t } = f;
  const a = f.fx.grid;
  const horizon = H * 0.56;
  const vx = W / 2;
  ctx.save();
  ctx.lineWidth = 1;
  // Fading toward the horizon.
  const grad = ctx.createLinearGradient(0, horizon, 0, H);
  grad.addColorStop(0, rgba(GLOW, 0));
  grad.addColorStop(1, rgba(GLOW, 0.55 * a));
  ctx.strokeStyle = grad;
  ctx.beginPath();
  for (let i = -24; i <= 24; i++) {
    const x = vx + i * (W / 16);
    ctx.moveTo(vx + (x - vx) * 0.02, horizon);
    ctx.lineTo(x, H);
  }
  // Horizontal lines rolling toward the viewer.
  const roll = (t / 1400) % 1;
  for (let k = 0; k < 18; k++) {
    const z = (k + roll) / 18;
    const y = horizon + (H - horizon) * z * z;
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
  // A faint mirrored ceiling grid.
  const g2 = ctx.createLinearGradient(0, 0, 0, horizon - H * 0.12);
  g2.addColorStop(0, rgba(GLOW, 0.18 * a));
  g2.addColorStop(1, rgba(GLOW, 0));
  ctx.strokeStyle = g2;
  ctx.beginPath();
  const top = horizon - H * 0.12;
  for (let i = -24; i <= 24; i++) {
    const x = vx + i * (W / 16);
    ctx.moveTo(vx + (x - vx) * 0.02, top);
    ctx.lineTo(x, 0);
  }
  ctx.stroke();
  ctx.restore();
}

function partialPolyline(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>, p: number): void {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * p;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length && left > 0; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const d = Math.hypot(bx - ax, by - ay);
    const k = Math.min(1, left / d);
    ctx.lineTo(ax + (bx - ax) * k, ay + (by - ay) * k);
    left -= d;
  }
}

function drawWireBox(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const { W, H } = f;
  const p = f.fx.wire;
  const fx0 = W * 0.06;
  const fy0 = H * 0.07;
  const fx1 = W * 0.94;
  const fy1 = H * 0.93;
  const bw = W * 0.5;
  const bh = H * 0.5;
  const bx0 = (W - bw) / 2;
  const by0 = H * 0.2;
  const bx1 = bx0 + bw;
  const by1 = by0 + bh;
  ctx.save();
  ctx.strokeStyle = rgba(GLOW, 0.9);
  ctx.shadowColor = rgba(GLOW, 0.9);
  ctx.shadowBlur = 12;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Back wall, corner rays, then the window and shelf hints.
  partialPolyline(ctx, [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1], [bx0, by0]], ease.out(span(p, 0, 0.45)));
  const rays: Array<[[number, number], [number, number]]> = [
    [[bx0, by0], [fx0, fy0]],
    [[bx1, by0], [fx1, fy0]],
    [[bx1, by1], [fx1, fy1]],
    [[bx0, by1], [fx0, fy1]],
  ];
  const rp = span(p, 0.3, 0.8);
  for (const [a, b] of rays) partialPolyline(ctx, [a, b], rp);
  const wx0 = bx0 + bw * 0.58;
  const wy0 = by0 + bh * 0.14;
  partialPolyline(ctx, [[wx0, wy0], [wx0 + bw * 0.3, wy0], [wx0 + bw * 0.3, wy0 + bh * 0.42], [wx0, wy0 + bh * 0.42], [wx0, wy0]], span(p, 0.6, 1));
  const sx = bx0 + bw * 0.08;
  partialPolyline(ctx, [[sx, by0 + bh * 0.3], [sx + bw * 0.32, by0 + bh * 0.3]], span(p, 0.7, 1));
  partialPolyline(ctx, [[sx, by0 + bh * 0.52], [sx + bw * 0.32, by0 + bh * 0.52]], span(p, 0.75, 1));
  ctx.stroke();
  // Vertex dots.
  ctx.fillStyle = rgba(HOT, 0.95 * span(p, 0.1, 0.4));
  for (const [x, y] of [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]] as Array<[number, number]>) {
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBeam(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const s = stageBox(f);
  const y = s.y + s.h * f.fx.beam;
  ctx.save();
  const g = ctx.createLinearGradient(0, y - 40, 0, y + 6);
  g.addColorStop(0, rgba(GLOW, 0));
  g.addColorStop(0.85, rgba(GLOW, 0.35));
  g.addColorStop(1, rgba(HOT, 0.95));
  ctx.fillStyle = g;
  ctx.fillRect(s.x, y - 40, s.w, 46);
  ctx.fillStyle = rgba(HOT, 1);
  ctx.shadowColor = rgba(GLOW, 1);
  ctx.shadowBlur = 18;
  ctx.fillRect(s.x, y - 1, s.w, 2);
  // Sparks along the edge.
  ctx.shadowBlur = 8;
  for (let i = 0; i < 40; i++) {
    const x = s.x + hash01(i, Math.floor(f.t / 60)) * s.w;
    const a = hash01(i, 99 + Math.floor(f.t / 80));
    ctx.fillStyle = rgba(HOT, 0.4 + 0.6 * a);
    ctx.fillRect(x, y - 1 - a * 3, 2, 2);
  }
  ctx.restore();
}

function drawRing(ctx: CanvasRenderingContext2D, her: Box, a: number, t: number): void {
  const cx = her.x + her.w / 2;
  const cy = her.y + her.h * 0.98;
  const rx = her.w * 0.62;
  const ry = rx * 0.16;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const k = 1 + i * 0.18 + ((t / 900) % 1) * 0.18;
    ctx.strokeStyle = rgba(GLOW, a * (0.75 - i * 0.22));
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(GLOW, a);
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The projector cone up through her.
  const g = ctx.createLinearGradient(0, cy, 0, her.y);
  g.addColorStop(0, rgba(GLOW, 0.22 * a));
  g.addColorStop(1, rgba(GLOW, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(cx - rx, cy);
  ctx.lineTo(cx + rx, cy);
  ctx.lineTo(cx + rx * 0.7, her.y);
  ctx.lineTo(cx - rx * 0.7, her.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHerScan(ctx: CanvasRenderingContext2D, her: Box, frac: number, t: number): void {
  const y = her.y + her.h * frac;
  const x0 = her.x - her.w * 0.25;
  const w = her.w * 1.5;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
  g.addColorStop(0, rgba(GLOW, 0));
  g.addColorStop(0.5, rgba(HOT, 0.95));
  g.addColorStop(1, rgba(GLOW, 0));
  ctx.fillStyle = g;
  ctx.shadowColor = rgba(GLOW, 1);
  ctx.shadowBlur = 14;
  ctx.fillRect(x0, y - 1.5, w, 3);
  for (let i = 0; i < 24; i++) {
    const px = her.x + hash01(i, Math.floor(t / 70)) * her.w;
    const py = y + hash01(i, 7 + Math.floor(t / 70)) * her.h * 0.12;
    ctx.fillStyle = rgba(HOT, 0.6 * hash01(i, 3));
    ctx.fillRect(px, py, 2, 2);
  }
  ctx.restore();
}

function drawOutline(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const b = f.bezel;
  ctx.save();
  ctx.strokeStyle = rgba(GLOW, 0.95);
  ctx.shadowColor = rgba(GLOW, 1);
  ctx.shadowBlur = 16;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const cx = b.x + b.w / 2;
  // Two halves drawn from the bottom centre, meeting at the top.
  const right: Array<[number, number]> = [[cx, b.y + b.h], [b.x + b.w, b.y + b.h], [b.x + b.w, b.y], [cx, b.y]];
  const left: Array<[number, number]> = [[cx, b.y + b.h], [b.x, b.y + b.h], [b.x, b.y], [cx, b.y]];
  partialPolyline(ctx, right, f.fx.outline);
  partialPolyline(ctx, left, f.fx.outline);
  ctx.stroke();
  ctx.restore();
}

function drawPulse(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const b = f.bezel;
  const a = f.fx.linkedPulse;
  ctx.save();
  ctx.strokeStyle = rgba(GLOW, 0.8 * a);
  ctx.shadowColor = rgba(GLOW, a);
  ctx.shadowBlur = 40 * a;
  ctx.lineWidth = 2 + 2 * a;
  const grow = (1 - a) * 18;
  ctx.strokeRect(b.x - grow, b.y - grow, b.w + grow * 2, b.h + grow * 2);
  ctx.restore();
}

// ── glitch ──────────────────────────────────────────────────────────────────

function drawRain(ctx: CanvasRenderingContext2D, f: IntroFrame, a: number): void {
  const { W, H, t } = f;
  const size = Math.max(14, Math.round(H / 54));
  const cols = Math.ceil(W / size);
  ctx.save();
  ctx.font = `${size}px ${'JetBrains Mono'}, ui-monospace, monospace`;
  ctx.textBaseline = 'top';
  for (let c = 0; c < cols; c++) {
    const speed = 0.25 + hash01(c, 1) * 0.6;
    const len = 6 + Math.floor(hash01(c, 2) * 18);
    const headY = ((t * speed * 0.6 + hash01(c, 3) * H * 2) % (H + len * size)) - len * size * 0.2;
    for (let k = 0; k < len; k++) {
      const y = headY - k * size;
      if (y < -size || y > H) continue;
      const g = GLYPHS[Math.floor(hash01(c * 131 + k, Math.floor(t / 90) + k) * GLYPHS.length)];
      const fade = 1 - k / len;
      ctx.fillStyle = k === 0 ? rgba(HOT, a * 0.95) : rgba(c % 7 === 0 ? MAGENTA : GLOW, a * 0.55 * fade);
      ctx.fillText(g, c * size, y);
    }
  }
  ctx.restore();
}

function drawRim(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const { W, H, t } = f;
  const R = f.fx.portalR;
  const cx = W / 2;
  const cy = H / 2;
  const seg = 160;
  const frameKey = Math.floor(t / 33);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const layers: Array<[string, number, number]> = [
    [MAGENTA, -5, 0.85],
    [CYAN, 5, 0.85],
    [HOT, 0, 1],
  ];
  for (const [col, off, alpha] of layers) {
    ctx.strokeStyle = rgba(col, alpha);
    ctx.shadowColor = rgba(col, 1);
    ctx.shadowBlur = 18;
    ctx.lineWidth = col === HOT ? 2 : 3;
    ctx.beginPath();
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * Math.PI * 2;
      const jag = (hash01(i, frameKey) - 0.5) * Math.max(6, R * 0.035) * (hash01(i >> 3, frameKey) > 0.7 ? 3 : 1);
      const r = R + jag;
      const x = cx + Math.cos(ang) * r + off;
      const y = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Inner glow.
  const g = ctx.createRadialGradient(cx, cy, Math.max(0, R - 60), cx, cy, R + 30);
  g.addColorStop(0, rgba(GLOW, 0));
  g.addColorStop(0.7, rgba(GLOW, 0.25));
  g.addColorStop(1, rgba(GLOW, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawStreams(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box): void {
  const p = f.fx.stream;
  const { H, t } = f;
  const size = Math.max(13, Math.round(H / 60));
  const n = 26;
  ctx.save();
  ctx.font = `${size}px ${'JetBrains Mono'}, ui-monospace, monospace`;
  ctx.textBaseline = 'top';
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = her.x + her.w * (0.1 + 0.8 * hash01(i, 21));
    const start = hash01(i, 22) * 0.45;
    const q = span(p, start, start + 0.45);
    if (q <= 0 || q >= 1) continue;
    const targetY = her.y + her.h * (0.15 + 0.75 * hash01(i, 23));
    const headY = -size * 4 + (targetY + size * 4) * ease.in(q);
    const len = 10;
    for (let k = 0; k < len; k++) {
      const y = headY - k * size * 1.05;
      if (y < -size) break;
      const g = GLYPHS[Math.floor(hash01(i * 17 + k, Math.floor(t / 70)) * GLYPHS.length)];
      ctx.fillStyle = k === 0 ? rgba(HOT, 0.95) : rgba(i % 3 === 0 ? MAGENTA : CYAN, 0.7 * (1 - k / len));
      ctx.fillText(g, x, y);
    }
    // A burst where it lands.
    if (q > 0.9) {
      const a = (q - 0.9) / 0.1;
      ctx.fillStyle = rgba(HOT, 0.8 * (1 - a));
      ctx.beginPath();
      ctx.arc(x + size / 3, targetY, 4 + 14 * a, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ── tunnel ──────────────────────────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function drawTunnel(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const { W, H } = f;
  const a = f.fx.tunnel;
  const phase = f.fx.tunnelPhase * 6;
  const cx = W / 2;
  const cy = H / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // The bright point at the far end.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.32);
  core.addColorStop(0, rgba(HOT, 0.85 * a));
  core.addColorStop(0.25, rgba(GLOW, 0.35 * a));
  core.addColorStop(1, rgba(GLOW, 0));
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, W, H);
  // Rings of light flying past.
  const N = 22;
  for (let i = 0; i < N; i++) {
    let d = (i / N - phase) % 1;
    if (d < 0) d += 1;
    const depth = 0.04 + d * 0.96;
    const s = 0.05 / depth;
    if (s > 1.6) continue;
    const w = W * s;
    const h = H * s;
    const alpha = a * Math.min(1, s * 3) * Math.max(0, 1 - (s - 0.9) / 0.7);
    ctx.strokeStyle = rgba(i % 4 === 0 ? HOT : GLOW, alpha * 0.85);
    ctx.lineWidth = Math.max(1, 3 * s);
    ctx.shadowColor = rgba(GLOW, alpha);
    ctx.shadowBlur = 20 * s;
    ctx.beginPath();
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, Math.min(24, 40 * s));
    ctx.stroke();
  }
  // Light streaks.
  ctx.shadowBlur = 0;
  const M = 64;
  for (let k = 0; k < M; k++) {
    const ang = hash01(k, 41) * Math.PI * 2;
    let r = (hash01(k, 42) + phase * (0.6 + hash01(k, 43))) % 1;
    if (r < 0) r += 1;
    const r0 = Math.pow(r, 2.2) * Math.hypot(W, H) * 0.6;
    const len = 30 + r * 220;
    const g = ctx.createLinearGradient(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0, cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
    g.addColorStop(0, rgba(GLOW, 0));
    g.addColorStop(1, rgba(HOT, 0.55 * a * r));
    ctx.strokeStyle = g;
    ctx.lineWidth = 1 + r * 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
    ctx.stroke();
  }
  ctx.restore();
}

function drawWindowEdge(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const s = stageBox(f);
  const k = f.fx.window;
  const w = s.w * k;
  const h = s.h * k;
  const x = s.x + (s.w - w) / 2;
  const y = s.y + (s.h - h) / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rgba(HOT, 0.9 * (1 - k * 0.6));
  ctx.shadowColor = rgba(GLOW, 1);
  ctx.shadowBlur = 30;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawMotes(ctx: CanvasRenderingContext2D, f: IntroFrame, her: Box): void {
  const p = f.fx.motes;
  const { W, H } = f;
  const cx = her.x + her.w / 2;
  const cy = her.y + her.h / 2;
  const reach = Math.hypot(W, H) * 0.55;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const n = 110;
  for (let i = 0; i < n; i++) {
    const start = hash01(i, 51) * 0.4;
    const q = span(p, start, start + 0.5);
    if (q <= 0 || q >= 1) continue;
    const ang = hash01(i, 52) * Math.PI * 2;
    const swirl = (1 - q) * 1.4 * (hash01(i, 53) > 0.5 ? 1 : -1);
    const sx = cx + Math.cos(ang) * reach;
    const sy = cy + Math.sin(ang) * reach;
    // Targets spread over her silhouette (narrower at the head).
    const ty = her.y + her.h * (0.08 + 0.88 * hash01(i, 54));
    const spread = 0.18 + 0.22 * ((ty - her.y) / her.h);
    const tx = cx + (hash01(i, 55) - 0.5) * her.w * spread * 2;
    const e = ease.inOut(q);
    const mx = sx + (tx - sx) * e;
    const my = sy + (ty - sy) * e;
    const rx = cx + (mx - cx) * Math.cos(swirl) - (my - cy) * Math.sin(swirl);
    const ry = cy + (mx - cx) * Math.sin(swirl) + (my - cy) * Math.cos(swirl);
    const a = Math.sin(q * Math.PI) * 0.95;
    const r = 1.5 + 2.5 * hash01(i, 56);
    const g = ctx.createRadialGradient(rx, ry, 0, rx, ry, r * 5);
    g.addColorStop(0, rgba(HOT, a));
    g.addColorStop(0.3, rgba(GLOW, a * 0.5));
    g.addColorStop(1, rgba(GLOW, 0));
    ctx.fillStyle = g;
    ctx.fillRect(rx - r * 5, ry - r * 5, r * 10, r * 10);
  }
  // A soft halo where they gather.
  const halo = Math.sin(span(p, 0.35, 1) * Math.PI);
  if (halo > 0) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, her.h * 0.6);
    g.addColorStop(0, rgba(HOT, 0.3 * halo));
    g.addColorStop(1, rgba(GLOW, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - her.h, cy - her.h, her.h * 2, her.h * 2);
  }
  ctx.restore();
}

function drawRipple(ctx: CanvasRenderingContext2D, f: IntroFrame): void {
  const b = f.bezel;
  const p = f.fx.ripple;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const q = span(p, i * 0.18, 0.6 + i * 0.18);
    if (q <= 0 || q >= 1) continue;
    const grow = ease.out(q) * Math.min(b.w, b.h) * 0.22;
    ctx.strokeStyle = rgba(GLOW, 0.6 * (1 - q));
    ctx.shadowColor = rgba(GLOW, 0.8 * (1 - q));
    ctx.shadowBlur = 24;
    ctx.lineWidth = 2;
    ctx.beginPath();
    roundRect(ctx, b.x - grow, b.y - grow, b.w + grow * 2, b.h + grow * 2, 6 + grow * 0.2);
    ctx.stroke();
  }
  ctx.restore();
}
