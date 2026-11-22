/**
 * The onboarding scene's stage gates (261012). A stage must complete exactly
 * once whether its CSS transition fires, never fires, or both the event and
 * the watchdog land; a hidden window holds the watchdog, but never forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HIDDEN_CEILING_MS,
  armTransitionGate,
  summarizeAdvance,
  watchdogDelayMs,
  whenVisible,
  type AdvanceSource,
  type Visibility,
} from './sceneGate';
import { GROUND_TRANSITION_MS, SUI_WALK_TRANSITION_MS } from './OnboardScene';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A page whose visibility the test flips by hand. */
function fakeVisibility(hidden: boolean): Visibility & { show(): void; listeners(): number } {
  let isHidden = hidden;
  const subs = new Set<() => void>();
  return {
    isHidden: () => isHidden,
    onVisible: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    show: () => {
      isHidden = false;
      for (const cb of [...subs]) cb();
    },
    listeners: () => subs.size,
  };
}

const VISIBLE = fakeVisibility(false);

function arm(opts: { expectedMs?: number; visibility?: Visibility; instant?: 'skip' | 'reduced_motion' } = {}) {
  const calls: AdvanceSource[] = [];
  const gate = armTransitionGate({
    expectedMs: opts.expectedMs ?? GROUND_TRANSITION_MS,
    onAdvance: (by) => calls.push(by),
    visibility: opts.visibility ?? VISIBLE,
    instant: opts.instant,
  });
  return { gate, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('watchdogDelayMs', () => {
  it('is the expected duration plus 1.5 s, never under 3 s', () => {
    expect(watchdogDelayMs(2400)).toBe(3900);
    expect(watchdogDelayMs(2600)).toBe(4100);
    expect(watchdogDelayMs(0)).toBe(3000);
    expect(watchdogDelayMs(1000)).toBe(3000);
  });
});

describe('armTransitionGate', () => {
  it('the transition fires: advances once, by transition, and the watchdog stays quiet', () => {
    const { gate, calls } = arm();
    vi.advanceTimersByTime(GROUND_TRANSITION_MS);
    gate.transitionEnded();
    expect(calls).toEqual(['transition']);
    expect(gate.done).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['transition']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the transition never fires: the watchdog advances a little after the expected duration', () => {
    const { calls } = arm();
    vi.advanceTimersByTime(watchdogDelayMs(GROUND_TRANSITION_MS) - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['watchdog']);
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['watchdog']);
  });

  it('both fire: a late transitionend after the watchdog does not advance twice', () => {
    const { gate, calls } = arm({ expectedMs: SUI_WALK_TRANSITION_MS });
    vi.advanceTimersByTime(watchdogDelayMs(SUI_WALK_TRANSITION_MS));
    gate.transitionEnded();
    gate.transitionEnded();
    gate.skip();
    expect(calls).toEqual(['watchdog']);
  });

  it('a skip completes now, once', () => {
    const { gate, calls } = arm();
    vi.advanceTimersByTime(500);
    gate.skip();
    gate.transitionEnded();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['skip']);
  });

  it('instant (reduced motion, or an intro already skipped) completes synchronously', () => {
    const { gate, calls } = arm({ instant: 'reduced_motion' });
    expect(calls).toEqual(['reduced_motion']);
    gate.transitionEnded();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['reduced_motion']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a cancelled (superseded) stage never fires', () => {
    const { gate, calls } = arm();
    gate.cancel();
    gate.transitionEnded();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hidden window holds the watchdog until it is shown, then counts from there', () => {
    const page = fakeVisibility(true);
    const { calls } = arm({ visibility: page });
    vi.advanceTimersByTime(10_000); // well past the visible-window watchdog
    expect(calls).toEqual([]);
    page.show();
    vi.advanceTimersByTime(watchdogDelayMs(GROUND_TRANSITION_MS) - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['watchdog']);
    expect(page.listeners()).toBe(0);
  });

  it('a hidden window: the real transition after it is shown still wins', () => {
    const page = fakeVisibility(true);
    const { gate, calls } = arm({ visibility: page });
    page.show();
    vi.advanceTimersByTime(GROUND_TRANSITION_MS);
    gate.transitionEnded();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['transition']);
  });

  it('a window that never reports visible still advances (ceiling, then the watchdog)', () => {
    const page = fakeVisibility(true);
    const { calls } = arm({ visibility: page });
    vi.advanceTimersByTime(HIDDEN_CEILING_MS + watchdogDelayMs(GROUND_TRANSITION_MS) - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['watchdog']);
    expect(page.listeners()).toBe(0);
  });

  it('a skip while hidden completes and drops the visibility listener', () => {
    const page = fakeVisibility(true);
    const { gate, calls } = arm({ visibility: page });
    gate.skip();
    expect(calls).toEqual(['skip']);
    expect(page.listeners()).toBe(0);
    page.show();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['skip']);
  });
});

describe('whenVisible', () => {
  it('runs at once on a visible page', () => {
    const cb = vi.fn();
    whenVisible(cb, VISIBLE);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('waits for a hidden page to show, once', () => {
    const page = fakeVisibility(true);
    const cb = vi.fn();
    whenVisible(cb, page);
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
    page.show();
    page.show();
    vi.advanceTimersByTime(HIDDEN_CEILING_MS);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting at the ceiling', () => {
    const page = fakeVisibility(true);
    const cb = vi.fn();
    whenVisible(cb, page, 7000);
    vi.advanceTimersByTime(6999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cancel stops both paths', () => {
    const page = fakeVisibility(true);
    const cb = vi.fn();
    const cancel = whenVisible(cb, page);
    cancel();
    page.show();
    vi.advanceTimersByTime(HIDDEN_CEILING_MS * 2);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('summarizeAdvance', () => {
  it('skip > reduced_motion > watchdog > transition', () => {
    expect(summarizeAdvance(['transition', 'transition'])).toBe('transition');
    expect(summarizeAdvance(['transition', 'watchdog'])).toBe('watchdog');
    expect(summarizeAdvance(['watchdog', 'skip'])).toBe('skip');
    expect(summarizeAdvance(['reduced_motion', 'reduced_motion'])).toBe('reduced_motion');
    expect(summarizeAdvance([])).toBe('transition');
  });
});

describe('watchdog sizing tracks the CSS', () => {
  const css = readFileSync(resolve(__dirname, 'onboard.module.css'), 'utf-8');
  const durationOf = (selector: string): number => {
    const block = new RegExp(`\\n\\.${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const ms = /transition:\s*transform\s+(\d+)ms/.exec(block)?.[1];
    return Number(ms);
  };
  it('the ground and walk constants match onboard.module.css', () => {
    expect(durationOf('ground')).toBe(GROUND_TRANSITION_MS);
    expect(durationOf('sui')).toBe(SUI_WALK_TRANSITION_MS);
  });
});




