---
quick_id: 260429-ons
slug: in-flight-snapshot-field-action-lifecycl
description: Make Sei self-aware of running actions via in_flight snapshot field, gate follow on the action lifecycle (not the dispatch lifecycle), tighten action error strings so the LLM cannot misinterpret them, allow multiple digs per turn but only one TYPE of movement, and let owner chat preempt in-flight work.
date: 2026-04-30
status: planned
---

# Quick Task 260429-ons — Self-aware actions + lifecycle pause + precise errors

## Why

From the prior wood-collecting log:
1. Sei has no idea she is mid-dig — `last_action_result` updates only on completion, so a `sei:idle` mid-dig sees stale state and she fires more digs.
2. Follow steals the pathfinder between dispatches because `pauseFollow(false)` runs in `finally`, the moment the chain returns — which can be long before the dig actually finishes its approach + swing + pickup walk.
3. `cannot dig jungle_log` is a catch-all that the LLM (correctly) interprets as "need a better tool" — but the real reasons are *out of reach* / *block already gone* / *single-flight collision*.
4. The LLM emits 10 parallel digs in one turn. Only the first runs; the other 9 hit the busy guard and return instantly.

## Tasks

### Task 1 — In-flight tracker + `in_flight:` snapshot line

**Files:** new `src/llm/inflight.js`, `src/observers/snapshot.js`, `src/llm/orchestrator.js`

**Action:**
- Add `createInflightTracker()` factory exposing:
  - `start({ name, args })` → returns a handle `{ id, name, args, startedAt }`. Stores the *most recent* in-flight entry (later entries overwrite older — single-flight is enforced elsewhere; this is a snapshot of "what is the bot doing right now").
  - `end(handle)` → clears the entry iff the id matches (so a stale `end()` after preemption can't wipe a newer entry).
  - `current()` → `{ name, args, startedAt } | null`.
- In `orchestrator.js`, wrap every `registry.execute(...)` call (both two-call and combined paths, and the personality `setGoals` path) with `start` / `end` in `try/finally`. Movement-action handles use the action name + a compact arg blurb (`dig jungle_log @8,65,-61`). Personality actions (`setGoals`) also tracked but tagged so follow doesn't pause for them (see Task 2).
- Expose the tracker on the orchestrator return value (so `bot.js` can wire it into follow) and on `_internal` for tests.
- Pass `inFlight: inflight.current()` to `composeSnapshot` from `renderUserContext`.
- In `composeSnapshot`, render an `in_flight:` line directly under `holding:` (visible early): format `in_flight: <name> <argblurb> (<elapsed>s)` when non-null, otherwise omit. `<elapsed>` is `((Date.now() - startedAt)/1000).toFixed(1)`.

**Verify:** With a long-running dig in flight, an `sei:idle` snapshot shows `in_flight: dig jungle_log @x,y,z (Ns)`. Once dig resolves, the next snapshot omits the line.

**Done:** Snapshot now reflects ground-truth "what am I doing right now" for any action that is async-running through `registry.execute`.

### Task 2 — Follow gates on action lifecycle, not dispatch lifecycle

**Files:** `src/behaviors/follow.js`, `src/llm/orchestrator.js`, `src/bot.js`

**Action:**
- Add `setInflightProvider(fn)` to `follow.js`. The follow tick checks the provider after the existing `_paused` and `bot.pathfinder?.isMoving?.()` gates: if the provider returns truthy (i.e. a *movement* action is in flight), the tick yields.
- Personality-only handles (`setGoals`, future `say`) tag themselves so the inflight provider can filter — `setInflightProvider` consumer should treat `name` from a known personality-action set as non-blocking. Simplest: tracker exposes `currentBlocking()` that filters out personality names; follow uses that.
- In `orchestrator.start()` (or at construction), call `setInflightProvider(() => tracker.currentBlocking() != null)`.
- Remove the explicit `pauseFollow(true)/(false)` bracket around `handleDispatch` — the inflight provider now drives follow, and tying pause to the dispatch function caused premature resume while dig's pickup walk was still running.
- Keep the `pauseFollow()` API exported (combat.js still uses it for stop-following-on-attack) but document the new semantics: explicit pause is a hard override; inflight is the soft default gate.

**Verify:** While `dig` is mid-execution (approach, swing, OR pickup walk), `_followInterval` ticks return early without issuing a goTo. Once dig resolves, the next tick may resume follow normally.

**Done:** Follow no longer competes with in-flight movement actions. The bot does not drift toward the player while a dig is running.

### Task 3 — Owner-chat preempts in-flight work

**Files:** `src/fsm.js`

**Action:**
- In `enqueue(...)` for `sei:chat_received` events where `data.ownerSpoke === true`, override priority to `P0_SAFETY` *only when there is a current action of priority > P0*. This makes a new owner utterance abort an in-flight movement chain so Sei can respond fresh.
- Implementation note: keep the queue priority for P0_SAFETY semantics, but tag the event so `sei:attacked` handling still distinguishes (fsm.js already switches on event name, not priority — no risk of misclassification).
- The existing `processNext` abort-when-lower-number logic does the rest: it calls `currentAction.controller.abort()`, which propagates as `signal.aborted` into `registry.execute` → action handlers' `abrt` promise resolves → returns `'aborted'` → `lastActionResult = '<name> aborted'` for the next turn.

**Verify:** While a dig is in flight, `SSk1tz: stop and come here` triggers the abort path; the in-flight dig returns `'aborted'`; the orchestrator's next dispatch handles the new chat.

**Done:** Owner chat (any chat where `ownerSpoke=true`) preempts in-flight movement. Sei can stop mid-dig when the player gives a new command.

### Task 4 — Tighter action error strings (no LLM-misleading catch-alls)

**Files:** `src/behaviors/dig.js`, `src/behaviors/attack.js`, `src/behaviors/place.js`, `src/behaviors/equip.js`, `src/behaviors/drop.js`, `src/behaviors/consume.js`, `src/behaviors/sleep.js`, `src/behaviors/container.js`, `src/behaviors/lookAt.js`, `src/behaviors/activate.js`

**Action:**
- **dig.js:**
  - Replace bare `'busy digging'` with `busy digging <currentBlockName> @x,y,z` so the LLM sees what is in progress and doesn't reflexively retry.
  - Compute distance to target before calling `bot.dig`; if `> 4.5` blocks, return `out of range (Nm)` instead of letting the underlying call fail with `'cannot dig'`.
  - Capture the actual mineflayer error message and discriminate: pickup-walk failures vs swing failures vs target-changed (block at coord no longer matches expected name) → `target changed` / `dig failed: <reason>` / `pickup walk failed (dug ok)`.
  - Replace `'cannot dig <name>'` from `canDigBlock` with `cannot break <name> with <holding|bare hands>` (more diagnostic).
- **attack.js:** distinguish `target gone` (entity removed since snapshot) from `target out of reach` from `cannot attack <name>: <reason>`.
- **place.js:** `no <item> in inventory` → keep. `could not equip` → `cannot hold <item> to place`. `cannot place <item>` → `cannot place <item> against <ref>: <reason>` (face/space/support).
- **equip.js:** `no <item>` → `no <item> in inventory`. `cannot equip <item>` → `cannot equip <item> to <destination>: <reason>` (slot full / not holdable).
- **drop.js:** `no <item>` → `no <item> in inventory`. `cannot drop <item>` → `cannot drop <item>: <reason>`.
- **consume.js:** `'no <item>'` → `no <item> in inventory`. `'could not eat'` → discriminate `food bar full` (check `bot.food >= 20`) vs `not edible` vs `cannot eat: <reason>`.
- **sleep.js:** `'cannot sleep'` → `cannot sleep: <reason>` (monsters/too far/obstructed). Add `'too far from bed'` if reach check fails.
- **container.js:** keep `'no container open'` etc, but add reach context to `'target out of reach'` → `'target out of reach (Nm, need ≤4)'`.
- **lookAt.js:** keep terse strings (look failures are rarely actionable signals).
- **activate.js:** `'cannot activate'` → `cannot activate held item: <reason>`.
- All files: when including a mineflayer error message, **truncate to ~80 chars** to avoid blowing context, and **strip stack traces** (split on `\n`, take first line).

**Verify:** Every action's `return` strings either describe success (`dug jungle_log`) or describe failure with enough context for the LLM to choose a corrective action *without inventing wrong theories like "I need an axe"*.

**Done:** Action result strings are diagnostic, not catch-all.

### Task 5 — Combined system prompt: one movement *type* per turn, multiple of same type ok

**Files:** `src/llm/orchestrator.js`

**Action:**
- Update `COMBINED_SYSTEM` to explicitly state:
  - "If `in_flight:` is shown, you are already doing that thing. Do not call any movement action this turn. You may `say` something to the player, or emit no tool calls."
  - "In one response you may emit AT MOST ONE TYPE of movement action — for example, ten `dig` calls is fine; one `dig` plus one `goTo` is not. The chosen actions will run sequentially."
  - "If the player gives a new instruction, the prior in-flight work is aborted automatically — start fresh, don't try to resume it."
  - "You may always `say` to the player, even while busy. Use it to acknowledge instructions or report progress."
- Add the same in_flight rule to the two-call personality prompt (`SYSTEM_INSTRUCTIONS`) since the two-call path also reads in_flight from the snapshot.

**Verify:** Re-running the wood-collecting scenario: 10 parallel digs in one turn execute serially without colliding (each one waits for the prior to clear in_flight), and a sei:idle mid-dig produces `say` only — no extra movement.

**Done:** LLM-side instructions match the new runtime guarantees.

### Task 6 — Smoke check

`node --check` on every edited file. No tests exist for the bot; relying on syntax check + manual review.

## must_haves

- **truths:**
  - `composeSnapshot` emits an `in_flight: …` line whenever an action is mid-execution.
  - Follow's tick yields whenever a *movement* action is in-flight (personality-only entries like `setGoals` do not pause follow).
  - `pauseFollow(true)/(false)` bracket around `handleDispatch` is removed; inflight provider is the new gate.
  - Owner chat (`ownerSpoke=true`) raises to P0 priority *only when there is a non-P0 action in flight*, causing `signal.abort()` and an `'aborted'` return from the in-flight handler.
  - Every non-trivial action error string distinguishes at least: target missing/changed, out of range, equip failure, generic failure with truncated mineflayer reason.
  - `COMBINED_SYSTEM` and `SYSTEM_INSTRUCTIONS` document the in_flight gate, the one-movement-type-per-turn rule, and the abort-on-new-command behavior.

- **artifacts:**
  - `src/llm/inflight.js` (new)
  - `src/observers/snapshot.js`
  - `src/llm/orchestrator.js`
  - `src/behaviors/follow.js`
  - `src/bot.js`
  - `src/fsm.js`
  - `src/behaviors/dig.js`, `attack.js`, `place.js`, `equip.js`, `drop.js`, `consume.js`, `sleep.js`, `container.js`, `activate.js`

- **key_links:**
  - `src/llm/orchestrator.js:170-330` (handleDispatch — both branches)
  - `src/observers/snapshot.js:21-102`
  - `src/behaviors/follow.js:5-31`
  - `src/fsm.js:52-112`
  - `src/behaviors/dig.js:12-57`
