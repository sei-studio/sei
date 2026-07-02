# Movement / vision-hallucination fix — log bbf5b66f …2026-06-16T04-27

Three issues from the 04-27 log; user-directed fixes.

## Issues & root causes

1. **Sui doesn't move at all.** Both `goTo` calls timed out as *unreachable* — to
   the cherry tree 44m off (line 216) and to the player (line 565:
   `"timeout — unreachable — try build to Y=112"`). The wood was past the loaded-
   chunk edge / up higher ground; a single 44m pathfind can't reach it, so she
   `end_loop`d and froze at spawn the whole session.
2. **Hallucinated a previously-built base.** The `visualize` turn (line 376)
   invented "the base I was building before, stone walls up, no roof" — a vision
   hallucination amplified by a stale cross-session goal ("build a complete base")
   while the snapshot listed only grass/dirt. She then `build`d → "no oak_planks".
3. **Third-person "Ouen's off to the side" / "ouen's way over there."** She was
   narrating the player's *position*, which spawns the name.

## Fixes (per user direction)

1. **New `explore` action** (`behaviors/explore.js`) — a short directional hop
   (default 16m, max 48): `{direction}`, or `{x,z}` to head toward a far point one
   hop at a time, or no-args fan-out. Reuses `goTo` under an 8s cap; a short hop is
   almost always reachable, so it loads new chunks and closes the gap instead of
   freezing. `ACTION_RULES` Pathfinder rule now routes timeout/unreachable →
   `explore` / `lookAround` → re-`find`/`goTo`, and only then ask the player.
2. **New `lookAround` action** (`behaviors/lookAround.js`) — physically sweeps the
   head 360° (visible in-game) and reports nearest trees/water/animals/mobs by
   compass direction + distance, drawn from **loaded world data, not an image** —
   so it can't hallucinate. The cheap scout step before `explore`/`visualize`.
3. **Anti-hallucination one-liner** in `BASELINE_INSTRUCTIONS` (all bots): "if you
   SEE a structure in a rendered image that is NOT in your nearby-blocks list, it
   is far and uncertain — go closer to check before you claim it."

## Files

- `src/bot/adapter/minecraft/behaviors/explore.js` (new), `lookAround.js` (new)
- `src/bot/adapter/minecraft/registry.js` — register both
- `src/bot/adapter/minecraft/prompts.js` — `explore`/`lookAround` descriptions,
  rewritten Pathfinder recovery rule
- `src/bot/brain/prompts.js` — anti-hallucination one-liner
- `scripts/probe-brain.mjs` — `STUCK-UNREACHABLE` scenario + `recover` evaluator;
  added explore/lookAround to the tool list
- `scripts/sim-loop.mjs` — faithful 04-27 world (far unreachable wood; explore
  closes the gap); prints movement path + reached-wood
- `src/bot/brain/orchestrator.test.js` — updated silent-branch wording assertion

## Results

- `STUCK-UNREACHABLE` (live, 8×): **8/8 recover** via explore / lookAround / find /
  scaffold-dig — never freezes, never falls back to follow.
- `sim-loop` (faithful 04-27): **~4/5 reach the wood** by exploring incrementally
  (`-2,109,2 → 14,109,0 → 30,109,-2 → 41,111,-4`); the rest still move (hunt/scout),
  none freeze.
- Full probe matrix green except the pre-existing stochastic `RESUME` (Lyra L1).
- All 146 bot unit tests pass.

## Notes / residual

- **Capability mismatch (separate issue):** the capability paragraph says the bot
  *can't craft*, yet goals routinely demand "craft tools / a crafting table." That
  makes some early-game goals unachievable and can stretch a loop into a
  player-pestering deadlock (sim Run 1, 14 lines). Worth deciding: add a craft
  action, or steer goals away from crafting. Out of scope for this turn.
- **Third-person name (#3)** is improved by removing its main triggers (no more
  hallucinated-base scene narration; explore replaces "ouen's over there, let me go
  ask"), but it's still prompt-bound, not mechanically enforced.
