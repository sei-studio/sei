/**
 * Her desktop entrance (261119): the intro's arrival curves, ending exactly
 * at rest so the switch to `show` never jumps.
 */
import { describe, expect, it } from 'vitest';
import { ENTRANCE_MS, ENTRANCE_REDUCED_MS, entranceFrame, entranceKeyframes, entranceMs } from './entrance';

describe('her entrance', () => {
  it('lasts as long as the intro\'s lift..clear; a fade under reduced motion', () => {
    expect(ENTRANCE_MS).toBe(2800);
    expect(entranceMs(false)).toBe(ENTRANCE_MS);
    expect(entranceMs(true)).toBe(ENTRANCE_REDUCED_MS);
  });

  it('starts unseen, a touch low, bright and blurred, and ends at rest', () => {
    const a = entranceFrame(0, 1000, false);
    expect(a.opacity).toBe(0);
    expect(a.transform).toBe('translateY(20.00px)');
    expect(a.filter).toBe('brightness(1.350) blur(4.00px)');
    const z = entranceFrame(1, 1000, false);
    expect(z).toEqual({ opacity: 1, transform: 'none', filter: 'none' });
  });

  it('only rises and sharpens: opacity up, rise and blur down, all the way', () => {
    let last = entranceFrame(0, 800, false);
    for (let i = 1; i <= 50; i++) {
      const f = entranceFrame(i / 50, 800, false);
      expect(f.opacity).toBeGreaterThanOrEqual(last.opacity);
      const rise = (x: string): number => Number(/translateY\(([\d.]+)px\)/.exec(x)?.[1] ?? 0);
      const blur = (x: string): number => Number(/blur\(([\d.]+)px\)/.exec(x)?.[1] ?? 0);
      expect(rise(f.transform)).toBeLessThanOrEqual(rise(last.transform));
      expect(blur(f.filter)).toBeLessThanOrEqual(blur(last.filter));
      last = f;
    }
  });

  it('reduced motion: opacity only', () => {
    for (const p of [0, 0.3, 0.7, 1]) {
      const f = entranceFrame(p, 1000, true);
      expect(f.transform).toBe('none');
      expect(f.filter).toBe('none');
    }
  });

  it('keyframes run 0 to 1 and the last one is her at rest', () => {
    const k = entranceKeyframes(900, false);
    expect(k[0].offset).toBe(0);
    expect(k[k.length - 1]).toEqual({ offset: 1, opacity: 1, transform: 'translateY(0px)', filter: 'brightness(1) blur(0px)' });
    expect(k[0].opacity).toBe(0);
  });
});




