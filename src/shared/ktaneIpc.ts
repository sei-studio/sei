/**
 * Keep Talking and Nobody Explodes, expert mode (261115): shared renderer <->
 * main contract.
 *
 * The player plays KTANE on their own screen as the Defuser and describes the
 * bomb by voice (or chat). The companion is the Expert: it has a compact
 * restatement of the bomb manual in its prompt and answers from it. There is
 * no game mod and no solver; every answer is the companion's own reading of
 * the manual (docs/design/ktane-companion-261115.md).
 *
 * Authority split:
 *
 *   main      owns the session: whether expert mode is on for a character,
 *             the bomb sheet the companion fills through its bomb_notes()
 *             tool, the analytics, and the closing play row. The turns
 *             themselves are ordinary chat / call turns (chatService) that
 *             carry the manual and the tool while a session is on.
 *   renderer  shows the panel (the companion's notes, Start call, New bomb,
 *             End) and never decides anything.
 */
import type { KtaneSheet, KtaneSessionTotals } from './ktaneSheet';

export interface KtaneState {
  characterId: string;
  /** False once the session ended (the last push of a session). */
  active: boolean;
  startedAt: number;
  sheet: KtaneSheet;
  totals: KtaneSessionTotals;
}

/** What opened the session (analytics shape only). */
export type KtaneStartSource = 'picker' | 'panel';

/** Why a session ended (analytics shape only). */
export type KtaneEndReason = 'user_end' | 'idle' | 'app_quit' | 'account_switch' | 'replaced';
