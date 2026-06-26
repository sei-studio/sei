---
phase: 17-minecraft-competence
plan: 02
subsystem: bot
tags: [mineflayer, reflex, pathfinder, fsmWires, mutex, goal-yield, integration]

# Dependency graph
requires:
  - phase: 17-01 (this phase, wave 1)
    provides: "startReflex(bot, config) controller, bot._seiReflexActive/_seiSavedGoal mutex, bot.emit('sei:reflex', {threat, threatLabel, noticed, count})"
provides:
  - "startReflex wired live at connect.js (first spawn + respawn re-arm)"
  - "waitForReflexClear(bot, signal, budgetMs) — non-destructive pathfinder goal-yield helper (pathfind.js)"
  - "follow/goTo/gather yield to bot._seiReflexActive instead of racing the creeper flee"
  - "fsmWires sei:reflex → handlers.onAttacked translation tagged attackerKind:'reflex' (+ threatLabel, noticed, count)"
affects: [17-05 (prompt framing consumes attackerKind:'reflex'), 17-06 (live evasion checkpoint)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Non-destructive pathfinder goal-yield: consumers park (await waitForReflexClear) while a reflex flee owns the goal, then resume their original destination — never abort/stop the action"
    - "A GoalChanged rejection during an active reflex is treated as a yield (loop & re-issue), not a cant_reach failure"
    - "Thin event-translation wire (sei:reflex onto the existing onAttacked P1 route) with a distinguishing kind tag — no new brain handler"

key-files:
  created: []
  modified:
    - src/bot/adapter/minecraft/connect.js
    - src/bot/adapter/minecraft/behaviors/follow.js
    - src/bot/adapter/minecraft/behaviors/pathfind.js
    - src/bot/adapter/minecraft/behaviors/mineVein.js
    - src/bot/adapter/minecraft/fsmWires.js

key-decisions:
  - "pathfind.js/mineVein.js install goals via bot.pathfinder.goto() (async), not setGoal — gated the goto() site with a reflex-yield wait rather than the plan's literal setGoal precondition"
  - "Reflex-distinguishing contract for Plan 05: attackerKind:'reflex' plus attackerLabel (threatLabel), noticed (telegraph flag) and count (nearby hostiles)"

requirements-completed: [MCRAFT-02, MCRAFT-03]

# Metrics
duration: ~15min
completed: 2026-06-26
---

# Phase 17 Plan 02: Reflex Live Wiring + Consumer Yield Summary

**Turns the Plan 01 reflex controller on in a running session: startReflex starts beside startCombat at connect (re-armed on respawn), follow/goTo/gather stand down to the bot._seiReflexActive goal mutex instead of fighting a creeper flee tick-for-tick, and a reflex engagement is surfaced to the brain as an in-character announcement via fsmWires — all with the evasion loop staying entirely outside fsm.js.**

## Performance
- **Duration:** ~15 min
- **Completed:** 2026-06-26
- **Tasks:** 3 (all type=auto)
- **Files modified:** 5 (0 created, 5 modified)

## Accomplishments
- Wired `startReflex(bot, config)` into `connect.js`: imported beside `startCombat`, started on first spawn, and re-armed on the respawn branch (Plan 01's disposer tears the loop down on death, so respawn must re-arm).
- Added `waitForReflexClear(bot, signal, budgetMs)` to `pathfind.js` — a non-destructive yield that parks the caller while `bot._seiReflexActive` is true, returning `'clear'|'aborted'|'timeout'` and respecting the abort signal + wall-clock budget.
- `follow.js`: the 1s `GoalFollow` re-install is now gated on `!bot._seiReflexActive`, so the follow tick yields the goal to the flee.
- `goTo` (pathfind.js): replaced the single `goto()` with a park/resume loop — it waits for the reflex to clear before installing its goal, and treats a `GoalChanged` rejection during an active reflex as a yield (loop and re-issue) rather than a `cant_reach`. The in-flight goTo pauses and continues to its original destination once the flee releases the goal.
- `gather` (mineVein.js): the per-block loop pauses on `bot._seiReflexActive` and resumes the same remaining vein blocks afterward — the batch is never cancelled.
- fsmWires: added an `onSeiReflex` wire translating the `sei:reflex` payload onto the existing `handlers.onAttacked` P1 chat-reaction route, tagged `attackerKind:'reflex'` (plus `threatLabel`, `noticed`, `count`); detached in `dispose()`.

## Task Commits
1. **Task 1: Wire startReflex at connect (spawn + respawn)** - `5fc3c8b` (feat)
2. **Task 2: Make follow/goTo/gather yield to the reflex mutex** - `765f240` (feat)
3. **Task 3: Surface the reflex announcement via fsmWires** - `ca346bc` (feat)

## Files Modified
- `src/bot/adapter/minecraft/connect.js` — import + start `startReflex` on first spawn and respawn (`grep -c "startReflex(bot, config)"` == 2).
- `src/bot/adapter/minecraft/behaviors/follow.js` — line-104 re-install gated on `!bot._seiReflexActive`.
- `src/bot/adapter/minecraft/behaviors/pathfind.js` — new `waitForReflexClear` helper; `goTo` park/resume yield loop.
- `src/bot/adapter/minecraft/behaviors/mineVein.js` — imports `waitForReflexClear`; per-block loop yields the batch during a flee.
- `src/bot/adapter/minecraft/fsmWires.js` — `onSeiReflex` translation wire + dispose detach.

## Contract for Plan 05 (prompt framing)
The reflex announcement reaches the brain through `handlers.onAttacked` with:
- `attackerKind: 'reflex'` — the discriminator distinguishing a proactive evasion warning from a real hit.
- `attackerLabel` — the threat label (`payload.threatLabel`, falling back to `threat.name` then `'a threat'`).
- `noticed` (bool) — true when a positive telegraph (creeper fuse/ignite) drove the flee.
- `count` (number) — nearby hostiles within the exit band (defaults to 1).

Plan 05 should phrase this as an in-character warning naming the threat and offering `attack()` / `explore()`, NOT "you were hit".

## Decisions Made
- Gated the `bot.pathfinder.goto()` site (the actual goal-install in `goTo`/`gather`) rather than a literal `setGoal` precondition — see Deviations.
- Reused the established `onAttacked` route for the announcement (no new brain handler), keeping fsmWires a thin translation layer per its module contract; the emit does not enqueue evasion work.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Yield-gate placed at `pathfinder.goto()`, not `pathfinder.setGoal()`**
- **Found during:** Task 2
- **Issue:** The plan's task body and acceptance criteria say to gate "every `bot.pathfinder.setGoal` in pathfind.js and mineVein.js." Neither file calls `setGoal` — `goTo` installs its goal via the async `bot.pathfinder.goto(goal)` (one-shot promise) and `gather` reaches the pathfinder only indirectly through `goTo`. Gating a non-existent `setGoal` call would have left both consumers racing the flee (the truth in `must_haves` would be unmet).
- **Fix:** Added `waitForReflexClear` and gated the real goal-install site: `goTo` parks before `goto()` and treats a `GoalChanged`-during-reflex rejection as a yield (loop & re-issue); `gather` pauses its per-block loop on `bot._seiReflexActive`. Both reference `_seiReflexActive` (acceptance grep satisfied) and neither calls abort/stop when yielding (non-destructive, T-17-04 mitigation intact).
- **Files modified:** src/bot/adapter/minecraft/behaviors/pathfind.js, src/bot/adapter/minecraft/behaviors/mineVein.js
- **Verification:** `npx vitest run src/bot/adapter/minecraft/behaviors/` green (73/73); full `src/bot` suite green (277/277).
- **Committed in:** `765f240` (Task 2)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** The intent (consumers yield to the flee, non-destructively) is fully met; only the literal API name in the plan was wrong for the installed code. No scope change — the mutex contract and yield semantics are exactly as specified.

## Threat Surface
No new security-relevant surface. T-17-04 (goal-thrash) is mitigated by the non-destructive yield — consumers park and resume the flee-restored goal rather than re-racing, and no action is aborted on yield. T-17-05 (sei:reflex into the brain) stays a fixed-shape translation in fsmWires (threat label + booleans + count); no raw world strings or coordinates flow to dispatch. T-17-06 (listener leak) is covered by the respawn re-arm pairing with Plan 01's death-teardown disposer and the fsmWires `dispose()` detaching `sei:reflex`. No new npm packages.

## Known Stubs
None.

## Issues Encountered
None beyond the deviation above.

## Next Phase Readiness
- Plan 05 can frame the `attackerKind:'reflex'` announcement (contract documented above).
- Plan 06 validates live evasion end-to-end in a real session (checkpoint) — the wiring, yield, and announcement paths are all in place.

## Self-Check: PASSED
- All 5 modified files present on disk.
- All 4 commits (3 task + 1 docs) found in git history.
- STATE.md / ROADMAP.md untouched (worktree mode — orchestrator owns those).

---
*Phase: 17-minecraft-competence*
*Completed: 2026-06-26*
