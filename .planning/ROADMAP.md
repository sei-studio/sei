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
3. Prompt-cache layout, ordered most-stable to least-stable: `[baseline + persona + memory snapshot]` (stays cached, survives a surface switch), then `[interface rules]`, then `[chat history]` (both re-cached on a switch), then `[ongoing memory + new messages]` (the growing tail). The memory snapshot is seeded once at session start and then frozen for the session. It is not re-ranked per turn, because re-ranking would invalidate the cache every turn. Memories written mid-session are appended to the tail. Scored retrieval and write-time importance ranking are not built in v0.4; they are deferred. Phase 16 keeps memory to correct MEMORY.md injection and proper remember() usage.
4. Persona drift is treated as attention decay rather than context overflow. The fix is to re-inject a compressed persona core at high recency on every turn, plus a small set of few-shot `say()` examples that demonstrate voice and register. Hardcoded scenario scripts are not used, because they do not generalize across contexts.
5. Voice output and text output are mutually exclusive. When voice is active, in-app text chat and the in-game chat box are disabled. The model is told whether its output will be spoken or typed and adjusts formality accordingly while staying in character. Voice uses ElevenLabs, with a voice selected per character.
6. The usage UI keeps the percentage indicator and removes the playtime-hours estimate, because chat, voice, Minecraft, and minigames consume credits at different rates and a single time estimate is inaccurate.
7. A dynamic tone and relationship state machine is deferred to a later milestone. In v0.4 the relationship feel comes from memory callbacks.
8. The closed action registry remains closed (carried from v0.3). The LLM dispatches typed actions, never code or coordinates. This applies to Minecraft competence work as well: no code-as-skills.

## Phases

- [ ] **Phase 16: Persona & Memory Core.** A small, mostly prompt-level phase: a per-turn re-injected persona core, the persona expander split into a surface-agnostic core plus a Minecraft addendum, scenario-agnostic few-shot `say()` voice examples, persona-modulated proactivity, honest handling of incorrect statements, and correct MEMORY.md injection and remember() usage. No scored memory retrieval (deferred).
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

**Rationale:** Phase 18 carries persona and memory across surfaces, so persona quality is built before it is shared. The scope is small and is mostly prompt and persona-assembly adjustments, not new subsystems. First, persona drift is attention decay, addressed by per-turn re-injection of a compressed persona core plus generalizable few-shot voice examples rather than scenario scripts. The persona expander is also split into a surface-agnostic core and a Minecraft addendum so later phases can attach other surfaces without rewriting persona logic. Voice examples are character-specific but scenario-agnostic. Proactivity is persona-modulated, so a cold character asks fewer questions than a warm one. Second, memory work in this phase is limited to correct MEMORY.md injection and proper remember() usage, with mid-session writes appended to the tail. Scored retrieval and write-time importance ranking are deferred. Perceived rapport is produced by active fact recall in conversation, not by an affinity score. All prompt text edited in this phase uses clear, objective, factual language to maximize how reliably the model follows it. Phase research covers character.ai design, roleplay prompting, and natural-conversation techniques.

**Success Criteria** (what must be TRUE):
  1. Saving a character from a short description produces a structured persona that preserves every fact the user wrote, contains no hardcoded scenario scripts, and includes few-shot `say()` voice examples that are present in the assembled prompt.
  2. Across a session longer than 12 turns the companion keeps its voice and stays in character more consistently than the current build, and states the same likes, dislikes, and priorities across turns.
  3. During ordinary play or chat the companion refers to facts it knows about the user without being prompted.
  4. A fact the companion writes mid-session is usable later in the same session without rebuilding the cached snapshot.
  5. When the companion is wrong about the world or states an incorrect in-game fact, it acknowledges the error in character rather than repeating it, and runtime memory is never synced to the cloud.

**Plans:** 3 plans

Plans:
- [ ] 16-01-PLAN.md — Runtime # CORE re-injection at the recency tail + honest-mistakes baseline (PERSONA-03/05/06, MEM-04)
- [ ] 16-02-PLAN.md — Expander generalization: # CORE section, universal/MC split, scenario-agnostic # VOICE, persona-modulated proactivity (PERSONA-01/02/04)
- [ ] 16-03-PLAN.md — Memory plumbing correctness + remember() cadence + active recall + local-only guard (MEM-01/02/03/06)

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

**Plans:** 5/6 plans executed

Plans:
- [x] 17-01-PLAN.md — Reflex evasion controller core (arrow dodge / creeper flee / melee strafe + telegraphs + mutex + config) [wave 1]
- [x] 17-02-PLAN.md — Reflex integration: connect wiring, follow/goTo/gather yield, announcement surfacing [wave 2]
- [x] 17-03-PLAN.md — Missing primitives: furnace 3-slot, door/gate activateBlock, sign reading, shelter [wave 1]
- [x] 17-04-PLAN.md — Progression-as-data (progression.json + nextMilestone), next: line, procedural memory [wave 1]
- [x] 17-05-PLAN.md — Capability/disposition/vision prompt rewrite [wave 2]
- [ ] 17-06-PLAN.md — Integration validation: unaided iron tier + reflex + primitives (human-verify) [wave 3]

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

## Research Findings

This milestone front-loaded deep research rather than deferring it to per-phase implementative research, because the design space (Minecraft competence, companion personality, varied behavior) is large and draws on a wide external literature. Full cited reports are in `.planning/research/`. The synthesis below is what each phase should build on.

**Research status:** the core deep-research streams are complete. Reports in `.planning/research/`: `v0.4-mc-llm-planning.md`, `v0.4-mc-mineflayer-skills.md`, `v0.4-mc-rl-hybrid.md`, `v0.4-mc-reflex-dodge.md` (Phase 17); `v0.4-companion-personality-memory.md`, `v0.4-persona-prompting-and-steering.md`, `v0.4-memory-and-relationship.md` (Phase 16, plus deferred tone); `v0.4-varied-behavior-and-minigames.md` (Phase 21). One additional Phase 17 stream, a comparison of leading agents' progression and skill graphs against Sei's minecraft-data-derived DAG (`v0.4-mc-progression-dag-comparison.md`), is in progress and will be folded into the progression item (item 4) when complete.

### Phase 17 — Minecraft Competence

Reports: `v0.4-mc-llm-planning.md`, `v0.4-mc-mineflayer-skills.md`, `v0.4-mc-rl-hybrid.md`.

1. **Control-surface verdict (decisive).** The marquee RL, imitation-learning, world-model, and foundation-policy agents (VPT, STEVE-1, GROOT, DreamerV3, MineRL, MineDojo) operate on rendered pixels plus mouse and keyboard in the real game client. Sei's bot is a headless protocol client (mineflayer) that sees structured state and acts through a high-level API. These policies cannot be plugged into mineflayer; using one would require running an actual rendered client plus a GPU plus 20 Hz inference alongside the bot, which is not viable on a consumer desktop. Recommendation: do not pursue pixel-based RL. Sei's protocol control surface sidesteps the hard problems those papers solve.

2. **The portable pattern is the hybrid hierarchy, implemented with classical game AI.** Every leading agent splits an LLM or foundation-model planner (slow, symbolic, about 0.2 to 2 Hz) from a low-level controller (fast, reactive, 20 Hz). Sei already is an instance of this pattern, with mineflayer as the controller. The recommended stack: LLM for intent and persona, then GOAP (goal-oriented action planning) for valid multi-step crafting and progression plans, then Behavior Trees and Utility AI for reactive safety and combat at 20 Hz, then steering and pathfinder for motor primitives, then the mineflayer API. Every tier runs locally on structured state with no GPU and no learned weights.

3. **Highest-leverage single item: a reactive "reflex" threat and combat micro-controller** running in the bot process between LLM turns. Full design in `v0.4-mc-reflex-dodge.md`. A ~20 Hz survival loop (`startReflex(bot, config)`, a sibling of the existing `startCombat` in `behaviors/combat.js`, wired from the same place) that runs on `bot.on('physicsTick')` (every 50 ms) and reads the entity list each tick to evade incoming damage before it lands. This directly fixes the named failures: the bot currently reacts only after `entityHurt` (the arrow or explosion already hit), is destroyed by creepers, and freezes in fights. Key points:

   - **No single library does reflex evasion; stitch four small pieces.** (a) Arrow dodge: hand-rolled, no dependency (~40 LOC). Scan `bot.entities` for `name === 'arrow'`, run a closest-approach ray test against the bot position, and sidestep with a `setControlState('left'|'right')` pulse of about 4 ticks. (b) Creeper flee: `mineflayer-pathfinder` (already a dependency), `GoalInvert(GoalFollow(creeper, 10))`, about 15 LOC. (c) Melee strafe: port the "circle" strafe loop from `@nxg-org/mineflayer-custom-pvp` SwordPvP rather than adding the dependency (it is PvP-oriented and owns the whole combat loop); `mineflayer-pvp` itself has no strafe. Optionally adopt `firejoust/mineflayer-movement` (MIT, beta) for terrain-safe steering so a flee or kite does not walk the bot into lava or off a cliff. (d) Aggro detection ("has it noticed you?"): only partially exposed by the protocol. Reliable telegraphs are creeper `metadata[16]` (fuse/swelling) and `[18]` (ignited), and living-entity `metadata[8] & 0x01` (drawing a bow, for skeletons). Zombies and similar expose no targeting flag, so fall back to an in-range plus moving-toward plus facing heuristic. Do not gate reflexes on provable aggro: treat any in-range hostile as a candidate (a false sidestep is harmless) and use the telegraphs only for the in-character "it has or has not noticed you" message.

   - **Non-interruptive by construction.** The reflex loop never enqueues into `src/bot/brain/fsm.js`, so it cannot trip the AbortController that would cancel an in-flight action such as `gather()`. Arrow dodge and melee strafe are pure control-state pulses that add lateral velocity for a few ticks and release, leaving the action's pathfinder goal untouched. Creeper flee is the one goal-owning reflex; it is made transparent by saving `bot.pathfinder.goal` before takeover and restoring it after, coordinated through a `bot._seiReflexActive` mutex that `goTo`/`follow`/`gather` yield to (the same pattern `combat.js` already uses with `stopFollow`/`startAttacking`). It must also suppress itself for a target the offensive `attack()` action is deliberately engaging.

   - **In-character announcement (the user's spec).** When reflexes activate, the bot emits an in-character `say()`-style message naming the threat and whether it has noticed the bot, then states the reflex is active and that the player can call `attack()`, or `explore()` to run if there are too many enemies. The reflex acts immediately in parallel; the message does not block the evasion.

   - **Per-persona reflexes.** Activation thresholds and the choice between fight and flee are personality-weighted (a cautious persona flees earlier and at lower enemy counts; a reckless one engages). This ties into the per-persona objective rubric from Phase 16 and Phase 21.

   - **Thresholds and config.** Skeleton and arrows arm at 16 blocks; creeper flee enters at 8 and exits at 12 (margin over the 3-block, 1.5 s, 30-tick fuse); melee kite at 4.5 blocks holding a 2.5 to 4 band. Enter/exit hysteresis prevents oscillation. New config keys under `adapter.minecraft`: `reflex_enabled` (default true), `reflex_tick_ms` (50), `arrow_watch_blocks` (16), `arrow_miss_threshold` (1.2), `creeper_flee_enter_blocks` (8), `creeper_flee_exit_blocks` (12), `melee_kite_blocks` (4.5).

4. **Progression as static data, not a planner.** Ship a progression dependency graph (`progression.json`) plus a pure `nextMilestone(state, goal)` walker that returns the nearest ready prerequisite and the single action that advances it, surfaced as one advisory `next:` snapshot line. This gives long-horizon coherence and a free curriculum without a planner module and without code generation. Source: Plan4MC skill graph, GITM tech-tree decomposition, Optimus-1 knowledge graph.

5. **Self-verifying tool results at zero extra LLM cost.** Sei already has the substrate: a `lastActionResult` string rendered into a `last_action_result:` snapshot line, and actions that return ad-hoc shapes such as `{ found: false, reason: ... }`. The change is to standardize every action return to a uniform `{ok, effect, reason, fix}` shape rather than per-action ad-hoc fields, and add handler-side precondition checks that name the missing precondition before an expensive failure. This collapses the Voyager critic and DEPS explain-before-replan ideas into the action handlers, so the single-layer model self-corrects on its next turn without a second model call. Verify claimed effects against the inventory and health deltas the snapshot already computes. Reflect and replan only on a detected discrepancy, never every turn.

6. **Procedural memory.** After a multi-step success, write a terse known-good procedure to memory (for example, how iron was obtained) so future turns retrieve it instead of re-deriving it. Source: JARVIS-1 plan retrieval; fits Sei's existing per-world memory.

7. **Concrete adapter additions (mineflayer-specific, prioritized).** Threat-safety spine: a `startThreatWatch` ticker plus a `threats:` snapshot line, a `fleeFrom` action, and migration of combat from the hand-rolled swing loop to `mineflayer-pvp` (correct cooldown and crit timing) with `fight`/`stopFighting` actions. Iron-tier crafting: a `smelt` action using `bot.openFurnace` that returns early and a `collectSmelted` pair, plus adopting `mineflayer-tool` so ore is mined with a sufficient tool (iron ore drops nothing below a stone pickaxe, a silent blocker today). Interaction: `useBlock` via `bot.activateBlock` for doors and levers (this packet path is unaffected by the bug in item 8), `readSign` via `block.getSignText()`, and self-relative `pillarUp`/`shelter` builds. Survivability: adopt `mineflayer-armor-manager`.

8. **Critical blocker to verify first.** `bot.activateItem()` is broken on Minecraft 1.21+ (mineflayer issue #3742, closed as not-planned; the `use_item` packet schema was not updated for the 1.21 wire format). This path is used by eating, `consume`, auto-eat, shield raising, and bow drawing. Eating is iron-tier-critical and currently routes through it. Action: connect to a real 1.21.x world and verify; add a single `seiActivateItem()` shim so the eventual protocol fix is a one-file change; if broken, hand-write the `use_item` packet with the 1.21 `yaw`/`pitch` fields or bump `minecraft-data`. Prefer block and entity interactions where possible, since those use a different unaffected packet.

   **Eating awareness (user requirement).** Eating is currently reflexive (driven by `mineflayer-auto-eat`), so the model is not aware it ate and cannot factor food into its reasoning or speech. Two things change here. First, fix or confirm the eating path against the `#3742` breakage above so eating works on 1.21+. Second, surface the eat as a self-verifying action result: when the bot eats (whether the model called `consume()` or the auto-eat reflex fired), feed the result back so the next turn's snapshot reflects it (`last_action_result:` for an explicit call, and a snapshot or event line such as "ate <food>, hunger now N" for a reflexive eat). The model should know it ate, what it ate, and the resulting hunger, the same way the `{ok, effect, reason, fix}` self-verifying convention in item 5 makes every other action observable. This keeps the survival reflex automatic while removing the blind spot.

9. **Open-source reference on the identical stack.** mindcraft-ce (mineflayer plus LLMs) already implements doors, fence gates, furnace smelting, and signs as parameterized commands, and keeps code generation off by default for safety. Read its behavior implementations for the mineflayer mechanics rather than re-deriving them. It also validates Sei's closed-registry stance.

### Phase 16 — Persona & Memory Core

Reports: `v0.4-companion-personality-memory.md`, `v0.4-persona-prompting-and-steering.md`, `v0.4-memory-and-relationship.md`.

Scope note: scored retrieval and write-time importance ranking (items 4 and 10 below) are deferred and are not built in v0.4. Phase 16 keeps memory simple: correct MEMORY.md injection and proper remember() usage. The research below is retained for the future memory work; the persona items (1, 2, 3, 5, 6, 7, 8) are what Phase 16 acts on.

1. **Drift is attention decay, not context overflow.** Self-consistency degrades more than 30 percent after 8 to 12 turns even with full context intact, and small models drift more (relevant because the default is Haiku-class). The retraining-free fix is to re-inject a compressed persona core (name plus about three traits plus register) at high recency on every turn, held at a static low depth. This validates the locked per-turn re-injection decision. Source: arXiv 2402.10962; SillyTavern Author's Note depth injection.

2. **Voice examples are the strongest anti-drift lever.** A few-shot of `say()` calls in the bot's own output format (Ali:Chat style, demonstrating register rather than situations) is the most-cited fix for drift and generic assistant voice. Positive demonstrations beat negations. Make the two or three defining traits load-bearing through redundancy (state them in the persona, in an example, and in a rule).

3. **Expansion uses a fixed-axis schema, not scenario scripts.** Generalizable axes: trait backbone (OCEAN-style), values and goals, an enumerated speech register (tone, rate, diction as a closed set, not free text), likes and dislikes, and stance toward the player. Refinements: enumerate register as a closed set for consistency (Voicing Personas, arXiv 2505.17093), preserve every seed fact and then elaborate (PersonaHub, arXiv 2406.20094), and constrain auto-expansion defaults to avoid stereotyped voice injection. Do not add hand-written situational examples; trait and register descriptions generalize across early game, late game, chat, and minigames, while scene scripts do not. This validates and refines the existing six-section `persona.expanded`.

4. **Memory: scored retrieval plus active callbacks.** Adopt the Stanford Generative Agents formula: score is recency plus importance plus relevance, each normalized to the 0 to 1 range, equal weights to start, recency decay factor 0.995, importance rated 1 to 10 by the model at write time, and reflection that distills raw entries into higher-level facts. The thing users actually perceive as an evolving relationship is concrete fact-recall callbacks (for example, recalling a disliked thing weeks later), not affinity meters. Auto-write facts more aggressively at write time rather than waiting for the model to volunteer them. Source: arXiv 2304.03442; MemGPT/Letta for the self-editing tiered model that resembles Sei's current `remember()`/`forget()`.

5. **Proactivity and honesty.** Gate proactive speech on having something worth saying rather than on a timer (Inner Thoughts, CHI 2025, arXiv 2501.00383), give proactive questions a motivated reason tied to shared activity (the Whispers from the Star lesson), acknowledge the user's answer, and pace intimacy gradually. When the companion is wrong about an in-game fact, recover in character with self-deprecation rather than a hard refusal or an out-of-character apology (RoleBreak, arXiv 2409.16727). Reliability is itself a rapport feature, and optimizing for per-turn approval drives sycophancy (the April 2025 GPT-4o rollback).

6. **The code-grounded gap.** Sei renders the persona front-loaded into the cached system prefix and never re-injects it near the recency end of the per-turn context. Drift research says that is the position a persona decays from fastest, so the fix is a compressed persona core re-injected at the recency tail of `composeSeedBlocks` every turn. Drift is measurable within about 8 turns, conversation history amplifies it, and it is worst for small models (the default Haiku-class), so this is high priority. Register is the hardest dimension for every model and does not come free from a trait list; it must be demonstrated. Sources: arXiv 2402.10962, PERSIST 2508.04826, PersonaGym 2407.18416.

7. **Card-schema target.** Cross-product convergence (SillyTavern, Character.AI, Kindroid, Replika, Nomi) is four elements: a prose trait body, example dialogue for voice, a small always-on atomic-facts store, and a short imperative style directive re-injected near the context end. Sei has the first and a partial second; it lacks the atomic-facts store and the re-injected directive. Add both.

8. **Expansion recipe (refined).** Separate generate-from-preserve (pin every seed fact as immutable, then elaborate), decouple identity/voice/scenario, enumerate the consistency-critical voice fields as a closed set, demonstrate register not situations, and explicitly counter the "assistant axis" attractor that weak personas snap back toward. Persona granularity scales with input richness, so thicken thin blurbs during expansion. Sources: PersonaHub 2406.20094, Voicing Personas 2505.17093.

9. **Hybrid steering verdict.** On hosted providers (Anthropic, OpenAI, OpenAI-compatible) there is no logprob or activation access, so every activation-steering and decoding-steering method is impossible; persona equals prompting on the default backend. The one real opportunity is local Ollama/llama.cpp control vectors via `vgel/repeng` (the open-weights form of Anthropic Persona Vectors, arXiv 2507.21509), built from the description Sei already collects. Treat it as a local-backend-only future spike with per-character tuning and a coherence guardrail, not a cross-provider feature.

10. **Memory design (concrete).** Adopt the Generative Agents scored retrieval (recency `0.995^(hours since retrieval)`, importance 1 to 10 at write, relevance, equal weights, each normalized) into the frozen-per-session prefix, with a Mem0-style ADD/UPDATE/DELETE/NOOP write vocabulary and MemoryBank decay replacing binary forget. At Sei's corpus size, lexical plus recency plus world-scope scoring beats embeddings (entity-dense memory is BM25's strength), so ship that first with zero new native dependencies; move to sqlite-vec + bge-small + reciprocal-rank fusion only if memory outgrows the prompt. Move compaction off the hot path into a sleep-time background editor. Perceived rapport comes from fact-recall callbacks and inside jokes, not affinity meters; keep memory user-visible and editable. Sources: arXiv 2304.03442, Mem0 2504.19413, MemoryBank 2305.10250, MemGPT/Letta 2310.08560, sleep-time compute 2504.13171.

11. **Deferred dynamic tone (designed, not built).** When the tone state machine is built in a later milestone, use a hidden Knapp-style relationship stage (milestone-gated, with hysteresis, no guilt-trip regression) crossed with a continuous valence/arousal mood (VADER per turn, momentum-smoothed, injected as a tone line). Do not learn the tone policy with approval-driven RL, which is the documented mechanism of sycophancy (warmth-training raises error 10 to 30 points); prompt-condition on the explicit hidden state and keep it hidden. Near-term, v0.4 gets the relationship feel from continuity callbacks, gated reciprocal self-disclosure, and warmth-without-capitulation, consistent with the deferred-state-machine decision. Sources: arXiv 2510.10079, 2310.13548, 2508.19258.

### Phase 21 — Minigames and varied behavior

Report: `v0.4-varied-behavior-and-minigames.md`.

1. **Why actions converge, and the fix.** RLHF biases models toward one helpful, fair, risk-neutral default, documented at both the persona layer (value inertia, dictator-game convergence across models) and the decoding layer (RLHF reduces output diversity). Adjectives do not move behavior; tying persona to a payoff does. Give each character an explicit objective function plus a short weighted priority rubric (for example curiosity, loyalty, caution, greed weights) that the brain reasons over before dispatching tools, bias tool selection per persona, and re-inject the objective into the per-turn snapshot (repeated interactions wash persona out). Sources: arXiv 2408.09049, 2511.08721, Phelps and Russell 2025.

2. **Variance knobs (separate from direction).** `min-p` (0.05 to 0.1) with temperature 1.0 to 1.5 raises behavioral variety without incoherence, but it is local-model only (Ollama, vLLM), not on Anthropic or Gemini (arXiv 2407.01082). For closed APIs (the default backend), use Verbalized Sampling (prompt for k options with probabilities) to recover about 2x diversity with no logit access (arXiv 2510.01171). The Zod registry is the validity guarantee, so decouple high-entropy action choice from schema-constrained arguments and run more entropy safely. Per-persona sampling profiles make variance itself a trait.

3. **Skill calibration is an architecture decision, not a prompt.** LLMs cannot self-handicap reliably; "play like a beginner" produces illegal or incoherent play, not believable weakness (arXiv 2406.07358). Put skill in an engine or sampling parameter. The believability standard is human-imitation calibration (Maia, arXiv 2409.20553): make mistakes position-dependent (pick a lower-evaluated move, blunder rate scales with difficulty) rather than uniform random, which feels alien. Stockfish `UCI_Elo` and MCTS sim-count are clean monotone dials but less believable. Lighter hybrids: bandits over per-persona strategy arms; activation steering only on local models.

4. **Division of labor.** The LLM plays directly for language, knowledge, social, and vision games. An engine plays and the LLM narrates in character for exact-state and search games (chess, Connect Four); never let the LLM compute the move (o3 plays at roughly 758 Elo). A vision LLM plays but is deliberately handicapped for GeoGuessr because frontier models are too strong.

5. **GeoGuessr (required).** Imagery: Mapillary API v4 as primary (free, CC BY-SA, cacheable), with Google Street View Static as an optional bring-your-own-key HD mode; pre-curate a vetted pano pool offline. Random valid locations via GeoNames populated places (country-weighted) with land and imagery-existence rejection. Map UI: MapLibre GL JS. Scoring: `5000 * exp(-distance_km / 2000)` with haversine. The companion plays via a vision model that outputs lat/lng plus reasoning, scored like the human and handicapped via low resolution or a time cap, with its reasoning surfaced as in-character chatter.

6. **Recommended trio: GeoGuessr, Codenames Duet, 20 Questions.** Together they cover vision, co-op, and conversational versus, and give one engine-tuned skill slider (Codenames via embeddings) and one believably-handicapped LLM slider (20 Questions, where weak play comes from stripping the reasoning scaffold and corrupting prior answers). Defer Connections (LLMs solve about 18 percent, no believable strong mode), Pictionary vision-guessing (weak VLM sketch recognition), and social deduction (multiplayer, conflicts with the single-companion loop). Sources: Codenames arXiv 2412.11373, 20 Questions BED-LLM arXiv 2508.21184.

### Phases 18, 19, 20 (implementative research at plan time)

Brain-surface decoupling, the UI overhaul, and ElevenLabs voice are implementation-driven and were not scoped for a separate external-literature stream. Their research is implementative (codebase integration, ElevenLabs API, UI patterns) and belongs in plan-phase. The earlier codebase grounding for these areas is already captured in the session and the locked decisions.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 16. Persona & Memory Core | 0/3 | Not started | - |
| 17. Minecraft Competence | 5/6 | In Progress|  |
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
