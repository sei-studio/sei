/**
 * SeiLink first-link analytics (261105, T337), shape only: the cinematic,
 * the guide's SeiLink tour and the SeiLink entry points. The renderer sends
 * them through `sei.track`; main's analytics:track handler rebuilds the props
 * with `sanitizeSeilinkIntroTrack`, so only closed enums, small counts,
 * buckets and the character id can leave the machine.
 *
 *  - seilink_intro {action: shown|completed|skipped|aborted, trigger, style,
 *    mood, end_on, reduced_motion, beat (where it ended), duration_bucket, host}
 *  - seilink_tour {action: offered|sure|not_now|completed|dropped, audience,
 *    offer_n, snoozed (not_now), step (dropped)}
 *  - seilink_entry {source: button|gear|tour|dock, action}
 *  - seilink_setup {action: started|resumed|finished|abandoned, step, surface,
 *    plain, steps_completed, steps_skipped, steps_total, ms_open, opened_from}
 *  - seilink_setup_step {step, action: shown|completed|skipped|back, changed,
 *    resumed, index}
 *  - seilink_intro_link (261106 v6, the WorldLink status lines) {outcome:
 *    success|failed|abandoned, failure, trigger, reduced_motion, lines_shown,
 *    line_1_ms .. line_9_ms, total_ms, slowest (milestone), slowest_ms,
 *    anima_start}. No character id, no text.
 *
 * Event table: docs/agents/seilink-analytics.md.
 */

export const SEILINK_INTRO_EVENT = 'seilink_intro';
export const SEILINK_TOUR_EVENT = 'seilink_tour';
export const SEILINK_ENTRY_EVENT = 'seilink_entry';

/** shown on start; completed = played to the end; skipped = the person skipped; aborted = the link failed (261106 v6: the host or her look), closed from the failure line. */
export const INTRO_ACTIONS = ['shown', 'completed', 'skipped', 'aborted'] as const;
export type IntroAction = (typeof INTRO_ACTIONS)[number];

/** first_link = her first successful move-in on this account; replay = "Replay SeiLink intro". */
export const INTRO_TRIGGERS = ['first_link', 'replay'] as const;
export type IntroTrigger = (typeof INTRO_TRIGGERS)[number];

/**
 * The visual treatment: the aurora (swaying curtains of soft light). 261106
 * had `bloom` and `tide` beside it; the aurora was kept and they are gone.
 */
export const INTRO_STYLES = ['aurora'] as const;
export type IntroStyle = (typeof INTRO_STYLES)[number];

/**
 * The aurora's colour mood. 261106 had three space moods (accretion, nebula,
 * eclipse); eclipse was picked (261106 v4) and it is the only one. The
 * prop stays on the event so the shape is unchanged.
 */
export const INTRO_MOODS = ['eclipse'] as const;
export type IntroMood = (typeof INTRO_MOODS)[number];

/** What the app sends: the one style and mood. */
export const INTRO_STYLE: IntroStyle = 'aurora';
export const INTRO_MOOD: IntroMood = 'eclipse';

/** What the intro settles into: the plain background she spawns on (black / white with the OS theme), or a room she has. */
export const INTRO_END_ON = ['plain_dark', 'plain_light', 'room'] as const;
export type IntroEndOn = (typeof INTRO_END_ON)[number];

/** The beats, in order: open the tunnel and build the room, link her, port to the desktop, linked. */
export const INTRO_BEATS = ['tunnel', 'link', 'port', 'linked'] as const;
export type IntroBeat = (typeof INTRO_BEATS)[number];

/** How the host start stood when the intro ended. */
export const INTRO_HOST = ['ok', 'failed', 'pending', 'none'] as const;
export type IntroHost = (typeof INTRO_HOST)[number];

export const DURATION_BUCKETS = ['lt3s', '3_6s', '6_9s', '9_12s', '12_20s', 'gt20s'] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export function introDurationBucket(ms: number): DurationBucket {
  const s = Number.isFinite(ms) ? Math.max(0, ms) / 1000 : 0;
  if (s < 3) return 'lt3s';
  if (s < 6) return '3_6s';
  if (s < 9) return '6_9s';
  if (s < 12) return '9_12s';
  if (s < 20) return '12_20s';
  return 'gt20s';
}

export const TOUR_ACTIONS = ['offered', 'sure', 'not_now', 'completed', 'dropped'] as const;
export type TourAction = (typeof TOUR_ACTIONS)[number];

/** new = onboarded on a build with the tour; existing = used Sei before it. */
export const TOUR_AUDIENCES = ['new', 'existing'] as const;
export type TourAudience = (typeof TOUR_AUDIENCES)[number];

/** The tour's steps (the guide's lines), for `dropped`. */
export const TOUR_STEPS = ['offer', 'button', 'room'] as const;
export type TourStepName = (typeof TOUR_STEPS)[number];

/** Where a SeiLink flow was opened from. */
export const ENTRY_SOURCES = ['button', 'gear', 'tour', 'dock'] as const;
export type SeilinkEntrySource = (typeof ENTRY_SOURCES)[number];

/** What the entry did: the move-in sheet, a direct move-in, the editor, a move-out, the intro replay. */
export const ENTRY_ACTIONS = ['sheet', 'move_in', 'edit', 'move_out', 'replay_intro'] as const;
export type EntryAction = (typeof ENTRY_ACTIONS)[number];

type Scalar = string | number | boolean | null;

// ── The WorldLink status lines (261106 v6) ────────────────────────────────

/** One per intro: how the status lines went (lib/seilink/worldLink.ts linkReport). */
export const SEILINK_INTRO_LINK_EVENT = 'seilink_intro_link';

/**
 * The pipeline milestones the lines wait on, in order (host is the host
 * start's answer, independent of the rest): the Anima request sent, its
 * answer, the bake running, the bake done, her face set installed.
 */
export const LINK_MILESTONES = ['sent', 'answered', 'running', 'baked', 'installed', 'host'] as const;
export type LinkMilestone = (typeof LINK_MILESTONES)[number];

/** Why the link failed: no network, a request or install error, the 3.5 min timeout, the bake gave up, the host start failed. */
export const LINK_FAILURES = ['offline', 'network', 'timeout', 'bake_failed', 'install', 'http', 'auth', 'host', 'error'] as const;
export type LinkFailure = (typeof LINK_FAILURES)[number];

/** success = the success line landed; failed = the failure line showed; abandoned = skipped or closed before either. */
export const LINK_OUTCOMES = ['success', 'failed', 'abandoned'] as const;
export type LinkOutcome = (typeof LINK_OUTCOMES)[number];

/** The number of status lines. */
export const LINK_LINE_COUNT = 9;

/** Where her bake stood when the intro started (shared/anima.ts AnimaStage), or none (a replay, no IPC). */
export const LINK_ANIMA_START = ['checking', 'requesting', 'queued', 'running', 'downloading', 'ready', 'unavailable', 'offline', 'failed', 'none'] as const;
export type LinkAnimaStart = (typeof LINK_ANIMA_START)[number];

/** The longest a timing prop can say (ms). */
const LINK_MS_MAX = 30 * 60_000;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function charId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

function small(v: unknown, max: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : undefined;
}

// ── The guided setup (261106, first-link v3) ──────────────────────────────

/** One per setup run: started, resumed (a run left unfinished before), finished (Done), abandoned (closed before Done). */
export const SEILINK_SETUP_EVENT = 'seilink_setup';
/** One per step action. */
export const SEILINK_SETUP_STEP_EVENT = 'seilink_setup_step';

export const SETUP_ACTIONS = ['started', 'resumed', 'finished', 'abandoned'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/** The steps (shared/seilinkRoom.ts ROOM_SETUP_STEPS, repeated here so this file has no room import). */
export const SETUP_STEP_NAMES = ['room', 'colours', 'furniture', 'extras'] as const;
export type SetupStepName = (typeof SETUP_STEP_NAMES)[number];

/** shown = the step came up; completed = Next (or Done); skipped = Skip; back = Back to the step before. */
export const SETUP_STEP_ACTIONS = ['shown', 'completed', 'skipped', 'back'] as const;
export type SetupStepAction = (typeof SETUP_STEP_ACTIONS)[number];

/** Where the setup editor sits: on the desktop stage or in the app window. */
export const SETUP_SURFACES = ['desktop', 'app'] as const;

/** seilinkTelemetry.EDITOR_OPENED_FROM (that file imports this one, so the list is repeated; a test keeps them equal). */
export const SETUP_OPENED_FROM = ['gear', 'dock', 'move_in', 'button', 'tour', 'offer', 'other'] as const;

export function isSeilinkIntroEvent(event: string): boolean {
  return (
    event === SEILINK_INTRO_EVENT ||
    event === SEILINK_TOUR_EVENT ||
    event === SEILINK_ENTRY_EVENT ||
    event === SEILINK_SETUP_EVENT ||
    event === SEILINK_SETUP_STEP_EVENT ||
    event === SEILINK_INTRO_LINK_EVENT
  );
}

/** Rebuild a renderer-sent first-link event's props from the closed shapes (main's track handler). */
export function sanitizeSeilinkIntroTrack(event: string, raw: Record<string, unknown> | undefined): Record<string, Scalar> {
  const p = raw ?? {};
  if (event === SEILINK_INTRO_EVENT) {
    const out: Record<string, Scalar> = {
      character_id: charId(p.character_id),
      action: oneOf(INTRO_ACTIONS, p.action) ?? 'shown',
      trigger: oneOf(INTRO_TRIGGERS, p.trigger) ?? 'first_link',
      style: oneOf(INTRO_STYLES, p.style),
      mood: oneOf(INTRO_MOODS, p.mood),
      end_on: oneOf(INTRO_END_ON, p.end_on),
      reduced_motion: p.reduced_motion === true,
      entry: oneOf(ENTRY_SOURCES, p.entry),
    };
    const beat = oneOf(INTRO_BEATS, p.beat);
    if (beat) out.beat = beat;
    const bucket = oneOf(DURATION_BUCKETS, p.duration_bucket);
    if (bucket) out.duration_bucket = bucket;
    const host = oneOf(INTRO_HOST, p.host);
    if (host) out.host = host;
    return out;
  }
  if (event === SEILINK_INTRO_LINK_EVENT) {
    const out: Record<string, Scalar> = {
      outcome: oneOf(LINK_OUTCOMES, p.outcome) ?? 'abandoned',
      trigger: oneOf(INTRO_TRIGGERS, p.trigger) ?? 'first_link',
      reduced_motion: p.reduced_motion === true,
    };
    const failure = oneOf(LINK_FAILURES, p.failure);
    if (failure) out.failure = failure;
    const shown = small(p.lines_shown, LINK_LINE_COUNT);
    if (shown !== undefined) out.lines_shown = shown;
    for (let i = 1; i <= LINK_LINE_COUNT; i++) {
      const ms = small(p[`line_${i}_ms`], LINK_MS_MAX);
      if (ms !== undefined) out[`line_${i}_ms`] = ms;
    }
    const total = small(p.total_ms, LINK_MS_MAX);
    if (total !== undefined) out.total_ms = total;
    const slowest = oneOf(LINK_MILESTONES, p.slowest);
    if (slowest) out.slowest = slowest;
    const slowMs = small(p.slowest_ms, LINK_MS_MAX);
    if (slowest && slowMs !== undefined) out.slowest_ms = slowMs;
    const start = oneOf(LINK_ANIMA_START, p.anima_start);
    if (start) out.anima_start = start;
    return out;
  }
  if (event === SEILINK_TOUR_EVENT) {
    const out: Record<string, Scalar> = {
      action: oneOf(TOUR_ACTIONS, p.action) ?? 'offered',
      audience: oneOf(TOUR_AUDIENCES, p.audience) ?? 'existing',
    };
    const n = small(p.offer_n, 9);
    if (n !== undefined) out.offer_n = n;
    if (typeof p.snoozed === 'boolean') out.snoozed = p.snoozed;
    const step = oneOf(TOUR_STEPS, p.step);
    if (step) out.step = step;
    return out;
  }
  if (event === SEILINK_SETUP_EVENT) {
    const out: Record<string, Scalar> = {
      character_id: charId(p.character_id),
      action: oneOf(SETUP_ACTIONS, p.action) ?? 'started',
      step: oneOf(SETUP_STEP_NAMES, p.step),
      surface: oneOf(SETUP_SURFACES, p.surface),
      plain: p.plain === true,
    };
    const done = small(p.steps_completed, 9);
    if (done !== undefined) out.steps_completed = done;
    const skipped = small(p.steps_skipped, 9);
    if (skipped !== undefined) out.steps_skipped = skipped;
    const total = small(p.steps_total, 9);
    if (total !== undefined) out.steps_total = total;
    const ms = small(p.ms_open, 24 * 3600_000);
    if (ms !== undefined) out.ms_open = ms;
    const from = oneOf(SETUP_OPENED_FROM, p.opened_from);
    if (from) out.opened_from = from;
    return out;
  }
  if (event === SEILINK_SETUP_STEP_EVENT) {
    const out: Record<string, Scalar> = {
      character_id: charId(p.character_id),
      step: oneOf(SETUP_STEP_NAMES, p.step) ?? 'room',
      action: oneOf(SETUP_STEP_ACTIONS, p.action) ?? 'shown',
      resumed: p.resumed === true,
    };
    if (typeof p.changed === 'boolean') out.changed = p.changed;
    const n = small(p.index, 9);
    if (n !== undefined) out.index = n;
    return out;
  }
  if (event === SEILINK_ENTRY_EVENT) {
    return {
      character_id: charId(p.character_id),
      source: oneOf(ENTRY_SOURCES, p.source) ?? 'button',
      action: oneOf(ENTRY_ACTIONS, p.action) ?? 'sheet',
    };
  }
  return {};
}
