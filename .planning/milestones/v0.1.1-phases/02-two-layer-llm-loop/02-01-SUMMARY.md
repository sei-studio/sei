---
phase: 02-two-layer-llm-loop
plan: "01"
subsystem: llm-primitives
tags: [llm, anthropic, ollama, config, persona, zod, json-schema]
requires:
  - src/registry.js (Phase 1 closed action registry)
provides:
  - src/config.js (extended ConfigSchema: persona/anthropic/ollama/llm blocks)
  - src/llm/persona.js (renderPersona, capHitLine)
  - src/llm/schemaBridge.js (buildAnthropicTools, buildOllamaTools)
  - src/llm/anthropicClient.js (createAnthropicClient: call, buildCachedSystem)
  - src/llm/ollamaClient.js (createOllamaClient: call, probe)
affects:
  - Wave 2 orchestrator will compose these primitives via LLMRequest -> LLMResponse
tech-stack:
  added:
    - "@anthropic-ai/sdk@^0.91.1"
    - "ollama@^0.6.3"
    - "zod-to-json-schema@^3.25.2"
  patterns:
    - "Cached 3-block Anthropic system prefix; cache_control ephemeral on LAST block (D-18)"
    - "Per-call Ollama instance to isolate abort() (Pitfall 3)"
    - "AbortSignal chained into per-call AbortController + wall-clock timeout"
key-files:
  created:
    - src/llm/persona.js
    - src/llm/schemaBridge.js
    - src/llm/anthropicClient.js
    - src/llm/ollamaClient.js
  modified:
    - src/config.js
    - package.json
    - package-lock.json
decisions:
  - "Default Anthropic model claude-haiku-4-5-20251001 (Haiku 3 retired April 2026 — D-20)"
  - "Default Ollama model qwen3.5:7b-instruct (non-instruct emits thinking traces — D-21)"
  - "ANTHROPIC_API_KEY env var fallback in loadConfig() keeps schema strict"
  - "persona + anthropic blocks REQUIRED (no defaults); ollama + llm default to {}"
metrics:
  duration: ~10min
  completed: "2026-04-25"
  tasks: 3
  files_changed: 7
---

# Phase 2 Plan 01: LLM Primitives (Config + Persona + Bridge + Clients) Summary

Provider-agnostic LLM primitives — extended config schema with persona/anthropic/ollama/llm blocks, Zod->JSON Schema bridge, and Anthropic + Ollama clients with timeouts and AbortSignal — ready for Wave 2 orchestrator composition.

## What Was Built

- **Config extension (`src/config.js`):** Added `persona` (name/backstory/tone), `anthropic` (api_key/model/timeout_ms), `ollama` (host/model/timeout_ms), `llm` (rate_limit_per_min/debounce_ms/max_hops/idle_fallback_ms) blocks. `loadConfig()` falls back to `ANTHROPIC_API_KEY` env var.
- **Persona renderer (`src/llm/persona.js`):** `renderPersona()` builds stable cached prefix text; `capHitLine()` returns tone-aware pre-rendered cap-hit messages (D-12, no LLM call).
- **Schema bridge (`src/llm/schemaBridge.js`):** `buildAnthropicTools()` and `buildOllamaTools()` convert Phase 1 registry Zod schemas into provider-specific tool shapes via `zod-to-json-schema`.
- **Anthropic client (`src/llm/anthropicClient.js`):** `messages.create` with 3-block cached system prefix (cache_control ephemeral on last block per D-18), AbortSignal + 20s default timeout, returns `{toolUses, text, usage, stopReason}`.
- **Ollama client (`src/llm/ollamaClient.js`):** Per-call `new Ollama()` instance (Pitfall 3), 2s `/api/tags` probe, 30s default chat timeout, AbortSignal chained into per-call AbortController firing `client.abort()`.

## Verification Results

- All three task verify commands printed `OK`
- `node -e "import('./src/bot.js').then(m => console.log(typeof m.start))"` -> `function` (Phase 1 still works)
- `grep -r "claude-3-haiku\|claude-3-5-haiku" src/` -> no matches (retired models absent)
- `grep -r "qwen2.5\|qwen-2.5" src/` -> no matches (D-21 instruct-only)
- Missing-persona config rejected by schema as required

## Commits

- `12401b6` feat(02-01): extend config schema with persona/anthropic/ollama/llm blocks
- `f3130be` feat(02-01): add persona renderer and Zod->JSON Schema bridge
- `ced3e9e` feat(02-01): add Anthropic and Ollama clients with timeouts and AbortSignal

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/config.js: FOUND
- src/llm/persona.js: FOUND
- src/llm/schemaBridge.js: FOUND
- src/llm/anthropicClient.js: FOUND
- src/llm/ollamaClient.js: FOUND
- Commits 12401b6, f3130be, ced3e9e: FOUND
