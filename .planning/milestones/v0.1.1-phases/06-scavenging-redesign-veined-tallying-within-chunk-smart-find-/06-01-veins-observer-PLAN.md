---
phase: 06
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/bot/adapter/minecraft/observers/veins.js
  - scripts/test-nearbyVeins.mjs
autonomous: true
requirements:
  - D-NEW-SCAV-1
tags:
  - minecraft
  - mineflayer
  - observer
  - scavenging

must_haves:
  truths:
    - "nearbyVeins() returns connected-component groups of same-ID interesting blocks within radius 16"
    - "Each vein has a name, anchor (closest member to bot), count (capped at 64), and distance"
    - "Top-K cap (default 8) applied by anchor distance; `more` counts overflow"
    - "Unloaded chunks / NaN origin handled defensively (empty result, no throw)"
  artifacts:
    - path: src/bot/adapter/minecraft/observers/veins.js
      provides: "nearbyVeins(bot, opts) flood-fill scanner"
      exports: ["nearbyVeins"]
    - path: scripts/test-nearbyVeins.mjs
      provides: "Unit test with stubbed bot proving flood-fill correctness"
  key_links:
    - from: src/bot/adapter/minecraft/observers/veins.js
      to: src/bot/adapter/minecraft/observers/blocks.js
      via: "imports isExposed + INTERESTING_BLOCK_NAMES"
      pattern: "import .* from './blocks.js'"
    - from: src/bot/adapter/minecraft/observers/veins.js
      to: src/bot/adapter/minecraft/observers/posHealer.js
      via: "uses getHealedPos for NaN-safe origin"
      pattern: "getHealedPos"
---

<objective>
Implement the veined block scanner — a pure observer module that groups nearby interesting blocks into 6-neighbor connected components (same exact MC block ID only) and returns the top-K veins by anchor distance. This replaces the per-block "16 nearest" semantics in the snapshot composer with vein-shaped information.

Purpose: D-NEW-SCAV-1 — the Haiku LLM currently can't tell one tree from 8 logs in a row. Veined output ("oak_log x6 near (3,64,-2)") gives it mining-shaped surroundings in fewer tokens.

Output: New observer module + unit test. No callers wired yet — that happens in plan 06-04.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-CONTEXT.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-RESEARCH.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-PATTERNS.md
@src/bot/adapter/minecraft/observers/blocks.js
@src/bot/adapter/minecraft/observers/posHealer.js

<interfaces>
<!-- Reuse contract from blocks.js (already in the codebase) -->

From src/bot/adapter/minecraft/observers/blocks.js:
- `export function isExposed(bot, pos): boolean` — conservative on unloaded chunks
- `export const INTERESTING_BLOCK_NAMES: Set<string>` — composed from WOODS, ORES, etc.

From src/bot/adapter/minecraft/observers/posHealer.js:
- `export function getHealedPos(bot): {x,y,z} | null` — NaN-poisoning-safe origin

mineflayer surface (already used by blocks.js):
- `bot.findBlocks({matching, maxDistance, count, point}): Vec3[]` — closest-first, loaded-chunks only
- `bot.blockAt(vec3): Block | null` — in-memory chunk lookup
- `bot.version: string` — for `minecraft-data(bot.version)`

Vec3 import: `import { Vec3 } from 'vec3'`
mcData import: `import mcDataLib from 'minecraft-data'`
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement nearbyVeins flood-fill scanner</name>
  <files>src/bot/adapter/minecraft/observers/veins.js</files>
  <behavior>
    - Returns `{ veins: [], more: 0 }` when origin is missing or NaN.
    - For a 3×1×3 oak_log slab with one adjacent spruce_log: returns 2 veins — oak_log count=9, spruce_log count=1 (same-ID-only connectivity per D-CONTEXT decision).
    - veinCap=64 truncates flood-fill mid-vein; reported `count` equals veinCap when truncated (rendering layer signals truncation via `x64+`, NOT this module).
    - maxVeins (default 8) limits returned array; `more` counts overflow.
    - Anchor = closest member of the vein to the bot's healed origin.
    - veins sorted by anchor distance ascending.
    - `bot.blockAt` returning null (unloaded neighbor) terminates that branch cleanly — no throw, vein count silently undercounts (matches blocks.js conservatism, documented in JSDoc).
  </behavior>
  <action>
Create `src/bot/adapter/minecraft/observers/veins.js`. Mirror the imports + origin-healing + mcData-id-array patterns from `observers/blocks.js` (see PATTERNS.md "Pattern Assignments — observers/veins.js" for verbatim snippets to copy).

Algorithm (per 06-RESEARCH.md L102-188, locked by D-CONTEXT):

1. Import: `Vec3` from 'vec3', `mcDataLib` from 'minecraft-data', `getHealedPos` from './posHealer.js', `isExposed` and `INTERESTING_BLOCK_NAMES` from './blocks.js'.

2. Export `nearbyVeins(bot, opts = {})`:
   - Read opts: `radius = 16`, `maxVeins = 8`, `veinCap = 64`, `interesting = INTERESTING_BLOCK_NAMES`.
   - Compute origin: `const origin = getHealedPos(bot) ?? bot.entity?.position`. If `!origin || !Number.isFinite(origin.x)` return `{ veins: [], more: 0 }`.
   - Build mcData id-array `matching` (copy the verbatim pattern from blocks.js L88-102; fallback to function form when mcData unavailable).
   - Seed: `const seeds = bot.findBlocks({ matching, maxDistance: radius, count: 256, point: origin })`.
   - Iterate seeds; for each unvisited seed:
     * Read `seedBlk = bot.blockAt(seed)`; skip if missing or `!interesting.has(seedBlk.name)`; skip if `!isExposed(bot, seed)` (exposure gate — same as nearbyBlocks).
     * Capture `veinName = seedBlk.name`.
     * BFS/DFS stack from seed using `NEIGHBOR_OFFSETS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]`.
     * Visited Set keyed `${x},${y},${z}`. Pop until empty OR `veinPositions.length >= veinCap`.
     * Same-name-only check: `if (!blk || blk.name !== veinName) continue` (after marking visited).
     * Push 6-neighbor Vec3s onto stack only if not already visited.
   - For each completed vein: compute anchor = member with min `distanceTo(origin)`. Push `{ name, anchor: {x,y,z}, count, distance: bestD }`.
   - Sort veins by `distance` ascending. `head = veins.slice(0, maxVeins)`, `more = max(0, veins.length - maxVeins)`. Return `{ veins: head, more }`.

3. JSDoc the export with `@param {import('mineflayer').Bot} bot` and full `@returns` shape (mirror blocks.js L68-77).

Constraints (per CLAUDE.md + RESEARCH.md):
- No side effects. No handle minting (snapshot.js does that in plan 06-04).
- Renderer factoring: this file produces structured data ONLY. Per CONTEXT.md L39, the rendering function is swappable — so do NOT format strings here.
- Pitfall 1 (RESEARCH.md L449): null `blockAt` across chunk boundary terminates branch cleanly; vein count is "visible vein" not "true vein". Document this in JSDoc.
  </action>
  <verify>
    <automated>node -e "import('./src/bot/adapter/minecraft/observers/veins.js').then(m => { if (typeof m.nearbyVeins !== 'function') process.exit(1); console.log('ok'); })"</automated>
  </verify>
  <done>
    `src/bot/adapter/minecraft/observers/veins.js` exists and exports `nearbyVeins`. Module imports cleanly. JSDoc present with `@param` and `@returns`. No imports of `targeting.js` (handle minting forbidden in observer tier).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Unit test nearbyVeins with stubbed Bot</name>
  <files>scripts/test-nearbyVeins.mjs</files>
  <behavior>
    - Test A: 3×1×3 oak_log slab + one adjacent spruce_log → 2 veins; oak count=9, spruce count=1.
    - Test B: NaN origin → returns `{ veins: [], more: 0 }`.
    - Test C: 100-block cobblestone cube (interesting set must include 'cobblestone' OR test substitutes a known interesting block) → vein count capped at 64; `more` reflects unreturned veins if any.
    - Test D: maxVeins=2 with 4 distinct single-block veins → returns 2 closest, `more=2`.
  </behavior>
  <action>
Create `scripts/test-nearbyVeins.mjs` following the project test convention (see `scripts/test-postProcessSay.mjs` and `scripts/test-fsmQueueDrain.mjs` for shape — plain Node ESM, `process.exit(0/1)` on assert failure, line-prefixed pass/fail logs).

Build a minimal Bot stub:
```js
function makeBot({ blocks, originPos = {x:0,y:64,z:0}, version = '1.20.4' }) {
  // blocks: Map<"x,y,z", string blockName>
  return {
    version,
    entity: { position: originPos },
    blockAt(p) {
      const name = blocks.get(`${p.x},${p.y},${p.z}`)
      if (!name) return null
      return { name, position: p, diggable: true }
    },
    findBlocks({ matching, maxDistance, count, point }) {
      // Iterate `blocks`, filter by name (handle both id-array and function form),
      // distance-sort, slice to `count`. Return Vec3-like {x,y,z, distanceTo}.
    },
    canDigBlock: () => true,
  }
}
```

Since `nearbyVeins` calls `isExposed(bot, pos)` from blocks.js, the stub must also satisfy that function's contract. Inspect blocks.js `isExposed` impl (line ~58-66) and stub whatever it reads — likely `bot.blockAt` neighbors. To avoid stubbing exposure logic, you may either:
  (a) construct test scenes where every test block has air neighbors (default `blockAt` returns null → treated as exposed), OR
  (b) inject a test-only `interesting` opt and rely on the natural air-neighbor exposure.

Use Vec3 from 'vec3' for positions where the impl calls `.distanceTo(origin)`.

Run four named test functions; print `[test-nearbyVeins] PASS A/B/C/D` lines; exit 1 if any fail.
  </action>
  <verify>
    <automated>node scripts/test-nearbyVeins.mjs</automated>
  </verify>
  <done>
    `node scripts/test-nearbyVeins.mjs` exits 0 and prints PASS for all four tests (A: two-vein separation, B: NaN guard, C: veinCap truncation, D: maxVeins + more).
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| world-state → observer | mineflayer returns possibly-null block data across unloaded chunks |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-06-01 | D | nearbyVeins flood-fill on unbounded slab | mitigate | `veinCap=64` ceiling on per-vein flood-fill; `count=256` ceiling on seed scan; both per-vein and per-result lists are bounded. |
| T-06-02 | D | NaN-poisoned bot position causing infinite loop in distance sort | mitigate | `Number.isFinite(origin.x)` guard returns empty result early (mirrors blocks.js L104-107). |
| T-06-03 | I | Cross-chunk vein undercount silently misleads caller | accept | Documented in JSDoc per Pitfall 1; matches existing observer conservatism. Caller (snapshot) is read-only LLM context, not safety-critical. |
</threat_model>

<verification>
- `node scripts/test-nearbyVeins.mjs` exits 0.
- `node -e "import('./src/bot/adapter/minecraft/observers/veins.js')"` resolves.
- Grep gate: `grep -v '^//\|^ \*' src/bot/adapter/minecraft/observers/veins.js | grep -c 'setHandles'` returns 0 (no handle minting in observer tier).
</verification>

<success_criteria>
- nearbyVeins exists, exports correctly, handles all four edge cases in tests.
- No coupling to snapshot.js, targeting.js, or registry.js — pure observer.
- Future renderer swap (per-vein → per-type) is possible without touching this file (no string formatting here).
</success_criteria>

<output>
After completion, create `.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-01-SUMMARY.md`.
</output>
