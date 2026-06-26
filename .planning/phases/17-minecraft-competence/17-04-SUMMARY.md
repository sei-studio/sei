---
phase: 17-minecraft-competence
plan: 04
subsystem: bot
tags: [progression, minecraft, memory, snapshot, mineflayer, json-data]

# Dependency graph
requires:
  - phase: 17-minecraft-competence
    provides: "observers/progression.js (SPINE DAG + computeProgression + matchGoalToNode), brain/memory/memoryLog.js, brain/orchestrator.js progression-goal linking"
provides:
  - "progression.json — the externalized 16-node spine DAG (static progression-graph layer, D-04/D-07)"
  - "loadSpine(url) — defensive JSON loader (degrade-to-empty)"
  - "nextMilestone(state, goal) -> { node, action } — pure static-graph walker (no GOAP)"
  - "per-turn snapshot `next:` advisory line (nearest milestone + advancing action)"
  - "appendProcedureOnce(node, deps) — D-08 procedural memory write-back, deduped by node id"
affects: [17-05, minecraft-competence, long-horizon-progression]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Static progression graph as a repo JSON asset loaded with import.meta.url + try/catch degrade-to-empty"
    - "Procedural memory write-back: reuse memoryLog.append + compaction trigger, deduped by a session Set"

key-files:
  created:
    - src/bot/adapter/minecraft/observers/progression.json
  modified:
    - src/bot/adapter/minecraft/observers/progression.js
    - src/bot/adapter/minecraft/observers/progression.test.js
    - src/bot/adapter/minecraft/observers/snapshot.js
    - src/bot/brain/orchestrator.js
    - src/bot/brain/orchestrator.test.js

key-decisions:
  - "Capture node.procedure onto activeFrontierGoal at setGoal-link time so the write-back never imports the minecraft spine into the game-agnostic brain"
  - "Dedupe procedural write-back via a session-scoped Set keyed by node id (plan-allowed alternative to a readAll scan)"
  - "Snapshot next: line reads readProgressionState(bot) with default flags — advisory only, complementary to the heartbeat frontier path"

patterns-established:
  - "Progression-as-data: the spine lives in JSON; the .js file only loads/derives/walks it"
  - "nextMilestone return shape { node, action } where action = node.next_action ?? node.label ?? null"

requirements-completed: [MCRAFT-07]

# Metrics
duration: ~20min
completed: 2026-06-26
---

# Phase 17 Plan 04: Progression Spine Externalization + Long-Horizon Coherence Summary

**The progression spine is now static data (progression.json) walked by a pure nextMilestone() function; every per-turn snapshot carries a `next:` advisory, and completing a milestone records its known-good procedure once into per-world memory — no GOAP planner, no new store.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-06-26T16:31Z
- **Completed:** 2026-06-26T16:40Z
- **Tasks:** 3 completed
- **Files modified:** 5 modified + 1 created

## Accomplishments
- Externalized the 16-node spine literal to `progression.json` (verbatim id/kind/label/key/needs/goal) loaded via `loadSpine(new URL('./progression.json', import.meta.url))` with a try/catch degrade-to-empty contract.
- Added optional `next_action` + `procedure` fields, populated for the iron-tier nodes (logs..iron_pickaxe); later nodes leave them empty and fall back to `label`.
- Added the pure `nextMilestone(state, goal)` walker returning `{ node, action }` (matchGoalToNode over the frontier wins, else currentMilestone).
- Added the per-turn snapshot `next: <label> — <action>` advisory line, try/caught so a bad spine never throws a snapshot tick.
- Added D-08 procedural memory write-back: `appendProcedureOnce` records a completed milestone's procedure once (append + compaction trigger), deduped by node id within the session, best-effort and non-fatal.

## Task Commits

Each task was committed atomically:

1. **Task 1: Externalize SPINE to progression.json + nextMilestone walker** — `2f09e21` (test, RED) → `1675823` (feat, GREEN)
2. **Task 2: Advisory next: snapshot line** — `de75e31` (feat)
3. **Task 3: Procedural memory write-back on milestone completion (D-08)** — `91dd025` (feat)

_TDD task 1 followed RED → GREEN; no refactor commit was needed._

## Files Created/Modified
- `src/bot/adapter/minecraft/observers/progression.json` (new) — the externalized spine DAG; all 16 nodes, iron-tier nodes carry `next_action` + `procedure`.
- `src/bot/adapter/minecraft/observers/progression.js` — loads SPINE from JSON via `loadSpine`; adds `nextMilestone`; existing compute/match/read logic unchanged.
- `src/bot/adapter/minecraft/observers/progression.test.js` — new tests for `loadSpine` degrade, JSON load shape, and `nextMilestone` cases.
- `src/bot/adapter/minecraft/observers/snapshot.js` — imports `nextMilestone` + `readProgressionState`; pushes the advisory `next:` line after `follow_target`, wrapped best-effort.
- `src/bot/brain/orchestrator.js` — exports `appendProcedureOnce`; session `writtenProcedures` Set; captures `node.procedure` on `activeFrontierGoal`; calls the write-back in the milestone-complete branch.
- `src/bot/brain/orchestrator.test.js` — 5 new unit tests proving the D-08 write-once + dedupe contract.

## Reference for downstream plans

- **nextMilestone return shape:** `{ node, action }` where `node` is the spine node (or `null` when complete) and `action` is `node.next_action ?? node.label ?? null`.
- **Snapshot `next:` line format:** `next: <node.label> — <action>` (em-dash separator; line omitted entirely when the game is complete or progression read fails).

## Decisions Made
- Capture `node.procedure` onto `activeFrontierGoal` at setGoal-link time rather than re-importing the minecraft SPINE into the game-agnostic brain — preserves the architecture boundary (brain reaches progression only via `adapter.getProgression`).
- Dedupe via a session-scoped `Set` keyed by node id (the plan's explicitly-allowed alternative to a `readAll()` scan), which the byte-threshold compactor still bounds for size.

## Deviations from Plan
None - plan executed exactly as written. (Task 1's `loadSpine` was exported as a named function so the malformed/missing-file degrade could be unit-tested directly, satisfying the plan's acceptance criterion; this is the natural realization of the plan's instruction, not a scope change.)

## Issues Encountered
Initial edits were mistakenly applied to the main checkout (`/Users/ouen/slop/sei-studio/sei`) instead of the dedicated phase worktree. Detected when the worktree test run still showed 13 (not 20) tests; the stray main-checkout edit was reverted with `git checkout -- <file>` and all work was redone against the worktree. The worktree versions of snapshot.js/orchestrator.js differ from the main checkout's uncommitted WIP, so all edit points were re-read from the worktree before applying.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 05 can reference the `nextMilestone` return shape and the `next:` line format for its disposition framing.
- The threat register items T-17-11 (parse-failure DoS) and T-17-13 (unbounded memory growth) are mitigated as planned (degrade-to-empty + dedupe/compaction).

---
*Phase: 17-minecraft-competence*
*Completed: 2026-06-26*
