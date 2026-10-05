/**
 * The "free play is back" scheduling (261005): wall gating, once per reset,
 * the timer recomputed from the stored reset time on every start, and the
 * setting gate. Driven with a manual clock and fake deps, no Electron.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRefillNotifier,
  DUE_WINDOW_MS,
  markHandled,
  MAX_ATTEMPTS,
  MAX_TIMER_MS,
  planRefill,
  recordWall,
  RETRY_MS,
  type RefillNotifierDeps,
  type RefillStatus,
} from './refillNotifier';
import { DEFAULT_TRAY_STATE, type TrayState } from './trayStateStore';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const RESET = '2026-10-08T00:00:00Z';
const RESET_MS = Date.parse(RESET);
const NEXT_RESET = '2026-10-15T00:00:00Z';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

interface Timer {
  fn: () => void;
  at: number;
  cleared: boolean;
}

function harness(initial: Partial<TrayState> = {}, opts: { status?: RefillStatus | null } = {}) {
  let state: TrayState = { ...DEFAULT_TRAY_STATE, ...initial };
  let now = T0;
  let focused = false;
  let status: RefillStatus | null =
    opts.status === undefined
      ? { userId: 'u1', cloud: true, over_limit: true, plan: 'free', resets_at: RESET }
      : opts.status;
  const timers: Timer[] = [];
  const clicks: Array<() => void> = [];
  const deps = {
    getState: () => state,
    updateState: async (fn: (s: TrayState) => TrayState) => {
      state = fn(state);
    },
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t: Timer = { fn, at: now + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      (h as Timer).cleared = true;
    },
    fetchStatus: vi.fn(async () => (status ? { ...status } : null)),
    isWindowFocused: () => focused,
    notify: vi.fn(async (_s: RefillStatus, onClick: () => void) => {
      clicks.push(onClick);
      return { lang: 'en', has_companion: true } as Record<string, unknown>;
    }),
    openApp: vi.fn(),
    capture: vi.fn(),
  } satisfies RefillNotifierDeps;
  const notifier = createRefillNotifier(deps);
  const live = (): Timer[] => timers.filter((t) => !t.cleared);
  return {
    deps,
    notifier,
    clicks,
    get state() {
      return state;
    },
    set state(s: TrayState) {
      state = s;
    },
    setStatus: (s: RefillStatus | null) => {
      status = s;
    },
    setFocused: (f: boolean) => {
      focused = f;
    },
    live,
    /** Move the clock and run every timer that comes due, in order. */
    advanceTo: async (ms: number) => {
      for (;;) {
        const due = live()
          .filter((t) => t.at <= ms)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.cleared = true;
        due.fn();
        await flush();
      }
      now = ms;
    },
  };
}

const refilled: RefillStatus = { userId: 'u1', cloud: true, over_limit: false, plan: 'free', resets_at: NEXT_RESET };

describe('recordWall / planRefill (pure)', () => {
  const base = { ...DEFAULT_TRAY_STATE, enabled: true };

  it('needs an account and a future reset time', () => {
    expect(recordWall(base, null, RESET, T0)).toBeNull();
    expect(recordWall(base, 'u1', null, T0)).toBeNull();
    expect(recordWall(base, 'u1', 'not a date', T0)).toBeNull();
    expect(recordWall(base, 'u1', '2026-10-01T00:00:00Z', T0)).toBeNull();
    expect(recordWall(base, 'u1', RESET, T0, 'free')?.wall).toEqual({ user_id: 'u1', resets_at: RESET, plan: 'free' });
  });

  it('does not re-record a reset that was already notified', () => {
    expect(recordWall({ ...base, notified_for: RESET }, 'u1', RESET, T0)).toBeNull();
  });

  it('plans nothing without a wall, and nothing while the setting is off', () => {
    expect(planRefill(base, T0)).toEqual({ kind: 'none' });
    const walled = recordWall({ ...base, enabled: false }, 'u1', RESET, T0)!;
    expect(planRefill(walled, T0)).toEqual({ kind: 'none' });
    expect(walled.wall).not.toBeNull(); // kept for when it is turned on
  });

  it('waits until the reset, caps the timer, fires late, drops stale or handled', () => {
    const walled = recordWall(base, 'u1', RESET, T0)!;
    expect(planRefill(walled, T0)).toEqual({ kind: 'wait', delayMs: RESET_MS - T0 });
    const far = recordWall(base, 'u1', '2026-12-31T00:00:00Z', T0)!;
    expect(planRefill(far, T0)).toEqual({ kind: 'wait', delayMs: MAX_TIMER_MS });
    expect(planRefill(walled, RESET_MS + 3_600_000)).toEqual({ kind: 'due', lateMs: 3_600_000 });
    expect(planRefill(walled, RESET_MS + DUE_WINDOW_MS + 1)).toEqual({ kind: 'drop' });
    expect(planRefill(markHandled(walled, RESET), RESET_MS)).toEqual({ kind: 'none' });
  });
});

describe('createRefillNotifier', () => {
  it('records nothing when the user never hit the wall', async () => {
    const h = harness({ enabled: true }, { status: { ...refilled, resets_at: RESET } });
    await h.notifier.noteWall();
    expect(h.state.wall).toBeNull();
    h.notifier.replan();
    expect(h.live()).toHaveLength(0);
  });

  it('records nothing for a local (BYOK) backend or a signed-out user', async () => {
    const h = harness({ enabled: true }, { status: { userId: 'u1', cloud: false, over_limit: true, plan: 'free', resets_at: RESET } });
    await h.notifier.noteWall();
    expect(h.state.wall).toBeNull();
    h.setStatus({ userId: null, cloud: true, over_limit: true, plan: 'free', resets_at: RESET });
    await h.notifier.noteWall();
    expect(h.state.wall).toBeNull();
  });

  it('notifies exactly once when the hit wall resets', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    expect(h.state.wall).toEqual({ user_id: 'u1', resets_at: RESET, plan: 'free' });
    expect(h.live().map((t) => t.at)).toEqual([RESET_MS]);

    h.setStatus(refilled);
    await h.advanceTo(RESET_MS);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
    expect(h.state.wall).toBeNull();
    expect(h.state.notified_for).toBe(RESET);
    expect(h.deps.capture).toHaveBeenCalledWith('refill_notification_shown', {
      lang: 'en',
      has_companion: true,
      plan: 'free',
      late_min: 0,
    });

    // A restart, a wake, or the same wall reported again: still once.
    h.notifier.replan();
    await h.advanceTo(RESET_MS + 86_400_000);
    h.setStatus({ userId: 'u1', cloud: true, over_limit: true, plan: 'free', resets_at: RESET });
    await h.notifier.noteWall();
    expect(h.state.wall).toBeNull();
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('noting the same wall twice arms one timer', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    await h.notifier.noteWall();
    expect(h.live()).toHaveLength(1);
  });

  it('recomputes the timer from the stored reset time on start', async () => {
    const stored = { enabled: true, wall: { user_id: 'u1', resets_at: RESET, plan: 'free' as const } };
    const h = harness(stored);
    h.notifier.replan(); // what initTray does at boot
    expect(h.live().map((t) => t.at)).toEqual([RESET_MS]);
  });

  it('fires on start when the reset passed while Sei was not running', async () => {
    const h = harness({ enabled: true, wall: { user_id: 'u1', resets_at: RESET } }, { status: refilled });
    await h.advanceTo(RESET_MS + 2 * 3_600_000); // Sei was off; no timers yet
    h.notifier.replan();
    await flush();
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
    expect(h.deps.capture).toHaveBeenCalledWith('refill_notification_shown', expect.objectContaining({ late_min: 120 }));
  });

  it('drops a reset older than the due window without notifying', async () => {
    const h = harness({ enabled: true, wall: { user_id: 'u1', resets_at: RESET } }, { status: refilled });
    await h.advanceTo(RESET_MS + DUE_WINDOW_MS + 60_000);
    h.notifier.replan();
    await flush();
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.state.wall).toBeNull();
  });

  it('is a no-op while the setting is off, and picks the wall up when turned on', async () => {
    const h = harness({ enabled: false });
    await h.notifier.noteWall(); // the wall is recorded regardless
    expect(h.state.wall).not.toBeNull();
    expect(h.live()).toHaveLength(0);
    h.setStatus(refilled);
    await h.advanceTo(RESET_MS + 60_000);
    expect(h.deps.notify).not.toHaveBeenCalled();

    h.state = { ...h.state, enabled: true };
    h.notifier.replan();
    await flush();
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the setting is turned off before the reset', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.state = { ...h.state, enabled: false };
    h.notifier.replan();
    expect(h.live()).toHaveLength(0);
    h.setStatus(refilled);
    await h.advanceTo(RESET_MS + 60_000);
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it('retries while the server has not rolled the week over', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    await h.advanceTo(RESET_MS); // still over_limit with the same resets_at
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.live().map((t) => t.at)).toEqual([RESET_MS + RETRY_MS]);
    h.setStatus(refilled);
    await h.advanceTo(RESET_MS + RETRY_MS);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('skips a reset when the account is on the wall again in the new week', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.setStatus({ userId: 'u1', cloud: true, over_limit: true, plan: 'free', resets_at: NEXT_RESET });
    await h.advanceTo(RESET_MS);
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.state.notified_for).toBe(RESET);
  });

  it('gives up after repeated failed snapshot reads', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.setStatus(null);
    await h.advanceTo(RESET_MS + RETRY_MS * (MAX_ATTEMPTS + 2));
    expect(h.deps.fetchStatus).toHaveBeenCalledTimes(1 + MAX_ATTEMPTS);
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.state.wall).toBeNull();
    expect(h.live()).toHaveLength(0);
  });

  it('holds the wall when another account is signed in', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.setStatus({ ...refilled, userId: 'u2' });
    await h.advanceTo(RESET_MS);
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.state.wall?.user_id).toBe('u1');
    expect(h.state.notified_for).toBeNull();
  });

  it('skips the notification when the window is focused', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.setStatus(refilled);
    h.setFocused(true);
    await h.advanceTo(RESET_MS);
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.state.notified_for).toBe(RESET);
  });

  it('skips the notification after a switch to a local backend', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.setStatus({ ...refilled, cloud: false });
    await h.advanceTo(RESET_MS);
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.state.wall).toBeNull();
  });

  it('a click opens Sei and is captured', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.setStatus(refilled);
    await h.advanceTo(RESET_MS);
    expect(h.clicks).toHaveLength(1);
    h.clicks[0]();
    expect(h.deps.openApp).toHaveBeenCalledTimes(1);
    expect(h.deps.capture).toHaveBeenCalledWith('refill_notification_clicked', { plan: 'free' });
  });

  it('records no shown event when the platform cannot show a notification', async () => {
    const h = harness({ enabled: true });
    h.deps.notify.mockResolvedValueOnce(null as unknown as Record<string, unknown>);
    await h.notifier.noteWall();
    h.setStatus(refilled);
    await h.advanceTo(RESET_MS);
    expect(h.deps.capture).not.toHaveBeenCalledWith('refill_notification_shown', expect.anything());
    expect(h.state.notified_for).toBe(RESET);
  });

  it('dispose clears the timer', async () => {
    const h = harness({ enabled: true });
    await h.notifier.noteWall();
    h.notifier.dispose();
    expect(h.live()).toHaveLength(0);
  });
});
