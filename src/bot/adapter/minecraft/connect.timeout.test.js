/**
 * connectTimeoutFor — the connect guard's budget.
 *
 * Regression cover for 260801: the guard is armed at createBot while the
 * supervisor's watchdog is armed at fork, so a flat 20s only reported first
 * when boot plus the status ping fit inside the 10s difference. On a cold
 * packaged Windows start they do not, and the specific failure was replaced by
 * the generic 30s "did not signal ready" every time. The property that matters
 * is not the exact number but that the guard always fires BEFORE the deadline
 * it was given, whatever boot cost.
 */
import { describe, it, expect } from 'vitest';
import { __testables } from './connect.js';

const { connectTimeoutFor, CONNECT_TIMEOUT_MS, REPORT_MARGIN_MS, MIN_CONNECT_TIMEOUT_MS } = __testables;

const SUMMON_BUDGET_MS = 30_000; // mirrors botSupervisor.SUMMON_TIMEOUT_MS

/** Budget chosen when `bootMs` elapsed between fork and createBot. */
const forBoot = (bootMs) => {
  const forkedAt = 1_000_000;
  return connectTimeoutFor(forkedAt + SUMMON_BUDGET_MS, forkedAt + bootMs);
};

describe('connectTimeoutFor', () => {
  it('falls back to the flat ceiling when main sends no deadline (older main)', () => {
    expect(connectTimeoutFor(undefined)).toBe(CONNECT_TIMEOUT_MS);
    expect(connectTimeoutFor(null)).toBe(CONNECT_TIMEOUT_MS);
    expect(connectTimeoutFor(NaN)).toBe(CONNECT_TIMEOUT_MS);
  });

  it('keeps the 20s ceiling on a fast boot, where it already fit', () => {
    // 2s boot: 30 - 2 - 3 = 25s remaining, so the ceiling still binds.
    expect(forBoot(2_000)).toBe(CONNECT_TIMEOUT_MS);
  });

  it('shrinks the budget once boot has eaten the margin', () => {
    // 12s boot: 30 - 12 - 3 = 15s. The old flat 20s would have fired at 32s,
    // i.e. after the supervisor's 30s watchdog had already overwritten it.
    expect(forBoot(12_000)).toBe(15_000);
  });

  it('fires before the deadline for every boot cost it can still beat', () => {
    for (const bootMs of [0, 500, 3_000, 7_500, 12_000, 18_000, 21_900]) {
      const firesAt = bootMs + forBoot(bootMs);
      expect(firesAt).toBeLessThan(SUMMON_BUDGET_MS);
    }
  });

  it('never returns a zero or negative timeout on a pathological boot', () => {
    // Past the point where any margin is left, the floor takes over: losing the
    // race to the supervisor is better than killing a healthy handshake on
    // arrival with a ~0ms timer.
    expect(forBoot(29_000)).toBe(MIN_CONNECT_TIMEOUT_MS);
    expect(forBoot(40_000)).toBe(MIN_CONNECT_TIMEOUT_MS);
  });

  it('leaves the lifecycle message room to cross the port', () => {
    const bootMs = 12_000;
    expect(SUMMON_BUDGET_MS - (bootMs + forBoot(bootMs))).toBe(REPORT_MARGIN_MS);
  });
});
