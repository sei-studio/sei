# Requirements: Sei v0.4 (Client)

**Milestone:** v0.4 — Minimum Desirable Companion
**Defined:** 2026-06-25 · **Last updated:** 2026-06-25
**Core Value:** A gaming companion that feels like a real character — it remembers you across chat and play, reacts with personality, and is worth spending time with whether or not you open Minecraft.

**Milestone goal:** Make the companion as emotionally compelling as possible within vanilla Minecraft's limited appeal, and unbind the product from "must play Minecraft" — by decoupling the persona+memory brain from the mineflayer surface so a companion is alive in chat, voice, and minigames too, with memory continuous across all of them.

> **Scope:** This file tracks **client** requirements. The hosted cloud backend (proxy server, auth/billing/moderation, TTS proxying if any) lives in a separate private repo; requirements here describe only the client side of that integration. The previous milestone's requirements are archived at [`milestones/v0.3-REQUIREMENTS.md`](milestones/v0.3-REQUIREMENTS.md).

**Locked decisions:**
- **Brain–surface decoupling:** one persona+memory "brain" attaches to a "surface" (Minecraft world / in-app text chat / voice call / minigame). The brain is shared; each surface supplies its own context blocks + output channel.
- **Cross-surface continuity:** shared on-disk memory (durable facts) + a compact handoff bridge (transient "what we were just doing") summarized at each surface switch. Raw transcripts are NOT carried across.
- **Prompt-cache layout:** `[baseline + persona + memory snapshot]` (always cached, survives switches) → `[interface rules]` → `[chat history]` (both re-cached per switch) → `[ongoing memory + new messages]` (tail). Memory is a **frozen-per-session snapshot**, not re-ranked per turn.
- **Persona drift = attention-decay:** fixed by per-turn persona re-injection + generalizable few-shot voice examples, NOT hardcoded scenario scripts.
- **Voice ⇆ text are mutually exclusive:** when voice is on, text + in-game chat are off; the model knows spoken-vs-typed and adjusts.
- **Usage UI:** keep the plain %, drop the playtime-hours estimate.
- **Dynamic tone state machine is deferred** to a later milestone.

---

## v0.4 Client Requirements

### Persona Core (PERSONA) — Phase 16

- [ ] **PERSONA-01**: When a user saves a character from a short/weak description, the system expands it into a structured persona (identity, enumerated voice/register, values & priorities, reaction patterns, memory framing) that preserves every fact the user wrote and adds no hardcoded scenario scripts
- [ ] **PERSONA-02**: The expanded persona generalizes across contexts — it drives behavior in Minecraft early-game, Minecraft late-game, casual chat, and minigames without any context-specific example scripts
- [ ] **PERSONA-03**: A compressed persona core is re-injected at high recency on every turn (not only in the cached system prefix), measurably reducing personality drift over a long (>12-turn) session
- [ ] **PERSONA-04**: The persona carries a small set of few-shot `say()` voice examples that demonstrate register/voice (not situational actions), and they appear in the assembled prompt
- [ ] **PERSONA-05**: The companion expresses stable, character-specific preferences/opinions (likes, dislikes, priorities) consistently across turns and surfaces
- [ ] **PERSONA-06**: When the companion is wrong about the world or invents an in-game fact, it acknowledges the mistake honestly/self-deprecatingly in character rather than doubling down

### Memory (MEM) — Phase 16

- [ ] **MEM-01**: Each memory is written with an importance rating assigned at write time
- [ ] **MEM-02**: The per-session memory snapshot is built by scored retrieval (recency + importance + relevance) at session start and stays frozen for the session (no per-turn re-ranking that would break the prompt cache)
- [ ] **MEM-03**: The companion actively references what it knows about the user during ordinary conversation/play (fact-recall callbacks), not only when explicitly asked
- [ ] **MEM-04**: Memories the companion writes mid-session are usable within the same session (appended to the tail) without rebuilding the cached snapshot
- [ ] **MEM-05**: Memory is continuous across surfaces — a fact learned in chat is available in-game and vice versa
- [ ] **MEM-06**: Runtime memory stays local-only and is never synced to the cloud (preserves the v0.3 boundary)

### Minecraft Competence (MCRAFT) — Phase 17

- [ ] **MCRAFT-01**: The companion can smelt/cook with a furnace unaided — load input + fuel and retrieve the output
- [ ] **MCRAFT-02**: The companion proactively detects nearby hostile mobs (threat radius / line of sight) and reacts before taking damage — e.g., it avoids or retreats from a creeper instead of being blown up
- [ ] **MCRAFT-03**: The companion wins a basic fight against common hostile mobs using movement/positioning, not just stationary attack-spam
- [ ] **MCRAFT-04**: The companion can read the text on a sign and reference/use it
- [ ] **MCRAFT-05**: The companion can open and pass through doors and gates
- [ ] **MCRAFT-06**: The companion can place blocks to build a simple, correct structure (e.g., a small shelter) at intended locations
- [ ] **MCRAFT-07**: From a fresh world the companion can progress the early/mid game spine unaided through iron tier (wood → tools → food → shelter → mine → smelt iron)
- [ ] **MCRAFT-08**: When vision is enabled, the companion uses visual input to help navigate/orient (recognize obstacles, openings) rather than relying solely on coordinates

### Brain–Surface Decoupling (BRAIN) — Phase 18

- [ ] **BRAIN-01**: A companion can run with no Minecraft world attached (chat-only) using the same persona+memory brain
- [ ] **BRAIN-02**: The brain attaches to a surface abstraction; Minecraft and text chat (and later voice, minigame) each supply their own context composition + output channel without duplicating persona/memory logic
- [ ] **BRAIN-03**: The assembled prompt follows the locked cache layout — persona+memory snapshot stays cached across a surface switch; only interface rules + history re-cache
- [ ] **BRAIN-04**: A surface switch produces a compact handoff bridge (summary of the just-ended session + salient new memory) seeded into the destination surface; raw transcripts are not carried across
- [ ] **BRAIN-05**: The model is told which surface/modality it is in and adjusts behavior/output accordingly
- [ ] **BRAIN-06**: The companion can initiate a surface handoff itself via a tool — e.g., propose and launch a Minecraft session or a minigame from chat

### In-App Chat (CHAT) — Phase 18

- [ ] **CHAT-01**: A user can hold a back-and-forth text conversation with a companion in-app without launching Minecraft
- [ ] **CHAT-02**: In chat, the companion's prompt is free of in-game world-state blocks, yielding cleaner in-character behavior
- [ ] **CHAT-03**: The companion proactively asks the user about themselves / their day with a motivated reason (not random or ill-timed pings) to build rapport
- [ ] **CHAT-04**: The companion invites the user to play (Minecraft or a minigame) at appropriate moments rather than only chatting
- [ ] **CHAT-05**: Rapport and facts established in chat carry into gameplay, and gameplay events are referenceable back in chat, via shared memory

### UI Overhaul (UI) — Phase 19

- [ ] **UI-01**: Clicking a character card on the home page opens a Discord-like chat interface with that companion
- [ ] **UI-02**: The chat interface has a top-right profile button that opens the current character info screen
- [ ] **UI-03**: A voice-call button (next to the profile button) starts a voice chat, opening a Discord-like call interface (profile pic, mute, hang-up)
- [ ] **UI-04**: A games button in the top-right opens a tiled window of supported games
- [ ] **UI-05**: Selecting a game opens an about page with a Summon button — the new primary path to summon a companion into an activity
- [ ] **UI-06**: The playtime-hours estimate is removed from the usage UI; the plain % indicator remains
- [ ] **UI-07**: All new UI uses the existing "Summoning Terminal" design tokens and reuses existing primitives (Button, CharacterCard, modal patterns) rather than literal hex/px

### Voice (VOICE) — Phase 20

- [ ] **VOICE-01**: A user can start a voice call with a companion; the companion speaks via ElevenLabs TTS
- [ ] **VOICE-02**: The voice used is chosen to match the character's personality
- [ ] **VOICE-03**: When voice is active, in-app text chat and the in-game chat box are disabled (one output channel at a time)
- [ ] **VOICE-04**: The model knows whether its output will be spoken or typed and adjusts formality/tone accordingly while staying in character
- [ ] **VOICE-05**: The user can mute and hang up; ending a call returns cleanly to the prior surface

### Minigames (GAME) — Phase 21

- [ ] **GAME-01**: A GeoGuessr-style minigame shows a street/earth scene, lets the user drop a guess on a world map, and scores by distance with a per-round timer
- [ ] **GAME-02**: The companion can play GeoGuessr too — guessing a location from the scene image via vision — with its score shown alongside the user's
- [ ] **GAME-03**: One or two additional simple LLM-playable games ship (selected during the phase)
- [ ] **GAME-04**: Different personas/models exhibit visibly varied strategy and skill level in the same game (play is not identical across characters)
- [ ] **GAME-05**: Minigames run as a brain surface — the companion stays in character and memory carries into and out of the game
- [ ] **GAME-06**: Games are reachable from the games picker (UI-04/05) and feed the companionship/engagement loop

---

## Future Requirements (Deferred)

Not in v0.4. Captured because they came up during planning/research.

- **Dynamic tone/relationship state machine** (flirty ↔ teasing ↔ serious ↔ aggressive transitions) — hard; v0.4 gets "alive" relationship feel from memory callbacks instead
- **Full Minecraft completion** (Nether → End → Ender Dragon) unaided — stretch beyond the iron-tier spine in MCRAFT-07
- **Omni-game adapter** (non-Minecraft real games) — the v1.0 north star, a separate milestone
- **Cloud-synced runtime memory** — privacy + race conditions; stays local-only
- **Multiple simultaneous bots / surfaces per companion at once** — one active surface per companion in v0.4
- **Per-activity burn-rate breakdown in the usage UI** — chat/voice/MC/minigames burn differently; for now show only the plain %
- **Voice input / speech-to-text** (user talks back) — v0.4 voice is companion-TTS output only unless trivially included
- **More than ~3 minigames / a full game catalog** — start with GeoGuessr + 1–2

## Out of Scope

Explicit exclusions for v0.4:

- **Modded Minecraft support / mod & version adapter pipeline** — dropped (was v0.3 Phase 16); blocked on mineflayer's vanilla-only registry ingestion + per-mod protocol code
- **Hot-loaded / LLM-generated handler code** — the closed action registry stays closed; adapters are data, not code
- **Dynamic tone state machine** — deferred (see Future)
- **Cloud sync of bot runtime memory** — local-only
- **Token counts in the usage UI** — friendly % only (carried from v0.3)

---

## Traceability

Each requirement maps to exactly one phase.

| Category | Count | Phase |
|----------|-------|-------|
| PERSONA-01..06 | 6 | Phase 16 |
| MEM-01..06 | 6 | Phase 16 |
| MCRAFT-01..08 | 8 | Phase 17 |
| BRAIN-01..06 | 6 | Phase 18 |
| CHAT-01..05 | 5 | Phase 18 |
| UI-01..07 | 7 | Phase 19 |
| VOICE-01..05 | 5 | Phase 20 |
| GAME-01..06 | 6 | Phase 21 |

**Total: 49 requirements across 6 phases.**

---

*Last updated: 2026-06-25 — defined v0.4 (Minimum Desirable Companion) requirements. Previous milestone archived as v0.3.*
