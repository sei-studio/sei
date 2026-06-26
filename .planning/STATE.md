---
gsd_state_version: 1.0
milestone: v0.4
milestone_name: Minimum Desirable Companion
status: Defining requirements
last_updated: "2026-06-26T00:50:10.452Z"
last_activity: 2026-06-25 -- Milestone v0.4 started
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
---

# State: Sei

## Project Reference

- **Core Value:** A gaming companion that feels like a real character — it remembers you across chat and play, reacts with personality, and is worth spending time with whether or not you open Minecraft.
- **Current Focus:** Milestone v0.4 — Minimum Desirable Companion (defining requirements)

> This is the **client** state. The hosted cloud backend (proxy server, auth/billing/moderation) lives in a separate private repo and is referenced here only at a high level.

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-06-25 -- Milestone v0.4 started

## Phase Progress

| Phase | Status |
|-------|--------|
| 16. Persona & Memory Core | Not started |
| 17. Minecraft Competence | Not started |
| 18. Brain–Surface Decoupling + In-App Chat | Not started |
| 19. UI Overhaul | Not started |
| 20. ElevenLabs Voice | Not started |
| 21. Minigames + GeoGuessr | Not started |

## Accumulated Context

### Locked Decisions (from research + user)

**v0.4 (this milestone):**

1. **Brain–surface decoupling.** One persona+memory "brain" attaches to a "surface" (Minecraft world / in-app text chat / voice call / minigame). The brain is shared; each surface supplies its own context blocks + output channel.
2. **Cross-surface continuity = shared memory + handoff bridge.** Durable facts flow through the shared on-disk memory store; transient "what we were just doing" is summarized into a compact bridge at a surface switch. Raw transcripts are NOT dragged across.
3. **Prompt-cache layout:** `[baseline + persona + memory snapshot]` (always cached, survives switches) → `[interface rules]` (re-cached per surface switch) → `[chat history]` (re-cached per switch) → `[ongoing memory + new messages]` (tail; only new turn written). Memory is a **frozen-per-session snapshot** seeded once at session start, NOT re-ranked every turn (re-ranking would invalidate the cache each turn). Memory the companion writes mid-session appends to the tail. Long conversation buffer is fine — messages are short and cheap.
4. **Persona drift is attention-decay**, fixed by per-turn re-injection of a compressed persona core at max recency + a few-shot of `say()` voice examples (which generalize), NOT hardcoded scenario scripts (which don't).
5. **Memory upgrade:** scored retrieval (recency + importance + relevance; importance rated at write time) replacing byte-truncation seeding. Perceived rapport comes from **fact-recall callbacks**, not affinity meters.
6. **The agent decides when to "launch" a game** — a `launch_game`/`start_session` tool in the chat surface makes the "invite you to play" loop literal.
7. **Voice and text/in-game chat are mutually exclusive.** When voice is on, text chat + in-game chat box are off. The model knows whether output is spoken vs typed and adjusts formality while staying in character. Voice = ElevenLabs, voice chosen by personality.
8. **Required minigame: a GeoGuessr clone** (random street/earth scene → map guess → score + timer). Plus 1–2 more simple LLM-playable games. Different personas/models should show varied strategy + skill.
9. **Usage UI:** keep the plain % ring; **drop** the playtime-hours estimate (chat/voice/MC/minigames burn at different rates, so a single time estimate is misleading). Not a focus area.
10. **Dynamic tone state machine is deferred** — out of scope for v0.4.

**Carried from v0.3 (still binding):**

11. Closed action registry stays closed — the LLM dispatches typed actions, never code or coordinates.
12. Two backends (local BYOK + cloud proxy); cloud routes through `api.sei.gg`. Runtime memory stays local-only.

### Notes

- **v0.3 shipped** (Phases 10–15: auth, cloud library, sharing+moderation, billing+% UI, multi-provider, vision). Phase 12 (Browse) remains code-complete behind a capabilities flag pending operator rollout (DMCA registration, moderation backfill, config flip).
- **Planned v0.3 Phase 16 (mod/version adapter) was dropped** — feasibility investigation found modded Minecraft needs solving mineflayer's vanilla-only registry ingestion (issue #700) plus per-mod protocol code; payoff too small and it shrinks the userbase. Superseded by v0.4.
- **Deep research front-loaded into the roadmap** (this milestone is research-heavy per user). **All 7 streams complete**, full reports in `.planning/research/v0.4-*.md`, synthesized into ROADMAP.md "Research Findings": Phase 17 = `mc-llm-planning`, `mc-mineflayer-skills`, `mc-rl-hybrid`; Phase 16 = `companion-personality-memory`, `persona-prompting-and-steering`, `memory-and-relationship`; Phase 21 = `varied-behavior-and-minigames`.
- Phase 17 research verdict: pixel-RL (VPT/STEVE-1/GROOT/DreamerV3) is incompatible with mineflayer's protocol control surface; adopt the hybrid hierarchy via classical game-AI (GOAP + Behavior Trees + Utility AI + steering). Highest-leverage item = a 20Hz reactive threat/combat micro-controller. **Critical blocker to verify first: `bot.activateItem()` broken on MC 1.21+ (mineflayer #3742) — affects eating/shield/bow.**

### Open Todos

- v0.4 milestone setup complete (PROJECT/REQUIREMENTS/ROADMAP + 7 research streams). Next: `/gsd:plan-phase 16` (or `/gsd:discuss-phase 16`).
- Operator-side v0.3 Phase 12 Browse rollout (see Phase 12 summary).

### Blockers

None.

## Session Continuity

**v0.3 (Commercializable MVP, Phases 10–15) shipped.** The planned Phase 16 mod adapter was dropped after a feasibility investigation.

**Milestone v0.4 — Minimum Desirable Companion is being defined.** It makes the companion compelling within vanilla Minecraft and accessible beyond it, by decoupling the persona+memory brain from the mineflayer surface (chat / voice / minigame surfaces) with memory continuous across all of them. Six phases (16–21): Persona & Memory Core → Minecraft Competence → Brain–Surface Decoupling + In-App Chat ‖ UI Overhaul → Voice → Minigames.

**Next action:** finish REQUIREMENTS.md, then create the ROADMAP via the roadmapper.
