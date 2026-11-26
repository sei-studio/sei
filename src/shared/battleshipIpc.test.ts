import { describe, expect, it } from 'vitest';
import {
  BATTLESHIP_SHIP_NAMES,
  fleetCells,
  placementCells,
  placementFits,
  randomFleetPlacement,
} from './battleshipIpc';

describe('Battleship placement helpers', () => {
  it('lays a horizontal ship to the right and a vertical one down', () => {
    expect(placementCells({ name: 'destroyer', row: 2, col: 3, horizontal: true })).toEqual([
      { row: 2, col: 3 },
      { row: 2, col: 4 },
    ]);
    expect(placementCells({ name: 'destroyer', row: 2, col: 3, horizontal: false })).toEqual([
      { row: 2, col: 3 },
      { row: 3, col: 3 },
    ]);
  });

  it('rejects ships that leave the board or overlap a taken cell', () => {
    const horizontal = { name: 'carrier', row: 0, col: 6, horizontal: true } as const;
    expect(placementFits(horizontal, [])).toBe(false);
    expect(placementFits({ ...horizontal, col: 5 }, [])).toBe(true);

    const vertical = { name: 'battleship', row: 7, col: 0, horizontal: false } as const;
    expect(placementFits(vertical, [])).toBe(false);
    expect(placementFits({ ...vertical, row: 6 }, [])).toBe(true);

    expect(placementFits({ name: 'destroyer', row: 1, col: 1, horizontal: true }, [
      { row: 1, col: 2 },
    ])).toBe(false);
  });

  it('builds a full random fleet that fits without overlaps', () => {
    for (let i = 0; i < 50; i++) {
      const fleet = randomFleetPlacement();
      expect(fleet.map((p) => p.name).sort()).toEqual([...BATTLESHIP_SHIP_NAMES].sort());

      const seen = new Set<string>();
      for (const cell of fleetCells(fleet)) {
        const key = `${cell.row}:${cell.col}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(cell.row).toBeGreaterThanOrEqual(0);
        expect(cell.row).toBeLessThan(10);
        expect(cell.col).toBeGreaterThanOrEqual(0);
        expect(cell.col).toBeLessThan(10);
      }
    }
  });
});
