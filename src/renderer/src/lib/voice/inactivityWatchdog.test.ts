/**
 * Tests for the voice-call inactivity watchdog's pure decision logic
 * (inactivityWatchdog.ts). The store owns timers; this owns the ladder:
 *
 *   W.1 — quiet under 10 min is 'ok'.
 *   W.2 — quiet at/over 10 min is 'prompt'.
 *   W.3 — with the prompt up, under 10 s is still 'prompt'; at/over 10 s
 *         is 'end'.
 *   W.4 — an active screenshare is 'ok' no matter how stale the clock is,
 *         even mid-countdown.
 *   W.5 — sleep/wake: a now far past BOTH thresholds with no prompt shown
 *         still lands on 'prompt' (the call never ends unasked).
 *   W.6 — countdownSecondsLeft walks 10 → 0 and clamps at 0.
 */

import { describe, it, expect } from 'vitest';
import {
  decideInactivity,
  countdownSecondsLeft,
  INACTIVITY_PROMPT_AFTER_MS,
  INACTIVITY_COUNTDOWN_MS,
} from './inactivityWatchdog';

const T0 = 1_700_000_000_000;

describe('decideInactivity', () => {
  it('W.1: quiet under the 10-minute window is ok', () => {
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt: null,
        now: T0 + INACTIVITY_PROMPT_AFTER_MS - 1,
        sharing: false,
      }),
    ).toBe('ok');
  });

  it('W.2: quiet at/over the window prompts', () => {
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt: null,
        now: T0 + INACTIVITY_PROMPT_AFTER_MS,
        sharing: false,
      }),
    ).toBe('prompt');
  });

  it('W.3: prompt holds through the countdown, then ends', () => {
    const promptAt = T0 + INACTIVITY_PROMPT_AFTER_MS;
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt,
        now: promptAt + INACTIVITY_COUNTDOWN_MS - 1,
        sharing: false,
      }),
    ).toBe('prompt');
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt,
        now: promptAt + INACTIVITY_COUNTDOWN_MS,
        sharing: false,
      }),
    ).toBe('end');
  });

  it('W.4: an active screenshare suppresses the watchdog entirely', () => {
    // Stale clock, no prompt.
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt: null,
        now: T0 + 10 * INACTIVITY_PROMPT_AFTER_MS,
        sharing: true,
      }),
    ).toBe('ok');
    // Even mid-countdown: sharing retracts the prompt rather than ending.
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt: T0 + INACTIVITY_PROMPT_AFTER_MS,
        now: T0 + INACTIVITY_PROMPT_AFTER_MS + 2 * INACTIVITY_COUNTDOWN_MS,
        sharing: true,
      }),
    ).toBe('ok');
  });

  it('W.5: waking far past both thresholds still prompts before ending', () => {
    expect(
      decideInactivity({
        lastActivityAt: T0,
        promptAt: null,
        now: T0 + 8 * 60 * 60_000, // slept 8 hours
        sharing: false,
      }),
    ).toBe('prompt');
  });

  it('W.6: countdown seconds walk 10 to 0 and clamp', () => {
    expect(countdownSecondsLeft(T0, T0)).toBe(10);
    expect(countdownSecondsLeft(T0, T0 + 1)).toBe(10);
    expect(countdownSecondsLeft(T0, T0 + 4_200)).toBe(6);
    expect(countdownSecondsLeft(T0, T0 + INACTIVITY_COUNTDOWN_MS)).toBe(0);
    expect(countdownSecondsLeft(T0, T0 + INACTIVITY_COUNTDOWN_MS + 5_000)).toBe(0);
  });
});
