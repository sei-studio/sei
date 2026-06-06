---
project: sei
---

# Milestones

| Version | Status      | Shipped    | Archive |
|---------|-------------|------------|---------|
| v1.0    | In progress | —          | (current — see ROADMAP.md) |
| v0.1.1  | Released    | 2026-05-18 | [ROADMAP](milestones/v0.1.1-ROADMAP.md) · [REQUIREMENTS](milestones/v0.1.1-REQUIREMENTS.md) · [phases](milestones/v0.1.1-phases/) · [quick](milestones/v0.1.1-quick/) |

## v1.0 — Commercializable MVP (in progress)

Promotes Sei from a working local prototype to a commercializable MVP: user accounts (email/password + Google), a cloud-authoritative character library with local cache-on-demand, c.ai-style character sharing with moderation, hosted AI billing with a friendly % usage indicator, a multi-provider `LlmProvider` abstraction, in-game bot-POV vision via `prismarine-viewer`, and a declarative mod/version adapter pipeline. Phases 10–14 are complete; Phase 15 (In-Game Vision) is the active phase. See `ROADMAP.md` and `REQUIREMENTS.md`.

The hosted cloud backend (proxy server, auth/billing/moderation infrastructure) lives in a separate private repo and is referenced from these planning docs only at a high level.

## v0.1.1 — first public release

Signed and notarized macOS `.dmg` + Windows `.exe`. End-to-end story shipped: Electron GUI onboarding, persona configuration, the mineflayer bot loop with single-layer Haiku reasoning + Zod-typed action dispatch, markdown `OWNER.md` / `DIARY.md` memory with LLM-directed compaction, and custom bot skins via CustomSkinLoader (Fabric Loader auto-install wizard).

The phase and quick-task directories that produced v0.1.1 are archived under `milestones/v0.1.1-phases/` and `milestones/v0.1.1-quick/`. This release is the working baseline for all v1.0 work.
