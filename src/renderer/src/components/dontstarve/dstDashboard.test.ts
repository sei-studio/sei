/**
 * dstDashboard helpers (260909): the game facts the DST dashboard paints.
 */
import { describe, it, expect } from 'vitest';
import { DST_CLOCK_SEGMENTS, DST_PHASE_SPLIT, clockSegments, dstItemLabel, meterPct, normalizePhase, normalizeSeason, slotCount, tempBand } from './dstDashboard';

describe('dstDashboard', () => {
  it('every season splits the clock into exactly 16 segments', () => {
    for (const season of Object.keys(DST_PHASE_SPLIT) as Array<keyof typeof DST_PHASE_SPLIT>) {
      const s = DST_PHASE_SPLIT[season];
      expect(s.day + s.dusk + s.night, season).toBe(DST_CLOCK_SEGMENTS);
      expect(clockSegments(season)).toHaveLength(DST_CLOCK_SEGMENTS);
    }
  });

  it('segments run day, then dusk, then night, and an unknown season reads as autumn', () => {
    const segs = clockSegments('autumn');
    expect(segs.slice(0, 8).every((p) => p === 'day')).toBe(true);
    expect(segs.slice(8, 12).every((p) => p === 'dusk')).toBe(true);
    expect(segs.slice(12).every((p) => p === 'night')).toBe(true);
    expect(clockSegments('???')).toEqual(segs);
    expect(normalizeSeason(undefined)).toBe('autumn');
    expect(normalizeSeason('Winter')).toBe('winter');
    expect(normalizePhase('NIGHT')).toBe('night');
    expect(normalizePhase(null)).toBe('day');
  });

  it('temperature bands follow the game thresholds (freeze at 0, overheat at 70)', () => {
    expect(tempBand(-3)).toBe('freezing');
    expect(tempBand(0)).toBe('freezing');
    expect(tempBand(4)).toBe('cold');
    expect(tempBand(25)).toBe('fine');
    expect(tempBand(65)).toBe('hot');
    expect(tempBand(70)).toBe('overheating');
    expect(tempBand(Number.NaN)).toBe('fine');
  });

  it('meters clamp and round', () => {
    expect(meterPct(96, 125)).toBe(77);
    expect(meterPct(-5, 100)).toBe(0);
    expect(meterPct(500, 100)).toBe(100);
    expect(meterPct(10, 0)).toBe(0);
  });

  it('item labels use the in-game name and fall back to the opened-up prefab', () => {
    expect(dstItemLabel('cutgrass')).toBe('Cut Grass');
    expect(dstItemLabel('goldnugget')).toBe('Gold Nugget');
    expect(dstItemLabel('spidergland')).toBe('Spider Gland');
    expect(dstItemLabel('some_new_thing')).toBe('Some New Thing');
  });

  it('the bar shows 15 slots and grows by rows of 15', () => {
    expect(slotCount(0)).toBe(15);
    expect(slotCount(15)).toBe(15);
    expect(slotCount(16)).toBe(30);
    expect(slotCount(24)).toBe(30);
  });
});
