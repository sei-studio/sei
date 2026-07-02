/**
 * playtimeEstimate.test.ts — unit tests for tokensRemainingToPlaytime.
 *
 * Locks in the rounding rule + boundary conditions.
 * 260602-hbr: the personalized rolling-24h model (PEAK_CALLS_PER_MIN /
 * STARTUP_TOKENS / SESSIONS_PER_HOUR) was replaced by a single flat
 * DEFAULT_TOKENS_PER_MIN multiplier. The sub-hour tests below pass an explicit
 * tokensPerMin (850) so they stay independent of the default constant's value.
 * 260606: minute-precision. Both branches now FLOOR to the whole minute and the
 * >=60min branch renders "~Hh Mmin left" so the live estimate ticks down by the
 * minute instead of snapping to whole hours. Plan-card marketing copy
 * (~1h/~5h/~20h) is static text in CreditsScreen, no longer derived here.
 */

import { describe, it, expect } from 'vitest';
import {
  tokensRemainingToPlaytime,
  DEFAULT_TOKENS_PER_MIN,
  VISION_MULTIPLIER,
} from './playtimeEstimate';

describe('tokensRemainingToPlaytime', () => {
  it('returns Calculating… when remainingTokens is undefined', () => {
    expect(tokensRemainingToPlaytime(undefined, undefined).display).toBe('Calculating…');
    expect(tokensRemainingToPlaytime(undefined, 850).display).toBe('Calculating…');
  });

  it('returns 0min left when remainingTokens is 0', () => {
    expect(tokensRemainingToPlaytime(0, 850).display).toBe('0min left');
  });

  it('falls back to DEFAULT_TOKENS_PER_MIN when tokensPerMin is undefined but tokens are present', () => {
    // Cold-start case: server sent remaining_tokens but no rate. We use the
    // flat default constant rather than block the playtime display. Supplying
    // DEFAULT_TOKENS_PER_MIN × 60 tokens keeps the rawMin == 60 boundary true
    // independent of the numerical default.
    const result = tokensRemainingToPlaytime(DEFAULT_TOKENS_PER_MIN * 60, undefined);
    expect(result.display).toBe('~1h left');
  });

  it('returns Calculating… when tokensPerMin <= 0', () => {
    expect(tokensRemainingToPlaytime(1000, 0).display).toBe('Calculating…');
    expect(tokensRemainingToPlaytime(1000, -10).display).toBe('Calculating…');
  });

  it('1 minute of tokens shows ~1min left (floored to the whole minute)', () => {
    expect(tokensRemainingToPlaytime(850, 850).display).toBe('~1min left');
  });

  it('14 minutes of tokens shows ~14min left', () => {
    expect(tokensRemainingToPlaytime(850 * 14, 850).display).toBe('~14min left');
  });

  it('30 minutes of tokens shows ~30min left', () => {
    expect(tokensRemainingToPlaytime(850 * 30, 850).display).toBe('~30min left');
  });

  it('59 minutes of tokens shows ~59min left (sub-hour, no rounding loss)', () => {
    expect(tokensRemainingToPlaytime(850 * 59, 850).display).toBe('~59min left');
  });

  it('floors a fractional sub-hour remainder down to the whole minute', () => {
    // 30.9 min → floor → 30
    expect(tokensRemainingToPlaytime(Math.round(850 * 30.9), 850).display).toBe('~30min left');
  });

  it('exactly 60 minutes flips to hour units: ~1h left', () => {
    expect(tokensRemainingToPlaytime(850 * 60, 850).display).toBe('~1h left');
  });

  it('65 minutes shows ~1h 5min left (hours + minutes, no hour rounding)', () => {
    expect(tokensRemainingToPlaytime(850 * 65, 850).display).toBe('~1h 5min left');
  });

  it('130 minutes shows ~2h 10min left', () => {
    expect(tokensRemainingToPlaytime(850 * 130, 850).display).toBe('~2h 10min left');
  });

  it('599 minutes shows ~9h 59min left (floored, never overpromised to 10h)', () => {
    expect(tokensRemainingToPlaytime(850 * 599, 850).display).toBe('~9h 59min left');
  });

  it('drops the minute segment when it floors to a whole hour', () => {
    expect(tokensRemainingToPlaytime(850 * 120, 850).display).toBe('~2h left');
  });

  it('uses DEFAULT_TOKENS_PER_MIN when tokensPerMin omitted', () => {
    // Same as supplying DEFAULT_TOKENS_PER_MIN explicitly. Pinning by
    // constant rather than literal so this test survives future default
    // changes.
    const explicit = tokensRemainingToPlaytime(
      DEFAULT_TOKENS_PER_MIN * 65,
      DEFAULT_TOKENS_PER_MIN,
    ).display;
    const implicit = tokensRemainingToPlaytime(DEFAULT_TOKENS_PER_MIN * 65).display;
    expect(implicit).toBe(explicit);
  });

  it('returns 0min when raw minutes is fractional below 1', () => {
    // 0.5 min of tokens → strictly less than 1 → show 0min, not a misleading ~1min
    expect(tokensRemainingToPlaytime(425, 850).display).toBe('0min left');
  });

  it('returns floored minutes count alongside display for testing/debugging', () => {
    expect(tokensRemainingToPlaytime(850 * 60, 850).minutes).toBe(60);
    expect(tokensRemainingToPlaytime(850 * 65, 850).minutes).toBe(65);
    expect(tokensRemainingToPlaytime(0, 850).minutes).toBe(0);
  });
});

describe('260606 minute-precision playtime multiplier', () => {
  it('DEFAULT_TOKENS_PER_MIN is the flat constant (6800)', () => {
    expect(DEFAULT_TOKENS_PER_MIN).toBe(6800);
  });

  it('full Trial grant (1M µ$ → 500k blended tokens) reads ~1h 13min', () => {
    // remaining_tokens = balance_micro / 2 (MICRO_PER_TOKEN_BLENDED).
    // 500000 / 6800 = 73.5 min → floor → 1h 13min.
    const trialTokens = 1_000_000 / 2;
    expect(tokensRemainingToPlaytime(trialTokens).display).toBe('~1h 13min left');
  });

  it('full Quest grant (3.825M µ$ → 1.9125M blended tokens) reads ~4h 41min', () => {
    // 1912500 / 6800 = 281.25 min → floor → 4h 41min.
    const questTokens = 3_825_000 / 2;
    expect(tokensRemainingToPlaytime(questTokens).display).toBe('~4h 41min left');
  });

  it('full Party grant (16.65M µ$ → 8.325M blended tokens) reads ~20h 24min', () => {
    // 8325000 / 6800 = 1224.26 min → floor → 20h 24min.
    const partyTokens = 16_650_000 / 2;
    expect(tokensRemainingToPlaytime(partyTokens).display).toBe('~20h 24min left');
  });

  it("ouen's live balance (886,314 µ$ → 443,157 tokens) reads ~1h 5min", () => {
    // The 10%-used regression: 65.17 min must show minutes, not snap to ~1h.
    expect(tokensRemainingToPlaytime(886_314 / 2).display).toBe('~1h 5min left');
  });
});

describe('Phase 15 (D-07) — vision auto-render playtime shrink', () => {
  // Auto-look has the bot render its surroundings on its own, which costs more
  // playtime. D-07 communicates this by SHRINKING the "~Xh left" figure — apply
  // VISION_MULTIPLIER to the burn rate when auto-render is ON. A higher effective
  // tokensPerMin yields fewer minutes for the same remaining tokens. PROXY-05
  // holds: only the displayed TIME shrinks; no token counts surface.

  it('VISION_MULTIPLIER is in the documented 1.3–1.5x range', () => {
    expect(VISION_MULTIPLIER).toBeGreaterThanOrEqual(1.3);
    expect(VISION_MULTIPLIER).toBeLessThanOrEqual(1.5);
  });

  it('VISION_MULTIPLIER is strictly greater than 1 so it shrinks (never grows) the figure', () => {
    expect(VISION_MULTIPLIER).toBeGreaterThan(1);
  });

  it('the multiplied rate yields strictly FEWER minutes than the base rate for the same tokens', () => {
    const remaining = DEFAULT_TOKENS_PER_MIN * 100; // 100 base-minutes worth
    const baseRate = DEFAULT_TOKENS_PER_MIN;
    const visionRate = DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER;

    const base = tokensRemainingToPlaytime(remaining, baseRate);
    const withVision = tokensRemainingToPlaytime(remaining, visionRate);

    expect(withVision.minutes).toBeLessThan(base.minutes);
  });

  it('the shrunk estimate matches the analytic floor(remaining / (rate × multiplier))', () => {
    const remaining = DEFAULT_TOKENS_PER_MIN * 100;
    const visionRate = DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER;
    const expectedMin = Math.floor(remaining / visionRate);
    expect(tokensRemainingToPlaytime(remaining, visionRate).minutes).toBe(expectedMin);
  });

  it('auto-render OFF (base rate) is UNCHANGED from the prior behavior — no regression', () => {
    // Passing the base rate (auto-render off) must equal the default-argument
    // call, i.e. exactly what the UI showed before this change.
    const remaining = DEFAULT_TOKENS_PER_MIN * 100;
    const offExplicit = tokensRemainingToPlaytime(remaining, DEFAULT_TOKENS_PER_MIN);
    const priorBehavior = tokensRemainingToPlaytime(remaining);
    expect(offExplicit.display).toBe(priorBehavior.display);
    expect(offExplicit.minutes).toBe(priorBehavior.minutes);
    // And it is exactly 100 minutes → ~1h 40min left (the pre-vision figure).
    expect(offExplicit.display).toBe('~1h 40min left');
  });
});
