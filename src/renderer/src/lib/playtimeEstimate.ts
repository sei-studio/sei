/**
 * playtimeEstimate.ts — pure conversion: tokens remaining → human playtime string.
 *
 * ITEM 4 (quick/260523-t8d) — replaces the PercentBar/credits-% display in
 * CreditsScreen + IconRail with a teen-friendly "~3h left" / "~30min left"
 * string. Backend supplies remaining_tokens; the UI does the formatting
 * client-side so the rounding rule can evolve without a main-process release.
 */

/**
 * Playtime estimate multiplier — a single flat constant (260602-hbr;
 * recalibrated 260602-uv9).
 *
 * The earlier personalized rolling-24h rate (PEAK_CALLS_PER_MIN ×
 * avg-request-cost + STARTUP_TOKENS, gated on 20 settled rows) was removed: it
 * over-promised on fresh balances (a full Party grant read ~91h against the
 * marketed ~20h) and only converged after enough usage data. We now apply ONE
 * flat rate to `remaining_tokens` for every user.
 *
 * 6800 tokens/min is the marketing calibration (tokens = grant_micro / 2 at the
 * proxy 2 µ$/token blended rate, `MICRO_PER_TOKEN_BLENDED`):
 *   - Trial  500,000 tok   → 73.5 min   → ~1h 13min
 *   - Quest  1,912,500 tok → 281.25 min → ~4h 41min
 *   - Party  8,325,000 tok → 1224.26 min → ~20h 24min
 * The plan cards advertise round figures (~1h / ~5h / ~20h) as static copy; the
 * LIVE estimate below now shows exact hours+minutes so it visibly ticks down
 * (260606). All remainders FLOOR so we never overpromise the last few minutes.
 *
 * Kept the name DEFAULT_TOKENS_PER_MIN for continuity — it is now the ONLY
 * rate, used as the default second argument to tokensRemainingToPlaytime().
 */
export const DEFAULT_TOKENS_PER_MIN = 6800;

/**
 * Vision auto-render burn-rate multiplier (Phase 15, D-07 / VIS-04).
 *
 * When the user turns ON idle auto-look, the bot periodically renders what it
 * sees and sends that frame to the model — heavier usage than text-only play.
 * D-07's cost communication is to SHRINK the "~Xh left" figure rather than show
 * a scary number at toggle time: callers pass `DEFAULT_TOKENS_PER_MIN ×
 * VISION_MULTIPLIER` as the effective rate when auto-render is on. A higher
 * effective tokens/min means `rawMin = remainingTokens / tokensPerMin` is
 * smaller, so the same balance reads as less playtime.
 *
 * 1.4× sits in the 1.3–1.5× band from 15-RESEARCH §"Playtime shrink (D-07)" — an
 * honest "vision costs noticeably more, but not punitively" estimate (the exact
 * per-frame cost depends on resolution/quality + idle cadence, so this is a flat
 * honest hint, not a precise meter). PROXY-05 holds: this only changes the
 * displayed TIME number; no token/dollar counts are ever surfaced.
 *
 * D-11: BYO-key / local-VLM users never see the Playtime/Credits surface at all
 * (it's gated to cloud-proxy users), so this multiplier falls out for free for
 * them — it must never be applied anywhere a BYO/local user could see it.
 */
export const VISION_MULTIPLIER = 1.4;

export interface PlaytimeEstimate {
  /** Human-readable display string, e.g. "~2h 5min left", "~45min left", "0min left", "Calculating…". */
  display: string;
  /** Raw computed minutes (floored) — exposed for testing/debugging. */
  minutes: number;
}

/**
 * Convert remaining tokens to a teenage-friendly playtime string.
 *
 * Rounding rule (260606 — minute-precision):
 *   - undefined inputs → "Calculating…"
 *   - rawMin < 1 → "0min left" (don't promise a turn the bot can't finish)
 *   - 1 ≤ rawMin < 60 → "~Nmin left" (floored to the whole minute)
 *   - rawMin >= 60 → "~Hh Mmin left" (both floored; "~Hh left" when M == 0)
 * Everything FLOORS so we never overpromise the last partial minute. The live
 * estimate visibly ticks down between refreshes instead of being pinned to a
 * whole hour.
 */
export function tokensRemainingToPlaytime(
  remainingTokens: number | undefined,
  tokensPerMin: number | undefined = DEFAULT_TOKENS_PER_MIN,
): PlaytimeEstimate {
  if (remainingTokens === undefined || tokensPerMin === undefined || tokensPerMin <= 0) {
    return { display: 'Calculating…', minutes: 0 };
  }
  if (remainingTokens <= 0) return { display: '0min left', minutes: 0 };
  const rawMin = remainingTokens / tokensPerMin;
  if (rawMin < 1) return { display: '0min left', minutes: 0 };
  const totalMin = Math.floor(rawMin);
  if (totalMin < 60) return { display: `~${totalMin}min left`, minutes: totalMin };
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return {
    display: mins === 0 ? `~${hours}h left` : `~${hours}h ${mins}min left`,
    minutes: totalMin,
  };
}
