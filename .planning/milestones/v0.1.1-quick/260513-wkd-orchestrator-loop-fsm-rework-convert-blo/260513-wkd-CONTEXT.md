# Quick Task 260513-wkd: Orchestrator loop + FSM rework — Context

**Gathered:** 2026-05-13
**Status:** Ready for planning

<domain>
## Task Boundary

Convert the orchestrator from a blocking `await`-based loop into an
FSM-event-driven loop. Long-running actions (pathfind, gather, dig-cuboid,
build-cuboid, attack-multi-swing, follow tick) dispatch in the background;
the next loop iteration is triggered by whichever event arrives first —
P2 (action completed) by default, or P1/P0 preempting early. Thread an
AbortSignal through every long-running behavior so abort actually halts
the body. Add an in-loop preemption surface so chat or attack events arriving
mid-action wake the LLM with `in_flight` context, and the model decides
whether to keep waiting, abandon, or switch tasks.

Today's blocking await locks dispatching: `processNext` cannot run the next
queued item until `onDispatch` returns. The orchestrator-side preempt
controllers (`replaceAbortController`) are similarly blocked. Result: P0/P1
events get parked in the FSM queue until pathfinder/gather completes (or
hits its own 12 s timeout), and the cancel branch in `fsm.js:119` is
effectively dead code while any long action is running.

Scope of this task: orchestrator + FSM event loop + signal threading +
snapshot enrichment + the new `stop` tool. Out of scope: re-shaping the
priority constants, changing tool names other than adding `stop`, touching
memory/diary code, persona prompt changes beyond what's needed for the new
tool description.

</domain>

<decisions>
## Implementation Decisions

### Cancel semantics (LOCKED — user choice)

The LLM has three intents per mid-loop iteration when in_flight is running.
Each maps to a distinct response shape:

| Intent | Response shape | Orchestrator effect |
|---|---|---|
| **Case 1** — continue task ("where are we headed") | text only, no tool_use | in_flight stays alive; loop stays alive; await next event |
| **Case 2** — task done, hold position ("we have enough") | text + `stop` tool | abort in_flight; loop terminal; no new task |
| **Case 3** — switch task ("let's get food") | text + new long-running tool | abort in_flight; current loop terminal; new loop with the new tool as seed |

Default text-only response while in_flight is running = **continue waiting**.
A new `stop` tool is added to the personality tool set (no args, returns
"stopped") as the explicit "task done, abandon in_flight, hold position"
signal. This keeps end_turn unambiguous: the orchestrator looks for `stop`
in the tool_uses; if present → case 2; else if any new long-running tool →
case 3; else → case 1.

**Rationale:** the user explicitly wants "respond without dropping" as a
clean capability. Default-to-continue maps to that. Adding a tiny `stop`
tool keeps the cancel-without-replacement path expressible without
overloading end_turn semantics with text content heuristics.

### Loop terminal condition (DERIVED)

- **No in_flight**: `end_turn` (no tool_use) → loop terminal. Same as today.
- **In_flight running**: terminal only when (a) in_flight completes AND the
  ensuing P2-triggered iteration ends with no tool_use, or (b) the model
  emits `stop` (case 2), or (c) the model emits a new long-running tool
  (case 3 — current loop terminates immediately; the new tool seeds a new
  loop).

### P1/P0 always elicit a spoken response (LOCKED — user requirement)

> "In all cases the model should say something upon receiving a P1 or P0."

Persona/system prompt addendum: on receipt of an owner chat or attack event
mid-loop, the response MUST include text. If the model returns text-only AND
no `stop` tool, this is case 1 and is the normal flow. If the model returns
JUST a tool (no text) on interruption, the orchestrator does not retry — the
model is trusted to have produced text, but operationally this becomes a
prompt-quality issue not an orchestrator concern.

### One in_flight at a time (LOCKED — user)

The orchestrator tracks at most one long-running action at a time. Mineflayer
can only do one pathfind/dig/build/attack-swing concurrently anyway.
Synchronous tools (find, setGoals, noteToSelf, lookAt, equip, sleep, follow,
unfollow, stop, drop, deposit, withdraw, activate, openContainer) can run
alongside an in_flight; they execute immediately in the same iteration and
the loop continues.

If the model emits a 2nd long-running tool while in_flight is running, treat
as case 3: abort in_flight, current loop becomes terminal, the new tool
becomes the seed of a new loop. The new loop's seed event is the same
interruption event (P0/P1) that triggered the current iteration — not a
synthesized event, so the seed prompt remains the original chat / attack
context, with the model's mid-loop response folded into recent_loop_history.

### Signal threading scope (LOCKED — user)

Day-1 scope: AbortSignal threaded through ALL long-running behaviors.

- `behaviors/pathfind.goTo` — accept `signal`, abort listener calls
  `bot.pathfinder.stop()` and resolves to `'aborted'` (new result variant
  distinct from `'timeout'`).
- `behaviors/mineVein.gatherAction` (gather) — check `signal.aborted`
  between dig steps; cleanly abort the surrounding pathfind via the same
  signal.
- `behaviors/dig.digAction` cuboid mode — check `signal.aborted` between
  cells in the Y-desc → X-asc → Z-asc iteration order.
- `behaviors/build.buildAction` cuboid mode — check `signal.aborted`
  between placements.
- `behaviors/attack.attackEntityAction` multi-swing — check `signal.aborted`
  between swings.
- `behaviors/follow.startFollow` 1 s tick — already yields via
  `bot.pathfinder.isMoving()` but should also short-circuit on `signal.aborted`
  if a signal is provided.

Behavior result on abort: each behavior returns a structured result with
`{ aborted: true, partial: <progress so far> }` (e.g., gather returns
`gathered K/N (aborted)`, build returns `built K placed, S skipped, A aborted of N cells`).
Tool result is logged to the loop history so the LLM sees what was completed
before the abort.

### Snapshot mid-flight enrichment (LOCKED — user, "keep simple")

The `composeSnapshot` output for a mid-loop iteration triggered by P1/P0
(i.e., `in_flight` is running) MUST include:

- **Existing snapshot fields** — pos, biome, surroundings, time, hp, food,
  xp, holding, inventory, terrain at feet, nearby blocks, nearby entities,
  goals, follow_target.
- **`in_flight:`** — `<name>(<args>) started=<Xs ago>`. The args field
  shows the LLM-readable form (e.g., `gather(cactus, n=7)`, `goTo(-111,75,-126,range=4)`).
- **`recent_events:`** — inventory delta + position delta since the previous
  iteration (already wired today). E.g., `+5 cactus; killed item ×2; +12m`.
- **`last_action_result:`** — the previous iteration's tool_result text
  if any (also already wired today).

Per-behavior progress fields beyond `started=Xs ago` are not required day 1.
The existing `inflight.updateProgress` mechanism already feeds cuboid
build/dig (`placed K/total`); gather should be updated to call it so the
`in_flight:` line can carry `gathered K/N` when present. This costs ~5 lines
in `mineVein.js`.

### FSM event surface (LOCKED — derived)

Add a new priority constant: `P2_ACTION_COMPLETE`. Placed at the same
priority as `P2_MOVEMENT` (= 2) so chat / attack still preempt naturally,
but it has its own event name `sei:action_complete` carrying
`{ name, input, result, aborted }`. The orchestrator's loop registers a
callback that fires this event when the in_flight promise resolves.

Today's `processNext`-blocks-on-await flow is replaced with: `handleDispatch`
either starts a new loop (no current loop) or feeds a mid-loop iteration
(current loop exists, event is P1/P0 or P2). The loop object owns:
- `inFlight: { name, input, promise, abortController, startedAt, snapshot } | null`
- `history: [...]` — the existing tool_use/tool_result history
- `pendingPreemptEvent: { event, data } | null` — set when P1/P0 fires
  during in_flight's await, drained by the next iteration.

When `handleDispatch` is called with `P2_ACTION_COMPLETE`, the orchestrator
appends the tool_result to history, summons Haiku with the fresh snapshot,
processes the response (per cancel-semantics table above), and returns.
`processNext` is free to dispatch the next queued event during this window —
but the orchestrator owns the `currentLoop` reference and will reject a new
loop-start while one exists; it routes the event into the existing loop
instead.

### Rollout shape (CLAUDE'S DISCRETION — user did not select)

Hard cutover. The rework is tightly coupled: orchestrator iteration shape,
FSM behavior, behavior signal contracts, snapshot enrichment, new tool —
none of these are independently shippable. A feature flag doubles the
surface area and the old (blocking) path is the bug we're trying to remove.

Cutover is gated by post-implementation manual verification (live cactus
gather + chat interrupt; live attack mid-gather; live "we have enough" stop).

### Loop seed when 2nd action emitted mid-loop (CLAUDE'S DISCRETION)

The new loop's seed event is the same P1/P0 event that triggered the current
iteration. The model's mid-loop response (text + new tool) is appended to
the previous loop's history before it goes terminal, so the next loop sees
it via `recent_loop_history`. The new tool dispatches as the first iteration
of the new loop, immediately becoming `inFlight`.

</decisions>

<specifics>
## Specific Ideas

### Files touched (day-1 estimate)

| File | Why |
|---|---|
| `src/bot/brain/orchestrator.js` | Iteration loop rewrite; `stop` tool registration; mid-loop preempt routing |
| `src/bot/brain/fsm.js` | Add `P2_ACTION_COMPLETE` constant + event name; cancel today's blocking-await assumption in comments |
| `src/bot/brain/index.js` | Wire `sei:action_complete` priority alongside others in `reenqueue` |
| `src/bot/brain/inflight.js` | Add `getInFlightLineForSnapshot()` helper that includes `started=Xs ago` |
| `src/bot/adapter/minecraft/observers/snapshot.js` | Render `in_flight:` line via the helper above |
| `src/bot/adapter/minecraft/behaviors/pathfind.js` | Accept `signal`; new `'aborted'` result variant |
| `src/bot/adapter/minecraft/behaviors/mineVein.js` | Thread `signal`; call `inflight.updateProgress` so `gathered K/N` shows in snapshot |
| `src/bot/adapter/minecraft/behaviors/dig.js` (cuboid) | Thread `signal`; check between cells |
| `src/bot/adapter/minecraft/behaviors/build.js` (cuboid) | Thread `signal`; check between placements |
| `src/bot/adapter/minecraft/behaviors/attack.js` | Thread `signal`; check between swings |
| `src/bot/adapter/minecraft/behaviors/follow.js` | Optional `signal` short-circuit (already yields well) |
| `src/bot/adapter/minecraft/registry.js` | Pass `config.signal` through to all long-running handlers |

### Behavior result shape additions

Each long-running behavior MUST return a structured result on abort that the
orchestrator can render as a tool_result string. Suggested shape:

```js
// non-abort (existing): "gathered 5/7 cactus"
// abort:                "gathered 5/7 cactus (aborted)"
//                       "built 12 placed, 3 skipped, 4 aborted of 19 cells"
//                       "pathfind aborted at 8.4m from target"
```

The model uses this to decide whether to resume, switch, or give up — the
existing tool descriptions already prime this behavior.

### `stop` tool description

> "Signal that the current task is done and you intend to hold position.
> Use ONLY when an in-flight long-running action (gather, dig, build,
> attack, goTo) should be aborted because the owner just told you to stop
> or you've decided the task is complete. Pair with a spoken acknowledgement
> in your text. No args. Returns 'stopped'."

Add to `PERSONALITY_NAMES` set in orchestrator.js so a `stop`-only response
is terminal without being interpreted as starting a new task.

### Persona / system-prompt addendum

> "When you receive an owner message or take damage mid-action, the snapshot
> will show `in_flight:` — the body is already doing something. You ALWAYS
> say something on receipt of owner chat or an attack. Then decide:
> respond and keep going (text only, the default), or call `stop` to halt
> the in-flight action and hold, or call a different long-running tool to
> switch tasks. Don't restate the in-flight action — it's already underway."

</specifics>

<canonical_refs>
## Canonical References

- Built on top of just-committed `25fda20` (text-as-chat refactor) — text
  blocks ARE the chat channel, no `say` tool. The new `stop` tool fits the
  same personality-tool slot as `setGoals` / `noteToSelf`.
- `fsm.js:104-119` — current `processNext` behavior. Preempt branch is dead
  code while a long action awaits; this rework makes it live.
- `pathfind.js:34-89` — `goTo` signature is the canonical surface for
  signal threading; mirrors should apply to gather / build / dig-cuboid /
  attack-multi-swing.
- CLAUDE.md "Every external call has a timeout" — preserved. Signal abort
  is additive to wall-clock timeout, not a replacement.
- CLAUDE.md "Event-sourced FSM: priority queue, single outstanding action
  token with AbortController" — this rework actually makes that contract
  hold; today the AbortController is essentially unused mid-action.

</canonical_refs>
