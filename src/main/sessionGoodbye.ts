import { isGameId, type GameId } from '../shared/gameIpc';

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
 *   - game: `closePlaySession` â†’ `bot_session_ended.next_step_hook`;
 *   - call: the call-ended report â†’ `voice_call_ended.next_step_hook` and
 *     `ended_by_companion`.
 *
 * Booleans only: never the hook text, never anything the companion said.
 * 261014: the note also holds the goodbye's player-facing line
 * (`next_time_for_player`) for the Home card's tag; it never reaches analytics.
 *
 * 261011: a hook set here also carries `next_step_source: 'companion'`. A
 * session the PLAYER ended can get a plan too, from a background check that
 * runs after this event has already gone out (playerEndNextStep.ts), so that
 * one is reported as its own `next_step_saved {source: 'player_end'}` event.
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
  /** 261014: that hook written to the player, for the Home card. Never sent to analytics. */
  nextStepLine?: string | null;
  /**
   * 261020: the game the plan is for, from the goodbye's next_time_game
   * field ('none' = not about a game). Unset = the model left it out.
   */
  nextStepGame?: GameId | 'none';
}

/** What a goodbye's next_time fields came to: whether a plan was given, and its player line. */
export interface NextStepHookResult {
  hook: boolean;
  line: string | null;
  /** 261020: see GoodbyeNote.nextStepGame; null = left out. */
  game?: GameId | 'none' | null;
}

/** A plan game as it arrives over the port or from a tool: a bot game id, 'none', or undefined. */
export function goodbyeGame(raw: unknown): GameId | 'none' | undefined {
  return raw === 'none' || isGameId(raw) ? raw : undefined;
}

export const NOTE_TTL_MS = 2 * 60_000;

const NONE: GoodbyeNote = { companionEnded: false, nextStepHook: false };

const notes = new Map<string, { note: GoodbyeNote; at: number }>();

const key = (characterId: string, surface: GoodbyeSurface): string => `${surface}:${characterId}`;

/**
 * The companion ended a session on `surface`; `hook` = whether it left a
 * plan (a boolean, or the plan's result with its player line).
 */
export function noteCompanionGoodbye(
  characterId: string,
  surface: GoodbyeSurface,
  hook: boolean | NextStepHookResult,
  now: number = Date.now(),
): void {
  const r: NextStepHookResult = typeof hook === 'boolean' ? { hook, line: null } : hook;
  const note: GoodbyeNote = { companionEnded: true, nextStepHook: r.hook === true };
  if (note.nextStepHook && typeof r.line === 'string' && r.line) note.nextStepLine = r.line;
  const game = goodbyeGame(r.game);
  if (note.nextStepHook && game) note.nextStepGame = game;
  notes.set(key(characterId, surface), { note, at: now });
}

/**
 * 261020 (review): where a goodbye's plan belongs, for its Home card tag. A
 * game the model named wins over the session (a Minecraft plan said while
 * leaving Stardew offers Minecraft). 'none' drops the game, so the card
 * offers the games picker (or a call) and no game claims the plan. Left out:
 * a game session's plan is that game's, a call's stays a call plan.
 */
export function goodbyePlanPlace(
  session: { surface: 'game'; game?: string | null } | { surface: 'call' },
  game: GameId | 'none' | undefined,
): { surface: 'game' | 'call'; game?: string } {
  if (game && game !== 'none') return { surface: 'game', game };
  if (session.surface === 'call') return { surface: 'call' };
  if (game === 'none' || !session.game) return { surface: 'game' };
  return { surface: 'game', game: session.game };
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
export type NextStepSourceProps = { next_step_source?: 'companion' };

const sourceProps = (note: GoodbyeNote): NextStepSourceProps =>
  note.nextStepHook ? { next_step_source: 'companion' } : {};

export function gameEndHookProps(note: GoodbyeNote): { next_step_hook: boolean } & NextStepSourceProps {
  return { next_step_hook: note.nextStepHook, ...sourceProps(note) };
}

/** `voice_call_ended` props. */
export function callEndHookProps(
  note: GoodbyeNote,
): { next_step_hook: boolean; ended_by_companion: boolean } & NextStepSourceProps {
  return { next_step_hook: note.nextStepHook, ended_by_companion: note.companionEnded, ...sourceProps(note) };
}

/** Tests only. */
export function _resetGoodbyeNotes(): void {
  notes.clear();
}




