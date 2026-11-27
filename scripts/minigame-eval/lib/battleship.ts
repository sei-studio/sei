/**
 * Fleet Battle helpers for the eval: seeded fleets, the fixed baseline bot
 * (hunt/target with parity), shot metrics, and the player's-eye board text
 * for the learner simulator.
 */
import {
  BATTLESHIP_SHIP_NAMES,
  SHIP_SIZES,
  battleshipCellName,
  fleetProblem,
  placementCells,
  placementFits,
  type BATTLESHIPGameState,
  type BATTLESHIPPlacement,
  type BATTLESHIPShotRecord,
} from '../../../src/shared/battleshipIpc';
import { rng } from './env';

const N = 10;

/** A legal fleet from a seed (the eval's stand-in for the player's Random button). */
export function seededFleet(seed: number): BATTLESHIPPlacement[] {
  const rand = rng(seed * 7919 + 17);
  for (let tries = 0; tries < 100; tries++) {
    const fleet: BATTLESHIPPlacement[] = [];
    let occ: Array<{ row: number; col: number }> = [];
    for (const name of BATTLESHIP_SHIP_NAMES) {
      const size = SHIP_SIZES[name];
      for (let a = 0; a < 400; a++) {
        const horizontal = rand() < 0.5;
        const row = Math.floor(rand() * (horizontal ? N : N - size + 1));
        const col = Math.floor(rand() * (horizontal ? N - size + 1 : N));
        const p: BATTLESHIPPlacement = { name, row, col, horizontal };
        if (!placementFits(p, occ)) continue;
        fleet.push(p);
        occ = occ.concat(placementCells(p));
        break;
      }
    }
    if (fleet.length === 5 && !fleetProblem(fleet)) return fleet;
  }
  throw new Error('seededFleet failed');
}

export type ViewCell = 'unknown' | 'miss' | 'hit' | 'sunk';

/**
 * The fixed baseline: hunt on a parity checkerboard (seeded order), and once
 * a hit is open, target its neighbours (extending along a line of two or
 * more hits first). Deterministic per seed and per sequence of results.
 */
export class HuntTargetBot {
  view: ViewCell[][] = Array.from({ length: N }, () => Array<ViewCell>(N).fill('unknown'));
  private order: Array<[number, number]>;
  constructor(seed: number) {
    const rand = rng(seed * 104729 + 3);
    const cells: Array<[number, number]> = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push([r, c]);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    // Parity cells first, then the rest (only reached if ships hide oddly).
    this.order = [...cells.filter(([r, c]) => (r + c) % 2 === 0), ...cells.filter(([r, c]) => (r + c) % 2 === 1)];
  }

  /** Feed a result back (sunkCells = every cell of a ship that just sank). */
  observe(row: number, col: number, hit: boolean, sunkCells: Array<{ row: number; col: number }> | null): void {
    this.view[row][col] = hit ? 'hit' : 'miss';
    if (sunkCells) for (const c of sunkCells) this.view[c.row][c.col] = 'sunk';
  }

  next(): [number, number] {
    const open: Array<[number, number]> = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (this.view[r][c] === 'hit') open.push([r, c]);
    if (open.length) {
      const unknown = (r: number, c: number): boolean => r >= 0 && r < N && c >= 0 && c < N && this.view[r][c] === 'unknown';
      // Lines of two or more open hits: extend at either end.
      for (const [r, c] of open) {
        for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
          if (r + dr < N && c + dc < N && this.view[r + dr][c + dc] === 'hit') {
            let a = 0;
            while (r - (a + 1) * dr >= 0 && c - (a + 1) * dc >= 0 && this.view[r - (a + 1) * dr][c - (a + 1) * dc] === 'hit') a++;
            let b = 1;
            while (r + (b + 1) * dr < N && c + (b + 1) * dc < N && this.view[r + (b + 1) * dr][c + (b + 1) * dc] === 'hit') b++;
            const ends: Array<[number, number]> = [
              [r - (a + 1) * dr, c - (a + 1) * dc],
              [r + (b + 1) * dr, c + (b + 1) * dc],
            ];
            for (const [er, ec] of ends) if (unknown(er, ec)) return [er, ec];
          }
        }
      }
      for (const [r, c] of open) {
        for (const [dr, dc] of [[-1, 0], [0, 1], [1, 0], [0, -1]] as const) {
          if (unknown(r + dr, c + dc)) return [r + dr, c + dc];
        }
      }
    }
    for (const [r, c] of this.order) if (this.view[r][c] === 'unknown') return [r, c];
    throw new Error('no cell left');
  }
}

/** Shots the baseline needs to sink a fleet (offline, same rules as the service). */
export function baselineShotsToSink(fleet: BATTLESHIPPlacement[], seed: number): number {
  const bot = new HuntTargetBot(seed);
  const ships = fleet.map((p) => ({ cells: placementCells(p), hits: 0 }));
  let sunk = 0;
  let shots = 0;
  while (sunk < ships.length) {
    const [r, c] = bot.next();
    shots++;
    const ship = ships.find((s) => s.cells.some((x) => x.row === r && x.col === c));
    if (!ship) {
      bot.observe(r, c, false, null);
      continue;
    }
    ship.hits++;
    const sank = ship.hits === ship.cells.length;
    if (sank) sunk++;
    bot.observe(r, c, true, sank ? ship.cells : null);
  }
  return shots;
}

export interface BsShotMetrics {
  shots: number;
  hits: number;
  hitRate: number;
  /** Shots taken while an unsunk hit was open on the board. */
  openHitShots: number;
  /** ... of which landed orthogonally next to an open hit. */
  followUps: number;
  followUpRate: number;
  /** Shots after the first hit on a ship until it sank, summed. */
  sinkSpans: number[];
  /** Hunt shots (no open hit) that were on the 2-parity checkerboard of the first. */
  huntShots: number;
}

/**
 * Metrics for one shooter over a finished history. `targetFleet` is the
 * fleet being shot at (known to the eval).
 */
export function shotMetrics(
  history: BATTLESHIPShotRecord[],
  by: 'ai' | 'player',
  targetFleet: BATTLESHIPPlacement[],
): BsShotMetrics {
  const view: ViewCell[][] = Array.from({ length: N }, () => Array<ViewCell>(N).fill('unknown'));
  const ships = targetFleet.map((p) => ({ name: p.name, cells: placementCells(p) }));
  const firstHitAt = new Map<string, number>();
  const sinkSpans: number[] = [];
  let shots = 0;
  let hits = 0;
  let openHitShots = 0;
  let followUps = 0;
  let huntShots = 0;
  for (const h of history) {
    if (h.by !== by) continue;
    const open: Array<[number, number]> = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (view[r][c] === 'hit') open.push([r, c]);
    shots++;
    if (open.length) {
      openHitShots++;
      if (open.some(([r, c]) => Math.abs(r - h.row) + Math.abs(c - h.col) === 1)) followUps++;
    } else huntShots++;
    if (h.hit) {
      hits++;
      view[h.row][h.col] = 'hit';
      const ship = ships.find((s) => s.cells.some((x) => x.row === h.row && x.col === h.col));
      if (ship && !firstHitAt.has(ship.name)) firstHitAt.set(ship.name, shots);
      if (h.sunkShip) {
        const s = ships.find((x) => x.name === h.sunkShip);
        if (s) for (const c of s.cells) view[c.row][c.col] = 'sunk';
        const first = firstHitAt.get(h.sunkShip);
        if (first !== undefined) sinkSpans.push(shots - first);
      }
    } else view[h.row][h.col] = 'miss';
  }
  return {
    shots,
    hits,
    hitRate: shots ? hits / shots : 0,
    openHitShots,
    followUps,
    followUpRate: openHitShots ? followUps / openHitShots : NaN,
    sinkSpans,
    huntShots,
  };
}

// ── what the player sees ───────────────────────────────────────────────────

const header = `    ${Array.from({ length: N }, (_, i) => String(i + 1).padStart(2, ' ')).join(' ')}`;

/** The player's own waters as the panel draws them. */
export function ownWatersText(s: BATTLESHIPGameState): string {
  const rows = s.playerGrid.cells.map((row, r) => {
    const cells = row.map((c) => (c === 'ship' ? ' S' : c === 'hit' ? ' X' : c === 'sunk' ? ' #' : c === 'miss' ? ' o' : ' .'));
    return `${String.fromCharCode(65 + r)}  ${cells.join(' ')}`;
  });
  return [header, ...rows].join('\n');
}

/** The enemy waters as the panel draws them (only shot results, sunk ships). */
export function enemyWatersText(s: BATTLESHIPGameState): string {
  const rows = s.aiVisibleGrid.cells.map((row, r) => {
    const cells = row.map((c) => (c === 'hit' ? ' X' : c === 'sunk' ? ' #' : c === 'miss' ? ' o' : ' .'));
    return `${String.fromCharCode(65 + r)}  ${cells.join(' ')}`;
  });
  return [header, ...rows].join('\n');
}

export function fleetLine(fleet: BATTLESHIPPlacement[]): string {
  return fleet
    .map((p) => {
      const cells = placementCells(p);
      const a = cells[0];
      const b = cells[cells.length - 1];
      return `${p.name} ${battleshipCellName(a.row, a.col)}-${battleshipCellName(b.row, b.col)}`;
    })
    .join(', ');
}

/** Parse the place_fleet() tool input the character sent (same rules as the service). */
export function parsePlaceFleet(input: unknown): BATTLESHIPPlacement[] | null {
  const ships = (input as { ships?: Array<{ ship?: string; start?: string; direction?: string }> })?.ships;
  if (!Array.isArray(ships)) return null;
  const out: BATTLESHIPPlacement[] = [];
  for (const s of ships) {
    const m = /^\s*([A-Ja-j])\s*(10|[1-9])\s*$/.exec(String(s.start ?? ''));
    if (!m) return null;
    out.push({
      name: String(s.ship).toLowerCase() as BATTLESHIPPlacement['name'],
      row: m[1].toUpperCase().charCodeAt(0) - 65,
      col: Number(m[2]) - 1,
      horizontal: String(s.direction).toLowerCase() === 'right',
    });
  }
  return fleetProblem(out) ? null : out;
}
