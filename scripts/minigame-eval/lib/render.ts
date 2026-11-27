/**
 * Readable transcripts of Test 1 games, for people and for the judge. The
 * judge version adds what the learner could not see: the cell each of the
 * companion's shots landed on and the board after every Four in a Row move.
 */
import { placementCells, type BATTLESHIPPlacement, type BATTLESHIPShotRecord } from '../../../src/shared/battleshipIpc';
import type { CONNECT4MoveRecord } from '../../../src/shared/connect4Ipc';
import { empty, play } from './connect4';

export interface TeachRow {
  game: 'bs' | 'c4';
  k: number;
  character: string;
  winner: string | null;
  playerColor?: 'r' | 'y';
  aiFleet?: BATTLESHIPPlacement[] | null;
  playerFleet?: BATTLESHIPPlacement[];
  history: Array<BATTLESHIPShotRecord | CONNECT4MoveRecord>;
  events: Array<{ ts: number; who: string; text: string }>;
  [k: string]: unknown;
}

const cellName = (r: number, c: number) => `${String.fromCharCode(65 + r)}${c + 1}`;

function fleetText(f: BATTLESHIPPlacement[] | null | undefined): string {
  if (!f) return '(unknown)';
  return f
    .map((p) => {
      const cs = placementCells(p);
      return `${p.name} ${cellName(cs[0].row, cs[0].col)}-${cellName(cs[cs.length - 1].row, cs[cs.length - 1].col)}`;
    })
    .join(', ');
}

function boardText(b: ReturnType<typeof empty>): string {
  return [...b.map((r) => '    | ' + r.map((c) => (c === 'r' ? 'R' : c === 'y' ? 'Y' : '.')).join(' ') + ' |'), '      1 2 3 4 5 6 7'].join('\n');
}

/** `judge`: add the hidden truth (shot cells, boards). `md`: markdown styling. */
export function renderTeach(row: TeachRow, opts: { judge?: boolean; md?: boolean } = {}): string {
  const name = row.character;
  const out: string[] = [];
  const md = opts.md === true;
  if (row.game === 'bs') {
    out.push(`Fleet Battle, ${name} vs Ren (beginner). Winner: ${row.winner ?? 'none'}.`);
    out.push(`${name}'s fleet (hidden from Ren): ${fleetText(row.aiFleet)}`);
    out.push(`Ren's fleet: ${fleetText(row.playerFleet)}`);
  } else {
    out.push(`Four in a Row, ${name} vs Ren (beginner). Ren plays ${row.playerColor === 'r' ? 'red (R), moves first' : 'yellow (Y), moves second'}. Winner: ${row.winner ?? 'none'}.`);
  }
  out.push('');
  const aiShots = row.game === 'bs' ? (row.history as BATTLESHIPShotRecord[]).filter((h) => h.by === 'ai') : [];
  let aiIdx = 0;
  const c4 = row.game === 'c4' ? (row.history as CONNECT4MoveRecord[]) : [];
  let c4Idx = 0;
  let board = empty();
  for (const e of row.events) {
    if (e.who === 'note') {
      if (e.text.startsWith('(learner call failed')) continue;
      out.push(md ? `> *Ren (private note): ${e.text}*` : `  (Ren private note: ${e.text})`);
      continue;
    }
    if (e.who === 'player') { out.push(md ? `**Ren:** ${e.text}` : `Ren: ${e.text}`); continue; }
    if (e.who === 'companion') { out.push(md ? `**${name}:** ${e.text}` : `${name}: ${e.text}`); continue; }
    let text = e.text;
    if (row.game === 'bs' && opts.judge && /^\S+ (missed|hit your fleet|sank your)/.test(text) && text.startsWith(name)) {
      const h = aiShots[aiIdx++];
      if (h) text += ` (shot at ${cellName(h.row, h.col)})`;
    }
    out.push(md ? `*[screen] ${text}*` : `[screen] ${text}`);
    if (row.game === 'c4' && opts.judge && /disc dropped into column/.test(text)) {
      const h = c4[c4Idx++];
      if (h) {
        board = play(board, h.column, h.color);
        out.push(md ? '```\n' + boardText(board) + '\n```' : boardText(board));
      }
    }
  }
  return out.join('\n');
}
