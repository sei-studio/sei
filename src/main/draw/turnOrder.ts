/**
 * Draw! turn order (260929).
 *
 * A round is two turns, one per player. It used to be hard-wired as "the
 * player draws, then the character", and the game-over test was "the
 * character just drew in the last round". The intro game (a player's first,
 * see INTRO_ROUNDS) flips the order so the character draws first, so both
 * questions now depend on who opens each round. Pure, for testing.
 */
import type { DrawRole } from '../../shared/drawIpc';

export function otherRole(r: DrawRole): DrawRole {
  return r === 'player' ? 'ai' : 'player';
}

/** The turn that just ended was the last turn of the game. */
export function isLastTurn(args: {
  drawer: DrawRole;
  firstDrawer: DrawRole;
  round: number;
  rounds: number;
}): boolean {
  return args.drawer !== args.firstDrawer && args.round >= args.rounds;
}

/** What follows the turn that just ended. */
export function nextTurn(args: {
  drawer: DrawRole;
  firstDrawer: DrawRole;
  round: number;
  rounds: number;
}): { kind: 'turn'; drawer: DrawRole; round: number } | { kind: 'gallery' } {
  if (args.drawer === args.firstDrawer) {
    // Same round, roles swap.
    return { kind: 'turn', drawer: otherRole(args.drawer), round: args.round };
  }
  if (isLastTurn(args)) return { kind: 'gallery' };
  return { kind: 'turn', drawer: args.firstDrawer, round: args.round + 1 };
}
