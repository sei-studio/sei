/**
 * SeiLink weather and ambience particles (261105, room catalog; Shawn msg
 * 1627). Pure simulation: no DOM, so the tests can drive it and the renderer
 * only draws what it says.
 *
 * A pack attaches particles to a frame (seilinkRoom.ts RoomFrame.particles),
 * so they come and go with the time of day and with the part: rain on a
 * view's dusk frame, fireflies on the forest's night lights, embers on the
 * campfire. Kinds:
 *  - rain: thin slanted streaks, three depths (far ones slower, fainter);
 *    `glass: true` adds drops sliding down the window glass.
 *  - snow: soft flakes drifting and swaying.
 *  - petals: pink petals tumbling down on the wind.
 *  - fireflies: slow wandering glows that blink.
 *  - embers: sparks rising from the bottom of their area, fading out.
 *  - dust: faint motes hanging in the light.
 *
 * Cost: the whole scene keeps at most MAX_PARTICLES; a frame steps each once
 * (a few multiplies) and the renderer draws them in a handful of batched
 * paths and sprite blits. Fields are seeded, so a picture is reproducible
 * (screenshots, tests), and they only step while the room is animating: the
 * renderer stops its loop when the wallpaper is covered, paused or hidden,
 * and particleDt caps the step after a pause so nothing jumps.
 */
import type { RoomBox } from './seilinkRoom';

export type RoomParticleKind = 'rain' | 'snow' | 'petals' | 'fireflies' | 'embers' | 'dust';
export const PARTICLE_KINDS: readonly RoomParticleKind[] = ['rain', 'snow', 'petals', 'fireflies', 'embers', 'dust'];

export interface RoomParticles {
  kind: RoomParticleKind;
  /** Multiplier of the kind's usual count, 0.1..3 (default 1). */
  density?: number;
  /** Where they live, canvas px. Default: the part's box (a view's window), else the whole canvas. */
  area?: RoomBox;
  /**
   * 'outside' = behind the room's glass, only seen through the window (the
   * default on a view); 'scene' = over the whole scene in `area` (outdoors,
   * fireflies, embers; the default elsewhere).
   */
  where?: 'outside' | 'scene';
  /** Rain: also drops running down the window glass. */
  glass?: boolean;
  /** Hex colour over the kind's own. */
  colour?: string;
  /** Sideways wind, -1..1 (default a little to the right for rain and petals). */
  wind?: number;
}

/** Whole-scene cap; fields are thinned to fit. */
export const MAX_PARTICLES = 160;
/** The longest step a frame takes, ms: after a pause or a slow frame the field moves on, it does not jump. */
export const MAX_STEP_MS = 50;

interface KindDef {
  /** Particles at density 1 over a 1000 x 1000 canvas-px area (scaled by area, clamped). */
  per1M: number;
  min: number;
  max: number;
  colour: string;
}

export const KIND_DEFS: Readonly<Record<RoomParticleKind, KindDef>> = {
  rain: { per1M: 60, min: 30, max: 110, colour: '#c8d6e8' },
  snow: { per1M: 40, min: 20, max: 80, colour: '#ffffff' },
  petals: { per1M: 14, min: 8, max: 30, colour: '#f6b6c8' },
  fireflies: { per1M: 9, min: 8, max: 26, colour: '#e4f57a' },
  embers: { per1M: 40, min: 10, max: 22, colour: '#ffad4a' },
  dust: { per1M: 12, min: 10, max: 30, colour: '#fff3d6' },
};

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** canvas px */
  size: number;
  /** 0.35..1: far particles are smaller, slower, fainter. */
  depth: number;
  /** radians, for sway, blink, tumble */
  phase: number;
  /** ms since (re)spawn */
  age: number;
  /** ms the particle lives (embers, glass drops), Infinity otherwise */
  life: number;
  /** Glass drops: ms left sitting still before it slides. */
  hold: number;
}

export interface ParticleField {
  kind: RoomParticleKind;
  area: RoomBox;
  colour: string;
  wind: number;
  particles: Particle[];
  /** Rain on the glass (drops), when the spec asks. */
  drops: Particle[];
  /** ms simulated so far */
  t: number;
  seed: number;
}

/** Small seeded PRNG (mulberry32), state kept on the field so steps are reproducible. */
function rng(field: { seed: number }): number {
  field.seed = (field.seed + 0x6d2b79f5) | 0;
  let t = field.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The count a spec asks for over its area, before the scene cap. */
export function particleCount(spec: Pick<RoomParticles, 'kind' | 'density'>, area: RoomBox): number {
  const d = KIND_DEFS[spec.kind];
  const density = Math.max(0.1, Math.min(3, spec.density ?? 1));
  const base = Math.max(d.min, Math.min(d.max, (d.per1M * area[2] * area[3]) / 1e6));
  return Math.max(1, Math.round(base * density));
}

function defaultWind(kind: RoomParticleKind): number {
  return kind === 'rain' ? 0.18 : kind === 'petals' ? 0.45 : kind === 'snow' ? 0.1 : 0;
}

/** Place (or re-place) one particle. `fresh` = first fill: anywhere in the area; later: at the edge it enters from. */
function spawn(field: ParticleField, p: Particle, fresh: boolean): void {
  const r = (): number => rng(field);
  const [ax, ay, aw, ah] = field.area;
  const scale = Math.max(0.5, Math.min(2, ah / 1000));
  p.depth = 0.35 + r() * 0.65;
  p.phase = r() * Math.PI * 2;
  p.age = 0;
  p.life = Infinity;
  p.hold = 0;
  p.x = ax + r() * aw;
  switch (field.kind) {
    case 'rain':
      p.vy = (1.1 + r() * 0.6) * p.depth * scale;
      p.vx = p.vy * field.wind;
      p.size = (1.2 + r() * 1.2) * p.depth;
      p.y = fresh ? ay + r() * ah : ay - r() * ah * 0.2;
      break;
    case 'snow':
      p.vy = (0.035 + r() * 0.05) * p.depth * scale;
      p.vx = 0.02 * field.wind * scale;
      p.size = (2.5 + r() * 4) * p.depth;
      p.y = fresh ? ay + r() * ah : ay - p.size * 2;
      break;
    case 'petals':
      p.vy = (0.045 + r() * 0.04) * p.depth * scale;
      p.vx = (0.03 + r() * 0.03) * field.wind * scale;
      p.size = (7 + r() * 6) * p.depth;
      p.y = fresh ? ay + r() * ah : ay - p.size * 2;
      if (!fresh && field.wind > 0.2 && r() < 0.5) {
        // On the wind they also blow in from the side.
        p.x = ax - p.size * 2;
        p.y = ay + r() * ah * 0.7;
      }
      break;
    case 'fireflies':
      p.vx = 0;
      p.vy = 0;
      p.size = 5 + r() * 5;
      p.y = ay + r() * ah;
      break;
    case 'embers':
      p.vy = -(0.07 + r() * 0.09) * scale;
      p.vx = (r() - 0.5) * 0.03;
      p.size = 2 + r() * 2.5;
      p.life = 1400 + r() * 1800;
      p.y = ay + ah * (0.7 + r() * 0.3);
      p.x = ax + aw * (0.25 + r() * 0.5);
      if (fresh) p.age = r() * p.life;
      break;
    case 'dust':
      p.vx = (r() - 0.5) * 0.012;
      p.vy = (r() - 0.5) * 0.008;
      p.size = 1.5 + r() * 2;
      p.y = ay + r() * ah;
      break;
  }
}

function spawnDrop(field: ParticleField, d: Particle, fresh: boolean): void {
  const r = (): number => rng(field);
  const [ax, ay, aw, ah] = field.area;
  d.x = ax + r() * aw;
  d.y = ay + r() * ah * (fresh ? 1 : 0.6);
  d.size = 3 + r() * 4;
  d.depth = 1;
  d.vx = 0;
  d.vy = 0;
  d.phase = r() * Math.PI * 2;
  d.age = 0;
  d.hold = 400 + r() * 5000;
  d.life = d.hold + 2500 + r() * 4000;
}

function blank(): Particle {
  return { x: 0, y: 0, vx: 0, vy: 0, size: 1, depth: 1, phase: 0, age: 0, life: Infinity, hold: 0 };
}

/** A filled field for a spec over its area. `count` is after the scene cap (see fitCounts). */
export function createField(spec: RoomParticles, area: RoomBox, seed: number, count = particleCount(spec, area)): ParticleField {
  const field: ParticleField = {
    kind: spec.kind,
    area,
    colour: spec.colour && /^#[0-9a-f]{6}$/i.test(spec.colour) ? spec.colour : KIND_DEFS[spec.kind].colour,
    wind: Math.max(-1, Math.min(1, spec.wind ?? defaultWind(spec.kind))),
    particles: [],
    drops: [],
    t: 0,
    seed: seed | 0 || 1,
  };
  for (let i = 0; i < count; i++) {
    const p = blank();
    spawn(field, p, true);
    field.particles.push(p);
  }
  if (spec.kind === 'rain' && spec.glass) {
    const n = Math.max(6, Math.min(18, Math.round(count / 6)));
    for (let i = 0; i < n; i++) {
      const d = blank();
      spawnDrop(field, d, true);
      field.drops.push(d);
    }
  }
  return field;
}

/** Counts per spec so the scene stays under MAX_PARTICLES (proportional, at least 1 each). */
export function fitCounts(wanted: readonly number[], max = MAX_PARTICLES): number[] {
  const total = wanted.reduce((a, b) => a + b, 0);
  if (total <= max) return [...wanted];
  const k = max / total;
  return wanted.map((n) => Math.max(1, Math.floor(n * k)));
}

/** True when a particle has left its area for good (the edge it moves away from), so it respawns. */
function gone(field: ParticleField, p: Particle): boolean {
  const [ax, ay, aw, ah] = field.area;
  const m = p.size * 3 + 4;
  if (p.age >= p.life) return true;
  if (p.y > ay + ah + m || p.y < ay - ah - m) return true;
  return p.x < ax - m * 2 || p.x > ax + aw + m * 2;
}

/** Advance a field by dt ms (capped at MAX_STEP_MS). */
export function stepField(field: ParticleField, dtMs: number): void {
  const dt = Math.max(0, Math.min(MAX_STEP_MS, dtMs));
  if (dt === 0) return;
  field.t += dt;
  const [ax, ay, aw, ah] = field.area;
  for (const p of field.particles) {
    p.age += dt;
    p.phase += dt * 0.0016;
    switch (field.kind) {
      case 'rain':
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        break;
      case 'snow':
        p.x += (p.vx + Math.sin(p.phase) * 0.018 * p.depth) * dt;
        p.y += p.vy * dt;
        break;
      case 'petals':
        p.x += (p.vx + Math.sin(p.phase * 1.3) * 0.03 * p.depth) * dt;
        p.y += (p.vy + Math.cos(p.phase * 0.9) * 0.012) * dt;
        break;
      case 'fireflies': {
        // Smooth wandering: velocity from slow sines of the particle's own phase.
        const s = 0.012;
        p.x += Math.sin(p.phase * 0.7 + p.size) * s * dt;
        p.y += Math.cos(p.phase * 0.53 + p.size * 2) * s * 0.7 * dt;
        // Stay in the area: wrap softly back in.
        if (p.x < ax) p.x += aw;
        if (p.x > ax + aw) p.x -= aw;
        if (p.y < ay) p.y = ay + 1;
        if (p.y > ay + ah) p.y = ay + ah - 1;
        break;
      }
      case 'embers':
        p.x += (p.vx + Math.sin(p.phase * 2.2) * 0.02) * dt;
        p.y += p.vy * dt;
        break;
      case 'dust':
        p.x += (p.vx + Math.sin(p.phase * 0.4) * 0.004) * dt;
        p.y += (p.vy + Math.cos(p.phase * 0.31) * 0.003) * dt;
        if (p.x < ax) p.x += aw;
        if (p.x > ax + aw) p.x -= aw;
        if (p.y < ay) p.y += ah;
        if (p.y > ay + ah) p.y -= ah;
        break;
    }
    if (gone(field, p)) spawn(field, p, false);
  }
  for (const d of field.drops) {
    d.age += dt;
    if (d.age > d.hold) {
      // Slides in fits and starts, a little sideways.
      const surge = 0.5 + 0.5 * Math.sin(d.age * 0.004 + d.phase);
      d.vy = 0.02 + surge * 0.09;
      d.y += d.vy * dt;
      d.x += Math.sin(d.age * 0.0021 + d.phase) * 0.006 * dt;
    }
    if (d.age >= d.life || d.y > ay + ah) spawnDrop(field, d, false);
  }
}

/** Opacity 0..1 of a particle right now (fireflies blink, embers fade, far rain is faint). */
export function particleAlpha(field: ParticleField, p: Particle): number {
  switch (field.kind) {
    case 'rain':
      return 0.18 + 0.3 * p.depth;
    case 'snow':
      return 0.45 + 0.5 * p.depth;
    case 'petals':
      return 0.7 + 0.3 * p.depth;
    case 'fireflies': {
      const b = Math.sin(p.phase * 1.7 + p.size);
      return Math.max(0, b) ** 2 * 0.95 + 0.05;
    }
    case 'embers': {
      const k = p.age / p.life;
      return Math.max(0, Math.min(1, k * 6)) * (1 - k) ** 1.5;
    }
    case 'dust':
      return 0.2 + 0.2 * (0.5 + 0.5 * Math.sin(p.phase * 0.8));
  }
}

/** The step for a frame at `now` after one at `last` (null = first frame): never negative, never over MAX_STEP_MS. */
export function particleDt(last: number | null, now: number): number {
  if (last === null || !Number.isFinite(last)) return 0;
  return Math.max(0, Math.min(MAX_STEP_MS, now - last));
}

/**
 * How particles show. 'animate' normally; 'still' when the person asked the
 * system for reduced motion (one settled picture, no loop: rain is left out,
 * since frozen streaks read as scratches), and also when the room draws at 0 fps.
 */
export type ParticleMode = 'animate' | 'still';

export function particleMode(opts: { reducedMotion: boolean; fps: number }): ParticleMode {
  if (opts.reducedMotion) return 'still';
  return opts.fps > 0 ? 'animate' : 'still';
}

/** Kinds that show in a still picture. */
export function showsStill(kind: RoomParticleKind): boolean {
  return kind !== 'rain';
}

/** A field settled for a still picture: stepped a few seconds so embers and drops are mid-life. */
export function settle(field: ParticleField, ms = 3000): ParticleField {
  for (let t = 0; t < ms; t += MAX_STEP_MS) stepField(field, MAX_STEP_MS);
  return field;
}
