---
phase: 260514-ngj
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/bot/brain/orchestrator.js
  - src/bot/brain/index.js
  - src/bot/adapter/minecraft/behaviors/chat.js
  - scripts/verify-260514-gam.mjs
autonomous: true
requirements:
  - NGJ-R1-R4-INTERRUPT-SEMANTICS
  - NGJ-END-LOOP-TOOL
  - NGJ-NO-PREABORT-OWNER-CHAT
  - NGJ-SPAWN-IDLE-NOT-JOINED
  - NGJ-TRIGGERDATA-CAPTURE
tags: [orchestrator, fsm, interrupt-semantics, cancel-semantics]

must_haves:
  truths:
    - "Owner chat arriving mid-loop appends a PLAYER INTERRUPT turn WITHOUT pre-aborting the in-flight action."
    - "On a P0/P1-triggered iteration, a text-only LLM response keeps the loop alive (R1)."
    - "On a P0/P1-triggered iteration, text + new action aborts old in-flight and the new action becomes in-flight in the SAME loop (R2)."
    - "On a P0/P1-triggered iteration, `end_loop` aborts in-flight and terminates the loop (R3)."
    - "On a P0/P1-triggered iteration, `end_loop` + new action terminates the loop AND a fresh loop opens seeded with the new action (R4)."
    - "On P2/P3-triggered iterations (action_complete, idle, loop_end), a text-only response terminates the loop as before — unchanged."
    - "First spawn enqueues `sei:idle` (P3), not `sei:joined`; greeting becomes a normal idle response."
    - "`sei:joined` is no longer recognized as a P0/P1 trigger in `triggerIsP0P1`."
    - "STOP_VERBS fast path in chat.js still hard-cancels the body (unchanged for stop/halt/cancel/nevermind)."
    - "`loop._triggerData = data` is set at loop creation so R4 reseed can carry the original event payload if used."
    - "Automated harness covers R1, R2, R3, R4 and exits 0."
  artifacts:
    - path: "src/bot/brain/orchestrator.js"
      provides: "end_loop tool, R1-R4 cancel-semantics dispatch, per-iteration trigger tracking, removed stop tool"
      contains: "end_loop"
    - path: "src/bot/brain/index.js"
      provides: "spawn path enqueues sei:idle at P3 (no sei:joined)"
      contains: "sei:idle"
    - path: "src/bot/adapter/minecraft/behaviors/chat.js"
      provides: "Non-stop-verb owner chat no longer pre-aborts in-flight body"
      contains: "STOP_VERBS"
    - path: "scripts/verify-260514-gam.mjs"
      provides: "R1/R2/R3/R4 assertions added (or new sibling harness)"
      contains: "R1"
  key_links:
    - from: "src/bot/adapter/minecraft/behaviors/chat.js"
      to: "src/bot/brain/orchestrator.js handleDispatch owner-chat branch"
      via: "sei:chat_received event"
      pattern: "sei:chat_received"
    - from: "src/bot/brain/orchestrator.js runIterations terminal-no-tools branch (line ~1434)"
      to: "per-iteration trigger flag loop._currentIterationTrigger"
      via: "iterationTriggerIsP0P1 gate"
      pattern: "iterationTriggerIsP0P1"
    - from: "src/bot/brain/orchestrator.js end_loop tool dispatch"
      to: "case R4 reseed (new loop with new action as seed)"
      via: "hasEndLoop && newSuspendingTools.length > 0"
      pattern: "end_loop"
---

<objective>
Replace the locked "case 1/2/3" cancel-semantics from 260513-wkd with the cleaner
R1/R2/R3/R4 interrupt-response model. The model now uses an explicit `end_loop`
tool to terminate a P0/P1-triggered iteration; text-only on a P0/P1 iteration
means "keep waiting" (R1) and does NOT tear down the loop. Owner chat arriving
mid-loop stops pre-aborting the in-flight body — the chat is just folded in
as a PLAYER INTERRUPT user turn and the next iteration is treated as
P0/P1-triggered. Spawn no longer fires `sei:joined`; greeting becomes a normal
P3 idle response. Retire the `stop` tool — `end_loop` replaces it.

Purpose: The current implementation misimplements the locked design (it tears
down on text-only mid-loop, and pre-aborts body on every owner chat). The R1-R4
model preserves the option to "respond without dropping" cleanly and removes the
buggy `_triggerData`-empty reseed path.

Output: Working R1-R4 dispatcher, `end_loop` tool, no-pre-abort owner-chat path,
spawn-uses-idle, and an automated harness extension covering all four responses.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-CONTEXT.md
@.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-SUMMARY.md
@src/bot/brain/orchestrator.js
@src/bot/brain/index.js
@src/bot/adapter/minecraft/behaviors/chat.js
@scripts/verify-260514-gam.mjs
@scripts/verify-260513-wkd.mjs

<interfaces>
<!-- Key call sites the executor will touch. Extracted from orchestrator.js. -->

From src/bot/brain/orchestrator.js (current shape):

```js
// Line ~147 — personality tool name set
const PERSONALITY_NAMES = new Set(['setGoals', 'noteToSelf', 'follow', 'unfollow', 'stop'])

// Line ~564 — inline-metadata tool name set (dispatched synchronously in same iteration)
const INLINE_METADATA = new Set(['setGoals', 'noteToSelf', 'stop'])

// Line ~806 — loop creation: trigger event recorded, trigger DATA is NOT recorded today (bug)
loop._triggerEvent = event
loop._ownerSpoke = !!data?.ownerSpoke || event === 'owner_chat'

// Line ~1042 — executeInlineMetadata switch for setGoals/stop/noteToSelf
async function executeInlineMetadata(loop, use) { ... }

// Line ~1434 — runIterations terminal-no-tools branch (current behavior: always return)
if (toolUses.length === 0) {
  return  // Terminal turn — needs new gate for P0/P1-triggered iterations
}

// Line ~1473 — triggerIsP0P1 (currently keyed off loop._triggerEvent only;
// must be re-keyed off the CURRENT iteration's trigger)
const triggerIsP0P1 = (() => {
  const e = loop._triggerEvent
  return e === 'owner_chat' || e === 'sei:chat_received' || e === 'sei:attacked' || e === 'sei:joined'
})()

// Line ~1489-1525 — case-3 fire/suppress branch (the buggy reseed)
reenqueue(loop._triggerEvent, loop._triggerData ?? null)  // _triggerData never set → empty data
```

From src/bot/brain/index.js (line ~234):
```js
queue.enqueue(Priority.P1_CHAT, 'sei:joined', { reason: 'just_connected', hint: '...' })
```

From src/bot/adapter/minecraft/behaviors/chat.js (lines 48-49):
```js
if (ownerSpoke && orchestrator) {
  forceCancelBody(bot)                                      // ← REMOVE for non-stop-verb path
  try { orchestrator.currentLoop?.abortController?.abort() } catch {}  // ← REMOVE for non-stop-verb path
  // ... STOP_VERBS fast path keeps forceCancelBody
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add end_loop tool, retire stop, no-pre-abort owner chat, spawn-uses-idle</name>
  <files>src/bot/brain/orchestrator.js, src/bot/brain/index.js, src/bot/adapter/minecraft/behaviors/chat.js</files>
  <action>
Surface changes only — no semantic dispatcher change yet. Land in this order:

A. **orchestrator.js — register `end_loop`**:
   - Add `end_loop` tool definition next to `setGoals`/`noteToSelf`/`stop` in the personality-tool registration block (search for where `stop` is defined). Schema: `{ type: 'object', properties: {}, additionalProperties: false }` (no args). Description verbatim:
     `"End the current loop. Use when the owner's request is fully handled and there's nothing more to wait for, or when you want to abandon the current task. Pair with text. Required to end the loop on iterations triggered by owner chat or being attacked; otherwise text alone is enough."`
   - Add `'end_loop'` to `PERSONALITY_NAMES` set (line ~147).
   - Add `'end_loop'` to `INLINE_METADATA` set (line ~564).
   - In `executeInlineMetadata` (line ~1042), add the `end_loop` branch BEFORE the `stop` branch:
     ```js
     if (use.name === 'end_loop') {
       lastActionResult = 'loop ended'
       return { result: { type: 'tool_result', tool_use_id: use.id, content: 'loop ended', is_error: false }, terminate: true }
     }
     ```
   - **Retire `stop`**: remove `'stop'` from `PERSONALITY_NAMES` and `INLINE_METADATA`; remove the `stop` branch from `executeInlineMetadata`; remove the `stop` tool definition. The `hasStop` reference and case-2 branch will be removed in Task 2; for THIS task, repoint `hasStop` to `hasEndLoop = toolUses.some(u => u.name === 'end_loop')` and leave the existing case-2 abort-in-flight + terminal logic intact under the new name. This keeps the harness green between tasks.

B. **orchestrator.js — capture trigger data at loop creation** (line ~806, right next to `loop._triggerEvent = event`):
   ```js
   loop._triggerData = data ?? null
   ```
   Required for the R4 reseed path in Task 2.

C. **chat.js — stop pre-aborting body on owner chat (non-stop-verb path)**:
   Restructure lines 47-67 so `forceCancelBody(bot)` and `orchestrator.currentLoop?.abortController?.abort()` ONLY run inside the STOP_VERBS branch. The non-stop-verb owner-chat path now just falls through to the normal `sei:chat_received` emit at the bottom of the function. Expected diff:
   ```js
   if (ownerSpoke && orchestrator) {
     const trimmed = String(message).trim().toLowerCase()
     if (STOP_VERBS.has(trimmed)) {
       forceCancelBody(bot)
       try { orchestrator.currentLoop?.abortController?.abort() } catch {}
       try {
         const owner = orchestrator.goals?.snapshot?.()?.owner_goals ?? []
         for (const g of owner) { try { orchestrator.goals.remove?.('owner', g) } catch {} }
       } catch {}
       try { bot.chat('stopping.') } catch {}
       return
     }
     // Non-stop owner messages fall through to dispatch; orchestrator handles
     // PLAYER INTERRUPT folding without pre-aborting the body.
   }
   ```
   Leave the `recordIncomingChat` call (line 37) and the proximity/addressed gates (lines 69-86) intact.

D. **index.js — spawn enqueues idle, not joined** (line ~234):
   Replace the `queue.enqueue(Priority.P1_CHAT, 'sei:joined', { ... })` block with:
   ```js
   queue.enqueue(Priority.P3_IDLE, 'sei:idle', { reason: 'just_connected_first_spawn' })
   ```
   Verify `Priority.P3_IDLE` is the correct constant name — check `src/bot/brain/fsm.js` first. If it's named differently (e.g. `P3_IDLE_TICK`), use that constant. The `hint` field is dropped since idle is a non-event tick — greeting now flows through whatever idle-seed prompt path exists.

E. **orchestrator.js — drop `sei:joined` from triggerIsP0P1** (line ~1475):
   Remove the `|| e === 'sei:joined'` clause. The event no longer exists as a trigger source; leaving it would be dead code with bug-magnet potential.

After these edits: existing harness `node scripts/verify-260513-wkd.mjs` should remain 13/13 if `hasStop` rename was done cleanly (assertions reference behavior, not internal var names — verify by reading the harness). `node scripts/verify-260514-gam.mjs` should also remain green (universal-inflight assertions unaffected).
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-260513-wkd.mjs &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-260514-gam.mjs &amp;&amp; node -e "import('/Users/ouen/slop/sei/src/bot/brain/orchestrator.js').then(m =&gt; console.log('orch parse OK'))"</automated>
  </verify>
  <done>
- `end_loop` defined, in PERSONALITY_NAMES, in INLINE_METADATA, handled in executeInlineMetadata with content 'loop ended' and terminate=true.
- `stop` tool removed from registration, PERSONALITY_NAMES, INLINE_METADATA, and executeInlineMetadata. References to `hasStop` repointed to `hasEndLoop`.
- `loop._triggerData = data ?? null` set at loop creation.
- chat.js: forceCancelBody only fires inside STOP_VERBS branch; non-stop owner chat falls through to normal dispatch.
- index.js: first-spawn path enqueues sei:idle at P3 (no sei:joined).
- triggerIsP0P1 in orchestrator.js no longer references sei:joined.
- Both existing harnesses (260513-wkd, 260514-gam) still pass.
- orchestrator.js parses (Node import succeeds).
  </done>
</task>

<task type="auto">
  <name>Task 2: R1-R4 dispatcher + per-iteration trigger tracking + R4 reseed</name>
  <files>src/bot/brain/orchestrator.js</files>
  <action>
Replace the cancel-semantics dispatch site (current lines ~1434-1532) with the R1/R2/R3/R4 model. This is the semantic heart of the task — work carefully.

A. **Per-iteration trigger tracking**. Add a new loop field `loop._currentIterationTrigger`:
   - At loop creation (orchestrator.js ~806), initialize to `event` (the trigger that opened the loop): `loop._currentIterationTrigger = event`.
   - In `handleActionComplete` (search for the function near line ~600-700, just below `handleDispatch`'s `sei:action_complete` branch): immediately before driving the next iteration, set `loop._currentIterationTrigger` based on the source. If `pendingInterrupt` is set OR `data?.aborted === true` due to a P1/P0 preempt path, set it to the original interrupting event:
     - PLAYER INTERRUPT path (pendingInterrupt set): `loop._currentIterationTrigger = 'sei:chat_received'`
     - P0 attack path: handled separately (teardown + reseed), not through handleActionComplete continuation — no change here.
     - Normal action_complete (action finished naturally): `loop._currentIterationTrigger = 'sei:action_complete'`
   - Search for any other path that drives `runIterations` again on an existing loop (grep for `runIterations(`) and ensure `_currentIterationTrigger` is set before each call. The first call from handleDispatch on fresh-loop creation already gets it from loop creation.

B. **New triggerIsP0P1 derivation** in runIterations (replace line ~1473 block):
   ```js
   const iterationTriggerIsP0P1 = (() => {
     const e = loop._currentIterationTrigger ?? loop._triggerEvent
     return e === 'owner_chat' || e === 'sei:chat_received' || e === 'sei:attacked'
   })()
   ```
   Note: `sei:joined` removed (Task 1 already dropped it). Use `iterationTriggerIsP0P1` (per-iteration), NOT a loop-scoped flag.

C. **New terminal-no-tools rule** (replace line ~1434 block):
   ```js
   if (toolUses.length === 0) {
     if (iterationTriggerIsP0P1) {
       // R1 — text-only on a P0/P1-triggered iteration means "keep waiting".
       // The loop stays alive. The in_flight (if any) continues. The next
       // iteration will be driven by whatever event arrives next
       // (action_complete, another preempt, or attack). Return WITHOUT
       // tearing down. Note: any spoken text was already emitted above.
       logger.debug?.(`[sei/orch] R1 text-only on P0/P1 iteration — loop stays alive (loop=${loop.id}, trigger=${loop._currentIterationTrigger})`)
       return
     }
     // P2/P3-triggered iteration (action_complete, idle, loop_end): text-only
     // terminates the loop as before. The outer handleDispatch / handleActionComplete
     // path will call teardownLoop after this return.
     return
   }
   ```
   Important: `return` here does NOT itself terminate the loop. Loop termination is driven by `loop.isTerminal` + `teardownLoop`. For the P0/P1 R1 case, NEITHER flag is set, so the loop is "suspended" with currentLoop still set and inFlight still running. The next event (action_complete from natural in_flight completion, or another preempt) re-enters via handleDispatch / handleActionComplete and drives another iteration.

   **Verify the suspension path holds**: After `return` from runIterations under R1, control returns to handleDispatch (or handleActionComplete). Those callers must NOT call teardownLoop when the loop is not terminal. Read handleDispatch ~line 690 finally/post-runIterations block and handleActionComplete's tail — confirm they only teardown when `loop.isTerminal`. If they unconditionally teardown, that's the bug to fix here (most likely they already gate on `loop.isTerminal`; if not, gate them).

D. **Replace case-2/case-3 block with R2/R3/R4 dispatcher** (lines ~1461-1532):
   ```js
   const hasEndLoop = toolUses.some(u => u.name === 'end_loop')
   const newSuspendingTools = toolUses.filter(u => !isInlineMetadata(u.name))
   // (note: end_loop is in INLINE_METADATA so it's already excluded from newSuspendingTools)

   if (hasEndLoop && newSuspendingTools.length > 0) {
     // R4 — end current loop AND open a fresh one with the new action as seed.
     // Abort old in_flight, flag terminal, re-enqueue the new action via a
     // synthetic event so the fresh loop's first iteration dispatches it.
     //
     // Reseed strategy: re-enqueue the original trigger (preserving owner
     // chat context) at the SAME priority. The model's mid-loop response
     // (which contained end_loop + new action) is already appended to history
     // and surfaces in the next loop via recent_loop_history. The fresh loop's
     // first iteration runs another haiku call and the model will re-emit the
     // new action because the prior turn's text/intent is in history. This
     // mirrors the case-3 fire branch but is gated on end_loop's presence
     // (not on continuation-status).
     logger.debug?.(`[sei/orch] R4 end_loop + new action: terminating + reseeding trigger=${loop._currentIterationTrigger ?? loop._triggerEvent} new=${newSuspendingTools.map(u => u.name).join(',')}`)
     if (loop.inFlight) {
       try { loop.inFlight.abortController.abort() } catch {}
     }
     loop.isTerminal = true
     try {
       reenqueue(loop._triggerEvent, loop._triggerData ?? null)
     } catch (err) {
       logger.warn?.(`[sei/orch] R4 reseed re-enqueue failed: ${err.message}`)
     }
     // Synthesize aborted placeholders for the new long-runners — we won't
     // dispatch them (the fresh loop will). end_loop's result slot is filled
     // by executeInlineMetadata's terminate path.
     // (Fall through to per-tool loop; long-runners get 'aborted: <name> (R4 reseed)'.)
   } else if (hasEndLoop) {
     // R3 — end current loop. Abort in_flight, flag terminal, no reseed.
     logger.debug?.(`[sei/orch] R3 end_loop alone: terminating loop=${loop.id}`)
     if (loop.inFlight) {
       try { loop.inFlight.abortController.abort() } catch {}
     }
     loop.isTerminal = true
     // Fall through; per-tool loop fills end_loop's slot with 'loop ended'.
   } else if (newSuspendingTools.length > 0) {
     // R2 if iterationTriggerIsP0P1 AND in_flight exists (or first iteration
     // of P0/P1-triggered loop dispatching its first action — same effect):
     //   abort old in_flight, new action becomes in_flight, SAME loop.
     // Otherwise (P2/P3-triggered iteration with new long-runner): same loop
     // continues; this is the existing "case 3 suppress" semantics generalized.
     // Both paths converge: abort in_flight if present, dispatch new long-runner.
     if (loop.inFlight) {
       logger.debug?.(`[sei/orch] R2/suppress new action: aborting old in_flight=${loop.inFlight.name} new=${newSuspendingTools.map(u => u.name).join(',')}`)
       try { loop.inFlight.abortController.abort() } catch {}
     } else {
       logger.debug?.(`[sei/orch] first-iter long-runner=${newSuspendingTools.map(u => u.name).join(',')}`)
     }
     // Fall through to per-tool loop which dispatches the new long-runner.
   } else {
     // Text + only inline-metadata tools (setGoals / noteToSelf / end_loop
     // already handled above). Same-loop continuation, no abort, no terminal.
     logger.debug?.(`[sei/orch] inline-metadata only: trigger=${loop._currentIterationTrigger ?? loop._triggerEvent}`)
   }
   ```
   Remove the entire old `hasStop` / `isContinuation`+`triggerIsP0P1` case-3 block. The new dispatcher does NOT depend on `_isContinuation` — the gate is now `hasEndLoop` presence plus tool composition, which is determinable from the LLM response alone.

E. **Aborted placeholder content**: in the per-tool loop where long-runners get synthesized aborted results during R4, use `aborted: <name> (R4 reseed)` (mirror the existing `aborted: <name> (case-3 reseed)` pattern). Update the existing string if it's the only consumer.

F. **Persona prompt addendum** — inject only on P0/P1-triggered iterations:
   - Locate the seed-prompt or per-iteration user-turn construction (search for "PLAYER INTERRUPT" or the seed-owner block near callPersonality). On iterations where `iterationTriggerIsP0P1` is true, append this text block to the user turn (or system addendum, whichever is the existing addendum-injection seam):
     `"You can end this loop with end_loop, or change your action by calling a new action tool. If you just want to keep doing what you're already doing, no tool call is needed — the body continues."`
   - The existing P0/P1-related addendum lives near where `eventAddendum` is composed for attacks and where PLAYER INTERRUPT text is folded — pick the closest existing addendum slot and append, do not introduce a new injection mechanism. If there is already an analogous addendum (likely from 260513-wkd "always speak on P0/P1"), REPLACE it with the R1-R4 version so the model gets clear guidance.

After these edits the orchestrator implements R1-R4 with:
- R1: text-only on P0/P1 iteration → loop stays alive (return without terminate).
- R2: text + new action on any iteration → abort in_flight, new becomes in_flight, same loop.
- R3: text + end_loop → abort in_flight, terminate loop.
- R4: text + end_loop + new action → abort in_flight, terminate loop, reseed fresh loop with original trigger event + data.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-260514-gam.mjs &amp;&amp; node -e "import('/Users/ouen/slop/sei/src/bot/brain/orchestrator.js').then(m =&gt; console.log('orch parse OK after R1-R4'))"</automated>
  </verify>
  <done>
- `end_loop` is the sole loop-termination signal on P0/P1-triggered iterations (R3/R4).
- Per-iteration `loop._currentIterationTrigger` set at loop creation AND at every continuation entry (handleActionComplete and any other runIterations re-entry).
- `iterationTriggerIsP0P1` derived from `loop._currentIterationTrigger` (NOT `loop._triggerEvent` alone).
- terminal-no-tools branch: returns WITHOUT teardown when iterationTriggerIsP0P1 (R1); returns as before otherwise.
- R2: text + new action aborts old in_flight, new dispatches in same loop.
- R3: text + end_loop terminates loop (aborts in_flight, flags terminal, falls through to per-tool loop).
- R4: text + end_loop + new action terminates AND re-enqueues `loop._triggerEvent` with `loop._triggerData` so the fresh loop seeds with the original context.
- All references to `hasStop` and `_isContinuation`-gated case-3 logic removed.
- Persona prompt addendum injected only on P0/P1-triggered iterations.
- orchestrator.js parses; 260514-gam harness still green (existing assertions are inflight-shape, not interrupt-semantics, so they should not regress — if any do, fix before declaring task done).
  </done>
</task>

<task type="auto">
  <name>Task 3: Extend verify-260514-gam.mjs harness with R1-R4 assertions</name>
  <files>scripts/verify-260514-gam.mjs</files>
  <action>
Extend the existing `scripts/verify-260514-gam.mjs` harness (566 lines, uses `_anthropicOverride` dep-injection seam — read it first to understand the mocking style). Add a new section `### R1-R4 Interrupt Response Semantics` with four new assertions. Mirror the structure of B7a (P1 mid-loop preempt) from `scripts/verify-260513-wkd.mjs` for the mock setup pattern.

For each assertion:
1. Start a fresh orchestrator with `_anthropicOverride` returning a scripted response sequence.
2. Dispatch a P1 event (`sei:chat_received` with `{ username: 'owner', message: 'go gather cactus', ownerSpoke: true, ts: Date.now() }`) to open a loop.
3. First LLM call returns a long-runner tool (e.g., `gather({ block: 'cactus', n: 7 })`) to start an in_flight.
4. Mid-flight, dispatch another P1 event to trigger the interrupt iteration.
5. Second LLM call returns the response shape under test (R1/R2/R3/R4).
6. Assert the orchestrator's resulting state.

Assertions to add:

**R1 (P1-triggered iteration → text-only → loop stays alive):**
- Setup: P1 chat opens loop; first call returns `gather`; mid-flight P1 chat arrives; second call returns text-only ("we're still going").
- Assert:
  - `loop.isTerminal === false` after second LLM call settles.
  - `currentLoop !== null` (loop still active).
  - Text emitted as chat (one adapter.chat call).
  - in_flight reference still present OR a new action_complete-driven iteration has not yet fired (depending on whether the test mock resolves the in_flight promise).
- Label: `R1 PASS — P1-triggered text-only response keeps loop alive`.

**R2 (P1-triggered iteration → text + new action → same loop, new in_flight):**
- Setup: same as R1; second call returns text + `goTo({ x: 0, y: 64, z: 0, range: 4 })` (no end_loop).
- Assert:
  - `loop.isTerminal === false`.
  - `currentLoop !== null`.
  - Old in_flight's abortController.signal.aborted === true (or aborted=true result observed via action_complete).
  - New in_flight name === 'goTo' (or whatever new tool was emitted).
  - currentLoop.id unchanged (SAME loop).
- Label: `R2 PASS — P1-triggered text+new action aborts old in_flight, new becomes in_flight, same loop`.

**R3 (P1-triggered iteration → text + end_loop → loop terminates):**
- Setup: same; second call returns text + `end_loop`.
- Assert:
  - `loop.isTerminal === true` (or `_terminated === true`).
  - `currentLoop === null` after teardownLoop fires (give one microtask tick).
  - Old in_flight's abortController.signal.aborted === true.
  - No new event was reenqueued with the original trigger (queue snapshot empty of `sei:chat_received` reseeds).
- Label: `R3 PASS — P1-triggered text + end_loop terminates loop`.

**R4 (P1-triggered iteration → text + end_loop + new action → terminate + fresh loop):**
- Setup: same; second call returns text + `end_loop` + `gather({ block: 'wood', n: 5 })`.
- Assert:
  - Original `loop.isTerminal === true`.
  - Old in_flight aborted.
  - Queue contains a re-enqueued event with `event === 'sei:chat_received'` carrying the ORIGINAL trigger data (assert `data.message === 'go gather cactus'` and `data.ownerSpoke === true` — confirms `loop._triggerData` was captured correctly in Task 1).
  - After draining the re-enqueued event (call `await orchestrator.dispatch(...)` manually if the harness uses synchronous drain), a fresh loop is created with a new `currentLoop.id` distinct from the original.
- Label: `R4 PASS — P1-triggered text + end_loop + new action terminates loop AND reseeds fresh loop with original trigger data`.

Add a fifth regression check:

**R-spawn-idle (spawn first-fire enqueues idle, not joined):**
- Stub the spawn-equivalent path (or directly inspect `src/bot/brain/index.js` is irrelevant for the orchestrator harness — instead assert that `triggerIsP0P1`/`iterationTriggerIsP0P1` returns false for `'sei:joined'`). Simplest: dispatch a `sei:joined` event into a fresh orchestrator and assert it does NOT open a P0/P1-iteration (or, if `sei:joined` is no longer routable, assert the orchestrator drops/ignores it cleanly without throwing).
- Label: `R-spawn-idle PASS — sei:joined is no longer a P0/P1 trigger`.

Print final tally: `node scripts/verify-260514-gam.mjs` must exit 0 with `R1 PASS`, `R2 PASS`, `R3 PASS`, `R4 PASS`, `R-spawn-idle PASS` lines emitted. Existing 260514-gam assertions must remain green (no regression).

**Pitfall**: the existing harness mocks may need extension — if `_anthropicOverride` only supports a single response, you may need to expose a queue-based mock (push responses, pop per call). Check first; if absent, add a small mockSequence helper at the top of the harness file.

**Pitfall**: timing of teardownLoop is async (microtask). Use `await new Promise(r => setImmediate(r))` between dispatches to let the FSM drain.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-260514-gam.mjs</automated>
  </verify>
  <done>
- scripts/verify-260514-gam.mjs runs and exits 0.
- New labels emitted: R1 PASS, R2 PASS, R3 PASS, R4 PASS, R-spawn-idle PASS.
- All pre-existing assertions in 260514-gam.mjs still pass (no regression).
- Mock infrastructure (response-queue if needed) is reusable for future interrupt-semantics tests.
  </done>
</task>

</tasks>

<verification>
After all three tasks land:

1. `node scripts/verify-260513-wkd.mjs` — should remain 13/13 PASS. (Some assertions reference `stop` tool; if any FAIL because the tool was retired in Task 1, that's expected — the test must be updated OR the SUMMARY notes the deviation. The 260513-wkd harness is allowed to drift since `stop` is being replaced; record any failures in the SUMMARY's deviations section but DO NOT silently modify 260513-wkd.mjs to mask removal of `stop`. If updates needed, document them.)

   **Decision rule**: if a 260513-wkd assertion fails specifically because `stop` no longer exists, update that assertion to use `end_loop` instead AND note the change in deviations. If it fails for any other reason, that's a regression — fix the code.

2. `node scripts/verify-260514-gam.mjs` — must be green including the new R1-R4 + R-spawn-idle assertions.

3. Manual code review checklist:
   - `grep -n "sei:joined" src/bot/brain/orchestrator.js src/bot/brain/index.js` — should return 0 hits (or only comments noting the retirement).
   - `grep -n "'stop'" src/bot/brain/orchestrator.js` — should return 0 hits in PERSONALITY_NAMES / INLINE_METADATA / tool definitions (STOP_VERBS in chat.js is unrelated and may match; that's fine).
   - `grep -n "forceCancelBody" src/bot/adapter/minecraft/behaviors/chat.js` — should appear exactly once, inside the STOP_VERBS branch.
   - `grep -n "loop._triggerData" src/bot/brain/orchestrator.js` — must show at least one assignment (loop creation) and at least one read (R4 reseed).
   - `grep -n "loop._currentIterationTrigger" src/bot/brain/orchestrator.js` — must show assignment at loop creation, in handleActionComplete, and reads in iterationTriggerIsP0P1.
</verification>

<success_criteria>
- Owner chat arriving mid-loop no longer pre-aborts the in-flight body (only STOP_VERBS does).
- `end_loop` tool replaces `stop`; defined, in personality + inline-metadata sets, and handled in executeInlineMetadata.
- R1 (text-only on P0/P1 iteration) keeps loop alive — verified by automated harness.
- R2 (text + new action) aborts old in_flight, new becomes in_flight in SAME loop — verified.
- R3 (text + end_loop) terminates loop — verified.
- R4 (text + end_loop + new action) terminates loop AND reseeds fresh loop with ORIGINAL trigger data — verified, and the test confirms `loop._triggerData` plumbing works (the bug we identified).
- P2/P3-triggered iterations (action_complete, idle, loop_end) terminate text-only as before — verified by existing 260514-gam assertions still passing.
- Spawn first-fire enqueues `sei:idle` at P3; `sei:joined` no longer routes as P0/P1 trigger.
- Persona prompt addendum injected on P0/P1 iterations only, with the verbatim text from the task description.
- All three harnesses (260513-wkd if updates allowed, 260514-gam, plus the new R1-R4 assertions) exit 0.
</success_criteria>

<output>
After completion, create `.planning/quick/260514-ngj-implement-p1-p0-interrupt-response-seman/260514-ngj-SUMMARY.md` summarizing:
- Which files were modified and why.
- Whether 260513-wkd.mjs assertions needed updates (and which ones) due to the `stop` → `end_loop` retirement.
- The final harness PASS counts.
- Any deviations from the plan (e.g., addendum injection site differed from expected).
- The R4 reseed strategy chosen (re-enqueue original trigger event with `loop._triggerData` vs. synthetic `sei:resume_with_action` — plan specifies the former as primary; if executor picked an alternative, document why).
- Live-verification checklist deferred to developer:
  - R1: cactus gather + "where are we headed" mid-flight → bot responds, gather continues.
  - R2: cactus gather + "actually get wood instead" → bot responds, gather aborts, goTo (or wood gather) starts, same loop.
  - R3: cactus gather + "we have enough" + (model emits end_loop) → bot responds, gather aborts, loop ends, no follow-up.
  - R4: cactus gather + "stop and switch to food" + (model emits end_loop + new action) → bot responds, gather aborts, loop ends, fresh loop opens with food action.
  - Spawn: first connect → bot greets via idle path (no `sei:joined`).
  - STOP_VERBS: "stop" / "halt" / "cancel" → fast-path body cancel + 'stopping.' chat, no Haiku round-trip.
</output>
