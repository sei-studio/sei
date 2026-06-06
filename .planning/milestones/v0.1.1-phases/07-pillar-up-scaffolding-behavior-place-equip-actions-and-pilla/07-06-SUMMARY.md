---
phase: 07-pillar-up-scaffolding-behavior-place-equip-actions-and-pilla
plan: 06
subsystem: brain/observers
tags: [progress-tick, inflight, snapshot, d-10]
requires: [07-02, 07-03, 07-05]
provides:
  - "inflight.updateProgress(handle, p) — push progress ticks onto current entry"
  - "runWithInflight onProgress injection for cuboid actions (build, dig+to)"
  - "snapshot in_flight: line enriched with `<completed>/<total>[, y=<currentY>]`"
affects: [src/bot/brain/inflight.js, src/bot/brain/orchestrator.js, src/bot/adapter/minecraft/observers/snapshot.js]
key-files:
  modified:
    - src/bot/brain/inflight.js
    - src/bot/brain/orchestrator.js
    - src/bot/adapter/minecraft/observers/snapshot.js
decisions:
  - "D-10 delivered via Option A (snapshot enrichment). Mid-action LLM-driven abort (RESEARCH Pitfall 6 Option B) deferred per CONTEXT Deferred Ideas."
  - "isCuboid predicate gates onProgress injection — `name==='build' || (name==='dig' && args.to)`. Single-cell dig unaffected."
  - "Stale-handle guard inside updateProgress prevents late ticks from a previous action overwriting the current entry."
metrics:
  duration: ~5min
  tasks: 2
  files-modified: 3
completed: 2026-05-12
---

# Phase 07 Plan 06: Progress-Tick Snapshot Enrichment Summary

Cuboid build/dig actions now emit `onProgress` ticks that the orchestrator stores on the inflight handle, and the snapshot's `in_flight:` line renders the latest tick — D-10 Option A delivered with no mid-action LLM iteration and no new abort tool.

## What Changed

1. **`inflight.js`** — handles carry a `progress` slot (init `null`); new `updateProgress(handle, p)` setter with stale-handle guard; exposed on the returned tracker.
2. **`orchestrator.js` `runWithInflight`** — for `build` and cuboid `dig` (i.e. `dig` with `args.to`), spread an `onProgress: (p) => inflight.updateProgress(handle, p)` into the exec opts. Non-cuboid actions get the original opts unchanged.
3. **`snapshot.js`** — `in_flight:` rendering computes `progressSuffix` from `inFlight.progress` (` — <placed|dug>/<total>[, y=<currentY>]`), appended only when both `completed` and `total` are numeric.

## Verification

Both inline verify scripts from the plan print `OK`:
- Task 1 inflight: 5/5 assertions pass (init null, set, stale-no-op, currentBlocking carry, cleared on end).
- Task 2 snapshot: `47/256` and `y=66` present when progress set; no `— N/N` suffix when `progress: null`.

Grep checks:
- `onProgress`, `isCuboid`, `updateProgress` in orchestrator.js → 3 matches total ✓
- `progressSuffix`, `inFlight.progress` in snapshot.js → 3 matches total ✓
- `progress: null`, `updateProgress` in inflight.js → 3 matches total ✓

## Deviations from Plan

None — plan executed exactly as written.

## Deferred (per planner brief + CONTEXT Deferred Ideas)

- **Mid-action LLM tick framework** (RESEARCH Pitfall 6 Option B). No new LLM iteration is scheduled mid-action; no new abort tool is introduced. Existing FSM `AbortController` path remains the sole preempt surface. Snapshot enrichment means that after the action completes (or after an FSM preempt), the next LLM iteration sees the latest progress.

## Commits

- `df576af` feat(07-06): add updateProgress to inflight tracker
- `d7f8b64` feat(07-06): wire cuboid onProgress to snapshot in_flight line

## Self-Check: PASSED

- src/bot/brain/inflight.js — FOUND ✓
- src/bot/brain/orchestrator.js — FOUND ✓
- src/bot/adapter/minecraft/observers/snapshot.js — FOUND ✓
- commit df576af — FOUND ✓
- commit d7f8b64 — FOUND ✓
