# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** Phase 1 — Bot Substrate (mineflayer + action registry + FSM, no LLMs)

## Current Position

- **Phase:** 1 — Bot Substrate
- **Plan:** 01-01 complete; 01-02, 01-03 remaining
- **Status:** Executing Phase 1
- **Progress:** Phases 0/4 complete (Phase 1 in progress, 1/3 plans done)

```
[PLAN] Phase 1  Bot Substrate         ← current
[____] Phase 2  Two-Layer LLM Loop
[____] Phase 3  Memory & Persistence
[____] Phase 4  Electron GUI & Packaging
```

## Performance Metrics

- Requirements coverage: 36/36 (100%)
- Phases defined: 4
- Plans executed: 1
- Phases complete: 0

## Accumulated Context

### Decisions (from PROJECT.md / research)

- Two-layer LLM: Haiku 3 personality + Ollama Qwen 2.5 movement, natural-language hand-off
- Closed Zod-typed action registry; LLM never generates code or coordinates
- Event-sourced FSM with priority queue; one outstanding action tracked by AbortController
- better-sqlite3 for persistence; LLM-directed compaction at semantic boundaries
- Three-process Electron: main ↔ renderer (React) ↔ utilityProcess (mineflayer + orchestrator)
- Screenshot / vision deferred to v2 (requires Haiku 3.5 + macOS permission UX)

### Todos

- Run 01-02-PLAN.md (pathfinder wrapper, action registry, reflex behaviors)
- Run 01-03-PLAN.md (FSM with priority queue, AbortController, behavior wiring)
- Parallel spike: Qwen tool-calling reliability (de-risk Phase 2)
- Parallel spike: native-module packaging (de-risk Phase 4)
- Parallel task: start Apple Developer / Windows EV cert applications (lead time)

### Blockers

- None

## Session Continuity

- **Last action:** Phase 1 plan 01 executed — project scaffold, config schema, bot connection with reconnect loop (2 tasks, 6 files)
- **Next action:** Execute 01-02-PLAN.md (pathfinder wrapper, action registry, reflex behaviors)

---
*Last updated: 2026-04-24 after Phase 1 plan 01 execution*
