/**
 * How a session's goodbye went (261008, retention fix 2(c)), as analytics
 * props on the existing `_ended` events.
 *
 * A companion that ends a session itself (game quit_game, end_call on either
 * the game brain or the chat surface) can attach a `next_time` hook to its
 * goodbye: something real to pick up next session, saved to MEMORY.md so the
 * next greeting can raise it (src/bot/brain/nextStep.js). Whether it did is
 * the one fact this module carries from that moment to the session's single
 * end choke point:
 *   - game: `closePlaySession` → `bot_session_ended.next_step_hook`;
 *   - call: the call-ended report → `voice_call_ended.next_step_hook` and
 *     `ended_by_companion`.
 *
 * Booleans only: never the hook text, never anything the companion said.
 *
 * The goodbye and the end event come from different processes (bot port,
 * renderer report), so a note waits here until consumed. It expires after
 * NOTE_TTL_MS so a report that never arrives (renderer reload, a quit with no
 * live world) cannot attach itself to a later session.
 */

export type GoodbyeSurface = 'game' | 'call';

export interface GoodbyeNote {
  /** The companion ended this session itself (quit_game / end_call). */
  companionEnded: boolean;
  /** Its goodbye carried a next_time hook. */
  nextStepHook: boolean;
}

export const NOTE_TTL_MS = 2 * 60_000;

const NONE: GoodbyeNote = { companionEnded: false, nextStepHook: false };

const notes = new Map<string, { note: GoodbyeNote; at: number }>();

const key = (characterId: string, surface: GoodbyeSurface): string => `${surface}:${characterId}`;

/** The companion ended a session on `surface`; `nextStepHook` = it left a hook. */
export function noteCompanionGoodbye(
  characterId: string,
  surface: GoodbyeSurface,
  nextStepHook: boolean,
  now: number = Date.now(),
): void {
  notes.set(key(characterId, surface), { note: { companionEnded: true, nextStepHook }, at: now });
}

/** Read and forget the note for a session that just ended. */
export function consumeGoodbye(characterId: string, surface: GoodbyeSurface, now: number = Date.now()): GoodbyeNote {
  const k = key(characterId, surface);
  const entry = notes.get(k);
  notes.delete(k);
  if (!entry || now - entry.at > NOTE_TTL_MS) return NONE;
  return entry.note;
}

/** `bot_session_ended` props. */
export function gameEndHookProps(note: GoodbyeNote): { next_step_hook: boolean } {
  return { next_step_hook: note.nextStepHook };
}

/** `voice_call_ended` props. */
export function callEndHookProps(note: GoodbyeNote): { next_step_hook: boolean; ended_by_companion: boolean } {
  return { next_step_hook: note.nextStepHook, ended_by_companion: note.companionEnded };
}

/** Tests only. */
export function _resetGoodbyeNotes(): void {
  notes.clear();
}
