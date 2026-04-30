---
quick_id: 260429-ons
status: complete
date: 2026-04-30
---

# Quick Task 260429-ons — Summary

## Goal
Make Sei aware of what she's already doing, stop follow from stealing the pathfinder mid-action, let owner chat interrupt in-flight work, and replace catch-all action error strings with self-diagnostic ones — so the LLM doesn't invent wrong theories like "I need an axe" when the real problem is "out of range".

## Changes

### Self-awareness layer
- **`src/llm/inflight.js`** (new) — `createInflightTracker()` records the most-recent in-flight action with `{name, args, startedAt}`. Exposes `start/end/current/currentBlocking`. Personality actions (`setGoals`, `say`, `look`) are tagged so they don't pause follow.
- **`src/observers/snapshot.js`** — accepts `inFlight` opt and renders an `in_flight: <name> <argblurb> (<elapsed>s)` line under `holding:`. The line is omitted when nothing is running.
- **`src/llm/orchestrator.js`** — every `registry.execute(...)` call now goes through `runWithInflight(name, args, opts)` which brackets the call with `inflight.start/end`. `renderUserContext` reads `inflight.current()` and passes it to `composeSnapshot`. Tracker is exposed on the orchestrator return + `_internal`.

### Follow lifecycle
- **`src/behaviors/follow.js`** — added `setInflightProvider(fn)`. The 1s tick yields when the provider returns truthy (movement action in flight). The hard `pauseFollow()` API is preserved for combat.js's stop-following-on-attack path.
- **`src/llm/orchestrator.js`** — wires `setInflightProvider(() => inflight.currentBlocking() != null)` at construction, and **removes** the `pauseFollow(true)/(false)` bracket from `handleDispatch`. Pause now matches the action lifecycle, not the dispatch lifecycle, so dig's approach + swing + pickup walk all complete without follow stealing the pathfinder.

### Owner-chat preemption
- **`src/fsm.js`** — `enqueue` promotes owner chat (`ownerSpoke=true`) to `P0_SAFETY` priority *only when there's a non-P0 action already in flight*. The existing `processNext` lower-number-aborts-current logic does the rest: `controller.abort()` → action handlers see `signal.aborted` → return `'aborted'` → snapshot clears `in_flight:` → next dispatch handles the new chat fresh.

### Tighter action error strings
Every action handler now returns failure strings with enough context that the LLM can choose a corrective action without guessing. Common pattern: `<verb> <noun> failed: <reason>` with mineflayer reasons truncated to 80 chars and stack traces stripped.

- **`src/llm/errStrings.js`** (new) — `firstLine` / `truncate` / `reason(err)` helpers shared by all action handlers.
- **`dig.js`** — surfaces what is currently being dug (`busy digging jungle_log @x,y,z`), explicit out-of-range with distance (`out of range (5.7m, need ≤4.5)`), holding-context for can't-break (`cannot break jungle_log with bare hands`), `target changed` when the block at the original coords no longer matches, and pickup-walk failures noted alongside the dug result.
- **`attack.js`** — `target gone` vs `target out of reach (Nm, need ≤3.5)`.
- **`place.js`** — `cannot hold X to place: <reason>` vs `cannot place X on Y: <reason>`.
- **`equip.js`** — `cannot equip X to <slot>: <reason>`.
- **`drop.js`** — `cannot drop X: <reason>`, returns actual count dropped.
- **`consume.js`** — `food bar full` short-circuit, `cannot eat X: <reason>` discriminates "not edible".
- **`sleep.js`** — pattern-matches mineflayer reason strings into `monsters nearby` / `too far from bed` / `bed obstructed`.
- **`activate.js`** — refuses with `cannot activate: holding nothing` before calling mineflayer; reports `activated <held>` instead of bare `activated`.
- **`container.js`** — open/deposit/withdraw failures include the reason; reach errors include distance.

### LLM-side rules
- **`src/llm/orchestrator.js`** — `SYSTEM_INSTRUCTIONS` (two-call) and `COMBINED_SYSTEM` (single-call) now document:
  - **In-flight rule** — if the snapshot shows `in_flight:`, do not call any movement action; you may `say` or stay quiet.
  - **One-movement-type rule** — multiple `dig` calls in a turn is fine and recommended (they run sequentially); mixing different movement types is not.
  - **Interrupt rule** — when the player gives a new instruction mid-task, the runtime aborts the prior work; treat it as a fresh start.
  - **Always-`say` allowed** — even while busy, Sei can acknowledge and report progress.

## Verification
- `node --check` clean on all 15 edited/created files.
- The combined-call path (executor=api) preserves prompt caching: `cachedCombinedSystemBlocks` is rebuilt unchanged; only the unbracketed text content of `COMBINED_SYSTEM` changed, which invalidates the cache once on next start (expected).
- The follow tick now has three short-circuit gates in order: hard `_paused` → inflight provider → `pathfinder.isMoving`. All three preserve the existing protection while adding action-lifecycle awareness.
- Owner-chat preemption fires only when `currentAction.priority > P0_SAFETY`, so attack-driven dispatches (P0) are not interrupted by casual owner chat.

## Notes / follow-ups

- **Pre-existing post-tool validator hook** continues to mis-flag this Node.js project's `setTimeout` calls as Vercel Workflow violations. The flagged line is unchanged Ollama-probe retry code; Sei runs in a Mineflayer utilityProcess, not Vercel sandbox.
- The dig out-of-range check uses 4.5 blocks (mineflayer's effective break reach). If the LLM emits a dig at 5+ blocks distance, it now returns `out of range` immediately instead of letting mineflayer fail with an opaque error mid-swing.
- Owner-chat preemption uses `ownerSpoke=true` (not `addressed=true`) since this is a single-owner companion bot — every owner utterance counts as potential redirection. Edge case: bot abandons important task because owner says "nice"; acceptable trade for now.
- Conversation memory (next phase) will reinforce all of this — once Haiku sees its own prior `tool_use` in history, the in-flight gate becomes belt-and-braces.
- The two-call (Ollama-healthy) movement path doesn't currently emit `in_flight:` for movement actions because the second-layer Qwen call has no awareness of the first layer's snapshot — only personality calls render it. This is fine: the in-flight gate matters most for the combined path where Haiku is also the executor.
