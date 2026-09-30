/**
 * Pure helpers behind the Stardew Valley dashboard (260909). No React, no
 * stores, so the tests can pin the game facts the panel paints: the weekday
 * of a season day, the clock dial position, the weather and season keys,
 * gold formatting.
 */

/** Every season is 28 days and day 1 is always a Monday. */
export const STARDEW_WEEKDAYS = ['Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.', 'Sun.'] as const;

export function stardewWeekday(day: number): (typeof STARDEW_WEEKDAYS)[number] {
  const d = Number.isFinite(day) && day >= 1 ? Math.floor(day) : 1;
  return STARDEW_WEEKDAYS[(d - 1) % 7];
}

export type StardewWeather = 'sunny' | 'rain' | 'storm' | 'snow' | 'windy';

/** The mod reports exactly these five (Snapshot.Weather()); anything else reads as sunny. */
export function normalizeWeather(weather: string | null | undefined): StardewWeather {
  const w = String(weather ?? '').toLowerCase();
  return w === 'rain' || w === 'storm' || w === 'snow' || w === 'windy' ? w : 'sunny';
}

export type StardewSeason = 'spring' | 'summer' | 'fall' | 'winter';

export function normalizeSeason(season: string | null | undefined): StardewSeason {
  const s = String(season ?? '').toLowerCase();
  return s === 'summer' || s === 'fall' || s === 'winter' ? s : 'spring';
}

/** Display names, keyed for t(). */
export const SEASON_LABEL: Record<StardewSeason, string> = { spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter' };
export const WEATHER_LABEL: Record<StardewWeather, string> = { sunny: 'Sunny', rain: 'Rain', storm: 'Storm', snow: 'Snow', windy: 'Windy' };

/**
 * Where the sun sits on the day dial: 0 at 6:00 AM (the day starts), 1 at
 * 2:00 AM (anyone still up passes out). The game clock is HHMM with hours
 * running past 24 after midnight (2600 = 2 AM).
 */
export function dayProgress(time: number): number {
  if (!Number.isFinite(time)) return 0;
  const hour = Math.floor(time / 100);
  const minute = time % 100;
  const minutes = hour * 60 + minute;
  const start = 6 * 60;
  const end = 26 * 60;
  return Math.max(0, Math.min(1, (minutes - start) / (end - start)));
}

/** Night on the dial begins at 6 PM in spring/summer and darkens earlier in fall/winter, like the game's ambient light. */
export function isEvening(time: number): boolean {
  return Number.isFinite(time) && time >= 1800;
}

/** "1:30 PM" as the game prints it in the HUD: "1:30 pm". */
export function hudTime(timeText: string): string {
  return String(timeText ?? '').replace(/\s*(AM|PM)$/i, (m) => m.toLowerCase());
}

/** 1250 -> "1,250g". */
export function formatGold(gold: number): string {
  const n = Number.isFinite(gold) ? Math.max(0, Math.floor(gold)) : 0;
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}g`;
}

export type BarTone = 'full' | 'low' | 'critical';

/** The energy bar goes yellow under a quarter and red under a tenth, like the game's. */
export function barTone(pct: number): BarTone {
  if (pct <= 10) return 'critical';
  if (pct <= 25) return 'low';
  return 'full';
}

export function pct(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

export const STARDEW_SLOTS = 36;
export const STARDEW_COLUMNS = 12;
