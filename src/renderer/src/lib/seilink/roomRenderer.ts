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
 *
 * Recolour (261104, editor pass): a state change that only moves tints
 * rebuilds just the tinted layers. Each cached side (back / front) keeps a
 * split around the layer being recoloured: everything below it and
 * everything above it, pre-composited once. A tint step then costs two
 * drawImage calls plus the one tinted layer, so dragging a colour stays
 * smooth. source-over is associative, so below + layer + above is the same
 * picture the full build draws.
 *
 * 261105 (room catalog): a pattern or accent change takes the same recolour
 * path (roomPattern.ts caches the warp, so only a new pattern or new
 * geometry runs it). Lights lit in a colour (glowTint) recolour their glow;
 * a cycling light's glow is drawn per frame in the colour of the moment.
 * Particles (rain, snow, fireflies, ...) draw on a fourth canvas, `fx`,
 * between back and her: stepped per frame while the loop runs, frozen when
 * it stops (covered, paused, hidden: fps 0 or the page hidden), and a single
 * settled still picture when the system asks for reduced motion.
 */
import {
  AVATAR_Z,
  type RoomBox,
  type RoomPresetManifest,
  type RoomState,
  type RoomTime,
} from '@shared/seilinkRoom';
import {
  cycleColour,
  glowAlpha,
  roomDrawPlan,
  roomOverlay,
  splitAtAvatar,
  type GlowLayer,
  type ItemLayer,
  type RoomDrawPlan,
  type SlotLayer,
  type ParticleLayer,
  type RoomOverlay,
  type RoomTimeMix,
} from '@shared/seilinkDraw';
import { createField, fitCounts, particleCount, particleDt, settle, showsStill, stepField, type ParticleField } from '@shared/seilinkParticles';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { drawRoomGlows, drawRoomLayers, loadPlanAssets, tintRegion, type RoomAssetError, type RoomAssets } from './roomCompose';
import { ctx2d, makeCanvas, type AnyCanvas } from './roomImages';
import { buildGlassMask, drawParticleLayers } from './roomParticles';

export interface RoomRendererCanvases {
  back: HTMLCanvasElement;
  front: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  /** 261105: particles, between back and the avatar. Absent: no particles drawn. */
  fx?: HTMLCanvasElement;
}

export interface RoomRendererEvents {
  /** First complete picture is on screen (once per setScene). */
  onReady?(): void;
  /** A pack file failed to load. That layer is skipped; the rest draws. */
  onError?(err: RoomAssetError): void;
  /** The overlay tint for UI drawn over the room changed. */
  onOverlay?(overlay: RoomOverlay): void;
  /** Which of the canvases have anything on them (hide the empty ones). */
  onLayersUsed?(used: { front: boolean; glow: boolean; fx?: boolean }): void;
}

interface TintSplit {
  /** Index into the side's layer list of the layer being recoloured. */
  index: number;
  below: AnyCanvas;
  above: AnyCanvas | null;
}

interface TimeCache {
  time: RoomTime;
  plan: RoomDrawPlan;
  /** Recolour splits per side (see the header). */
  splits: { back?: TintSplit; front?: TintSplit };
  back: AnyCanvas;
  front: AnyCanvas | null;
  /** Still glows, pre-composited. */
  glowStill: AnyCanvas | null;
  /** Glows that animate (an effect, or a cycling light), drawn per frame. */
  glowAnimated: GlowLayer[];
  /** 261105: this time's particles, and the glass mask over the view for the ones outside. */
  particles: ParticleLayer[];
  glass: { box: RoomBox; mask: AnyCanvas } | null;
  /** Average colour of the room at this time, for the overlay fallback. */
  sampled: string;
}

interface Scene {
  manifest: RoomPresetManifest;
  state: RoomState;
  resolve: RoomUrlResolver;
}

const MIX_STEPS = 128;

/** The state minus what never changes a cached picture (time) and minus colours (tints, patterns, cycle). */
function structureKey(state: RoomState): string {
  const slots: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state.slots)) slots[k] = v ? { id: v.id } : v;
  return JSON.stringify({ ...state, time: null, slots, items: state.items.map(({ tint: _t, pattern: _p, accent: _a, ...rest }) => rest) });
}

function tintKey(state: RoomState): string {
  return JSON.stringify([
    Object.entries(state.slots).map(([k, v]) => [k, v?.tint ?? null, v?.pattern ?? null, v?.accent ?? null, v?.cycle ?? null]),
    state.items.map((i) => [i.tint ?? null, i.pattern ?? null, i.accent ?? null]),
  ]);
}

/** Everything about a layer's colour: a change here recolours just that layer. */
function layerTint(l: SlotLayer | ItemLayer): string | null {
  if (!l.tint) return null;
  const p = l.pattern;
  return p ? `${l.tint}|${p.def.id}|${p.accent}|${p.period.join('x')}` : l.tint;
}

function glowKey(glows: readonly GlowLayer[]): string {
  return glows.map((g) => `${g.src}:${g.effect ?? ''}:${g.tint ?? ''}:${g.cycle ? 1 : 0}`).join(',');
}

const isAnimatedGlow = (g: GlowLayer): boolean => Boolean(g.effect || g.cycle);

function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h | 0;
}

function reducedMotionQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    return null;
  }
}
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
  private sceneTints = '';
  private retinting = false;
  private retintAgain = false;
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
  private used = { front: false, glow: false, fx: false };
  private disposed = false;
  private reported = new Set<string>();
  /** Live particle fields by ParticleLayer.key (kept across a time crossfade). */
  private fields = new Map<string, { field: ParticleField; sig: string }>();
  private lastFx: number | null = null;
  private reduced: MediaQueryList | null = reducedMotionQuery();
  /** Perf harness: particle frames drawn and the time they took. */
  readonly fxStats = { frames: 0, ms: 0, particles: 0 };

  constructor(
    private readonly canvases: RoomRendererCanvases,
    private readonly events: RoomRendererEvents = {},
    opts: { fps?: number; fadeMs?: number } = {},
  ) {
    this.fps = opts.fps ?? 30;
    this.fadeMs = opts.fadeMs ?? 1200;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.reduced?.addEventListener?.('change', this.onReducedMotion);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reduced?.removeEventListener?.('change', this.onReducedMotion);
    this.caches.clear();
    this.building.clear();
    this.fields.clear();
  }

  /** The system asks for reduced motion: particles show one still picture (rain left out), no loop. */
  get reducedMotion(): boolean {
    return Boolean(this.reduced?.matches);
  }

  /** New manifest / state / pack. Caches rebuild; the old picture stays until the new one is ready. */
  setScene(manifest: RoomPresetManifest, state: RoomState, resolve: RoomUrlResolver): void {
    // state.time only picks which caches show (setMix); it never changes what a
    // time's picture looks like, so a time change keeps every cache.
    const key = structureKey(state);
    const tints = tintKey(state);
    const prev = this.scene;
    this.scene = { manifest, state, resolve };
    if (prev && prev.manifest === manifest && prev.resolve === resolve && key === this.sceneKey) {
      if (tints === this.sceneTints) return;
      this.sceneTints = tints;
      // Only colours moved: recolour the cached layers in place. While a cache
      // is still building it would come out with the old colours, so rebuild.
      if (this.caches.size > 0 && this.building.size === 0) {
        void this.retint();
        return;
      }
    }
    this.sceneKey = key;
    this.sceneTints = tints;
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
    // Back from hidden: the step after the gap is capped (particleDt), nothing jumps.
    this.kick();
  };

  private onReducedMotion = (): void => {
    this.fields.clear();
    this.syncFields();
    this.drawFx(performance.now());
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
    this.syncFields();
    this.drawFx(performance.now());
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

    const { still: glowStill, animated } = this.buildGlows(plan, w, h, res, manifest.canvas);

    // Particles outside are seen only through the glass: the view box minus
    // what the back layers above the view draw over it.
    let glass: TimeCache['glass'] = null;
    const outside = plan.particles.find((p) => p.where === 'outside');
    if (outside && this.canvases.fx) {
      const owner = outside.owner;
      const at = back.indexOf(owner);
      const box: RoomBox = owner.kind === 'slot' && owner.box ? owner.box : outside.area;
      const shell = back.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === 'shell');
      const glassImg = shell?.frame.glass ? this.assets.masks.get(shell.frame.glass) : undefined;
      const above = at >= 0 ? back.slice(at + 1) : [];
      glass = {
        box,
        mask: buildGlassMask(box, res, (ctx) => drawRoomLayers(ctx, above, manifest.canvas, this.assets, res), glassImg && shell ? { image: glassImg, rect: shell.box ?? [0, 0, cw, ch] } : null),
      };
    }

    return {
      time,
      plan,
      splits: {},
      back: backC,
      front: frontC,
      glowStill,
      glowAnimated: animated,
      particles: plan.particles,
      glass,
      sampled: sampleColour(backC, frontC),
    };
  }

  /** Still glows pre-composited, and the ones drawn per frame. */
  private buildGlows(plan: RoomDrawPlan, w: number, h: number, res: number, canvas: readonly [number, number]): { still: AnyCanvas | null; animated: GlowLayer[] } {
    const still = plan.glows.filter((g) => !isAnimatedGlow(g));
    const animated = plan.glows.filter(isAnimatedGlow);
    let glowStill: AnyCanvas | null = null;
    if (still.length > 0) {
      glowStill = makeCanvas(w, h);
      const gctx = ctx2d(glowStill);
      gctx.setTransform(res, 0, 0, res, 0, 0);
      drawRoomGlows(gctx, still, canvas, this.assets, () => 1);
    }
    return { still: glowStill, animated };
  }

  // ── recolour fast path ────────────────────────────────────────────────────

  private async retint(): Promise<void> {
    if (this.retinting) {
      this.retintAgain = true;
      return;
    }
    this.retinting = true;
    try {
      do {
        this.retintAgain = false;
        const scene = this.scene;
        if (!scene) return;
        const seq = this.sceneSeq;
        const caches = [...this.caches.values()];
        const plans = caches.map((c) => roomDrawPlan(scene.manifest, scene.state, c.time));
        // Masks are usually loaded already (the part was tinted by its default).
        await Promise.all(plans.map((p) => loadPlanAssets(p, scene.resolve, this.assets)));
        if (this.disposed || seq !== this.sceneSeq) return;
        if (this.scene !== scene) {
          this.retintAgain = true;
          continue;
        }
        caches.forEach((c, i) => {
          if (this.caches.get(c.time) === c) this.retintCache(c, plans[i], scene.manifest);
        });
        this.composeStatic(true);
        this.drawGlow(performance.now());
        // A light switched to (or off) cycling starts (or may stop) the loop.
        this.kick();
      } while (this.retintAgain);
    } finally {
      this.retinting = false;
    }
  }

  private retintCache(c: TimeCache, plan: RoomDrawPlan, manifest: RoomPresetManifest): void {
    const canvas = manifest.canvas;
    // A light's colour (glowTint) or cycle moved: its glows again (they are small).
    if (glowKey(plan.glows) !== glowKey(c.plan.glows)) {
      const { still, animated } = this.buildGlows(plan, c.back.width, c.back.height, this.res, canvas);
      c.glowStill = still;
      c.glowAnimated = animated;
    }
    const next = splitAtAvatar(plan);
    const prev = splitAtAvatar(c.plan);
    for (const side of ['back', 'front'] as const) {
      const target = side === 'back' ? c.back : c.front;
      const layers = next[side];
      const old = prev[side];
      if (!target || layers.length !== old.length) continue;
      const changed: number[] = [];
      for (let i = 0; i < layers.length; i++) if (layerTint(layers[i]) !== layerTint(old[i])) changed.push(i);
      if (changed.length === 0) continue;
      const ctx = ctx2d(target);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      if (changed.length > 1) {
        c.splits[side] = undefined;
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.setTransform(this.res, 0, 0, this.res, 0, 0);
        drawRoomLayers(ctx, layers, canvas, this.assets, this.res);
        continue;
      }
      const index = changed[0];
      let split = c.splits[side];
      if (!split || split.index !== index) {
        split = this.makeSplit(layers, index, target.width, target.height, canvas);
        c.splits[side] = split;
      }
      // Only the mask's bounds change colour: redraw just that rectangle
      // (device px, rounded out). A flipped item draws whole (no clip there).
      const layer = layers[index];
      const region = layer.kind === 'item' && layer.flip ? null : tintRegion(layer, canvas, this.assets);
      let [dx, dy, dw, dh] = [0, 0, target.width, target.height];
      if (region) {
        const x0 = Math.max(0, Math.floor(region[0] * this.res) - 1);
        const y0 = Math.max(0, Math.floor(region[1] * this.res) - 1);
        const x1 = Math.min(target.width, Math.ceil((region[0] + region[2]) * this.res) + 1);
        const y1 = Math.min(target.height, Math.ceil((region[1] + region[3]) * this.res) + 1);
        if (x1 <= x0 || y1 <= y0) continue;
        [dx, dy, dw, dh] = [x0, y0, x1 - x0, y1 - y0];
      }
      const clip: RoomBox | undefined = region ? [dx / this.res, dy / this.res, dw / this.res, dh / this.res] : undefined;
      ctx.clearRect(dx, dy, dw, dh);
      ctx.drawImage(split.below, dx, dy, dw, dh, dx, dy, dw, dh);
      ctx.setTransform(this.res, 0, 0, this.res, 0, 0);
      drawRoomLayers(ctx, [layer], canvas, this.assets, this.res, clip);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (split.above) ctx.drawImage(split.above, dx, dy, dw, dh, dx, dy, dw, dh);
    }
    c.plan = plan;
    // The sample only matters when the pack names no overlay for this time.
    if (!manifest.overlay?.[c.time]) c.sampled = sampleColour(c.back, c.front);
  }

  private makeSplit(layers: ReadonlyArray<SlotLayer | ItemLayer>, index: number, w: number, h: number, canvas: readonly [number, number]): TintSplit {
    const below = makeCanvas(w, h);
    const bctx = ctx2d(below);
    bctx.setTransform(this.res, 0, 0, this.res, 0, 0);
    drawRoomLayers(bctx, layers.slice(0, index), canvas, this.assets, this.res);
    let above: AnyCanvas | null = null;
    if (index < layers.length - 1) {
      above = makeCanvas(w, h);
      const actx = ctx2d(above);
      actx.setTransform(this.res, 0, 0, this.res, 0, 0);
      drawRoomLayers(actx, layers.slice(index + 1), canvas, this.assets, this.res);
    }
    return { index, below, above };
  }

  private sizeCanvases(): void {
    const scene = this.scene;
    if (!scene) return;
    const w = Math.round(scene.manifest.canvas[0] * this.res);
    const h = Math.round(scene.manifest.canvas[1] * this.res);
    for (const c of [this.canvases.back, this.canvases.front, this.canvases.glow, this.canvases.fx]) {
      if (!c) continue;
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
      fx: Boolean(this.canvases.fx && (from.particles.length || to.particles.length)),
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
        drawRoomGlows(
          ctx,
          c.glowAnimated,
          scene.manifest.canvas,
          this.assets,
          (g) => w * (animate && g.effect ? glowAlpha(g.effect, now, seedOf(g, g.z)) : 1),
          (g) => (g.cycle ? cycleColour(animate ? now : 0, (seedOf(g, g.z) / 6.283) * 0.15) : (g.tint ?? null)),
        );
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  private hasAnimation(): boolean {
    if (this.fade) return true;
    for (const c of this.caches.values()) if (c.glowAnimated.length) return true;
    if (this.canvases.fx && !this.reducedMotion) for (const c of this.caches.values()) if (c.particles.length) return true;
    return false;
  }

  // ── particles ─────────────────────────────────────────────────────────────

  /** The particle layers of the caches on screen, with their crossfade weights. */
  private particleParts(): Array<[TimeCache, number]> {
    const mix = this.currentMix();
    if (!mix) return [];
    const a = this.caches.get(mix.from);
    const b = this.caches.get(mix.to);
    if (!a && !b) return [];
    const from = a ?? b!;
    const to = b ?? a!;
    if (from === to) return [[to, 1]];
    const t = Math.max(0, Math.min(1, mix.t));
    return [[from, 1 - t], [to, t]];
  }

  /** Make (or keep) a field per particle layer on screen, under the scene cap. */
  private syncFields(): void {
    if (!this.canvases.fx) return;
    const layers = new Map<string, ParticleLayer>();
    for (const [c] of this.particleParts()) for (const l of c.particles) if (!layers.has(l.key)) layers.set(l.key, l);
    const list = [...layers.values()];
    const counts = fitCounts(list.map((l) => particleCount(l.spec, l.area)));
    const live = new Set<string>();
    list.forEach((l, i) => {
      live.add(l.key);
      const sig = `${l.area.join(',')}:${counts[i]}:${JSON.stringify(l.spec)}`;
      const hit = this.fields.get(l.key);
      if (hit && hit.sig === sig) return;
      const field = createField(l.spec, l.area, hashKey(l.key), counts[i]);
      // Reduced motion: one settled picture, so embers and drops are mid-life rather than all at birth.
      if (this.reducedMotion) settle(field);
      this.fields.set(l.key, { field, sig });
    });
    for (const k of [...this.fields.keys()]) if (!live.has(k)) this.fields.delete(k);
  }

  private drawFx(now: number): void {
    const fx = this.canvases.fx;
    if (!fx) return;
    const t0 = performance.now();
    const parts = this.particleParts();
    const still = this.reducedMotion;
    const dt = still || this.fps <= 0 ? 0 : particleDt(this.lastFx, now);
    this.lastFx = now;
    if (dt > 0) for (const { field } of this.fields.values()) stepField(field, dt);
    const ctx = ctx2d(fx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, fx.width, fx.height);
    let n = 0;
    for (const [c, w] of parts) {
      if (w <= 0 || !c.particles.length) continue;
      drawParticleLayers(ctx, c.particles, this.res, w, (l) => this.fields.get(l.key)?.field ?? null, c.glass, still, showsStill);
      for (const l of c.particles) n += this.fields.get(l.key)?.field.particles.length ?? 0;
    }
    if (n) {
      this.fxStats.frames++;
      this.fxStats.ms += performance.now() - t0;
      this.fxStats.particles = n;
    }
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
        this.drawFx(now);
      }
      if (this.hasAnimation()) this.raf = requestAnimationFrame(step);
      // The loop stops (covered, paused, hidden): the next start steps from scratch, capped.
      else this.lastFx = null;
    };
    this.lastFx = null;
    this.raf = requestAnimationFrame(step);
  }

  private setUsed(used: { front: boolean; glow: boolean; fx: boolean }): void {
    if (used.front === this.used.front && used.glow === this.used.glow && used.fx === this.used.fx) return;
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

/** Average colour of a cached picture (what the overlay falls back to when the manifest names none). */
function sampleColour(back: AnyCanvas, front: AnyCanvas | null): string {
  const one = makeCanvas(1, 1);
  const octx = ctx2d(one, { willReadFrequently: true });
  octx.drawImage(back, 0, 0, 1, 1);
  if (front) octx.drawImage(front, 0, 0, 1, 1);
  const [r, g, b] = octx.getImageData(0, 0, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Re-exported so callers need one import for the avatar z. */
export { AVATAR_Z };
