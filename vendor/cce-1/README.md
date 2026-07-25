# CCE-1: Character Chess Engine

Skill-conditioned move generation with LLM personality selection, Elo 400 to 2000.

This is the reference implementation of the CCE-1 design ([cce-1.pdf](./cce-1.pdf), included in this repo). It powers the chess minigame in [Sei](https://github.com/sei-studio/sei).

## Problem

AI game companions must play chess as a believable character *and* as a believable player at a target rating. Standard engine weakening returns one skill-adjusted move; CCE has a second decision layer: an LLM chooses the move that fits its personality. It therefore needs a *set* of candidate moves, and every candidate in that set must already reflect the persona's rating. A 400-rated character and an 1800-rated character should consider different moves, imagine different continuations, and hold different beliefs about who is winning. If any layer leaks engine strength, the character breaks.

## Why not Stockfish or raw Maia

- **Stockfish** (Skill Level / UCI_Elo) runs a full-strength search and perturbs only the final move choice. Its MultiPV list stays engine-optimal at every setting, so it cannot serve as a weak player's consideration set, and it is structurally unable to hang a piece. UCI_Elo also bottoms out near 1320.
- **Maia** predicts the probability of each legal move for a player of a given rating, and is the most accurate predictor of human moves. But playing its argmax yields play far above the label (averaging many players removes their individual blunders), and its tactical sharpness barely decreases at lower ratings. CCE builds on Maia and corrects both gaps with sampling layers.

## Architecture

```
persona layer:      Soulcaster ──> Chess Profile (Elo + overrides)

move generation:    Elo-Adjusted Maia ──> Move Sampler (temperature)
                    ──> Blunder ──> Blinder ──> 4-Move Candidate Set

per candidate:      Lookahead (alternating Maia rollout, depth n(Elo))
context:            Macro Context (material + W/D/L probability range)
rendering:          Translation (moves & lines -> plain sentences)

selection:          LLM with persona text picks purely by character.
                    Strength is fully determined upstream; the LLM can
                    only express style.
```

### Components

- **Chess profile** (`src/profile.js`) — the persona config: Elo (400-2000) plus optional overrides for temperature, blunder rate, blinder rate, lookahead depth, and band width. Everything derives from Elo by default.
- **Elo-adjusted Maia** (`src/maia.js`) — Maia inference conditioned on persona Elo (`elo_oppo = elo_self`), returning a probability distribution over all legal moves. This implementation runs the official Maia-3 5M checkpoint ([CSSLab/maia3](https://github.com/CSSLab/maia3), Chessformer architecture), exported to ONNX by `scripts/export-maia3.py` and run with onnxruntime-node. Elo conditioning is continuous; we use the 600-2600 range.
- **Move sampler** (`src/sampler.js`) — Gumbel-top-k over the tempered distribution: `s(m) = log p(m)/T + g_m`, keep the top 4; equivalent to sequential sampling without replacement from `q(m) ∝ p(m)^(1/T)`. Temperature is 1 inside Maia's calibrated range and rises linearly below it (a 400 persona gets T = 2). Moves below 1% raw probability are dropped before tempering so the flattening spreads mass over bad-but-human moves, not the full legal tail.
- **Blunder** (`src/cce.js`) — with Elo-scaled probability `P = b_max · e^{-(Elo-400)/λ}`, swaps one candidate for a move from the bottom tail of the distribution. Models impulsive lapses.
- **Blinder** (`src/cce.js`) — when Stockfish detects a short forced mate or a wide-gap tactic, removes it from the candidate set with probability `P = 1 - σ((Elo-μ)/s)`. Models not seeing what is on the board and counters Maia's tactical-sharpness quirk. Both curves start near certainty at 400 and near zero at 2000.
- **Lookahead** (`src/cce.js`) — for each candidate, one rollout of alternating Maia predictions, all plies conditioned on persona Elo and sampled at persona temperature, so the imagined line is rating-appropriate on both sides. One rollout per candidate, never averaged. Depth `n(Elo) = clip(floor(Elo/250), 1, 8)` plies: a 400 sees only its own move, a 2000 sees four moves per side.
- **Translation** (`src/translate.js`) — a deterministic chess.js tagger converts each move and rollout into plain sentences: captures, checks, mates, promotions, threats, hanging pieces, material deltas. No raw FEN reaches the LLM (SAN is included so the picker can name its move).
- **Macro context** (`src/macro.js`) — material count plus a win/draw/loss assessment shown as a probability *range*, not a confidence score. The band's half-width shrinks linearly from the full range at 400 to about 5 points at 2000, and at low Elo the band center shifts toward a naive material-only evaluation: weak players are confidently wrong, not just uncertain.
- **Stockfish** (`src/stockfish.js`) — bundled stockfish.js 18 lite (single-threaded WASM, ~7 MB) used for the Blinder's tactic detection and the macro band's engine estimate.

## Usage

```js
import { CharacterChessEngine } from 'cce-1';

const engine = await CharacterChessEngine.create({
  maiaModelPath: '/path/to/maia3-5m.onnx',
});

const out = await engine.candidateSet(fen, { elo: 900 });
// out.macro.text        -> "Material is even (39 points each). Your sense of
//                           your winning chances: somewhere between 20% and 85%."
// out.candidates[0]     -> { uci, san, sentence, tags, line }
//   .sentence           -> "You take the knight on e5 with your pawn. The piece
//                           could be taken there."
//   .line?.sentence     -> "You imagine: they take the pawn on e5 with their
//                           queen; ...; material stays even."

await engine.dispose();
```

The Maia-3 model file is not bundled (21 MB); download it from this repo's releases, or reproduce it with `scripts/export-maia3.py` from the official [Maia3-5M](https://huggingface.co/UofTCSSLab/Maia3-5M) checkpoint, and pass its path. The consuming app should present the four candidates plus macro context to its LLM and let the character pick.

## Calibration

Every constant in `src/formulas.js` is an empirical placeholder in the paper's spirit ("all constants are tuned empirically"). `scripts/calibrate.mjs` plays a persona against Stockfish UCI_Elo anchors and reports a measured performance rating (the paper prescribes 100 games per persona; the harness ships but is not run by CI):

```
node scripts/calibrate.mjs --elo 800 --games 20 --anchor 1320
```

## Limitations (from the paper)

- Translation is literal, move-by-move. It does not yet surface the strategic texture of a line (aggressive, simplifying, cramping, risky), so personality expression is shallower than strength expression. The fix is a richer feature layer over each rollout before the LLM.
- Everything below the model's training floor is extrapolation, calibrated only by measured performance.
- The Blinder is a heuristic patch over Maia's tactics quirk, not a principled model of oversight.
- Latency grows with 4 candidates x n rollout plies of Maia inference per move (~10 ms per inference on modern CPUs).
- `elo_oppo` is fixed to the persona's own rating; the engine does not model its actual opponent.

## Implementation notes (deviations from the paper)

- The paper targets Maia-2 (calibrated 1100-1900, categorical Elo inputs). This implementation uses Maia-3 ([CSSLab/maia3](https://github.com/CSSLab/maia3), the Chessformer paper, ICLR 2026) with continuous Elo inputs and a 600-2600 deployment range, so temperature extrapolation only has to cover 400-600 and the formulas' floor constant is 600, not 1100.
- The model file is our own ONNX export of the official Maia3-5M checkpoint (`scripts/export-maia3.py`). The wrapper bakes the reference engine's no-history behavior (current position repeated to fill the 8-position window) into the graph, so inference takes a single position. Board encoding (mirror to white's perspective; flat 64x12 piece tokens) and the 4352-move vocabulary match the official repo's `tokenize_board` / `get_all_possible_moves`.
- Candidates carry SAN alongside the sentences; the paper's "no raw notation reaches the LLM" is relaxed one notch so the downstream `play(move)` tool has an unambiguous argument.

## License

AGPL-3.0-only (same as Sei). The bundled Stockfish WASM build (`engines/`, unmodified `stockfish-18-lite-single` from [stockfish.js](https://github.com/nmrugg/stockfish.js) v18.0.8) is GPL-3.0; see `engines/Copying.txt`, with corresponding source at that repository and the [Stockfish](https://github.com/official-stockfish/Stockfish) project. The Maia-3 model in this repo's releases is our ONNX export (`scripts/export-maia3.py`) of the official [Maia3-5M](https://huggingface.co/UofTCSSLab/Maia3-5M) checkpoint released by the [Maia Chess](https://www.maiachess.com) project (CSSLab, University of Toronto) under AGPL-3.0 at [CSSLab/maia3](https://github.com/CSSLab/maia3); it stays AGPL-3.0. CCE-1 is not affiliated with the Maia or Stockfish projects.
