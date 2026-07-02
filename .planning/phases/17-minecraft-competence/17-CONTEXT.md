# Phase 17: Minecraft Competence - Context

**Gathered:** 2026-06-25
**Status:** Ready for planning

> **Revised after ROADMAP update.** The milestone front-loaded deep research at
> the milestone level (7 streams; folded into `ROADMAP.md` → "Research Findings"
> and reports in `.planning/research/`). Phase 17 is therefore **research-complete,
> not research-first** — it *builds on* the findings rather than starting with a
> research pass. An earlier draft of this file (pre-update) framed the phase as
> "start with deep research"; that premise is now obsolete.

<domain>
## Phase Boundary

Bring the companion's in-Minecraft capability up toward SOTA so it plays vanilla
well and can progress unaided to **iron tier**. The eight requirements
(MCRAFT-01..08) are the concrete targets:

- **Hard blocks** (don't exist today): furnace smelting/cooking (load input +
  fuel, retrieve output), **proactive** hostile-mob detection (currently reactive
  — must be *hit* first, so creepers kill it), sign reading, door/gate traversal.
- **Soft improvements:** positioning-based combat (today it stationary
  attack-spams), simple correct structure building (e.g. a shelter).
- **Integrative:** unaided progression from a fresh world to iron tier
  (wood → tools → food → shelter → mine → smelt iron), and vision-assisted
  navigation when vision is enabled.

The phase implements the **requirement-mapped research core** (reflex evasion
controller, missing primitives, progression-as-data) plus **procedural memory**
(see Decisions). A **redesign of the adapter is permitted** where the research
direction calls for it — not just additive patches — under the closed-registry
constraint (D-03).
</domain>

<decisions>
## Implementation Decisions

### Research posture — COMPLETE, build on it
- **D-01:** Phase 17 deep research is **done at the milestone level** and folded
  into ROADMAP. There is no further "start with research" gate. Reports to build
  on: `v0.4-mc-llm-planning.md`, `v0.4-mc-mineflayer-skills.md`,
  `v0.4-mc-rl-hybrid.md`, `v0.4-mc-reflex-dodge.md` (see canonical refs). One
  stream — a progression-DAG comparison — is still in progress and gets folded
  into the progression work (D-08) when it lands; do not block on it.
- **D-02 (control-surface verdict — decisive):** Do **NOT** pursue pixel-based RL
  / foundation policies (VPT, STEVE-1, GROOT, DreamerV3, MineDojo). They need a
  rendered client + GPU + 20 Hz inference, not viable on a consumer desktop.
  Sei's headless mineflayer protocol client (structured state + high-level API)
  is the right surface and sidesteps the problems those papers solve.
- **D-03 (closed registry — carried, binding):** registry stays closed — the LLM
  dispatches typed actions, never code or coordinates. Voyager-style
  code-as-skills is used for primitive/action *design* only, never as a runtime
  mechanism. New capabilities ship as new registered primitives.

### Architecture — hybrid hierarchy with classical game AI
- **D-04:** Adopt the portable hybrid pattern the leading agents share, all local
  / no GPU / no learned weights: **LLM** (intent + persona, ~0.2–2 Hz) → **static
  progression graph** (valid multi-step ordering) → **reactive reflex / behavior-
  tree / utility AI** (safety + combat, ~20 Hz) → **steering + pathfinder** (motor
  primitives) → mineflayer API. Sei is already an instance of this; the phase
  fills the reactive tier and the progression layer.

### Reflex evasion micro-controller (MCRAFT-02 / MCRAFT-03) — highest leverage
- **D-05:** Add `startReflex(bot, config)`, a **sibling of `startCombat` in
  `behaviors/combat.js`**, wired from the same place. A ~20 Hz survival loop on
  `bot.on('physicsTick')` (50 ms) that reads the entity list each tick and evades
  **before** damage lands — fixing the named failures (reacts only after
  `entityHurt`, dies to creepers, freezes in fights). Full design in
  `v0.4-mc-reflex-dodge.md`. Key constraints:
  - **No single library does this — stitch four small pieces:** (a) arrow dodge
    (hand-rolled closest-approach ray test + lateral `setControlState` pulse,
    ~40 LOC, no dep); (b) creeper flee (`mineflayer-pathfinder`
    `GoalInvert(GoalFollow(creeper,10))`); (c) melee strafe (port the "circle"
    strafe from `@nxg-org/mineflayer-custom-pvp` rather than adding the dep;
    `mineflayer-pvp` has no strafe); (d) aggro telegraphs (creeper `metadata[16]`
    fuse / `[18]` ignited, skeleton bow `metadata[8]&0x01`; otherwise in-range +
    moving-toward + facing heuristic). Do not gate reflexes on provable aggro —
    treat any in-range hostile as a candidate; a false sidestep is harmless.
  - **Non-interruptive by construction:** the reflex loop **never enqueues into
    `fsm.js`**, so it cannot trip the AbortController that would cancel an
    in-flight action (e.g. `gather()`). Dodges/strafes are pure control-state
    pulses; creeper-flee is the one goal-owning reflex — save/restore
    `bot.pathfinder.goal` and coordinate via a `bot._seiReflexActive` mutex that
    `goTo`/`follow`/`gather` yield to (same pattern `combat.js` already uses).
    Suppress reflexes for a target `attack()` is deliberately engaging.
  - **In-character announcement (user's spec):** on activation the bot emits a
    `say()`-style line naming the threat + whether it noticed the bot, states the
    reflex is active, and offers the player a choice (call `attack()`, or
    `explore()` to run if outnumbered). The message does not block evasion.
  - **Config (under `adapter.minecraft`):** `reflex_enabled` (true),
    `reflex_tick_ms` (50), `arrow_watch_blocks` (16), `arrow_miss_threshold`
    (1.2), `creeper_flee_enter_blocks` (8), `creeper_flee_exit_blocks` (12),
    `melee_kite_blocks` (4.5); enter/exit hysteresis to prevent oscillation.
- **D-06 (per-persona reflexes — DEFERRED to fixed defaults this phase):** ship
  **fixed sensible default** thresholds in Phase 17. Persona-weighting (cautious
  flees earlier, reckless engages) is real but couples to Phase 16's persona
  rubric — it is **deferred** to keep Phase 17 independent of Phase 16 (per
  ROADMAP "Depends on: Nothing"). Leave a clean hook for later weighting.

### Progression (MCRAFT-07)
- **D-07:** Progression as **static data, not a planner.** Ship a dependency
  graph (`progression.json`) + a pure `nextMilestone(state, goal)` walker that
  returns the nearest ready prerequisite and the single advancing action,
  surfaced as one advisory `next:` snapshot line. Gives long-horizon coherence +
  a free curriculum with no planner module and no code generation (sources:
  Plan4MC skill graph, GITM tech-tree, Optimus-1 knowledge graph). **Do NOT build
  a GOAP planner** — the static graph supersedes it. Builds on the existing
  `observers/progression.js` iron-tier ladder; fold the in-progress DAG-comparison
  report in when it lands.

### Procedural memory (IN scope — user-selected)
- **D-08:** After a multi-step success (e.g. "how iron was obtained), write a
  terse known-good **procedure** to memory so future turns retrieve it instead of
  re-deriving (research item 6; JARVIS-1 plan retrieval). Reuses Sei's existing
  per-world memory store.

### Missing primitives (MCRAFT-01 / 04 / 05 / 06)
- **D-09:** New registered actions/behaviors: **furnace** 3-slot handling
  (input + fuel + output; `container.js` is the near-template), **sign reading**
  (block text → snapshot/tool), **door/gate activation** (`activateBlock` — note
  the current `activate.js` only right-clicks the *held item*), and **shelter
  building** on top of the existing `build`/`placeBlock` cuboid primitive. The
  prompt capability contract (`prompts.js`) must be rewritten — it currently tells
  the bot "you can't smelt… ask the player."

### Vision-assisted navigation (MCRAFT-08)
- **D-10:** **On-demand / on-failure.** The deep research did not cover this (the
  MC streams are structured-state-focused and rejected pixel control). Reuse the
  vision-gated `look` tool from Phase 15: reach for it when navigation **fails or
  terrain is ambiguous** (and when the player asks); coordinates/snapshot drive
  the rest. Cheapest path; respects cloud vision-token cost. Not always-on.

### Companion disposition — "the SMP friend" (north star, carried)
- **D-11:** The companion **can solo the game but chooses to involve the player.**
  User's framing: "my friend can beat the game alone but chooses to play SMP with
  me." Capability (unaided iron tier, MCRAFT-07) and disposition (togetherness)
  are separate; default runtime disposition is to involve the player, not run off
  and solo the world. The reflex in-character announcement (D-05) and procedural
  recall (D-08) are expressions of this.
- **D-12 (idle / player-not-engaged — tiered):** passive (stay put) → reactive
  (light chores: wood, food, cobble) → agentic (since it *can* solo, when it would
  otherwise push the game forward alone it **asks/invites the player** instead).
  Maps onto FSM idle/heartbeat; exact thresholds for planning.
- **D-13 (stuck / failure):** when genuinely blocked (no iron, missing tool,
  pathfinding stuck) it **asks the player, in character** — turn the block into an
  invite ("can't find iron anywhere, wanna go cave-diving?"), not silent retry or
  solo pivot.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (planner; researcher if re-run) MUST read these before planning or implementing.**

### Completed deep research (the design basis — read first)
- `.planning/research/v0.4-mc-reflex-dodge.md` — **full reflex/evasion design**
  (D-05): arrow dodge, creeper flee, melee strafe, aggro telegraphs, the
  non-interruptive mutex pattern, thresholds/config. Most load-bearing report.
- `.planning/research/v0.4-mc-rl-hybrid.md` — control-surface verdict (D-02) and
  the hybrid-hierarchy architecture (D-04).
- `.planning/research/v0.4-mc-llm-planning.md` — progression-as-data + `next:`
  line (D-07), self-verifying action returns (deferred — see Deferred), procedural
  memory (D-08).
- `.planning/research/v0.4-mc-mineflayer-skills.md` — mineflayer plugin/primitive
  survey for furnace/sign/door/skills (D-09).
- `.planning/research/v0.4-mc-progression-dag-comparison.md` — **in progress**;
  fold into D-07 when complete. Do not block on it.
- `.planning/ROADMAP.md` → "Research Findings" → "Phase 17" — the synthesis that
  consolidates the above (items 1–6).

### Milestone & requirements framing
- `.planning/REQUIREMENTS.md` — MCRAFT-01..08 (lines 44–51) locked acceptance
  targets; full game completion (Nether→End) is out of scope (line 104).
- `.planning/PROJECT.md` — v0.4 "Minimum Desirable Companion"; Sei is a companion,
  not "a monkey who can play games."
- `.planning/STATE.md` — Locked Decision 11 (closed registry).

### Existing adapter — build-on / redesign targets
- `src/bot/adapter/minecraft/behaviors/combat.js` — `startCombat`; reflex
  controller is its **sibling**. Has the `HOSTILE_MOBS` set + stop/start mutex
  pattern to reuse.
- `src/bot/adapter/minecraft/behaviors/attack.js` — offensive `attack()`; reflexes
  must suppress for its deliberate target.
- `src/bot/adapter/minecraft/behaviors/activate.js` — only right-clicks the held
  item; door/gate needs `activateBlock` (MCRAFT-05 gap).
- `src/bot/adapter/minecraft/behaviors/container.js` — chest ops; furnace template.
- `src/bot/adapter/minecraft/behaviors/build.js` + `registry.js` `build`/
  `placeBlock` (256-cell cuboid) — shelter basis (MCRAFT-06).
- `src/bot/adapter/minecraft/observers/progression.js` — iron-tier milestone
  ladder; basis for `progression.json` + walker (D-07).
- `src/bot/adapter/minecraft/observers/{entities,lineOfSight,targeting}.js` —
  entity + LOS scanning the reflex loop reads each tick.
- `src/bot/adapter/minecraft/prompts.js` — capability contract to rewrite (stop
  telling the bot it can't smelt / must defer to player).
- `src/bot/brain/fsm.js` + `adapter/minecraft/fsmWires.js` — P0_SAFETY priority
  queue. Note: the reflex loop deliberately runs **outside** the FSM (D-05).
- `src/bot/brain/memory/` — per-world memory store for procedural write-back (D-08).
- `src/bot/config.js` — where the new `adapter.minecraft` reflex config keys land.

### Prior field findings (same problem space)
- `.planning/phases/15-in-game-vision-via-prismarine-viewer/15-CONTEXT.md` — the
  `look`/vision foundation MCRAFT-08 reuses (D-10).
- `.planning/heartbeat-progression-results-260615.md` — prior progression/
  heartbeat experiment.
- `.planning/movement-vision-fix-260616b.md`, `.planning/spam-narration-fix-260616.md`
  — movement/vision + narration-spam fixes (relevant to reflex announcement
  cadence in D-05 and chore-narration visibility in D-12).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`startCombat` mutex pattern** (`combat.js`): `stopFollow`/`startAttacking`
  save/restore + the `HOSTILE_MOBS` set are the exact template for `startReflex`
  and its `bot._seiReflexActive` mutex (D-05).
- **`mineflayer-pathfinder`** (already a dependency): `GoalInvert(GoalFollow)` is
  the creeper-flee primitive — no new dep.
- **Container ops** (`container.js`): near-template for furnace 3-slot handling.
- **Progression observer** (`progression.js`): already models the iron ladder —
  evolve toward the static `progression.json` + walker (D-07).
- **`build`/`placeBlock` cuboid** (256-cell capped) — shelter basis (MCRAFT-06).
- **Vision `look`** (Phase 15, vision-gated) — MCRAFT-08 (D-10).
- **Per-world memory** — procedural write-back target (D-08).

### Established Patterns / Constraints
- **Single-layer brain, closed typed registry** — keep the contract (D-03).
- **The reflex tier runs OUTSIDE the FSM** (D-05) — unlike normal P0_SAFETY work
  it must not enqueue or it would abort in-flight actions.
- **Pathfinder calls are wall-clock-timeout-wrapped (12s)** — any flee/kite
  movement respects the no-silent-hang rule.

### Integration Points
- `startReflex` wired alongside `startCombat`; reads entity/LOS observers per tick.
- New furnace/sign/door primitives → `registry.js` + a behavior file each.
- `progression.json` + walker → new `next:` snapshot line.
- Procedural write-back → memory store after multi-step success.
- `prompts.js` capability contract rewrite.
- New reflex config keys → `config.js` under `adapter.minecraft`.
</code_context>

<specifics>
## Specific Ideas

- **North-star analogy:** "My friend can beat the game alone but chooses to play
  SMP with me." Capability full; disposition togetherness.
- **Reflex UX (user's spec, from research):** on threat, announce in-character +
  offer the player `attack()` or `explore()`-to-flee; evade immediately in
  parallel. Failure framed as invitation, not a robot erroring out.
- **No GPU, no pixel RL** (D-02) — every tier is local classical game AI on
  structured state.
</specifics>

<deferred>
## Deferred Ideas

- **Self-verifying action returns** (research item 5): standardizing all ~18
  actions to a uniform `{ok, effect, reason, fix}` shape + precondition checks.
  Considered and **deferred this phase** (user scoped Phase 17 to procedural
  memory only). Strong fast-follow candidate — directly de-risks unaided
  iron-tier; revisit if MCRAFT-07 reliability is shaky in testing.
- **Per-persona reflex weighting** (D-06): deferred until Phase 16's persona
  rubric exists, to keep Phase 17 independent. Phase 17 ships fixed defaults with
  a hook.
- **GOAP planner:** explicitly NOT pursued — the static progression graph (D-07)
  supersedes it.
- **Full game completion** (Nether → End → Ender Dragon): out of scope; this phase
  stops at the iron-tier spine.
- **Varied in-game behavior by personality** (LLM actions converge regardless of
  prompt): scheduled as its own research-gated track in Phase 21.
- **Modded / omni-game adapter:** dropped for v0.4 (vanilla only).
</deferred>

---

*Phase: 17-minecraft-competence*
*Context gathered: 2026-06-25 (revised after ROADMAP research-fold update)*
</content>
