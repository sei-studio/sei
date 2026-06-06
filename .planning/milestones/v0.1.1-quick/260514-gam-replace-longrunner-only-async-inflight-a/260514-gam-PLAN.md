---
quick_task: 260514-gam
type: execute
plan: 01
wave: 1
depends_on: []
files_modified:
  - src/bot/brain/orchestrator.js
  - scripts/verify-260514-gam.mjs
autonomous: false  # live in-game verification scenarios 1–6 require the developer
requirements:
  - "260514-gam D1 (universalize non-blocking inflight to world-touching tools, B/A/A locked)"
  - "260514-gam D2 (P1/P0 race uses pendingInterrupt-fold join — no new dedup)"
  - "260514-gam D3 (batched tool_uses serialize within same loop via action_complete — one haiku per logical turn)"
  - "260514-gam D4 deferred (owner-position-in-snapshot — NOT in this task)"

must_haves:
  truths:
    - "5-placeBlock batch + mid-batch owner chat lands PLAYER INTERRUPT in <500ms (was 16–28s)."
    - "5-placeBlock batch with no interrupt completes all 5, then exactly ONE haiku call follows (not 5)."
    - "Single sync tool (e.g. equip, find, lookAt) suspends the loop and shows up in `in_flight:` snapshot line for its lifetime."
    - "Chat arriving in the <500ms window between a sync tool's dispatch and settle produces exactly one PLAYER INTERRUPT iteration (no double-fold, no lost chat)."
    - "case-2 (`stop`) tool fired while a sync tool is in_flight aborts that sync tool and terminates the loop."
    - "case-3 (new long-runner emitted mid-sync-inflight, P0/P1 trigger) aborts the sync inflight, terminates current loop, and reseeds a fresh loop with the original trigger event."
    - "setGoals / noteToSelf / stop remain inline (no suspend, no action_complete, one haiku iteration count, no `in_flight:` line for them)."
    - "The single `LONG_RUNNERS` set no longer exists alongside a new `INLINE_METADATA` set — exactly one classification function is the source of truth."
  artifacts:
    - path: "src/bot/brain/orchestrator.js"
      provides: "Universal non-blocking inflight dispatch + batched-result serialization via action_complete"
      contains: "INLINE_METADATA"
    - path: "scripts/verify-260514-gam.mjs"
      provides: "Automated harness for batched-tool-uses serialization, sync-tool suspend/resume, sync-tool chat preempt, case-2/case-3 with sync inflight"
  key_links:
    - from: "src/bot/brain/orchestrator.js handleActionComplete"
      to: "src/bot/brain/orchestrator.js per-tool dispatch loop"
      via: "loop._pendingResults + loop._pendingActionUse + loop._pendingToolUses (batched-queue serialization)"
      pattern: "_pendingToolUses"
    - from: "src/bot/brain/orchestrator.js owner-chat preempt branch (line ~735)"
      to: "src/bot/brain/orchestrator.js handleActionComplete pendingInterrupt-fold (line ~1076)"
      via: "loop.inFlight.abortController.abort() → sei:action_complete{aborted:true} → fold PLAYER INTERRUPT"
      pattern: "pendingInterrupt && data.aborted"
    - from: "src/bot/brain/orchestrator.js case-2/case-3 cancel dispatcher (line ~1253)"
      to: "loop.inFlight.abortController"
      via: "abort() call unchanged — now applies to sync tools too because they also set loop.inFlight"
      pattern: "loop.inFlight.abortController.abort"
---

<objective>
Replace the LONGRUNNER-only async inflight architecture with a universal non-blocking inflight path so every world-touching tool (sync + async) suspends the loop, registers `loop.inFlight`, fires `sei:action_complete` on settle, and is preemptible by P1 owner-chat / P0 attack. Fixes the 20-second blocking cascade on N-tool batches (concrete repro in CONTEXT.md: 5-`placeBlock` batch, 16–28s chat-preempt gap).

Purpose: today every tool not in `LONG_RUNNERS = {goTo, gather, dig, build, attackEntity}` runs through `runWithInflightAwait` inside the per-tool for-loop at orchestrator.js:1320–1538. Signal-check happens only BETWEEN iterations of that for-loop (line 1349), and mineflayer's internal 4s `placeBlock` timeout is not signal-aware → an N-tool batch blocks for up to N × tool-timeout before chat preempt can land.

Output: orchestrator.js with a single classification function (`INLINE_METADATA = {setGoals, noteToSelf, stop}`); every other tool dispatches via `startLongRunner` and the loop suspends until `sei:action_complete`. `handleActionComplete` is extended to drain a per-loop pending batch queue (`loop._pendingToolUses`) without an extra haiku call. The `LONG_RUNNERS` set goes away. case-2 / case-3 abort paths are unchanged structurally and verified to Just Work against sync tools because they only touch `loop.inFlight.abortController`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260514-gam-replace-longrunner-only-async-inflight-a/260514-gam-CONTEXT.md
@.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-CONTEXT.md
@.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-SUMMARY.md
@src/bot/brain/orchestrator.js
@src/bot/brain/inflight.js
@src/bot/brain/fsm.js
@src/bot/adapter/minecraft/behaviors/chat.js
@scripts/verify-260513-wkd.mjs

<interfaces>
<!-- Key surfaces the executor will touch. Already in the codebase. -->

From src/bot/brain/orchestrator.js (existing, will be modified):
```js
// Line ~542 — REMOVE the LONG_RUNNERS set; replace with INLINE_METADATA.
const LONG_RUNNERS = new Set(['goTo', 'gather', 'dig', 'build', 'attackEntity'])
function isLongRunner(name, _args) { return LONG_RUNNERS.has(name) }

// Line ~570 — runWithInflightAwait: KEEP (used by INLINE_METADATA inline branch
// or delete in favor of inline inflight.start/end). Per CONTEXT.md Claude's
// Discretion: prefer delete if no remaining external callers — verify with
// grep first.
async function runWithInflightAwait(name, args, execOpts) { ... }

// Line ~590 — startLongRunner: KEEP unchanged. This becomes the universal
// dispatch path for all non-INLINE_METADATA tools.
function startLongRunner(name, args, execOpts) {
  // returns { promise, abortController, handle, startedAt }
}

// Line ~1042 — handleActionComplete: EXTEND to drain the batched queue.
// Today it fills exactly one result slot and then calls runIterations to do
// one more haiku call. After Task 1 it must:
//   (1) fill the just-completed slot,
//   (2) check loop._pendingToolUses for the next un-dispatched batched
//       tool_use,
//   (3) if any: dispatch that tool_use (via startLongRunner) and RETURN —
//       do NOT call runIterations. The loop stays suspended waiting for
//       the next sei:action_complete.
//   (4) if none: append the now-complete results array (existing path) and
//       call runIterations for the next haiku turn (existing path).
// pendingInterrupt-fold path at orchestrator.js:1076–1081 stays exactly as is —
// it folds the PLAYER INTERRUPT into the appendToolResults call when ALL
// remaining batched slots are abandoned, which happens in the abort path
// below.

// Line ~1424 — the existing isLongRunner-true branch (NON-BLOCKING dispatch
// via startLongRunner). This becomes the dispatch site for sync tools too.

// Line ~1517–1536 — the existing isLongRunner-false branch (synchronous
// dispatch via runWithInflightAwait). REMOVE for non-INLINE_METADATA tools.
//
// Pre-batch dispatch ordering: the for-loop at line 1320 today fills sync
// results inline, then dispatches the first long-runner and returns. After
// Task 1, the for-loop's responsibility shrinks: handle INLINE_METADATA
// inline (setGoals/noteToSelf/stop fill their result slots and continue),
// dispatch the FIRST non-inline tool via startLongRunner, stash REMAINING
// non-inline tool_uses in loop._pendingToolUses, and return. handleActionComplete
// drains _pendingToolUses one-at-a-time on each sei:action_complete.
```

From src/bot/brain/inflight.js (existing, no API changes required):
```js
// Public API stable. snapshot's `in_flight:` line is rendered by
// getInFlightLineForSnapshot(tracker.current()). Sync tools going through
// startLongRunner naturally populate this via inflight.start({name, args}).
//
// describeArgs already handles the arg-blurb for sync-tool inputs
// (block name from placeBlock, item from equip, etc.) — no change needed.
```

From src/bot/brain/orchestrator.js (cancel dispatcher — verify unchanged):
```js
// Line ~1253 — case-2 (stop): aborts loop.inFlight.abortController.
//   After Task 1, loop.inFlight may be a SYNC tool's runner — the abort
//   call still works identically (AbortController is universal).
// Line ~1264 — case-3 (new long-runner mid-continuation):
//   Same abort path. case-3 fire (P0/P1 trigger) re-enqueues the trigger
//   event; case-3 suppress (non-P0/P1 trigger) falls through to dispatch
//   the new tool. Both paths are agnostic to whether the prior inflight
//   was sync or async.
//
// Task 1's verify step must include an automated harness assertion that
// case-2 + sync-inflight and case-3 + sync-inflight both abort cleanly
// (no code change to those branches, but live regression risk if
// loop.inFlight shape changes).
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Replace LONG_RUNNERS with INLINE_METADATA and route all world-touching tools through startLongRunner; extend handleActionComplete to serialize batched tool_uses without an extra haiku call</name>
  <files>src/bot/brain/orchestrator.js</files>
  <action>
This is the core rewrite. Per CONTEXT.md Decision 1 (Option B locked) and Decision 3 (Option A locked).

**1. Classification surface (orchestrator.js line ~537–545).**
Delete `LONG_RUNNERS` and `isLongRunner`. Replace with:

```js
// 260514-gam D1: every world-touching tool dispatches non-blocking via
// startLongRunner. Only pure-metadata tools stay inline.
const INLINE_METADATA = new Set(['setGoals', 'noteToSelf', 'stop'])
function isInlineMetadata(name) { return INLINE_METADATA.has(name) }
```

Grep the file for `isLongRunner(` and `LONG_RUNNERS` — there are call sites in the case-3 dispatch at line ~1241 (`newLongRunners = toolUses.filter(u => isLongRunner(u.name, u.input))`) and at line ~1424 (the dispatch-branch selector). Both must be rewritten:

- case-3 detection (line ~1241): now `const newSuspendingTools = toolUses.filter(u => !isInlineMetadata(u.name))`. Per CONTEXT.md Decision 1, every non-inline tool now suspends the loop, so case-3's "new long-running tool present" predicate naturally extends to every world-touching tool. Update the local variable name (`newSuspendingTools`) and the debug logs (`cancel-case=3 …`) to match. Preserve the existing `triggerIsP0P1` gate, the `isContinuation` gate, and both the fire / suppress branches — only the predicate changes.
- dispatch-branch selector (line ~1424): `} else if (isLongRunner(u.name, u.input)) {` becomes `} else if (!isInlineMetadata(u.name)) {`. The inline branch at line 1517–1536 is now dead for every non-metadata tool — remove the entire `else { /* synchronous tools */ }` arm and delete the `runWithInflightAwait` call site there.

**2. Batched-queue stash on first dispatch (orchestrator.js line ~1320–1538).**
The per-tool for-loop must fill INLINE_METADATA slots inline, then on the FIRST non-inline tool: dispatch via `startLongRunner`, set `loop.inFlight` + `loop._pendingActionUse` + `loop._pendingResults` (existing), and ALSO stash the remaining unprocessed batched tool_uses for handleActionComplete to drain:

```js
// After dispatching tool_uses[i] via startLongRunner, before `return`:
loop._pendingToolUses = toolUses.slice(i + 1).map((u, k) => ({
  index: i + 1 + k,           // original slot in results[]
  use: u,                      // {id, name, input}
}))
```

Subsequent non-inline tools in the same batch are NOT dispatched yet — handleActionComplete drains them one-at-a-time on each `sei:action_complete`.

Edge: INLINE_METADATA tool_uses appearing AFTER a non-inline tool_use in the same batch (e.g. `[placeBlock, noteToSelf, placeBlock]`) must still be processed inline before the queue stash so their tool_results are filled. The for-loop already runs in order; the change is only that the `return` after `startLongRunner` happens at the FIRST non-inline tool, and `_pendingToolUses` carries the rest (mixed inline + non-inline). handleActionComplete's queue-drain logic (below) handles inline entries by filling their slot inline and continuing to the next queue entry without dispatching.

**3. handleActionComplete queue-drain (orchestrator.js line ~1042–1131).**
After filling the just-completed slot (existing line 1058–1066), before the `appendToolResults` call at line 1091, check `loop._pendingToolUses`:

```js
// 260514-gam D3: drain the batched queue. If any pending tool_use remains,
// dispatch the next NON-INLINE one (filling inline slots inline along the
// way) and return without calling runIterations — one haiku per logical turn,
// not per tool.
const queue = loop._pendingToolUses
if (queue && queue.length > 0) {
  // PLAYER INTERRUPT abandon path: if pendingInterrupt was just folded
  // (extraEventText set), synthesize aborted results for the remaining
  // batch and fall through to appendToolResults so the PLAYER INTERRUPT
  // turn renders once.
  if (extraEventText) {
    for (const { index, use } of queue) {
      pendingResults[index] = {
        type: 'tool_result',
        tool_use_id: use.id,
        content: 'aborted: player interrupt',
        is_error: false,
      }
    }
    loop._pendingToolUses = null
    // Fall through to the existing appendToolResults call below.
  } else {
    // Process inline-metadata entries inline; on the first non-inline
    // entry, dispatch via startLongRunner and return.
    while (queue.length > 0) {
      const { index, use } = queue.shift()
      if (isInlineMetadata(use.name)) {
        // Re-use the same inline handling the for-loop applies. Factor
        // the setGoals/noteToSelf/stop result-fill into a small helper
        // `executeInlineMetadata(loop, use, results, lastActionRef)` that
        // returns the filled result; call it here and write into
        // pendingResults[index]. (Avoid duplicating the inline arms.)
        const r = await executeInlineMetadata(loop, use)
        pendingResults[index] = r.result
        continue
      }
      // Non-inline: dispatch and return; loop stays suspended.
      const runner = startLongRunner(use.name, use.input, { ...config, _goalStore: goals })
      const inflightEntry = {
        name: use.name, input: use.input,
        promise: runner.promise, abortController: runner.abortController,
        handle: runner.handle, startedAt: runner.startedAt,
        tool_use_id: use.id,
      }
      loop.inFlight = inflightEntry
      loop._pendingActionUse = { id: use.id, name: use.name, input: use.input }
      loop._pendingResults = pendingResults
      loop._pendingByteWarn = byteWarn
      loop._pendingToolUses = queue   // remaining entries
      // Re-attach the SAME settle handler used at the first dispatch (line
      // ~1477–1512). Factor it into a small helper `attachSettleHandler(loop, runner, use)`
      // and call it from both sites so there is exactly one implementation.
      attachSettleHandler(loop, runner, use)
      return  // loop suspended; next sei:action_complete drains the next entry
    }
    // Queue drained to empty without dispatching a new in_flight (all
    // remaining were inline metadata). Fall through to appendToolResults.
    loop._pendingToolUses = null
  }
}
```

Notes:
- Factor `executeInlineMetadata` and `attachSettleHandler` as local helpers so both the original for-loop and handleActionComplete call the same code.
- The case-2 stop / case-3 reseed paths in the cancel dispatcher are NOT invoked here — they only fire on the NEXT haiku response. The queue-drain happens BEFORE the next haiku call, so a queued `stop` tool_use that the model emitted alongside e.g. `placeBlock` flows through the inline-metadata branch above (its result is filled with `'stopped'`, no abort fires) and then `appendToolResults` + the next haiku call sees `stop` in the just-completed assistant turn and applies case-2 normally. (Concretely: a model batch of `[placeBlock, stop]` dispatches placeBlock, completes, the queue holds `[stop]`, the drain fills stop's slot inline, the array is appended to history, the next haiku iteration sees the assistant turn it emitted on the original call and applies cancel semantics — which in this case is "no in_flight left to abort because placeBlock already settled, terminate the loop". This matches the existing behavior; verify in the automated harness.)
- pendingInterrupt-fold path at the existing line 1076–1081: stays exactly as written. When a sync inflight aborts mid-batch (chat arrived), `data.aborted === true` and `pendingInterrupt !== null` → extraEventText is set. The new queue-drain block above sees `extraEventText` and synthesizes aborted placeholders for all remaining queue entries (mirrors the existing 1560–1568 synthesis), then falls through to the SAME `appendToolResults` call at 1091 — PLAYER INTERRUPT renders once, all results paired correctly.

**4. setGoals back-compat call site (orchestrator.js line ~1374).**
Today the setGoals arm calls `runWithInflight` (the alias at line 608). After this task, INLINE_METADATA tools no longer need `inflight.start/end` at all (they're invisible to `in_flight:` snapshot — pure metadata). Replace with a direct `await registry.execute('setGoals', u.input, null, { ...config, _goalStore: goals })`. Same for `noteToSelf` (already direct via affectLog) and `stop` (already inline result-only). Then delete `runWithInflightAwait` and the `runWithInflight` alias entirely — grep first to confirm no remaining callers.

**5. Debug breadcrumbs.**
Add log lines mirroring existing long-runner breadcrumbs:
- `logger.debug?.([sei/orch] dispatch suspend tool=${use.name} batch_remaining=${queue.length})` at startLongRunner sites
- `logger.debug?.([sei/orch] action_complete drain inline=${use.name})` for inline queue entries
- `logger.debug?.([sei/orch] action_complete drain dispatch tool=${use.name} remaining=${queue.length})` for next-in-batch dispatch

This is the CONTEXT.md "yes, mirror the existing long-runner debug breadcrumbs" item under Claude's Discretion.

**6. Single source of truth invariant.**
After the rewrite there must be exactly one classifier (`isInlineMetadata`) and exactly one dispatch path for non-inline tools (`startLongRunner`). Add a top-of-file comment block (mirroring the 260513-wkd one at line ~537) explaining the new model. Grep the file for `LONG_RUNNERS`, `isLongRunner`, `runWithInflightAwait`, `runWithInflight` — must all be gone after this task.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && grep -nE '\b(LONG_RUNNERS|isLongRunner|runWithInflightAwait|runWithInflight)\b' src/bot/brain/orchestrator.js ; echo "EXIT=$?"</automated>
    <!-- Expected: EXIT=1 (grep finds no matches). If any of the four tokens remain, the rewrite is incomplete. -->
    <automated>cd /Users/ouen/slop/sei && node -e "import('./src/bot/brain/orchestrator.js').then(m => { console.log('ok, exports:', Object.keys(m)) }).catch(e => { console.error('FAIL', e.message); process.exit(1) })"</automated>
    <!-- Expected: module loads without syntax errors. -->
  </verify>
  <done>
- `LONG_RUNNERS`, `isLongRunner`, `runWithInflightAwait`, `runWithInflight` all gone from orchestrator.js (grep returns 0 matches).
- `INLINE_METADATA = new Set(['setGoals', 'noteToSelf', 'stop'])` is the single classification function.
- All non-inline tools (placeBlock, equip, find, lookAt, dropItem, activateItem, sleep, openContainer, depositItem, withdrawItem, consumeItem, follow, unfollow, goTo, gather, dig, build, attackEntity) dispatch via `startLongRunner` exactly.
- `handleActionComplete` drains `loop._pendingToolUses`: inline entries fill inline, non-inline entries dispatch via `startLongRunner` and return without calling runIterations.
- pendingInterrupt-fold path (line ~1076) abandons remaining queue with `'aborted: player interrupt'` placeholders and falls through to existing `appendToolResults`.
- case-2 / case-3 dispatcher unchanged structurally (only the `isLongRunner` predicate renamed to `!isInlineMetadata`).
- Module loads cleanly (`node -e "import('./src/bot/brain/orchestrator.js')"` exits 0).
- One atomic commit: `feat(260514-gam): universalize non-blocking inflight for world-touching tools`.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add automated harness scripts/verify-260514-gam.mjs covering batched-serialization, sync-tool suspend/resume, sync-tool chat preempt, case-2/case-3 with sync inflight</name>
  <files>scripts/verify-260514-gam.mjs</files>
  <action>
Create a new harness modeled on `scripts/verify-260513-wkd.mjs` (523 lines, 13/13 PASS today). The harness uses the same in-memory FSM + brain bootstrap pattern (no live mineflayer) and asserts on the orchestrator's observable behavior: which `reenqueue` events fire and in what order, what shows up in `loop.history`, when `loop.inFlight` is set/cleared, when `_pendingToolUses` is populated/drained.

**Required test cases (one assertion block each, all must PASS):**

- **G1 — Batched non-inline serialization, natural completion.** Model emits `[placeBlock(a), placeBlock(b), placeBlock(c)]`. Stub registry resolves each in ~10ms. Assert: (a) exactly ONE haiku call fires after the batch (not 3); (b) `sei:action_complete` fires 3 times in order a→b→c; (c) `loop.history` ends with a single assistant turn (the batch) followed by a single tool_result turn carrying 3 results in the same order; (d) `loop.inFlight` is null at terminal.

- **G2 — Batched non-inline + mid-batch chat preempt.** Model emits `[placeBlock(a), placeBlock(b), placeBlock(c)]`. Stub a resolves; before b completes, fire `owner_chat` with text "stop now". Assert: (a) `loop.inFlight.abortController.abort()` fires once; (b) `sei:action_complete` for b carries `aborted:true`; (c) `_pendingToolUses` for c is drained to `'aborted: player interrupt'`; (d) the next haiku call's user turn carries `PLAYER INTERRUPT: stop now`; (e) all 3 results paired in history.

- **G3 — Single sync action (e.g. equip) suspend/resume, no chat.** Model emits `[equip(stone_pickaxe)]`. Stub resolves in ~50ms. Assert: (a) `loop.inFlight.name === 'equip'` during the suspend window; (b) `getInFlightLineForSnapshot(tracker.current())` returns a non-empty string starting with `in_flight: equip(`; (c) on settle, exactly one `sei:action_complete` fires, then exactly one haiku call.

- **G4 — Single sync action + chat in the <500ms suspend window.** Model emits `[find(cactus)]`. Before the find stub resolves, fire `owner_chat` "wait here". Assert: (a) abort fires within one signal tick; (b) `sei:action_complete` carries `aborted:true`; (c) `pendingInterrupt` is non-null when action_complete arrives; (d) extraEventText `PLAYER INTERRUPT: wait here` folds into the next user turn; (e) exactly ONE PLAYER INTERRUPT iteration runs.

- **G5 — case-2 (stop) fired while sync inflight running.** Iteration 1: model emits `[placeBlock(a)]`. Iteration 2 (after action_complete continuation): model emits `[stop]`. Assert: stop tool fires; loop terminates with `isTerminal=true`. Variant G5b: Iteration 2 model emits `[stop]` WHILE iteration 1's placeBlock is still resolving (race) — this is exercised by firing `sei:action_complete` AFTER the case-2 path has flagged terminal. Assert loop.inFlight.abortController.abort was called from the cancel dispatcher; loop terminates cleanly.

- **G6 — case-3 reseed (P1 trigger) with sync inflight.** Trigger event is `owner_chat` "place a block then come back". Iteration 1 dispatches `placeBlock`. On action_complete continuation (iteration 2), model emits `[goTo(x,y,z)]`. Assert: case-3 fire path runs (`triggerIsP0P1=true`); `loop.inFlight.abortController.abort` is called (no-op if already settled); current loop terminates; `reenqueue('owner_chat', ...)` re-fires the trigger event; the new loop opens with the original chat text as the seed.

- **G7 — Mixed batch: `[noteToSelf, placeBlock, setGoals]`.** Assert: noteToSelf fills slot 0 inline (synchronously, no inflight); placeBlock dispatches and suspends; on action_complete, the queue contains setGoals which fills inline; THEN appendToolResults fires + one haiku call. (Verifies the in-order inline-then-suspend-then-drain-inline ordering.)

- **G8 — Regression guard: setGoals / noteToSelf / stop never set `loop.inFlight` and never fire `sei:action_complete`.** Model emits `[setGoals(...), noteToSelf(...), stop]`. Assert: zero `sei:action_complete` events fire across the entire batch; `loop.inFlight` is never set; loop terminates from `stop`.

- **G9 — Regression: existing 260513-wkd harness still PASSes.** The new harness optionally execs `node scripts/verify-260513-wkd.mjs` as a child process and asserts its exit code is 0, or the task's verify step runs both harnesses in sequence (preferred — keeps each harness self-contained). Documentation only inside this harness; the run-both is in the verify step below.

**Harness shape (mirror verify-260513-wkd.mjs):**
- Module-level `const cases = []` collecting `{ name, fn }` objects.
- `case('G1 …', async () => { … assertions … })` helper.
- Bootstrap the brain with stub config, stub adapter (chat = noop, closeAnySessions = noop, registry stubs with delayed resolves), stub anthropicClient that returns canned tool_uses per iteration.
- At the end: `let pass=0,fail=0; for (const c of cases) { try { await c.fn(); pass++; console.log('✓', c.name) } catch (e) { fail++; console.error('✗', c.name, e.message) } } process.exit(fail ? 1 : 0)`.

Use the same private-API access patterns 260513-wkd uses (no exports added to orchestrator.js for testing).
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && node scripts/verify-260514-gam.mjs</automated>
    <!-- Expected: all 8 cases PASS (G1–G8), exit code 0. -->
    <automated>cd /Users/ouen/slop/sei && node scripts/verify-260513-wkd.mjs</automated>
    <!-- Expected: existing 13/13 still PASS, exit code 0. Regression guard on Task 1. -->
  </verify>
  <done>
- scripts/verify-260514-gam.mjs exists, 8 cases (G1–G8) all PASS, exit 0.
- scripts/verify-260513-wkd.mjs still 13/13 PASS, exit 0 (regression guard).
- Harness asserts cover: batched serialization (one haiku per turn not per tool), mid-batch chat preempt, sync-tool suspend/resume, sync-tool chat-in-window race, case-2 with sync inflight, case-3 reseed with sync inflight, mixed inline+suspend batch ordering, INLINE_METADATA stays inline.
- One atomic commit: `test(260514-gam): add automated harness for universal inflight + batched serialization`.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Live in-game verification scenarios 1–6 (developer-run, non-negotiable per CONTEXT.md "Specifics")</name>
  <what-built>
Tasks 1 + 2 land: orchestrator universalized to non-blocking inflight for all world-touching tools; batched tool_uses serialize within the same loop via action_complete (one haiku per logical turn); automated harness PASSes (G1–G8) + 260513-wkd regression PASSes. The case-2/case-3 abort paths are structurally unchanged — they touch `loop.inFlight.abortController` which is now universal.

The automated harness cannot exercise live mineflayer's 4s internal placeBlock timeout, real Anthropic streaming latency, or actual in-game chat plumbing. Per CONTEXT.md Specifics, scenarios 1–6 require an in-game session.
  </what-built>
  <how-to-verify>
Each scenario below MUST PASS before declaring the task complete. Report results inline in the SUMMARY.md.

**Scenario 1 — 5-placeBlock batch + mid-batch chat preempt (THE bug):**
1. Start the bot, summon, owner near.
2. Prompt: "place 5 cactus blocks in a row" (or any prompt that causes a ≥3-tool placeBlock batch). At least two of those placeBlock calls must fail or time-out (4s mineflayer timeout) so we exercise the worst-case duration — easy repro: target a spot the bot can't reach or doesn't have the block for.
3. ~1s into the batch, send chat "stop".
4. **Assert:** PLAYER INTERRUPT folds within <500ms of the chat (timestamp the chat in the in-game log, timestamp the bot's `[sei/orch] action_complete + PLAYER INTERRUPT folded` log line). Was 16–28s before this task; must now be <500ms (one signal tick).

**Scenario 2 — 5-placeBlock batch, natural completion of all 5, no chat:**
1. Prompt that yields a 5-placeBlock batch all of which can succeed.
2. Wait for the bot to finish.
3. **Assert:** all 5 blocks placed correctly in the world. Inspect the brain log: exactly ONE `[anthropic] call` line fires AFTER the batch (not 5). Loop history shows one assistant turn with 5 tool_uses, one tool_result turn with 5 paired results, then one final haiku call for the post-batch narration / terminal.

**Scenario 3 — Single sync action + chat arriving in the <500ms window between dispatch and settle:**
1. Prompt: "find a cactus" (`find` is sync but goes through startLongRunner now).
2. As soon as the bot dispatches find, send chat "wait, where are you?".
3. **Assert:** exactly ONE PLAYER INTERRUPT iteration runs (one user turn carrying `PLAYER INTERRUPT: wait, where are you?`); the bot replies in chat; no double-fold of the interrupt; no orphan tool_uses in the log.

**Scenario 4 — Single sync action + no chat, completes normally:**
1. Prompt: "equip your stone pickaxe".
2. **Assert:** behavior unchanged from today — bot equips the item, exactly one `in_flight: equip(...) started=...s ago` snapshot line appears between dispatch and settle (look in the diary or render snapshot via debug). Then a single follow-up haiku call narrates. No regression vs. the prior inline path.

**Scenario 5 — case-2 `stop` tool fired while a sync tool is in flight:**
1. Force a slow sync inflight: prompt "open the chest at <coords>" (`openContainer`) or "drop 10 dirt" (`dropItem` in a loop).
2. While the sync tool is mid-flight, send a follow-up chat that strongly implies the bot should stop (e.g. "actually never mind, just hold there"). The model should emit `[stop]`.
3. **Assert:** `[sei/orch] cancel-case=2 stop tool — aborting in_flight <name>` log line appears; loop terminates; bot remains in place (no continuation iteration); the in-flight tool's settle log shows `aborted=true`.

**Scenario 6 — case-3 reseed (new long-runner emitted while sync tool is in flight, P1 trigger):**
1. Trigger: owner chat "open the chest then come back" (sync tool `openContainer` first).
2. While `openContainer` is in flight, send chat "actually let's go find food instead".
3. The model should emit `[goTo(...) or find(food)]` on the continuation.
4. **Assert:** `[sei/orch] cancel-case=3 fire trigger=owner_chat …` log line; current loop terminates; a fresh loop opens with the original chat ("open the chest then come back") OR the new chat as trigger — verify the trigger event matches the implementation choice (per CONTEXT.md Decision 2, both orderings flow through the same fold join point — note in SUMMARY.md which trigger event reseeded).

**Regression scenarios (must also PASS):**
- 260513-wkd live scenarios 1–5 from that SUMMARY (cactus + question, "we have enough" stop, "switch to food" mid-gather, P0 zombie mid-gather, baseline no-interrupt). They exercise the existing long-runner paths which must not regress. A spot-check on at least 2 (cactus + question, P0 zombie) is sufficient.

Type "approved: scenarios 1–6 PASS" or describe failures with timestamps + log excerpts.
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues</resume-signal>
</task>

</tasks>

<verification>
**Automated (CI-runnable):**
1. `cd /Users/ouen/slop/sei && grep -nE '\b(LONG_RUNNERS|isLongRunner|runWithInflightAwait|runWithInflight)\b' src/bot/brain/orchestrator.js` returns no matches (exit 1).
2. `cd /Users/ouen/slop/sei && node scripts/verify-260514-gam.mjs` PASSes 8/8 (G1–G8).
3. `cd /Users/ouen/slop/sei && node scripts/verify-260513-wkd.mjs` PASSes 13/13 (regression).
4. `cd /Users/ouen/slop/sei && node -e "import('./src/bot/brain/orchestrator.js').then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"` exits 0.

**Live (developer-run, BLOCKING):** Scenarios 1–6 above. PLAYER INTERRUPT latency for a 5-placeBlock batch must drop from 16–28s observed pre-task to <500ms post-task. Document timestamps in SUMMARY.md.
</verification>

<success_criteria>
- `LONG_RUNNERS` set and `isLongRunner` function are GONE; `INLINE_METADATA = {setGoals, noteToSelf, stop}` is the single classifier.
- `runWithInflightAwait` and `runWithInflight` alias are deleted (no remaining callers).
- All non-INLINE_METADATA tools dispatch via `startLongRunner` (sync + async alike); the loop suspends and resumes on `sei:action_complete`.
- Batched tool_uses serialize within the same loop via `loop._pendingToolUses` queue drained in `handleActionComplete`; exactly one haiku call fires per logical turn (not per tool).
- Mid-batch chat preempt aborts the current in_flight within one signal tick and folds PLAYER INTERRUPT via the existing line-~1076 path (Decision 2: no new dedup machinery).
- case-2 (stop) and case-3 (reseed) cancel branches verified unchanged structurally; they correctly abort sync-tool inflights because they only touch `loop.inFlight.abortController` (now universal).
- Automated harness `scripts/verify-260514-gam.mjs` PASSes 8/8 (G1–G8).
- Regression harness `scripts/verify-260513-wkd.mjs` PASSes 13/13.
- Live in-game scenarios 1–6 PASS; SUMMARY.md records timestamps showing PLAYER INTERRUPT latency dropped from ~16–28s to <500ms for the 5-placeBlock case.
- Three atomic commits: (1) Task 1 feat, (2) Task 2 test, (3) Task 3 SUMMARY/checkpoint + any live-verification follow-ups.
</success_criteria>

<output>
After completion, create `.planning/quick/260514-gam-replace-longrunner-only-async-inflight-a/260514-gam-SUMMARY.md` recording:
- Final orchestrator.js diff summary (file sections touched, ~LOC delta).
- Harness results: G1–G8 individually, plus 260513-wkd 13/13 regression PASS.
- Live scenario 1–6 results with timestamps (chat-sent → PLAYER-INTERRUPT-folded latency for the 5-placeBlock case).
- Confirmation that `LONG_RUNNERS`, `isLongRunner`, `runWithInflightAwait`, `runWithInflight` are all gone.
- Confirmation that case-2 / case-3 dispatcher needed only the `isLongRunner → !isInlineMetadata` predicate rename (no structural change).
- Note that owner-position-in-snapshot remains deferred to a separate quick task (CONTEXT.md Decision 4).
</output>
