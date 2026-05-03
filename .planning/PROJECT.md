# Sei

## What This Is

Sei is a **framework** for running custom personas in Minecraft. The user names the character (default examples use "Sui") and configures personality; Sei runs the bot loop. The framework joins your server as a configurable persona with proactive behavior and autonomous decision-making. Non-technical users set it up through a CLI today and an Electron GUI in v1.0 — enter an API key, describe the bot's personality, and the persona joins the game as a living character. Sei uses a two-layer LLM architecture: a cloud personality model (Haiku) for decisions and conversation, and a local function-calling model (Ollama Qwen) for executing movement and actions via mineflayer.

Naming: **"Sei"** is the framework name. The character's name is set by the user — the default `persona.name` in `config.example.json` is `"Sui"`.

## Core Value

A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Two-layer LLM system: personality LLM (Haiku 3 API) + movement LLM (Ollama local)
- [ ] Personality LLM loops on events: chat message, small model completion, significant world events (attacked, hungry, mob nearby, inventory change), with 10s idle fallback
- [ ] Movement LLM receives natural language instructions from personality LLM and calls mineflayer functions
- [ ] Mineflayer integration: world state, in-game chat, inventory, movement control
- [ ] OS screenshot capture fed to personality LLM as visual context
- [ ] Long-term memory: bot identity/personality, player relationships, world progression
- [ ] Multi-player aware: interacts with any player, has primary owner concept
- [ ] Idle behavior: stays near player, comments on surroundings
- [ ] Electron GUI: API key input, personality config (name, backstory, tone/traits)
- [ ] Model source configurable in GUI: local Ollama or API-only fallback
- [ ] Bundled executable distribution (.exe / .app)

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
*Last updated: 2026-04-24 after initialization*
