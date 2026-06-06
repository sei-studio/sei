---
phase: 260513-wkd
plan: 01
type: execute
subsystem: orchestrator
tags: [orchestrator, fsm, cancel-semantics, abort-signal, snapshot]
status: complete
completed: 2026-05-14
commits:
  - 0744c6e refactor(260513-wkd): signal threading + stop tool + FSM constant + snapshot helper (no-op precursor)
  - 0bee0d0 feat(260513-wkd): non-blocking orchestrator loop + cancel-semantics dispatcher + verify harness
requirements_completed:
  - WKD-CANCEL-SEMANTICS
  - WKD-SIGNAL-THREADING
  - WKD-FSM-EVENT-LOOP
  - WKD-STOP-TOOL
  - WKD-SNAPSHOT-INFLIGHT
  - WKD-INTERRUPT-SPEAK
deviations: |
  - B5b assertion added beyond the plan's B1..B9 spec — verifies the P1
    preempt → in_flight.abort cascade end-to-end before stop tears down
    the loop. Provides a discrete pinpoint signal between B5 (stop
    direct) and B7a (P1 preempt + case-1 continuation). Total harness
    PASS count: 13 (12 plan-spec + B5b bonus).
  - Plan said "10 assertions" in done-list summary but enumerated 12
    distinct sub-cases (B1, B2, B2b, B3, B4, B5, B6-fire, B6-suppress,
    B7a, B7b, B8, B9). I implemented the 12 plan-spec assertions plus
    B5b for 13 total.
  - In the cancel-semantics dispatcher, case 3's "fire" branch
    synthesizes aborted tool_result content `aborted: <name> (case-3
    reseed)` for the long-runner tool_uses (instead of dispatching them)
    so the assistant turn pairing invariant holds when appendToolResults
    is called. The plan implied this via "Fall through so per-tool loop
    fills out results array" but did not specify the exact aborted
    string — I picked one that names the tool and the gate so the next
    loop's recent_loop_history is interpretable.
files_modified:
  - src/bot/adapter/minecraft/behaviors/pathfind.js
  - src/bot/adapter/minecraft/behaviors/follow.js
  - src/bot/adapter/minecraft/behaviors/mineVein.js
  - src/bot/adapter/minecraft/registry.js
  - src/bot/brain/inflight.js
  - src/bot/adapter/minecraft/observers/snapshot.js
  - src/bot/brain/fsm.js
  - src/bot/brain/index.js
  - src/bot/brain/orchestrator.js
files_created:
  - scripts/verify-260513-wkd.mjs
---

# 260513-wkd — Orchestrator loop + FSM rework Summary

## What shipped

### Task 1 (commit `0744c6e`) — surface-area precursor, no semantic change

- `pathfind.goTo` accepts optional `signal` (6th param); aborts via
  `bot.pathfinder.stop()`; new `'aborted'` PathfindResult variant.
  `composeVerticalHint` short-circuits on `'aborted'`.
- `registry.js` goTo handler passes `config?.signal` through.
- `follow.js` documents the target-clear abort contract inline on
  `startFollow` (no signal param — follow's 1 s tick is too coarse).
- `mineVein.gatherAction` pushes progress via
  `config?.onProgress?.({dug, total})` — same channel as cuboid
  build/dig. Initial 0/N tick on batch known + per-block ticks after
  each entry.done.
- `inflight.js` exports `getInFlightLineForSnapshot(entry, now)`
  rendering `in_flight: <name>(<argblurb>) started=<X.X>s ago[ — <completed>/<total>[, y=<currentY>]]`.
  Preserves Phase 7 D-10 em-dash + y=<currentY> channels byte-stable;
  only the elapsed trailer changes (`(Xs)` → `started=Xs ago`).
- `snapshot.js` replaces the inline in_flight block with a single call
  to `getInFlightLineForSnapshot`. Brain + adapter now share one
  source-of-truth formatter; the helper lives in `brain/inflight.js`
  so the verify harness can call it without booting the adapter.
- `fsm.js` adds `Priority.P2_ACTION_COMPLETE = 2.1` between
  `P2_MOVEMENT (2)` and `P2_5_LOOP_END (2.5)`.
- `index.js` reenqueue switch routes `'sei:action_complete'` at
  `Priority.P2_ACTION_COMPLETE`.
- `orchestrator.js` registers the `stop` personality tool (no args,
  returns 'stopped'); adds `'stop'` to `PERSONALITY_NAMES`; replaces
  the legacy "Owner messages preempt the body" line with the new
  always-speak-on-P0/P1 + cancel-semantics addendum.

After Task 1: the old blocking loop still runs end-to-end; all the
new wires are present but inert.

### Task 2 (commit `0bee0d0`) — non-blocking loop + cancel-semantics dispatcher

- `runWithInflightAwait` / `startLongRunner` split. `startLongRunner`
  returns synchronously `{ promise, abortController, handle, startedAt }`;
  the orchestrator attaches a settle handler that re-enqueues
  `sei:action_complete` carrying `{ name, input, result, aborted, tool_use_id }`.
- `_buildExecOpts` extends the progress-flavored set to include
  `gather` so the in_flight: line shows `dug K/N` via the SAME
  onProgress channel used by build/dig.
- `runIterations`: when a long-runner tool_use appears, the per-tool
  loop early-returns after stashing `{ results[], pendingActionUse, byteWarn }`
  on the loop. handleDispatch returns immediately; the loop is
  suspended until sei:action_complete arrives.
- `handleActionComplete(loop, data)`: finalises the pending results
  array, appends the snapshot turn (with PLAYER INTERRUPT folded in
  when pendingInterrupt is set + aborted=true), replaces the outer
  abortController if it was aborted by a P1 preempt, sets
  `loop._isContinuation = true`, and drives one more iteration.
- Cancel-semantics dispatch table (single decision site in
  `runIterations`, BEFORE the per-tool loop) — see table below.
- `terminateLoop` + `teardownLoop` split. `terminateLoop` flags
  `loop._terminated` only; `teardownLoop` runs the legacy finally
  block (sessionState.onLoopTerminal, loopHistory push,
  sei:loop_terminal re-enqueue, currentLoop=null, pendingAttack /
  preservedInterrupt re-fire, adapter.closeAnySessions). teardownLoop
  is callable from both the fresh-loop natural-completion path AND
  from action_complete continuations that terminate the loop.
- `handleDispatch sei:action_complete` branch routes to
  `handleActionComplete` when tool_use_id matches the loop's pending
  action. Drops if currentLoop is null or already terminal.
- `handleDispatch` owner-chat (P1) branch now ALSO aborts
  `currentLoop.inFlight.abortController` (was outer-only). The
  aborted in_flight fires sei:action_complete with aborted=true;
  pendingInterrupt is folded into the appendToolResults eventText so
  the SAME loop continues with `PLAYER INTERRUPT: <text>` context.
- `handleDispatch sei:attacked` (P0) branch synchronously aborts
  in_flight + outer signal, then calls `terminateLoop` + `teardownLoop`
  directly so the pendingAttack re-enqueue at P0 fires immediately
  (the legacy outer-signal abort cascade no longer flows through
  callPersonality when the loop is suspended on an in_flight).
- `_anthropicOverride` dep injection seam on `createOrchestrator` for
  verify-harness use only.

## Cancel-semantics dispatch table (as implemented)

| Case | Trigger | Tool batch | Code location | Effect |
|------|---------|-----------|---------------|--------|
| **0** | first iteration of any fresh loop | long-runner | runIterations long-runner branch (`isLongRunner` true, `loop.isTerminal` false) | Dispatch via `startLongRunner`, stash inFlight + pendingResults, return |
| **1** | action_complete continuation OR P1 preempt | text only, no tools | `runIterations` toolUses.length === 0 branch | Loop terminates (existing terminal-no-tools path); teardownLoop fires |
| **2** | continuation OR fresh | `stop` tool present | runIterations pre-dispatch: `hasStop` branch | `loop.inFlight?.abortController.abort()`; flag `loop.isTerminal = true`; per-tool loop fills stop's result slot ('stopped'); appendToolResults; `if (loop.isTerminal) return` → teardownLoop |
| **3-fire** | continuation, trigger ∈ {`owner_chat`, `sei:chat_received`, `sei:attacked`, `sei:joined`} | new long-runner | runIterations pre-dispatch: `isContinuation && newLongRunners.length > 0 && triggerIsP0P1` | Log `case3-gate trigger=<event> fire`; abort old inFlight; flag terminal; `reenqueue(loop._triggerEvent, loop._triggerData)`; per-tool loop synthesises `aborted: <name> (case-3 reseed)` for long-runners; appendToolResults; return → teardownLoop |
| **3-suppress** | continuation, trigger ∈ {`sei:idle`, `sei:loop_end`, `sei:action_complete`, ...} | new long-runner | runIterations pre-dispatch: `isContinuation && newLongRunners.length > 0 && !triggerIsP0P1` | Log `case3-gate trigger=<event> suppress`; abort old inFlight; FALL THROUGH to the per-tool loop's long-runner branch which dispatches the new long-runner as the next inFlight of the SAME loop |

Continuation is flagged via `loop._isContinuation = true` set by
`handleActionComplete` AND by the P1 preempt path's PLAYER INTERRUPT
fold. The first iteration of a fresh loop has `_isContinuation = false`
so case 3's gate cannot misfire on the seed iteration.

## Guards preserved verbatim

- `shouldPreserveInterrupt` (PLAYER INTERRUPT dedup, 500ms bucket key
  `username:text:bucket`)
- `pendingAttack` + verbal-first `eventAddendum` reseed (P0 path,
  whose semantics are unchanged; only the trigger mechanics moved from
  outer-signal abort cascade to direct teardownLoop call)
- `_digCapped` (parallel-dig cap = 1 per turn) — fired before the
  long-runner branch sees `dig`
- `_followNoop` (same-turn follow + attackEntity collapse)
- `cant_reach 2x` dedup + nudge (cantReachNudge wins over silenceNudge)
- silent-iteration cadence (`_advanceIterationCadence`, threshold 4)
- WR-02 external-signal bridging (`loop._externalSignal` +
  `bridgeExternalAbort` + `replaceAbortController` re-bridge)
- byte-cap warning (`BYTE_WARN_THRESHOLD` = 100 KiB)
- `gracefulCapClose` (iteration cap one-shot wrap-up with `tools=[]`)
- `repairAfterAbort` (orphan tool_result pairing on outer-signal abort)
- `shouldSuppressLoopEndSay` (loop_end-window dedup of text emissions)
- WR-04 preserved interrupt re-enqueue at P1 after a P0 attack reseed

## Guards migrated

- **Loop teardown**: legacy `finally` block in `handleDispatch` →
  `teardownLoop(loop)`. All steps preserved (sessionState.onLoopTerminal,
  loopHistory push, sei:loop_terminal re-enqueue, currentLoop = null,
  pendingAttack re-fire, preservedInterrupt re-fire,
  adapter.closeAnySessions). Now callable from both the fresh-loop
  natural-completion path AND from action_complete continuations that
  terminate the loop (case 2 stop, case 3 reseed, text-only after
  action_complete).
- **In_flight abort semantics**: legacy `currentLoop.abortController.abort()`
  for P1 owner chat. New: aborts BOTH the in_flight's dedicated
  AbortController AND the outer abortController. P0 attack path
  similarly aborts both.

## Harness assertions (scripts/verify-260513-wkd.mjs)

All 13 assertions PASS — `node scripts/verify-260513-wkd.mjs` exits 0.

- B1 PASS — non-blocking dispatch (handleDispatch returns within ~2ms while gather pends; assertion <500ms)
- B2 PASS — sei:action_complete re-enqueued at P2.1 with correct `{ name, input, result, aborted, tool_use_id }` shape
- B3 PASS — action_complete drove a second Haiku call with tool_result + snapshot
- B4 PASS — case 1 (text-only response) terminates loop without further action_complete
- B2b PASS — priority tier ordering P2_MOVEMENT(2) before P2_ACTION_COMPLETE(2.1)
- B5 PASS — case 2 (stop tool) tears down loop AND emits spoken text
- B5b PASS — P1 preempt aborts in_flight; subsequent stop tears down loop (bonus end-to-end abort wire check)
- B6-fire PASS — case 3 fire: owner_chat trigger reseeds original event after new long-runner
- B6-suppress PASS — case 3 suppress: sei:idle trigger continues same loop with new in_flight
- B7a PASS — P1 mid-loop preempt aborts in_flight, same loop continues with PLAYER INTERRUPT, case-1 text terminates
- B7b PASS — P0 attack preempt uses existing pendingAttack reseed path; sei:attacked re-enqueued at P0
- B8 PASS — signal delivery: config.signal.aborted flips within one tick of `abortController.abort()`
- B9 PASS — stop terminal with no in_flight: no abort needed, loop terminates cleanly

`scripts/verify-phase7.mjs`: 13/13 PASS (regression — em-dash +
y=<currentY> channels preserved byte-stable; cuboid surface unchanged).

## Live-verification checklist (deferred to developer)

These require a live mineflayer bot + Minecraft server; the executor
cannot run them. Run after merging this work and an `npm` boot.

- **Cactus gather + chat interrupt (case 1, text only).** Spawn bot,
  `say "gather 7 cactus"` → gather starts, `in_flight: gather(cactus) started=…s ago — 0/N` line appears in the next snapshot. Mid-gather, `say "wait, how many do we need?"` → bot speaks within ~1 s (NO 12 s pathfind timeout wait), gather continues, `in_flight:` line persists with updated `K/N` ticks.
- **Attack mid-gather (P0 reseed).** During gather, get hit by a
  zombie (let one attack the bot, or use `/summon zombie`). Bot must
  speak verbal-first (eventAddendum present) in a FRESH loop after the
  gather aborts. Aborted gather result `aborted partial gather K/N` appears in `recent_loop_history` of the new loop.
- **"We have enough" stop (case 2).** Mid-gather, `say "we have enough"` → bot must say something AND emit `stop` tool. The in_flight's
  AbortController flips within ~1 s; gather body halts; partial result
  `gathered K/N cactus (aborted)` appears in the loop's tool_result; bot
  holds position (no follow-up movement).
- **"Switch to food" mid-gather (case 3 fire).** Mid-gather,
  `say "actually let's get food instead"` → bot says something,
  gather aborts mid-batch, a FRESH loop opens (case 3 fire branch,
  trigger=owner_chat) seeded with the new owner-chat context. The
  model's mid-loop response is in recent_loop_history of the new loop.
- **P0 zombie mid-gather (existing P0 path retained).** During gather,
  hit by a zombie → bot reacts verbally first via the existing
  eventAddendum path (FRESH loop, NOT the new mid-loop P1
  continuation). Confirm the snapshot in the post-attack iteration
  shows `in_flight: gather(...) started=…s ago` ONLY if gather is
  re-issued by the model; otherwise the gather is aborted and the new
  loop proceeds attack-first.

## Threat Flags

None. This rewrite preserves all existing trust boundaries: the
orchestrator's adapter seam is unchanged, no new network endpoints or
auth paths are introduced, no new file-system writes, and the cancel-
semantics dispatcher is brain-internal (no remote control surface).

## Self-Check: PASSED

- src/bot/brain/orchestrator.js — modified, present (commit 0744c6e + 0bee0d0)
- src/bot/brain/fsm.js — modified, present (commit 0744c6e)
- src/bot/brain/index.js — modified, present (commit 0744c6e)
- src/bot/brain/inflight.js — modified, present (commit 0744c6e)
- src/bot/adapter/minecraft/behaviors/pathfind.js — modified, present (commit 0744c6e)
- src/bot/adapter/minecraft/behaviors/follow.js — modified, present (commit 0744c6e)
- src/bot/adapter/minecraft/behaviors/mineVein.js — modified, present (commit 0744c6e)
- src/bot/adapter/minecraft/registry.js — modified, present (commit 0744c6e)
- src/bot/adapter/minecraft/observers/snapshot.js — modified, present (commit 0744c6e)
- scripts/verify-260513-wkd.mjs — created, present (commit 0bee0d0)
- Commit 0744c6e: FOUND in git log
- Commit 0bee0d0: FOUND in git log
- scripts/verify-260513-wkd.mjs: 13/13 PASS
- scripts/verify-phase7.mjs: 13/13 PASS (no regression)
