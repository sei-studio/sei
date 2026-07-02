---
project: sei
---

# Milestones

| Version | Status      | Shipped    | Archive |
|---------|-------------|------------|---------|
| v0.4    | In progress | —          | (current — see ROADMAP.md) |
| v0.3    | Released    | 2026-06-10 | [ROADMAP](milestones/v0.3-ROADMAP.md) · [REQUIREMENTS](milestones/v0.3-REQUIREMENTS.md) · phases 10–15 in `phases/` |
| v0.1.1  | Released    | 2026-05-18 | [ROADMAP](milestones/v0.1.1-ROADMAP.md) · [REQUIREMENTS](milestones/v0.1.1-REQUIREMENTS.md) · [phases](milestones/v0.1.1-phases/) · [quick](milestones/v0.1.1-quick/) |

> **Version trajectory.** Sei's milestones climb toward **v1.0 = a companion that can play nearly any game**. v0.1.1 was the first Minecraft release; **v0.3** made it a commercializable Minecraft agent; **v0.4** turns it into an *agentic gaming companion* that is compelling beyond Minecraft. (The v0.3 milestone was authored under the working label "v1.0 — Commercializable MVP"; it was renumbered to v0.3 when the v1.0 target was redefined as omni-game. Archived v0.3 docs retain the original "v1.0" wording internally.)

## v0.4 — Minimum Desirable Companion (in progress)

Makes the companion as emotionally compelling as possible within vanilla Minecraft's limited appeal, and stops the product from being gated behind "must play Minecraft." Four problems: **in-game capability** (the agent isn't as competent as SOTA Minecraft bots — no furnace use, no proactive mob awareness, weak combat/structures), **personalization** (memory is on-demand and never actively referenced; the relationship doesn't evolve), **personality** (weak persona prompts; users describe characters badly and personas drift), and **accessibility** (only reachable by Minecraft players, when the real pitch is companionship/emotional connection).

The load-bearing move is **decoupling the persona+memory "brain" from the mineflayer "surface"** so a companion can be alive in an in-app text chat, voice call, or minigame — not just in a world — with memory continuous across all of them. Adds: a stronger persona/memory core, expanded Minecraft competence, in-app chat, ElevenLabs voice, and a small set of LLM-playable minigames (incl. a GeoGuessr clone). See `ROADMAP.md` and `REQUIREMENTS.md`.

## v0.3 — Commercializable MVP (Minecraft agent)

Promoted Sei from a working local prototype to a commercializable Minecraft agent: user accounts (email/password + Google), a cloud-authoritative character library with local cache-on-demand, c.ai-style character sharing with moderation, hosted AI billing with a friendly % usage indicator, a multi-provider `LlmProvider` abstraction, and in-game bot-POV vision via `prismarine-viewer`. Phases 10–15 shipped. The planned Phase 16 (declarative mod/version adapter pipeline) was **dropped** after a feasibility investigation found modded support requires solving mineflayer's vanilla-only registry-ingestion limitation plus per-mod protocol code — out of proportion to its payoff — and was superseded by the v0.4 direction.

The hosted cloud backend (proxy server, auth/billing/moderation infrastructure) lives in a separate private repo and is referenced from these planning docs only at a high level.

## v0.1.1 — first public release

Signed and notarized macOS `.dmg` + Windows `.exe`. End-to-end story shipped: Electron GUI onboarding, persona configuration, the mineflayer bot loop with single-layer Haiku reasoning + Zod-typed action dispatch, markdown `OWNER.md` / `DIARY.md` memory with LLM-directed compaction, and custom bot skins via CustomSkinLoader (Fabric Loader auto-install wizard).

The phase and quick-task directories that produced v0.1.1 are archived under `milestones/v0.1.1-phases/` and `milestones/v0.1.1-quick/`. This release is the working baseline for all later work.
