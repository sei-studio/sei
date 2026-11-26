/**
 * Why a voice call or a backseat (screen-share) session ended (261023), as
 * analytics props on `voice_call_ended` and `backseat_ended`.
 *
 * Both events used to carry no reason (backseat only had 'app_quit' and
 * 'account_switch' from main), so a 48-second share that ended on a timed-out
 * first turn looked the same as a player pressing Stop, and a share the OS
 * ended looked the same as one the player replaced with another window. 746
 * of 794 backseat sessions in the 30 days to 261023 had no reason. The same
 * gap hid why 49 of 94 subscriber calls lasted under a minute.
 *
 * Shape only: a fixed token, optionally with a short class suffix
 * ("capture_failed:permission"), never error text. Pure, so the mapping is
 * pinned in callEndReasons.test.ts.
 */

/**
 * Reasons the RENDERER reports for a call it hung up. Main validates against
 * this list (the IPC schema), so a typo can never reach analytics.
 */
export const CALL_END_REASONS = [
  /** The hang-up button. */
  'user_hangup',
  /** The companion hung up (end_call), solo call or the last one leaving. */
  'companion_hangup',
  /** The 10-minute inactivity watchdog ended it after its prompt. */
  'inactivity',
  /** The usage limit hard stop (402) ended it. */
  'credits_depleted',
  /** The renderer reset its surfaces (sign-out, account change seen late). */
  'scope_reset',
  /** Dev only: a hot reload tore the voice module down. */
  'dev_reload',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/**
 * Reasons MAIN stamps on calls it closed itself, because no renderer report
 * is coming (the renderer is gone) or would arrive too late (account switch).
 */
export const MAIN_CALL_END_REASONS = ['app_quit', 'account_switch', 'window_closed', 'renderer_gone', 'renderer_reload'] as const;
export type MainCallEndReason = (typeof MAIN_CALL_END_REASONS)[number];

/** Backseat end reasons the renderer may send with backseat:end. */
export const BACKSEAT_END_REASONS = [
  /** The share toggle (call controls) or the overlay's stop. */
  'user_stop',
  /** The hang-up button, which takes the share with it. */
  'user_hangup',
  /** The player picked a different game tile while sharing. */
  'game_switch',
  /** The cross-launch gate ended the share to start another game. */
  'game_launch',
  /** The OS ended the shared track and it could not be picked up again. */
  'capture_lost',
  /** macOS ended the track while the window is still there: the system
   *  "Stop sharing" control, which is the player's choice. */
  'capture_stopped_by_os',
  /** Capture never came up after main accepted the session. */
  'capture_failed',
  /** The account changed while the share was starting. */
  'scope_changed',
  /** The auto-share watch was stopped while its share was starting. */
  'watch_stopped',
  /** The companion left the call while sharing. */
  'companion_left',
] as const;
export type BackseatEndReason = (typeof BACKSEAT_END_REASONS)[number];

/** The `call_ended:<cause>` family: the call ended for a non-button reason
 *  and took the share with it. */
export type BackseatCallEndedReason = `call_ended:${CallEndReason}`;

/** Every token the renderer may put on backseat:end. */
export type BackseatEndReasonArg = BackseatEndReason | BackseatCallEndedReason | `capture_failed:${CaptureErrorClass}`;

/** What started a share (backseat_started.trigger). */
export const BACKSEAT_START_TRIGGERS = [
  /** The player picked a window or screen in the share picker. */
  'picker',
  /** A share armed before the call connected, started once it did. */
  'pending',
  /** The auto-share watch found the picked game's window. */
  'auto_share',
  /** The auto-share watch found the window again after it went away. */
  'auto_resume',
] as const;
export type BackseatStartTrigger = (typeof BACKSEAT_START_TRIGGERS)[number];

/** Capture failure classes (getUserMedia errors are DOMExceptions by name). */
export type CaptureErrorClass = 'permission' | 'not_found' | 'busy' | 'no_video' | 'other';

const BACKSEAT_REASON_SET: ReadonlySet<string> = new Set<string>(BACKSEAT_END_REASONS);
const CALL_REASON_SET: ReadonlySet<string> = new Set<string>(CALL_END_REASONS);
const CAPTURE_CLASSES: ReadonlySet<string> = new Set<string>(['permission', 'not_found', 'busy', 'no_video', 'other']);

export function isCallEndReason(r: unknown): r is CallEndReason {
  return typeof r === 'string' && CALL_REASON_SET.has(r);
}

/**
 * The reason a share ends with when its call ends. The hang-up button is
 * named for what the player did; every other call end is `call_ended:<why>`,
 * so a share lost to the inactivity watchdog or a companion hang-up reads as
 * that and not as the player stopping it.
 */
export function backseatReasonForCallEnd(callReason: CallEndReason): BackseatEndReasonArg {
  return callReason === 'user_hangup' ? 'user_hangup' : `call_ended:${callReason}`;
}

/**
 * Validate a backseat end reason from the renderer. Unknown or missing input
 * becomes 'unspecified' rather than being dropped, so a path that forgot to
 * pass one shows up in the data instead of hiding in "no reason".
 */
export function normalizeBackseatEndReason(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 64) return 'unspecified';
  if (BACKSEAT_REASON_SET.has(raw)) return raw;
  const m = /^(call_ended|capture_failed):([a-z_]+)$/.exec(raw);
  if (m) {
    if (m[1] === 'call_ended' && CALL_REASON_SET.has(m[2])) return raw;
    if (m[1] === 'capture_failed' && CAPTURE_CLASSES.has(m[2])) return raw;
  }
  return 'unspecified';
}

/**
 * Whether an end reason means the player chose to end the session. Only these
 * run the player-end "next time" check (playerEndNextStep, an LLM call): a
 * window that closed or a share that failed is not the player leaving.
 */
export function isPlayerEndedReason(reason: string): boolean {
  return reason === 'user_stop' || reason === 'user_hangup';
}

/** Classify a capture start failure by its DOMException name. */
export function captureErrorClass(err: unknown): CaptureErrorClass {
  const name = (err as { name?: unknown } | null)?.name;
  const msg = String((err as { message?: unknown } | null)?.message ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  if (/produced no video/i.test(msg)) return 'no_video';
  return 'other';
}

/**
 * 261123: the shape of a capture start that failed, for backseat_ended. The
 * renderer reports it next to a `capture_failed:<class>` reason; main keeps
 * only known values (normalizeCaptureFailDetail), so nothing free-form ever
 * reaches analytics.
 *   source_kind  what the player picked
 *   first_class  why the FIRST attempt failed (the later ones are retries)
 *   retry        'none' (not retried: not a busy failure) or 'failed'
 *   minimized    whether the picked window was minimized (Windows only)
 */
export interface CaptureFailDetail {
  source_kind: 'window' | 'screen';
  first_class: CaptureErrorClass;
  retry: 'none' | 'relaxed_ok' | 'failed';
  minimized: 'yes' | 'no' | 'unknown';
}

const FAIL_DETAIL_VALUES: Record<keyof CaptureFailDetail, ReadonlySet<string>> = {
  source_kind: new Set(['window', 'screen']),
  first_class: CAPTURE_CLASSES,
  retry: new Set(['none', 'relaxed_ok', 'failed']),
  minimized: new Set(['yes', 'no', 'unknown']),
};

/** Validate a failure detail from the renderer into backseat_ended props
 *  (`capture_<key>`). Unknown keys and values are dropped. */
export function normalizeCaptureFailDetail(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, allowed] of Object.entries(FAIL_DETAIL_VALUES)) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && allowed.has(v)) out[`capture_${k}`] = v;
  }
  return out;
}
