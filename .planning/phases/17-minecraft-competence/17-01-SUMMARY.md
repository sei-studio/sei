---
phase: 17-minecraft-competence
plan: 01
subsystem: bot
tags: [mineflayer, reflex, combat, pathfinder, physicsTick, evasion, zod-config]

# Dependency graph
requires:
  - phase: v0.3 (shipped)
    provides: combat.js startCombat factory, HOSTILE_MOBS set, follow.js pathfinder goal pattern, config MinecraftAdapterSchema
provides:
  - "startReflex(bot, config) — ~20 Hz physicsTick survival controller (arrow sidestep, creeper goal-owning flee, melee circle-strafe), returns a dispose()"
  - "closestApproach(arrowPos, arrowVel, botPos) — pure point-to-line ray test returning { missDist, ahead }"
  - "scanThreats(bot, mc) — priority threat classifier (creeper-panic > arrow > creeper > melee)"
  - "resolveReflexThresholds(mc, personaWeights) — D-06 per-persona threshold hook (fixed defaults this phase)"
  - "bot._seiReflexActive / bot._seiSavedGoal mutex contract for goal-owning flee"
  - "bot.emit('sei:reflex', { threat, threatLabel, noticed, count }) one-per-engagement announcement"
  - "behaviors/hostiles.js — shared HOSTILE_MOBS set"
  - "seven adapter.minecraft reflex config keys"
affects: [17-02 (live wiring + consumer yield), fsmWires, prompts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "physicsTick (~20 Hz) adapter-side reflex loop running entirely outside fsm.js"
    - "goal_updated event tracking to snapshot/restore the action goal (pathfinder ^2.4.5 hides bot.pathfinder.goal)"
    - "D-06 single-function per-persona threshold override hook (resolveReflexThresholds)"
    - "enter/exit hysteresis bands to prevent goal-thrash oscillation"

key-files:
  created:
    - src/bot/adapter/minecraft/behaviors/reflex.js
    - src/bot/adapter/minecraft/behaviors/reflex.test.js
    - src/bot/adapter/minecraft/behaviors/hostiles.js
  modified:
    - src/bot/adapter/minecraft/behaviors/combat.js
    - src/bot/config.js

key-decisions:
  - "Track the external action goal via the goal_updated event rather than bot.pathfinder.goal (not exposed in mineflayer-pathfinder ^2.4.5) for a faithful flee save/restore"
  - "Active-flee maintenance lives in the tick (not scanThreats) so exit hysteresis at the 12-block band works even though scanThreats only reports a creeper at the 8-block enter band"
  - "wither_skeleton is both a ranged (bow-draw) and melee threat — it falls through to the melee check"

patterns-established:
  - "Reflex tier: structured-state evasion (D-04 hybrid hierarchy) issued as non-goal control-state pulses, with the single goal-owning exception (creeper flee) mediated by a bot._seiReflexActive mutex"
  - "Pure ray-geometry core (closestApproach) split out for unit testing, no Vec3 dependency"

requirements-completed: [MCRAFT-02, MCRAFT-03]

# Metrics
duration: ~25min
completed: 2026-06-26
---

# Phase 17 Plan 01: Reflex Evasion Micro-Controller Summary

**startReflex — a ~20 Hz physicsTick survival loop that evades incoming damage before it lands: arrow sidestep pulses (closest-approach ray test), a creeper goal-owning flee under the bot._seiReflexActive mutex, and melee circle-strafe, all running outside fsm.js.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-06-26
- **Tasks:** 3 (2 TDD)
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- Hoisted the 26-name `HOSTILE_MOBS` set into a shared `hostiles.js` module (combat.js now imports it; behavior byte-identical aside from the import).
- Added seven `adapter.minecraft` reflex config keys (D-05 thresholds) with documented defaults; config parses unchanged for existing files.
- Built `startReflex` mirroring the `startCombat` factory: physicsTick subscription, knockback NaN/finite guard, threat scan, three evasion mechanisms, and a `dispose()` that tears down every listener and timer.
- Pure `closestApproach` ray math unit-tested (direct hit, already-past, lateral miss); `scanThreats` priority unit-tested (fusing creeper outranks an incoming arrow).
- Creeper flee transparently takes over the pathfinder goal (`GoalInvert(GoalFollow(creeper, exit))`), saves/restores the prior goal under enter/exit hysteresis with no boundary oscillation, and fires exactly one `sei:reflex` announcement per engagement.

## Task Commits

1. **Task 1: Hoist HOSTILE_MOBS + add reflex config keys** - `9d07308` (refactor)
2. **Task 2 (TDD): Threat scan + arrow dodge + melee strafe** - `a183859` (test, RED) → `2a57766` (feat, GREEN)
3. **Task 3 (TDD): Creeper flee + mutex + announcement** - `71a2caf` (test, RED) → `c742391` (feat, GREEN)

## Files Created/Modified
- `src/bot/adapter/minecraft/behaviors/reflex.js` - The reflex survival controller: `startReflex`, `closestApproach`, `scanThreats`, `resolveReflexThresholds`.
- `src/bot/adapter/minecraft/behaviors/reflex.test.js` - 15 unit tests (ray math, threshold hook, threat priority, pulse non-goal-contention, creeper flee save/restore + hysteresis + single announcement).
- `src/bot/adapter/minecraft/behaviors/hostiles.js` - Shared `HOSTILE_MOBS` set (26 vanilla hostiles).
- `src/bot/adapter/minecraft/behaviors/combat.js` - Now imports `HOSTILE_MOBS` from `./hostiles.js` (Set literal removed).
- `src/bot/config.js` - Seven reflex keys in `MinecraftAdapterSchema` (`reflex_enabled`, `reflex_tick_ms`, `arrow_watch_blocks`, `arrow_miss_threshold`, `creeper_flee_enter_blocks`, `creeper_flee_exit_blocks`, `melee_kite_blocks`).

## Public Surface for Plan 02 (live wiring)

- `startReflex(bot, config)` → returns `dispose()`. No-ops (returns a no-op disposer) when `mc.reflex_enabled === false`. Subscribes `physicsTick`, `death` (once), `goal_updated`.
- `closestApproach(arrowPos, arrowVel, botPos)` → `{ missDist, ahead }` (pure; plain `{x,y,z}` inputs).
- `scanThreats(bot, mc)` → `{ kind: 'arrow'|'creeper'|'melee', entity, sideHint?, panic? }` or `null`.
- `resolveReflexThresholds(mc, personaWeights)` → fixed defaults today; the **D-06 per-persona override point** (the tick reads all thresholds through it).
- **Mutex contract:** `bot._seiReflexActive` (bool) is true while a creeper flee owns the pathfinder goal; `bot._seiSavedGoal` holds the action goal to restore. Consumers `follow`/`goTo`/`gather` must yield their `setGoal` while `bot._seiReflexActive` is true (Plan 02 work).
- **Offensive suppression:** melee strafe is suppressed when `bot._seiOffensiveTarget === mob.id`.
- **Announcement:** `bot.emit('sei:reflex', { threat, threatLabel, noticed, count })` fires once per engagement (rising edge). `noticed` is true when a positive telegraph (creeper fuse/ignite) drove the flee; `count` is the number of nearby hostiles within the exit band. Plan 02's fsmWires translates this into an in-character `say()` offering attack()/explore(). The emit does NOT enqueue into fsm.js.

## Decisions Made
- Track the external action goal via the `goal_updated` event (with `bot.pathfinder.goal` as a defensive fallback) — see Deviations.
- Compute thresholds once per `startReflex` (`TH`) since persona weighting is ignored this phase; `scanThreats` re-resolves internally for callers that pass only `mc`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Goal snapshot uses the `goal_updated` event, not `bot.pathfinder.goal`**
- **Found during:** Task 3 (Creeper flee goal takeover)
- **Issue:** The plan specifies snapshotting the action goal via `bot._seiSavedGoal = bot.pathfinder.goal`. The installed `mineflayer-pathfinder` (^2.4.5) does NOT expose `bot.pathfinder.goal` as a public field (only `setGoal`/`isMoving`/`isMining`/`isBuilding`; the goal + dynamic flag are closure-private and surfaced only through the `goal_updated` event). Reading `bot.pathfinder.goal` would silently capture `undefined`, so the flee would restore a null goal and strand `gather()`/`follow()`.
- **Fix:** Subscribe to `goal_updated` and maintain `_trackedGoal`/`_trackedDynamic`, masking our own flee set/restore via a `_selfSetting` flag. `enterFlee` snapshots the tracked goal (with `bot.pathfinder.goal` as a defensive fallback) and `exitFlee` restores it with its dynamic flag. The `goal_updated` listener is removed in `dispose()`.
- **Files modified:** src/bot/adapter/minecraft/behaviors/reflex.js
- **Verification:** Test drives a creeper 7→13 blocks and asserts the prior goal is restored exactly once with no boundary oscillation; full suite green.
- **Committed in:** `c742391` (Task 3 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** The fix is required for the save/restore contract to actually work against the installed pathfinder version; the public mutex contract (`bot._seiReflexActive`/`bot._seiSavedGoal`) and behavior are exactly as the plan specified. No scope creep.

## Issues Encountered
None beyond the deviation above.

## Threat Surface
No new security-relevant surface introduced. The loop reads server-controlled entity state only (untrusted input), distance-caps the scan before any math, reuses the combat.js NaN/finite guard, and tears down on death/dispose — matching the plan's threat register (T-17-01/02 mitigated, T-17-03 accepted). No new npm packages (T-17-SC).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 can wire `startReflex(bot, config)` beside `startCombat` in `connect.js` and make `follow`/`goTo`/`gather` yield on `bot._seiReflexActive`, and translate `sei:reflex` in `fsmWires` — all against the documented public surface above without re-reading reflex.js.
- No live wiring was done in this plan (by design): `startReflex` is unit-tested in isolation but not yet called anywhere.

---
*Phase: 17-minecraft-competence*
*Completed: 2026-06-26*
