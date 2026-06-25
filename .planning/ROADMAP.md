# Roadmap: Sei v0.4, Minimum Desirable Companion

**Milestone:** v0.4, Minimum Desirable Companion
**Phases:** 6 (Phase 16 through Phase 21, continuing from v0.3 which ended at Phase 15)
**Granularity:** coarse
**Coverage:** all 49 v0.4 client requirements mapped, no orphans
**Last updated:** 2026-06-25

## Milestone Goal

Increase the companion's appeal within vanilla Minecraft, and make the product usable by people who do not play Minecraft. The mechanism is to separate the persona and memory layer (the "brain") from the mineflayer connection (the "surface"), so a companion can run in an in-app text chat, a voice call, or a minigame as well as in a Minecraft world, with one shared memory across all of them.

The milestone addresses four problems:
1. In-game capability: the agent cannot use a furnace, only detects hostile mobs after being hit, has weak combat, and cannot read signs or open doors.
2. Personalization: memory is written only on demand and is not actively referenced in conversation.
3. Personality: persona prompts are weak and the persona drifts toward a generic assistant voice over a session.
4. Accessibility: the product is reachable only by Minecraft players, while the intended value is companionship.

> Scope note: this is the client roadmap. The hosted cloud backend (proxy server, auth, billing, moderation, and any TTS proxying) is in a separate private repo and is referenced here only where the client integrates with it. The previous milestone is archived at [`milestones/v0.3-ROADMAP.md`](milestones/v0.3-ROADMAP.md).

## Locked Decisions (baked into this roadmap)

1. Brain and surface are separated. One persona+memory brain attaches to one surface at a time (Minecraft world, in-app text chat, voice call, or minigame). The brain is shared; each surface supplies its own context blocks and output channel.
2. Cross-surface continuity uses shared memory plus a handoff bridge. Durable facts are stored in the shared on-disk memory. At a surface switch, the transient recent context is summarized into a compact bridge and seeded into the new surface. Raw transcripts are not copied across surfaces.
3. Prompt-cache layout, ordered most-stable to least-stable: `[baseline + persona + memory snapshot]` (stays cached, survives a surface switch), then `[interface rules]`, then `[chat history]` (both re-cached on a switch), then `[ongoing memory + new messages]` (the growing tail). The memory snapshot is built once at session start by scored retrieval and then frozen for the session. It is not re-ranked per turn, because re-ranking would invalidate the cache every turn. Memories written mid-session are appended to the tail.
4. Persona drift is treated as attention decay rather than context overflow. The fix is to re-inject a compressed persona core at high recency on every turn, plus a small set of few-shot `say()` examples that demonstrate voice and register. Hardcoded scenario scripts are not used, because they do not generalize across contexts.
5. Voice output and text output are mutually exclusive. When voice is active, in-app text chat and the in-game chat box are disabled. The model is told whether its output will be spoken or typed and adjusts formality accordingly while staying in character. Voice uses ElevenLabs, with a voice selected per character.
6. The usage UI keeps the percentage indicator and removes the playtime-hours estimate, because chat, voice, Minecraft, and minigames consume credits at different rates and a single time estimate is inaccurate.
7. A dynamic tone and relationship state machine is deferred to a later milestone. In v0.4 the relationship feel comes from memory callbacks.
8. The closed action registry remains closed (carried from v0.3). The LLM dispatches typed actions, never code or coordinates. This applies to Minecraft competence work as well: no code-as-skills.

## Phases

- [ ] **Phase 16: Persona & Memory Core.** Persona expander, per-turn persona re-injection, few-shot `say()` voice examples, scored memory retrieval with a frozen per-session snapshot, active memory callbacks, honest handling of incorrect statements.
- [ ] **Phase 17: Minecraft Competence.** Furnace use, proactive mob detection, positioning-based combat, sign reading, doors and gates, simple structures, unaided progression to iron tier, vision-assisted navigation.
- [ ] **Phase 18: Brain–Surface Decoupling + In-App Chat.** Run the persona+memory brain without a Minecraft world, define the surface abstraction and handoff bridge, add modality awareness and an agent-initiated handoff tool, and ship in-app text chat.
- [ ] **Phase 19: UI Overhaul.** Chat interface on character-card click, profile and voice-call and games entry points, games picker leading to an about page and Summon, removal of the playtime estimate.
- [ ] **Phase 20: ElevenLabs Voice.** ElevenLabs TTS voice-call surface, per-character voice, mutual exclusion with text and in-game chat, modality-aware tone, mute and hang-up.
- [ ] **Phase 21: Minigames + GeoGuessr.** Minigame surface, a GeoGuessr clone the companion also plays via vision, one or two more LLM-playable games, personality-varied skill, memory carried in and out.

## Phase Details

### Phase 16: Persona & Memory Core

**Status:** Not started (no plans yet)

**Goal:** A companion created from a short user description holds a consistent, specific personality across a long session, references what it knows about the user without being asked, and acknowledges its own mistakes. This persona and memory layer is the shared substrate used by the later surface work.

**Depends on:** Nothing. It is foundational and is the substrate that Phase 18 decouples.

**Requirements:** PERSONA-01 through PERSONA-06, MEM-01 through MEM-06

**Rationale:** Phase 18 carries persona and memory across surfaces, so persona quality and memory retrieval are built before they are shared. Two locked decisions drive the work. First, persona drift is attention decay, addressed by per-turn re-injection of a compressed persona core plus generalizable few-shot voice examples rather than scenario scripts. Second, memory is a frozen per-session snapshot built by scored retrieval (recency, importance, and relevance, with importance assigned at write time), with mid-session writes appended to the tail. Perceived rapport is produced by active fact recall in conversation, not by an affinity score. Phase research covers character.ai design, roleplay prompting, and natural-conversation techniques.

**Success Criteria** (what must be TRUE):
  1. Saving a character from a short description produces a structured persona that preserves every fact the user wrote, contains no hardcoded scenario scripts, and includes few-shot `say()` voice examples that are present in the assembled prompt.
  2. Across a session longer than 12 turns the companion keeps its voice and stays in character more consistently than the current build, and states the same likes, dislikes, and priorities across turns.
  3. During ordinary play or chat the companion refers to facts it knows about the user without being prompted.
  4. A fact the companion writes mid-session is usable later in the same session without rebuilding the cached snapshot.
  5. When the companion is wrong about the world or states an incorrect in-game fact, it acknowledges the error in character rather than repeating it, and runtime memory is never synced to the cloud.

**Plans:** TBD

---

### Phase 17: Minecraft Competence

**Status:** Not started (no plans yet)

**Goal:** The companion can smelt with a furnace, detect hostile mobs before taking damage, fight using positioning, read signs, open doors, build a simple shelter, and progress from a new world to iron tier without help.

**Depends on:** Nothing architecturally. It is an independent track that can run in parallel with Phases 18 through 21.

**Requirements:** MCRAFT-01 through MCRAFT-08

**Rationale:** This track has no dependency on the surface refactor, so it can run in parallel with the brain and surface work. The current build is reactive on threats (it is destroyed by creepers because it reacts only after being hit) and lacks furnace use, sign reading, and door traversal. The closed action registry remains closed, so existing Minecraft-bot research is used for primitive and action design only, not for code-as-skills. Phase research covers open-source Minecraft bots and agents (mineflayer plugins, Voyager, MineDojo, primitive design) under that constraint.

**Success Criteria** (what must be TRUE):
  1. The companion smelts or cooks with a furnace without help (loads input and fuel, retrieves output) and reads the text on a sign and references it.
  2. The companion detects nearby hostile mobs and avoids or retreats from them before taking damage, including not being killed by a creeper, instead of reacting only after being hit.
  3. The companion wins a basic fight against common hostile mobs using movement and positioning rather than stationary attacking.
  4. The companion opens and passes through doors and gates, and places blocks to build a simple correct structure such as a small shelter at the intended location.
  5. From a new world the companion progresses to iron tier without help (wood, tools, food, shelter, mining, smelting iron), and when vision is enabled it uses visual input to help navigate rather than relying only on coordinates.

**Plans:** TBD

---

### Phase 18: Brain–Surface Decoupling + In-App Chat

**Status:** Not started (no plans yet)

**Goal:** The persona+memory brain runs without a Minecraft world attached, so a companion can operate in an in-app text chat. A surface abstraction and a handoff bridge let memory and recent context move across the world, chat, voice, and minigame surfaces.

**Depends on:** Phase 16 (the shared persona+memory core is the substrate that is decoupled).

**Enables:** Phase 20 (voice is a surface) and Phase 21 (minigame is a surface).

**Requirements:** BRAIN-01 through BRAIN-06, CHAT-01 through CHAT-05

**Rationale:** This phase removes the requirement for an active Minecraft session. The brain attaches to a surface abstraction in which each surface supplies its own context composition and output channel without duplicating persona or memory logic. The prompt-cache layout keeps the persona+memory snapshot cached across a surface switch, while only the interface rules and history re-cache. Cross-surface continuity uses shared on-disk memory plus a compact handoff bridge at the switch, with no raw transcript copied across. The first non-Minecraft surface, in-app text chat, is delivered here: the prompt contains no world-state blocks, the companion asks about the user with a stated reason, and an agent-initiated handoff tool (for example `launch_game` or `start_session`) lets the companion start a Minecraft session or minigame. This phase is built in parallel with the Phase 19 UI work, per the user, so the chat surface and its interface ship together.

**Success Criteria** (what must be TRUE):
  1. A companion runs in chat-only mode with no Minecraft world attached, using the same persona+memory brain, and a user can hold a text conversation in-app without launching Minecraft.
  2. In chat the prompt contains no in-game world-state blocks, and the model is told which surface and modality it is in and adjusts accordingly.
  3. A surface switch keeps the persona+memory snapshot cached (only interface rules and history re-cache) and produces a compact handoff bridge, containing a summary of the prior session and salient new memory, that is seeded into the destination surface, with no raw transcript copied across.
  4. The companion asks about the user with a stated reason rather than at random, invites the user to play, and can start a handoff itself through a tool, for example proposing and launching a Minecraft session from chat.
  5. Facts established in chat are available in gameplay, and gameplay events can be referenced back in chat, through the shared memory.

**Plans:** TBD

---

### Phase 19: UI Overhaul

**Status:** Not started (no plans yet)

**Goal:** Clicking a character card opens a chat interface. The interface provides profile, voice-call, and games entry points. The games picker leads to an about page with a Summon button and becomes the primary way to summon a companion into an activity.

**Depends on:** Benefits from Phase 18 (the chat surface exists), but is built in parallel with Phase 18 per the user rather than after it.

**Requirements:** UI-01 through UI-07

**Rationale:** The interface is reorganized from launching a Minecraft bot to talking to or playing with a companion. The card click opens a chat interface. The games picker (game tile, then about page, then Summon) replaces the previous summon flow as the primary path. The profile and voice-call buttons create the entry points that later phases use: the voice-call button opens a call interface that Phase 20 connects to ElevenLabs, and the games picker is where Phase 21 minigames appear, so this phase builds interface scaffolding ahead of both. The playtime-hours estimate is removed because it is inaccurate across surfaces with different consumption rates; the percentage indicator remains. New UI uses the existing design tokens and existing primitives (Button, CharacterCard, modal patterns) rather than literal hex or pixel values.

**Success Criteria** (what must be TRUE):
  1. Clicking a character card on the home page opens a chat interface with that companion.
  2. The chat interface has a top-right profile button that opens the character info screen, and a voice-call button next to it that opens a call interface with profile image, mute, and hang-up controls.
  3. A games button in the top-right opens a tiled list of supported games, and selecting a game opens an about page with a Summon button that is the primary path to summon a companion into an activity.
  4. The playtime-hours estimate is removed from the usage UI and only the percentage indicator remains.
  5. New UI uses the existing design tokens and existing primitives rather than literal hex or pixel values.

**Plans:** TBD
**UI hint:** yes

---

### Phase 20: ElevenLabs Voice

**Status:** Not started (no plans yet)

**Goal:** A user can hold a voice call with a companion that speaks in a per-character ElevenLabs voice. Text and in-game chat are disabled while the call is active, and ending the call returns to the prior surface.

**Depends on:** Phase 18 (voice is a brain surface) and Phase 19 (the call interface exists).

**Requirements:** VOICE-01 through VOICE-05

**Rationale:** Voice is the second non-Minecraft surface, so it follows the surface abstraction (Phase 18) and its call interface (Phase 19). Output channels are mutually exclusive: when voice is active, text and in-game chat are off, and the model is told its output will be spoken and adjusts formality and tone while staying in character. Each character is assigned a voice selected to match its personality. Mute and hang-up return to the surface the user came from. Voice input (speech-to-text) is deferred; v0.4 voice is companion TTS output only.

**Success Criteria** (what must be TRUE):
  1. A user can start a voice call and the companion speaks via ElevenLabs TTS, in a voice selected to match that character's personality.
  2. While voice is active, in-app text chat and the in-game chat box are disabled.
  3. The model knows its output will be spoken rather than typed and adjusts formality and tone accordingly while staying in character.
  4. The user can mute and hang up, and ending the call returns to the prior surface.

**Plans:** TBD
**UI hint:** yes

---

### Phase 21: Minigames + GeoGuessr

**Status:** Not started (no plans yet)

**Goal:** A small set of LLM-playable minigames runs as a brain surface. It includes a required GeoGuessr clone that the companion also plays. Different characters show different strategy and skill, and memory carries into and out of the game.

**Depends on:** Phase 18 (minigame is a brain surface) and Phase 19 (the games picker). Research-gated on personality-varied behavior.

**Requirements:** GAME-01 through GAME-06

**Rationale:** Minigames are the third surface, so they follow the surface abstraction (Phase 18) and the games picker (Phase 19). The required title is a GeoGuessr clone: a random street or earth scene, a world map to drop a guess, and a distance-based score with a per-round timer. The companion plays it as well, guessing from the scene image via vision, with both scores shown. One or two more simple LLM-playable games are selected during the phase. Different characters produce different strategy and skill in the same game, and because a minigame is a surface, the companion stays in character and memory carries in and out. Phase research covers methods for producing personality-varied behavior and skill.

**Success Criteria** (what must be TRUE):
  1. A GeoGuessr-style minigame shows a street or earth scene, lets the user drop a guess on a world map, and scores by distance with a per-round timer.
  2. The companion plays GeoGuessr by guessing a location from the scene image via vision, with its score shown alongside the user's.
  3. One or two additional simple LLM-playable games are available, reachable from the games picker (UI-04 and UI-05).
  4. Different characters show different strategy and skill in the same game; play is not identical across characters.
  5. The minigame runs as a brain surface: the companion stays in character and memory carries into and out of the game.

**Plans:** TBD
**UI hint:** yes

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 16. Persona & Memory Core | 0/TBD | Not started | - |
| 17. Minecraft Competence | 0/TBD | Not started | - |
| 18. Brain–Surface Decoupling + In-App Chat | 0/TBD | Not started | - |
| 19. UI Overhaul | 0/TBD | Not started | - |
| 20. ElevenLabs Voice | 0/TBD | Not started | - |
| 21. Minigames + GeoGuessr | 0/TBD | Not started | - |

## Critical Path

```
Phase 16 (Persona & Memory Core), substrate
   gates Phase 18 (Brain–Surface Decoupling + In-App Chat)
              built in parallel with
          Phase 19 (UI Overhaul)
              both gate Phase 20 (ElevenLabs Voice)
              both gate Phase 21 (Minigames + GeoGuessr), research-gated

Phase 17 (Minecraft Competence), independent track, parallelizable with Phases 18 through 21
```

**Why Phase 16 is first:** persona quality and memory retrieval are the shared substrate carried across surfaces by Phase 18, so they are built before they are shared.

**Why Phase 17 is parallel:** Minecraft competence has no dependency on the surface refactor and is a self-contained track.

**Why Phase 18 and Phase 19 are parallel:** the user wants the chat surface (18) and its interface (19) built together so the chat experience ships complete.

**Why Phases 20 and 21 follow 18 and 19:** voice and minigames are each new surfaces that require the Phase 18 surface abstraction and the Phase 19 interface entry points. Phase 21 also depends on the personality-varied behavior research.
