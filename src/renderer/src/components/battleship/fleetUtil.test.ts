import { describe, expect, it } from 'vitest';
import type { BATTLESHIPCell, BATTLESHIPGameState, BATTLESHIPPlacement, BATTLESHIPShotRecord } from '@shared/battleshipIpc';
import { placementCells } from '@shared/battleshipIpc';
import {
  canFireAt,
  clampedPlacementAt,
  coordName,
  enemyShips,
  enemySunkShips,
  lastShotBy,
  placementOfShip,
  rotated,
  shipAt,
} from './fleetUtil';

const empty = (): BATTLESHIPCell[][] => Array.from({ length: 10 }, () => Array<BATTLESHIPCell>(10).fill('empty'));

function game(over: Partial<BATTLESHIPGameState> = {}): BATTLESHIPGameState {
  return {
    gameId: 'g',
    characterId: 'c',
    status: 'active',
    playerGrid: { cells: empty(), ships: [] },
    aiVisibleGrid: { cells: empty(), ships: [] },
    turn: 'player',
    aiThinking: false,
    pendingAiMove: null,
    result: null,
    history: [],
    shotsFired: 0,
    playerShots: 0,
    aiShots: 0,
    playerStarts: true,
    playerFleetPlaced: true,
    aiFleet: 'ready',
    aiTurnFailed: null,
    ...over,
  };
}

function mark(cells: BATTLESHIPCell[][], p: BATTLESHIPPlacement, v: BATTLESHIPCell): void {
  for (const c of placementCells(p)) cells[c.row][c.col] = v;
}

describe('coordName / placementOfShip', () => {
  it('names cells with a row letter and a 1-based column', () => {
    expect(coordName({ row: 0, col: 0 })).toBe('A1');
    expect(coordName({ row: 9, col: 9 })).toBe('J10');
  });

  it('recovers anchor and orientation from a ship cell list', () => {
    const v = { name: 'cruiser' as const, size: 3, sunk: false, cells: [{ row: 4, col: 2 }, { row: 5, col: 2 }, { row: 6, col: 2 }] };
    expect(placementOfShip(v)).toEqual({ name: 'cruiser', row: 4, col: 2, horizontal: false });
  });
});

describe('enemySunkShips', () => {
  it('rebuilds a sunk enemy ship from its sunk cells and the shot record', () => {
    const g = game();
    const p: BATTLESHIPPlacement = { name: 'cruiser', row: 2, col: 4, horizontal: true };
    mark(g.aiVisibleGrid.cells, p, 'sunk');
    g.history = [
      { by: 'player', row: 2, col: 4, hit: true, sunkShip: null },
      { by: 'ai', row: 0, col: 0, hit: false, sunkShip: null },
      { by: 'player', row: 2, col: 5, hit: true, sunkShip: null },
      { by: 'ai', row: 0, col: 1, hit: false, sunkShip: null },
      { by: 'player', row: 2, col: 6, hit: true, sunkShip: 'cruiser' },
    ];
    expect(enemySunkShips(g)).toEqual([p]);
  });

  it('splits two sunk ships lying end to end', () => {
    const g = game();
    const a: BATTLESHIPPlacement = { name: 'destroyer', row: 7, col: 1, horizontal: true };
    const b: BATTLESHIPPlacement = { name: 'submarine', row: 7, col: 3, horizontal: true };
    mark(g.aiVisibleGrid.cells, a, 'sunk');
    mark(g.aiVisibleGrid.cells, b, 'sunk');
    g.history = [
      { by: 'player', row: 7, col: 2, hit: true, sunkShip: 'destroyer' },
      { by: 'player', row: 7, col: 5, hit: true, sunkShip: 'submarine' },
    ];
    const got = enemySunkShips(g);
    expect(got).toHaveLength(2);
    expect(got).toContainEqual(b);
    // The destroyer cannot overlap the submarine once that one is claimed.
    const cells = got.flatMap((p) => placementCells(p).map((c) => `${c.row},${c.col}`));
    expect(new Set(cells).size).toBe(5);
  });

  it("ignores the companion's sink records (history.by)", () => {
    const g = game();
    const p: BATTLESHIPPlacement = { name: 'destroyer', row: 0, col: 0, horizontal: true };
    // Same cells sunk on both grids; only the player's record may claim the enemy one.
    mark(g.playerGrid.cells, p, 'sunk');
    mark(g.aiVisibleGrid.cells, p, 'sunk');
    g.history = [{ by: 'ai', row: 0, col: 1, hit: true, sunkShip: 'destroyer' }];
    expect(enemySunkShips(g)).toEqual([]);
    g.history.push({ by: 'player', row: 0, col: 0, hit: true, sunkShip: 'destroyer' });
    expect(enemySunkShips(g)).toEqual([p]);
  });
});

describe('enemyShips', () => {
  it('mid-game: only the rebuilt sunk ships', () => {
    const g = game();
    const p: BATTLESHIPPlacement = { name: 'destroyer', row: 4, col: 4, horizontal: false };
    mark(g.aiVisibleGrid.cells, p, 'sunk');
    g.history = [{ by: 'player', row: 5, col: 4, hit: true, sunkShip: 'destroyer' }];
    expect(enemyShips(g)).toEqual([{ placement: p, sunk: true }]);
  });

  it('game over: the revealed fleet from main, afloat ships included', () => {
    const g = game({ status: 'ended' });
    const sunk: BATTLESHIPPlacement = { name: 'destroyer', row: 4, col: 4, horizontal: false };
    const afloat: BATTLESHIPPlacement = { name: 'carrier', row: 0, col: 0, horizontal: true };
    mark(g.aiVisibleGrid.cells, sunk, 'sunk');
    g.history = [{ by: 'player', row: 5, col: 4, hit: true, sunkShip: 'destroyer' }];
    g.aiVisibleGrid.ships = [
      { name: 'destroyer', size: 2, sunk: true, cells: placementCells(sunk) },
      { name: 'carrier', size: 5, sunk: false, cells: placementCells(afloat) },
    ];
    expect(enemyShips(g)).toEqual([
      { placement: sunk, sunk: true },
      { placement: afloat, sunk: false },
    ]);
  });
});

describe('placement helpers', () => {
  it('slides a ship dropped over an edge back onto the board', () => {
    expect(clampedPlacementAt('carrier', { row: 3, col: 8 }, true, 0)).toEqual({ name: 'carrier', row: 3, col: 5, horizontal: true });
    expect(clampedPlacementAt('carrier', { row: 9, col: 0 }, false, 2)).toEqual({ name: 'carrier', row: 5, col: 0, horizontal: false });
  });

  it('rotates about the grabbed segment, then about the anchor, else refuses', () => {
    const ship: BATTLESHIPPlacement = { name: 'cruiser', row: 4, col: 4, horizontal: true };
    expect(rotated([ship], ship, 1)).toEqual({ name: 'cruiser', row: 3, col: 5, horizontal: false });
    const blocker: BATTLESHIPPlacement = { name: 'destroyer', row: 3, col: 5, horizontal: false };
    expect(rotated([ship, blocker], ship, 1)).toEqual({ name: 'cruiser', row: 4, col: 4, horizontal: false });
    const wall: BATTLESHIPPlacement = { name: 'carrier', row: 5, col: 3, horizontal: true };
    expect(rotated([ship, blocker, wall], ship, 1)).toBeNull();
    expect(shipAt([ship], { row: 4, col: 6 })?.name).toBe('cruiser');
    expect(shipAt([ship], { row: 5, col: 6 })).toBeNull();
  });
});

describe('lastShotBy / canFireAt', () => {
  const shot = (by: 'player' | 'ai', row: number, col: number): BATTLESHIPShotRecord => ({ by, row, col, hit: false, sunkShip: null });

  it('reads the shooter from history.by', () => {
    const g = game();
    g.history = [shot('ai', 1, 1), shot('player', 2, 2), shot('ai', 3, 3)];
    expect(lastShotBy(g, 'ai')).toEqual({ row: 3, col: 3 });
    expect(lastShotBy(g, 'player')).toEqual({ row: 2, col: 2 });
    // Not strictly alternating (e.g. a retried turn): still exact.
    g.history.push(shot('player', 4, 4), shot('player', 5, 5));
    expect(lastShotBy(g, 'player')).toEqual({ row: 5, col: 5 });
    expect(lastShotBy(game(), 'ai')).toBeNull();
  });

  it('only allows firing at untouched enemy cells', () => {
    const g = game();
    g.aiVisibleGrid.cells[0][0] = 'miss';
    expect(canFireAt(g, { row: 0, col: 0 })).toBe(false);
    expect(canFireAt(g, { row: 0, col: 1 })).toBe(true);
  });
});
