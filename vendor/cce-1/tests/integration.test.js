/**
 * End-to-end candidate generation against the real Maia-3 model and the
 * bundled Stockfish. Skipped when the model file is absent (CI without the
 * 21 MB download); locally the dev copy lives at ~/.sei-dev/cce/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';

const MODEL =
  process.env.CCE_MAIA_MODEL ??
  path.join(homedir(), '.sei-dev', 'cce', 'maia3-5m.onnx');

const hasModel = existsSync(MODEL);

test('candidateSet end to end', { skip: !hasModel && 'maia model not present' }, async () => {
  const { CharacterChessEngine, mulberry32 } = await import('../src/index.js');
  const engine = await CharacterChessEngine.create({
    maiaModelPath: MODEL,
    rng: mulberry32(42),
  });
  try {
    const START = new Chess().fen();

    const weak = await engine.candidateSet(START, { elo: 400 });
    assert.equal(weak.candidates.length, 4);
    assert.equal(weak.toMove, 'w');
    // A 400 sees only its own move: no imagined line.
    for (const c of weak.candidates) {
      assert.equal(c.line, null);
      assert.ok(c.sentence.length > 0);
      assert.ok(c.san.length > 0);
    }
    // A 400's band is the full range.
    assert.equal(weak.macro.band.lo, 0);
    assert.equal(weak.macro.band.hi, 100);
    assert.match(weak.macro.text, /cannot tell who is winning/);

    const strong = await engine.candidateSet(START, { elo: 2000 });
    assert.equal(strong.candidates.length, 4);
    // A 2000 imagines several plies.
    assert.ok(strong.candidates.some((c) => c.line && c.line.sans.length > 2));
    assert.ok(strong.macro.band.hi - strong.macro.band.lo <= 20);

    // Black-to-move positions work (mirroring path).
    const c = new Chess();
    c.move('e4');
    const black = await engine.candidateSet(c.fen(), { elo: 1500 });
    assert.equal(black.toMove, 'b');
    const legal = new Set(
      c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')),
    );
    for (const cand of black.candidates) {
      assert.ok(legal.has(cand.uci), `${cand.uci} is not legal after 1.e4`);
    }
  } finally {
    await engine.dispose();
  }
});
