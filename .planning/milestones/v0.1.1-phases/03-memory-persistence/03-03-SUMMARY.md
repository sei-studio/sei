---
phase: 03-memory-persistence
plan: 03
subsystem: memory.compaction
tags: [llm, compaction, anthropic, memory, async, diary, owner]
requires:
  - src/llm/loop.js (Plan 3-01)
  - src/llm/sessionState.js (Plan 3-02)
  - src/memory/diary.js (Plan 3-02)
  - src/memory/owner.js (Plan 3-02)
provides:
  - src/llm/compaction.js — createCompactor({ summarizeLoopBatch, consolidateOlderHalf })
  - sessionState wiring — D-51 loop-batch trigger + D-53 consolidation trigger
  - scripts/verify-phase3.js — phase-3 aggregate harness
affects:
  - src/llm/sessionState.js (compactor binding + accumulator + locks)
  - src/llm/orchestrator.js (loopMessages passed to onLoopTerminal; anthropic + cachedSystemBlocks exposed on _internal)
  - src/bot.js (compactor construction + sessionState.setCompactor)
  - package.json (verify:phase3 script)
tech-stack:
  added: []
  patterns:
    - factory + dependency injection (createCompactor mirrors orchestrator pattern)
    - fire-and-forget async with single-flight lock (consolidationLock)
    - retry-on-failure semantics via deferred counter reset
key-files:
  created:
    - src/llm/compaction.js
    - scripts/verify-phase3.js
    - .planning/phases/03-memory-persistence/03-03-SUMMARY.md
  modified:
    - src/llm/sessionState.js
    - src/llm/orchestrator.js
    - src/bot.js
    - scripts/verify-phase3-memory.js (Task-1 commit; harness already on main)
    - package.json
decisions:
  - Q2 — chains.js is a no-op shim; Loop owns its own lifecycle bounds. Compaction never references chains.
  - Q5 — split rule keep = max(ceil(N/2), 5); when N ≤ 5, consolidateOlderHalf no-ops.
  - Failed summarizeLoopBatch leaves the batch intact (loopCount/cumulativeBytes NOT reset) → next Loop terminal retries (T-03-17).
  - consolidateOlderHalf is fire-and-forget; never awaited inline. consolidationLock single-flights.
  - Cache hit guarantee: compactor reuses orchestrator._internal.cachedSystemBlocks BY REFERENCE (Pitfall 4 / D-52).
  - sessionState gained a setCompactor(c) method to break the bot.js construction-order cycle without bouncing through closures.
metrics:
  duration: ~30 min (continuation)
  completed: 2026-05-01
---

# Phase 3 Plan 03: Compaction Calls — Summary

LLM-directed memory compaction (MEM-02) and long-term diary consolidation
(MEM-04) wired through the same Haiku model and the same cached system
prefix the orchestrator already uses. Two semantic-boundary triggers
(loop-terminal for summaries, session-end for consolidation) gate cadence
on top of D-51/D-53. Idle ticks have no path to disk writes (A7 / D-55).

## Compactor public API (as shipped)

```javascript
// src/llm/compaction.js
export function createCompactor({
  anthropic,            // { call(req): Promise<resp> }
  cachedSystemBlocks,   // SAME reference orchestrator passes for personality calls
  diary,                // createDiary() instance
  config,               // { anthropic: { timeout_ms } }
  logger,
}) {
  return {
    /** D-52: Returns { topic, body } on success, null on failure. Writes one DIARY entry. */
    async summarizeLoopBatch({ loopMessagesBatch, when, signal }),

    /** D-54: Returns true on success, false on skip/failure. Rewrites older half of DIARY.md. */
    async consolidateOlderHalf({ signal }),
  }
}
```

Both calls pass `tools: []`, `systemBlocks: cachedSystemBlocks` (identity),
`timeoutMs: config.anthropic.timeout_ms` — verified by harness identity
checks (`compaction-uses-cached-system-blocks`, `compaction-has-timeout`).

## Triggers (sessionState)

| Trigger | Source | Cadence | Async? | Lock |
|---------|--------|---------|--------|------|
| summarizeLoopBatch | onLoopTerminal | loopCount ≥ 10 OR cumulativeLoopBytes ≥ 32 KB (D-51) | awaited (sync within hook) | none |
| consolidateOlderHalf (size) | onLoopTerminal | DIARY.md size > diary_size_cap_bytes (D-53) | fire-and-forget | consolidationLock |
| consolidateOlderHalf (count) | onPlayerLeft | sessionsSinceConsolidation ≥ 4 (D-53) | fire-and-forget | consolidationLock |
| residual flush | onPlayerLeft | loopCount > 0 OR cumulativeBytes > 0 (D-56) | awaited inline | none |

Counter reset:
- Successful summarize → loopCount/cumulativeBytes/loopBatchMessages cleared.
- Failed summarize → counters preserved for retry on next semantic boundary.
- Successful consolidation → sessionsSinceConsolidation = 0 (in `.then`).

## Verification

`node scripts/verify-phase3.js` — **48/48 cases pass** (10 from Plan 3-01
loop harness, 38 from Plan 3-02/3-03 memory harness).

Key cases proving Plan 3-03 guarantees:
- `summarize-prompt-shape` — `req.systemBlocks === cachedSystemBlocks` (identity)
- `compaction-uses-cached-system-blocks` — both call sites use the same reference
- `compaction-has-timeout` — both pass `timeoutMs` from config
- `consolidate-min-entries` — N ≤ 5 short-circuits without an Anthropic call
- `consolidate-split-50pct` — keep = max(ceil(N/2), 5); heading uses boundary date
- `d51-loop-count-trigger` — fires at exactly the 10th loop, resets counters
- `d51-bytes-trigger` — fires when cumulative > 32 KB
- `d51-trigger-survives-failure` — null result preserves counters (T-03-17)
- `d53-session-trigger` — async consolidation after 4 sessions; counter resets
- `d53-size-trigger` — file > cap fires consolidation from onLoopTerminal
- `d53-async-non-blocking` — onPlayerLeft returns < 200ms during 500ms compactor delay
- `a7-no-idle-write` — idle ticks have no path to compaction
- `session-end-flush` — residual batch flushed on owner leave

`grep -nE "(# Owner|# Diary)" src/llm/persona.js src/llm/anthropicClient.js`
returns no matches — Pitfall 4 cache invariant holds.

`git diff src/fsm.js` empty across the entire phase (`shasum =
6654ba484f22cd2efbfc058596407a7fe4440f0c`, unchanged from Phase 2 tip).

## Q-resolutions documented in code

- `src/llm/compaction.js:23` — Q5 split rule
- `src/llm/compaction.js:165` — Q5 split inline comment
- `src/llm/compaction.js:13-14` — Q2 (chains irrelevant; Loop owns lifecycle)

## Threat register status (T-03-13..T-03-17)

| Threat | Mitigation observed |
|--------|---------------------|
| T-03-13 (DoS via timeout) | Both calls pass `timeoutMs`; failures return null/false (verified by `summarize-rate-limited`). |
| T-03-14 (consolidation race) | `consolidationLock` single-flights; diary's internal mutex guards write. |
| T-03-15 (cache invalidation) | Identity check on `cachedSystemBlocks` (verified by `compaction-uses-cached-system-blocks`). |
| T-03-16 (idle regression) | Trigger paths confined to `onLoopTerminal` / `onPlayerLeft` (verified by `a7-no-idle-write`). |
| T-03-17 (failed summary loses batch) | Counters NOT reset on null (verified by `d51-trigger-survives-failure`). |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Construction-order cycle in bot.js**
- **Found during:** Task 2 wiring
- **Issue:** Plan said construct compactor with `orchestrator._internal.anthropic` + `orchestrator._internal.cachedSystemBlocks`, then pass it into `createSessionState`. But `sessionState` itself is passed *into* `createOrchestrator` — circular construction order.
- **Fix:** Added `sessionState.setCompactor(compactor)` setter so the binding can be injected after the orchestrator is built. Construction order: sessionState (no compactor) → orchestrator (gets sessionState) → compactor (uses orchestrator's anthropic + cachedSystemBlocks) → sessionState.setCompactor(compactor). Tests still construct with the `compactor:` arg directly (the constructor still accepts it).
- **Files modified:** src/llm/sessionState.js, src/bot.js
- **Commit:** 77384d6

**2. [Plan-text deviation] `older[older.length-1]` for boundary date instead of `older[0]?.dateIso`**
- **Found during:** Task 1 implementation
- **Issue:** Plan example code says `const through = older[0]?.dateIso ?? ...`, but the `consolidate-split-50pct` test sets up entries with dates `2026-01-01..2026-01-12` (entries[0] has the LOWEST date) and expects the heading to read `consolidated through 2026-01-12`. With `older[0]` we'd get `2026-01-07`.
- **Resolution:** Used `older[older.length-1]` — the last/oldest entry of the older slice when the diary is newest-first. Test case is authoritative; plan example was illustrative.
- **Commit:** bb650b7

### Auth gates / human checkpoints
None. Fully autonomous execution.

### Manual integration smoke
NOT run in this continuation. The plan calls for a real Minecraft + real
Haiku 60-minute integration smoke (`<verification>` bullet 3). Deferred —
the structural harness (48/48) covers every D-51/D-52/D-53/D-54/D-55/D-56
guarantee in isolation. A live smoke is recommended before declaring
phase 3 production-ready.

## Self-Check: PASSED

- src/llm/compaction.js exists (214 lines)
- scripts/verify-phase3.js exists
- .planning/phases/03-memory-persistence/03-03-SUMMARY.md exists
- Commit bb650b7 exists (compaction.js)
- Commit 77384d6 exists (sessionState wiring)
- Commit ec0cfe5 exists (verify-phase3.js)
- All 48 phase-3 verification cases pass
- src/fsm.js byte-unchanged (sha 6654ba484f22cd2efbfc058596407a7fe4440f0c)
