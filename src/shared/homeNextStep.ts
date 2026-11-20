/**
 * The Home "up next" card (261013, retention O2 / T119): shared contract.
 *
 * Main reads each Home character's latest unexpired, unconsumed "Plan for
 * next time" entry from MEMORY.md (written by T80 goodbyes and the T96
 * player-end check), or falls back to its newest active goal from the
 * HEARTBEAT goal files, and answers `home:next-steps` with one of these per
 * character that has something. src/main/homeNextStep.ts has the rules.
 */

import { isGameId, type GameId } from './gameIpc';
import { GAME_CATALOG } from './games';

/** Where a plan was made. Same values as playerEndNextStep's NextStepSurface. */
export type HomeNextStepSurface = 'game' | 'call' | 'backseat' | 'chat';

export interface HomeNextStep {
  characterId: string;
  /** 'plan' = a saved "Plan for next time"; 'goal' = an active HEARTBEAT goal. */
  source: 'plan' | 'goal';
  /** The step as display text (one line, first letter capitalized). */
  text: string;
  /** When the entry was written, ms epoch. */
  at: number;
  /** The surface it came from; null when not recorded (older plans). */
  surface: HomeNextStepSurface | null;
  /** Game id for surface 'game' (minecraft, stardew, dontstarve) or a backseat game id. */
  game: string | null;
}

/**
 * 261014: a companion name as it reads inside the card's sentences ("Up next
 * with Red", "Call Red"). A name typed all lowercase ("red") reads as an
 * ordinary word there, so its first letter is raised. Display only: the
 * stored name is untouched, and so is any name with a capital in it
 * ("xXSuiXx", "DeepSeek") or no cased letters at all (CJK). The party tile
 * shows the name on its own as a caption, where it is kept as typed. Main
 * uses it too, so the player-end check writes the name the card shows
 * (playerEndNextStep.ts).
 */
export function nameInSentence(name: string): string {
  const n = String(name ?? '');
  if (n !== n.toLowerCase() || n === n.toUpperCase()) return n;
  const chars = Array.from(n);
  const i = chars.findIndex((c) => c.toUpperCase() !== c);
  if (i < 0) return n;
  chars[i] = chars[i].toUpperCase();
  return chars.join('');
}

/** Lowercase letters and digits only: "Don't Starve Together" -> "dontstarvetogether". */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 261020: a bot game as plan text names it ("Stardew Valley", "stardew",
 * "Don't Starve Together") as its id, or null when it names none of them.
 * Used for the game a plan's memory line names and for the player-end
 * check's `game:` answer, so a value with extra words around one game name
 * ("Minecraft.") still reads; one naming two games reads as none.
 */
export function gameIdFromName(name: string | null | undefined): GameId | null {
  const n = squash(String(name ?? ''));
  if (!n) return null;
  if (isGameId(n)) return n;
  const games = GAME_CATALOG.filter((g) => isGameId(g.id));
  const exact = games.find((g) => squash(g.name) === n);
  if (exact && isGameId(exact.id)) return exact.id;
  const hits = games.filter((g) => n.includes(squash(g.name)) || n.includes(g.id));
  return hits.length === 1 && isGameId(hits[0].id) ? hits[0].id : null;
}

/** A bot game id as plan text names it ("Stardew Valley"). */
export function gameDisplayName(game: GameId): string {
  return GAME_CATALOG.find((g) => g.id === game)?.name ?? game;
}
