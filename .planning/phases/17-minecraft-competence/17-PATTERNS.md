# Phase 17: Minecraft Competence - Pattern Map

**Mapped:** 2026-06-25
**Files analyzed:** 11 (new + modified)
**Analogs found:** 11 / 11 (every new file has a strong in-repo template)

> Read alongside `17-CONTEXT.md` (13 decisions) and `.planning/research/v0.4-mc-reflex-dodge.md`.
> All excerpts below are read-only references — copy the *shape*, not the file.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `behaviors/reflex.js` (NEW) | behavior (background controller) | event-driven (20 Hz tick) | `behaviors/combat.js` | role-match (combat is `entityHurt`-driven, reflex is `physicsTick`-driven; mutex + start/stop + `HOSTILE_MOBS` are exact) |
| `behaviors/furnace.js` (NEW) | behavior (session) | request-response / CRUD | `behaviors/container.js` | exact (3-slot furnace is chest-session + 2 extra slots) |
| sign-reading primitive (NEW behavior + registry tool) | behavior + observer | transform (block → text) | `behaviors/activate.js` (handler shell) + `observers/entities.js` `droppedItemName` (metadata decode) | role-match |
| `behaviors/activateBlock.js` (NEW, door/gate) | behavior | request-response | `behaviors/activate.js` (held-item only today) | role-match (same handler skeleton, different mineflayer call) |
| shelter building (registry wiring on existing `build`) | behavior + registry | batch (cuboid place) | `behaviors/build.js` + `registry.js` `BuildSchema` | exact (reuse `buildAction`; shelter = a hollow cuboid + roof) |
| `progression.json` + `nextMilestone()` walker (NEW) | data + pure observer | transform (state → advisory) | `observers/progression.js` (`SPINE` + `computeProgression`) | exact (evolve the in-code DAG to data + walker) |
| `next:` snapshot line (MODIFY snapshot) | observer | transform | `observers/snapshot.js` `composeSnapshot` (`follow_target:` line) | exact |
| procedural memory write-back (MODIFY orchestrator) | service | event-driven (on success) | `brain/memory/memoryLog.js` `appendMemory` + orchestrator `remember` handler | exact |
| `prompts.js` capability rewrite (MODIFY) | config/prompt | n/a | `adapter/minecraft/prompts.js` `CAPABILITY_PARAGRAPH` + `ACTION_DESCRIPTIONS` | exact |
| reflex config keys (MODIFY `config.js`) | config | n/a | `config.js` `MinecraftAdapterSchema` | exact |
| registry wiring for new actions (MODIFY `registry.js`) | registry | n/a | `registry.js` `registry.register(...)` calls | exact |

---

## Pattern Assignments

### `behaviors/reflex.js` (NEW — highest leverage, D-05)

**Analog:** `src/bot/adapter/minecraft/behaviors/combat.js` (the `startCombat` factory).

**1. Module-scoped `HOSTILE_MOBS` set to reuse verbatim** — `combat.js:4-10`:
```js
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'phantom', 'drowned', 'husk', 'stray',
  'pillager', 'vindicator', 'evoker', 'ravager', 'enderman', 'endermite',
  'silverfish', 'guardian', 'elder_guardian', 'wither_skeleton', 'hoglin',
  'piglin_brute', 'zoglin',
])
```
Hoist this into a shared module (or re-export from `combat.js`) rather than duplicating — the reflex loop scans the same set each tick.

**2. The `startCombat` factory shape `startReflex` must mirror** — `combat.js:35-90`. Note the structure: a top-level `export function startCombat(bot, config)` that (a) resolves `const mc = config?.adapter?.minecraft ?? config ?? {}` for config keys (line 49), (b) closes over `let` state, (c) defines `start*`/`stop*` inner fns that `clearInterval`/`clearTimeout` before re-arming, (d) subscribes to bot events. `startReflex` keeps the same skeleton but its loop is a `physicsTick` subscription instead of `setInterval`:
```js
// combat.js:49-51 — config slice + threshold read (COPY this access path)
const mc = config?.adapter?.minecraft ?? config ?? {}
const throttleMs = Number.isFinite(mc.attack_react_throttle_ms) ? mc.attack_react_throttle_ms : 3500
```

**3. The interval-loop finite-state guard (knockback NaN skip)** — `combat.js:58-80`. The reflex tick must reuse this defensive pre-check before reading positions/velocities each tick:
```js
const vel = bot.entity?.velocity
const pos = bot.entity?.position
if (!vel || !pos) return
if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) return
if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return
```

**4. The mutex / save-restore pattern** — research `v0.4-mc-reflex-dodge.md` §6 + `combat.js` `stopAttacking` (lines 83-90, which calls `bot.pathfinder?.stop()` then `startFollow`). For reflex, the goal-owning creeper-flee must `save bot.pathfinder.goal → setGoal(GoalInvert(GoalFollow(creeper, FLEE_RANGE)), true) → restore`, coordinated via a new `bot._seiReflexActive` boolean mutex. **The yield contract:** `follow.js:104` already gates on `if (!bot.pathfinder.isMoving())` before re-installing its goal — `follow`/`goTo`/`gather` must additionally check `bot._seiReflexActive` and yield while a flee owns the goal. Wire `GoalInvert`/`GoalFollow` from the same import as `follow.js:1-2`:
```js
import pkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = pkg
// goals.GoalInvert(new goals.GoalFollow(creeper, 10))  — research §5, no new dep
```

**5. Tick subscription model** — there is no existing `physicsTick` loop in the repo (combat/follow use `setInterval`). Use `bot.on('physicsTick', ...)` per research §3-4 (50 ms = the `reflex_tick_ms` config key). Mirror `combat.js:126-128` for teardown on `entityGone`/death.

**6. Wiring site** — `connect.js:242-256`. Add `startReflex(bot, config)` directly beside `startCombat(bot, config)` (line 250) inside the first-spawn block, and re-arm on respawn beside `startFollow` (line 255):
```js
// connect.js:250 — add the sibling call right here
startCombat(bot, config)
startFollow(bot, config)
```
Import at `connect.js:21` next to `import { startCombat } from './behaviors/combat.js'`.

**7. In-character announcement (D-05)** — the reflex emits a `say()`-style line via the bot event bus, NOT by calling the registry. Follow `combat.js:108-112` which emits `bot.emit('sei:attacked', payload)` (throttled). Reflex should emit a similar one-shot event the orchestrator surfaces; do NOT enqueue into the FSM (D-05: runs outside `fsm.js`).

---

### `behaviors/furnace.js` (NEW — MCRAFT-01, D-09)

**Analog:** `src/bot/adapter/minecraft/behaviors/container.js` (near-exact template).

**1. Module-scoped single-flight SESSION + global close** — `container.js:9-21`:
```js
export const OPEN_TIMEOUT_MS = 6000
export const TRANSFER_TIMEOUT_MS = 4000
const REACH = 4
const SESSION = { container: null, blockPos: null }

export async function closeContainerSession() {
  if (SESSION.container) {
    try { await SESSION.container.close() } catch {}
    SESSION.container = null
    SESSION.blockPos = null
  }
}
```
Furnace gets its own `FURNACE_SESSION` + `closeFurnaceSession()`. Note the orchestrator calls `closeContainerSession()` on chain-end/abort — register the furnace equivalent the same way (search for that call site in the orchestrator and add the furnace close beside it).

**2. Open pattern (reach check + timeout race + abort race)** — `container.js:42-79`. Copy verbatim, swapping `bot.openContainer(target)` for `bot.openFurnace(target)` (mineflayer returns a `Furnace` with `.inputItem()/.fuelItem()/.outputItem()` and `.putInput()/.putFuel()/.takeOutput()` — see `v0.4-mc-mineflayer-skills.md`):
```js
const op = bot.openContainer(target)         // → bot.openFurnace(target)
  .then((container) => { SESSION.container = container; SESSION.blockPos = target.position; return `opened ${targetName}` })
  .catch((err) => { const r = reason(err); return r ? `cannot open ${targetName}: ${r}` : `cannot open ${targetName}` })
const tmo = new Promise((r) => setTimeout(async () => { await closeContainerSession(); r('timeout') }, timeoutMs))
const abrt = attachAbort(signal, closeContainerSession)
return Promise.race([op, tmo, abrt])
```

**3. The `attachAbort` helper + `itemIdByName`** — `container.js:23-40`. Reuse both unchanged. The 3 furnace slot ops (load input, load fuel, take output) each follow the `depositItemAction`/`withdrawItemAction` template (`container.js:81-145`): `if (signal?.aborted) return 'aborted'` → `if (!SESSION.container) return 'no furnace open'` → resolve item id → `Promise.race([op, tmo, abrt])` with per-op timeout.

---

### sign-reading primitive (NEW behavior + registry tool — MCRAFT-04, D-09)

**Analog (handler skeleton):** `behaviors/activate.js:6-31`. **Analog (block-text decode):** mineflayer exposes `block.signText` / `block.getSignText()` on a `bot.blockAt(pos)` — read the block like `resolveBlock` does in `container.js:49`. The metadata-decode mindset mirrors `observers/entities.js:19-33` `droppedItemName` (scan a structured field for the human-readable string, return `null` when it hasn't arrived):
```js
// activate.js:6-13 — the handler shell to copy (signal guard + timeout + reason())
export async function activateItemAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  ...
  const timeoutMs = args?.timeout_ms ?? config?.activate_timeout_ms ?? DEFAULT_TIMEOUT_MS
```
Sign-reading is read-only — likelier surfaced as a snapshot line (see `next:` pattern) and/or a `readSign` tool returning `{ text }`. If it becomes a snapshot line, follow the `composeSnapshot` `lines.push(...)` pattern (below) instead of a registry action.

---

### `behaviors/activateBlock.js` (NEW — door/gate, MCRAFT-05, D-09)

**Analog:** `behaviors/activate.js` (the *current* `activate.js` only right-clicks the held item — `bot.activateItem()` at line 16; door/gate needs `bot.activateBlock(block)`).

Copy the entire `activate.js` handler shape (lines 6-31): signal-abort guard, `Promise.race([op, tmo, abrt])`, `reason(err)` formatting. Swap the core call:
```js
// activate.js:15-21 — replace bot.activateItem() with bot.activateBlock(target)
const op = Promise.resolve()
  .then(() => bot.activateItem())            // → bot.activateBlock(resolveBlock(args, bot))
  .then(() => `activated ${heldName}`)        // → `opened ${targetName}`
  .catch((err) => { const r = reason(err); return r ? `cannot activate ${heldName}: ${r}` : `cannot activate ${heldName}` })
```
Resolve the target block with `resolveBlock(args, bot)` + the reach check from `container.js:49-55`. Register with `TargetShape` (see registry section).

---

### shelter building (registry wiring — MCRAFT-06, D-09)

**Analog:** `behaviors/build.js` (`buildAction`, `enumerateBuildCells` at lines 33-50) + `registry.js` `BuildSchema` (lines 78-91) and its registration (line 249).

The 256-cell cuboid already exists and is schema-capped. A shelter is a *composition* of existing `build` calls (4 hollow walls + a roof layer + a door gap), not a new primitive. Two viable shapes:
- Keep it LLM-driven: rewrite the prompt so the bot composes `build({from,to,hollow:true})` + a roof `build`. No new code — see `build.js:110-111` description already documents `hollow:true` = 4 vertical walls.
- OR add a thin `shelter` convenience action that calls `buildAction` N times. If so, follow `registry.js:249` registration and the `BuildSchema` cell-cap `.refine` (lines 83-90) to keep the 256-cell guarantee.

```js
// build.js:33-49 — cell enumeration is already correct for walls/roof
export function enumerateBuildCells(from, to, hollow) { ... }   // hollow=true → walls only
```

---

### `progression.json` + `nextMilestone(state, goal)` walker (NEW — MCRAFT-07, D-07)

**Analog/basis:** `observers/progression.js` (the entire file — `SPINE` array lines 52-69, `computeProgression` lines 110-136, `matchGoalToNode` lines 144-153, `readProgressionState` lines 190-201).

The phase **externalizes `SPINE` to `progression.json`** and adds a `nextMilestone(state, goal)` walker. The existing functions are the walker — `computeProgression` already returns `{ frontier, currentMilestone, furthest, complete }` and `matchGoalToNode` already links free-text goals to a node. The work is:
1. Move the `SPINE` literal (lines 52-69) into `progression.json`, load it, keep the derived `SPINE_BY_ID`/`SUCCESSORS` maps (lines 71-74).
2. Add `nextMilestone(state, goal)` = `matchGoalToNode(goal, frontier)` ?? `computeProgression(state).currentMilestone`, returning the node + its single advancing action.

**Node shape to preserve in JSON** (`progression.js:52`):
```js
{ id: 'furnace', kind: 'get', label: 'make a furnace', key: 'furnace',
  needs: ['stone_pickaxe'], goal: { have: 'furnace' } }
```
**Keep the defensive contract** (`progression.js:190-201`): `readProgressionState` swallows errors → empty state so a snapshot tick never throws. The live bot reader (`bestPickaxeTier` 156-166, `itemsByName` 168-176) stays in `.js`; only the static graph moves to JSON.

---

### `next:` snapshot line (MODIFY — D-07)

**Analog:** `observers/snapshot.js` `composeSnapshot` (line 70) — specifically the `follow_target:` line at lines 217-227 and the simpler `lines.push` calls. The `getProgression` accessor already exists at `index.js:98`.

Append a single advisory line using the established push pattern:
```js
// snapshot.js:226 — the follow_target line is the exact shape to mirror
lines.push(`follow_target: ${followLabel ?? '(none)'}`)
// NEW: next: <currentMilestone.label> — <single advancing action>
```
The progression view is read via the adapter accessor (`index.js:98`):
```js
getProgression: (flags = {}) => readProgression(bot, flags),
```
Note: the existing `frontier` already reaches the model via the **heartbeat** (`orchestrator.js:1098-1118` computes `frontierText` from `prog.frontier`, `renderHeartbeat` at line 349 frames it). The new `next:` line is the *per-turn snapshot* surfacing of `currentMilestone` — additive, scoped to the snapshot, do not remove the heartbeat path.

---

### procedural memory write-back (MODIFY — D-08)

**Analog:** `brain/memory/memoryLog.js` `appendMemory` (lines 78-99) + the orchestrator `remember` handler (`orchestrator.js:1847-1864`).

The memory store API is `createMemoryLog({ path })` → `{ append(text, when), forget, readAll, noteWorld }` (`memoryLog.js:34-43`). The orchestrator already holds `memoryLog` (`orchestrator.js:463`) and writes via:
```js
// orchestrator.js:1854-1857 — the exact append + compaction trigger to reuse
await memoryLog.append(text, new Date())
lastActionResult = 'remembered'
memoryCompactor.maybeCompact().catch(err => logger.warn?.(`...`))
```
For procedural write-back after a multi-step success, call `memoryLog.append(procedureText, new Date())` from the success path (terse known-good procedure, e.g. "iron: dig to y≤16, mine iron_ore, smelt in furnace w/ coal"). Entries are append-only `- [iso] text` lines (`memoryLog.js:29-32`); they roll into the existing byte-threshold compaction automatically — no new mechanism needed. **Do not** introduce a parallel store; reuse the per-world `MEMORY.md` (segmented by `noteWorld`, `memoryLog.js:54-76`).

---

### `prompts.js` capability rewrite (MODIFY — D-09)

**Analog:** `adapter/minecraft/prompts.js` — `CAPABILITY_PARAGRAPH` (lines 9-12) and `ACTION_DESCRIPTIONS` (lines 86-116).

The load-bearing sentence to **delete/rewrite** is `prompts.js:10`:
```
You can't smelt in a furnace, ride mounts, enchant, brew potions, or build redstone — those aren't available to you yet. ... a smelted ingot is something you request, not something you make
```
After this phase the bot CAN smelt (furnace), read signs, open doors, build shelters — rewrite the paragraph to add those abilities and drop the "ask the player to smelt" deferral. Add `ACTION_DESCRIPTIONS` entries for each new tool following the existing one-paragraph-per-action style (`prompts.js:86-115`), e.g. mirror the `placeBlock` (line 101-102) and `attackEntity` (line 86-87) entries. The paragraph is a **cached system block** (`anthropicClient.js:307`, index 2) — keep it concise; per-turn churn is expensive.

---

### reflex config keys (MODIFY `config.js` — D-05)

**Analog:** `config.js` `MinecraftAdapterSchema` (lines 17-34).

Add the new keys inside `MinecraftAdapterSchema` following the existing `z.number()...default(...)` style (the `attack_react_throttle_ms` key at line 33 is the closest sibling):
```js
// config.js:33 — copy this declaration style for each reflex key
attack_react_throttle_ms: z.number().int().min(0).default(3500),
```
New keys (D-05 thresholds): `reflex_enabled: z.boolean().default(true)`, `reflex_tick_ms: z.number().int().min(0).default(50)`, `arrow_watch_blocks` (16), `arrow_miss_threshold` (1.2, non-int → `z.number()`), `creeper_flee_enter_blocks` (8), `creeper_flee_exit_blocks` (12), `melee_kite_blocks` (4.5). They are read in `reflex.js` via the `mc = config?.adapter?.minecraft ?? config ?? {}` slice (combat.js:49 pattern).

---

### registry wiring for new actions (MODIFY `registry.js` — D-03/D-09)

**Analog:** `registry.js` — every `registry.register(name, ZodSchema, handler)` call (lines 128-436) and the shared shapes `TargetShape` (lines 36-46) / `Vec3Shape` (line 48).

**Registration shape to follow** — `registry.js:418` (openContainer uses `TargetShape`) and `registry.js:251` (build):
```js
registry.register('openContainer', TargetShape, openContainerAction)
registry.register('build', BuildSchema, buildAction)
```
New actions:
- furnace ops → import from `./behaviors/furnace.js`, register `openFurnace` with `TargetShape` and the 3 slot ops with `{ item, count }` schemas (mirror `depositItem`/`withdrawItem` at lines 420-436).
- door/gate → `registry.register('activateBlock', TargetShape, activateBlockAction)`.
- sign read → `registry.register('readSign', TargetShape, readSignAction)` (or surface via snapshot, no registry entry).
- Import each new behavior at the top alongside lines 11-33. Keep the closed-registry invariant (D-03): typed Zod schema + handler only, no code/coordinates from the LLM.

---

## Shared Patterns

### Behavior handler skeleton (signal-abort + timeout race + `reason()`)
**Source:** `behaviors/activate.js:6-31`, `behaviors/container.js:42-79`.
**Apply to:** furnace, activateBlock, readSign (every new registry action).
```js
export async function fooAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const timeoutMs = args?.timeout_ms ?? config?.foo_timeout_ms ?? DEFAULT_TIMEOUT_MS
  const op = Promise.resolve().then(() => bot.doThing()).then(() => `ok`).catch((err) => {
    const r = reason(err); return r ? `cannot foo: ${r}` : `cannot foo`
  })
  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))
  const abrt = new Promise((r) => { if (!signal) return; signal.addEventListener('abort', () => r('aborted'), { once: true }) })
  return Promise.race([op, tmo, abrt])
}
```
`reason()` is `import { reason } from '../../../brain/errStrings.js'`.

### Config-slice resolution
**Source:** `combat.js:49`, `follow.js:81`.
**Apply to:** `reflex.js` and any behavior reading `adapter.minecraft.*` keys.
```js
const mc = config?.adapter?.minecraft ?? config ?? {}
const range = Number.isFinite(mc.someKey) ? mc.someKey : DEFAULT
```
(The caller passes top-level `config`; keys live under `config.adapter.minecraft`.)

### Pathfinder goal yield / mutex
**Source:** `follow.js:104` (`if (!bot.pathfinder.isMoving())` before re-installing its goal); research `v0.4-mc-reflex-dodge.md` §6.
**Apply to:** `reflex.js` (creeper-flee owns the goal), and `follow`/`goTo`/`gather` must additionally yield to `bot._seiReflexActive`.

### Snapshot line emission
**Source:** `observers/snapshot.js:226` (`lines.push(...)`), accessor `index.js:98`.
**Apply to:** the `next:` progression line and (optionally) sign text.

### Memory append
**Source:** `memoryLog.js:78-99`, used at `orchestrator.js:1854`.
**Apply to:** procedural write-back. `await memoryLog.append(text, new Date())` then `memoryCompactor.maybeCompact()`.

### Registry registration
**Source:** `registry.js:128-436`. `registry.register(name, ZodSchema, handler)`; reuse `TargetShape` (36-46) / `Vec3Shape` (48) / cuboid-cap `.refine` (83-90).

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| (none) | — | — | Every new artifact has a strong in-repo template. The only genuinely *new* mechanism is the `bot.on('physicsTick')` 20 Hz loop — there is no existing `physicsTick` subscriber (combat/follow use `setInterval`), so `reflex.js` borrows the *factory + mutex + NaN-guard* shape from `combat.js` but the tick driver itself follows `v0.4-mc-reflex-dodge.md` §3-4, not a code analog. The arrow-dodge ray math (closest-approach) is also new code (~40 LOC, research §4) with no repo precedent. |

## Metadata

**Analog search scope:** `src/bot/adapter/minecraft/{behaviors,observers}/`, `src/bot/adapter/minecraft/{registry,connect,prompts,index}.js`, `src/bot/brain/memory/`, `src/bot/brain/{orchestrator,prompts}.js`, `src/bot/config.js`.
**Files scanned:** ~18 source files read in full or targeted ranges.
**Pattern extraction date:** 2026-06-25
