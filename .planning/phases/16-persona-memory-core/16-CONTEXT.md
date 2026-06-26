# Phase 16: Persona & Memory Core - Context

**Gathered:** 2026-06-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 16 builds the shared persona + memory substrate, still Minecraft-attached (chat/voice/minigame surfaces arrive in Phases 18-21). It delivers:

1. A drift-resistant persona: a compressed persona core re-injected at high recency every turn.
2. A surface-agnostic persona structure: the expander is restructured into a universal core plus a separate Minecraft addendum, so Phase 18 can attach other surfaces without rewriting persona logic.
3. Character-specific, scenario-agnostic few-shot `say()` voice examples.
4. In-character, persona-modulated proactivity (a cold character asks fewer questions than a warm one).
5. Honest handling of its own mistakes.
6. Correct memory plumbing: MEMORY.md properly injected, `remember()` used properly. Runtime memory stays local-only.

**Scope override (important):** the roadmap's locked "scored retrieval + importance ratings" memory overhaul (MEM-01, MEM-02, and the Generative Agents recommendation in research) is **descoped** for this phase per the user. Memory stays roughly as-is (append-only MEMORY.md, current seeding); only injection correctness and `remember()` usage are addressed. See D-06/D-07 and the reconciliation note in Deferred.

</domain>

<decisions>
## Implementation Decisions

### Persona core (drift fix — PERSONA-03)
- **D-01:** The persona expander (`src/main/personaExpansion.ts`) gains a dedicated `# CORE` section authored at character-save time: a tight ~3-5 line distillation = name + ~3 defining traits + register. Deterministic, cacheable, author-controlled (chosen over runtime programmatic compression or a runtime LLM re-compression). The runtime lifts `# CORE` and re-injects it at the **recency tail of `composeSeedBlocks` every turn** — this is the core anti-drift mechanism. Validated by research (drift = attention decay; re-inject compressed core at high recency).
- **D-02:** `# CORE` is written **surface-agnostic** (no Minecraft verbs), so the drift-fighting tail already generalizes across surfaces.

### Voice examples (PERSONA-04)
- **D-03:** Few-shot `say()` voice examples are **character-specific but scenario-agnostic** — they demonstrate the character's register/voice, never tied to a situation ("gathering wood", "being attacked"). They live in the **cached `# VOICE` prefix** (not re-injected in the tail). PERSONA-04 is satisfied because `# VOICE` is part of the assembled prompt. Matches research: "demonstrate register, not situations" (Ali:Chat style).

### Persona structure (surface split — PERSONA-02)
- **D-04:** Restructure the expander **now** into a **universal persona core** (identity, voice, values, stance, general proactivity flavor — surface-agnostic) **plus a separate Minecraft addendum block** (the MC-specific behaviors: `follow`/`setGoal`, biome/project goal-type fit, MC reactions). Phase 18 then attaches per-surface addenda rather than rewriting persona logic. Chosen over deferring the split entirely to Phase 18, because Phase 16 is billed as the shared substrate so the split is honest here.

### Proactivity (in-character interaction — MEM-03-adjacent)
- **D-05:** Proactive questions / talking to the player are **persona-modulated**: a cold character asks the player fewer questions, a warm one more. In-character and not a uniform "ask about the user" behavior. Lives in the universal persona core (it is social/surface-agnostic). Aligns with research item 5 (gate proactive speech on having something worth saying; motivated reason).

### Honest mistakes (PERSONA-06)
- **D-06:** Driven by **prompt instruction + the model writing failures to memory** — when something does not work or it was wrong, the bot owns it in character (self-deprecation, RoleBreak) and records the failure with `remember()` so it learns and does not repeat it. **No hardcoded failure detection** (no action-result diffing, no correction-classifier).

### Memory (scoring descoped)
- **D-07:** **No scored retrieval, no importance ratings.** This overrides the roadmap's locked MEM-01/MEM-02 and the Generative Agents recommendation in research. Memory stays append-only MEMORY.md with the current seeding approach.
- **D-08:** Phase 16 memory work is narrow: ensure **MEMORY.md is properly injected** into the prompt, and **`remember()` usage is proper** (right cadence, right content — subjective entries, not transaction logs). Runtime memory stays **local-only** (MEM-06, carried from v0.3).
- **D-09:** **No separate atomic-facts store.** Active recall (MEM-03) is not a dedicated mechanism — it falls out of MEMORY.md being present in the prompt plus persona prompting. (Chosen over a new structured player-facts store or upgrading PLAYER.md into one.)

### Claude's Discretion
- Exact length/format of the `# CORE` section and how it is detected/extracted by the runtime.
- Precise wording of the `remember()` cadence guidance and the honesty/self-deprecation instruction.
- Mechanism for "properly injected MEMORY.md" — diagnose the current `readMemoryForSeed` wiring and fix whatever is off; no specific approach mandated.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/ROADMAP.md` §"Phase 16: Persona & Memory Core" — goal, success criteria.
- `.planning/ROADMAP.md` §"Research Findings → Phase 16 — Persona & Memory Core" — the prescriptive research synthesis (note: items 4/10 scored-retrieval are descoped here, see D-07).
- `.planning/REQUIREMENTS.md` §"Persona Core (PERSONA)" and §"Memory (MEM)" — PERSONA-01..06, MEM-01..06 (MEM-01/MEM-02 descoped — reconcile).

### Phase 16 deep research
- `.planning/research/v0.4-companion-personality-memory.md` — companion design (character.ai, drift, callbacks).
- `.planning/research/v0.4-persona-prompting-and-steering.md` — persona expansion schema, register-as-closed-set, anti-drift levers.
- `.planning/research/v0.4-memory-and-relationship.md` — memory architecture (scored retrieval is here but descoped for this phase).

### Code to change / reuse
- `src/main/personaExpansion.ts` — the 6-section expander to restructure (add `# CORE`; split universal core vs MC addendum). `EXPANSION_SYSTEM`, `REQUIRED_SECTION_HEADERS`.
- `src/bot/brain/prompts.js` — `renderPersona()`, `BASELINE_INSTRUCTIONS`, `PERSONALITY_TOOL_DESCRIPTIONS.say`/`.remember`, proactiveness directives.
- `src/bot/brain/orchestrator.js` — `composeSeedBlocks` (cache layout; where `# CORE` re-injects at the recency tail) and `rebuildPersonalitySystem()` (cached system prefix).
- `src/bot/brain/memory/memoryLog.js` — `readMemoryForSeed`, `appendMemory`/`remember`, `forgetMemory` (verify injection correctness).
- `src/shared/characterSchema.ts` — `PersonaSchema` (`source` / `expanded`); structural changes to `expanded` ripple here.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `personaExpansion.ts`: a working 6-section expander (`# IDENTITY / # VOICE / # DEFAULT DYNAMIC / # PROACTIVENESS / # REACTIONS / # MEMORY`) with stable cacheable system prompt and tolerant header detection. Extend it (`# CORE`, universal/MC split) rather than rebuild.
- `# VOICE` already emits 5-7 sample utterances — the substrate for D-03; tighten them to be scenario-agnostic.
- `composeSeedBlocks` / `rebuildPersonalitySystem` already implement the ordered cache-breakpoint layout — the re-injected `# CORE` slots into the recency tail of `composeSeedBlocks`.
- `memoryLog.js` already segments MEMORY.md by world and has seed-truncation + compaction that preserve `## World N` headers — keep these invariants.

### Established Patterns
- Persona is currently front-loaded into the **cached system prefix** and never re-injected near recency — the exact gap PERSONA-03 fixes (research item 6).
- `remember()` is one-arg (`remember(text)`), append-only, subjective-only by contract (the `# MEMORY` section bans fact/transaction logs). Staying one-arg (no importance) per D-07.
- Closed Zod action/tool registry stays closed (v0.4 locked decision 8).

### Integration Points
- New `# CORE` re-injection: `composeSeedBlocks` tail in `orchestrator.js`.
- Expander structural change: `personaExpansion.ts` output + `characterSchema.ts` `expanded` consumers (`renderPersona` in `prompts.js`).
- Existing saved characters have old-format `expanded` — migration / re-expansion needs handling (see Deferred / open question).

</code_context>

<specifics>
## Specific Ideas

- Persona core = name + ~3 traits + register, re-injected at the recency tail every turn; surface-agnostic.
- Voice examples must read like the character but be free of any scenario ("gathering wood", "being attacked").
- Cold characters ask fewer questions; warm characters ask more — proactivity scales with persona.
- When the bot is wrong, it owns it (self-deprecating, in voice) and `remember()`s the failure; no detection code.
- Keep memory dead simple this phase — no scoring, no importance, no new facts store.

</specifics>

<deferred>
## Deferred Ideas

- **Scored memory retrieval + importance ratings (Generative Agents formula).** Roadmap/research recommended it (MEM-01, MEM-02, research items 4/10) but the user descoped it from Phase 16. Possible future milestone. **Action: reconcile `.planning/REQUIREMENTS.md` (MEM-01, MEM-02) and `.planning/ROADMAP.md` locked decision #3 / Phase 16 research items with this descope before/at planning** so downstream agents do not re-introduce scoring.
- **Atomic-facts store about the player (user-visible/editable).** Research item 7/10 flagged it as missing; user chose not to add it. Could revisit if active recall proves too weak.
- **Full universal-core / per-surface (chat/voice/minigame) addenda.** Phase 16 does the universal-core + MC-addendum split; the additional surface addenda are Phase 18.
- **Cross-surface memory continuity (MEM-05).** Phase 18 (shared memory + handoff bridge).
- **Dynamic tone / relationship state machine.** Deferred to a later milestone (existing locked decision).
- **Local-backend persona control vectors (repeng / Persona Vectors).** Research item 9 — local-Ollama-only future spike, not a v0.4 feature.

</deferred>

---

*Phase: 16-persona-memory-core*
*Context gathered: 2026-06-25*
