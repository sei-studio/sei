# Quick Task 260514-gam: Universalize inflight + resolve P1/P0-mid-sync race - Context

**Gathered:** 2026-05-14
**Status:** Ready for planning

<domain>
## Task Boundary

Replace the LONGRUNNER-only async inflight architecture with a universal non-blocking inflight path so synchronous tools (placeBlock, equip, find, lookAt, dropItem, activateItem, sleep, openContainer, depositItem, withdrawItem, consumeItem, follow, unfollow) also suspend the loop, register `loop.inFlight`, fire `sei:action_complete` on settle, and are preemptible by P1/P0 owner-chat — eliminating the 20s blocking cascade observed when the model emits a 5-placeBlock batch.

**In scope:** orchestrator.js dispatch path (`runWithInflightAwait`, `startLongRunner`, `LONG_RUNNERS` set, the per-tool for-loop at ~line 1320, the case-2/case-3 cancel dispatch table, the batched-results pairing logic), inflight.js if its API needs to grow, signal-threading for synchronous registry handlers that don't honor AbortSignal today.

**Out of scope:** owner-position-in-snapshot fix (deferred to a separate quick task), recent_events position delta, placeBlock failure-reason classification, fixing mineflayer's internal placeBlock timeout, any work on the FSM priority numerics (P0/P1/P2.1/P2.5 stay as-is), changes to the LLM tool registry / Zod schemas.

</domain>

<decisions>
## Implementation Decisions

### Decision 1 — Universalization scope (Gray area 1)
**LOCKED: Option B — Every world-touching tool goes non-blocking; pure-state tools stay inline.**

- **Non-blocking (go through `startLongRunner` path):** `placeBlock`, `dig`, `gather`, `goTo`, `build`, `attackEntity`, `equip`, `dropItem`, `activateItem`, `sleep`, `openContainer`, `depositItem`, `withdrawItem`, `consumeItem`, `find`, `lookAt`, `follow`, `unfollow`.
- **Inline (stay synchronous, no suspend/resume):** `setGoals`, `noteToSelf`, `stop`. These are pure-metadata tools that complete in microseconds and gain nothing from suspend/resume. Routing them through `action_complete` would inflate loop count and add a haiku continuation per call for no benefit.

Rationale: targets every tool whose execution is observable or could take ≥100ms; metadata tools don't benefit from interruptibility.

### Decision 2 — P1/P0-mid-sync race resolution (Gray area 2)
**LOCKED: Option A — Use the existing `pendingInterrupt`-fold path; no new dedup machinery.**

When chat arrives during a now-non-blocking sync action:
- First-arrival sets state (chat-interrupt branch sets `pendingInterrupt` + aborts; OR action_complete settle clears `loop.inFlight`).
- Second-arrival path (handleActionComplete at orchestrator.js:1076–1081) sees `pendingInterrupt` and folds a `PLAYER INTERRUPT` user turn with `prior_task` hint into the same loop. Exactly one continuation iteration runs.
- Both orderings (chat-first vs settle-first) flow through the same fold join point. No new "dedup token" or "natural-completion wins" branch.

Edge corner explicitly accepted: if a 1s sync action settles at T=0.99s and chat arrives at T=1.00s, `loop.inFlight` is already null by the time chat enters the chat-interrupt branch — the branch's `if (currentLoop.inFlight)` guard skips the in_flight abort (correct), still sets `pendingInterrupt`, still aborts `loop.abortController`. The next iteration (driven by `handleActionComplete`'s continuation) picks up `pendingInterrupt` and emits the PLAYER INTERRUPT turn. Verified against current code; no new code needed for this path.

### Decision 3 — Batched tool_uses handling (Gray area 3)
**LOCKED: Option A — Serialize within the same loop via action_complete; no extra haiku call between batched tools.**

When the model emits N tool_uses in one turn:
- Tool[0] dispatches via `startLongRunner`, loop suspends, `loop._pendingResults` array sized N with tool[0]'s slot unfilled.
- On `sei:action_complete` for tool[0]: handleActionComplete fills tool[0]'s result slot, checks remaining unfilled slots in `loop._pendingResults`. If tool[1] exists, dispatch tool[1] from the SAME iteration step (no new haiku call). Repeat.
- Once all N results are filled, append the completed results turn to history and call haiku for the next iteration.
- Each individual tool dispatch is preemptible by P1/P0 — chat arriving mid-batch aborts the current tool, folds PLAYER INTERRUPT, abandons remaining batch slots (synthesize `aborted: player interrupt` for unfilled slots, same as the existing synthesis at orchestrator.js:1560–1568).

Rationale: preserves the model's batched intent semantically (no behavioral cap change), keeps haiku-call count equal to today's (one haiku per "logical turn", not per tool), and exposes preempt points between every tool — fixes the 20s blocking cascade.

### Decision 4 — Owner-position-in-snapshot
**LOCKED: Deferred to a separate quick task. Do NOT include in this task's plan.**

### Claude's Discretion
- The exact API shape on `inflight.js` (e.g., whether `loop.inFlight` becomes `loop.inFlight: { name, tool_use_id, abortController, promise, … }` or a richer queue type) is implementer's choice as long as the snapshot helper `getInFlightLineForSnapshot` still renders the active tool's line.
- Whether `dig({x,y,z})` single-block (no `to`) routes through the non-blocking path: yes (per Decision 1, dig is world-touching). The `_buildExecOpts` progress-flavored detection stays as-is.
- Whether to keep `runWithInflightAwait` as a back-compat alias or delete it: prefer delete if no remaining callers; the synchronous inline branch for setGoals/noteToSelf/stop can call `inflight.start/end` directly.
- Whether to add new debug-log lines for "sync-tool dispatched as non-blocking" — yes, mirror the existing long-runner debug breadcrumbs.

</decisions>

<specifics>
## Specific Ideas

**The bug to fix (concrete evidence):** in the 18:18–18:20 cactus-placement log, a 5-`placeBlock` tool batch ran sequentially for 20 seconds (4s mineflayer timeout × 5). Owner chat "how many do u have left?" arrived at 18:19:13.013 but PLAYER INTERRUPT did not fold until 18:19:29 — a 16-second responsiveness gap. Second chat "come try here" at 18:19:47.685 buffered until 18:20:15 (28-second gap). The synchronous-tool branch at `orchestrator.js:1517–1536` calls `runWithInflightAwait` which only checks `signal.aborted` *between* iterations of the for-loop at line 1349; mineflayer's `placeBlock` internal 4s timeout is not signal-aware.

**Key code sites the planner should touch:**
- `src/bot/brain/orchestrator.js:542` — `LONG_RUNNERS = new Set([…])` set. After this task, the *concept* of LONG_RUNNERS likely goes away or expands to mean "world-touching tools". Pure-state tools become a separate small set (e.g., `INLINE_METADATA = new Set(['setGoals', 'noteToSelf', 'stop'])`).
- `src/bot/brain/orchestrator.js:570–608` — `runWithInflightAwait` and `startLongRunner`. The synchronous branch needs to either be removed or kept only for the 3 inline metadata tools.
- `src/bot/brain/orchestrator.js:1320–1538` — the per-tool dispatch for-loop. The non-long-runner branch at 1517–1536 (the `runWithInflightAwait` call site) is the main rewrite.
- `src/bot/brain/orchestrator.js:1456–1505` — the `startLongRunner` dispatch site. Its pattern (dispatch, register `loop.inFlight`, store `_pendingActionUse`/`_pendingResults`, attach `.then` settle handler that re-enqueues `sei:action_complete`) is the template for sync tools too.
- `src/bot/brain/orchestrator.js:1028–1131` — `handleActionComplete`. Today it processes one result and runs one more iteration. After Decision 3, it must check `_pendingResults` for remaining unfilled slots and dispatch the NEXT tool in the batch (if any) from the same iteration step, only calling `callPersonality` once all slots are filled.

**Existing patterns to preserve:**
- The `case-2 stop` and `case-3 reseed` branches at orchestrator.js:1253–1300 already abort `loop.inFlight.abortController`. With sync tools now also setting `loop.inFlight`, these branches Just Work — verify they don't need changes.
- The `pendingInterrupt`-fold join at orchestrator.js:1076–1081 — Decision 2 explicitly relies on this. Verify it still fires correctly when the in-flight tool is a sync one whose abort took effect in <50ms.
- The `_pendingResults`/`_pendingActionUse` machinery and the `tool_use_id` matching at orchestrator.js:712–716 — already designed for the suspend/resume contract; should accommodate sync tools without change.

**Verification scenarios (live, in-game) the planner should require in PLAN.md:**
1. **5-placeBlock batch + mid-batch chat preempt.** Issue a batch that times out at least 2 times; send "stop" mid-batch; chat preempt must land in <500ms (one mineflayer-timeout signal-tick at worst).
2. **5-placeBlock batch, natural completion of all 5.** No chat. Verify the batch completes correctly and exactly one haiku call follows the batch (not 5).
3. **Single sync action + chat arriving in the <500ms window between dispatch and settle.** Verify exactly one PLAYER INTERRUPT iteration runs.
4. **Single sync action + no chat, completes normally.** Verify behavior unchanged from today (snapshot in_flight shown for duration, then cleared).
5. **case-2 stop tool fired while a sync tool is in flight.** Verify the in_flight abort propagates and the loop terminates.
6. **case-3 reseed (new long-runner emitted while sync tool is in flight).** Verify the in_flight aborts, loop terminates, and the new long-runner opens a fresh loop with the correct trigger event.

**Non-goals (planner should NOT include):**
- Changing the LLM-facing tool descriptions or schemas.
- Adding new tools or removing existing ones.
- Tweaking the FSM priority constants.
- Touching the snapshot composer beyond what `inflight.js` already provides (no owner-position fix here).

</specifics>

<canonical_refs>
## Canonical References

- `.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-CONTEXT.md` — the prior rework that introduced the non-blocking model for long-runners. This task generalizes that pattern.
- `.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-SUMMARY.md` — the live verification scenarios from the prior task; the new scenarios in this task are analogous but for sync tools.
- `scripts/verify-260513-wkd.mjs` — the existing harness. The planner should consider whether new test cases extend this file or create a new harness.

</canonical_refs>
