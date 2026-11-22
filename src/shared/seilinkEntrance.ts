/**
 * WorldLink entrance (261119, product call (261119)): her arrival on the
 * desktop, apart from the one-time first-link intro.
 *
 * Before, the only entrance was inside the intro, which plays once per
 * account, and the intro was the only thing that waited for her Anima face
 * set. Every later move-in put her straight onto the wallpaper, often as her
 * picture with the oval fade because the bake had not finished. Now the
 * wallpaper itself (the host page) brings her in, every time she moves in:
 *
 *  - wait:  her look is still being made (an Anima bake or its download).
 *           Her place shows one quiet status line in the intro's style
 *           ("Inviting {name}â€¦"); a click on it lets her in now.
 *  - hold:  her look is ready but the app has not stepped aside yet (a move-in
 *           from the app): nothing in her place, so the entrance is seen.
 *  - enter: she comes in (the intro's arrival: a fade with a slight rise and
 *           a blur clearing).
 *  - show:  she is just there (a restore at app start with her look ready, a
 *           host restart, or the first-link intro already showed her coming in).
 *
 * Main decides (main/seilink/host/arrival.ts) from the trigger, her look and
 * whether the app stepped aside; the page draws it
 * (components/seilink/host/HostArrival.tsx). Shared by both, pure.
 */
import type { AnimaShownKind, AnimaStage, AnimaUiState } from './anima';
import { ANIMA_SHOWN_KINDS } from './anima';

/**
 * How long a first bake is expected to take (the intro spreads its middle
 * lines over it). Real bakes took about 130 to 350 s until 261119; the fast
 * bake (no QC, batched render) measured 49 s warm and 63 s cold, plus up to
 * 4 s of polling and the pack download.
 */
export const EXPECTED_LINK_MS = 75_000;
/**
 * The intro stops waiting for her look after this long: with the bake still
 * running it hands her arrival over to the desktop (no failure line); the
 * desktop's waiting line turns quieter but keeps waiting. Lower it with
 * EXPECTED_LINK_MS.
 */
export const LINK_TIMEOUT_MS = 240_000;

/** After a move-in from the app, she waits this long for the app to step aside before coming in anyway. */
export const REVEAL_WAIT_MS = 12_000;

/**
 * What brought her onto the desktop: the first-link intro (first_link), a
 * move-in from the app (move_in), a move-in that replaced someone (switch),
 * or the saved move-in brought back at app start or after an account switch
 * (restore).
 */
export const ENTRANCE_TRIGGERS = ['first_link', 'move_in', 'switch', 'restore'] as const;
export type EntranceTrigger = (typeof ENTRANCE_TRIGGERS)[number];

export function isEntranceTrigger(v: unknown): v is EntranceTrigger {
  return typeof v === 'string' && (ENTRANCE_TRIGGERS as readonly string[]).includes(v);
}

export const ARRIVAL_MODES = ['wait', 'hold', 'enter', 'show'] as const;
export type ArrivalMode = (typeof ARRIVAL_MODES)[number];

/** Main -> the wallpaper page: what to do with her now. */
export interface SeilinkArrival {
  mode: ArrivalMode;
  trigger: EntranceTrigger;
  /** wait only: the wait passed LINK_TIMEOUT_MS; the line stays, dimmer. */
  quiet?: boolean;
}

export function isArrivalMode(v: unknown): v is ArrivalMode {
  return typeof v === 'string' && (ARRIVAL_MODES as readonly string[]).includes(v);
}

/** Checked again at every hop (the pipe, the page): closed shapes only. */
export function sanitizeArrival(v: unknown): SeilinkArrival | null {
  const a = (v ?? {}) as Record<string, unknown>;
  if (!isArrivalMode(a.mode) || !isEntranceTrigger(a.trigger)) return null;
  return a.mode === 'wait' && a.quiet === true ? { mode: 'wait', trigger: a.trigger, quiet: true } : { mode: a.mode, trigger: a.trigger };
}

/** Anima stages that mean her face set is on its way. */
const PENDING_STAGES: readonly AnimaStage[] = ['checking', 'requesting', 'queued', 'running', 'downloading'];

/**
 * Is her look still on its way? Not when a face set is already on disk (a
 * re-check of an older pack runs behind it), or she plays her own imported
 * model. `unavailable` while the client is still busy is the cloud cut-out
 * downloading (the stage is set before it lands).
 */
export function lookPending(s: { state?: AnimaUiState; stage?: AnimaStage } | null, opts: { inFlight?: boolean; imported?: boolean } = {}): boolean {
  if (opts.imported || !s || s.state === 'ready') return false;
  if (s.stage && PENDING_STAGES.includes(s.stage)) return true;
  return s.stage === 'unavailable' && opts.inFlight === true;
}

/**
 * How her look stood when she came in (seilink_entrance.look):
 *  - ready: there from the start (her face set on disk), no wait;
 *  - arrived: she waited and her face set landed;
 *  - unavailable: no face set will come (the cloud cut-out or her picture);
 *  - failed / offline: the bake failed or there was no network (her fallback look);
 *  - skipped: a click on the waiting line let her in before it landed;
 *  - imported: her own model;
 *  - waiting: the session ended while she still waited (action `ended`).
 */
export const ENTRANCE_LOOKS = ['ready', 'arrived', 'unavailable', 'failed', 'offline', 'skipped', 'imported', 'waiting'] as const;
export type EntranceLook = (typeof ENTRANCE_LOOKS)[number];

/** Her look's class from the anima status once it is no longer pending (or imported). */
export function settledLook(s: { state?: AnimaUiState; stage?: AnimaStage } | null, opts: { imported?: boolean; waited?: boolean } = {}): EntranceLook {
  if (opts.imported) return 'imported';
  if (s?.state === 'ready' || s?.stage === 'ready') return opts.waited ? 'arrived' : 'ready';
  if (s?.stage === 'offline') return 'offline';
  if (s?.stage === 'failed') return 'failed';
  return 'unavailable';
}

/**
 * What the page does with her (main's decision, every input known now):
 *  - she already came in this session: show;
 *  - her look is on its way (and nobody clicked the line): wait;
 *  - a restore: show, unless she had to wait (then her look arriving is her arrival: enter);
 *  - the first link: the intro shows her coming in while it covers the desktop, so show; once the
 *    app has stepped aside (the intro handed over with her bake still running): enter;
 *  - a move-in or a switch: hold until the app has stepped aside, then enter.
 */
export function arrivalMode(i: { trigger: EntranceTrigger; arrived: boolean; pending: boolean; skipped: boolean; revealed: boolean; waited: boolean }): ArrivalMode {
  if (i.arrived) return 'show';
  if (i.pending && !i.skipped) return 'wait';
  if (i.trigger === 'restore') return i.waited ? 'enter' : 'show';
  if (i.trigger === 'first_link') return i.revealed ? 'enter' : 'show';
  return i.revealed ? 'enter' : 'hold';
}

// â”€â”€ Analytics (shape only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * seilink_entrance, once per session (main/seilink/host/arrival.ts):
 * {character_id, trigger, action, look, waited, wait_ms, timed_out, skipped,
 * avatar_kind?, reduced_motion?}. action: played (her entrance ran), still
 * (she was just there), ended (the session ended before she came in).
 * wait_ms: from the waiting line coming up to her look landing (0 without a
 * wait). timed_out: the wait passed LINK_TIMEOUT_MS. Never text.
 */
export const SEILINK_ENTRANCE_EVENT = 'seilink_entrance';
export const ENTRANCE_ACTIONS = ['played', 'still', 'ended'] as const;
export type EntranceAction = (typeof ENTRANCE_ACTIONS)[number];

/** The page -> main report once she is in (FromHost `arrived`), checked in main. */
export function sanitizeArrivedReport(v: unknown): { played: boolean; reduced: boolean; kind: AnimaShownKind | null } {
  const a = (v ?? {}) as Record<string, unknown>;
  const kind = typeof a.kind === 'string' && (ANIMA_SHOWN_KINDS as readonly string[]).includes(a.kind) ? (a.kind as AnimaShownKind) : null;
  return { played: a.played === true, reduced: a.reduced === true, kind };
}




