#!/usr/bin/env node
/**
 * Calibration harness: plays CCE personas against Stockfish UCI_Elo anchors
 * and reports a measured performance rating per persona Elo.
 *
 * The paper calls for 100 games per persona; that is hours of compute, so
 * this harness is shipped but NOT run as part of the build or tests. Use it
 * to tune the constants in src/formulas.js.
 *
 *   node scripts/calibrate.mjs --elo 800 --games 20 --anchor 1320
 *
 * The LLM normally picks among the 4 candidates by personality; to measure
 * the strength floor/ceiling of the candidate set itself, this harness picks
 * uniformly at random among them (an LLM-neutral stand-in).
 */

import { Chess } from 'chess.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CharacterChessEngine, mulberry32 } from '../src/index.js';

const { values: args } = parseArgs({
  options: {
    elo: { type: 'string', default: '1200' },
    games: { type: 'string', default: '10' },
    anchor: { type: 'string', default: '1320' }, // stockfish UCI_Elo floor
    model: {
      type: 'string',
      default: path.join(homedir(), '.sei-dev', 'cce', 'maia3-5m.onnx'),
    },
    seed: { type: 'string', default: '1' },
  },
});

const personaElo = Number(args.elo);
const games = Number(args.games);
const anchorElo = Number(args.anchor);
const rng = mulberry32(Number(args.seed));

const engine = await CharacterChessEngine.create({ maiaModelPath: args.model, rng });

let wins = 0;
let draws = 0;

for (let g = 0; g < games; g++) {
  const chess = new Chess();
  const cceIsWhite = g % 2 === 0;
  let plies = 0;
  while (!chess.isGameOver() && plies < 300) {
    const cceToMove = chess.turn() === (cceIsWhite ? 'w' : 'b');
    if (cceToMove) {
      const { candidates } = await engine.candidateSet(chess.fen(), { elo: personaElo });
      const pick = candidates[Math.floor(rng() * candidates.length)];
      chess.move({ from: pick.uci.slice(0, 2), to: pick.uci.slice(2, 4), promotion: pick.uci[4] });
    } else {
      const best = await engine.stockfish.bestMoveAtElo(chess.fen(), anchorElo, {
        movetimeMs: 60,
      });
      chess.move({ from: best.slice(0, 2), to: best.slice(2, 4), promotion: best[4] });
    }
    plies++;
  }
  let result;
  if (chess.isCheckmate()) {
    const cceDelivered = chess.turn() !== (cceIsWhite ? 'w' : 'b');
    result = cceDelivered ? 'win' : 'loss';
    if (cceDelivered) wins++;
  } else {
    result = 'draw';
    draws++;
  }
  console.log(`game ${g + 1}/${games}: ${result} (${plies} plies, cce as ${cceIsWhite ? 'white' : 'black'})`);
}

const score = (wins + draws / 2) / games;
const safe = Math.min(Math.max(score, 0.01), 0.99);
const perf = Math.round(anchorElo + 400 * Math.log10(safe / (1 - safe)));
console.log(
  `\npersona ${personaElo}: score ${(score * 100).toFixed(0)}% vs UCI_Elo ${anchorElo} -> performance ~${perf}`,
);

await engine.dispose();
