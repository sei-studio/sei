---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Commercializable MVP
status: executing
last_updated: "2026-06-10T09:24:56.663Z"
last_activity: 2026-06-10 -- Phase 15 execution started
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 77
  completed_plans: 70
  percent: 91
---

# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** Phase 15 — in-game-vision-via-prismarine-viewer

> This is the **client** state. The hosted cloud backend (proxy server, auth/billing/moderation) lives in a separate private repo and is referenced here only at a high level.

## Current Position

Phase: 15 (in-game-vision-via-prismarine-viewer) — EXECUTING
Plan: 1 of 7
Status: Executing Phase 15
Last activity: 2026-06-10 -- Phase 15 execution started

## Phase Progress

| Phase | Status |
|-------|--------|
| 10. Auth Foundation | Complete (9/9 plans) |
| 11. Cloud Character Library | Complete (19/19 plans) |
| 12. Character Sharing UI + Moderation | Code complete (18/18 plans); awaiting operator rollout |
| 13. AI Proxy + Billing + Usage UI | Complete (23/23 plans) |
| 14. Multi-Provider Model Abstraction | Complete (1/1 plans); reduced scope per user directive |
| 15. In-Game Vision via prismarine-viewer | Planned (7 plans, ready to execute) |
| 16. Mod & Version Adapter Pipeline | Not started |

## Accumulated Context

### Locked Decisions (from research + user)

1. Vision = bot-POV via `prismarine-viewer` headless render. No OS capture. No Fabric mod for vision.
2. Mod adapters = keybind/item scan → LLM filter → LLM recipe writer → declarative recipes only. No code execution.
3. Cloud sync = character definition only. Runtime memory (`OWNER.md`, `DIARY.md`) stays local.
4. Modded textures live in Phase 16 (Mod Adapter), not Phase 15 (Vision).
5. Cloud-AI routing shipped first as a `baseURL` override before the full multi-provider refactor.
6. The hosted cloud backend lives in a separate private repo; this client integrates with it over HTTPS at `api.sei.gg`.

### Notes

- **Phase 12** is CODE COMPLETE but not yet live to users — Browse stays behind a capabilities flag until an operator completes the rollout runbook (DMCA registration, backend secret provisioning, moderation backfill, then the config flip). Tracked in the Phase 12 summary.
- **Phase 14** shipped the `LlmProvider` factory + adapters only. Deferred to backlog (tracked in the Phase 14 context): the list-style onboarding model picker, per-provider $/hr CI benchmark, per-provider caching observability, and Zod re-validation at the adapter boundary. Anthropic remains the default so existing configs boot unchanged.

### Open Todos

- Run `/gsd-execute-phase 15` (In-Game Vision).
- Operator-side Phase 12 Browse rollout (see Phase 12 summary).

### Blockers

None.

## Session Continuity

**Phases 10–14 complete.** Auth, cloud character library, sharing UI + moderation surfaces, hosted AI billing + % usage UI, and the multi-provider `LlmProvider` abstraction have all landed. Phase 12 is code-complete and gated behind a capabilities flag pending an operator rollout.

**Phase 15 (In-Game Vision via prismarine-viewer) is planned and is the active focus.** It adds bot-POV rendering, a capability-gated `visualize` Zod action, opt-in idle auto-render with a custom line-of-sight helper, and a per-hour vision cap (enforced server-side for cloud-AI users). The native-ABI render spike gates all feature waves.

**Next action:** `/gsd-execute-phase 15`.
