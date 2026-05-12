# Phase 7: Cuboid build / dig primitive (with scaffolding) — Specification

**Created:** 2026-05-12
**Ambiguity score:** 0.14 (gate: ≤ 0.20)
**Requirements:** 6 locked

## Goal

The bot gains two LLM-callable actions — `build` and `dig` — that operate on absolute two-point cuboids and internally handle the locomotion needed to construct or excavate cells the bot cannot directly reach (jump+place scaffolding for upward builds), so the LLM can build/dig walls, pillars, platforms, tunnels, and hollow shells without per-block coordinate reasoning.

## Background

`placeBlock` and `equip` actions are already registered with Zod schemas in `src/bot/adapter/minecraft/registry.js:174` and `:184`, with implementations in `behaviors/place.js` and `behaviors/equip.js` (both have timeouts + abort wiring). However, neither appears in `ACTION_DESCRIPTIONS` (`src/bot/adapter/minecraft/index.js:23`), so the LLM has no idea these tools exist — matching the user-reported defect that the bot "tried to place dirt block under it" but logs show zero `placeBlock(` and zero `equip(` calls.

There is no shape-aware primitive anywhere. The LLM could in theory drive single-cell placement, but it has no spatial awareness, so multi-cell structures (walls, pillars, houses, tunnels) never get built. Pathfinder has a scaffolding-blocks option but it is not currently surfaced or wired.

The phase delivers a single cuboid abstraction: `build({from, to, block, hollow?})` places blocks across the axis-aligned region between two absolute corners; `dig({from, to, hollow?})` removes blocks across the same region. Every shape the user cares about (pillar, wall, fence, platform, room shell, tunnel) is a special case of this primitive.

## Requirements

1. **`build` cuboid action**: A new closed-registry action that places blocks across a two-point absolute cuboid.
   - Current: No `build` action exists. `placeBlock` is single-cell and not exposed to the LLM.
   - Target: `build({from:{x,y,z}, to:{x,y,z}, block:string, hollow?:boolean})` registered in the action registry with Zod schema; iterates cells in the cuboid and places `block` at each. With `hollow:true`, only the 4 vertical wall faces are placed (no floor, no ceiling — caller composes floor/ceiling via a separate flat `build` call).
   - Acceptance: A test invokes `build({from:{x:0,y:64,z:0}, to:{x:3,y:64,z:3}, block:'dirt'})` against a stub bot and verifies 16 dirt cells placed; a second test with `hollow:true` and from/to spanning a 4×3×4 region verifies only the 24 wall-face cells are placed (no floor/ceiling cells).

2. **`dig` cuboid action**: A new closed-registry action that breaks blocks across a two-point absolute cuboid.
   - Current: `dig` exists but only for a single block (by name with auto-find or by single `{x,y,z}`).
   - Target: A separate cuboid-mode action (new action name e.g. `digRegion` or extended `dig` schema — decided in discuss-phase) accepting `{from, to, hollow?}`. With `hollow:true` only the 4 wall faces are broken (matching `build` semantics).
   - Acceptance: A test invokes the cuboid dig over a known 1×2×5 region and verifies all 10 cells are broken in order; abort signal mid-call leaves remaining cells intact.

3. **Jump+place scaffolding inside `build`**: When a target build cell is above the bot's current reach, `build` internally pillars up underneath itself.
   - Current: `placeBlock` fails with "no reference block" or out-of-reach when there's no adjacent face. No vertical locomotion exists.
   - Target: Inside `build`, when the next cell to place is unreachable due to height, the bot jumps and places the block under its feet, then proceeds. Uses the same `block` arg the caller specified (no separate scaffolding block). Pathfinder's stock scaffolding flag MAY be used if discuss-phase finds it sufficient.
   - Acceptance: With the bot standing on flat ground at y=64 and inventory containing dirt, `build({from:{x:0,y:65,z:0}, to:{x:0,y:69,z:0}, block:'dirt'})` produces a 5-block pillar with the bot ending at y=69; the bot never falls and never times out.

4. **`block` arg is required**: `build` does not infer the block to place.
   - Current: N/A (no build action).
   - Target: Zod schema rejects calls without `block`. Returns `no <block> in inventory` if the named block isn't held (same idiom as `placeBlock`).
   - Acceptance: Calling `build` without `block` is rejected at schema validation; calling with a block not in inventory returns the inventory-miss string.

5. **Volume cap (256 cells)**: Each `build` or `dig` call is bounded.
   - Current: N/A.
   - Target: Schema rejects any call where the cuboid contains more than 256 cells. Error string suggests splitting into smaller calls.
   - Acceptance: A 9×9×4 (324 cell) call is rejected before any block action runs; an 8×8×4 (256 cell) call is accepted.

6. **Unreachable hint surfaced from `goTo` and `dig`**: When pathfinder/dig fails because the destination is elevated and unreachable, the action result text includes a hint pointing the LLM at `build`.
   - Current: `goTo` / `dig` return generic "couldn't reach" / "out of reach" strings.
   - Target: When the failure cause is vertical unreachability (target Y > bot Y + reach + small margin and no path found), the result string contains a phrase like `unreachable — try build to Y=N` so the LLM can chain into a pillar.
   - Acceptance: A test scenario places a target 5 blocks above the bot in an open area; calling `goTo` to that point returns a result containing the substring `try build` and the correct Y value.

## Boundaries

**In scope:**
- New `build` cuboid action (Zod schema + handler + LLM description with examples).
- New `dig` cuboid action OR extended `dig` schema (form decided in discuss-phase).
- LLM-facing descriptions for the existing `placeBlock` and `equip` actions added to `ACTION_DESCRIPTIONS` so the LLM at least sees the primitives.
- Internal jump+place scaffolding loop inside `build` for upward builds.
- `hollow` flag with walls-only semantics (no floor, no ceiling — caller composes those via flat single-Y cuboids).
- 256-cell volume cap, schema-enforced.
- `unreachable — try build to Y=N` hint surfaced from `goTo` and `dig` when failure cause is vertical.
- Required `block` arg, no defaults, no inventory inference.
- Examples in the action description teaching the LLM common shapes (pillar = keep two dims const, wall = one dim const, platform = const Y, tunnel = dig with const Y/Z).

**Out of scope:**
- Crouch-to-edge-and-place capability (overhangs, cantilevers) — deferred to backlog; needs sneak toggle + edge detection + face-down placement, separate phase.
- Bot-relative `{forward, up, right}` corner spec — absolute `{x,y,z}` only for this phase; relative coords can be revisited if LLM struggles.
- Auto-pillaring inside `goTo` or `dig` (silent scaffolding) — explicit LLM call only; hint mechanism keeps the loop visible.
- Default block selection / inventory priority list — `block` is required, no fallback.
- Diagonal or rotated cuboids — axis-aligned only.
- Block-replacement semantics in `build` (digging then placing if the cell is occupied) — caller is responsible for clearing first via `dig`.
- Multi-stage / batched builds spanning multiple LLM iterations as a single atomic action — each call is one cuboid, LLM chains them.
- Aesthetic stair / roof / arch shapes — cuboid primitive only.

## Constraints

- Cuboid volume cap: ≤ 256 cells per call, schema-enforced before any side effects.
- Every cell operation must respect the action's `signal.aborted` — partial work is allowed but the loop must exit on abort, same idiom as `mineVein` and `dig`.
- Per-cell place/dig timeouts inherit from existing `placeBlock` (4000ms) and `dig` defaults; the cuboid action does not impose its own outer timeout that would kill a legitimate 256-cell run.
- `placeBlock` / `equip` primitives are reused as-is — no rewrite. The cuboid action is composed on top.
- LLM descriptions follow the `dig` precedent: canonical string lives next to the handler, mirrored into `ACTION_DESCRIPTIONS`.

## Acceptance Criteria

- [ ] `build` action exists in the registry, Zod-validated, with required `from`, `to`, `block` and optional `hollow`.
- [ ] Cuboid `dig` (action name TBD in discuss-phase) exists in the registry, Zod-validated, with required `from`, `to` and optional `hollow`.
- [ ] `placeBlock` and `equip` have LLM-facing descriptions in `ACTION_DESCRIPTIONS`.
- [ ] `build` with `hollow:true` places only the 4 vertical wall faces (no floor, no ceiling); test fixture confirms exact cell set.
- [ ] `build` rejects calls with > 256 cells before any placement occurs.
- [ ] `build` rejects calls missing `block` at the schema layer.
- [ ] `build` produces a 5-block-high dirt pillar starting from the bot's feet via internal jump+place; bot ends at the top safely.
- [ ] Owner saying "build a 4x4 wall in front of you" results in a visible 4×4 wall in-world (live integration scenario).
- [ ] Owner saying "dig a 1x2x5 tunnel forward" results in a 10-cell tunnel the bot can walk into (live integration scenario).
- [ ] Owner saying "go up to that tree" with an elevated target causes the bot to receive the `unreachable — try build to Y=N` hint and successfully chain a `build` pillar to reach it (live integration scenario).
- [ ] Mid-action abort (e.g. owner chat preempts) stops the cuboid loop and leaves the bot in a safe state.

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                  |
|--------------------|-------|------|--------|--------------------------------------------------------|
| Goal Clarity       | 0.90  | 0.75 | ✓      | Single cuboid primitive, two actions, locked.          |
| Boundary Clarity   | 0.85  | 0.70 | ✓      | Crouch-edge explicitly out; relative coords deferred.  |
| Constraint Clarity | 0.80  | 0.65 | ✓      | 256-cell cap; hollow=walls-only; block required.       |
| Acceptance Criteria| 0.85  | 0.70 | ✓      | 3 live scenarios + unit-level checks.                  |
| **Ambiguity**      | 0.14  | ≤0.20| ✓      | Gate passed.                                           |

## Interview Log

| Round | Perspective              | Question summary                                          | Decision locked                                                                                  |
|-------|--------------------------|----------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| 1     | Researcher + Simplifier  | Scope: pillar-only vs general shape vocabulary?           | Expanded: shape-aware build/dig — pillar is one case. User flagged spatial awareness as the gap. |
| 1     | Simplifier               | Fixed shape verbs or unified primitive?                   | Single cuboid `build` + `dig`; pillar/wall/cube/tunnel all fall out from two-point spec.         |
| 1     | Researcher               | Corner specification — absolute, relative, or both?       | Absolute `{x,y,z}` only for this phase; LLM gets examples in the action description.            |
| 1     | Researcher               | Auto-scaffold inside goTo/dig?                            | No — surface `unreachable — try build to Y=N` hint; LLM decides whether to pillar.              |
| 1     | Researcher               | Default block when unspecified?                           | None — `block` arg is required. No inventory inference.                                          |
| 1     | Researcher (user-added)  | Underlying scaffolding capability still needed?           | Yes — jump+place loop lives inside `build` so the bot can build cells above its reach.          |
| 2     | Boundary Keeper          | Crouch-to-edge-and-place in scope?                        | Out of scope — promoted to backlog; sneak + edge detection + face-down place is its own phase. |
| 2     | Failure Analyst          | `hollow:true` semantics — which faces?                    | Walls only (4 vertical faces). Floor and ceiling are caller's responsibility via flat cuboids.  |
| 2     | Failure Analyst          | Volume cap per call?                                      | 256 cells, hard reject at schema layer.                                                          |
| 2     | Failure Analyst          | Concrete acceptance scenarios?                            | 4×4 wall on request, 1×2×5 tunnel on request, reach-a-tree via hint-driven pillar.              |

---

*Phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla*
*Spec created: 2026-05-12*
*Next step: /gsd-discuss-phase 7 — implementation decisions (action naming for cuboid dig, jump+place vs pathfinder scaffolding flag, error-string format for the unreachable hint, etc.)*
