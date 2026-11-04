/**
 * SeiLink room renderer (261104). The imperative core behind RoomCanvas; the
 * desktop host and the editor can drive it directly.
 *
 * It owns three on-screen canvases stacked around the avatar:
 *   back  = slots + items behind her (z < AVATAR_Z, ties per the plan),
 *   front = slots + items in front of her,
 *   glow  = every glow, CSS mix-blend-mode: screen over all of it.
 *
 * Static work is cached: for each time of day in the current mix, back,
 * front and the still glows are composited ONCE into offscreen bitmaps at
 * the display resolution. A frame then costs at most two drawImage calls per
 * layer (and only during a crossfade); with no fade running, back and front
 * are not touched at all. Only animated glows ('flicker', 'pulse') redraw on
 * the animation loop, capped at `fps` (0 = a still picture, no loop), and the
 * loop does not run while the page is hidden.
 *
 * Time of day: setMix() takes the target mix (seilinkDraw roomTimeMix). A
 * clock fade (from != to) is applied as given. A jump to another time (the
 * user picks night, or the clock skipped past a fade) is animated over
 * `fadeMs` instead of cutting.
 */
import {
  AVATAR_Z,
  type RoomPresetManifest,
  type RoomState,
  type RoomTime,
} from '@shared/seilinkRoom';
import {
  glowAlpha,
  roomDrawPlan,
  roomOverlay,
  splitAtAvatar,
  type GlowLayer,
  type RoomDrawPlan,
  type RoomOverlay,
  type RoomTimeMix,
} from '@shared/seilinkDraw';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { drawRoomGlows, drawRoomLayers, loadPlanAssets, type RoomAssetError, type RoomAssets } from './roomCompose';
import { ctx2d, makeCanvas, type AnyCanvas } from './roomImages';

export interface RoomRendererCanvases {
  back: HTMLCanvasElement;
  front: HTMLCanvasElement;
  glow: HTMLCanvasElement;
}

export interface RoomRendererEvents {
  /** First complete picture is on screen (once per setScene). */
  onReady?(): void;
  /** A pack file failed to load. That layer is skipped; the rest draws. */
  onError?(err: RoomAssetError): void;
  /** The overlay tint for UI drawn over the room changed. */
  onOverlay?(overlay: RoomOverlay): void;
  /** Which of the three canvases have anything on them (hide the empty ones). */
  onLayersUsed?(used: { front: boolean; glow: boolean }): void;
}

interface TimeCache {
  time: RoomTime;
  plan: RoomDrawPlan;
  back: AnyCanvas;
  front: AnyCanvas | null;
  /** Still glows, pre-composited. */
  glowStill: AnyCanvas | null;
  /** Glows that animate, drawn per frame. */
  glowAnimated: GlowLayer[];
  /** Average colour of the room at this time, for the overlay fallback. */
  sampled: string;
}

interface Scene {
  manifest: RoomPresetManifest;
  state: RoomState;
  resolve: RoomUrlResolver;
}

const MIX_STEPS = 128;
const SEEDS = new WeakMap<GlowLayer, number>();

function seedOf(g: GlowLayer, i: number): number {
  let s = SEEDS.get(g);
  if (s === undefined) {
    s = (i * 2.399) % 6.283;
    SEEDS.set(g, s);
  }
  return s;
}

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export class RoomRenderer {
  private scene: Scene | null = null;
  private sceneSeq = 0;
  private sceneKey = '';
  private assets: RoomAssets = { images: new Map(), masks: new Map(), glows: new Map() };
  private caches = new Map<RoomTime, TimeCache>();
  private building = new Map<RoomTime, Promise<TimeCache | null>>();
  /** Device px per canvas px. */
  private res = 0;
  private target: RoomTimeMix | null = null;
  private shown: RoomTimeMix | null = null;
  /** An animated jump. `start` is set once both times are cached, so loading never eats the fade. */
  private fade: { from: RoomTime; to: RoomTime; start: number | null } | null = null;
  private fps: number;
  private fadeMs: number;
  private raf = 0;
  private lastFrame = 0;
  private readySent = false;
  private lastOverlay = '';
  private used = { front: false, glow: false };
  private disposed = false;
  private reported = new Set<string>();

  constructor(
    private readonly canvases: RoomRendererCanvases,
    private readonly events: RoomRendererEvents = {},
    opts: { fps?: number; fadeMs?: number } = {},
  ) {
    this.fps = opts.fps ?? 30;
    this.fadeMs = opts.fadeMs ?? 1200;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.caches.clear();
    this.building.clear();
  }

  /** New manifest / state / pack. Caches rebuild; the old picture stays until the new one is ready. */
  setScene(manifest: RoomPresetManifest, state: RoomState, resolve: RoomUrlResolver): void {
    // state.time only picks which caches show (setMix); it never changes what a
    // time's picture looks like, so a time change keeps every cache.
    const key = JSON.stringify({ ...state, time: null });
    const prev = this.scene;
    this.scene = { manifest, state, resolve };
    if (prev && prev.manifest === manifest && prev.resolve === resolve && key === this.sceneKey) return;
    this.sceneKey = key;
    this.sceneSeq++;
    this.readySent = false;
    this.invalidate();
  }

  /** Device px per canvas px (RoomCanvas: min(1, viewport.scale x devicePixelRatio)). */
  setResolution(res: number): void {
    const r = Math.max(0.05, Math.min(1, res));
    if (Math.abs(r - this.res) < 0.01) return;
    this.res = r;
    this.invalidate();
  }

  /** Current device px per canvas px (0 until RoomCanvas measures). */
  get resolution(): number {
    return this.res;
  }

  setFps(fps: number): void {
    this.fps = Math.max(0, fps);
    this.kick();
  }

  setFadeMs(ms: number): void {
    this.fadeMs = Math.max(0, ms);
  }

  setMix(mix: RoomTimeMix): void {
    const prev = this.target;
    const shown = this.currentMix();
    this.target = mix;
    const changed = !prev || prev.from !== mix.from || prev.to !== mix.to;
    if (shown && prev && changed && mix.from === mix.to && this.fadeMs > 0 && this.fps > 0) {
      const dominant = shown.t >= 0.5 ? shown.to : shown.from;
      if (dominant !== mix.to) {
        this.fade = { from: dominant, to: mix.to, start: null };
      }
    }
    void this.refresh();
  }

  /** The mix on screen right now (an animated jump included). */
  currentMix(): RoomTimeMix | null {
    if (this.fade) {
      const t = this.fade.start === null ? 0 : Math.min(1, (performance.now() - this.fade.start) / this.fadeMs);
      return { from: this.fade.from, to: this.fade.to, t: ease(t) };
    }
    return this.target;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private onVisibility = (): void => {
    this.kick();
  };

  private invalidate(): void {
    this.caches.clear();
    this.building.clear();
    void this.refresh();
  }

  private needed(mix: RoomTimeMix): RoomTime[] {
    if (this.fade) return [this.fade.from, this.fade.to];
    return mix.from === mix.to || mix.t >= 1 ? [mix.to] : mix.t <= 0 ? [mix.from] : [mix.from, mix.to];
  }

  private async refresh(): Promise<void> {
    const mix = this.currentMix();
    if (!this.scene || !mix || this.res <= 0) return;
    const seq = this.sceneSeq;
    const times = this.needed(mix);
    const built = await Promise.all(times.map((t) => this.cacheFor(t)));
    if (this.disposed || seq !== this.sceneSeq || built.some((c) => !c)) return;
    // Drop caches no mix needs now (memory: a full-screen layer is ~15 MB).
    const keep = new Set<RoomTime>(this.needed(this.currentMix() ?? mix));
    if (this.fade && this.fade.start === null) this.fade.start = performance.now();
    for (const t of [...this.caches.keys()]) if (!keep.has(t)) this.caches.delete(t);
    this.composeStatic(true);
    this.drawGlow(performance.now());
    if (!this.readySent) {
      this.readySent = true;
      this.events.onReady?.();
    }
    this.kick();
  }

  private cacheFor(time: RoomTime): Promise<TimeCache | null> {
    const hit = this.caches.get(time);
    if (hit) return Promise.resolve(hit);
    const pending = this.building.get(time);
    if (pending) return pending;
    const seq = this.sceneSeq;
    const res = this.res;
    const job = this.build(time, res).then((c) => {
      if (this.building.get(time) === job) this.building.delete(time);
      if (!c || seq !== this.sceneSeq || res !== this.res || this.disposed) return null;
      this.caches.set(time, c);
      return c;
    });
    this.building.set(time, job);
    return job;
  }

  private async build(time: RoomTime, res: number): Promise<TimeCache | null> {
    const scene = this.scene;
    if (!scene) return null;
    const { manifest, state, resolve } = scene;
    const plan = roomDrawPlan(manifest, state, time);
    const { errors } = await loadPlanAssets(plan, resolve, this.assets);
    for (const e of errors) {
      const key = `${this.sceneSeq}:${e.file}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.events.onError?.(e);
    }
    const [cw, ch] = manifest.canvas;
    const w = Math.round(cw * res);
    const h = Math.round(ch * res);
    const { back, front } = splitAtAvatar(plan);

    const backC = makeCanvas(w, h);
    const bctx = ctx2d(backC);
    bctx.setTransform(res, 0, 0, res, 0, 0);
    drawRoomLayers(bctx, back, manifest.canvas, this.assets, res);

    let frontC: AnyCanvas | null = null;
    if (front.length > 0) {
      frontC = makeCanvas(w, h);
      const fctx = ctx2d(frontC);
      fctx.setTransform(res, 0, 0, res, 0, 0);
      drawRoomLayers(fctx, front, manifest.canvas, this.assets, res);
    }

    const still = plan.glows.filter((g) => !g.effect);
    const animated = plan.glows.filter((g) => g.effect);
    let glowStill: AnyCanvas | null = null;
    if (still.length > 0) {
      glowStill = makeCanvas(w, h);
      const gctx = ctx2d(glowStill);
      gctx.setTransform(res, 0, 0, res, 0, 0);
      drawRoomGlows(gctx, still, manifest.canvas, this.assets, () => 1);
    }

    // Average colour (what the overlay falls back to when the manifest names none).
    const one = makeCanvas(1, 1);
    const octx = ctx2d(one, { willReadFrequently: true });
    octx.drawImage(backC, 0, 0, 1, 1);
    if (frontC) octx.drawImage(frontC, 0, 0, 1, 1);
    const [r, g, b] = octx.getImageData(0, 0, 1, 1).data;
    const sampled = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

    return { time, plan, back: backC, front: frontC, glowStill, glowAnimated: animated, sampled };
  }

  private sizeCanvases(): void {
    const scene = this.scene;
    if (!scene) return;
    const w = Math.round(scene.manifest.canvas[0] * this.res);
    const h = Math.round(scene.manifest.canvas[1] * this.res);
    for (const c of [this.canvases.back, this.canvases.front, this.canvases.glow]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
  }

  private lastStatic = '';

  /** Recompose back + front from the caches when the mix moved enough to show. */
  private composeStatic(force = false): void {
    const mix = this.currentMix();
    if (!mix) return;
    const a = this.caches.get(mix.from);
    const b = this.caches.get(mix.to);
    if (!b && !a) return;
    const t = Math.round(Math.max(0, Math.min(1, mix.t)) * MIX_STEPS) / MIX_STEPS;
    const key = `${this.sceneSeq}:${this.res}:${mix.from}:${mix.to}:${t}`;
    if (!force && key === this.lastStatic) return;
    this.lastStatic = key;
    this.sizeCanvases();
    const from = a ?? b!;
    const to = b ?? a!;
    const bctx = ctx2d(this.canvases.back);
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalAlpha = 1;
    bctx.clearRect(0, 0, bctx.canvas.width, bctx.canvas.height);
    // Back is opaque: lay `from` down whole, then `to` at t.
    if (t < 1 || from === to) bctx.drawImage(from.back, 0, 0);
    if (from !== to && t > 0) {
      bctx.globalAlpha = t;
      bctx.drawImage(to.back, 0, 0);
      bctx.globalAlpha = 1;
    }
    const fctx = ctx2d(this.canvases.front);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, fctx.canvas.width, fctx.canvas.height);
    if (from.front && (from === to || t < 1)) {
      fctx.globalAlpha = from === to ? 1 : 1 - t;
      fctx.drawImage(from.front, 0, 0);
    }
    if (from !== to && to.front && t > 0) {
      fctx.globalAlpha = t;
      fctx.drawImage(to.front, 0, 0);
    }
    fctx.globalAlpha = 1;
    this.setUsed({
      front: Boolean(from.front || to.front),
      glow: Boolean(from.glowStill || to.glowStill || from.glowAnimated.length || to.glowAnimated.length),
    });
    this.emitOverlay(mix);
  }

  private drawGlow(now: number): void {
    const mix = this.currentMix();
    const scene = this.scene;
    if (!mix || !scene) return;
    const a = this.caches.get(mix.from);
    const b = this.caches.get(mix.to);
    if (!a && !b) return;
    const from = a ?? b!;
    const to = b ?? a!;
    const t = from === to ? 1 : Math.max(0, Math.min(1, mix.t));
    const ctx = ctx2d(this.canvases.glow);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const animate = this.fps > 0;
    const parts: Array<[TimeCache, number]> = from === to ? [[to, 1]] : [[from, 1 - t], [to, t]];
    for (const [c, w] of parts) {
      if (w <= 0) continue;
      if (c.glowStill) {
        ctx.globalAlpha = w;
        ctx.drawImage(c.glowStill, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (c.glowAnimated.length) {
        ctx.setTransform(this.res, 0, 0, this.res, 0, 0);
        drawRoomGlows(ctx, c.glowAnimated, scene.manifest.canvas, this.assets, (g) => w * (animate ? glowAlpha(g.effect, now, seedOf(g, g.z)) : 1));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  private hasAnimation(): boolean {
    if (this.fade) return true;
    for (const c of this.caches.values()) if (c.glowAnimated.length) return true;
    return false;
  }

  /** Start the loop if anything moves; it stops itself when nothing does. */
  private kick(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.disposed || document.visibilityState === 'hidden') return;
    if (this.fps <= 0) {
      // Still picture: land any running fade, draw once.
      if (this.fade) {
        this.fade = null;
        void this.refresh();
      }
      return;
    }
    if (!this.hasAnimation()) return;
    const step = (now: number): void => {
      this.raf = 0;
      if (this.disposed || document.visibilityState === 'hidden') return;
      if (now - this.lastFrame >= 1000 / this.fps - 2) {
        this.lastFrame = now;
        if (this.fade && this.fade.start !== null && now - this.fade.start >= this.fadeMs) {
          this.fade = null;
          void this.refresh();
        }
        this.composeStatic();
        this.drawGlow(now);
      }
      if (this.hasAnimation()) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private setUsed(used: { front: boolean; glow: boolean }): void {
    if (used.front === this.used.front && used.glow === this.used.glow) return;
    this.used = used;
    this.events.onLayersUsed?.(used);
  }

  private emitOverlay(mix: RoomTimeMix): void {
    const scene = this.scene;
    if (!scene || !this.events.onOverlay) return;
    const sampled: Partial<Record<RoomTime, string>> = {};
    for (const c of this.caches.values()) sampled[c.time] = c.sampled;
    const o = roomOverlay(scene.manifest, mix, sampled);
    const key = `${o.color}:${o.light}`;
    if (key === this.lastOverlay) return;
    this.lastOverlay = key;
    this.events.onOverlay(o);
  }
}

/** Re-exported so callers need one import for the avatar z. */
export { AVATAR_Z };
