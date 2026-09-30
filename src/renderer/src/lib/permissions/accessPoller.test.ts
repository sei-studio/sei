/**
 * 260929: the permission cards' poll. Checks about once a second, never
 * overlaps itself, stops on the first grant and continues exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_POLL_MS,
  RESTART_OFFER_AFTER_MS,
  restartOfferDue,
  startAccessPoller,
} from './accessPoller';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startAccessPoller', () => {
  it('checks immediately, then every second, and continues once on grant', async () => {
    let granted = false;
    const check = vi.fn(async () => granted);
    const onGranted = vi.fn();
    startAccessPoller({ check, onGranted });

    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS * 3);
    expect(check).toHaveBeenCalledTimes(4);
    expect(onGranted).not.toHaveBeenCalled();

    granted = true;
    await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS);
    expect(onGranted).toHaveBeenCalledTimes(1);

    // Polling has stopped: no more checks, no second continue.
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS * 5);
    expect(check).toHaveBeenCalledTimes(calls);
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it('waits one interval first when not immediate', async () => {
    const check = vi.fn(async () => false);
    startAccessPoller({ check, onGranted: () => {}, immediate: false });
    await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('is single-flight: a slow check is never overlapped', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const check = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ACCESS_POLL_MS * 4));
      inFlight--;
      return false;
    });
    const poller = startAccessPoller({ check, onGranted: () => {} });
    for (let i = 0; i < 10; i++) {
      poller.poke();
      await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS);
    }
    expect(maxInFlight).toBe(1);
    // 10 s of wall time with 4 s checks + 1 s gaps: two finished, one running.
    expect(check.mock.calls.length).toBeLessThanOrEqual(3);
    poller.stop();
  });

  it('treats a throwing or rejecting check as "not yet" and keeps going', async () => {
    let n = 0;
    const check = vi.fn(() => {
      n++;
      if (n === 1) throw new Error('sync boom');
      if (n === 2) return Promise.reject(new Error('async boom'));
      return Promise.resolve(n >= 3);
    });
    const onGranted = vi.fn();
    startAccessPoller({ check, onGranted });
    await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS * 3);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it('stop() halts polling, and a grant landing after stop is ignored', async () => {
    let resolve: (v: boolean) => void = () => {};
    const check = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    const onGranted = vi.fn();
    const poller = startAccessPoller({ check, onGranted });
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    resolve(true);
    await vi.advanceTimersByTimeAsync(ACCESS_POLL_MS * 3);
    expect(onGranted).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('poke() runs the next check now', async () => {
    const check = vi.fn(async () => false);
    const poller = startAccessPoller({ check, onGranted: () => {}, immediate: false });
    poller.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});

describe('restartOfferDue', () => {
  it('is never due before the player confirms', () => {
    expect(restartOfferDue(null, 1e12)).toBe(false);
  });

  it('comes due 20 s after "I turned it on"', () => {
    expect(RESTART_OFFER_AFTER_MS).toBe(20_000);
    expect(restartOfferDue(1_000, 1_000 + 19_999)).toBe(false);
    expect(restartOfferDue(1_000, 1_000 + 20_000)).toBe(true);
  });
});
