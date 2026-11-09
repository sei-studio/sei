/**
 * WorldLink setup analytics (261110, product call 261110), shape only. The
 * renderer sends them through `sei.track`; main's analytics:track handler
 * rebuilds the props with `sanitizeSeilinkSetupTrack`, so only closed enums,
 * small counts and the character id leave the machine. Main sends
 * seilink_minimize_windows itself (stageFlow), through the same builder.
 *
 *  - seilink_setup_call {outcome: started|consent_shown|install_started|
 *    installed|install_failed|declined|error, guided, gate}: the Call button
 *    by the room editor's talk box.
 *  - seilink_live_hint {action: shown|dismissed|show_desktop|minimized,
 *    surface: intro_end|app_window, os}: the "lives on your desktop" card
 *    when the room first goes live.
 *  - seilink_minimize_windows {outcome: ok|failed|unsupported, windows
 *    (count, capped), surface, os}: "Minimize other windows".
 *  - seilink_placement_guide {mode: outline, cls: floor|surface|wall, placed}:
 *    the first drag of each kind in an editor session (outlined areas in
 *    place of the old blur).
 *
 * Event table: docs/agents/seilink-analytics.md.
 */

export const SEILINK_SETUP_CALL_EVENT = 'seilink_setup_call';
export const SEILINK_LIVE_HINT_EVENT = 'seilink_live_hint';
export const SEILINK_MINIMIZE_EVENT = 'seilink_minimize_windows';
export const SEILINK_PLACEMENT_GUIDE_EVENT = 'seilink_placement_guide';

export const SETUP_CALL_OUTCOMES = ['started', 'consent_shown', 'install_started', 'installed', 'install_failed', 'declined', 'error'] as const;
export type SetupCallOutcome = (typeof SETUP_CALL_OUTCOMES)[number];
/** What the voice-module check said when the button was pressed. */
export const SETUP_CALL_GATES = ['ready', 'installing', 'consent'] as const;

export const LIVE_HINT_ACTIONS = ['shown', 'dismissed', 'show_desktop', 'minimized'] as const;
export type LiveHintAction = (typeof LIVE_HINT_ACTIONS)[number];
/** intro_end = over the first link's last frame; app_window = in the app after a move-in without the intro. */
export const LIVE_HINT_SURFACES = ['intro_end', 'app_window'] as const;
export type LiveHintSurface = (typeof LIVE_HINT_SURFACES)[number];

export const MINIMIZE_OUTCOMES = ['ok', 'failed', 'unsupported'] as const;
export type MinimizeOutcome = (typeof MINIMIZE_OUTCOMES)[number];
export const MINIMIZE_SURFACES = ['live_card', 'other'] as const;
/** The most windows the minimize count says. */
const MINIMIZE_MAX = 50;

export const PLACEMENT_CLASSES = ['floor', 'surface', 'wall'] as const;

const OSES = ['mac', 'windows', 'linux'] as const;
export type SetupOs = (typeof OSES)[number];

type Scalar = string | number | boolean | null;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function charId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** The events this module owns. */
export function isSeilinkSetupEvent(event: string): boolean {
  return event === SEILINK_SETUP_CALL_EVENT || event === SEILINK_LIVE_HINT_EVENT || event === SEILINK_MINIMIZE_EVENT || event === SEILINK_PLACEMENT_GUIDE_EVENT;
}

/** Rebuild one of these events' props from the closed shapes. */
export function sanitizeSeilinkSetupTrack(event: string, raw: Record<string, unknown> | undefined): Record<string, Scalar> {
  const p = raw ?? {};
  if (event === SEILINK_SETUP_CALL_EVENT) {
    const out: Record<string, Scalar> = {
      character_id: charId(p.character_id),
      outcome: oneOf(SETUP_CALL_OUTCOMES, p.outcome) ?? 'error',
      guided: p.guided === true,
    };
    const gate = oneOf(SETUP_CALL_GATES, p.gate);
    if (gate) out.gate = gate;
    return out;
  }
  if (event === SEILINK_LIVE_HINT_EVENT) {
    return {
      character_id: charId(p.character_id),
      action: oneOf(LIVE_HINT_ACTIONS, p.action) ?? 'shown',
      surface: oneOf(LIVE_HINT_SURFACES, p.surface) ?? 'intro_end',
      os: oneOf(OSES, p.os),
    };
  }
  if (event === SEILINK_MINIMIZE_EVENT) {
    const out: Record<string, Scalar> = {
      outcome: oneOf(MINIMIZE_OUTCOMES, p.outcome) ?? 'failed',
      surface: oneOf(MINIMIZE_SURFACES, p.surface) ?? 'other',
      os: oneOf(OSES, p.os),
    };
    const n = Number(p.windows);
    if (Number.isFinite(n) && n >= 0) out.windows = Math.min(Math.round(n), MINIMIZE_MAX);
    return out;
  }
  if (event === SEILINK_PLACEMENT_GUIDE_EVENT) {
    return {
      mode: 'outline',
      cls: oneOf(PLACEMENT_CLASSES, p.cls) ?? 'floor',
      placed: p.placed === true,
    };
  }
  return {};
}
