---
phase: 260514-ngj
status: complete
date: 2026-05-14
commits:
  - fa8ac5d feat(260514-ngj): retire stop tool, add end_loop, no-pre-abort owner chat, spawn-uses-idle
  - 752fd3c feat(260514-ngj): R1-R4 dispatcher with per-iteration trigger tracking and R4 reseed
  - 65be3a7 test(260514-ngj): extend verify-260514-gam.mjs with R1-R4 + spawn-idle assertions
verify:
  - "scripts/verify-260514-gam.mjs — 14/14 PASS (G1..G8 + R1..R4 + R-spawn-idle)"
  - "scripts/verify-260513-wkd.mjs — 13/13 PASS (no regression on prior cancel-semantics harness)"
---

# 260514-ngj — P1/P0 interrupt response semantics

## What changed

Replaced the broken 260513-wkd case-1/2/3 implementation (which silently swapped case-1 from "keep going" to "loop terminal" and re-enqueued triggers with `null` data, causing message-spam loops) with the originally-locked R1/R2/R3/R4 design plus an explicit `end_loop` verb.

### Behavior contract (locked)

On a **P0/P1-triggered iteration** (owner chat or attack — i.e. PLAYER INTERRUPT context):

| Response | Tools emitted | In-flight | Loop |
|---|---|---|---|
| **R1** continue (default) | text only | stays alive | stays alive |
| **R2** change action | text + new action | abort old; new becomes in-flight | stays alive |
| **R3** stop loop | text + `end_loop` | aborted | terminal |
| **R4** stop + reseed | text + `end_loop` + new action | aborted | terminal, new loop seeded with original `_triggerData` and the new action |

On **P2/P3-triggered iterations** (action_complete, idle, loop_end): unchanged — text-only terminates naturally; `end_loop` is allowed but not required.

## Files touched

- `src/bot/brain/orchestrator.js` — new `end_loop` inline-metadata tool; `loop._triggerData` populated at creation; `loop._currentIterationTrigger` set per-iteration; R1 keep-alive branch in `runIterations` and `handleActionComplete`; R2/R3/R4 dispatch in case-3 replacement; persona addendum injected only on P0/P1 iterations; `sei:joined` dropped from `triggerIsP0P1`. `stop` retired.
- `src/bot/brain/index.js` — first spawn enqueues `sei:idle` (P3) instead of `sei:joined` (P1).
- `src/bot/adapter/minecraft/behaviors/chat.js` — non-stop-verb owner chat no longer calls `forceCancelBody(bot)` or `abortController.abort()`. Stop-verb fast path unchanged.
- `scripts/verify-260514-gam.mjs` — extended with R1, R2, R3, R4, and R-spawn-idle assertions using the existing `_anthropicOverride` seam.

## Pitfalls handled

- Both first-iteration (`runIterations`) and continuation (`handleActionComplete`) paths apply the new termination rule.
- `currentLoop` is NOT torn down on R1 (text-only on a P0/P1 iteration) — teardown only fires when `loop.isTerminal`.
- `loop._triggerData` is now populated at line 806 so the R4 reseed carries the original chat data; the empty-data spam loop that started this whole task is impossible.

## Out of scope

- The parallel-`placeBlock` batched-storm issue surfaced in the analysis is a separate concern and not part of this task.
- Iteration cap tuning, memory/diary changes.

## Verification

```
$ node scripts/verify-260514-gam.mjs
14/14 PASS — G1..G8 + R1..R4 + R-spawn-idle

$ node scripts/verify-260513-wkd.mjs
13/13 PASS — no regression on prior cancel-semantics harness
```

Live-server verification (cactus interrupt scenario from the original bug log) was not exercised in this task — recommend a smoke test before merging if there's any doubt.
