---
phase: 01-bot-substrate
plan: "02"
subsystem: behaviors
tags: [mineflayer, pathfinder, registry, zod, behaviors, follow, chat, combat, auto-eat]
dependency_graph:
  requires: [01-01]
  provides: [action-registry, pathfind-wrapper, reflex-behaviors]
  affects: [01-03]
tech_stack:
  added: []
  patterns: [Closed Zod action registry, Promise.race timeout, poll-based follow interval, mineflayer event hooks]
key_files:
  created:
    - src/behaviors/pathfind.js
    - src/registry.js
    - src/behaviors/follow.js
    - src/behaviors/chat.js
    - src/behaviors/autoEat.js
    - src/behaviors/combat.js
  modified: []
decisions:
  - "mineflayer-pathfinder goals accessed via default/module.exports interop — named export 'goals' not available in ESM"
  - "mineflayer-auto-eat exposes plugin as 'loader' named export, not default"
  - "chat.js uses bot.username (not config.username) for addressed-check to match actual bot name"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-24T22:02:09Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 6
  files_modified: 0
---

# Phase 1 Plan 02: Reflex Behaviors and Action Registry Summary

Closed Zod-typed action registry with goTo registration, wall-clock pathfinder timeout via Promise.race, and all five scripted reflex behaviors (follow, chat, auto-eat, combat) wired to mineflayer events.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Pathfinder wrapper and action registry | f9fa1ba | src/behaviors/pathfind.js, src/registry.js |
| 2 | Reflex behaviors — follow, chat, auto-eat, combat | cb648c3 | src/behaviors/follow.js, src/behaviors/chat.js, src/behaviors/autoEat.js, src/behaviors/combat.js |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] mineflayer-pathfinder ESM interop — goals not a named export**
- **Found during:** Task 1 verification
- **Issue:** `import { Movements, goals } from 'mineflayer-pathfinder'` threw SyntaxError — `goals` is only on the default/module.exports object
- **Fix:** Changed to `import pkg from 'mineflayer-pathfinder'; const { Movements, goals } = pkg`
- **Files modified:** src/behaviors/pathfind.js
- **Commit:** f9fa1ba (fixed before commit)

**2. [Rule 1 - Bug] mineflayer-auto-eat exposes plugin as 'loader', not default export**
- **Found during:** Task 2 verification
- **Issue:** `import autoEat from 'mineflayer-auto-eat'` threw — no default export; plugin is named 'loader'
- **Fix:** Changed to `import { loader as autoEat } from 'mineflayer-auto-eat'`
- **Files modified:** src/behaviors/autoEat.js
- **Commit:** cb648c3 (fixed before commit)

## Known Stubs

None — all behaviors wire to real mineflayer events. Phase 1 chat response is intentionally event-only (`sei:chat_received`); Phase 2 LLM handler will consume that event.

## Threat Surface Scan

No new security surface beyond the plan's threat model.
- T-02-02 (follow DoS): goTo() wall-clock timeout implemented in pathfind.js
- T-02-03 (registry tampering): Zod schema.parse() rejects malformed args; unknown names throw immediately

## Self-Check: PASSED

- src/behaviors/pathfind.js: FOUND
- src/registry.js: FOUND
- src/behaviors/follow.js: FOUND
- src/behaviors/chat.js: FOUND
- src/behaviors/autoEat.js: FOUND
- src/behaviors/combat.js: FOUND
- Commit f9fa1ba: FOUND
- Commit cb648c3: FOUND
