---
quick_id: 260429-nyx
slug: update-api-only-fallback-to-single-combi
description: Collapse API-only fallback to a single Haiku call with combined personality+movement tools, and replace trailing-edge attack debounce with a leading-edge throttle so the first hit fires immediately while rapid follow-ups within 500ms are suppressed.
date: 2026-04-30
status: planned
---

# Quick Task 260429-nyx — API-only single-call + leading-edge attack throttle

## Why

The local Ollama movement model is the bottleneck. In `executor: 'api'` (and on circuit-trip fallback), every dispatch costs **two** Anthropic round-trips (personality hop → movement hop). Combining both into a **single** Haiku call halves API latency and token spend in fallback mode.

Separately, `entityHurt` fires repeatedly during a single attack burst. The current 500ms trailing-edge debounce (`createDebouncer`) waits for 500ms of *quiet* before emitting `sei:attacked` — so the bot effectively responds *late*. The user wants leading-edge behaviour: react to the first hit immediately, suppress the second hit if it arrives within 500ms of the first.

## Tasks

### Task 1 — Leading-edge throttle for `sei:attacked`

**Files:** `src/llm/debounce.js`, `src/behaviors/combat.js`

**Action:**
- Add `throttleLeading(key, payload, fire, windowMs)` to `debounce.js` (or add a sibling `createThrottle(windowMs)` factory). Semantics: on first call for a key, fire immediately and arm a cooldown timer; subsequent calls within `windowMs` are dropped (last payload optionally retained but not re-emitted). After the window expires, the next call fires immediately again.
- In `combat.js`, replace the `bot._seiDebouncer.debounce('attacked:…', …)` call with the new leading-edge throttle so the first hit triggers `sei:attacked` instantly and follow-up hits within the window do not re-trigger the LLM dispatch.
- Keep chat ingress on the existing trailing-edge debouncer (chat coalescing benefits from waiting; combat does not).

**Verify:** `bot._seiAttackThrottle` (or equivalent) is wired in `bot.js`; `combat.js` no longer references the trailing debouncer for the `attacked:*` key. Add a tiny inline self-check or rely on existing verify harness.

**Done:** Two `entityHurt` events fired 100ms apart cause exactly **one** `sei:attacked` emission, and that emission happens on the *first* event (not after a 500ms delay).

### Task 2 — Combined single-call fallback

**Files:** `src/llm/orchestrator.js`

**Action:**
- Build a new combined system prompt + tools list used only when `circuit.isOpen()` (i.e. `executor: 'api'` or Ollama tripped).
- Combined tools = personality tools (`say`, `setGoals`, `look`) **plus** the movement registry tools (filtered with `n !== 'setGoals'`), all flattened into one Anthropic `tools` array. Drop `handOffToMovement` from the combined set — it is meaningless when there is no second layer.
- Add `callCombined(userBlock, signal)` that issues one `anthropic.call` with the merged tools and a concise unified system prompt: "You are a Minecraft companion. You may speak (`say`), set goals (`setGoals`), look (`look`), or directly invoke a movement action (e.g. `goTo`, `dig`, `attack`, `follow`, `equip`, …). Pick the smallest set of tool calls that fulfils the situation. Stay under 3 sentences of internal reasoning."
- In `handleDispatch`, branch at the personality step:
  - **If `circuit.isOpen()`** → call `callCombined`, count one hop, then dispatch the toolUses through the same say/goal/look/movement handlers already used for the two-call path. Skip the dedicated movement hop entirely.
  - **Else** → keep the existing two-call path unchanged.
- Reuse the existing chain bookkeeping, `lastActionResult` tracking, abort handling, and `pauseFollow` / container cleanup so the fallback path inherits all of the same safety nets.

**Verify:** With `config.llm.executor: 'api'`, a dispatch produces exactly one `anthropic.call` invocation per chain hop. Movement actions emitted by the combined call execute through `registry.execute()` exactly like the two-call path.

**Done:** API-only fallback issues a single Haiku request per personality turn; `say`/`setGoals`/`look` and movement actions (`goTo`, `dig`, `attack`, …) all dispatch from that single response. Two-layer (auto) mode behaviour is unchanged when Ollama is healthy.

### Task 3 — Smoke check

**Files:** existing `scripts/verify-phase2_1.js` (read-only run if it does not require a live Minecraft server) + a quick `node --check` on edited files.

**Action:** Run `node --check` on the edited JS files to catch syntax errors. If `scripts/verify-phase2_1.js` runs without a live server, run it; otherwise skip and rely on syntax check + manual review.

**Done:** No syntax errors; orchestrator wiring imports cleanly.

## must_haves

- **truths:**
  - `entityHurt` bursts within 500ms produce one leading-edge `sei:attacked` emission, fired on the first hit.
  - When the Ollama circuit is open, `handleDispatch` issues exactly **one** Anthropic call per personality turn (not two).
  - When the circuit is closed (Ollama healthy), the two-call personality→movement flow is preserved unchanged.
  - The combined-call path can emit `say`, `setGoals`, `look`, and any movement-registry action (excluding `setGoals` duplication and `handOffToMovement`) in a single response, all dispatched through `registry.execute`.
- **artifacts:**
  - `src/llm/debounce.js` — exports a leading-edge throttle helper.
  - `src/behaviors/combat.js` — `attacked:*` path uses the leading-edge throttle.
  - `src/llm/orchestrator.js` — combined-call branch active when `circuit.isOpen()`.
- **key_links:**
  - `src/llm/orchestrator.js:128-141` (start / forced api-only)
  - `src/llm/orchestrator.js:184-297` (handleDispatch)
  - `src/behaviors/combat.js:66-86` (entityHurt handler)
  - `src/llm/debounce.js:1-19` (existing trailing-edge debouncer)
