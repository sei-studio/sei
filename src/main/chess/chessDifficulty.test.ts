/**
 * 260929 adaptive chess strength: the pure stepping rules and the persisted
 * per-character offset. Players won 2 of 16 decided games against fixed
 * persona Elo; a loss now lowers the next game a step, a win raises it by a
 * smaller one, inside bounds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfg } = vi.hoisted(() => ({ cfg: { current: {} as Record<string, unknown> } }));
vi.mock('../configStore', () => ({
  loadConfig: vi.fn(async () => cfg.current),
  updateConfig: vi.fn(async (mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
    cfg.current = mutate(cfg.current);
    return cfg.current;
  }),
}));

import {
  CHESS_DIFFICULTY,
  effectiveElo,
  nextEloOffset,
  readEloOffset,
  recordChessOutcome,
} from './chessDifficulty';

const AUTO = { elo: 1350, styleNote: '', source: 'auto' as const };
const USER = { elo: 1350, styleNote: '', source: 'user' as const };
const CHAR = '77777777-7777-4777-8777-777777777777';

describe('nextEloOffset', () => {
  it('drops a full step after a player loss and half that after a win', () => {
    expect(nextEloOffset(0, 'ai', 1350)).toBe(-CHESS_DIFFICULTY.lossStep);
    expect(nextEloOffset(-100, 'player', 1350)).toBe(-100 + CHESS_DIFFICULTY.winStep);
    expect(CHESS_DIFFICULTY.winStep).toBeLessThan(CHESS_DIFFICULTY.lossStep);
  });

  it('leaves draws alone', () => {
    expect(nextEloOffset(-200, 'draw', 1350)).toBe(-200);
  });

  it('six straight losses against a 1350 bottom out at the floor, not below', () => {
    let off = 0;
    for (let i = 0; i < 10; i++) off = nextEloOffset(off, 'ai', 1350);
    expect(off).toBe(CHESS_DIFFICULTY.minOffset);
    expect(effectiveElo(1350, off)).toBe(1350 + CHESS_DIFFICULTY.minOffset);
  });

  it('never banks offset past the absolute Elo range', () => {
    // A 450 character can only go 50 down; the next win must count at once.
    let off = 0;
    for (let i = 0; i < 5; i++) off = nextEloOffset(off, 'ai', 450);
    expect(off).toBe(-50);
    expect(effectiveElo(450, off)).toBe(CHESS_DIFFICULTY.minElo);
    expect(nextEloOffset(off, 'player', 450)).toBe(0);
    // And a 1950 character cannot climb past the ceiling.
    let up = 0;
    for (let i = 0; i < 10; i++) up = nextEloOffset(up, 'player', 1950);
    expect(effectiveElo(1950, up)).toBe(CHESS_DIFFICULTY.maxElo);
  });

  it('caps how far above the persona a winning streak can push it', () => {
    let off = 0;
    for (let i = 0; i < 20; i++) off = nextEloOffset(off, 'player', 900);
    expect(off).toBe(CHESS_DIFFICULTY.maxOffset);
  });

  it('clamps a corrupt stored offset before stepping', () => {
    expect(nextEloOffset(-99999, 'player', 1350)).toBe(CHESS_DIFFICULTY.minOffset + CHESS_DIFFICULTY.winStep);
    expect(effectiveElo(1350, Number.NaN)).toBe(1350);
  });
});

describe('persisted offset', () => {
  beforeEach(() => {
    cfg.current = {};
  });

  it('records per character and reads it back for the next game', async () => {
    expect(await readEloOffset(CHAR, AUTO)).toBe(0);
    expect(await recordChessOutcome(CHAR, AUTO, 'ai')).toBe(-100);
    expect(await recordChessOutcome(CHAR, AUTO, 'ai')).toBe(-200);
    expect(await recordChessOutcome(CHAR, AUTO, 'player')).toBe(-150);
    expect(await readEloOffset(CHAR, AUTO)).toBe(-150);
    expect(cfg.current.chess_elo_offsets).toEqual({ [CHAR]: -150 });
  });

  it('does not adapt a strength the user set by hand', async () => {
    cfg.current = { chess_elo_offsets: { [CHAR]: -300 } };
    expect(await readEloOffset(CHAR, USER)).toBe(0);
    expect(await recordChessOutcome(CHAR, USER, 'ai')).toBeNull();
    expect(cfg.current.chess_elo_offsets).toEqual({ [CHAR]: -300 });
  });

  it('writes nothing for a draw', async () => {
    expect(await recordChessOutcome(CHAR, AUTO, 'draw')).toBeNull();
    expect(cfg.current.chess_elo_offsets).toBeUndefined();
  });
});
