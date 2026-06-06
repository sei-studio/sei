---
phase: 02-two-layer-llm-loop
plan: "02"
subsystem: llm-orchestrator
tags: [orchestrator, hop-cap, rate-limit, debounce, circuit-breaker, goals, fallback]
requires:
  - src/llm/anthropicClient.js (Wave 1)
  - src/llm/ollamaClient.js (Wave 1)
  - src/llm/persona.js (Wave 1)
  - src/llm/schemaBridge.js (Wave 1)
  - src/registry.js (Phase 1 + setGoals extension)
provides:
  - src/llm/goals.js (createGoalStore)
  - src/llm/rateLimiter.js (createTokenBucket)
  - src/llm/debounce.js (createDebouncer)
  - src/llm/circuit.js (createOllamaCircuit)
  - src/llm/chains.js (createChainTracker)
  - src/llm/orchestrator.js (createOrchestrator)
  - src/registry.js (setGoals action)
affects:
  - Wave 3 will wire orchestrator.handleDispatch into the FSM sei:dispatch event
tech-stack:
  added: []
  patterns:
    - "Chain-scoped hop tracker — counts hops across handleDispatch re-entries via _chainId, closes LLM-04 leak"
    - "Two-state Ollama circuit (qwen / haiku-fallback), trips at 3 consecutive failures, no half-open (D-14)"
    - "Token bucket: 30/min capacity + refill on personality call site"
    - "Pre-rendered cap-hit chat line — no extra LLM call when hop cap trips (D-12)"
    - "Personality LLM tools strictly limited to say/handOffToMovement/setGoals; mineflayer registry actions reserved for movement layer (D-04)"
key-files:
  created:
    - src/llm/goals.js
    - src/llm/rateLimiter.js
    - src/llm/debounce.js
    - src/llm/circuit.js
    - src/llm/chains.js
    - src/llm/orchestrator.js
  modified:
    - src/registry.js
decisions:
  - "Hop counter is chain-scoped (keyed by _chainId), not per-dispatch — closes LLM-04 leak where FSM completion events could re-enter the orchestrator without tripping the cap"
  - "Chain TTL 60s sweeps abandoned chains if end() is missed (e.g. orchestrator crash mid-chain)"
  - "setGoals lives in the registry (uniform Zod validation) but is invoked only by the personality layer; movement subRegistry filters it out"
  - "Cap-hit emits capHitLine via bot.chat directly — never another LLM call"
  - "Startup probe trips circuit on failure, executor remains haiku-fallback for the session (D-13)"
metrics:
  duration: ~7min
  completed: "2026-04-25"
  tasks: 2
  files_changed: 7
---

# Phase 2 Plan 02: Orchestrator + Primitives Summary

Composes Wave 1 LLM clients into a single `createOrchestrator()` with chain-scoped hop cap, token-bucket rate limit, Ollama circuit breaker with Haiku fallback, in-memory goal store, and a `setGoals` registry action — Wave 3 ready as pure FSM wiring.

## What Was Built

- **Goal store (`src/llm/goals.js`):** in-memory `owner_goals` / `self_goals` with dedupe; mutated only via the `setGoals` registry action (D-06/D-07).
- **Token bucket (`src/llm/rateLimiter.js`):** capacity + refill-per-min, `tryAcquire`/`awaitAcquire`. Backstops cost on the personality call site (LLM-06).
- **Debouncer (`src/llm/debounce.js`):** per-key 500ms coalesce, last payload wins. Wave 3 wires it into bot event ingestion (LLM-05).
- **Ollama circuit (`src/llm/circuit.js`):** two-state (qwen / haiku-fallback), trips at 3 consecutive failures; `trip()` for startup probe failures; no half-open (D-13/D-14).
- **Chain tracker (`src/llm/chains.js`):** chain-scoped hop tracker. Each chain has its own `{hops, deadline, seedEvent}` record keyed by an opaque `chainId`. Closes the LLM-04 leak where prior per-dispatch counting let degenerate FSM-completion-driven loops exceed 5 logical hops without tripping. TTL (60s) sweeps abandoned chains.
- **`setGoals` registry action (`src/registry.js`):** Zod schema `{list:'owner'|'self', op:'add'|'remove', goal:string}`; mutates `config._goalStore` (orchestrator threads its goal store through on every personality-driven invocation).
- **Orchestrator (`src/llm/orchestrator.js`):** single `handleDispatch(event, data, signal)` entry. Personality call → say / setGoals / handOffToMovement → movement call (Ollama or Anthropic-fallback) → registry.execute on each tool_call with `{...config, _goalStore, _chainId, signal}`. Cap-hit emits `capHitLine(config.persona)` directly via `bot.chat`, never another LLM call. Startup probe (3 retries × 2s) trips the circuit if Ollama unreachable.

## Verification Results

- Task 1 verify: `OK` — covers goal-store dedupe, token-bucket exhaustion (2-token capacity → third `tryAcquire` returns false), debouncer coalescing 3 calls into 1 with last payload, circuit trip on exactly the 3rd failure, chain tracker reporting `capped` only on the 6th increment.
- Task 2 verify: `OK` — `createDefaultRegistry().list()` includes both `goTo` and `setGoals`; orchestrator exposes `start`, `handleDispatch`, `executorStatus === 'qwen'`, `goals.add`, `_internal.chains.begin`; `registry.execute('setGoals', ...)` mutates the orchestrator's goal store.
- All grep acceptance checks pass: `setGoals` ≥2 in registry.js (registration + handler), `createOrchestrator` ≥1, chain wiring ≥3 (got 4), `_chainId` ≥2, personality-tool names ≥3, `config.llm.max_hops` =1, movement-side `n !== 'setGoals'` =1, `capHitLine(config.persona)` =1, **no `let hops`** local counter (=0).
- Regression: `grep -r "claude-3-haiku\|claude-3-5-haiku\|qwen2\.5" src/` → no matches.

## Commits

- `9fe7165` feat(02-02): add goal store, token bucket, debouncer, circuit, chain tracker primitives
- `457b869` feat(02-02): add setGoals registry action and orchestrator core

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/llm/goals.js: FOUND
- src/llm/rateLimiter.js: FOUND
- src/llm/debounce.js: FOUND
- src/llm/circuit.js: FOUND
- src/llm/chains.js: FOUND
- src/llm/orchestrator.js: FOUND
- src/registry.js (modified, contains setGoals): FOUND
- Commit 9fe7165: FOUND
- Commit 457b869: FOUND
