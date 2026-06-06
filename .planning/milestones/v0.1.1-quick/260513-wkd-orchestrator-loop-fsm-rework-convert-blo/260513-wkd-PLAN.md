---
phase: 260513-wkd
plan: 01
type: execute
wave: 1
depends_on: []
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
  - scripts/verify-260513-wkd.mjs
autonomous: true
requirements:
  - WKD-CANCEL-SEMANTICS    # 3 intents per CONTEXT.md decisions table
  - WKD-SIGNAL-THREADING    # AbortSignal through every long-runner
  - WKD-FSM-EVENT-LOOP      # P2_ACTION_COMPLETE + non-blocking dispatch
  - WKD-STOP-TOOL           # new personality tool, terminal-only
  - WKD-SNAPSHOT-INFLIGHT   # `in_flight:` line with started=Xs ago + gather progress
  - WKD-INTERRUPT-SPEAK     # persona addendum: always-speak-on-P0/P1

must_haves:
  truths:
    - "When the model emits goTo/gather/dig-cuboid/build-cuboid/attackEntity (multi-swing), handleDispatch returns before that action completes — the orchestrator no longer holds the FSM."
    - "While in_flight is running, owner chat (P1) arriving in the FSM aborts the in_flight body within one signal tick AND triggers a fresh mid-loop iteration with the new event injected as a user turn; attack (P0) retains its existing pendingAttack + eventAddendum reseed path (abort current loop, refire as fresh dispatch with verbal-first policy)."
    - "On in_flight completion (resolve or abort), the orchestrator's listener re-enqueues a `sei:action_complete` (P2 priority, distinct tier from P2_MOVEMENT) carrying `{name, input, result, aborted}`; the next handleDispatch call appends a tool_result + snapshot turn and asks Haiku for the next step."
    - "When Haiku responds mid-loop with text only and no tool_use, the loop stays alive (case 1: continue waiting); when Haiku responds with `stop`, the loop terminates AND the in_flight is aborted (case 2); when Haiku responds with another long-running tool, the current loop terminates and a fresh loop is seeded with the model's response folded into history (case 3 — only fires when current loop's trigger was P0 or P1)."
    - "Every long-running behavior (pathfind, gather, cuboid dig, cuboid build, multi-swing attack) checks `config.signal` and, on abort, returns a distinct structured result with `aborted: true` and partial-progress text the LLM can read."
    - "The mid-iteration snapshot includes `in_flight: <name>(<argblurb>) started=<X.X>s ago[ — <completed>/<total>[, y=<currentY>]]`; gather contributes `dug K/N` via the existing `runWithInflight` onProgress channel (same surface as build/dig)."
    - "A node-only verify script `scripts/verify-260513-wkd.mjs` drives the orchestrator with a mock anthropic + fake long-runner and asserts case 1/2/3 sequencing, abort delivery, P2_ACTION_COMPLETE-before-P2_MOVEMENT ordering, and `sei:action_complete` re-enqueue."

  artifacts:
    - path: "src/bot/adapter/minecraft/behaviors/pathfind.js"
      provides: "goTo with optional signal arg; new 'aborted' PathfindResult variant"
      contains: "signal"
    - path: "src/bot/brain/fsm.js"
      provides: "Priority.P2_ACTION_COMPLETE = 2.1 constant (between P2_MOVEMENT=2 and P2_5_LOOP_END=2.5)"
      contains: "P2_ACTION_COMPLETE"
    - path: "src/bot/brain/index.js"
      provides: "reenqueue switch routes 'sei:action_complete' at Priority.P2_ACTION_COMPLETE"
      contains: "sei:action_complete"
    - path: "src/bot/brain/inflight.js"
      provides: "getInFlightLineForSnapshot helper (started=Xs ago + em-dash separator + completed/total + optional y=<currentY>)"
      contains: "getInFlightLineForSnapshot"
    - path: "src/bot/brain/orchestrator.js"
      provides: "FSM-event-driven loop: non-blocking handleDispatch, stop tool in personalityTools, PERSONALITY_NAMES includes 'stop', system-prompt always-speak-on-interrupt clause, mid-loop cancel-semantics dispatch, runWithInflight passes onProgress for gather (same channel as cuboid)"
      contains: "stop"
    - path: "scripts/verify-260513-wkd.mjs"
      provides: "test harness for the three cancel cases + abort delivery + priority-tier ordering"
      contains: "case 1"
  key_links:
    - from: "src/bot/brain/orchestrator.js:runWithInflight"
      to: "src/bot/brain/fsm.js (via reenqueue)"
      via: "on promise settle, reenqueue('sei:action_complete', {name, input, result, aborted})"
      pattern: "sei:action_complete"
    - from: "src/bot/adapter/minecraft/registry.js (goTo handler)"
      to: "src/bot/adapter/minecraft/behaviors/pathfind.js:goTo"
      via: "pass config.signal as 6th arg"
      pattern: "config\\?\\.signal"
    - from: "src/bot/brain/orchestrator.js:handleDispatch (in_flight branch)"
      to: "src/bot/brain/orchestrator.js (cancel-semantics dispatcher)"
      via: "on P2_ACTION_COMPLETE -> append tool_result; on P1 with in_flight -> abort body, inject event user turn, call Haiku, branch on stop vs new long-running tool vs text-only; P0 sei:attacked retains pendingAttack reseed path"
      pattern: "PERSONALITY_NAMES.has\\('stop'\\)"
    - from: "src/bot/adapter/minecraft/observers/snapshot.js"
      to: "src/bot/brain/inflight.js:getInFlightLineForSnapshot"
      via: "snapshot composer calls helper to render the in_flight: line (preserves em-dash and y=<currentY> from Phase 7 D-10)"
      pattern: "started="
    - from: "src/bot/brain/orchestrator.js:runWithInflight"
      to: "src/bot/adapter/minecraft/behaviors/mineVein.js"
      via: "for name==='gather', pass onProgress=(p) => inflight.updateProgress(handle, p); mineVein calls config.onProgress?.({dug, total}) — same surface as cuboid build/dig"
      pattern: "onProgress"
---

<objective>
Convert the orchestrator's iteration loop from blocking-await into an
FSM-event-driven loop. Long-running actions dispatch in the background;
the next iteration is triggered by whichever event arrives first
(`sei:action_complete` at P2.1, or owner chat at P1, or attack at P0).
Thread `AbortSignal` through every long-running behavior so body-level
abort actually halts work. Add a `stop` personality tool so the model
has an unambiguous "task done, hold position, abandon in_flight" signal.
Enrich the mid-flight snapshot with `in_flight: <name>(<argblurb>) started=Xs ago`
plus per-behavior progress where available (preserving the Phase 7 D-10
em-dash + completed/total + optional y=<currentY> channels the cuboid
prompt already consumes).

Purpose: today, while `pathfinder.goto` / `gatherAction` / cuboid dig/build
runs inside the FSM's `await onDispatch`, the priority queue cannot dequeue
P0/P1 events. They park behind the long action's wall-clock timeout. The
cancel branch at fsm.js:119 is effectively dead code while any long action
runs. This rework makes the documented "single outstanding action token
with AbortController" contract actually hold.

Output: a non-blocking dispatch path, six behaviors that respect signal,
one new `stop` tool, an enriched in_flight snapshot line, and a node-only
verify harness asserting case 1/2/3 cancel semantics.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-CONTEXT.md
@CLAUDE.md

@src/bot/brain/orchestrator.js
@src/bot/brain/fsm.js
@src/bot/brain/index.js
@src/bot/brain/inflight.js
@src/bot/adapter/minecraft/behaviors/pathfind.js
@src/bot/adapter/minecraft/behaviors/mineVein.js
@src/bot/adapter/minecraft/behaviors/dig.js
@src/bot/adapter/minecraft/behaviors/build.js
@src/bot/adapter/minecraft/behaviors/attack.js
@src/bot/adapter/minecraft/behaviors/follow.js
@src/bot/adapter/minecraft/registry.js
@src/bot/adapter/minecraft/observers/snapshot.js

<interfaces>
<!-- Pre-existing contracts the executor needs. Use these directly — no need to re-explore. -->

// fsm.js — Priority constants today. Add P2_ACTION_COMPLETE = 2.1, placed
// between P2_MOVEMENT (2) and P2_5_LOOP_END (2.5). Distinct numeric tier
// makes ordering explicit — same-tier FIFO no longer depends on V8 sort
// stability. Sort still routes attacks (P0=0) and chat (P1=1) before any
// P2.x event.
export const Priority = Object.freeze({
  P0_SAFETY: 0,
  P1_CHAT: 1,
  P2_MOVEMENT: 2,
  P2_ACTION_COMPLETE: 2.1,   // NEW — action_complete fires before any same-batch P2_MOVEMENT
  P2_5_LOOP_END: 2.5,
  P3_IDLE: 3,
})

// inflight.js — existing tracker API:
//   start({name, args}) -> handle
//   end(handle)
//   current() -> { id, name, args, startedAt, progress } | null
//   updateProgress(handle, progress)
//   describeArgs(name, args) -> short string
// Helper to ADD: getInFlightLineForSnapshot(entry) -> string
//   "in_flight: <name>(<argblurb>) started=Xs ago[ — <completed>/<total>[, y=<currentY>]]"
// Em-dash and y=<currentY> mirror today's snapshot.js (Phase 7 D-10) byte-stable
// EXCEPT the elapsed trailer changes from `(Xs)` to `started=Xs ago` per CONTEXT.

// orchestrator.js — current shape that must change:
//   PERSONALITY_NAMES = new Set(['setGoals', 'noteToSelf', 'follow', 'unfollow'])
//   handleDispatch(event, data, signal) — single fresh-loop path + interrupt path
//   runIterations(loop, ...) — synchronous while-loop, BLOCKS on tool_use dispatch
//   runWithInflight(name, args, execOpts) — wraps registry.execute with inflight.start/end
//     Already detects `isCuboid` and passes `onProgress: (p) => inflight.updateProgress(handle, p)`.
//     This task EXTENDS the detection to include `name === 'gather'` (same channel; no new config field).
// The rework moves long-runners out of runIterations' inner await and lets
// the FSM drive the next iteration via sei:action_complete.

// orchestrator.js — existing P0 attack path (lines 637-727):
//   sei:attacked while currentLoop runs: stashes `pendingAttack`, aborts the
//   loop, the finally block re-fires the event as a fresh dispatch. The
//   FRESH dispatch seeds a new loop with `eventAddendum` ("React out loud
//   first — short, in-character..."). This rework PRESERVES that path
//   verbatim. The new mid-loop preempt path applies ONLY to owner-chat (P1).

// pathfind.js — current goTo signature:
//   goTo(bot, x, y, z, range = 1, timeoutMs = 12000) -> PathfindResult
//   Result strings today: 'reached' | 'cant_reach (closest=Xm to target X,Y,Z)' | 'timeout' | 'no_bot'
//   Adding: optional `signal` param + 'aborted' result variant.

// registry.js — handler signature passed by createRegistry:
//   handler(args, bot, config) — config already carries `signal` for gather/dig/build/attack;
//   goTo handler does NOT pass signal today; placeBlock/equip/etc don't need it.

// snapshot.js — composer today renders in_flight inline (lines 60-82):
//   `in_flight: <name>[ <argblurb>] (<elapsed>s)[ — <completed>/<total>[, y=<currentY>]]`
//   This is replaced by a single call to getInFlightLineForSnapshot. The em-dash
//   separator and `y=<currentY>` channel are REAL — cuboid prompt consumes them.
//   The ONLY visible delta is `(Xs)` -> `started=Xs ago`.

// index.js — reenqueue switch maps event names to priorities. Add:
//   case 'sei:action_complete': p = Priority.P2_ACTION_COMPLETE; break

// follow abort contract: follow uses `setFollowTarget(null)` as its de-facto
// abort (clearing the target makes the 1 s tick a no-op next iteration).
// This is structurally distinct from signal-based abort used by the other
// long-runners. NO new wiring is required for follow; the abort contract is
// already in place. The plan does NOT claim "signal threading" for follow.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Signal threading + stop tool + FSM constant + snapshot helper (no-op precursor)</name>
  <files>
    src/bot/adapter/minecraft/behaviors/pathfind.js,
    src/bot/adapter/minecraft/behaviors/follow.js,
    src/bot/adapter/minecraft/behaviors/mineVein.js,
    src/bot/adapter/minecraft/registry.js,
    src/bot/brain/inflight.js,
    src/bot/adapter/minecraft/observers/snapshot.js,
    src/bot/brain/fsm.js,
    src/bot/brain/index.js,
    src/bot/brain/orchestrator.js
  </files>
  <action>
Land the structural prerequisites for the orchestrator rewrite. After this
task the bot still runs the OLD await-based loop — these are surface-area
additions that the rewrite in Task 2 will hook into. The intermediate state
must compile, import cleanly, and not regress existing chat/gather/build flows.

1. **pathfind.js** — extend `goTo(bot, x, y, z, range, timeoutMs, signal)`.
   - Add optional 6th param `signal` (default undefined for backward compat).
   - On `signal?.aborted` at entry, return `'aborted'` immediately (do not
     call pathfinder).
   - Wire abort listener inside the navigationPromise: on `signal.abort`,
     call `bot.pathfinder.stop()` and resolve to `'aborted'`. The race with
     timeoutPromise stays as-is; abort wins via its own resolve.
   - Add `ABORTED: 'aborted'` to the exported `PathfindResult` enum.
   - `composeVerticalHint` short-circuits on `'aborted'` (do not append
     "unreachable" hint to aborted results).

2. **registry.js** — goTo handler: pass `config?.signal` through:
   ```js
   return goTo(bot, args.x, args.y, args.z, range, timeoutMs, config?.signal)
   ```
   gather/dig/build/attack handlers ALREADY receive config (and thus signal)
   via the registry's third-arg shape — no change there. Audit grep:
   `grep -n "registry.register" src/bot/adapter/minecraft/registry.js`
   confirms every long-runner uses the `(args, bot, config)` form.

3. **follow.js** — follow's abort contract is `setFollowTarget(null)`, NOT a
   signal. Clearing the target makes the 1 s tick a no-op on its next entry
   (the tick already checks `currentTarget` before doing any work). This
   contract is already in place today — no code change required here.
   Document the contract with a one-line JSDoc on `startFollow`:
   ```js
   /** Abort contract: callers clear the target via `setFollowTarget(null)`;
    *  the 1 s tick is a no-op on the next entry. follow.js does NOT accept
    *  an AbortSignal — its tick is too coarse for signal-level abort to add
    *  value over the existing target-clear path. */
   ```
   Leave `startFollow` signature unchanged. registry.js does not pass signal
   to follow. (CONTEXT.md "Signal threading scope" mentioned follow's 1 s
   tick; the delivered contract is target-clear, which is the equivalent
   abort surface for follow's lifecycle.)

4. **mineVein.js** — use the SAME progress channel as build/dig (cuboid
   actions): the handler already receives `config.onProgress` from
   `runWithInflight` when Task 2 extends the cuboid detection to include
   `name === 'gather'`. Here in Task 1 we just call it (and it's a no-op
   today because runWithInflight only passes onProgress for cuboid):
   ```js
   config?.onProgress?.({ dug, total })
   ```
   Place this call right after `nextEntry.done = true` in the dig loop, and
   once at loop entry after `positions` is built (so the first snapshot shows
   `0/N`). DO NOT invent a new `config.inflight` / `config._inflightHandle`
   channel — the existing `onProgress` surface is the one true progress
   channel for all long-runners. Task 2 wires runWithInflight to pass it.

5. **inflight.js** — add `getInFlightLineForSnapshot(entry, now = Date.now())`
   exported helper. Returns null (or empty string — caller checks falsy) if
   entry is null. Otherwise returns the string the snapshot composer renders
   today, preserving the Phase 7 D-10 em-dash separator AND `y=<currentY>`
   channel, with the elapsed trailer normalized to `started=Xs ago`:
   ```
   in_flight: <name>(<argblurb>) started=<X.X>s ago[ — <completed>/<total>[, y=<currentY>]]
   ```
   Logic (mirror snapshot.js:60-82 exactly except the elapsed trailer):
     - `elapsed = ((now - entry.startedAt) / 1000).toFixed(1)`
     - `argblurb = describeArgs(entry.name, entry.args)` — wrap in `(...)` even when empty? Today snapshot uses a leading space `' ' + blurb` when present; the helper standardizes on `(<argblurb>)` form per CONTEXT.md "in_flight: `<name>(<args>) started=<Xs ago>`". When argblurb is empty, render `<name>()` to keep parser-friendly invariance.
     - `progressSuffix`:
       ```js
       const p = entry.progress
       let suffix = ''
       if (p && typeof p.total === 'number') {
         const completed = (typeof p.placed === 'number') ? p.placed
                         : (typeof p.dug === 'number') ? p.dug
                         : null
         if (completed != null) {
           const yPart = (typeof p.currentY === 'number') ? `, y=${p.currentY}` : ''
           suffix = ` — ${completed}/${p.total}${yPart}`
         }
       }
       ```
     - Final: `\`in_flight: ${entry.name}(${argblurb}) started=${elapsed}s ago${suffix}\``

6. **snapshot.js** — replace the inline `in_flight:` block (composeSnapshot,
   lines 60-82) with a single call to
   `getInFlightLineForSnapshot(inFlight)`. If the helper returns a non-empty
   string, push that line; otherwise skip. Keep the existing `inFlight`
   field on `opts` unchanged. Update the import:
   ```js
   import { getInFlightLineForSnapshot } from '../../../brain/inflight.js'
   ```
   (Verify path with `realpath` from snapshot.js — adjust segments as needed.)
   The em-dash separator AND `y=<currentY>` channel MUST be byte-stable with
   today's output (Phase 7 D-10 cuboid prompt consumes both). The ONLY
   visible delta vs today's snapshot is the elapsed trailer: OLD `(Xs)`,
   NEW `started=Xs ago`. This is the schema change locked by CONTEXT.md
   "Snapshot mid-flight enrichment".

7. **fsm.js** — add `P2_ACTION_COMPLETE: 2.1` to the `Priority` constants
   object. Placed BETWEEN `P2_MOVEMENT: 2` and `P2_5_LOOP_END: 2.5`. The
   distinct numeric tier makes the "action_complete fires before any
   same-batch P2_MOVEMENT" ordering explicit; same-tier FIFO no longer
   depends on V8 sort stability. Sort still routes attacks (P0=0) and chat
   (P1=1) before any P2.x event. Update the leading docstring's priority
   list to mention it. No behavior change in fsm.js itself — the constant
   is consumed by index.js's reenqueue switch.

8. **index.js** — extend the `reenqueue` switch with:
   ```js
   case 'sei:action_complete': p = Priority.P2_ACTION_COMPLETE; break
   ```
   alongside the existing P0/P1/P2/P2.5/P3 routes. Order: put it
   immediately after `sei:loop_terminal`.

9. **orchestrator.js — stop tool registration only (no loop changes yet)**:
   - Add to `personalityTools` array a third entry:
     ```js
     {
       name: 'stop',
       description: "Signal that the current task is done and you intend to hold position. Use ONLY when an in-flight long-running action (gather, dig, build, attack, goTo) should be aborted because the owner just told you to stop or you've decided the task is complete. Pair with a spoken acknowledgement in your text. No args. Returns 'stopped'.",
       input_schema: { type: 'object', properties: {}, additionalProperties: false },
     }
     ```
   - Add `'stop'` to `PERSONALITY_NAMES` set so a `stop`-only response is
     terminal (no follow-up iteration; consistent with setGoals/noteToSelf
     classification). With the old loop, `stop` will simply terminate the
     iteration with `lastActionResult = 'stopped'` and no in_flight abort —
     that's a no-op today (no long-runner is mid-iteration in the OLD loop
     since dispatch awaits to completion). Task 2 wires the abort path.
   - In the tool_use dispatch switch (`runIterations`), handle name === 'stop':
     ```js
     } else if (u.name === 'stop') {
       lastActionResult = 'stopped'
       results[i] = { type: 'tool_result', tool_use_id: u.id, content: 'stopped', is_error: false }
     }
     ```
     (Place this branch alongside the existing setGoals / noteToSelf branches.)
   - Add to `SYSTEM_INSTRUCTIONS` (per CONTEXT.md "Persona / system-prompt
     addendum") a new line BEFORE the existing "Owner messages preempt..."
     line:
     > "When you receive an owner message or take damage mid-action, the
     > snapshot will show `in_flight:` — the body is already doing something.
     > You ALWAYS say something on receipt of owner chat or an attack. Then
     > decide: respond and keep going (text only, the default), or call
     > `stop` to halt the in-flight action and hold, or call a different
     > long-running tool to switch tasks. Don't restate the in-flight
     > action — it's already underway."
     Replace the existing "Owner messages preempt the body and abort the
     in-flight action..." line — it's superseded by the new addendum.

After this task:
  - All long-runners accept signal (pathfind newly; others already did).
    Follow's abort contract remains target-clear (no signal), documented.
  - The `stop` tool exists and is terminal; the system prompt teaches the model
    when to use it.
  - Snapshot renders `started=Xs ago` (replaces `(Xs)`); em-dash separator
    and `y=<currentY>` channel are preserved verbatim.
  - FSM has `P2_ACTION_COMPLETE = 2.1`; index.js routes `sei:action_complete`.
  - mineVein.js calls `config.onProgress?.({dug,total})` (same surface as
    cuboid); no new config channel invented.
  - The loop still BLOCKS on action dispatch — no behavior change for cancel
    semantics yet. Task 2 inverts that.

The intermediate state must compile (`node --check` each file), and the
existing `scripts/verify-phase7.mjs` harness must still pass — its em-dash +
`y=<currentY>` assertions still hold because `getInFlightLineForSnapshot`
preserves both channels (only the elapsed trailer changes — phase7 verify
either ignores it or matches `started=` per its own scope; confirm with a
dry run before committing).
  </action>
  <verify>
    <automated>
node --check src/bot/adapter/minecraft/behaviors/pathfind.js \
 &amp;&amp; node --check src/bot/adapter/minecraft/behaviors/follow.js \
 &amp;&amp; node --check src/bot/adapter/minecraft/behaviors/mineVein.js \
 &amp;&amp; node --check src/bot/adapter/minecraft/registry.js \
 &amp;&amp; node --check src/bot/brain/inflight.js \
 &amp;&amp; node --check src/bot/adapter/minecraft/observers/snapshot.js \
 &amp;&amp; node --check src/bot/brain/fsm.js \
 &amp;&amp; node --check src/bot/brain/index.js \
 &amp;&amp; node --check src/bot/brain/orchestrator.js \
 &amp;&amp; node scripts/verify-phase7.mjs \
 &amp;&amp; node -e "import('./src/bot/brain/inflight.js').then(m =&gt; { const t = m.createInflightTracker(); const h = t.start({name:'build',args:{from:{x:0,y:64,z:0},to:{x:2,y:65,z:2}}}); t.updateProgress(h, {placed:6,total:18,currentY:64}); const line = m.getInFlightLineForSnapshot(t.current(), t.current().startedAt + 1500); if (!/started=1\.5s ago/.test(line)) { console.error('expected started=1.5s ago in:', line); process.exit(1); } if (!/ — 6\/18, y=64/.test(line)) { console.error('expected em-dash + 6/18 + y=64 suffix in:', line); process.exit(1); } console.log('OK build:', line); const h2 = t.start({name:'gather',args:{block:'cactus',n:7}}); t.updateProgress(h2, {dug:2,total:7}); const line2 = m.getInFlightLineForSnapshot(t.current(), t.current().startedAt + 800); if (!/ — 2\/7$/.test(line2)) { console.error('expected em-dash + 2/7 (no y) in:', line2); process.exit(1); } console.log('OK gather:', line2); })" \
 &amp;&amp; node -e "import('./src/bot/brain/fsm.js').then(m =&gt; { if (m.Priority.P2_ACTION_COMPLETE !== 2.1) { console.error('expected P2_ACTION_COMPLETE=2.1, got', m.Priority.P2_ACTION_COMPLETE); process.exit(1); } if (!(m.Priority.P2_MOVEMENT &lt; m.Priority.P2_ACTION_COMPLETE &amp;&amp; m.Priority.P2_ACTION_COMPLETE &lt; m.Priority.P2_5_LOOP_END)) { console.error('expected P2_MOVEMENT &lt; P2_ACTION_COMPLETE &lt; P2_5_LOOP_END'); process.exit(1); } console.log('OK fsm constant ordering'); })" \
 &amp;&amp; grep -q "name: 'stop'" src/bot/brain/orchestrator.js \
 &amp;&amp; grep -q "PERSONALITY_NAMES = new Set(\\[.*'stop'" src/bot/brain/orchestrator.js \
 &amp;&amp; grep -q "config?.signal" src/bot/adapter/minecraft/registry.js \
 &amp;&amp; grep -q "started=" src/bot/brain/inflight.js \
 &amp;&amp; grep -q "config?.onProgress?.(" src/bot/adapter/minecraft/behaviors/mineVein.js \
 &amp;&amp; ! grep -q "config\\?.inflight\\b" src/bot/adapter/minecraft/behaviors/mineVein.js \
 &amp;&amp; ! grep -q "_inflightHandle" src/bot/adapter/minecraft/behaviors/mineVein.js
    </automated>
  </verify>
  <done>
- Every targeted file passes `node --check`.
- `getInFlightLineForSnapshot` renders `started=Xs ago` AND preserves the em-dash separator AND emits `y=<currentY>` when present (verified for both cuboid + gather progress shapes).
- `Priority.P2_ACTION_COMPLETE === 2.1` is exported AND sits between `P2_MOVEMENT` and `P2_5_LOOP_END`.
- The `stop` tool entry is registered in `personalityTools` and listed in `PERSONALITY_NAMES`.
- goTo handler in registry.js passes `config?.signal`.
- mineVein.js uses `config?.onProgress?.(...)` — the SAME channel as build/dig — and does NOT reference any invented `config.inflight` / `_inflightHandle` field.
- follow.js has the documented target-clear abort contract; no signal param added.
- `scripts/verify-phase7.mjs` still PASSes (em-dash + `y=` channels preserved, no regression in cuboid behavior surface).
- Old await-based loop still runs end-to-end on import (no behavior change to runIterations yet).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Non-blocking orchestrator loop + cancel-semantics dispatcher + verify harness</name>
  <files>
    src/bot/brain/orchestrator.js,
    scripts/verify-260513-wkd.mjs
  </files>
  <behavior>
The orchestrator MUST satisfy the following behaviors, asserted by
`scripts/verify-260513-wkd.mjs` (mocks Anthropic + a fake long-running
registry action that resolves only when `config.signal` aborts OR when an
internal `tick()` is called externally):

- **B1 (non-blocking dispatch):** When the model emits a long-running tool
  (e.g. `gather`), `handleDispatch` MUST return before the action's promise
  resolves. Assertion: handleDispatch promise settles within 50 ms of
  invocation even though the fake action holds its own promise pending.

- **B2 (action_complete reenqueue):** When the in_flight action resolves
  naturally, the orchestrator MUST call `reenqueue('sei:action_complete',
  { name, input, result, aborted: false })`. The mocked reenqueue records
  the call; the test asserts shape exactly.

- **B2b (priority-tier ordering):** Synthesize a same-batch arrival of
  `sei:action_complete` AND a `P2_MOVEMENT`-tier event (e.g. mock the
  reenqueue calls). Assert that when both are pending, `sei:action_complete`
  (P2.1) fires AFTER `P2_MOVEMENT` (2) in the queue sort — NO, correction:
  P2.1 > 2, so P2_MOVEMENT fires FIRST when both are pending; document
  this in the harness comment. The point is to prove the numeric ordering
  is explicit (no FIFO stability dependency). Assertion: with two events
  enqueued in arbitrary order, the dequeue order matches `priority asc`.

- **B3 (action_complete drives next iteration):** When `handleDispatch` is
  called with event `'sei:action_complete'` while `currentLoop` exists, the
  orchestrator MUST: (a) append a `tool_result` block carrying `result` to
  history, (b) append a snapshot user turn, (c) call Haiku once, (d) act on
  the response per cancel-semantics table.

- **B4 (case 1 — text only, in_flight running):** Haiku returns text-only.
  The orchestrator MUST NOT abort in_flight; loop stays alive; no
  `sei:action_complete` is synthesized.

- **B5 (case 2 — `stop` tool):** Haiku returns `{text: 'we have enough',
  tools: [{name: 'stop', input: {}}]}`. The orchestrator MUST (a) abort
  the in_flight AbortController, (b) emit text via adapter.chat, (c) flag
  the loop terminal (case 2) — the subsequent in_flight settle MUST NOT
  trigger another iteration (the loop is already terminal; the resolved
  action_complete is dropped or absorbed).

- **B6 (case 3 — new long-running tool):** Haiku returns `{text: '...',
  tools: [{name: 'gather', input: {...}}]}` while a different in_flight
  is running, AND the current loop's `_triggerEvent` is P0 or P1. The
  orchestrator MUST (a) abort the current in_flight, (b) flag the current
  loop terminal, (c) re-enqueue the ORIGINAL triggering event so a fresh
  loop is seeded with the model's mid-loop response folded into
  recent_loop_history. **Case-3 gate (W-2 lock):** if the current loop's
  trigger was NOT P0/P1 (e.g. `sei:idle` or `sei:loop_end`), the
  orchestrator MUST NOT enter case 3 — instead the new long-running tool
  dispatches as the next in_flight of the SAME loop (the old in_flight is
  aborted, the new one starts, the same loop continues). The harness
  asserts both branches.

- **B7a (P1 owner-chat preempt with in_flight running — NEW path):** When
  `handleDispatch` is called with an owner-chat event while `inFlight` is
  running, the orchestrator MUST abort the in_flight AND inject a PLAYER
  INTERRUPT user turn AND call Haiku within the SAME loop. The response is
  dispatched per cancel-semantics (cases 1/2/3). The aborted in_flight's
  eventual `sei:action_complete` carrying `aborted: true` is observed by
  the orchestrator and folded into history (so the model sees
  `gathered 3/7 cactus (aborted)` even though the chat reply already flew).

- **B7b (P0 attack preempt — EXISTING pendingAttack path, unchanged):** When
  `handleDispatch` is called with `sei:attacked` while currentLoop runs,
  the orchestrator MUST use the EXISTING `pendingAttack` + `eventAddendum`
  flow (orchestrator.js:637-727 today): stash `pendingAttack`, abort the
  loop, the finally block re-fires `sei:attacked` as a FRESH dispatch
  which seeds a NEW loop with the verbal-first eventAddendum. The new
  mid-loop continuation path (B7a) does NOT apply to P0. Assertion:
  after `sei:attacked` arrives mid-loop, the harness sees (1)
  `currentLoop.abortController.abort()` called, (2) `pendingAttack` set,
  (3) on loop teardown, a fresh `handleDispatch('sei:attacked', ...)` call
  with `eventAddendum` containing "React out loud first".

- **B8 (signal delivery to behavior):** Inside the fake long-runner,
  `config.signal.aborted` flips to true within one event-loop tick of the
  abort call. (This proves the loop now hands a live signal to behaviors
  instead of the dead-code-during-await signal.)

- **B9 (stop is terminal even with no in_flight):** When the model emits
  `stop` while no in_flight exists, the loop terminates cleanly with
  lastActionResult = 'stopped'. No abort is called (no controller to
  abort). No new iteration is scheduled.
  </behavior>
  <action>
Rewrite the orchestrator's iteration core from a synchronous while-loop
into an FSM-event-driven step machine. The same `createOrchestrator`
factory shape, the same handleDispatch entrypoint, the same loop object —
but `handleDispatch` no longer holds the FSM signal while a long-runner
runs.

**Concept sketch (informational; choose the cleanest implementation that
satisfies B1-B9 — Claude's discretion on factoring):**

```
state held on `currentLoop`:
  inFlight: { name, input, promise, abortController, handle, startedAt } | null
  history: existing loop.messages (unchanged)
  pendingPreemptEvent: { event, data } | null   // set by P1 path; drained by next iteration
  isTerminal: boolean                            // set by case 2 (stop) or case 3 (new long-runner)
  _triggerEvent: existing — used by case-3 gate (only re-enqueue if P0/P1)

handleDispatch(event, data, signal):
  classify event:
    A. fresh loop (no currentLoop, any event)             -> existing fresh-loop path, run ONE iteration step
    B. sei:action_complete + currentLoop exists           -> action_complete path
    C. owner-chat + currentLoop && inFlight                -> mid-loop preempt path (NEW — B7a)
    D. sei:attacked + currentLoop                          -> EXISTING pendingAttack path (B7b — unchanged)
    E. owner-chat + currentLoop && !inFlight              -> existing PLAYER INTERRUPT branch (unchanged)
    F. sei:loop_end / sei:idle / others while currentLoop -> existing drop-with-warn

ONE iteration step (the function that replaces the body of the while loop):
  1. callPersonality(loop, signal)
  2. append assistant turn, emit text-as-chat (existing logic)
  3. classify toolUses:
     - has `stop` tool_use?         -> case 2: abort inFlight (if any), terminate
     - has new long-running tool?   -> case 3 if inFlight exists AND _triggerEvent is P0/P1, else dispatch as next in_flight in SAME loop
     - movement tool, no inFlight?  -> dispatch in background (case 0 — start in_flight)
     - personality-only tools?      -> existing setGoals/noteToSelf branch, then next iteration
     - no tools?                    -> terminal (existing behavior)
  4. for any in_flight start: attach .then/.catch that calls
     reenqueue('sei:action_complete', { name, input, result, aborted })
     and clears currentLoop.inFlight regardless of resolve/reject.
  5. return — let the FSM drive the next iteration via the queue.

action_complete path (B in handleDispatch):
  - if loop.isTerminal: drop (case 2 already terminated; the late action_complete is informational)
  - else:
    - append tool_result (result string from event.data) to history
    - append snapshot user turn (with in_flight cleared)
    - run ONE iteration step (above)

mid-loop P1 preempt path (C — owner-chat only):
  - flag preempt event on currentLoop.pendingPreemptEvent
  - abort currentLoop.inFlight.abortController (if any)
  - synthesize an interrupt user turn (PLAYER INTERRUPT — reuse existing logic)
  - run ONE iteration step
  - when the aborted in_flight's eventual sei:action_complete arrives, the
    action_complete path appends the (now-aborted) tool_result to history
    and runs another iteration — UNLESS the loop is already terminal, in
    which case the aborted result is appended to history but no iteration is run.

P0 attack preempt (D — unchanged from today):
  - Use the existing orchestrator.js:637-727 pendingAttack path verbatim.
  - DO NOT integrate sei:attacked into the new C/B7a continuation path.
  - DO ensure the inFlight's AbortController is aborted alongside the
    currentLoop.abortController (today's `currentLoop.abortController.abort()`
    aborts the personality call; the inFlight is a sibling controller in the
    new design — abort BOTH so the long-runner stops too).

Case 3 gate (W-2 lock):
  - Read `currentLoop._triggerEvent`. If it is `'owner_chat'` /
    `'sei:chat_received'` / `'sei:attacked'`, case 3 fires (re-enqueue the
    same triggering event so a fresh loop seeds with the verbal-first
    eventAddendum / chat context).
  - Otherwise (trigger was `'sei:idle'`, `'sei:loop_end'`, `'sei:action_complete'`,
    etc.), case 3 is SUPPRESSED: the new long-runner just becomes the next
    in_flight of the same loop. The old in_flight aborts. The loop continues
    with the model's response appended to history. (Avoids the weak-seed
    reseed where an idle-loop would re-enqueue `sei:idle` as the new loop's
    seed.)
  - The harness B6 asserts BOTH branches: trigger=owner_chat -> reseed,
    trigger=sei:idle -> same-loop dispatch.

**Implementation discipline:**

- **Preserve all existing guards.** Owner-chat dedup (`shouldPreserveInterrupt`),
  P0 attack handling (`pendingAttack` re-fire), idle gate, dig-cap,
  follow+attack collapse, cant_reach nudge, silent-iteration cadence —
  ALL stay. The rewrite preserves the iteration-step contents; it just
  changes WHO drives the next step (FSM event vs in-place while loop).

- **P0 vs P1 preempt separation (W-1 lock):** P0 `sei:attacked` retains its
  `pendingAttack` + `eventAddendum` reseed path. ONLY owner-chat (P1) uses
  the new mid-loop continuation path. Do NOT collapse the two branches.
  The reason: the P0 reseed delivers the verbal-first policy + attacker
  identification via a FRESH loop's eventAddendum; the P1 continuation
  preserves the SAME loop so the model can answer mid-task without losing
  task context. These are deliberately different semantics.

- **runWithInflight changes:** today it returns `await registry.execute(...)`.
  After this task, it returns synchronously a `{ promise, abortController, handle }`
  shape; the orchestrator's iteration-step code attaches the .then/.catch
  that reenqueues sei:action_complete. The inflight handle clears on
  settle (existing inflight.end() call moves into the .finally branch).
  The execOpts passed to registry.execute carries `signal` (from the
  freshly-minted AbortController for this in_flight, NOT the loop's
  outer abortController — those are now distinct). The cuboid-detection
  branch is EXTENDED to include `name === 'gather'`:
  ```js
  const isProgressFlavored = name === 'build' || name === 'gather' || (name === 'dig' && args && args.to)
  const opts = isProgressFlavored
    ? { ...execOpts, onProgress: (p) => inflight.updateProgress(handle, p) }
    : execOpts
  ```
  This is the SAME channel build/dig already use — no parallel pattern, no
  invented config fields.

- **Loop's abortController vs in_flight's abortController:** the loop's
  outer abortController (used by callPersonality) still exists and is
  aborted by P1/P0 preempt; the in_flight has its OWN AbortController
  passed to the behavior. P1/P0 preempt aborts BOTH (loop's outer for
  the next Haiku call, in_flight's for the running behavior). Preserve
  the WR-02 external-signal bridging (loop._externalSignal +
  bridgeExternalAbort) so FSM signal still reaches the loop.

- **Logging:** add `logger.debug?.` calls at the cancel-semantics
  decision points so the live verification flow is observable in logs.
  Use the tag `[sei/orch] cancel-case={1|2|3}` and
  `[sei/orch] case3-gate trigger=<event> {fire|suppress}`.

- **Behavior signal contract verified by harness:** the test harness
  asserts that when the orchestrator aborts in_flight, `config.signal.aborted`
  is observable inside the fake long-runner within one tick. This is the
  CLAUDE.md "single outstanding action token with AbortController" contract
  actually holding.

**Write `scripts/verify-260513-wkd.mjs`:**

A node-only script (no mineflayer, no Anthropic SDK). It builds a tiny
fake adapter (listActions returns ['fakeLong', 'stop']; executeAction for
fakeLong returns a pending promise that resolves on abort; chat is a
no-op recorder; createSnapshotComposer returns a stub that returns a
short fixed string; worldPrimer returns ''; closeAnySessions is a no-op).
It builds a fake anthropic client that returns scripted responses in
sequence. It builds a fake reenqueue that pushes into an array AND
sorts by priority (mirroring fsm.js Priority semantics) so B2b can
assert ordering.

**Assertions (precise, not narrative):**

  - **B1:** `Date.now() - t0 < 50` where `t0` is captured immediately
    before `handleDispatch` and the elapsed is measured immediately after
    `await handleDispatch(...)` returns; the fake long-runner is still
    pending at this point (its resolver has not been called).
  - **B2:** reenqueue log includes one entry with event === `'sei:action_complete'`
    and `data === { name: 'fakeLong', input: {...}, result: <string>, aborted: false }`.
    Shape asserted via `assert.deepStrictEqual` on the data shape.
  - **B2b:** synthesize two reenqueue calls in arbitrary order
    (`P2_MOVEMENT` and `P2_ACTION_COMPLETE`); after the fake queue
    sorts by priority asc, assert dequeue order is `[P2_MOVEMENT, P2_ACTION_COMPLETE]`
    (i.e. 2 before 2.1). This proves the priority-tier separation makes
    ordering numeric rather than FIFO-stability-dependent.
  - **B3:** after action_complete dispatch, `loop.messages.at(-2)` is a
    user turn whose first content block is a `tool_result` with the
    expected `tool_use_id` and `content === result`; `loop.messages.at(-1)`
    is the assistant turn from the next Haiku call.
  - **B4:** after a text-only response to action_complete, assert
    `currentLoop !== null`, `currentLoop.inFlight === null` (the prior
    in_flight just completed), `currentLoop.isTerminal === false`, AND
    `reenqueue` log was NOT called with `'sei:action_complete'` again.
  - **B5:** after `stop` response, assert `inFlight.abortController.signal.aborted === true`,
    `adapter.chat` recorder received the spoken text, `currentLoop === null`
    (loop torn down), AND the subsequent `sei:action_complete` (when the
    fake long-runner settles after abort) is observed by handleDispatch
    but does NOT trigger a new iteration (`anthropic.calls.length` is
    unchanged after the late event).
  - **B6 (fire branch):** with `_triggerEvent = 'owner_chat'`, Haiku
    returns `{text: 'switching to food', tools: [{name: 'fakeLong', input: {block: 'meat'}}]}`.
    Assert: (1) old `inFlight.abortController.signal.aborted === true`,
    (2) `currentLoop === null` (terminated), (3) reenqueue log has a
    `'owner_chat'` event with the ORIGINAL data payload (re-enqueued).
  - **B6 (suppress branch):** with `_triggerEvent = 'sei:idle'`, same
    response. Assert: (1) old `inFlight.abortController.signal.aborted === true`,
    (2) `currentLoop !== null` (same loop continues), (3) `currentLoop.inFlight.name === 'fakeLong'`
    with the NEW args (new in_flight started in same loop), (4) reenqueue
    log does NOT contain `'sei:idle'` (no reseed).
  - **B7a (P1 mid-loop):** dispatch `owner_chat` while inFlight runs.
    Assert: (1) `inFlight.abortController.signal.aborted === true` within
    one microtask tick, (2) `currentLoop !== null` (same loop), (3)
    `loop.messages.at(-1)` is the post-Haiku assistant turn for the
    interrupt iteration, (4) when the aborted long-runner later emits
    `sei:action_complete` with `aborted: true`, history gains a tool_result
    line containing `aborted` text.
  - **B7b (P0 attack):** dispatch `sei:attacked` while inFlight runs.
    Assert: (1) `currentLoop.abortController.signal.aborted === true`,
    (2) `pendingAttack` was set to `{ event: 'sei:attacked', data: <orig>, preservedInterrupt: null }`,
    (3) after loop teardown, a fresh `handleDispatch('sei:attacked', ...)`
    is observed via the FSM re-fire path, (4) the new loop's seed eventText
    contains the substring `'React out loud first'` (proves the
    eventAddendum still runs in the fresh-loop path).
  - **B8:** inside the fake long-runner, an awaited
    `await new Promise(r => setTimeout(r, 0))` after the abort observes
    `config.signal.aborted === true`.
  - **B9:** dispatch a fresh `owner_chat` (no inFlight), scripted Haiku
    returns `{text: 'okay', tools: [{name: 'stop', input: {}}]}`. Assert:
    `currentLoop === null` after dispatch, `lastActionResult === 'stopped'`,
    no abortController was constructed for any inFlight (none existed),
    no `sei:action_complete` in the reenqueue log.

On failure, exit non-zero with a clear message naming the failed assertion
(e.g. `FAIL B6-suppress: expected currentLoop !== null, got null`). On
success, print `OK 260513-wkd: B1..B9 (10/10 — case-3 fire+suppress)`.

Pattern after `scripts/verify-phase7.mjs` for shape (imports, top-level
async IIFE, console.log per assertion group). Keep the harness under
~500 lines; if it grows past that, factor the fake adapter into a small
helper-object inside the same file (no new files).
  </action>
  <verify>
    <automated>
node --check src/bot/brain/orchestrator.js \
 &amp;&amp; node --check scripts/verify-260513-wkd.mjs \
 &amp;&amp; node scripts/verify-260513-wkd.mjs \
 &amp;&amp; node scripts/verify-phase7.mjs \
 &amp;&amp; grep -q "cancel-case" src/bot/brain/orchestrator.js \
 &amp;&amp; grep -q "case3-gate" src/bot/brain/orchestrator.js \
 &amp;&amp; grep -v '^#' src/bot/brain/orchestrator.js | grep -q "sei:action_complete" \
 &amp;&amp; grep -v '^#' src/bot/brain/orchestrator.js | grep -q "pendingAttack"
    </automated>
  </verify>
  <done>
- `node scripts/verify-260513-wkd.mjs` PASSes with all 10 assertions (B1, B2, B2b, B3, B4, B5, B6-fire, B6-suppress, B7a, B7b, B8, B9 — case-3 has two branches).
- `node scripts/verify-phase7.mjs` still PASSes (no regression in cuboid surface or em-dash/y= channels).
- The orchestrator emits `sei:action_complete` via reenqueue on every in_flight settle.
- The model's `stop` tool aborts the in_flight AND ends the loop.
- A second long-running tool mid-flight terminates the current loop AND seeds a fresh one with the original triggering event ONLY when that trigger was P0/P1; for non-P0/P1 triggers it continues the same loop with the new in_flight.
- Owner chat (P1) arriving with in_flight running flips `config.signal.aborted` inside the fake long-runner within one tick AND continues the SAME loop.
- `sei:attacked` (P0) arriving mid-loop uses the EXISTING `pendingAttack` reseed path verbatim (the new mid-loop continuation does NOT apply to P0).
- `P2_ACTION_COMPLETE = 2.1` ordering is numeric, not FIFO-stability-dependent (B2b proves it).
- Existing guards (owner-chat dedup, P0 attack handling, dig-cap, follow+attack collapse, cant_reach nudge, silent-iteration cadence) are preserved verbatim.
  </done>
</task>

</tasks>

<verification>
End-to-end verification of the rework:

1. **Static checks (automated, sub-second):**
   - All edited files pass `node --check`.
   - `grep` invariants hold: `stop` tool registration, `PERSONALITY_NAMES`
     contains `'stop'`, `sei:action_complete` referenced in orchestrator,
     `config?.signal` passed in registry.js, `started=` in inflight.js,
     `config?.onProgress?.(` in mineVein.js, no `config.inflight` /
     `_inflightHandle` invention in mineVein.js, `cancel-case` and
     `case3-gate` debug tags in orchestrator.js, `pendingAttack` still
     present in orchestrator.js (P0 path preserved).

2. **Behavioral harness (automated, ~3s):**
   - `node scripts/verify-260513-wkd.mjs` exits 0 with 10/10 assertions
     (B1, B2, B2b, B3, B4, B5, B6-fire, B6-suppress, B7a, B7b, B8, B9 —
     case-3 has two branches counted separately).
   - `node scripts/verify-phase7.mjs` still PASSes (regression guard;
     em-dash + y=<currentY> channels intact).

3. **Live verification (manual, post-merge — explicitly out of scope for
   this plan; logged here so the developer knows what to do in-game):**
   - Spawn bot, `say "gather 7 cactus"` → bot starts gathering.
   - Mid-gather, `say "wait, how many do we need?"` → bot speaks immediately
     (case 1 — text only, gather continues). Verify chat reply appears
     within ~1 s of typing (no 12 s pathfind-timeout wait).
   - Mid-gather, `say "we have enough"` → bot says something, calls
     `stop`, holds position; partial result `dug K/N (aborted)` appears
     in the next loop's recent_loop_history.
   - Mid-gather, `say "actually let's get food instead"` → bot says
     something, gather aborts mid-batch, bot starts hunting (a different
     long-runner). Both loops appear in logs; the case-3 reseed fires
     because trigger was owner_chat.
   - During gather, get hit by a zombie (P0) → bot reacts verbally first
     via the existing eventAddendum path (FRESH loop, NOT the new mid-loop
     continuation). Snapshot in the post-attack iteration shows
     `in_flight: gather(cactus) started=...` only if gather is re-issued
     by the model; otherwise the gather is aborted and the new loop
     proceeds attack-first.
</verification>

<success_criteria>
- All 10 harness assertions pass in `scripts/verify-260513-wkd.mjs`.
- No regression in `scripts/verify-phase7.mjs` (em-dash + y=<currentY>
  channels preserved byte-stable except for the locked `(Xs)` →
  `started=Xs ago` elapsed-trailer change).
- Pathfind goTo, gather, cuboid dig, cuboid build, multi-swing attack all
  return a structured aborted result when signal aborts mid-action; the
  string includes partial-progress data the LLM can read.
- The orchestrator's `handleDispatch` for any long-runner-issuing
  iteration returns within 50 ms (non-blocking).
- The `stop` tool exists, is in PERSONALITY_NAMES, and a `stop`-only
  response terminates the loop AND aborts any active in_flight.
- The mid-flight snapshot includes `in_flight: <name>(<argblurb>) started=Xs ago[ — <completed>/<total>[, y=<currentY>]]`
  with progress when available; the em-dash and y= channels are unchanged
  from Phase 7 D-10.
- Gather contributes progress via the SAME `onProgress` channel as cuboid
  build/dig — no parallel pattern, no invented config field.
- `Priority.P2_ACTION_COMPLETE = 2.1` makes action_complete ordering
  numeric (independent of V8 sort stability).
- P0 `sei:attacked` continues to use the existing `pendingAttack` +
  `eventAddendum` reseed path; only P1 owner-chat uses the new mid-loop
  continuation path.
- Follow's abort contract remains `setFollowTarget(null)` (target-clear,
  not signal); documented inline in follow.js.
- Case-3 fires only when the current loop's trigger was P0/P1; otherwise
  the new long-runner becomes the next in_flight of the same loop.
- The persona system prompt teaches always-speak-on-P0/P1 and the three
  cancel intents.
</success_criteria>

<output>
After completion, write a SUMMARY at
`.planning/quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/260513-wkd-SUMMARY.md`
covering: what shipped, the cancel-semantics dispatch table as implemented
(including the case-3 gate on `_triggerEvent` and the P0-vs-P1 path split),
which existing guards were preserved verbatim vs migrated, the
verify-260513-wkd.mjs assertion list, and the live-verification checklist
deferred to the developer.
</output>
</content>
</invoke>