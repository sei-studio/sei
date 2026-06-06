# Sei

## What This Is

Sei is a **Minecraft AI companion** — a configurable LLM persona that joins a LAN (offline-mode) world as a mineflayer bot, chats with the player, and acts autonomously with personality and persistent memory. The user names the character and describes its personality; Sei runs the bot loop so the persona feels like a living character rather than a scripted bot.

Non-technical players set it up through an Electron GUI (productName **"Sei Launcher"**): pick or describe a character, choose how the AI is powered, and the persona joins the game. This repository is the **open-source client** — the desktop launcher, the bot runtime, and the GUI.

Naming: **"Sei"** is the framework/launcher. The character's name is set by the user (bundled defaults include "Sui").

## Core Value

A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

## How It Works (Architecture at a Glance)

- **Single-layer Haiku loop** — one Anthropic call does both reasoning and action dispatch. There is no separate "movement model"; the LLM reasons and emits tool calls in the same turn.
- **Three-process Electron** — `main` (privileged) ↔ `renderer` (GUI, contextIsolation) ↔ `utilityProcess` (the mineflayer bot + LLM brain). Mineflayer runs only in the utilityProcess.
- **Closed action registry** — the LLM calls Zod-typed actions from a fixed registry. It never generates code or raw coordinates.
- **Event-sourced FSM** — a priority queue (P0 safety → P1 chat → P2 completion → P3 idle) with a single outstanding action token guarded by an AbortController. An `iteration_cap` (default 30) bounds tool-use chains; owner chat preempts mid-iteration.
- **Local-first memory** — character runtime memory (`OWNER.md`, `DIARY.md`) stays on the user's machine and is compacted by the LLM at semantic boundaries, never on a mechanical timer.
- **Every external call is timeout-wrapped** — pathfinder and Anthropic calls have wall-clock timeouts; no exceptions.

### Two AI backends

The backend is chosen by `ai_backend_kind` in the user's `config.json` (default `local`):

- **Local (BYOK)** — the user supplies their own Anthropic API key, stored locally via Electron `safeStorage`. Default for users who continue without an account. Other providers are supported through the multi-provider abstraction.
- **Cloud** — signed-in users (Supabase auth) route LLM calls through Sei's hosted proxy at `api.sei.gg`, paying with in-app credits. Signed-in users default to cloud.

The cloud backend (proxy server, auth/billing/moderation infrastructure) lives in a **separate private repository** and is referenced here only at a high level. This client speaks to it over HTTPS; no server internals live in this repo.

## Current Milestone: v1.0 — Commercializable MVP

**Goal:** Promote Sei from a working local prototype (v0.1.1) to a commercializable MVP — accounts, a shared character library, hosted AI billing, broader model support, in-game vision, and universal Minecraft mod/version compatibility — without losing the local-only first-class experience or the closed-action-registry invariant.

**Target client features:**
- Cloud character library — character *definition* (persona, prompt, skin, portrait) is cloud-authoritative; runtime memory stays local
- User accounts — email/password + Google sign-in (required for cloud/sharing, optional for local-only use)
- Character sharing — Home (mine + recent) vs Browse (all public, search, "Add to Mine"), c.ai-style discovery
- Hosted AI billing — purchase proxied AI credits in-app; friendly % usage indicator (no token counts)
- Multi-provider model support — Anthropic, OpenAI, Gemini, Grok, OpenRouter, OpenAI-compatible local (Ollama, etc.)
- In-game vision — bot-POV renders via `prismarine-viewer` so a vision-capable model can "see" the world (in progress)
- Mod & version adapter — ingest a mods folder and emit reviewable, declarative Zod-action recipes (no code execution)

## Requirements

### Validated (shipped in v0.1.1 / v1.0)

- [x] Single-layer Haiku reasoning + Zod action dispatch (one Anthropic call)
- [x] Mineflayer integration: world state, in-game chat, inventory, movement control
- [x] Event-sourced FSM with priority queue + `iteration_cap`
- [x] LLM-directed memory compaction at semantic boundaries
- [x] Multi-player aware: primary-owner concept
- [x] Idle behavior: stays near the player, comments on surroundings
- [x] Electron GUI onboarding: API key input, personality config
- [x] Signed/notarized macOS `.dmg` + Windows `.exe` distribution
- [x] Custom bot skins via CustomSkinLoader + Fabric auto-install wizard
- [x] Isolated Sei launcher profile (own `gameDir` + selective mod linking)
- [x] Mod jar scanner with Fabric/Forge metadata parsing (`src/main/modScanner.ts`)
- [x] Email/password + Google auth; `safeStorage` session persistence (Phase 10)
- [x] Cloud character library with local cache-on-demand (Phase 11)
- [x] Character sharing UI + moderation gates (Phase 12 — code complete)
- [x] Hosted AI billing + friendly % usage UI (Phase 13)
- [x] Multi-provider `LlmProvider` abstraction (Phase 14)

### Active

- [ ] In-game vision: bot-POV `prismarine-viewer` render + `visualize` Zod action, capability-gated, 16-block + line-of-sight gating (Phase 15 — in progress)
- [ ] Mod/version adapter ingestion: diff modded items/keybinds vs vanilla → reviewable declarative Zod recipes + texture extraction (Phase 16)

### Out of Scope (v1.0)

- Raw system-prompt editing in the GUI — power users edit config files directly
- Multiple simultaneous bots per app instance
- Voice/audio — text only
- OS screen-capture / Fabric companion mod for vision — replaced by bot-POV via `prismarine-viewer`
- Cloud sync of runtime memory (`OWNER.md` / `DIARY.md`) — stays local-only
- Hot-loaded / LLM-generated handler code — adapters are data, never code

## Context

- The **cloud backend is a separate private repo**: the proxy server, Supabase migrations, edge functions, and billing infrastructure. This client repo describes only the client side and reaches the proxy at `api.sei.gg`.
- Target users: non-technical Minecraft players who want a companion without writing code.
- Electron handles both the GUI (config/setup) and the bot utilityProcess.
- v1.0 targets LAN (offline-mode) worlds — no Mojang UUIDs; identity binds to the signed-in account.

## Constraints

- **Tech stack**: Node.js + mineflayer for the bot runtime; Electron for the GUI/desktop app.
- **Performance**: the LLM loop must not block the mineflayer tick loop — async architecture required.
- **Distribution**: a single double-clickable executable per platform (electron-builder).
- **Invariant**: the closed action registry is never bypassed — the LLM dispatches typed actions, never code or coordinates.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Single-layer Haiku (reasoning + dispatch in one call) | Simpler and lower-latency than a two-layer split; one model both reasons and emits tool calls | Shipped (v0.1.1) |
| Closed Zod-typed action registry | Safety + determinism — no code execution from model output | Shipped |
| Event-driven FSM with priority queue + abort token | Responsive to game events without busy-polling; owner chat preempts | Shipped |
| Electron three-process split | Non-technical users need a double-click experience; isolates the bot from the GUI | Shipped |
| Two backends (local BYOK + cloud proxy) | Local-only stays first-class; cloud serves users who don't want to manage keys | Shipped |
| Bot-POV vision via `prismarine-viewer` | Avoids OS screen-recording permissions and the player-monitor privacy leak; no Fabric mod | In progress (Phase 15) |
| Declarative mod adapters (data, not code) | Preserves the closed-registry invariant for modded content | Planned (Phase 16) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-06 — Phases 10–14 complete; Phase 15 (In-Game Vision via prismarine-viewer) is the active phase. Cloud backend split into a separate private repo.*
