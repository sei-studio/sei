---
phase: 260503-1bu
plan: 01
subsystem: orchestrator+observers
tags: [snapshot, deltas, interrupt, resume, orchestrator, prior_task]
requires: [b0c52f3]
provides:
  - "snapshot.recent_events line summarising kills, inventory deltas, and hp loss since the prior snapshot"
  - "prior_task: hint injected into the synthesized PLAYER INTERRUPT user turn so the model has a single-line cue to resume the aborted task"
affects:
  - src/observers/snapshot.js
  - src/llm/orchestrator.js
tech-stack:
  added: []
  patterns:
    - "Per-orchestrator stateful composer factory wraps the existing stateless composeSnapshot to preserve back-compat for any direct callers"
    - "Helper extractPriorTask walks loop._internal.messages backwards skipping personality-only tools (say/setGoals) — same shape as snapshot's describeInflightArgs but inlined to avoid cross-module coupling"
key-files:
  created: []
  modified:
    - src/observers/snapshot.js
    - src/llm/orchestrator.js
decisions:
  - "Kill detection is a heuristic (mob disappearance from 24-block radius); no entityDead subscription added — out of scope for this quick task"
  - "HP regen intentionally not surfaced — too noisy"
  - "recent_events line omitted entirely when no deltas exist, to keep idle snapshots tight"
  - "prior_task hint includes a one-sentence guidance phrase to push the model toward an explicit resume/drop decision rather than asking 'what next?'"
metrics:
  duration_minutes: 6
  tasks_completed: 2
  tasks_deferred: 1
  files_modified: 2
  completed_date: "2026-05-03"
---

# Quick Task 260503-1bu: Snapshot Delta Indicators + Prior-Task Resume Hint Summary

Two surgical changes addressing a live-session observation: the bot didn't notice between-snapshot events (kills, inventory pickups, hp damage), and after handling a chat interrupt it dropped the prior task and asked "what next?" instead of resuming. Now every snapshot carries a `recent_events:` delta line, and every PLAYER INTERRUPT turn carries a `prior_task:` line with explicit resume/drop guidance.

## What Shipped

### 1. Stateful snapshot composer (`src/observers/snapshot.js`)

- New export `createSnapshotComposer({ bot })` — factory that wraps the existing stateless `composeSnapshot` and tracks per-instance previous inventory, hp, and in-range mob ids.
- `composer.next(opts)` composes the base snapshot, computes deltas, and inserts `recent_events: <events>` immediately after `last_action_result:` when any delta exists.
- Delta rules:
  - Inventory: `+N item` for gains/increases, `-N item` for losses/removals, capped at 6 entries with `(+N more)` overflow.
  - Kills: mob ids that disappeared from a 24-block radius and are no longer present in `bot.entities` (or are `isValid === false`). Players (`username` truthy) excluded. Same-name disappearances grouped as `killed sheep ×2`.
  - HP loss: `hp -N`. Regen NOT emitted.
- State updates AFTER composing — first call therefore shows no deltas (correct; no "previous" yet).
- `composer.reset()` exposed but not yet wired to death/disconnect — sufficient for v1.
- `composeSnapshot` left exported with identical signature/behavior. No existing call site changes required beyond orchestrator's snapshotText helper.

**Commit:** `10e1c7a feat(260503-1bu): add stateful snapshot composer with recent_events deltas`

### 2. Orchestrator wiring + prior_task hint (`src/llm/orchestrator.js`)

- Imported `createSnapshotComposer`; instantiated once per `createOrchestrator(...)` next to the inflight tracker.
- `snapshotText()` now delegates to `snapshotComposer.next(...)` (same opts shape). `composeSnapshot` import retained because the composer calls it internally.
- Added `extractPriorTask(loop)` — walks `loop._internal.messages` backwards looking for the most recent assistant `tool_use` block, skipping `say` and `setGoals`. Returns:
  - For `handOffToMovement`: `intent="<first 120 chars>"`
  - For combined-mode movement actions (e.g. `attackEntity`, `goTo`, `dig`, `follow`): `<name> <key arg> [times=N]`
  - `null` if nothing resumable found.
- Added a `withPriorTaskHint(loop, eventText)` helper that appends `\nprior_task: <…>\n(If the new request is a sub-task or quick favor, resume prior_task after handling it. If it replaces the goal, drop prior_task.)` when extraction succeeds, otherwise returns `eventText` unchanged.
- Both interrupt-repair paths now route through the helper:
  - The mid-tool-dispatch catch arm in `runIterations` (constructs `interruptEventText` then passes through `withPriorTaskHint`).
  - `repairAfterAbort` (uses `eventTextWithHint` in both the `appendToolResults` and `appendUserTurn` branches).
- No FSM changes, no new dispatch events, no new mineflayer subscriptions, no new external calls — purely in-process. CLAUDE.md timeout rule trivially satisfied.

**Commit:** `1bbb67d feat(260503-1bu): wire stateful snapshot composer + prior_task interrupt hint`

## Resume Mechanic Note

The actual interrupt-and-resume capability — preserving the loop's `messages` array across the abort so prior tool_uses remain visible — was already shipped in `b0c52f3 fix(orch): interrupt repair, mid-task narration, owner+diary cache`. This plan only added **salience**: the model could already see the aborted tool_use in history, but it was buried among other content. The new `prior_task:` line gives it a one-token salient cue, plus a one-sentence guidance phrase to bias the decision toward an explicit resume/drop choice.

## "Killed = Disappearance" Heuristic — Limitation & Upgrade Path

The current implementation infers kills from mob disappearance from a 24-block radius. This will produce false positives:
- A sheep that wanders out of range during the snapshot tick will register as `killed sheep`.
- A mob that enters an unloaded chunk will register as killed.
- Conversely, kills that occur outside the 24-block radius (e.g. a creeper killed from afar by a skeleton) will not register.

This is acceptable for v1: the `recent_events:` line is observational commentary the LLM reads alongside the canonical state, not an authoritative event log. The prompt does not change to claim authority.

**Future upgrade path:** subscribe to `bot.on('entityDead')` to record confirmed kills into a small per-orchestrator ring buffer, and emit those alongside or instead of the disappearance heuristic. Out of scope for this quick task; tracked here for the next time the snapshot subsystem is touched.

## Edge Cases Handled

- First call to `composer.next()` after construction: `prevInventory/prevHp/prevEntityIds` are null, so no events are emitted (correct — no baseline yet).
- Player entities are excluded from `prevEntityIds` so they cannot ever appear in a `killed …` line.
- HP regen flips are silently swallowed (only `currHp < prevHp` emits).
- Empty event list ⇒ `recent_events:` line is omitted entirely (snapshot stays tight when nothing happened).
- `extractPriorTask` returns `null` for interrupts from idle (no in-flight task in history) — the original `eventText` is used unchanged, no degradation.
- `withPriorTaskHint` is a no-op when extraction returns null, so the catch-arm and `repairAfterAbort` paths remain crash-free for stateless-style interrupts.
- The composer never throws — `bot.entity` and `bot.entities` are guarded with optional-chaining and try/catch around `position.distanceTo`.

## Deviations from Plan

None — both code-modifying tasks executed as written. Task 3 (live in-game verification) is deferred to the user per the executor constraint that no Minecraft server is available in this environment.

## Self-Check: PASSED

- `src/observers/snapshot.js` exports `createSnapshotComposer` and `composeSnapshot`: verified via `node --input-type=module -e "import { … }"`.
- `src/llm/orchestrator.js` includes `createSnapshotComposer({ bot })`, `snapshotComposer.next(`, `function extractPriorTask`, and `prior_task:` literal: verified via the plan's automated grep check (all 4 OK).
- Module imports cleanly: `import('./src/llm/orchestrator.js')` resolves with `createOrchestrator` typeof === `function`.
- Commits exist:
  - `10e1c7a` (Task 1) — found.
  - `1bbb67d` (Task 2) — found.

## Deferred-to-User: Task 3 Live Verification Checklist

Run when next launching the bot in a real session.

**Setup:** `npm start` (or your usual launch path).

**Delta indicator test:**
1. Stand near a passive mob. Tell bot: `kill that sheep with times: 5` (or however your phrasing dispatches an attackEntity batch).
2. After the kill, inspect the next snapshot in the debug log. Expect `recent_events:` to contain `killed sheep` and inventory gain like `+1 wool` and/or `+1 mutton`.
3. Drop an item on the bot or `/give` it something. Next snapshot's `recent_events:` should show `+N <item>`.
4. Punch the bot once. Next snapshot's `recent_events:` should show `hp -N` (matches damage taken).

**Interrupt-resume test (the original bug):**
1. Tell bot: `kill these sheep` near a flock.
2. Mid-attack, say: `give me your sword first wait`.
3. Bot should: drop sword AND either (a) resume attacking sheep, or (b) `say` something referencing the prior task ("want me to keep killing the sheep?"). It should NOT just say "what next?" with no acknowledgment of the prior task.
4. In the debug log, confirm the user turn following the interrupt contains a `prior_task: attackEntity sheep …` (or `prior_task: intent="…"`) line plus the resume/drop guidance sentence.

**No-regression checks:**
- Snapshots without deltas (idle ticks where nothing happened, first tick after spawn) MUST NOT have a `recent_events:` line.
- Existing snapshot lines (`pos`, `biome`, `hp/food/xp`, `holding`, `in_flight`, `inventory`, `nearby blocks`, `nearby entities`, `owner_goals`, `self_goals`, `follow_target`, `last_action_result`) all rendered as before.
- OWNER.md / DIARY.md / `recent_chat` injection still work — no system-prefix changes were made.

**Resume signal:** Reply `approved` to the orchestrator if both tests pass, or describe what failed (which test, expected vs observed).
