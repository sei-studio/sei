/**
 * SeiLink first-link analytics (261105, T337), shape only: the cinematic,
 * the guide's SeiLink tour and the SeiLink entry points. The renderer sends
 * them through `sei.track`; main's analytics:track handler rebuilds the props
 * with `sanitizeSeilinkIntroTrack`, so only closed enums, small counts,
 * buckets and the character id can leave the machine.
 *
 *  - seilink_intro {action: shown|completed|skipped|aborted, trigger, style,
 *    reduced_motion, beat (where it ended), duration_bucket, host}
 *  - seilink_tour {action: offered|sure|not_now|completed|dropped, audience,
 *    offer_n, snoozed (not_now), step (dropped)}
 *  - seilink_entry {source: button|gear|tour|dock, action}
 *
 * Event table: docs/agents/seilink-analytics.md.
 */

export const SEILINK_INTRO_EVENT = 'seilink_intro';
export const SEILINK_TOUR_EVENT = 'seilink_tour';
export const SEILINK_ENTRY_EVENT = 'seilink_entry';

/** shown on start; completed = played to the end; skipped = the person skipped; aborted = the host failed, it ended early. */
export const INTRO_ACTIONS = ['shown', 'completed', 'skipped', 'aborted'] as const;
export type IntroAction = (typeof INTRO_ACTIONS)[number];

/** first_link = her first successful move-in on this account; replay = "Replay SeiLink intro". */
export const INTRO_TRIGGERS = ['first_link', 'replay'] as const;
export type IntroTrigger = (typeof INTRO_TRIGGERS)[number];

/**
 * The visual treatments (261106: soft colour gradients, glows and waves, no
 * hard lines): aurora = swaying curtains of aurora light, bloom = slow warm
 * pulses breathing out of her seat, tide = drifting pools of liquid light.
 * One ships as the default (introPref.DEFAULT_INTRO_STYLE).
 */
export const INTRO_STYLES = ['aurora', 'bloom', 'tide'] as const;
export type IntroStyle = (typeof INTRO_STYLES)[number];

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

export function isSeilinkIntroEvent(event: string): boolean {
  return event === SEILINK_INTRO_EVENT || event === SEILINK_TOUR_EVENT || event === SEILINK_ENTRY_EVENT;
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
  if (event === SEILINK_ENTRY_EVENT) {
    return {
      character_id: charId(p.character_id),
      source: oneOf(ENTRY_SOURCES, p.source) ?? 'button',
      action: oneOf(ENTRY_ACTIONS, p.action) ?? 'sheet',
    };
  }
  return {};
}
