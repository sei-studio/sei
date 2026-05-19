---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Commercializable MVP
status: planning
last_updated: "2026-05-19T07:41:41.349Z"
last_activity: 2026-05-19
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** v1.0 Commercializable MVP — promote v0.1.1 local prototype to cloud accounts, shared character library, hosted AI billing, broader model support, in-game vision, and universal mod compatibility.

## Current Position

Phase: 10 (Auth Foundation) — not started
Plan: —
Status: Roadmap drafted; awaiting user approval to begin planning Phase 10
Last activity: 2026-05-19 — ROADMAP.md written, 67/67 requirements mapped across Phases 10–16

## Phase Progress

| Phase | Status |
|-------|--------|
| 10. Auth Foundation | Not started |
| 11. Cloud Character Library | Not started |
| 12. Character Sharing UI + Moderation | Not started |
| 13. AI Proxy + Billing + Usage UI | Not started |
| 14. Multi-Provider Model Abstraction | Not started |
| 15. In-Game Vision via prismarine-viewer | Not started |
| 16. Mod & Version Adapter Pipeline | Not started |

## Accumulated Context

### Locked Decisions (from research + user)

1. Vision = bot-POV via `prismarine-viewer` headless render. No OS capture. No Fabric mod for vision.
2. Mod adapters = keybind-scan → LLM filter → LLM recipe writer → declarative recipes only. No code execution.
3. Payments = Lemon Squeezy as Merchant of Record. No LLC for v1.0.
4. Cloud sync = character definition only. Runtime memory stays local.
5. Modded textures live in Phase 16 (Mod Adapter), not Phase 15 (Vision).
6. Proxy ships first as `baseURL` override before full multi-provider refactor.

### Phase 13 Two-Sub-Delivery Pattern

Phase 13 plans TWO sub-deliveries explicitly:
- (a) Proxy as `baseURL` + `Authorization` header override to existing `anthropicClient.js` (~10 lines) — ships before Phase 14
- (b) Re-touch as `LlmProvider` variant after Phase 14 lands

### Decisions To Log

None yet.

### Open Todos

- User approval of ROADMAP.md → run `/gsd-plan-phase 10`

### Blockers

None.

## Session Continuity

Last action: Roadmap creation for v1.0 milestone — 7 phases (10–16), 67 requirements, 100% coverage.

Next action: User approves roadmap → `/gsd-plan-phase 10` (Auth Foundation).
