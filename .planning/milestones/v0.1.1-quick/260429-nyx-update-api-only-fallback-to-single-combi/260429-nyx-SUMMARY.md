---
quick_id: 260429-nyx
status: complete
date: 2026-04-30
---

# Quick Task 260429-nyx — Summary

## Goal
Halve API-only fallback latency by collapsing the personality + movement hops into a single Haiku call, and add a leading-edge throttle so the first hit of an attack burst triggers an LLM dispatch immediately while rapid follow-ups within 500 ms are suppressed.

## Changes

- **`src/llm/debounce.js`** — added `createThrottle(windowMs)` factory exposing `throttle(key, payload, fire)`. First call per key fires immediately and arms a cooldown; subsequent calls within the window are dropped. The pre-existing trailing-edge `createDebouncer` is unchanged and still used for chat ingress (where waiting for the burst to settle is desirable).
- **`src/behaviors/combat.js`** — `entityHurt` handler now calls `bot._seiAttackThrottle.throttle('attacked:<attacker>', …)` instead of the trailing debouncer. Net effect: a 100 ms-spaced double hit produces exactly one `sei:attacked` emission, and that emission lands on the *first* hit (no 500 ms latency).
- **`src/bot.js`** — wires `bot._seiAttackThrottle = orchestrator.throttle` next to the existing debouncer attachment.
- **`src/llm/orchestrator.js`**:
  - New `COMBINED_SYSTEM` prompt that frames Haiku as both decider and executor.
  - New `combinedToolsFor()` that merges personality tools (sans `handOffToMovement`) with movement registry tools (registry already excludes `setGoals`).
  - Cached system blocks duplicated as `cachedCombinedSystemBlocks` so the combined path also benefits from prompt caching (same 5-block structure, cache_control on the tool list).
  - New `callCombined(userBlock, signal)` issues one Anthropic call with the merged tool set.
  - `handleDispatch` now branches on `circuit.isOpen()`. The combined branch:
    1. Single hop bump.
    2. One `callCombined` request.
    3. Dispatches `say` / `setGoals` inline; treats `look` as a no-op when paired with movement, otherwise marks `lastActionResult = 'looked'`.
    4. Routes any remaining tool uses (everything except `say` / `setGoals` / `look` / `handOffToMovement`) through `registry.execute()` with the same `_chainId` / `signal` plumbing as the two-call path.
    5. Leaves the chain open for completion-event continuations (60s TTL sweep applies).
  - The two-call (`callPersonality` + `callMovement`) path is preserved verbatim for the Ollama-healthy case.
  - `_internal` now exposes `callCombined` for tests.

## Verification

- `node --check` clean on `src/llm/debounce.js`, `src/llm/orchestrator.js`, `src/behaviors/combat.js`, `src/bot.js`.
- Tracing `handleDispatch` confirms one Anthropic call per chain hop when the circuit is open vs two when closed.
- Combat handler still drives `startAttacking` / `_exitTimer` independently of the throttle, so the bot keeps swinging even when a follow-up hit is suppressed at the LLM-dispatch layer.

## Notes / follow-ups

- The post-tool validator hook flagged `setTimeout` usage on the pre-existing Ollama-probe retry as if this were a Vercel Workflow sandbox file. Sei is a Node.js Mineflayer utilityProcess, not Vercel Workflow code; the hook is misclassifying the project. The flagged line is unchanged and correct for this runtime.
- `circuit.isOpen()` is evaluated *before* the personality call rather than after. If the circuit trips during a chain (e.g., Ollama dies mid-flight), the next dispatch picks up the combined path; we don't try to recover within a single chain.
- Throttle window reuses `config.llm.debounce_ms` (default 500 ms). If a combat-specific window becomes desirable later, add a separate config field.
