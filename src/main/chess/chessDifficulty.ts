/**
 * Adaptive chess strength (260929).
 *
 * The character's Elo comes from its persona (chessProfile.ts) and used to be
 * fixed forever. Real usage: players won 2 of 16 decided games, and one new
 * player lost 6 straight to a 1350 companion in an hour. So each game now
 * plays at the persona Elo plus a per-player offset: a loss drops the next
 * game a step, a win raises it by a smaller step, within bounds. The persona
 * still sets the character's baseline; the offset only follows how this
 * particular player is doing against it.
 *
 * Only AUTO profiles adapt. A strength the user set by hand in Edit companion
 * -> Games is a choice, not a guess, and is played as set.
 *
 * Persisted per character in the profile-scoped config (`chess_elo_offsets`),
 * so it survives restarts and follows the account, not the machine.
 */
import { loadConfig, updateConfig } from '../configStore';
import type { ChessProfile } from './chessProfile';

export const CHESS_DIFFICULTY = {
  /** Elo removed after the player loses. */
  lossStep: 100,
  /** Elo added after the player wins. Smaller on purpose: ease back in slowly. */
  winStep: 50,
  /** Furthest below the persona Elo the offset may go. */
  minOffset: -600,
  /** Furthest above the persona Elo the offset may go. */
  maxOffset: 200,
  /** Absolute bounds, the same as ChessProfileSchema. */
  minElo: 400,
  maxElo: 2000,
} as const;

/** Result from the PLAYER's side: 'player' won, 'ai' won, or a draw. */
export type ChessOutcome = 'player' | 'ai' | 'draw';

type Bounds = typeof CHESS_DIFFICULTY;

/**
 * The offset range for a character whose persona Elo is `base`: the configured
 * offset bounds, narrowed so base + offset never leaves the absolute Elo range.
 * Without the narrowing a 450 character could bank offset it can never use,
 * and every later win would first have to pay that back.
 */
function offsetRange(base: number, b: Bounds = CHESS_DIFFICULTY): { lo: number; hi: number } {
  const lo = Math.max(b.minOffset, b.minElo - base);
  const hi = Math.min(b.maxOffset, b.maxElo - base);
  return { lo: Math.min(lo, 0), hi: Math.max(hi, 0) };
}

/** Pure: the offset after one decided game. Draws leave it where it is. */
export function nextEloOffset(
  offset: number,
  outcome: ChessOutcome,
  base: number,
  b: Bounds = CHESS_DIFFICULTY,
): number {
  const { lo, hi } = offsetRange(base, b);
  const cur = Math.max(lo, Math.min(hi, Math.round(offset) || 0));
  if (outcome === 'ai') return Math.max(lo, cur - b.lossStep);
  if (outcome === 'player') return Math.min(hi, cur + b.winStep);
  return cur;
}

/** Pure: the Elo a game is played at. */
export function effectiveElo(base: number, offset: number, b: Bounds = CHESS_DIFFICULTY): number {
  const { lo, hi } = offsetRange(base, b);
  const off = Math.max(lo, Math.min(hi, Math.round(offset) || 0));
  return Math.max(b.minElo, Math.min(b.maxElo, Math.round(base + off)));
}

/** Whether this profile's strength follows the player's results. */
export function adapts(profile: ChessProfile): boolean {
  return profile.source !== 'user';
}

/** The stored offset for a character (0 when none, unreadable, or not adapting). */
export async function readEloOffset(characterId: string, profile: ChessProfile): Promise<number> {
  if (!adapts(profile)) return 0;
  try {
    const cfg = await loadConfig();
    const v = cfg.chess_elo_offsets?.[characterId];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Fold one decided game into the stored offset. Returns the new offset, or
 * null when nothing was written (not adapting, a draw, or the write failed).
 * Never throws: difficulty is never load-bearing for ending a game.
 */
export async function recordChessOutcome(
  characterId: string,
  profile: ChessProfile,
  outcome: ChessOutcome,
): Promise<number | null> {
  if (!adapts(profile) || outcome === 'draw') return null;
  try {
    let next = 0;
    await updateConfig((cfg) => {
      const offsets = { ...(cfg.chess_elo_offsets ?? {}) };
      next = nextEloOffset(offsets[characterId] ?? 0, outcome, profile.elo);
      offsets[characterId] = next;
      return { ...cfg, chess_elo_offsets: offsets };
    });
    return next;
  } catch (err) {
    console.warn(`[sei/chess] difficulty update failed: ${(err as Error).message}`);
    return null;
  }
}
