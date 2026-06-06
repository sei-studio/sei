---
phase: 06
plan: 03
type: execute
wave: 2
depends_on: ["06-02"]
files_modified:
  - src/bot/adapter/minecraft/behaviors/mineVein.js
  - scripts/test-mineVein.mjs
autonomous: true
requirements:
  - D-NEW-SCAV-3
tags:
  - minecraft
  - mineflayer
  - behavior
  - scavenging

must_haves:
  truths:
    - "mineVeinAction resolves either {name} (via resolveTerm + findBlocks) or {x,y,z} to an anchor block"
    - "Flood-fills the vein (6-neighbor, same exact ID only, cap 64) from the resolved anchor"
    - "Pre-pathfinds to each block (goTo range=3) before delegating to digAction (Pitfall 2 mitigation)"
    - "Respects config.signal — aborts mid-vein on owner-chat preempt and returns `aborted after K/N <name>`"
    - "Returns single deterministic terminal string: `mined K/N <name>` or `mined K/N <name> (vein-cap reached)` or `aborted after K/N <name>` or `no <term> in loaded chunks` or `no block at anchor`"
    - "Exports MINE_VEIN_DESCRIPTION colocated with handler (drift-discipline pattern)"
  artifacts:
    - path: src/bot/adapter/minecraft/behaviors/mineVein.js
      provides: "mineVeinAction handler + MINE_VEIN_DESCRIPTION"
      exports: ["mineVeinAction", "MINE_VEIN_DESCRIPTION"]
    - path: scripts/test-mineVein.mjs
      provides: "Unit test with stubbed bot + digAction proving sequence + abort"
  key_links:
    - from: src/bot/adapter/minecraft/behaviors/mineVein.js
      to: src/bot/adapter/minecraft/loose-terms.js
      via: "import resolveTerm for name → ID list"
      pattern: "import \\{ resolveTerm \\}"
    - from: src/bot/adapter/minecraft/behaviors/mineVein.js
      to: src/bot/adapter/minecraft/behaviors/dig.js
      via: "imports digAction for inner per-block dig"
      pattern: "digAction"
    - from: src/bot/adapter/minecraft/behaviors/mineVein.js
      to: src/bot/adapter/minecraft/behaviors/pathfind.js
      via: "goTo before each digAction (Pitfall 2)"
      pattern: "goTo\\("
---

<objective>
Implement `mine_vein` — the primary mining verb the Haiku LLM should reach for when scavenging vein-shaped resources (trees, ore deposits, stone walls). This action resolves a name OR coordinate to an anchor block, flood-fills the connected vein, pathfinds to each member in turn, and mines block-by-block, returning a single deterministic terminal string.

Purpose: D-NEW-SCAV-3 — currently `dig({block:"oak_log"})` couples find+dig in one call. `mine_vein` decouples (find via `find()` action OR snapshot handle) and amortizes a multi-block vein into ONE LLM iteration (massive iteration-cap savings on tree/ore extraction).

Output: New behavior module + unit test. Registration in registry.js happens in plan 06-04.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-CONTEXT.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-RESEARCH.md
@.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-PATTERNS.md
@src/bot/adapter/minecraft/behaviors/dig.js
@src/bot/adapter/minecraft/behaviors/pathfind.js
@src/bot/adapter/minecraft/loose-terms.js

<interfaces>
<!-- Contracts to consume — VERIFIED in source -->

From src/bot/adapter/minecraft/behaviors/dig.js:
- `export async function digAction(args, bot, config): Promise<string>` — returns deterministic result strings like `"dug oak_log @x,y,z"`, `"out of range"`, `"aborted"`, `"timeout digging..."`. Does its own single-flight + timeout. Does NOT pathfind to range — caller must be within ~4.5m (Pitfall 2).
- `export const DIG_DESCRIPTION: string` — colocation analog.

From src/bot/adapter/minecraft/behaviors/pathfind.js:
- `export async function goTo(bot, x, y, z, range = 1, timeoutMs = 12000): Promise<PathfindResult>` — wall-clock bounded pathfind.

From src/bot/adapter/minecraft/loose-terms.js (built in 06-02):
- `export function resolveTerm(name: string): string[]`

mineflayer surface:
- `bot.findBlocks({matching, maxDistance, count, point}): Vec3[]`
- `bot.blockAt(vec3): Block | null`
- `bot.entity.position`

Config contract (per registry.js (args, bot, config) pattern):
- `config?.signal: AbortSignal | undefined`
- `config?.pathfinder_timeout_ms?: number` (default 12000)

Description colocation contract (per dig.js L10-20 + orchestrator.js L114-117):
- Export `MINE_VEIN_DESCRIPTION` from this file; orchestrator.js (in plan 06-04) mirrors it into `ACTION_DESCRIPTIONS.mine_vein` with a sync-comment.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement mineVeinAction + MINE_VEIN_DESCRIPTION</name>
  <files>src/bot/adapter/minecraft/behaviors/mineVein.js</files>
  <behavior>
    - Input shape: `{name?: string, x?: number, y?: number, z?: number, maxDistance?: number}`. At least one of `name` or `(x,y,z)` required (registry-side refine enforces).
    - With `{name: 'wood'}` and a single oak_log at (5,64,0): resolves anchor via `resolveTerm` + `findBlocks`; floods → 1 block; pathfinds + digs; returns `mined 1/1 oak_log`.
    - With `{x,y,z}` of a stone block in a 100-block stone wall: floods up to 64 blocks; returns `mined N/64 stone (vein-cap reached)` where N ≤ 64.
    - With `config.signal` aborted before start: returns `'aborted'`.
    - With `config.signal` aborted between block 3 and block 4 of a 5-block vein: returns `aborted after 3/5 oak_log` (or similar; K is dug count, N is total vein positions).
    - With `name` that resolves to nothing in loaded chunks: returns `no <term> in loaded chunks`.
    - With `{x,y,z}` pointing at air / null block: returns `no block at anchor`.
    - With `name` having NO ids and `findBlocks` empty: returns `no <term> in loaded chunks`.
    - Each per-block step: `await goTo(bot, p.x, p.y, p.z, 3, timeoutMs)` then `await digAction({x:p.x, y:p.y, z:p.z}, bot, config)`. If digAction returns `'aborted'`, surface `aborted after K/N` and stop. Other failures: mark position done, continue.
  </behavior>
  <action>
Create `src/bot/adapter/minecraft/behaviors/mineVein.js`. Follow `behaviors/dig.js` patterns verbatim where applicable (imports shape, abort-signal early return, colocated description export, deterministic result-string contract).

Imports:
```js
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import { resolveTerm } from '../loose-terms.js'
import { goTo } from './pathfind.js'
import { digAction } from './dig.js'
```

Constants:
```js
const NEIGHBOR_OFFSETS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
const VEIN_CAP = 64
```

`MINE_VEIN_DESCRIPTION` (per CONTEXT.md L57 + PATTERNS.md "Primer steering for mine_vein"):
> "Mine a whole connected vein in one call. Prefer this over `dig` for vein-shaped resources (trees, ore deposits, stone walls). Pass `{name:\"<term>\"}` — loose terms (`wood`, `ore`, `stone`, `dirt`, `sand`, `log`, `planks`, `leaves`) expand server-side to the right MC block IDs; you can also pass an exact ID like `oak_log`. Or pass `{x,y,z}` of a known anchor block (from a snapshot `#N` handle or a prior `find()` result). Returns `mined K/N <name>` on success, `mined K/N <name> (vein-cap reached)` when the vein exceeds 64 blocks, `aborted after K/N <name>` on owner-chat preempt, `no <name> in loaded chunks` when nothing matches, or `no block at anchor` when the coord is empty/air."

Export both `mineVeinAction` and `MINE_VEIN_DESCRIPTION`.

`mineVeinAction(args, bot, config)` algorithm (per RESEARCH.md L282-362):

1. `const signal = config?.signal; if (signal?.aborted) return 'aborted'` (dig.js L29-30 pattern).
2. `const timeoutMs = config?.pathfinder_timeout_ms ?? 12000`.
3. **Resolve anchor:**
   - If `typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number'`: `anchor = new Vec3(args.x, args.y, args.z)`.
   - Else if `typeof args.name === 'string'`:
     * `const ids = resolveTerm(args.name)`.
     * Build `matching` (mcData id-array form per blocks.js L88-102; fallback to function form).
     * If empty: return `no ${args.name} in loaded chunks`.
     * `const origin = bot.entity?.position`.
     * `const hits = bot.findBlocks({ matching, maxDistance: args.maxDistance ?? 32, count: 1, point: origin })`.
     * If `!hits.length`: return `no ${args.name} in loaded chunks`.
     * `anchor = hits[0]` (Vec3-like from mineflayer).
   - Else: return `'must specify name or x,y,z'` (note: registry refine should prevent this — defensive).
4. **Flood-fill from anchor** (same exact ID only, cap VEIN_CAP):
   - `const seedBlk = bot.blockAt(anchor); if (!seedBlk) return 'no block at anchor'`.
   - `const veinName = seedBlk.name`.
   - BFS/DFS with visited Set keyed `${x},${y},${z}`. Continue while `stack.length && positions.length < VEIN_CAP`. Per node: skip if visited; mark visited; if `bot.blockAt(p)?.name !== veinName` continue; push to `positions`; enqueue 6-neighbors.
5. **Mine block-by-block, closest-first, abort-aware:**
   - Track `dug = 0`. Maintain per-position `done` flag.
   - Loop while remaining positions exist:
     * `if (signal?.aborted) return \`aborted after ${dug}/${positions.length} ${veinName}\``.
     * Recompute closest-remaining via `bot.entity?.position`.
     * `await goTo(bot, p.x, p.y, p.z, 3, timeoutMs)` (Pitfall 2 mitigation — RESEARCH.md L365-370).
     * `const r = await digAction({x:p.x, y:p.y, z:p.z}, bot, config)`.
     * If `r === 'aborted'`: return `\`aborted after ${dug}/${positions.length} ${veinName}\``.
     * If `typeof r === 'string' && r.startsWith('dug ')`: `dug++; mark done`.
     * Else (out-of-range / timeout / no-block): mark done, continue (surface only in terminal aggregate; do not throw).
6. **Terminal result:**
   - `const capNote = positions.length >= VEIN_CAP ? ' (vein-cap reached)' : ''`.
   - Return `\`mined ${dug}/${positions.length} ${veinName}${capNote}\``.

JSDoc on `mineVeinAction` with `@param`/`@returns` matching dig.js style.

Constraints (CLAUDE.md + RESEARCH.md):
- Every external call timeout-wrapped: `goTo` has its own timeout, `digAction` has its own timeout — outer loop only watches `signal` between iterations.
- Single registered-action token (FSM rule): this function returns ONE terminal Promise; no FSM event re-emission.
- No coordinate hallucination — anchor comes from registry-validated args (Zod refine on `name || (x,y,z)`).
  </action>
  <verify>
    <automated>node -e "import('./src/bot/adapter/minecraft/behaviors/mineVein.js').then(m => { if (typeof m.mineVeinAction !== 'function' || typeof m.MINE_VEIN_DESCRIPTION !== 'string') process.exit(1); if (!m.MINE_VEIN_DESCRIPTION.includes('mine_vein') && !m.MINE_VEIN_DESCRIPTION.toLowerCase().includes('vein')) process.exit(2); console.log('ok'); })"</automated>
  </verify>
  <done>
    Module exports `mineVeinAction` and `MINE_VEIN_DESCRIPTION`. Description text mentions loose-term expansion, `(x,y,z)` alternative, and result-string shapes. Imports include `resolveTerm`, `goTo`, `digAction`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Unit test mineVeinAction sequence + abort + cap</name>
  <files>scripts/test-mineVein.mjs</files>
  <behavior>
    - Test A: single oak_log at (5,64,0), `{name:'wood'}` — returns `mined 1/1 oak_log`; goTo called once; digAction called once.
    - Test B: 5-block oak_log row, `{x,y,z}` of leftmost — returns `mined 5/5 oak_log`; 5 goTo + digAction calls in order of bot-distance.
    - Test C: signal pre-aborted — returns `'aborted'` with zero goTo/digAction calls.
    - Test D: 5-block vein, abort signal fires after 2 successful digs — returns `aborted after 2/5 oak_log`.
    - Test E: `{name:'wood'}` with no matching blocks in stub — returns `no wood in loaded chunks`.
    - Test F: `{x:0,y:64,z:0}` returning null block — returns `no block at anchor`.
    - Test G: 100-block stone slab — returns `mined K/64 stone (vein-cap reached)` with K ≤ 64.
  </behavior>
  <action>
Create `scripts/test-mineVein.mjs` modeled on `scripts/test-attackInterruptRace.mjs` (uses AbortController) and `scripts/test-fsmQueueDrain.mjs`.

**Stubbing strategy:** Since mineVeinAction imports `digAction` and `goTo` statically, you cannot trivially replace them at runtime in plain ESM. Two viable approaches — pick (a):

(a) **Recommended: dependency injection via a small refactor.** In mineVein.js, accept optional `_deps = { goTo, digAction }` as a fourth arg defaulting to the real imports:
```js
import { goTo as realGoTo } from './pathfind.js'
import { digAction as realDigAction } from './dig.js'
export async function mineVeinAction(args, bot, config, _deps) {
  const goTo = _deps?.goTo ?? realGoTo
  const digAction = _deps?.digAction ?? realDigAction
  // ...
}
```
This adds zero runtime cost (default to real), keeps the registry call site untouched (`(args, bot, config) =>` is preserved — fourth arg silently undefined → falls through to real impls), and makes the inner loop unit-testable. If you take this approach, update Task 1 to include `_deps` plumbing.

(b) Alternative: ESM module-level mocking via `--import` loader. More fragile; avoid unless (a) is unacceptable.

**Recommend (a).** Update Task 1 to include the optional `_deps` parameter.

Bot stub (small):
```js
function makeBot({ blocks, originPos = {x:0,y:64,z:0}, version='1.20.4' }) {
  // blocks: Map<"x,y,z", string blockName>
  return {
    version,
    entity: { position: originPos },
    blockAt(p) {
      const n = blocks.get(`${p.x},${p.y},${p.z}`)
      return n ? { name: n, position: p } : null
    },
    findBlocks({ matching, maxDistance, count, point }) {
      // sort positions by distance, filter by matching (handle id-array OR fn), slice(count)
    },
  }
}
```

For each test, build `goToStub` and `digActionStub` that record calls and return canned results:
- digActionStub returns `'dug ' + name + ' @x,y,z'` for the position; on abort: `'aborted'`.
- goToStub returns `{ ok: true }` resolved.

Test D abort-mid-sequence: use an AbortController; trigger `controller.abort()` from inside the third `digActionStub` invocation; the next iteration's `signal?.aborted` check returns the aborted result.

Print PASS A/B/C/D/E/F/G; exit 1 on first failure.
  </action>
  <verify>
    <automated>node scripts/test-mineVein.mjs</automated>
  </verify>
  <done>
    `node scripts/test-mineVein.mjs` exits 0 with PASS for all 7 tests.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| LLM args → mine_vein | Haiku-supplied `name` or `(x,y,z)` enters a closed Zod-validated action |
| FSM signal → action loop | AbortController must reach mid-vein and stop digging promptly |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-06-06 | D | Unbounded flood-fill on a large slab (e.g. stone biome) | mitigate | `VEIN_CAP=64` ceiling on `positions.length`; reported in terminal string for LLM awareness. |
| T-06-07 | D | Per-block pathfind hangs indefinitely | mitigate | `goTo(bot, x, y, z, 3, timeoutMs)` wall-clock-bounded (12s default, configurable via `config.pathfinder_timeout_ms`); inner digAction also self-times. |
| T-06-08 | T | Mid-vein owner-chat preempt fails to cancel | mitigate | `signal?.aborted` checked before each iteration AND digAction propagates `'aborted'` from its own race; partial-progress surfaced in terminal string. |
| T-06-09 | E | LLM passes coords that match bot's own position (Pitfall 5) | accept | `bot.blockAt(anchor)` returns null at air feet → `no block at anchor`. Document in MINE_VEIN_DESCRIPTION. |
</threat_model>

<verification>
- `node scripts/test-mineVein.mjs` exits 0.
- `grep -c "config?.signal" src/bot/adapter/minecraft/behaviors/mineVein.js` ≥ 2 (pre-flight + per-iteration).
- `grep -c "VEIN_CAP\\|veinCap\\|64" src/bot/adapter/minecraft/behaviors/mineVein.js` ≥ 1.
- Module imports `resolveTerm`, `goTo`, `digAction` — verify with grep.
</verification>

<success_criteria>
- mineVeinAction handles all three input modes (name-only, coord-only, neither → error) deterministically.
- Abort propagates within one iteration boundary.
- Vein cap surfaces in terminal result string when reached.
- Description text steers Haiku to prefer mine_vein over dig for vein-shaped work.
</success_criteria>

<output>
After completion, create `.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-03-SUMMARY.md`.
</output>
