/**
 * stardewDashboard helpers (260909): the game facts the Stardew dashboard paints.
 */
import { describe, it, expect } from 'vitest';
import { barTone, dayProgress, formatGold, hudTime, isEvening, normalizeSeason, normalizeWeather, pct, stardewWeekday } from './stardewDashboard';

describe('stardewDashboard', () => {
  it('day 1 of every season is a Monday and the week wraps', () => {
    expect(stardewWeekday(1)).toBe('Mon.');
    expect(stardewWeekday(3)).toBe('Wed.');
    expect(stardewWeekday(7)).toBe('Sun.');
    expect(stardewWeekday(8)).toBe('Mon.');
    expect(stardewWeekday(28)).toBe('Sun.');
    expect(stardewWeekday(0)).toBe('Mon.');
  });

  it('weather and season keys are the five and four the mod reports, anything else defaults', () => {
    expect(normalizeWeather('storm')).toBe('storm');
    expect(normalizeWeather('windy')).toBe('windy');
    expect(normalizeWeather('festival')).toBe('sunny');
    expect(normalizeSeason('fall')).toBe('fall');
    expect(normalizeSeason('')).toBe('spring');
  });

  it('the day dial runs 6:00 AM to 2:00 AM', () => {
    expect(dayProgress(600)).toBe(0);
    expect(dayProgress(1600)).toBe(0.5);
    expect(dayProgress(2600)).toBe(1);
    expect(dayProgress(300)).toBe(0);
    expect(isEvening(1750)).toBe(false);
    expect(isEvening(1800)).toBe(true);
  });

  it('time and gold print like the HUD', () => {
    expect(hudTime('1:30 PM')).toBe('1:30 pm');
    expect(hudTime('6:00 AM')).toBe('6:00 am');
    expect(formatGold(1250)).toBe('1,250g');
    expect(formatGold(500)).toBe('500g');
    expect(formatGold(1234567)).toBe('1,234,567g');
    expect(formatGold(-4)).toBe('0g');
  });

  it('the bar turns yellow under a quarter and red under a tenth', () => {
    expect(barTone(100)).toBe('full');
    expect(barTone(26)).toBe('full');
    expect(barTone(25)).toBe('low');
    expect(barTone(10)).toBe('critical');
    expect(pct(172, 270)).toBe(64);
    expect(pct(5, 0)).toBe(0);
  });
});
