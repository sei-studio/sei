---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-05-07T06:19:29.309Z"
progress:
  total_phases: 12
  completed_phases: 4
  total_plans: 22
  completed_plans: 19
  percent: 86
---

# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** Phase 03.1 — behavior-polish-and-ai-game-decoupling-refactor-analysis-dri

## Current Position

Phase: 03.1 (behavior-polish-and-ai-game-decoupling-refactor-analysis-dri) — EXECUTING
Plan: 1 of 10
Next: Phase 3 — Memory & Persistence

- **Phase:** 3 — Memory & Persistence
- **Plan:** Phase 2.1 complete (2.1-01, 2.1-02, 2.1-03 all done)
- **Status:** Executing Phase 03.1
- **Progress:** Phases 3/4 complete (incl. 2.1)
- **Next action:** /gsd-plan-phase 3.1 — analysis-driven behavior polish + AI/game decoupling

```
[DONE] Phase 1    Bot Substrate
[DONE] Phase 2    Two-Layer LLM Loop
[DONE] Phase 2.1  Expand Actions & Game State
[____] Phase 3    Memory & Persistence    ← next
[____] Phase 4    Electron GUI & Packaging
```

## Performance Metrics

- Requirements coverage: 36/36 (100%)
- Phases defined: 4
- Plans executed: 9
- Phases complete: 3 (incl. 2.1)

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
- Phase 3.1 inserted after Phase 3: Behavior polish and AI/game decoupling refactor (analysis-driven from logs/) (URGENT)

### Blockers

- None

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260429-nyx | API-only fallback → single combined Haiku call + leading-edge attack throttle | 2026-04-30 | 6468a3e | [260429-nyx-update-api-only-fallback-to-single-combi](./quick/260429-nyx-update-api-only-fallback-to-single-combi/) |
| 260429-ons | in_flight snapshot field + follow gates on action lifecycle + owner-chat preempts in-flight work + tighter action error strings + one-movement-type-per-turn rule | 2026-04-30 | 697f9a9 | [260429-ons-in-flight-snapshot-field-action-lifecycl](./quick/260429-ons-in-flight-snapshot-field-action-lifecycl/) |
| 260502-h6i | Sei latency + diary hallucination fixes: cache_control on last tool, no-op compaction skip, remove look tool, owner-chat preempt (sei:chat_received), stop-verb pre-LLM hard cancel | 2026-05-02 | ce7d90e | [260502-h6i-fix-sei-latency-owner-chat-preempt-stop-](./quick/260502-h6i-fix-sei-latency-owner-chat-preempt-stop-/) |
| 260503-1bu | Snapshot `recent_events:` deltas (kills, inventory gains, hp loss) + `prior_task:` interrupt-resume hint so bot resumes prior task after chat interrupt without reminder | 2026-05-03 | 1bbb67d | [260503-1bu-add-snapshot-delta-indicators-kills-inve](./quick/260503-1bu-add-snapshot-delta-indicators-kills-inve/) |
| 260503-1sk | Exposure-filter `nearby blocks:` (no more xray), add `around feet:` 5×4×5 grouped line, expand interesting set to terrain blocks (sand, sandstone, gravel, dirt, grass_block, …), and double radius when local view is sparse — fixes "get me 10 sand" failure on beach | 2026-05-03 | 5abc8a8 | [260503-1sk-snapshot-blocks-only-show-exposed-non-xr](./quick/260503-1sk-snapshot-blocks-only-show-exposed-non-xr/) |
| 260503-cli | Prod/dev chat mode split (only `say` reaches chat in prod, ≤15 words) + Sei=framework / character=Sui rebrand + light-blue `sei` CLI for onboarding/start/config + README rewrite | 2026-05-03 | cfe75b0 | [260503-cli-prod-chat-mode-rebrand](./quick/260503-cli-prod-chat-mode-rebrand/) |
| 260504-oh9 | Fix sei CLI silent exit under npx/global-install (entrypoint guard now realpath-resolves argv[1]) + first-run gate so `sei start`/`sei config` refuse without `config.json` + README switched to `npm link` + `sei` | 2026-05-04 | fdbc8ca | [260504-oh9-fix-sei-cli-entrypoint-guard-silent-exit](./quick/260504-oh9-fix-sei-cli-entrypoint-guard-silent-exit/) |
| 260505-iqo | Memory & loop architecture refactor: API-only collapse (drop ollama/circuit/handOffToMovement), convoMemory module with split owner/self ring buffers + loopHistory, idle-timing split into `sei:loop_end` + 60s fallback with per-event seed prompts, strict say/think separation | 2026-05-05 | 0a35318 | [260505-iqo-memory-and-loop-architecture-refactor-bu](./quick/260505-iqo-memory-and-loop-architecture-refactor-bu/) |
| 260505-twx | Sei behavior fixes: chat/full mode toggle (relay [think] in chat when full), snapshot tier-aware ranking (interesting-before-terrain) + 16-entry cap, dig-by-name tool description, P0 attack reaction (abort+restart with verbal-first seed), clearer dig error strings (no held-item suffix), iteration_cap 20→30, say() cadence rule (mandatory first/last turn, optional middle) | 2026-05-05 | ea9b342 | [260505-twx-sei-behavior-fixes-chat-full-mode-toggle](./quick/260505-twx-sei-behavior-fixes-chat-full-mode-toggle/) |

## Session Continuity

- **Last action:** Plan 03.1-07 complete (Bucket A gap-closure, Wave 2). Three tasks landed: (1) `postProcessSay` regex narrowed to keep `,` `!` `?` `'` `;` `:` and strip only `.` `—` `–` `"` `` ` `` per D-NEW-TONE-1; (2) new `shouldSuppressLoopEndSay` predicate + `convoMemory.recentChat.lastSelf()` accessor wired into the say() handler with 2s window for byte-equal-after-normalize duplicates on `sei:loop_end` loops (D-NEW-DM-1/2/3); (3) `gracefulCapClose` now strengthens the seed prompt, runs the model output through `postProcessSay`, bumps timeout to ≥8000ms, and logs distinct info/warn lines so post-replay tells us which path fired (D-W-8 / D-NEW-TONE-2). Commits: 607607f, 35cfb48, f1386e2, 7cfd7f3.
- **Next action:** Continue Phase 03.1 gap-closure — plans 03.1-08 / 03.1-09 / 03.1-10 remain in Bucket A.

---
*Last updated: 2026-05-07 — plan 03.1-07 completed (gap-closure: D-NEW-TONE-1, D-NEW-DM-1/2/3, D-W-8/D-NEW-TONE-2).*
| 2026-05-03 | fast | attack pursues + zod entity schema cleanup | done |
| 2026-05-05 | fast | docs cleanup: remove two-layer/ollama from README+ARCHITECTURE | done |
| 2026-05-05 | fast | drop port from persisted config; LAN discovery is the only path | done |
