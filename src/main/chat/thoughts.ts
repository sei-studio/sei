/**
 * Thought steering seam (main process).
 *
 * A "thought" is a natural-language string queued per character and folded into
 * the NEXT LLM prompt built for that character's in-app turn. Thoughts are
 * EPHEMERAL steering: they nudge what the companion does on one turn (speak
 * first, greet, acknowledge a state change) and are NEVER persisted into the
 * chat transcript, never shown to the user, and never quoted back. They ride the
 * prompt as a bracketed model-facing note (see renderThoughtNote) folded into the
 * user side, then evaporate.
 *
 * Three current uses:
 *   1. First meeting. When the player first opens chat with a freshly matched
 *      unique companion, the companion speaks first (THOUGHT_FIRST_MEETING),
 *      pushed via the queue and drained in sendFirstMeetingTurn.
 *   2. Joining a game. The "on my way in" steering for an open-world launch
 *      (THOUGHT_JOINING_GAME). This one lives here as the single seam, though its
 *      consumer (resolveLaunch) delivers it as a mid-turn tool_result rather than
 *      via the queue.
 *   3. Joining a call. Greet-on-join steering for a live voice call
 *      (THOUGHT_JOINING_CALL). NOT consumed on this branch (see its doc comment).
 *
 * Future direction: an LLM narrator may push thoughts into this queue to steer a
 * companion's in-app chat, call, or game turns from the outside. The queue is
 * the seam it would write to, and this module is the single place that owns the
 * steering TEXT so a narrator (or an author) edits it in one spot.
 */

/** In-memory per-character queue of pending steering thoughts. */
const queue = new Map<string, string[]>();

/** Queue a steering thought for the character's next LLM turn. */
export function pushThought(characterId: string, text: string): void {
  const list = queue.get(characterId);
  if (list) list.push(text);
  else queue.set(characterId, [text]);
}

/** Return and clear all pending thoughts for a character (empty array if none). */
export function drainThoughts(characterId: string): string[] {
  const list = queue.get(characterId);
  if (!list) return [];
  queue.delete(characterId);
  return list;
}

/** Peek at pending thoughts without clearing them. */
export function peekThoughts(characterId: string): string[] {
  return queue.get(characterId)?.slice() ?? [];
}

/** Drop any pending thoughts for a character without returning them. */
export function clearThoughts(characterId: string): void {
  queue.delete(characterId);
}

/**
 * Render pending thoughts as one bracketed, model-facing note in the house style
 * (same framing as the launch-failed system note): clearly NOT the player
 * speaking, never to be quoted or mentioned. Returns '' when there are no
 * thoughts, so a caller can fold unconditionally. Multiple thoughts join into a
 * single note so they land as one user-side aside.
 */
export function renderThoughtNote(thoughts: string[]): string {
  const text = thoughts.map((t) => t.trim()).filter(Boolean).join(' ');
  if (!text) return '';
  return `[A thought crosses your mind (not the player speaking; never quote or mention this note): ${text}]`;
}

/**
 * First meeting. Pushed when the player first opens chat with a freshly matched
 * unique companion; the companion speaks first. The stay-in-character clause is
 * load-bearing: a gruff companion should NOT act curious just because the note
 * suggests asking about the player.
 */
export const THOUGHT_FIRST_MEETING =
  'You were just summoned to World Zero, Earth, by this human. The tools you are seeing belong to the Sei terminal. ' +
  'Say something to the human. Ask about them if you are curious, or just say hi if you are not. ' +
  'Stay true to your own character.';

/**
 * Joining a game. The "on the way in" steering for an open-world launch: tell the
 * player you are hopping in, do NOT claim you have already arrived, keep it to one
 * short line. resolveLaunch delivers this as a tool_result mid-turn, but the TEXT
 * lives here so it is the single seam a future narrator would edit.
 */
export const THOUGHT_JOINING_GAME =
  'You are on your way into the player\'s Minecraft world right now, so tell them you\'re hopping in. ' +
  'Do NOT claim you have already arrived; you are still joining. Keep it to one short line.';

/**
 * Joining a live voice call. Greet-on-join steering.
 *
 * NOT consumed on this branch: the voice call here is a UI placeholder, and the
 * real call LLM lives on the separate voice-call branch. That branch will import
 * this constant after merge; it is defined here now so the steering text has a
 * single home the moment the call brain is wired up.
 */
export const THOUGHT_JOINING_CALL =
  'You just joined a live voice call with the player. Greet them first, briefly, in your own voice.';
