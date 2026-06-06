# Phase 7: Cuboid build / dig primitive (with scaffolding) - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Shape-aware build/dig actions backed by jump+place locomotion. A single cuboid abstraction (`build` with required two corners + block; extended `dig` with optional `to`) replaces per-cell coordinate reasoning. Walls, pillars, platforms, tunnels, and hollow shells all fall out of the two-corner spec. Phase also surfaces existing `placeBlock` / `equip` to the LLM and adds an "unreachable — try build to Y=N" hint from `goTo` / `dig` failures.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**6 requirements are locked.** See `07-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `07-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):**
- New `build` cuboid action (Zod schema + handler + LLM description with examples).
- Extended cuboid `dig` (this discussion locked: same action with optional `to`, see D-01).
- LLM-facing descriptions for the existing `placeBlock` and `equip` actions added to `ACTION_DESCRIPTIONS`.
- Internal jump+place scaffolding loop inside `build` for upward builds.
- `hollow` flag with walls-only semantics (4 vertical faces; caller composes floor/ceiling via flat single-Y cuboids).
- 256-cell volume cap, schema-enforced.
- `unreachable — try build to Y=N` hint surfaced from `goTo` and `dig` when failure cause is vertical.
- Required `block` arg on `build`, no defaults, no inventory inference.
- Examples teaching the LLM common shapes (pillar/wall/platform/tunnel/hollow shell).

**Out of scope (from SPEC.md):**
- Crouch-to-edge-and-place capability — deferred to backlog.
- Bot-relative `{forward, up, right}` corner spec — absolute `{x,y,z}` only.
- Auto-pillaring inside `goTo` / `dig` (silent scaffolding) — explicit LLM call only.
- Default block selection / inventory priority list.
- Diagonal or rotated cuboids — axis-aligned only.
- Block-replacement semantics in `build` — see D-05 (build skips occupied cells instead).
- Multi-stage batched builds spanning multiple LLM iterations as one atomic action.
- Aesthetic stair / roof / arch shapes.

</spec_lock>

<decisions>
## Implementation Decisions

### Action surface
- **D-01:** Extend the existing `dig` action with an optional `to:{x,y,z}` field rather than introducing a separate `digRegion`. Zod refine: `(block) | ({x,y,z}) | ({x,y,z}+to)`. Description must teach both single-cell and cuboid modes; cuboid examples are taught via the shared system-prompt cheatsheet (see D-08) so the inline description stays lean.
- **D-02:** `build` is a brand-new registry action — no overload of `placeBlock`. `placeBlock` remains as the single-cell primitive that `build` composes on top of.
- **D-03:** `placeBlock` and `equip` get LLM-facing descriptions added to `ACTION_DESCRIPTIONS` in `src/bot/adapter/minecraft/index.js`. Canonical strings live next to their handlers (mirrors `DIG_DESCRIPTION` precedent).

### Scaffolding (jump + place)
- **D-04:** Custom hand-rolled jump+place loop inside `build`. Sequence: detect target cell unreachable due to height → bot.setControlState('jump', true) → wait for apex (~250ms; planner to confirm exact timing) → bot.setControlState('jump', false) → `placeBlock` against block-below with `faceVector={x:0,y:1,z:0}` → wait for landing → continue. Do NOT use mineflayer-pathfinder `Movements.scafoldingBlocks` — keeps the loop deterministic, abortable, and per-cell observable.

### Cell semantics
- **D-05:** `build` skips occupied cells. If a cell already contains a non-air block, place nothing and continue. Build never breaks-and-replaces — caller composes a `dig` call first if they want a fresh region.
- **D-06:** `dig` silently skips air cells (counts them as done). No per-skip noise in the result string.

### Iteration order
- **D-07:** `build` iterates Y ascending → X → Z. Bottom-up is required so scaffolding works (must have a support block before the next layer up). `dig` iterates Y descending → X → Z. Top-down so the bot is never stranded on a column above where it's standing and gravity-affected blocks (sand, gravel) don't drop on the bot. Both orders are documented constants in their handler files.

### LLM grammar
- **D-08:** Cuboid grammar examples live in a new `seed_cuboid_grammar` cached system-prompt block (added to the cached prefix near `seed_owner` / `seed_diary` in `orchestrator.js:283-288`). Block teaches the two-corner mental model once for both `build` and extended `dig`: pillar (keep two dims const), wall (one dim const), platform (const Y), tunnel (const Y, const Z dig), hollow room shell (hollow:true). Tool descriptions stay short and reference "see seed_cuboid_grammar". Cached prefix grows once; no per-tool duplication.

### Unreachable hint
- **D-09:** `goTo` and `dig` emit `unreachable — try build to Y=N` in the result string when pathfinder fails AND target.y > bot.y + small margin (planner to pick the exact margin — likely 2 blocks since a vanilla bot can jump 1). N is the target Y. Trigger is a pathfinder failure of any kind (NoPath / timeout) when the elevation condition holds, so the LLM gets nudged even when the failure mode is mixed (e.g., partial path, scaffolding-blocked target).

### Async progress / long-running actions
- **D-10:** Cuboid actions emit periodic progress ticks. The orchestrator, instead of waiting for the cuboid action to fully resolve before calling the next LLM loop iteration, schedules a tick every ~10s while the action is in-flight. Each tick injects a short progress line into the next prompt (e.g., `build progress: 47/256 cells, current y=66`) and the LLM may choose to abort, continue waiting, or take other action. FSM priority is unchanged — owner chat / safety interrupts still preempt mid-action via the existing AbortController path. The LLM is expected to infer the rest of the situation from the world snapshot. **Scope note:** this is a small orchestrator-side change adjacent to the cuboid actions; planner should keep it minimal (probably a `progress$` callback on long actions + a tick scheduler in the loop) rather than a generalized "async UX" rewrite.

### Volume / safety
- **D-11:** 256-cell cap (from SPEC R5) is checked at the Zod schema layer BEFORE any side effect runs. Cell count = `|to.x - from.x + 1| * |to.y - from.y + 1| * |to.z - from.z + 1|`. Error string suggests splitting.

### Claude's Discretion
- Exact apex/landing timing constants in D-04 (jump uses ~250ms apex, ~200ms landing — planner verifies experimentally).
- Exact margin in D-09 (recommend 2; planner can tune).
- Progress tick interval in D-10 (recommend 10s; planner can tune based on observed action duration).
- Result string format for `build` / cuboid `dig` — concise summary of placed/dug/skipped counts; format mirrors existing `dig` / `mineVein` idioms.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements
- `.planning/phases/07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla/07-SPEC.md` — Locked requirements, boundaries, acceptance criteria. MUST read before planning.

### Existing action precedents (read for pattern fidelity)
- `src/bot/adapter/minecraft/behaviors/dig.js` — `DIG_DESCRIPTION` constant + handler pattern. Canonical string lives next to handler. New `build` must mirror this layout.
- `src/bot/adapter/minecraft/behaviors/mineVein.js` — Multi-step action with abort/timeout/loop precedent. Closest analog to a cuboid loop.
- `src/bot/adapter/minecraft/behaviors/place.js` — Existing `placeBlockAction`; `build` composes on top of it (D-02).
- `src/bot/adapter/minecraft/behaviors/equip.js` — Existing `equipAction`; gets LLM description in D-03.
- `src/bot/adapter/minecraft/registry.js` — Action registration site for the new `build` and extended `dig` schemas.
- `src/bot/adapter/minecraft/index.js` §`ACTION_DESCRIPTIONS` (line 23) — Where `placeBlock`/`equip`/`build` LLM-facing descriptions land.
- `src/bot/brain/orchestrator.js` §283-288 — Cached system-prompt block layout (`seed_owner`, `seed_diary`). New `seed_cuboid_grammar` block lands in this region.
- `src/bot/brain/orchestrator.js` (loop tick + action awaiting site) — Where the periodic progress-tick logic from D-10 hooks in.

### Project conventions
- `CLAUDE.md` — Closed action registry, every external call has a timeout, single outstanding action token with AbortController, three-process Electron model.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `placeBlockAction` (`behaviors/place.js`): Single-cell placement with timeout + abort. `build` composes a loop over this. Already does the `bot.equip` dance before placing.
- `equipAction` (`behaviors/equip.js`): Standalone equip with timeout + abort. Surfaced to LLM in D-03.
- `mineVeinAction` (`behaviors/mineVein.js`): Closest precedent for a multi-step in-loop action — handles abort, per-step result accumulation, timeout. `build` loop structure should mirror this.
- `bot.setControlState('jump', ...)` (mineflayer primitive): Available on the bot; used directly in the custom scaffolding loop (D-04).
- `reason(err)` (`brain/errStrings.js`): Standard error-string conversion. Reuse for all per-cell failure messages.
- Cached prefix blocks (`orchestrator.js:283-288`): The pattern of inserting a named text block into the cached system prompt is established — `seed_cuboid_grammar` follows the same shape.

### Established Patterns
- **Description-next-to-handler:** `DIG_DESCRIPTION` lives in `dig.js` and is imported into `ACTION_DESCRIPTIONS`. `BUILD_DESCRIPTION` and updated `DIG_DESCRIPTION` follow the same convention.
- **Race(op, timeout, abort):** Every action handler does `Promise.race([op, timeout, abort])`. Cuboid handlers do this per-cell, not over the whole cuboid (so 256 cells × per-cell timeout > total action wall-clock allowed).
- **Zod refine for input variants:** Pattern already used in `mine_vein` (name OR x,y,z). Extended `dig` schema uses the same idiom for `(block) | ({x,y,z}) | ({x,y,z}+to)`.

### Integration Points
- **Registry registration:** `src/bot/adapter/minecraft/registry.js` lines ~160-200. New `build` action + updated `dig` schema land here.
- **ACTION_DESCRIPTIONS map:** `src/bot/adapter/minecraft/index.js:23`. Add `placeBlock`, `equip`, `build`, and updated `dig` entries (importing the canonical strings from their handlers).
- **Orchestrator cached prefix:** `src/bot/brain/orchestrator.js:283-288`. Insert `seed_cuboid_grammar` block before the last `cache_control` boundary so it joins the cached prefix.
- **Orchestrator action-await loop:** Wherever the loop currently awaits action completion before scheduling the next LLM call — D-10 inserts a progress-tick timer here.
- **Pathfinder error paths in `goTo` and `dig`:** Result-string composition points where D-09's hint is injected.

</code_context>

<specifics>
## Specific Ideas

- The cuboid `dig` should feel like a natural extension of the existing single-block `dig` — users (and the LLM) shouldn't need to learn a new tool name to dig a tunnel. The `to` arg flips the mode.
- Progress ticks should "look like what Claude Code does while waiting for tasks": short status line, model can decide to keep waiting or take action. Not a verbose dump.
- For occupied-cell skipping in `build`: the user explicitly does NOT want the bot to dig-then-replace. If the cell is taken, it's taken. Caller composes `dig` first if they want a clean canvas.
- The system-prompt cuboid grammar block is meant to teach the LLM the *shape vocabulary* (pillar = column, wall = plane, platform = floor, etc.) so it can pick the right two corners for natural-language requests like "build a wall in front of you".

</specifics>

<deferred>
## Deferred Ideas

- **Crouch-to-edge-and-place behavior** — Out of scope (locked in SPEC.md). Needs sneak toggle + edge detection + face-down placement. Promote to backlog when overhangs / cantilevered builds become a real ask.
- **Bot-relative `{forward, up, right}` corner spec** — Deferred. If the LLM struggles with absolute coords + bot position, revisit in a follow-up phase.
- **Default block selection / inventory priority list** — Out of scope. `block` arg stays required. Could become a separate "auto-block" helper later if useful.
- **Generalized async-action LLM tick framework** — D-10 ships a minimal version scoped to cuboid actions. A general "any action over N seconds gets progress ticks" framework is a larger orchestrator refactor and should be its own backlog item if needed.
- **Aesthetic shapes (stairs, roofs, arches, spheres)** — Out of scope. Cuboid only. Future shape primitives can layer on top of `build`.

</deferred>

---

*Phase: 7-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla*
*Context gathered: 2026-05-12*
