/**
 * "Free play is back" OS notification (261005, retention fix 2b).
 *
 * New users spend the weekly free allowance in their first session and
 * nothing brings them back when it refills (retention analysis 261005). With
 * the menu bar / tray setting on, Sei stays running after the window closes,
 * so it can post one OS notification, in the active companion's voice, at
 * the moment the allowance resets.
 *
 * Rules (each one is a unit test in refillNotifier.test.ts):
 *   - Only for a wall the user actually HIT. main records the wall
 *     (account id + CreditsStatus.resets_at) on every 'depleted' hard stop,
 *     after confirming over_limit with a fresh my_plan read. Someone who never
 *     ran out is never notified.
 *   - At most once per reset: `notified_for` remembers the reset already
 *     handled, and the wall is dropped once it fires (or is skipped).
 *   - Only while the tray setting is on. Recording the wall does not depend
 *     on the setting (the wall prompt turns it on AFTER the wall), firing does.
 *   - The timer is recomputed from the stored reset time on every start, on
 *     a setting change, on a new wall and after the machine wakes, so a quit,
 *     a reboot or a sleep never loses it. A reset that passed while Sei was
 *     not running fires on the next start (a login launch is the main case),
 *     unless it is older than DUE_WINDOW_MS.
 *   - At fire time a fresh snapshot must show the SAME account, still in
 *     cloud mode and off the wall. Still on the wall with the same reset time
 *     means the server has not rolled over yet: retry shortly. An account
 *     switch keeps the wall for that account's next start.
 *   - When the window is open and focused the player is already here (and
 *     the in-app "free play is back" banner covers it): mark it handled
 *     without a notification.
 *
 * Everything with side effects comes in through `deps`, so the scheduling is
 * testable with fake timers and no Electron.
 */
import type { TrayState } from './trayStateStore';

/** setTimeout's ceiling (about 24.8 days); a longer wait re-plans on wake-up. */
export const MAX_TIMER_MS = 2_147_483_647;
/** A reset older than this when Sei starts is old news (the next one is a week out). */
export const DUE_WINDOW_MS = 6 * 86_400_000;
/** Server not rolled over yet, or the snapshot read failed: try again after this. */
export const RETRY_MS = 5 * 60_000;
/** Give up on a reset after this many failed attempts (about 2 hours). */
export const MAX_ATTEMPTS = 24;

/** The fresh account snapshot the notifier needs. null = the read failed. */
export interface RefillStatus {
  /** Signed-in account, null when signed out. */
  userId: string | null;
  cloud: boolean;
  over_limit: boolean;
  plan: 'free' | 'quest' | 'party';
  resets_at: string;
}

export type RefillPlan =
  | { kind: 'none' }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'due'; lateMs: number }
  /** The stored wall can never fire (bad date, already handled, too old): drop it. */
  | { kind: 'drop' };

/**
 * Record a wall the user just hit. Returns the new state, or null when
 * nothing changes (no account, no usable reset time, same wall again, or a
 * reset that was already notified).
 */
export function recordWall(
  state: TrayState,
  userId: string | null | undefined,
  resetsAt: string | null | undefined,
  nowMs: number,
  plan?: 'free' | 'quest' | 'party',
): TrayState | null {
  if (!userId || !resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  if (state.notified_for === resetsAt) return null;
  if (state.wall && state.wall.user_id === userId && state.wall.resets_at === resetsAt) return null;
  return { ...state, wall: { user_id: userId, resets_at: resetsAt, ...(plan ? { plan } : {}) } };
}

/** What to do about the stored wall right now. Pure. */
export function planRefill(state: TrayState, nowMs: number): RefillPlan {
  if (!state.wall) return { kind: 'none' };
  const at = Date.parse(state.wall.resets_at);
  if (!Number.isFinite(at) || state.notified_for === state.wall.resets_at) return { kind: 'drop' };
  // Setting off: keep the wall (turning it on later in the week still works),
  // but schedule nothing.
  if (!state.enabled) return { kind: 'none' };
  if (at > nowMs) return { kind: 'wait', delayMs: Math.min(at - nowMs, MAX_TIMER_MS) };
  if (nowMs - at > DUE_WINDOW_MS) return { kind: 'drop' };
  return { kind: 'due', lateMs: nowMs - at };
}

/** State after a reset was handled (notified or deliberately skipped). */
export function markHandled(state: TrayState, resetsAt: string): TrayState {
  return {
    ...state,
    wall: state.wall && state.wall.resets_at === resetsAt ? null : state.wall,
    notified_for: resetsAt,
  };
}

export interface RefillNotifierDeps {
  getState: () => TrayState;
  updateState: (fn: (s: TrayState) => TrayState) => Promise<unknown>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Fresh snapshot (my_plan + session). Resolve null when the read fails. */
  fetchStatus: () => Promise<RefillStatus | null>;
  /** True when the main window is visible and focused. */
  isWindowFocused: () => boolean;
  /**
   * Post the notification. Resolves the analytics props it used (language,
   * plan), or null when the platform cannot show one.
   */
  notify: (status: RefillStatus, onClick: () => void) => Promise<Record<string, unknown> | null>;
  /** Open (show or restore) the main window. */
  openApp: () => void;
  capture: (event: string, props?: Record<string, unknown>) => void;
  log?: (msg: string) => void;
}

export interface RefillNotifier {
  /** Re-plan from the stored state (start, setting change, wake). */
  replan: () => void;
  /** A 'depleted' hard stop happened: confirm and remember the wall. */
  noteWall: () => Promise<void>;
  dispose: () => void;
}

export function createRefillNotifier(deps: RefillNotifierDeps): RefillNotifier {
  let timer: unknown = null;
  let firing = false;
  let disposed = false;
  // Failed / not-yet-rolled attempts for the reset currently due.
  let attempts = 0;
  let attemptsFor: string | null = null;
  const log = deps.log ?? (() => {});

  const clear = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const arm = (ms: number): void => {
    clear();
    if (disposed) return;
    timer = deps.setTimer(() => {
      timer = null;
      replan();
    }, Math.max(0, ms));
  };

  const handled = async (resetsAt: string): Promise<void> => {
    await deps.updateState((s) => markHandled(s, resetsAt));
  };

  const fire = async (resetsAt: string, wallUser: string, lateMs: number): Promise<void> => {
    if (firing) return;
    firing = true;
    try {
      if (attemptsFor !== resetsAt) {
        attemptsFor = resetsAt;
        attempts = 0;
      }
      attempts += 1;
      const status = await deps.fetchStatus();
      // Re-read: the setting may have flipped or the wall changed during the read.
      const now = deps.getState();
      if (disposed || !now.enabled || !now.wall || now.wall.resets_at !== resetsAt) return;

      if (!status) {
        if (attempts >= MAX_ATTEMPTS) {
          log(`refill notify: snapshot kept failing, giving up on ${resetsAt}`);
          await handled(resetsAt);
        } else {
          arm(RETRY_MS);
        }
        return;
      }
      if (status.userId !== wallUser) {
        // Another account (or signed out). Keep the wall for its owner's next
        // start; nothing to do in this run.
        log('refill notify: different account signed in, holding');
        return;
      }
      if (!status.cloud) {
        await handled(resetsAt);
        return;
      }
      if (status.over_limit) {
        if (status.resets_at === resetsAt && attempts < MAX_ATTEMPTS) {
          // The server has not rolled the week over yet.
          arm(RETRY_MS);
        } else {
          // On the wall again in a new week: "free play is back" would be wrong.
          await handled(resetsAt);
        }
        return;
      }
      if (deps.isWindowFocused()) {
        // The player is already here; the in-app banner says it.
        await handled(resetsAt);
        return;
      }
      const props = await deps.notify(status, () => {
        deps.capture('refill_notification_clicked', { plan: status.plan });
        deps.openApp();
      });
      await handled(resetsAt);
      if (props) {
        deps.capture('refill_notification_shown', {
          ...props,
          plan: status.plan,
          late_min: Math.round(lateMs / 60_000),
        });
      }
    } catch (err) {
      log(`refill notify failed: ${(err as Error).message}`);
    } finally {
      firing = false;
    }
  };

  function replan(): void {
    if (disposed) return;
    clear();
    const state = deps.getState();
    const plan = planRefill(state, deps.now());
    switch (plan.kind) {
      case 'none':
        return;
      case 'drop':
        if (state.wall) void deps.updateState((s) => (s.wall && s.wall.resets_at === state.wall?.resets_at ? { ...s, wall: null } : s));
        return;
      case 'wait':
        arm(plan.delayMs);
        return;
      case 'due':
        if (state.wall) void fire(state.wall.resets_at, state.wall.user_id, plan.lateMs);
        return;
    }
  }

  const noteWall = async (): Promise<void> => {
    try {
      const status = await deps.fetchStatus();
      if (!status || !status.cloud || !status.over_limit || !status.userId) return;
      const next = recordWall(deps.getState(), status.userId, status.resets_at, deps.now(), status.plan);
      if (!next) return;
      await deps.updateState((s) => recordWall(s, status.userId, status.resets_at, deps.now(), status.plan) ?? s);
      replan();
    } catch (err) {
      log(`refill notify: wall record failed: ${(err as Error).message}`);
    }
  };

  return {
    replan,
    noteWall,
    dispose: () => {
      disposed = true;
      clear();
    },
  };
}
