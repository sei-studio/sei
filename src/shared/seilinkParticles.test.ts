import { describe, expect, it } from 'vitest';
import {
  MAX_PARTICLES,
  MAX_STEP_MS,
  PARTICLE_KINDS,
  createField,
  fitCounts,
  particleAlpha,
  particleCount,
  particleDt,
  particleMode,
  settle,
  showsStill,
  stepField,
  type ParticleField,
} from './seilinkParticles';
import type { RoomBox } from './seilinkRoom';

const AREA: RoomBox = [1341, 16, 1219, 1292];

function inBounds(f: ParticleField): boolean {
  const [x, y, w, h] = f.area;
  return f.particles.every((p) => {
    const m = p.size * 3 + 4;
    return p.x >= x - m * 2 && p.x <= x + w + m * 2 && p.y >= y - h - m && p.y <= y + h + m;
  });
}

describe('particle spawn bounds', () => {
  for (const kind of PARTICLE_KINDS) {
    it(`${kind}: spawns inside its area and stays in bounds over a minute`, () => {
      const f = createField({ kind, glass: kind === 'rain' }, AREA, 7);
      const [x, y, w, h] = AREA;
      // First fill: inside the area itself.
      for (const p of f.particles) {
        expect(p.x).toBeGreaterThanOrEqual(x - p.size * 2);
        expect(p.x).toBeLessThanOrEqual(x + w);
        expect(p.y).toBeGreaterThanOrEqual(y - p.size * 2);
        expect(p.y).toBeLessThanOrEqual(y + h);
      }
      for (let t = 0; t < 60_000; t += 33) {
        stepField(f, 33);
        if (t % 990 === 0) expect(inBounds(f)).toBe(true);
      }
      for (const d of f.drops) {
        expect(d.x).toBeGreaterThanOrEqual(x);
        expect(d.x).toBeLessThanOrEqual(x + w);
        expect(d.y).toBeLessThanOrEqual(y + h);
      }
      for (const p of f.particles) {
        const a = particleAlpha(f, p);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    });
  }

  it('rain falls and respawns at the top, embers rise from the bottom', () => {
    const rain = createField({ kind: 'rain' }, AREA, 3);
    const before = rain.particles.map((p) => p.y);
    stepField(rain, 16);
    rain.particles.forEach((p, i) => expect(p.y > before[i] || p.y < AREA[1]).toBe(true));
    const embers = createField({ kind: 'embers' }, [1000, 800, 400, 400], 3);
    for (const p of embers.particles) expect(p.y).toBeGreaterThanOrEqual(800 + 400 * 0.7);
    for (const p of embers.particles) expect(p.vy).toBeLessThan(0);
  });

  it('only rain with glass gets drops', () => {
    expect(createField({ kind: 'rain', glass: true }, AREA, 1).drops.length).toBeGreaterThan(0);
    expect(createField({ kind: 'rain' }, AREA, 1).drops).toHaveLength(0);
    expect(createField({ kind: 'snow', glass: true }, AREA, 1).drops).toHaveLength(0);
  });

  it('is seeded: the same seed gives the same field', () => {
    const a = createField({ kind: 'snow' }, AREA, 42);
    const b = createField({ kind: 'snow' }, AREA, 42);
    stepField(a, 40);
    stepField(b, 40);
    expect(a.particles).toEqual(b.particles);
    expect(createField({ kind: 'snow' }, AREA, 43).particles).not.toEqual(a.particles);
  });
});

describe('particle counts', () => {
  it('scales with area and density, clamped per kind', () => {
    const small = particleCount({ kind: 'rain' }, [0, 0, 100, 100]);
    const big = particleCount({ kind: 'rain' }, [0, 0, 2560, 1440]);
    expect(small).toBe(30);
    expect(big).toBe(140);
    // Density scales the clamped count (the scene cap still holds the total).
    expect(particleCount({ kind: 'rain', density: 0.5 }, [0, 0, 2560, 1440])).toBe(70);
  });

  it('the scene cap thins every field in proportion', () => {
    expect(fitCounts([10, 20])).toEqual([10, 20]);
    const fitted = fitCounts([200, 100]);
    expect(fitted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_PARTICLES);
    expect(fitted[0]).toBeGreaterThan(fitted[1]);
  });
});

describe('particle pause and reduced motion', () => {
  it('a pause never makes the field jump: the step is capped', () => {
    expect(particleDt(null, 1000)).toBe(0);
    expect(particleDt(1000, 1016)).toBe(16);
    expect(particleDt(1000, 61_000)).toBe(MAX_STEP_MS);
    expect(particleDt(2000, 1000)).toBe(0);
    const f = createField({ kind: 'snow' }, AREA, 5);
    const g = createField({ kind: 'snow' }, AREA, 5);
    stepField(f, 600_000); // a long pause, stepped once
    stepField(g, MAX_STEP_MS);
    expect(f.particles).toEqual(g.particles);
  });

  it('a zero step changes nothing (the loop is stopped while covered)', () => {
    const f = createField({ kind: 'fireflies' }, AREA, 9);
    const copy = structuredClone(f.particles);
    stepField(f, 0);
    expect(f.particles).toEqual(copy);
    expect(f.t).toBe(0);
  });

  it('reduced motion shows a still picture, without rain', () => {
    expect(particleMode({ reducedMotion: true, fps: 30 })).toBe('still');
    expect(particleMode({ reducedMotion: false, fps: 30 })).toBe('animate');
    expect(particleMode({ reducedMotion: false, fps: 0 })).toBe('still');
    expect(showsStill('rain')).toBe(false);
    expect(showsStill('fireflies')).toBe(true);
    const f = settle(createField({ kind: 'embers' }, AREA, 2), 1000);
    expect(f.t).toBe(1000);
  });
});
