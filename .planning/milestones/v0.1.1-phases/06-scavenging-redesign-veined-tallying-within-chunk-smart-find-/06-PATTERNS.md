# Phase 6: Scavenging Redesign — Pattern Map

**Mapped:** 2026-05-11
**Files analyzed:** 6 (3 new, 3 modified)
**Analogs found:** 6 / 6

## File Classification

| File | New/Mod | Role | Data Flow | Closest Analog | Match Quality |
|------|---------|------|-----------|----------------|---------------|
| `src/bot/adapter/minecraft/observers/veins.js` | new | observer (pure world-read) | request-response (sync read) | `src/bot/adapter/minecraft/observers/blocks.js` | exact (same role + data flow) |
| `src/bot/adapter/minecraft/loose-terms.js` | new | utility / static data table | transform (NL→IDs lookup) | `src/bot/adapter/minecraft/observers/blocks.js` constant exports (TERRAIN, INTERESTING_BLOCK_NAMES) | role-match (static lookup) |
| `src/bot/adapter/minecraft/behaviors/mineVein.js` | new | behavior / registered action handler | request-response with abort + timeout | `src/bot/adapter/minecraft/behaviors/dig.js` | exact (action handler with abort/timeout/single-flight) |
| `src/bot/adapter/minecraft/observers/snapshot.js` | mod | observer composer | transform (compose lines + mint handles) | self (in-place edit of L43, L97-108) | self |
| `src/bot/adapter/minecraft/registry.js` | mod | Zod action registrar | config / registration | self (add two `registry.register(...)` calls inside `createDefaultRegistry()`) | self |
| `src/bot/brain/orchestrator.js` | mod | LLM primer / cached prefix | config (description strings) | self (add two keys to `ACTION_DESCRIPTIONS` at L107) | self |

## Pattern Assignments

### `observers/veins.js` (new) — observer, request-response

**Analog:** `src/bot/adapter/minecraft/observers/blocks.js`

**Imports pattern** (blocks.js L1-4):
```js
import mcDataLib from 'minecraft-data'
import { Vec3 } from 'vec3'
import { getHealedPos } from './posHealer.js'
```
Add to veins.js: `import { isExposed, INTERESTING_BLOCK_NAMES } from './blocks.js'` (reuse, not redefine).

**Origin / NaN-healing pattern** (blocks.js L104-107):
```js
const origin = getHealedPos(bot) ?? bot.entity?.position
const point = origin && Number.isFinite(origin.x) ? origin : undefined
```
Veins.js MUST use the same origin pattern — knockback-poisoning NaN protection.

**mcData → matching-ids resolver** (blocks.js L88-102):
```js
let mcData
try { mcData = mcDataLib(bot.version) } catch { mcData = null }
let matching
if (mcData?.blocksByName) {
  const ids = []
  for (const name of (typeof interesting === 'function' ? [] : interesting)) {
    const b = mcData.blocksByName[name]
    if (b) ids.push(b.id)
  }
  matching = ids.length ? ids : ((b) => isInteresting(b.name))
} else {
  matching = (b) => isInteresting(b.name)
}
```
Copy this verbatim into veins.js seed-list construction (RESEARCH.md A3 — id-array form is faster).

**findBlocks seed-scan pattern** (blocks.js L112):
```js
const found = bot.findBlocks({ matching, maxDistance: r, count, point })
```
Veins.js uses `count: 256` for a generous seed list (per RESEARCH.md L140); flood-fill deduplicates.

**Empty-origin early return** (blocks.js — implicit; aroundFeet L180):
```js
if (!origin || !Number.isFinite(origin.x)) return { groups: [], total: 0, more: 0 }
```
Veins.js: `return { veins: [], more: 0 }`.

**Return-shape convention:** `{ veins, more }` — mirrors blocks.js `{ positions, more }` and `aroundFeet` `{ groups, total, more }`. Caller (snapshot.js) reads `.veins` and `.more`.

**JSDoc convention** (blocks.js L68-77, L173-178): full `@param`/`@returns` block on every exported function with `{import('mineflayer').Bot}` typing.

---

### `loose-terms.js` (new) — utility, static table

**Analog:** `src/bot/adapter/minecraft/observers/blocks.js` constants section (L6-35)

**Constant-list composition pattern** (blocks.js L6-8, L26-35):
```js
const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']
const ORES = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore']

export const INTERESTING_BLOCK_NAMES = new Set([
  ...WOODS.map(w => `${w}_log`),
  ...WOODS.map(w => `${w}_planks`),
  ...ORES,
  ...ORES.map(o => `deepslate_${o}`),
  // ...
])
```
loose-terms.js builds its TABLE the same way (RESEARCH.md L203-219). Reuse the `WOODS` list shape; consider exporting `WOODS` from blocks.js OR duplicating with a comment cross-reference.

**Export shape:** named exports + one helper (`resolveTerm`, `LOOSE_TERMS`). No default export. Matches blocks.js convention (`export const TERRAIN`, `export const INTERESTING_BLOCK_NAMES`, `export function nearbyBlocks`, `export function aroundFeet`).

**No `import { Bot }` needed** — pure data + pure function. This file does NOT depend on mineflayer.

**Phase 7 reuse note (from CONTEXT.md L61):** export `resolveTerm` and the table at module level so Phase 7's pillar-up can `import { resolveTerm } from '../loose-terms.js'` without going through observers.

---

### `behaviors/mineVein.js` (new) — behavior, action handler

**Analog:** `src/bot/adapter/minecraft/behaviors/dig.js`

**Imports pattern** (dig.js L1-4):
```js
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { goTo } from './pathfind.js'
import { firstLine, truncate } from '../../../brain/errStrings.js'
```
mineVein.js adds: `import { Vec3 } from 'vec3'`, `import mcDataLib from 'minecraft-data'`, `import { resolveTerm } from '../loose-terms.js'`, `import { digAction } from './dig.js'`, `import { INTERESTING_BLOCK_NAMES } from '../observers/blocks.js'`.

**Description colocation rule** (dig.js L10-20):
```js
export const DIG_DESCRIPTION = "Break a block. Prefer `{ block: \"<name>\" }` to dig the NEAREST EXPOSED block of that name within maxDistance ..."
```
mineVein.js exports `MINE_VEIN_DESCRIPTION` next to the action. orchestrator.js's `ACTION_DESCRIPTIONS.mine_vein` is kept in sync with this constant (dig.js L114-117 of orchestrator does the same dance).

**Abort-signal early return** (dig.js L29-30):
```js
const signal = config?.signal
if (signal?.aborted) return 'aborted'
```
Use at start of `mineVeinAction` AND check between each block in the loop (RESEARCH.md L338): `if (signal?.aborted) return \`aborted after ${dug}/${positions.length} ${veinName}\``.

**Timeout + abort race pattern** (dig.js L99-112):
```js
const tmo = new Promise((r) => setTimeout(() => {
  try { bot.stopDigging() } catch {}
  r(`timeout digging ${blockName} @${bx},${by},${bz}`)
}, timeoutMs))

const abrt = new Promise((r) => {
  if (!signal) return
  signal.addEventListener('abort', () => {
    try { bot.stopDigging() } catch {}
    r('aborted')
  }, { once: true })
})

return Promise.race([op, tmo, abrt])
```
mineVein delegates inner per-block timeout to `digAction` (which already wraps); but the OUTER vein loop itself needs to respect `signal` between iterations and surface partial progress in the abort message.

**Deterministic *what*-only result strings** (dig.js L26-27 doc, L52, L91, L101): every code path returns a string the LLM can directly reason from. mineVein follows: `mined ${dug}/${positions.length} ${veinName}` or `mined ${dug}/${total} ${veinName} (vein-cap reached)` or `aborted after ${dug}/${total} ${veinName}` or `no ${args.name} in loaded chunks`.

**Pathfind-before-dig (Pitfall 2)** — RESEARCH.md L365-370 explicitly flags `digAction` does not pathfind to range. Pattern:
```js
await goTo(bot, p.x, p.y, p.z, 3, 10_000)
const r = await digAction({ x: p.x, y: p.y, z: p.z }, bot, config)
```
Where `goTo` signature comes from pathfind.js L17: `goTo(bot, x, y, z, range = 1, timeoutMs = 12000)`.

---

### `observers/snapshot.js` (modified)

**Self-pattern.** Replace L43 (`nearbyBlocks(...)` call) with `nearbyVeins(...)` call. Replace render block at L97-108.

**Critical invariants to preserve:**
- L92-95: shared monotonic `n` counter across blocks AND entities — vein handles must consume `n` first; entity numbering continues at L116 picks up after veins.
- L93-94, L105: handle entries shape:
  ```js
  handles.push([tag, { kind: 'block', pos: { x, y, z }, expiresAt }])
  ```
  One handle per vein anchor.
- L141: `setHandles(handles)` is the SINGLE call point. veins observer returns plain data; snapshot.js mints handles inline (Pitfall 3 in RESEARCH.md L457).
- L43 imports: replace `nearbyBlocks` with `nearbyVeins` from `./veins.js`. Keep `aroundFeet` import — `terrain at feet:` line is unchanged (CONTEXT.md Q3, RESEARCH.md L36).

**Replacement render pattern** — mirrors existing L98-108 structure:
```js
lines.push('nearby veins:')
if (veins.veins.length === 0) {
  lines.push('  (none)')
} else {
  for (const v of veins.veins) {
    const tag = `#${n++}`
    // Renderer is swappable per CONTEXT.md L39 — keep it inline-simple here
    lines.push(`  ${tag} ${v.name} x${v.count} @${v.anchor.x},${v.anchor.y},${v.anchor.z} d=${v.distance.toFixed(1)}`)
    handles.push([tag, { kind: 'block', pos: v.anchor, expiresAt }])
  }
  if (veins.more > 0) lines.push(`  +${veins.more} more`)
}
```

---

### `registry.js` (modified)

**Self-pattern.** Add two `registry.register(...)` calls inside `createDefaultRegistry()` between L218 (activateItem) and L221 (sleep), or grouped with locate/dig actions.

**Imports addition** (insert after L13):
```js
import { resolveTerm } from './loose-terms.js'
import { mineVeinAction, MINE_VEIN_DESCRIPTION } from './behaviors/mineVein.js'
import { getHealedPos } from './observers/posHealer.js'
import mcDataLib from 'minecraft-data'
import { Vec3 } from 'vec3'
```

**Zod-schema-then-handler pattern** (registry.js L70-89 goTo, L106 dig, L108-116 placeBlock):
```js
registry.register(
  'find',
  z.object({
    name: z.string().min(1),
    maxDistance: z.number().min(1).max(128).default(64),
  }),
  async (args, bot, config) => {
    // ... inline handler (find is small; mine_vein is large → behaviors/ file)
  }
)
```

**Refine-with-message pattern for OR-shaped inputs** (registry.js L36-39, L141-144, L153-157):
```js
z.object({
  name: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  maxDistance: z.number().min(1).max(64).default(32),
}).refine(
  a => a.name || (a.x != null && a.y != null && a.z != null),
  { message: 'must specify name or x,y,z' }
)
```
Use for `mine_vein` schema (matches AttackEntity's name/target refine pattern).

**Inline-handler vs behaviors/ file rule:** small handlers stay inline (setGoals L91-103, follow L148-174, unfollow L176-188); complex multi-step handlers move to `behaviors/*.js` (dig, place, attack, etc.). `find` → inline. `mine_vein` → `behaviors/mineVein.js`.

**Config destructure pattern** (registry.js L78-79, dig.js L29):
```js
async (args, bot, config) => {
  const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
  // ...
}
```
mine_vein consumes `config?.signal` for AbortController.

---

### `brain/orchestrator.js` (modified)

**Self-pattern.** Add two keys to `ACTION_DESCRIPTIONS` map at L107-118.

**Description-style pattern** (L108-117):
- One-line for simple actions: `goTo: 'Move the bot to the given (x, y, z) coordinates within range blocks.'`
- Multi-sentence with usage guidance + caveats for complex actions (`dig` L117): explains when to prefer which arg shape, what the result strings mean, and the `#N` rotation caveat.

**Cache-prefix coordination** (RESEARCH.md L401 + Pitfall 6):
- Edit is a deliberate cache bust (one-time warm-up cost).
- Batch the edit: add BOTH `find:` and `mine_vein:` keys in one commit.
- Keep description text byte-identical to `MINE_VEIN_DESCRIPTION` in behaviors/mineVein.js — dig.js L20 / orchestrator.js L117 maintain this drift discipline.

**Primer steering for mine_vein:** RESEARCH.md L59 and CONTEXT.md L57 — description must steer Haiku toward `mine_vein({name})` over `dig({block})` for vein-shaped resources. Mirror the rhetorical style of dig.js L20 ("Prefer ... over ..."): e.g. `mine_vein: 'Mine a whole connected vein in one call. Prefer this over dig for vein-shaped resources (trees, ore deposits, stone walls). Pass {name:"<term>"} (loose terms like "wood"/"ore"/"stone" expand server-side) OR {x,y,z} for a known anchor block. ...'`.

## Shared Patterns

### Abort-signal propagation
**Source:** `src/bot/adapter/minecraft/behaviors/dig.js` L29-30, L104-110
**Apply to:** `behaviors/mineVein.js`
```js
const signal = config?.signal
if (signal?.aborted) return 'aborted'
// ... and in any loop body:
if (signal?.aborted) return `aborted after ${k}/${n}`
```

### NaN-healed origin
**Source:** `src/bot/adapter/minecraft/observers/blocks.js` L104-107
**Apply to:** `observers/veins.js`, `find` action handler in `registry.js`
```js
const origin = getHealedPos(bot) ?? bot.entity?.position
const point = origin && Number.isFinite(origin.x) ? origin : undefined
```

### minecraft-data id-array matching
**Source:** `src/bot/adapter/minecraft/observers/blocks.js` L88-102
**Apply to:** `observers/veins.js` seed scan, `find` handler in `registry.js`, `mineVein.js` resolve step
```js
let mcData
try { mcData = mcDataLib(bot.version) } catch { mcData = null }
const matching = mcData?.blocksByName
  ? ids.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
  : ((b) => ids.includes(b.name))
```

### Result-string contract
**Source:** `src/bot/adapter/minecraft/behaviors/dig.js` L26-27 (doc), L52, L60-65, L91-96
**Apply to:** `find` (returns object — orchestrator JSON-stringifies; see RESEARCH.md L275-276 noting setGoals returns object), `mine_vein` (returns string).
- Strings: deterministic, *what*-only, include all context the LLM needs (block name, coords, failure reason).
- Objects: shape mirrors `{ ok, snapshot }` from setGoals (registry.js L101-102) → `{ found, id, pos:{x,y,z}, distance }` or `{ found:false, reason }`.

### Description-colocation drift discipline
**Source:** `src/bot/adapter/minecraft/behaviors/dig.js` L10-20 (`DIG_DESCRIPTION`) + `src/bot/brain/orchestrator.js` L114-117 (sync comment)
**Apply to:** `MINE_VEIN_DESCRIPTION` in `behaviors/mineVein.js` + `ACTION_DESCRIPTIONS.mine_vein` in `orchestrator.js`. Sync-comment in orchestrator references behaviors/mineVein.js so future edits don't drift.

### Closed-registry contract (Phase 2.1, STATE.md)
**Source:** entire `registry.js` register pattern
**Apply to:** both new actions — Zod schema MUST validate; no free-form coords from LLM (mine_vein accepts coords but the primer steers toward `{name}` per RESEARCH.md L59); every external call timeout-wrapped (CLAUDE.md "Every external call has a timeout").

## No Analog Found

None. Every new file has a strong analog in the existing codebase. RESEARCH.md L13-14 confirms: "the phase is mostly (a) a flood-fill grouper on top of the existing exposure-filtered scan, (b) a hand-curated NL→ID table, and (c) two new entries in registry.js."

## Metadata

**Analog search scope:**
- `src/bot/adapter/minecraft/observers/` (blocks.js, snapshot.js, targeting.js read in full)
- `src/bot/adapter/minecraft/behaviors/` (dig.js, pathfind.js read in full)
- `src/bot/adapter/minecraft/registry.js` (read in full)
- `src/bot/brain/orchestrator.js` (L90-230 read for ACTION_DESCRIPTIONS + cadence patterns)

**Files scanned:** 7
**Pattern extraction date:** 2026-05-11

## PATTERN MAPPING COMPLETE

**Phase:** 6 — scavenging-redesign-veined-tallying-within-chunk-smart-find-
**Files classified:** 6 (3 new, 3 modified)
**Analogs found:** 6 / 6

### Coverage
- Files with exact analog: 2 (veins.js → blocks.js; mineVein.js → dig.js)
- Files with role-match analog: 1 (loose-terms.js → blocks.js constants)
- Files with self-pattern (in-place edit): 3 (snapshot.js, registry.js, orchestrator.js)
- Files with no analog: 0

### Key Patterns Identified
- All observers use `getHealedPos(bot) ?? bot.entity?.position` + `Number.isFinite` NaN guard
- All action handlers follow `(args, bot, config) => Promise<string|object>` shape with `config?.signal` abort check + `*-only result strings*` contract
- minecraft-data id-array matching is the canonical `findBlocks` pattern (faster than function-form on large radii)
- LLM-facing description text colocates with implementation (`DIG_DESCRIPTION` export) and is mirrored into `ACTION_DESCRIPTIONS` with a sync-comment to prevent drift
- Snapshot handle table is mutated ONCE per snapshot via `setHandles(handles)` at end of `composeSnapshot`; observers return plain data, snapshot.js mints handles inline using the shared monotonic `n` counter

### File Created
`.planning/phases/06-scavenging-redesign-veined-tallying-within-chunk-smart-find-/06-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can reference analog patterns directly in PLAN.md action sections.
