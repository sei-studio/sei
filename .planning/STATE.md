# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** Phase 1 — Bot Substrate (mineflayer + action registry + FSM, no LLMs)

## Current Position

- **Phase:** 1 — Bot Substrate
- **Plan:** 01-01, 01-02, 01-03 complete
- **Status:** Phase 1 complete; ready for Phase 2
- **Progress:** Phases 1/4 complete

```
[DONE] Phase 1  Bot Substrate
[____] Phase 2  Two-Layer LLM Loop    ← next
[____] Phase 3  Memory & Persistence
[____] Phase 4  Electron GUI & Packaging
```

## Performance Metrics

- Requirements coverage: 36/36 (100%)
- Phases defined: 4
- Plans executed: 3
- Phases complete: 1

## Accumulated Context

### Decisions (from PROJECT.md / research)

- Two-layer LLM: Haiku 3 personality + Ollama Qwen 2.5 movement, natural-language hand-off
- Closed Zod-typed action registry; LLM never generates code or coordinates
- Event-sourced FSM with priority queue; one outstanding action tracked by AbortController
- better-sqlite3 for persistence; LLM-directed compaction at semantic boundaries
- Three-process Electron: main ↔ renderer (React) ↔ utilityProcess (mineflayer + orchestrator)
- Screenshot / vision deferred to v2 (requires Haiku 3.5 + macOS permission UX)
- mineflayer-pathfinder goals accessed via default export interop (named ESM export unavailable)
- mineflayer-auto-eat plugin exposed as 'loader' named export, not default
- chat.js uses bot.username for addressed-check to match actual in-game bot name

### Todos

- Plan and execute Phase 2 (Two-Layer LLM Loop)
- Parallel spike: Qwen tool-calling reliability (de-risk Phase 2)
- Parallel spike: native-module packaging (de-risk Phase 4)
- Parallel task: start Apple Developer / Windows EV cert applications (lead time)

### Blockers

- None

## Session Continuity

- **Last action:** Phase 1 plan 03 executed — event-sourced FSM, priority queue, AbortController, behavior wiring (2 tasks, 2 files)
- **Next action:** Plan and execute Phase 2 (Two-Layer LLM Loop)

---
*Last updated: 2026-04-24 after Phase 1 plan 03 execution — Phase 1 complete*
