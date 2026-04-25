---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-25T23:30:00.000Z"
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 6
  completed_plans: 6
  percent: 100
---

# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** Phase 2.1 — Expand Actions & Game State (INSERTED, urgent) before Phase 3

## Current Position

Phase: 02 (two-layer-llm-loop) — COMPLETE (3/3 plans)
Next: Phase 3 — Memory & Persistence (or insert Phase 2.5 for action-registry expansion first)

- **Phase:** 3 — Memory & Persistence (next), or Phase 2.5 (action-registry expansion) if inserted
- **Plan:** Phase 2 complete (02-01, 02-02, 02-03 all done)
- **Status:** Phase 2 complete; awaiting Phase 2.5 insertion or Phase 3 kickoff
- **Progress:** Phases 2/4 complete
- **Next action:** `/gsd-insert-phase 2.5` to plan action-registry expansion (mining, inventory, follow-gating), OR `/gsd-discuss-phase 3` to begin memory work directly.

```
[DONE] Phase 1  Bot Substrate
[DONE] Phase 2  Two-Layer LLM Loop
[____] Phase 3  Memory & Persistence    ← next (or insert 2.5 first)
[____] Phase 4  Electron GUI & Packaging
```

## Performance Metrics

- Requirements coverage: 36/36 (100%)
- Phases defined: 4
- Plans executed: 6
- Phases complete: 2

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
- Default Anthropic model claude-haiku-4-5-20251001 (Haiku 3 retired April 2026, D-20)
- Default Ollama model qwen3.5:7b-instruct (non-instruct emits thinking traces, D-21)
- ANTHROPIC_API_KEY env-var fallback supported in loadConfig (schema stays strict)
- Per-call new Ollama() instance to isolate abort() scope (Pitfall 3)
- Anthropic cached system prefix: 3 blocks, cache_control ephemeral on LAST block (D-18)
- Hop counter is chain-scoped (keyed by _chainId) not per-dispatch — closes LLM-04 leak across FSM completion re-entries
- Personality LLM tools restricted to say/handOffToMovement/setGoals; mineflayer registry actions reserved for movement layer (D-04)
- setGoals lives in the registry but movement subRegistry filters it out

### Todos

- Plan and execute Phase 2 (Two-Layer LLM Loop)
- Parallel spike: Qwen tool-calling reliability (de-risk Phase 2)
- Parallel spike: native-module packaging (de-risk Phase 4)
- Parallel task: start Apple Developer / Windows EV cert applications (lead time)

### Roadmap Evolution

- Phase 2.1 inserted after Phase 2: Expand action registry beyond goTo/setGoals and surface inventory/surroundings/position to personality LLM as text (URGENT). Conflict-checked against Phase 3 (Memory) and Phase 4 (GUI) — no overlap; Phase 3 still owns SQLite persistence and compaction.

### Blockers

- None

## Session Continuity

- **Last action:** Gathered context for Phase 2.1 (Expand Actions & Game State). 16 decisions locked (D-22..D-37) covering action set, targeting model, observation snapshot, capability overview, movement-LLM contract, failure feedback, and the "still learning, asks the human" persona trait. CONTEXT.md + DISCUSSION-LOG.md written and committed.
- **Next action:** `/gsd-plan-phase 2.1` to research and plan the phase.

---
*Last updated: 2026-04-25 — Phase 2.1 context gathered.*
