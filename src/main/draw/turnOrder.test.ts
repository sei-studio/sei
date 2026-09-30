/** 260929: Draw! turn order with either side opening each round. */
import { describe, it, expect } from 'vitest';
import type { DrawRole } from '../../shared/drawIpc';
import { isLastTurn, nextTurn } from './turnOrder';

function playOut(firstDrawer: DrawRole, rounds: number): string[] {
  const seq: string[] = [];
  let cur: { drawer: DrawRole; round: number } = { drawer: firstDrawer, round: 1 };
  for (let guard = 0; guard < 50; guard++) {
    seq.push(`${cur.round}:${cur.drawer}`);
    const n = nextTurn({ ...cur, firstDrawer, rounds });
    if (n.kind === 'gallery') break;
    cur = n;
  }
  return seq;
}

describe('Draw! turn order', () => {
  it('a normal game: the player opens every round, three rounds, six turns', () => {
    expect(playOut('player', 3)).toEqual(['1:player', '1:ai', '2:player', '2:ai', '3:player', '3:ai']);
  });

  it('the intro game: the character draws first, then the player, one round', () => {
    expect(playOut('ai', 1)).toEqual(['1:ai', '1:player']);
  });

  it('the game ends after the SECOND turn of the last round, whoever opened it', () => {
    expect(isLastTurn({ drawer: 'ai', firstDrawer: 'player', round: 3, rounds: 3 })).toBe(true);
    expect(isLastTurn({ drawer: 'player', firstDrawer: 'player', round: 3, rounds: 3 })).toBe(false);
    expect(isLastTurn({ drawer: 'player', firstDrawer: 'ai', round: 1, rounds: 1 })).toBe(true);
    expect(isLastTurn({ drawer: 'ai', firstDrawer: 'ai', round: 1, rounds: 1 })).toBe(false);
  });
});
