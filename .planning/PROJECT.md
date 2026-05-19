# Sei

## What This Is

Sei is a **framework** for running custom personas in Minecraft. The user names the character (default examples use "Sui") and configures personality; Sei runs the bot loop. The framework joins your server as a configurable persona with proactive behavior and autonomous decision-making. Non-technical users set it up through a CLI today and an Electron GUI in v1.0 — enter an API key, describe the bot's personality, and the persona joins the game as a living character. Sei uses a two-layer LLM architecture: a cloud personality model (Haiku) for decisions and conversation, and a local function-calling model (Ollama Qwen) for executing movement and actions via mineflayer.

Naming: **"Sei"** is the framework name. The character's name is set by the user — the default `persona.name` in `config.example.json` is `"Sui"`.

## Core Value

A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

## Current Milestone: v1.0 Commercializable MVP

**Goal:** Promote Sei from a working local prototype to a commercializable MVP — accounts, shared character library, hosted AI billing, broader model support, vision, and universal Minecraft compatibility.

**Target features:**
- Cloud character library (image/skin/desc/prompt in shared free-tier DB) — replaces per-user memory files for character definition
- Email/password + Google auth — required for cloud/sharing, optional for local-only API use
- Character sharing — Home (recent + mine) vs Browse (all, search, add to mine), c.ai-style discovery
- Cloud AI proxy — $5 one-time or $20/month proxied Claude credits via in-app checkout; friendly % usage UX (no token counts); paid to personal account
- Multi-provider model support — OpenAI/Anthropic/Gemini/Grok/OpenRouter/local OpenAI-compatible with caching; onboarding model picker → list
- In-game vision via player-POV screenshots — gated by 16-block radius + line-of-sight; idle auto-screenshot when VLM; explicit `visualize` skill
- Universal MC mod/version compatibility — LLM-driven adapter ingestion that diffs modded items/keybinds vs baseline and emits new Zod actions + summary/knowledge

## Requirements

### Validated

- [x] Single-layer Haiku reasoning + Zod action dispatch (v0.1.1 — superseded the two-layer plan)
- [x] Mineflayer integration: world state, in-game chat, inventory, movement control (v0.1.1)
- [x] Event-sourced FSM with priority queue + iteration_cap (v0.1.1)
- [x] LLM-directed memory compaction at semantic boundaries (v0.1.1)
- [x] Multi-player aware: primary owner concept (v0.1.1)
- [x] Idle behavior: stays near player, comments on surroundings (v0.1.1)
- [x] Electron GUI onboarding: API key input, personality config (v0.1.1)
- [x] Bundled executable distribution: signed/notarized macOS .dmg + Windows .exe (v0.1.1)
- [x] Custom bot skins via CustomSkinLoader + Fabric auto-install wizard (v0.1.1)

### Active

- [ ] Cloud character library backed by free-tier shared DB (image, skin, desc/prompt)
- [ ] User accounts: email/pw + Google; cloud/sharing gated, local-only optional
- [ ] Character browse/share flow split into Home vs Browse with search and "add to mine"
- [ ] In-app paid AI proxy ($5 one-time / $20/month) routing through personal Anthropic key
- [ ] Friendly usage indicator (% bar, no token counts) anchored above settings icon
- [ ] Multi-provider model adapter (OpenAI, Anthropic, Gemini, Grok, OpenRouter, local) with prompt caching working per-provider
- [ ] Onboarding model picker changed from grid → list
- [ ] In-game vision: player-POV screenshot capture with 16-block + line-of-sight gating
- [ ] Idle auto-screenshot when active model is a VLM, plus a `visualize` action skill
- [ ] Mod/version adapter ingestion pipeline: diff modded items/keybinds vs baseline → emit summary + Zod actions

### Out of Scope

- Raw system prompt editing in GUI — targeting non-technical users; power users can edit config files directly
- Multiple simultaneous Sei bots — single bot instance per Electron app for v1
- Voice/audio — text only for v1

## Context

- Existing codebase: `mineflayer/` directory contains mineflayer library source (likely a local copy or fork)
- Architecture sketch exists in `ARCHITECTURE.md` — relational graph showing data flow between components
- Target users: non-technical Minecraft players who want a companion without writing code
- Electron handles both the GUI (config/setup) and wraps the Node.js bot process
- Screenshot capture requires OS-level window capture (not a Minecraft API) — brittle but desired for visual context

## Constraints

- **Tech stack**: Node.js + mineflayer for bot runtime — already chosen and present in repo
- **Tech stack**: Electron for GUI — confirmed, enables bundled desktop app
- **Dependency**: Ollama must be running locally when local model mode is selected
- **Performance**: Personality LLM loop must not block mineflayer tick loop — async architecture required
- **Distribution**: Must bundle into a single executable for non-technical users — Electron Builder or similar

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Two-layer LLM (large + small) | Separates personality/decisions (needs context, creativity) from function-calling (needs speed, precision) | — Pending |
| Natural language hand-off between LLMs | Simpler than structured JSON; personality LLM describes intent in plain English | — Pending |
| Ollama for local movement model | Free, local, no API cost for high-frequency function calls | — Pending |
| Event-driven loop with 10s fallback | Responsive to game events without busy-polling; idle fallback keeps bot alive | — Pending |
| Electron for GUI + process management | Non-technical users need a double-click experience; Electron wraps Node.js naturally | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-19 — milestone v1.0 (Commercializable MVP) started*
