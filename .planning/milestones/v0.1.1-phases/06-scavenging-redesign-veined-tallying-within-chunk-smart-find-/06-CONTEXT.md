# Phase 6 Context: Scavenging redesign — veined tallying + find()

**Date:** 2026-05-11
**Source:** Promoted from 999.1. Driven by D-NEW-SCAV-1/2/3 in `.planning/phases/03.1-behavior-polish-and-ai-game-decoupling-refactor-analysis-dri/VALIDATION.md` (L138-139, L191-193).
**User quote:** *"combine veined tallying for within chunk and smart_find for navigating to other chunks, i think we finally can make scavenging resources work."*

## Domain

Replace the snapshot composer's "16 nearest blocks by distance" world-state with a **veined representation** so the Haiku personality LLM sees compact, mining-shaped information about its surroundings, and give it a single `find()` action that accepts both exact block IDs and loose natural-language terms ("wood", "stone", "ore") so it can locate resources without enumerating every variant.

**Scope reframe during discussion:** The ROADMAP's three subsystems (veined tallying / smart_find / find) collapse to **two**:
1. Veined snapshot (LLM-visible text shape)
2. `find()` upgrade — same action handles exact IDs AND loose terms; supersedes a separate `smart_find`

A new `mine_vein` action is added alongside.

## Canonical Refs

- `.planning/ROADMAP.md` (Phase 6 entry, L153-164)
- `.planning/phases/03.1-behavior-polish-and-ai-game-decoupling-refactor-analysis-dri/VALIDATION.md` (source defect lines)
- `src/bot/adapter/minecraft/observers/snapshot.js` (current 16-by-distance composer to be rewritten)
- `src/bot/adapter/minecraft/observers/blocks.js` (`nearbyBlocks`, `INTERESTING_BLOCK_NAMES` — current scan helpers)
- `src/bot/adapter/minecraft/observers/targeting.js` (handle numbering / position lookup)
- `src/bot/brain/orchestrator.js` (consumes snapshot text)
- Phase 2.1 CONTEXT (`.planning/phases/2.1-expand-actions-and-game-state/2.1-CONTEXT.md`) — closed Zod action registry rules
- Phase 03.1 PLAN files for snapshot composer history (search `snapshot` under `.planning/phases/03.1-.../`)

## Decisions

### Veined snapshot format
- **Output:** one line per detected vein. Format (illustrative — exact rendering up to planner):
  ```
  nearby veins:
    oak_log     vein#A x6  near (3,64,-2)  d=2.4   handle #1
    oak_log     vein#B x4  near (7,65,-5)  d=6.1   handle #2
    iron_ore    vein#C x3  near (8,55, 4)  d=9.8   handle #3
    +N more
  ```
- **Future flexibility:** per-type collapsed format (`oak_log x12 nearest …`) is a noted alternative if per-vein gets too noisy in practice. Planner: keep the composer factored so the rendering function can be swapped without touching the scanner.
- **Scan radius:** 16 blocks (match current `nearbyBlocks` radius). Cap total veins surfaced (top-K by distance) to keep snapshot bounded.
- **Connectivity:** 6-neighbor flood-fill (face-adjacent), **same exact block ID only**. spruce_log next to oak_log = two separate veins. No cross-chunk merging.

### find() action — registered, replaces both old find and smart_find
- **Type:** Registered Zod action, returns a result (does NOT move the bot).
- **Input:** a single term — either an exact MC block ID (`oak_log`) OR a loose natural-language term (`wood`, `stone`, `ore`).
- **Output:** `{id: string, pos: {x,y,z}, distance: number}` for the nearest match, or a structured "none in loaded chunks" result.
- **Search scope:** loaded chunks only (whatever mineflayer has in memory — no spiral exploration this phase).
- **Loose-term resolution:** hand-curated static table maps loose terms → ID lists (e.g. `{wood: ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'], stone: [...], ore: [...]}`). When a loose term is given, find scans for ANY ID in the list and returns the nearest hit.
- **Fallthrough:** if the input doesn't match a loose-term key, treat it as an exact ID.
- **Rationale for keeping resolution server-side rather than letting Haiku enumerate variants:** ground-truth ID table is correct for the running MC version (Haiku's training-data knowledge of MC IDs is fuzzy across versions), and single call beats N find() calls under the 20-iteration cap.

### mine_vein action — new primary mining verb
- **Type:** Registered Zod action that finds + paths + mines a whole connected vein.
- **Input:** either a name (loose term or exact ID — uses same resolver as `find()`) OR a coordinate (mine the vein containing this block).
- **Behavior:** for the resolved/anchor block, flood-fill the vein (6-neighbor, same exact ID — matches snapshot rules), pathfind to it, mine block-by-block.
- **Rationale:** real Minecraft mining is vein-shaped (one tree's logs, one ore deposit). Haiku should reach for `mine_vein` by default; `dig` stays for coord-based single-block cases.
- **Capability primer update:** the existing Phase 2.1 capability text shown to Haiku must guide it: "use mine_vein for vein-shaped resources; use dig only for single coord-specific blocks."

### Loose-term table is reusable infrastructure
- The hand-curated NL→IDs table is its own module (not buried inside `find()`).
- **Phase 7 (pillar-up) note:** Phase 7's roadmap dependency on `find()` was for resolving "what block to place" — which is a *pure NL→ID lookup*, not a locator call. Phase 7 should consume the **table directly**, not call `find()`. Surface the table as a small exported helper (e.g. `resolveTerm(name) → string[]`).

## Code Context

**Replaces:** the entire "nearby blocks" block in `src/bot/adapter/minecraft/observers/snapshot.js` (currently lines ~43, ~97-107, sourced from `nearbyBlocks` in `blocks.js`).

**New/changed:**
- New scanner producing vein groups (flood-fill from `INTERESTING_BLOCK_NAMES` candidates within radius 16).
- New snapshot rendering for veined output (replaces the per-block `#N <id> at …` lines).
- New module: loose-term table + `resolveTerm()` helper.
- New action: `find()` in the Zod registry.
- New action: `mine_vein()` in the Zod registry, composed of resolve + flood + pathfind + sequential dig.
- Capability primer update (Phase 2.1 cached prefix) so Haiku knows about find / mine_vein semantics.

**Closed-registry rules carry forward (Phase 2.1):** every new action timeout-wrapped, AbortController-cancellable, respects FSM priority queue.

## Deferred Ideas

- **Per-type collapsed snapshot format** — alternative rendering if per-vein gets noisy. Composer should remain factored to swap renderers without changing the scanner.
- **Cross-chunk spiral exploration** in `find()` — explicitly out of scope; current phase is loaded-chunks-only. Revisit if/when scavenging needs to roam.
- **mine_vein partial completion / resume semantics** — let planner decide; if it gets complex, defer richer resume to a follow-up.
- **mc-data-driven term table** — could replace the hand-curated table at startup. Hand table chosen for predictability; revisit if MC version drift becomes a pain.

## Open Questions for Planner

- How `mine_vein` handles vein size caps (huge cobblestone vein = unbounded?). Recommend a soft cap (e.g. 64 blocks) with surfaced "stopped at cap" result.
- How `mine_vein` reports progress / partial failure back to the Haiku loop (single terminal result vs streamed updates).
- Whether the veined snapshot still surfaces non-vein "around feet" data unchanged (current snapshot has a separate 5x4x5 feet cube — likely keep as-is).

## Next Step

`/clear` then `/gsd-plan-phase 6`
