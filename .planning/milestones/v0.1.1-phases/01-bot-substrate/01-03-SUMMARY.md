---
phase: 01-bot-substrate
plan: "03"
subsystem: fsm
tags: [fsm, priority-queue, abortcontroller, behaviors, bot]
dependency_graph:
  requires: [01-01-PLAN.md, 01-02-PLAN.md]
  provides: [src/fsm.js, updated src/bot.js]
  affects: [src/bot.js]
tech_stack:
  added: []
  patterns: [event-sourced FSM, priority queue, AbortController cancellation, setImmediate processing loop]
key_files:
  created:
    - src/fsm.js
  modified:
    - src/bot.js
decisions:
  - FSM processes events via setImmediate to prevent synchronous stack overflow from event storms (T-03-01)
  - sei:dispatch emitted before switch/case so Phase 2 LLM orchestrator can intercept any event
  - Idle timer resets on every enqueue so it only fires after true 10s inactivity
metrics:
  duration: "~10 minutes"
  completed: "2026-04-24"
  tasks_completed: 2
  files_created: 1
  files_modified: 1
requirements:
  - BOT-01
  - BOT-02
  - BOT-03
  - BOT-04
  - BOT-05
  - BOT-06
  - CONN-01
  - CONN-02
  - CONN-03
  - CONN-04
---

# Phase 1 Plan 03: FSM and Behavior Wiring Summary

**One-liner:** Event-sourced FSM with P0-P3 priority queue, AbortController preemption, and all five behaviors wired into bot.js spawn handler.

## What Was Built

### Task 1 — src/fsm.js

Created the single event orchestrator for the bot:

- `Priority` constants: `P0_SAFETY=0`, `P1_CHAT=1`, `P2_MOVEMENT=2`, `P3_IDLE=3`
- `createFSM(bot, config, registry)` attaches to a mineflayer bot instance
- Priority queue: events sorted ascending by priority number; lower = higher urgency
- `setImmediate`-based processing loop prevents synchronous recursion / stack overflow
- AbortController cancellation: higher-priority event aborts current action's controller before starting
- Lower-priority events re-queued while higher-priority action is running
- `sei:dispatch` emitted before each event handler — Phase 2 LLM orchestrator hooks in here
- 10s idle fallback timer (`resetIdleTimer` called on every enqueue)
- Phase 1 scripted handlers: P0 logs attack, P1 echoes chat, P3 logs idle tick

### Task 2 — src/bot.js

Updated to import and start all behaviors and FSM on spawn:

- Added imports: `pathfinder`, `startFollow/stopFollow`, `startChat`, `startAutoEat`, `startCombat`, `createDefaultRegistry`, `createFSM`
- Spawn handler: loads pathfinder plugin, starts all five behaviors, creates FSM with default registry
- End handler: calls `stopFollow()` before reconnect logic
- All existing logic (humanizeReason, reconnect loop, start/stop/getBot) preserved

## Verification

```
node --input-type=module --eval "import './src/index.js'"
# → [sei] Starting Sei — connecting to 127.0.0.1:25565
# → Error: connect ECONNREFUSED (expected — no server running; no import errors)

node -e "import('./src/fsm.js').then(m => console.log('FSM exports:', typeof m.createFSM, typeof m.Priority))"
# → FSM exports: function object
```

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/fsm.js: EXISTS, exports createFSM and Priority
- src/bot.js: EXISTS, contains all required imports and spawn/end wiring
- Commits: cd9467f (fsm.js), f4140c9 (bot.js)
