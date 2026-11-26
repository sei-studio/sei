/**
 * Pure helpers for the Fleet Battle view (no three.js, no React).
 *
 * The authoritative game lives in main (src/main/battleship/). The player's
 * view of the enemy (`aiVisibleGrid`) carries cell states only, never ships,
 * so a sunk enemy ship has to be found again from its 'sunk' cells and the
 * shot history before it can be drawn; everything else here is draft and
 * placement bookkeeping for the drag-and-drop fleet setup.
 */

import {
  BATTLESHIP_COLS,
  BATTLESHIP_ROWS,
  SHIP_SIZES,
  placementCells,
  placementFits,
  type BATTLESHIPCell,
  type BATTLESHIPGameState,
  type BATTLESHIPPlacement,
  type BATTLESHIPShip,
  type BATTLESHIPShipName,
} from '@shared/battleshipIpc';

export interface GridPos {
  row: number;
  col: number;
}

export const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

/** "B7" style coordinate for a cell (rows are letters, columns numbers). */
export function coordName(p: GridPos): string {
  return `${ROW_LETTERS[p.row] ?? '?'}${p.col + 1}`;
}

/** A placed ship's placement (anchor + orientation) from its cell list. */
export function placementOfShip(ship: BATTLESHIPShip): BATTLESHIPPlacement {
  const cells = ship.cells;
  const row = Math.min(...cells.map((c) => c.row));
  const col = Math.min(...cells.map((c) => c.col));
  const horizontal = cells.length < 2 || cells[0].row === cells[1].row;
  return { name: ship.name, row, col, horizontal };
}

/**
 * Enemy ships the player has sunk, rebuilt from the visible grid. Each shot
 * record that sank a ship names it; the ship is a straight run of 'sunk'
 * cells of that ship's length through the shot cell. Ships lying end to end
 * make single records ambiguous, so this picks the assignment of runs to
 * records that places the most ships without overlap, then the one with the
 * most runs that end exactly (no further 'sunk' cell beyond either end).
 */
export function enemySunkShips(game: BATTLESHIPGameState): BATTLESHIPPlacement[] {
  const grid = game.aiVisibleGrid.cells;
  const at = (r: number, c: number): BATTLESHIPCell | undefined => grid[r]?.[c];
  const seenNames = new Set<BATTLESHIPShipName>();
  const options: Array<Array<{ p: BATTLESHIPPlacement; cells: string[]; exact: boolean }>> = [];
  for (const rec of game.history) {
    if (!rec.sunkShip || seenNames.has(rec.sunkShip)) continue;
    if (at(rec.row, rec.col) !== 'sunk') continue;
    // The AI sinking one of the player's ships writes a record too; that one
    // belongs to the player's grid, where the named ship holds the cell.
    const own = game.playerGrid.ships.find((s) => s.name === rec.sunkShip);
    const ownHere = !!own?.sunk && own.cells.some((c) => c.row === rec.row && c.col === rec.col);
    const size = SHIP_SIZES[rec.sunkShip];
    const cands: Array<{ p: BATTLESHIPPlacement; cells: string[]; exact: boolean }> = [];
    for (const horizontal of [true, false]) {
      for (let k = 0; k < size; k++) {
        const p: BATTLESHIPPlacement = {
          name: rec.sunkShip,
          row: horizontal ? rec.row : rec.row - k,
          col: horizontal ? rec.col - k : rec.col,
          horizontal,
        };
        const cells = placementCells(p);
        if (!cells.every((c) => at(c.row, c.col) === 'sunk')) continue;
        const before = horizontal ? at(p.row, p.col - 1) : at(p.row - 1, p.col);
        const last = cells[cells.length - 1];
        const after = horizontal ? at(last.row, last.col + 1) : at(last.row + 1, last.col);
        const exact = before !== 'sunk' && after !== 'sunk';
        if (ownHere && !exact) continue;
        cands.push({ p, cells: cells.map((c) => `${c.row},${c.col}`), exact });
      }
    }
    if (!cands.length) continue;
    seenNames.add(rec.sunkShip);
    options.push(cands);
  }

  // Tiny search (at most five ships, ten runs each).
  let best: { placed: BATTLESHIPPlacement[]; exact: number } = { placed: [], exact: -1 };
  const used = new Set<string>();
  const chosen: BATTLESHIPPlacement[] = [];
  const walk = (i: number, exact: number): void => {
    if (i === options.length) {
      if (chosen.length > best.placed.length || (chosen.length === best.placed.length && exact > best.exact)) {
        best = { placed: chosen.slice(), exact };
      }
      return;
    }
    for (const cand of options[i]) {
      if (cand.cells.some((c) => used.has(c))) continue;
      for (const c of cand.cells) used.add(c);
      chosen.push(cand.p);
      walk(i + 1, exact + (cand.exact ? 1 : 0));
      chosen.pop();
      for (const c of cand.cells) used.delete(c);
    }
    walk(i + 1, exact);
  };
  walk(0, 0);
  return best.placed;
}

/** The fleet's placement with `name` removed. */
export function without(draft: BATTLESHIPPlacement[], name: BATTLESHIPShipName): BATTLESHIPPlacement[] {
  return draft.filter((p) => p.name !== name);
}

/** The placed ship covering a cell, if any. */
export function shipAt(draft: BATTLESHIPPlacement[], pos: GridPos): BATTLESHIPPlacement | null {
  return draft.find((p) => placementCells(p).some((c) => c.row === pos.row && c.col === pos.col)) ?? null;
}

/** Index of a cell along a placed ship (0 = anchor), or -1. */
export function segmentOf(p: BATTLESHIPPlacement, pos: GridPos): number {
  return placementCells(p).findIndex((c) => c.row === pos.row && c.col === pos.col);
}

/**
 * The placement for `name` held by segment `grab` with that segment over
 * `pos`. May fall off the board; check with placementFits.
 */
export function placementAt(
  name: BATTLESHIPShipName,
  pos: GridPos,
  horizontal: boolean,
  grab: number,
): BATTLESHIPPlacement {
  return {
    name,
    row: horizontal ? pos.row : pos.row - grab,
    col: horizontal ? pos.col - grab : pos.col,
    horizontal,
  };
}

/**
 * Same as placementAt, but slid back onto the board when the ship would hang
 * over an edge (dropping a long ship near the border should not just fail).
 */
export function clampedPlacementAt(
  name: BATTLESHIPShipName,
  pos: GridPos,
  horizontal: boolean,
  grab: number,
): BATTLESHIPPlacement {
  const p = placementAt(name, pos, horizontal, grab);
  const size = SHIP_SIZES[name];
  const maxRow = horizontal ? BATTLESHIP_ROWS - 1 : BATTLESHIP_ROWS - size;
  const maxCol = horizontal ? BATTLESHIP_COLS - size : BATTLESHIP_COLS - 1;
  return { ...p, row: Math.min(Math.max(p.row, 0), maxRow), col: Math.min(Math.max(p.col, 0), maxCol) };
}

/**
 * Rotate a placed ship in place: first about its grabbed segment, then about
 * its anchor. Null when neither fits.
 */
export function rotated(
  draft: BATTLESHIPPlacement[],
  p: BATTLESHIPPlacement,
  grab: number,
): BATTLESHIPPlacement | null {
  const others = placementCellsOf(without(draft, p.name));
  const pivot = placementCells(p)[Math.max(0, grab)] ?? { row: p.row, col: p.col };
  const candidates = [
    clampedPlacementAt(p.name, pivot, !p.horizontal, grab),
    { ...p, horizontal: !p.horizontal },
  ];
  return candidates.find((c) => placementFits(c, others)) ?? null;
}

export function placementCellsOf(draft: BATTLESHIPPlacement[]): GridPos[] {
  return draft.flatMap((p) => placementCells(p));
}

/** True when a player shot at `pos` on the enemy grid is still possible. */
export function canFireAt(game: BATTLESHIPGameState, pos: GridPos): boolean {
  return game.aiVisibleGrid.cells[pos.row]?.[pos.col] === 'empty';
}

export type Shooter = 'player' | 'ai';

/**
 * Who fired each shot in `game.history` (player and companion shots share
 * one list). Turns strictly alternate, so only the first shooter is unknown;
 * pick the order whose shots all match the grid they landed on (a player shot
 * is a non-empty cell of the enemy grid, a companion shot one of the player's
 * grid). Falls back to counting back from whose turn it is.
 */
export function shotOwners(game: BATTLESHIPGameState): Shooter[] {
  const n = game.history.length;
  const order = (first: Shooter): Shooter[] =>
    game.history.map((_, i) => (i % 2 === 0 ? first : first === 'player' ? 'ai' : 'player'));
  const fired = (s: Shooter, r: number, c: number): boolean => {
    const v = (s === 'player' ? game.aiVisibleGrid : game.playerGrid).cells[r]?.[c];
    return v === 'hit' || v === 'miss' || v === 'sunk';
  };
  const fits = (owners: Shooter[]): boolean => game.history.every((h, i) => fired(owners[i], h.row, h.col));
  const a = order('player');
  const b = order('ai');
  const fa = fits(a);
  const fb = fits(b);
  if (fa && !fb) return a;
  if (fb && !fa) return b;
  // Ambiguous (or inconsistent): the last shot was by whoever is NOT up now.
  if (n === 0) return [];
  const lastBy: Shooter = game.turn === 'player' ? 'ai' : 'player';
  const first: Shooter = (n - 1) % 2 === 0 ? lastBy : lastBy === 'player' ? 'ai' : 'player';
  return order(first);
}

/** The companion's most recent shot, if any. */
export function lastShotBy(game: BATTLESHIPGameState, who: Shooter): GridPos | null {
  const owners = shotOwners(game);
  for (let i = game.history.length - 1; i >= 0; i--) {
    if (owners[i] === who) return { row: game.history[i].row, col: game.history[i].col };
  }
  return null;
}
