/**
 * PNGTuber Remix model player (261122 spike): steps and draws a parsed
 * `sei-pngremix` spec (src/shared/pngremix/pngRemix.ts) on a 2D canvas.
 *
 * It follows Remix's own node chain per layer (SpriteObject -> Modifier1 ->
 * Rotation -> Modifier -> Sprite2D; children hang under the parent's
 * Sprite2D) and approximates its motion code:
 *  - container (SpritesContainer.gd): bounce physics (gravity, relaunch on
 *    "Bouncy", one-shot bounces on mouth open/close), wobble, float, squish;
 *  - per layer (movements.gd): sine wobble, sine rotation, drag lag, and the
 *    movement-driven rotation and squash/stretch, fed down the tree when a
 *    layer has physics on;
 *  - blink and talk switches hide a layer and its subtree;
 *  - clip children (pupils inside eye whites) composite through an
 *    offscreen buffer;
 *  - modulate (subtree) and tint (own image) colour, alpha;
 *  - a wiggly appendage is a curled, wagging textured strip (no physics).
 * Remix's per-frame lerps are converted to frame-rate independent ones.
 */
import type { PngRemixLayer, PngRemixLayerState, PngRemixMotion, PngRemixSpec, PngRemixBounce } from '@shared/pngremix/pngRemix';

export type Mat = [number, number, number, number, number, number];
export type Drawable = CanvasImageSource & { width: number; height: number };

export function mul(p: Mat, q: Mat): Mat {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
export function trs(x: number, y: number, r: number, sx: number, sy: number): Mat {
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Remix per-frame lerp factor `a` (60 Hz) as a factor for `frames` frames. */
const lerpK = (a: number, frames: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, a)), frames);
const deg = (d: number): number => (d * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  d = ((2 * d) % (Math.PI * 2)) - d;
  return a + d * t;
}
/** Remix's phys_eff default: every movement term is scaled by it / 200. */
const PHYS = 25 / 200;

export interface RigInput {
  /** Seconds since the last step. */
  dt: number;
  mouthOpen: boolean;
  eyesClosed: boolean;
}

interface LayerRun {
  wob: [number, number];
  rot: number;
  stretch: [number, number];
  spin: number;
  dragger: [number, number] | null;
  dragOff: [number, number];
  length: number;
  // Per-frame results:
  visible: boolean;
  attach: Mat; // the Sprite2D transform (children hang here)
  z: number;
  rgb: [number, number, number];
  alpha: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class PngRemixRig {
  private readonly runs: LayerRun[];
  private readonly children: number[][];
  private state = 0;
  private tick = 0;
  // Container.
  private bounceY = 0;
  private yVel = 0;
  private cPos: [number, number] = [0, 0];
  private cScale: [number, number] = [1, 1];
  private bounceChange = 0;
  private squishT = -1;
  private wasOpen = false;
  private wasClosedEyes = false;
  private tintCache = new Map<string, HTMLCanvasElement>();
  private offscreen: HTMLCanvasElement[] = [];

  constructor(
    readonly spec: PngRemixSpec,
    private readonly images: Array<Drawable | null>,
    private readonly makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  ) {
    this.runs = spec.layers.map(() => ({
      wob: [0, 0],
      rot: 0,
      stretch: [1, 1],
      spin: 0,
      dragger: null,
      dragOff: [0, 0],
      length: 0,
      visible: true,
      attach: [1, 0, 0, 1, 0, 0],
      z: 0,
      rgb: [1, 1, 1],
      alpha: 1,
    }));
    this.children = spec.layers.map(() => []);
    spec.layers.forEach((l, i) => {
      if (l.parent >= 0) this.children[l.parent]!.push(i);
    });
  }

  get stateIndex(): number {
    return this.state;
  }

  setState(i: number): void {
    const next = clamp(Math.trunc(i), 0, this.spec.states.length - 1);
    if (next === this.state) return;
    this.state = next;
  }

  /** Advance motion by `input.dt` seconds and lay out every layer. */
  step(input: RigInput): void {
    const dt = clamp(input.dt, 0, 0.1);
    const f = dt * 60; // Remix physics frames this step
    this.tick += dt * this.spec.tickRate;
    const st = this.spec.states[this.state]!;
    const open = input.mouthOpen;
    const phase: PngRemixBounce = open ? st.open : st.closed;

    // ── Container (SpritesContainer.gd) ──
    if (open !== this.wasOpen) {
      this.wasOpen = open;
      const shot = phase.onEnter;
      if (shot === 1 && this.bounceY > -1) this.yVel = -phase.energy;
      if (shot === 3 && this.bounceY > -16) this.yVel = -st.open.energy;
    }
    const prevY = this.bounceY;
    this.bounceY = Math.min(0, this.bounceY + this.yVel * dt);
    this.bounceChange = f > 0 ? (prevY - this.bounceY) / f : 0;
    this.yVel = clamp(this.yVel + phase.gravity * dt, -9e7, 9e7);
    const k08 = lerpK(0.08, f);
    switch (phase.anim) {
      case 'bouncy':
        if (this.bounceY > -1) this.yVel = -phase.energy;
        break;
      case 'wobble':
        this.cPos[0] += (Math.sin(this.tick * phase.xFrq) * phase.xAmp - this.cPos[0]) * k08;
        this.cPos[1] += (Math.sin(this.tick * phase.yFrq) * phase.yAmp - this.cPos[1]) * k08;
        this.bounceChange = this.cPos[1] / 10;
        break;
      case 'float':
        this.cPos[1] += (Math.sin(this.tick * phase.yFrq) * phase.yAmp - this.cPos[1]) * k08;
        this.bounceChange = this.cPos[1] / 8;
        break;
      case 'squish': {
        this.cPos[1] += (Math.sin(this.tick * phase.yFrq) * phase.yAmp - this.cPos[1]) * k08;
        const v = this.cPos[1] * 0.01;
        this.cScale[0] += (1 - v - this.cScale[0]) * k08;
        this.cScale[1] += (1 + v - this.cScale[1]) * k08;
        break;
      }
      default: {
        const k05 = lerpK(0.05, f);
        this.cPos[0] -= this.cPos[0] * k05;
        this.cPos[1] -= this.cPos[1] * k05;
      }
    }
    if (phase.anim !== 'squish') {
      this.cScale[0] += (1 - this.cScale[0]) * k08;
      this.cScale[1] += (1 - this.cScale[1]) * k08;
    }
    // Blink squish (a 0.25 s squash, then 0.1 s back).
    if (input.eyesClosed && !this.wasClosedEyes && st.blinkSquish > 0) this.squishT = 0;
    this.wasClosedEyes = input.eyesClosed;
    let squishY = 1;
    if (this.squishT >= 0) {
      this.squishT += dt;
      const amt = st.blinkSquish;
      const s0 = 1 / amt;
      if (this.squishT < 0.25) squishY = s0 + (amt - s0) * Math.sin((this.squishT / 0.25) * (Math.PI / 2));
      else if (this.squishT < 0.35) squishY = amt + (1 - amt) * Math.sin(((this.squishT - 0.25) / 0.1) * (Math.PI / 2));
      else this.squishT = -1;
    }

    const container = mul(trs(0, this.bounceY, 0, 1, 1), trs(this.cPos[0], this.cPos[1], 0, this.cScale[0], this.cScale[1] * squishY));
    this.layout(container, input, f, true);
  }

  /** Lay out every layer under `container`; `animate` false gives the rest pose. */
  private layout(container: Mat, input: RigInput, f: number, animate: boolean): void {
    const layers = this.spec.layers;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]!;
      const run = this.runs[i]!;
      const st = l.states[this.state]!;
      const parent = l.parent >= 0 ? this.runs[l.parent]! : null;
      const parentAttach = parent ? parent.attach : container;

      run.visible =
        (parent ? parent.visible : true) &&
        st.visible &&
        !l.startHidden &&
        !(st.blink === 1 && input.eyesClosed) &&
        !(st.blink === 2 && !input.eyesClosed) &&
        !(st.talk === 1 && !input.mouthOpen) &&
        !(st.talk === 2 && input.mouthOpen);
      run.z = (parent ? parent.z : 0) + st.z;
      const pr = parent ? parent.rgb : ([1, 1, 1] as [number, number, number]);
      run.rgb = [pr[0] * st.colored[0], pr[1] * st.colored[1], pr[2] * st.colored[2]];
      run.alpha = (parent ? parent.alpha : 1) * st.colored[3];

      const root = mul(parentAttach, trs(st.pos[0], st.pos[1], st.rot, st.scale[0], st.scale[1]));
      let modifier: Mat = [1, 0, 0, 1, 0, 0];
      if (animate && !l.still) {
        const m: PngRemixMotion = input.mouthOpen && st.motionOpen ? st.motionOpen : st.motion;
        const k5 = lerpK(0.5, f);
        run.wob[0] += (Math.sin(this.tick * m.xFrq) * m.xAmp - run.wob[0]) * k5;
        run.wob[1] += (Math.sin(this.tick * m.yFrq) * m.yAmp - run.wob[1]) * k5;
        const target = apply(root, run.wob[0], run.wob[1]);
        const prev = run.dragger ?? target;
        let dragger: [number, number] = target;
        if (m.drag > 0)
          dragger = [
            prev[0] + (target[0] - prev[0]) * lerpK(1 / Math.max(1, m.drag), f),
            prev[1] + (target[1] - prev[1]) * lerpK(1 / Math.max(1, m.drag), f),
          ];
        run.dragger = dragger;
        // Lag as an offset in the layer's own frame (the inverse of root's linear part).
        const det = root[0] * root[3] - root[1] * root[2];
        if (m.drag > 0 && Math.abs(det) > 1e-9) {
          const dx = dragger[0] - target[0];
          const dy = dragger[1] - target[1];
          const lx = (root[3] * dx - root[2] * dy) / det;
          const ly = (-root[1] * dx + root[0] * dy) / det;
          const k = lerpK(0.5, f);
          run.dragOff[0] += (lx - run.dragOff[0]) * k;
          run.dragOff[1] += (ly - run.dragOff[1]) * k;
        } else {
          run.dragOff[0] = 0;
          run.dragOff[1] = 0;
        }
        // Movement this frame (Remix: glob - dragger, x + y), per 60 Hz frame.
        let length = f > 0 ? (prev[0] - dragger[0] + (prev[1] - dragger[1])) / f : 0;
        if (st.ignoreBounce) length -= this.bounceChange;
        if (st.physics && parent) length += parent.length;
        run.length = clamp(length, -1e4, 1e4);
        const s = run.length * m.stretch * 0.01 * PHYS;
        const k15 = lerpK(0.15, f);
        run.stretch[0] += (1 - s - run.stretch[0]) * k15;
        run.stretch[1] += (1 + s - run.stretch[1]) * k15;
        const rMin = deg(m.rMin);
        const rMax = deg(m.rMax);
        const sway = clamp(Math.sin(this.tick * m.rotFrq) * deg(m.rotDeg), rMin, rMax);
        const drag = clamp(run.length * deg(m.rdrag) * PHYS, rMin, rMax);
        run.rot = lerpAngle(run.rot, drag + sway, k15);
        run.spin += m.spin * f;
        modifier = trs(run.wob[0] + run.dragOff[0], run.wob[1] + run.dragOff[1], run.rot + run.spin, run.stretch[0], run.stretch[1]);
      } else {
        run.length = 0;
      }
      const flipH = l.kind === 'appendage' ? !!st.appendage?.flipH : st.flipH;
      const flipV = l.kind === 'appendage' ? !!st.appendage?.flipV : st.flipV;
      run.attach = mul(mul(root, modifier), trs(st.offset[0], st.offset[1], 0, flipH ? -1 : 1, flipV ? -1 : 1));
    }
  }

  /**
   * Model-space bounds of the rest pose (eyes open, mouth closed, no motion)
   * in `state` (default the current one): what a host fits to its box.
   */
  /**
   * How far (model units) the whole model can rise above its rest pose: the
   * highest container bounce (energy^2 / 2g) or float/wobble amplitude over
   * every state and mouth phase. The view keeps this much room so a bounce
   * never lifts the model out of its box.
   */
  motionHeadroom(): number {
    let most = 0;
    for (const st of this.spec.states) {
      for (const ph of [st.closed, st.open]) {
        const bounces = ph.anim === 'bouncy' || ph.onEnter === 1 || ph.onEnter === 3;
        if (bounces && ph.gravity > 0) most = Math.max(most, (ph.energy * ph.energy) / (2 * ph.gravity));
        if (ph.anim === 'wobble' || ph.anim === 'float' || ph.anim === 'squish') most = Math.max(most, Math.abs(ph.yAmp));
      }
      // A one-bounce on opening uses the open phase's energy under either gravity.
      if (st.closed.onEnter === 3 && st.closed.gravity > 0) most = Math.max(most, (st.open.energy * st.open.energy) / (2 * st.closed.gravity));
    }
    return Number.isFinite(most) ? Math.min(most, 1e5) : 0;
  }

  restBounds(state = this.state): Bounds | null {
    const saved = this.state;
    this.state = state;
    this.layout([1, 0, 0, 1, 0, 0], { dt: 0, mouthOpen: false, eyesClosed: false }, 0, false);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (p: [number, number]): void => {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    };
    this.spec.layers.forEach((l, i) => {
      const run = this.runs[i]!;
      const st = l.states[this.state]!;
      if (!run.visible || l.image < 0 || st.clip === 1) return;
      if (l.kind === 'appendage' && st.appendage) {
        const half = st.appendage.width / 2;
        for (const p of this.appendagePoints(st)) {
          add(apply(run.attach, p[0] - half, p[1] - half));
          add(apply(run.attach, p[0] + half, p[1] + half));
        }
        return;
      }
      const meta = this.spec.images[l.image]!;
      const w = meta.w / st.frames[0];
      const h = meta.h / st.frames[1];
      for (const [cx, cy] of [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [-w / 2, h / 2],
        [w / 2, h / 2],
      ] as const) {
        add(apply(run.attach, cx, cy));
      }
    });
    this.state = saved;
    // Reset motion state the rest layout touched.
    for (const r of this.runs) r.length = 0;
    if (!Number.isFinite(x0) || x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Appendage centre line in its own frame (Remix WigglyAppendage2D, at rest, wagging). */
  private appendagePoints(st: PngRemixLayerState): Array<[number, number]> {
    const a = st.appendage!;
    let curve = a.curve;
    if (a.wag) curve = clamp(Math.sin(this.tick * a.wag.freq) * a.wag.speed, deg(a.wag.min), deg(a.wag.max));
    const raw: Array<[number, number]> = [[0, 0]];
    let ang = deg(a.angle);
    for (let i = 1; i <= a.segments; i++) {
      ang += curve;
      const p = raw[i - 1]!;
      raw.push([p[0] + Math.cos(ang) * a.segLen, p[1] + Math.sin(ang) * a.segLen]);
    }
    // Smooth through the segment midpoints (quadratic Bezier, like Remix's subdivision).
    if (raw.length < 3) return raw;
    const out: Array<[number, number]> = [raw[0]!];
    const SUB = 6;
    for (let i = 0; i < raw.length - 2; i++) {
      const a0 = i === 0 ? raw[0]! : mid(raw[i]!, raw[i + 1]!);
      const b = raw[i + 1]!;
      const c = i === raw.length - 3 ? raw[i + 2]! : mid(raw[i + 1]!, raw[i + 2]!);
      for (let s = 1; s <= SUB; s++) {
        const t = s / SUB;
        const u = 1 - t;
        out.push([u * u * a0[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a0[1] + 2 * u * t * b[1] + t * t * c[1]]);
      }
    }
    return out;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  /** Draw the laid-out model; `base` maps model space to canvas pixels. */
  draw(ctx: CanvasRenderingContext2D, base: Mat): void {
    const roots: number[] = [];
    this.spec.layers.forEach((l, i) => {
      if (l.parent < 0) roots.push(i);
    });
    this.drawScope(ctx, base, this.collect(roots), 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Layers drawn in one scope: `starts` and their descendants, except that a
   * clipping layer stands for its whole subtree (drawn as a group). Sorted by
   * z, then tree order (Godot's canvas order).
   */
  private collect(starts: number[]): number[] {
    const out: number[] = [];
    const walk = (i: number): void => {
      if (!this.runs[i]!.visible) return;
      out.push(i);
      const st = this.spec.layers[i]!.states[this.state]!;
      if (st.clip !== 0) return;
      for (const c of this.children[i]!) walk(c);
    };
    for (const s of starts) walk(s);
    return out
      .map((i, order) => ({ i, order }))
      .sort((a, b) => this.runs[a.i]!.z - this.runs[b.i]!.z || a.order - b.order)
      .map((x) => x.i);
  }

  private drawScope(ctx: CanvasRenderingContext2D, base: Mat, list: number[], depth: number): void {
    for (const i of list) {
      const st = this.spec.layers[i]!.states[this.state]!;
      if (st.clip !== 0 && depth < 4) this.drawClipGroup(ctx, base, i, depth);
      else this.drawLayer(ctx, base, i);
    }
  }

  private drawClipGroup(ctx: CanvasRenderingContext2D, base: Mat, i: number, depth: number): void {
    const l = this.spec.layers[i]!;
    const st = l.states[this.state]!;
    if (st.clip === 2) this.drawLayer(ctx, base, i);
    if (l.image < 0 || this.children[i]!.length === 0) return;
    const img = this.images[l.image];
    if (!img) return;
    // Device-pixel box of the clipping image: the group can never reach past it.
    const m = mul(base, this.run(i).attach);
    const fw = img.width / st.frames[0];
    const fh = img.height / st.frames[1];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [cx, cy] of [
      [-fw / 2, -fh / 2],
      [fw / 2, -fh / 2],
      [-fw / 2, fh / 2],
      [fw / 2, fh / 2],
    ] as const) {
      const p = apply(m, cx, cy);
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const rx = Math.max(0, Math.floor(x0));
    const ry = Math.max(0, Math.floor(y0));
    const rw = Math.min(cw, Math.ceil(x1)) - rx;
    const rh = Math.min(ch, Math.ceil(y1)) - ry;
    if (rw <= 0 || rh <= 0) return;
    let off = this.offscreen[depth];
    if (!off) {
      off = this.makeCanvas();
      this.offscreen[depth] = off;
    }
    if (off.width < cw || off.height < ch) {
      off.width = Math.max(off.width, cw);
      off.height = Math.max(off.height, ch);
    }
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(rx, ry, rw, rh);
    octx.save();
    octx.beginPath();
    octx.rect(rx, ry, rw, rh);
    octx.clip();
    this.drawScope(octx, base, this.collect(this.children[i]!), depth + 1);
    // Keep only what lies on the clipping image's pixels.
    octx.globalCompositeOperation = 'destination-in';
    octx.globalAlpha = 1;
    this.blit(octx, m, img, st, 0, 0);
    octx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(off, rx, ry, rw, rh, rx, ry, rw, rh);
  }

  private run(i: number): LayerRun {
    return this.runs[i]!;
  }

  private drawLayer(ctx: CanvasRenderingContext2D, base: Mat, i: number): void {
    const l = this.spec.layers[i]!;
    const st = l.states[this.state]!;
    if (l.image < 0 || st.clip === 1) return;
    const src = this.images[l.image];
    if (!src) return;
    const run = this.run(i);
    const r = run.rgb[0] * st.tint[0];
    const g = run.rgb[1] * st.tint[1];
    const b = run.rgb[2] * st.tint[2];
    const alpha = run.alpha * st.tint[3];
    if (alpha <= 0.001) return;
    const img = r > 0.995 && g > 0.995 && b > 0.995 ? src : this.tinted(l.image, src, r, g, b);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'source-over';
    const m = mul(base, run.attach);
    if (l.kind === 'appendage' && st.appendage) this.drawAppendage(ctx, m, img, st);
    else this.blit(ctx, m, img, st, 0, 0);
  }

  /** Draw a (sheet frame of a) centred sprite under transform `m`. */
  private blit(ctx: CanvasRenderingContext2D, m: Mat, img: Drawable, st: PngRemixLayerState, _x: number, _y: number): void {
    const [hf, vf] = st.frames;
    const fw = img.width / hf;
    const fh = img.height / vf;
    const fx = (st.frame % hf) * fw;
    const fy = Math.floor(st.frame / hf) * fh;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(img, fx, fy, fw, fh, -fw / 2, -fh / 2, fw, fh);
  }

  private drawAppendage(ctx: CanvasRenderingContext2D, m: Mat, img: Drawable, st: PngRemixLayerState): void {
    const a = st.appendage!;
    const pts = this.appendagePoints(st);
    let total = 0;
    const lens: number[] = [];
    for (let j = 0; j < pts.length - 1; j++) {
      const d = Math.hypot(pts[j + 1]![0] - pts[j]![0], pts[j + 1]![1] - pts[j]![1]);
      lens.push(d);
      total += d;
    }
    if (total <= 0 || a.width <= 0) return;
    let s = 0;
    for (let j = 0; j < lens.length; j++) {
      const p = pts[j]!;
      const q = pts[j + 1]!;
      const len = lens[j]!;
      const sx = (s / total) * img.width;
      const sw = Math.max(0.5, (len / total) * img.width);
      s += len;
      if (len <= 0) continue;
      const seg = mul(m, trs(p[0], p[1], Math.atan2(q[1] - p[1], q[0] - p[0]), 1, 1));
      ctx.setTransform(seg[0], seg[1], seg[2], seg[3], seg[4], seg[5]);
      // A hair of overlap hides the seams between slices.
      ctx.drawImage(img, Math.min(sx, img.width - sw), 0, sw, img.height, 0, -a.width / 2, len + 0.75, a.width);
    }
  }

  private tinted(idx: number, src: Drawable, r: number, g: number, b: number): Drawable {
    const q = (v: number): number => Math.round(clamp(v, 0, 1) * 64);
    const key = `${idx}:${q(r)}:${q(g)}:${q(b)}`;
    const hit = this.tintCache.get(key);
    if (hit) return hit;
    const c = this.makeCanvas();
    c.width = src.width;
    c.height = src.height;
    const x = c.getContext('2d');
    if (!x) return src;
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = `rgb(${Math.round((q(r) / 64) * 255)}, ${Math.round((q(g) / 64) * 255)}, ${Math.round((q(b) / 64) * 255)})`;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(src, 0, 0);
    if (this.tintCache.size > 256) this.tintCache.clear();
    this.tintCache.set(key, c);
    return c;
  }

  dispose(): void {
    this.tintCache.clear();
    for (const c of this.offscreen) {
      c.width = 0;
      c.height = 0;
    }
    this.offscreen = [];
  }
}

function mid(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
