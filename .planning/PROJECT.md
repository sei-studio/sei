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

## Version Trajectory

Sei climbs toward **v1.0 = a companion that can play nearly any game.** v0.1.1 was the first Minecraft release; **v0.3** made it a commercializable Minecraft agent; **v0.4 (current)** turns it into an *agentic gaming companion* compelling beyond Minecraft. (The v0.3 milestone was authored under the working label "v1.0 — Commercializable MVP" and renumbered when v1.0 was redefined as omni-game.)

## Current Milestone: v0.4 — Minimum Desirable Companion

**Goal:** Make the companion as emotionally compelling as possible within vanilla Minecraft's limited appeal, and unbind the product from "must play Minecraft" — by decoupling the persona+memory brain from the mineflayer surface so a companion is alive in chat, voice, and minigames too, with memory continuous across all of them.

**Four problems this milestone attacks:**
- **In-game capability** — the agent isn't as competent as SOTA Minecraft bots: no furnace/smelting, only reactive (not proactive) mob awareness, weak combat, can't read signs or open doors.
- **Personalization** — memory is on-demand and never actively referenced; the relationship dynamic never evolves.
- **Personality** — persona prompts are weak; users describe characters poorly and personas drift toward generic "assistant voice."
- **Accessibility** — Sei is only reachable by Minecraft players, when the actual pitch is companionship / emotional connection.

**Target client features:**
- Persona & memory core — generalizable persona expander, per-turn persona re-injection (fights attention-decay drift), scored memory retrieval with active fact-callbacks, tone with stronger preferences + honest handling of in-game hallucinations
- Minecraft competence — furnace/smelting, proactive threat awareness, better combat, sign reading, doors, navigation, better structures
- Brain–surface decoupling + in-app chat — one persona+memory brain attaches to a surface (Minecraft world, text chat, voice, minigame); memory continuous across surfaces; agent can initiate "let's play" handoffs
- ElevenLabs voice — voice-per-personality TTS in a call surface, mutually exclusive with text, modality-aware tone (spoken vs typed)
- Minigames — a small set of LLM-playable non-3D games (GeoGuessr clone + 1–2 more) with personality-varied strategy/skill
- UI overhaul — Discord-like chat on character-card click; profile, voice-call, and games entry points; games picker as the new summon path

## Requirements

### Validated (shipped in v0.1.1 / v0.3)

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
- [x] In-game vision: bot-POV `prismarine-viewer` render + `visualize` Zod action, capability-gated, 16-block + line-of-sight gating (Phase 15)

### Active (v0.4 — Minimum Desirable Companion)

- [ ] Persona & memory core: generalizable persona expander, per-turn persona re-injection, scored memory retrieval + active callbacks, stronger tone (Phase 16)
- [ ] Minecraft competence: furnace/smelting, proactive threat awareness, better combat, signs, doors, navigation (Phase 17)
- [ ] Brain–surface decoupling + in-app text chat: shared persona+memory across surfaces, handoff bridge, agent-initiated "let's play" (Phase 18)
- [ ] UI overhaul: Discord-like chat on card click; profile / voice-call / games entry points; games picker as summon path (Phase 19)
- [ ] ElevenLabs voice: voice-per-personality call surface, mutually exclusive with text, modality-aware tone (Phase 20)
- [ ] Minigames: GeoGuessr clone + 1–2 more, personality-varied strategy/skill (Phase 21)

### Out of Scope (v0.4)

- Raw system-prompt editing in the GUI — power users edit config files directly
- Multiple simultaneous bots per app instance
- Dynamic tone/relationship state machine (flirty↔serious↔aggressive transitions) — deferred; v0.4 gets "alive" relationship feel from memory callbacks instead
- Modded Minecraft support / mod & version adapter pipeline — **dropped** (was the planned v0.3 Phase 16); blocked on mineflayer's vanilla-only registry ingestion + per-mod protocol code, out of proportion to payoff
- Omni-game adapter (non-Minecraft real games) — the v1.0 north star, not this milestone
- Cloud sync of runtime memory (`OWNER.md` / `DIARY.md`) — stays local-only
- Hot-loaded / LLM-generated handler code — the closed action registry stays closed

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
| Bot-POV vision via `prismarine-viewer` | Avoids OS screen-recording permissions and the player-monitor privacy leak; no Fabric mod | Shipped (Phase 15) |
| Drop the mod/version adapter pipeline | Modded support needs mineflayer registry-ingestion work + per-mod protocol code; payoff too small, shrinks the userbase | Dropped (was v0.3 Phase 16) |
| Decouple persona+memory "brain" from the mineflayer "surface" | One brain attaches to world / chat / voice / minigame; unbinds the product from Minecraft and makes memory continuous across surfaces | Planned (v0.4 Phase 18) |
| Memory = frozen-per-session snapshot in the cached prefix + tail appends | Keeps the persona+memory head always-cached across surface switches; per-turn scored re-ranking would invalidate the cache every turn | Planned (v0.4 Phase 16/18) |
| Cross-surface continuity via shared memory + a compact handoff bridge | Durable facts flow through memory; transient "what we were just doing" is summarized at the switch — continuity without dragging raw transcripts across (and without killing cache) | Planned (v0.4 Phase 18) |
| Fight persona drift with per-turn persona re-injection + few-shot voice examples | Drift is attention-decay, not context overflow; scenario scripts don't generalize but voice/register demonstrations do | Planned (v0.4 Phase 16) |
| Voice and in-game/text chat are mutually exclusive | One output channel at a time; the model is told whether it's spoken or typed and adjusts formality while staying in character | Planned (v0.4 Phase 20) |

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
*Last updated: 2026-06-25 — v0.3 (Commercializable MVP, Phases 10–15) shipped; planned Phase 16 mod adapter dropped. Started milestone v0.4 — Minimum Desirable Companion (Phases 16–21): persona/memory core, Minecraft competence, brain–surface decoupling + in-app chat, UI overhaul, voice, minigames. Completed v1.0-labeled milestone renumbered to v0.3.*
