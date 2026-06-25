# Phase 17: Minecraft Competence - Context

**Gathered:** 2026-06-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Bring the companion's in-Minecraft capability up toward SOTA so it can play
vanilla well and progress unaided to **iron tier**. The eight requirements
(MCRAFT-01..08) are the concrete targets:

- **Hard blocks** (capabilities that don't exist today): furnace smelting/cooking
  (load input + fuel, retrieve output), **proactive** hostile-mob detection
  (currently reactive — it must be *hit* before reacting, so creepers kill it),
  sign reading, door/gate traversal.
- **Soft improvements:** positioning-based combat (today it stationary
  attack-spams), simple correct structure building (e.g. a shelter).
- **Integrative:** unaided progression from a fresh world to iron tier
  (wood → tools → food → shelter → mine → smelt iron), and vision-assisted
  navigation when vision is enabled.

**This phase is research-led, not "expand the existing registry."** Its purpose
is to **integrate external knowledge** (open-source Minecraft bots/agents, NVIDIA
Voyager / MineDojo / MineRL, mineflayer plugins, primitive-function design, RL,
vision approaches), then redesign the adapter against that knowledge. A
**complete redesign of the Minecraft adapter is in scope** — not just additive
patches to the current 18-action set. The closed-registry constraint still holds
(see Decisions): research informs primitive/action *design*, never code-as-skills.
</domain>

<decisions>
## Implementation Decisions

### Research is the first activity (not optional)
- **D-01:** Phase 17 **begins with deep research**, before any design or
  planning of the adapter changes. The user was explicit: "Start with research.
  This isn't an 'expand' capabilities — it might involve a complete redesign."
  Do not pre-decide the threat model, combat algorithm, or vision-navigation
  policy from current code — those are **outputs of the research**, not inputs.
- **D-02:** A full **adapter redesign is permitted**. The existing 18-action
  registry, `combat.js`, `progression.js`, observers, and prompt contract are
  redesign *targets*, not fixed scaffolding to extend. Evaluate whether the
  current single-call-reactive structure can reach the requirements or needs
  reworking (e.g. proactive safety loop, primitive library, skill composition
  within the closed registry).

### Closed-registry constraint (carried from v0.4 Decision 11 / ROADMAP)
- **D-03:** The action registry **stays closed** — the LLM dispatches typed
  actions, never writes code or raw coordinates. Voyager-style "code-as-skills"
  / self-authored skill libraries are studied for **primitive and action design
  only**, and are NOT adopted as a runtime mechanism. New capabilities ship as
  new registered primitives/composite actions.

### Companion disposition — "the SMP friend" (north star)
- **D-04:** The companion **can solo the game, but chooses to involve the
  player** because doing things together is the point. User's framing: "my
  friend can beat the game alone but chooses to play SMP with me." Capability
  and disposition are separate: the *capability* to reach iron tier unaided is a
  real, tested success criterion (MCRAFT-07); the *default runtime disposition*
  is to involve the player rather than run off and solo the world.
- **D-05 (idle / player-not-engaged behavior — tiered):** when the player is
  offline / AFK / off doing their own thing, behavior spans a spectrum the user
  described as **passive → reactive → agentic**:
  - *Passive:* stay put / hold position.
  - *Reactive:* do light chores (gather wood, food, cobble).
  - *Agentic:* since it is *capable* of soloing, when it would otherwise push
    the game forward on its own, it should **ask the player** / invite them in
    rather than silently advancing milestones alone.
  Exact thresholds and how this maps to FSM idle/heartbeat behavior is for
  research + planning to resolve; the principle is "don't run off and solo it."
- **D-06 (stuck / failure behavior):** when it genuinely can't progress (no iron
  found, missing a tool, pathfinding stuck), it **asks the player, in
  character** — turn the block into a companion invite ("I can't find iron
  anywhere, wanna go cave-diving?") rather than silent retry or solo pivot.

### Claude's Discretion — explicitly deferred to research, NOT user-decided
The user declined to pre-answer these and routed them to research. Downstream
researcher/planner derive these from external knowledge, then surface
recommendations:
- **Threat / combat disposition** (fight vs. flee defaults, creeper handling,
  whether bravery varies by personality vs. a fixed hardcoded safety floor).
  User: "This is hard coded. Do research first." Treat the proactive-safety
  reaction as a mechanical layer whose design comes from research.
- **Positioning-combat algorithm** (kiting/strafing/reach management).
- **Vision-assisted navigation aggressiveness** (on-demand vs. proactive vs.
  always-on; cost tradeoff on the cloud backend). May be a redesign, not a knob.
- **Whether progression needs an explicit goal/plan scaffold** vs. the
  single-layer brain reacting to the progression snapshot.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner) MUST read these before planning or implementing.**

### Milestone & requirements framing
- `.planning/PROJECT.md` — v0.4 "Minimum Desirable Companion" framing; Sei is a
  companion (emotional connection), not "a monkey who can play games."
- `.planning/REQUIREMENTS.md` — MCRAFT-01..08 (lines 44–51) are the locked
  acceptance targets; out-of-scope note: full Nether→End→Ender-Dragon completion
  is a stretch beyond the iron-tier spine.
- `.planning/ROADMAP.md` — Phase 17 section: research mandate already states
  "open-source Minecraft bots and agents (mineflayer plugins, Voyager, MineDojo,
  primitive design) under [the closed-registry] constraint."
- `.planning/STATE.md` — Locked Decisions 11 (closed registry) and the note that
  "Minecraft bot SOTA" deep research is scheduled inside this phase.

### Existing adapter — redesign targets (read to know current state & its limits)
- `src/bot/adapter/minecraft/registry.js` — current 18-action set; the schema/
  primitive surface to redesign.
- `src/bot/adapter/minecraft/behaviors/combat.js` — current combat: reactive
  (`entityHurt`), stationary attack-spam. Both the MCRAFT-02 and MCRAFT-03 pain
  points live here.
- `src/bot/adapter/minecraft/behaviors/activate.js` — only right-clicks the
  *held item*; no block activation → no door/gate opening (MCRAFT-05 gap).
- `src/bot/adapter/minecraft/behaviors/container.js` — chest open/deposit/
  withdraw; no furnace 3-slot handling (MCRAFT-01 gap).
- `src/bot/adapter/minecraft/observers/progression.js` — iron-tier milestone
  ladder (furnace, iron_pickaxe nodes already modeled). Drives MCRAFT-07.
- `src/bot/adapter/minecraft/observers/entities.js` + `lineOfSight.js` /
  `targeting.js` — nearest-entity + LOS scanning; the substrate a proactive
  threat detector would build on.
- `src/bot/adapter/minecraft/prompts.js` — current capability contract that
  literally tells the bot "you can't smelt… ask the player." Must change.
- `src/bot/brain/fsm.js` + `src/bot/adapter/minecraft/fsmWires.js` — P0_SAFETY →
  P1_CHAT → P2_MOVEMENT → P3_IDLE priority queue; where a proactive-safety
  trigger and idle/heartbeat disposition (D-05) would wire in.

### Prior in-the-field findings (same problem space)
- `.planning/phases/15-in-game-vision-via-prismarine-viewer/15-CONTEXT.md` —
  vision/`look` foundation MCRAFT-08 builds on.
- `.planning/heartbeat-progression-results-260615.md` — prior progression/
  heartbeat experiment results.
- `.planning/movement-vision-fix-260616b.md` — movement + vision fixes.
- `.planning/spam-narration-fix-260616.md` — narration/spam control (relevant to
  how visibly the bot narrates chores/struggle under D-05/D-06).

### External knowledge to research (entry points, not exhaustive)
- NVIDIA **Voyager** (open-ended embodied agent, skill library) — for primitive/
  action design only (D-03).
- **MineDojo** / **MineRL** — task suites, knowledge base, RL baselines.
- **mineflayer plugin ecosystem** — pathfinder (door-aware movement), pvp,
  collectblock, auto-eat, tool, and any furnace/sign helpers.
- Pre-LLM Minecraft bot literature on primitive-function design and combat
  (kiting/positioning).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Container ops** (`container.js`): `openContainer`/`depositItem`/
  `withdrawItem` are a near-template for furnace slot handling — furnace adds
  input/fuel/output semantics on top.
- **Entity + LOS observers** (`entities.js`, `lineOfSight.js`, `targeting.js`):
  already compute nearest entities and clear line of sight — the raw signals a
  proactive threat detector needs; no new sensing primitives required to start.
- **Progression observer** (`progression.js`): already models the iron-tier
  milestone ladder (incl. furnace and iron_pickaxe nodes) — the spine for
  MCRAFT-07 scoring/goal tracking.
- **`build`/`placeBlock` + cuboid schema** (`registry.js`, `build.js`): a
  256-cell-capped structured placement primitive — basis for shelter building
  (MCRAFT-06).
- **`look` / vision render** (vision-gated `visualize.js`): MCRAFT-08 foundation
  from Phase 15.

### Established Patterns
- **Single-layer brain, closed typed registry** — one LLM call reasons +
  dispatches registered actions. Redesign must keep this contract (D-03) even if
  it adds composite/long-running primitives.
- **Event-sourced FSM with P0_SAFETY** — proactive threat response belongs at
  P0; the priority queue + single AbortController is the place a "retreat from
  creeper before being hit" reaction must preempt.
- **Pathfinder calls are wall-clock-timeout-wrapped** (12s default) — any new
  navigation/combat movement must respect this no-silent-hang rule.

### Integration Points
- New furnace/sign/door primitives → `registry.js` + a behavior file each.
- Proactive threat trigger → new observer signal + `fsmWires.js` P0 emission.
- Idle/agentic disposition (D-05) → FSM idle/heartbeat + prompt contract.
- Prompt capability contract (`prompts.js`) must be rewritten to stop telling the
  bot it can't smelt / must defer to the player.
</code_context>

<specifics>
## Specific Ideas

- **North-star analogy (D-04):** "My friend can beat the game alone but chooses
  to play SMP with me." Capability is full; disposition is togetherness.
- **The phase is step 2–3 of the user's v0.4 plan:** (2) deep research on how
  other bots play Minecraft well — open-source agents, function libraries, RL,
  vision, multi-agent; (3) adjust/redesign the adapter so companions can beat
  the game on their own, fixing hard blocks (furnace, mob alertness) and soft
  ones (combat), plus signs, doors, visual navigation.
- **Failure framed as invitation (D-06):** the *intended feel* of a stuck moment
  is a companion turning to you, not a robot erroring out.
</specifics>

<deferred>
## Deferred Ideas

- **Full game completion** (Nether → End → Ender Dragon unaided) — explicitly
  out of scope per REQUIREMENTS; this phase stops at the iron-tier spine.
- **Personalization / dynamic tone / memory-reference behavior** — that's the
  Persona & Memory Core (Phase 16) and later tone work, not Phase 17.
- **Varied in-game behavior by personality** (LLM actions converge regardless of
  prompt) — the user scheduled this as its own deep-research track for Phase 21,
  not here. Combat *bravery* variation touches it but is deferred to research.
- **Modded / omni-game adapter** — dropped for v0.4; vanilla only.
</deferred>

---

*Phase: 17-minecraft-competence*
*Context gathered: 2026-06-25*
</content>
</invoke>
