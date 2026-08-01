/**
 * Call scene geometry + resolution.
 *
 * The staging numbers are what make the walk-in look right, and they are easy
 * to get subtly wrong in a way that only shows as "she pops in from nowhere"
 * on one window size. Pinning them here means the descriptor format can be
 * refactored without re-deriving the maths by eye.
 */

import { describe, it, expect } from 'vitest';
import type { Character } from '@shared/characterSchema';
import type { SceneActor } from '@shared/callScene';
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import {
  actorBoxStyle,
  actorMirrored,
  actorStartCenterX,
  easingTimeAtProgress,
  frontCrossX,
  frontSwitchDelayMs,
  hasCallScene,
  isPastFront,
  offstageTranslatePct,
  resolveCallScene,
  restIsPastFront,
} from './callScenes';

/** Minimal character stand-in — resolution only ever looks at the id. */
function char(id: string): Character {
  return { id, name: 'x' } as unknown as Character;
}

function actor(over: Partial<SceneActor> = {}): SceneActor {
  return {
    idle: { kind: 'images', images: ['a.png'] },
    aspect: 1.5,
    facing: 'left',
    rest: { centerX: 0.5, bottom: 0.07, width: 0.66 },
    entrance: { from: 'right', durationMs: 1000 },
    ...over,
  };
}

describe('resolveCallScene', () => {
  it('gives Sui the grass scene', () => {
    const scene = resolveCallScene(char(DEFAULT_CHARACTER_UUIDS.sui));
    expect(scene?.id).toBe('sui-grass');
    expect(hasCallScene(char(DEFAULT_CHARACTER_UUIDS.sui))).toBe(true);
  });

  it('gives everyone else nothing, so they fall back to art', () => {
    expect(resolveCallScene(char(DEFAULT_CHARACTER_UUIDS.marv))).toBeNull();
    expect(resolveCallScene(undefined)).toBeNull();
    expect(hasCallScene(char('11111111-2222-3333-4444-555555555555'))).toBe(false);
  });
});

describe('offstageTranslatePct', () => {
  it('clears the right edge completely when entering from the right', () => {
    // Box spans 0.17..0.83 of the stage. Its LEFT edge must pass 1.0, so the
    // move is (1 - 0.17) of the stage = 1.258 of the actor's own 0.66 width.
    const pct = offstageTranslatePct(actor());
    expect(pct).toBeCloseTo(((1 - 0.17 + 0.03) / 0.66) * 100, 6);
    // Sanity: past the edge, not merely at it.
    expect(0.17 + (pct / 100) * 0.66).toBeGreaterThan(1);
  });

  it('clears the left edge when entering from the left', () => {
    const pct = offstageTranslatePct(actor({ entrance: { from: 'left', durationMs: 1 } }));
    expect(pct).toBeLessThan(0);
    // The box's RIGHT edge ends up left of 0.
    expect(0.83 + (pct / 100) * 0.66).toBeLessThan(0);
  });

  it('scales with the actor, not the stage', () => {
    // A narrower sprite has further to travel in units of its OWN width.
    const wide = offstageTranslatePct(actor({ rest: { centerX: 0.5, bottom: 0, width: 0.8 } }));
    const narrow = offstageTranslatePct(actor({ rest: { centerX: 0.5, bottom: 0, width: 0.2 } }));
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe('actorMirrored', () => {
  it('leaves art alone when it already faces the way it walks', () => {
    // Entering from the right means walking left, and this art faces left.
    expect(actorMirrored(actor())).toBe(false);
    expect(actorMirrored(actor({ facing: 'right', entrance: { from: 'left', durationMs: 1 } }))).toBe(
      false,
    );
  });

  it('mirrors art drawn facing the other way', () => {
    expect(actorMirrored(actor({ facing: 'right' }))).toBe(true);
    expect(actorMirrored(actor({ entrance: { from: 'left', durationMs: 1 } }))).toBe(true);
  });
});

// 260731 — she walks in from behind the grass and steps in front of it partway
// across. The switch is a timer, so what these pin is the arithmetic that
// decides WHEN: a wrong answer here is a sprite that pops through the
// foreground in the middle of the field, or never comes forward at all.
describe('stepping in front of the foreground', () => {
  const third = () => actor({ entrance: { from: 'right', durationMs: 2200, frontAfter: 1 / 3 } });

  it('measures frontAfter from the edge she walks in from', () => {
    expect(frontCrossX(third())).toBeCloseTo(2 / 3, 6);
    expect(
      frontCrossX(actor({ entrance: { from: 'left', durationMs: 1, frontAfter: 1 / 3 } })),
    ).toBeCloseTo(1 / 3, 6);
  });

  it('is behind out at the entry edge and in front once past the line', () => {
    const a = third();
    expect(isPastFront(a, 0.9)).toBe(false);
    expect(isPastFront(a, 0.7)).toBe(false);
    expect(isPastFront(a, 0.6)).toBe(true);
    expect(restIsPastFront(a)).toBe(true); // rests at centre, well past 2/3
  });

  it('never comes forward without frontAfter — the original behaviour', () => {
    expect(frontCrossX(actor())).toBeNull();
    expect(isPastFront(actor(), 0)).toBe(false);
    expect(frontSwitchDelayMs(actor())).toBeNull();
  });

  it('never comes forward when she rests short of the line', () => {
    // Entering from the right but stopping at 0.8, out where the foreground
    // really is between her and the camera.
    const a = actor({
      rest: { centerX: 0.8, bottom: 0.07, width: 0.66 },
      entrance: { from: 'right', durationMs: 1000, frontAfter: 1 / 3 },
    });
    expect(frontSwitchDelayMs(a)).toBeNull();
  });

  it('switches partway through the walk, not at either end', () => {
    const a = third();
    const ms = frontSwitchDelayMs(a) as number;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(a.entrance.durationMs);
  });

  // The switch is a POSITION, and the walk is eased, so the time cannot be a
  // straight fraction of the duration. The curve is fast through the middle,
  // which puts a late-distance crossing earlier in time than a linear read of
  // it would.
  it('converts distance to time through the walk easing', () => {
    const a = third();
    const start = actorStartCenterX(a);
    const linear = ((2 / 3 - start) / (a.rest.centerX - start)) * a.entrance.durationMs;
    const eased = frontSwitchDelayMs(a) as number;
    expect(eased).toBeLessThan(linear);
  });

  it('easing inversion is monotonic and pinned at both ends', () => {
    expect(easingTimeAtProgress(0)).toBeCloseTo(0, 6);
    expect(easingTimeAtProgress(1)).toBeCloseTo(1, 6);
    expect(easingTimeAtProgress(-5)).toBeCloseTo(0, 6);
    expect(easingTimeAtProgress(5)).toBeCloseTo(1, 6);
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const t = easingTimeAtProgress(p);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('Sui crosses over during her own walk', () => {
    const sui = resolveCallScene(char(DEFAULT_CHARACTER_UUIDS.sui))!;
    const ms = frontSwitchDelayMs(sui.actor) as number;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(sui.actor.entrance.durationMs);
  });
});

describe('actorBoxStyle', () => {
  it('centres the box on centerX', () => {
    const box = actorBoxStyle(actor());
    expect(parseFloat(box.left)).toBeCloseTo(17, 6);
    expect(parseFloat(box.bottom)).toBeCloseTo(7, 6);
    expect(parseFloat(box.width)).toBeCloseTo(66, 6);
    expect(box.left.endsWith('%') && box.width.endsWith('%')).toBe(true);
  });
});
