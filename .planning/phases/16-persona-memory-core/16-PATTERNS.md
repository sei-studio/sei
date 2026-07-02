# Phase 16: Persona & Memory Core - Pattern Map

**Mapped:** 2026-06-25
**Files analyzed:** 5 (all MODIFY — no new files; this is a prompt-tuning / persona-assembly phase)
**Analogs found:** 5/5 (every target is an existing file/section being edited in place; analogs are the current code being modified, plus sibling sections to copy structure from)

> This phase modifies existing prompt-assembly code rather than creating new
> subsystems. So "analog" here means **the current structure of each target**,
> documented so the planner can write concrete, surgical edit instructions. Where
> a NEW section/block must be added, the analog is the closest existing
> section/block whose shape it should copy.

## File Classification

| Modified File | Role | Data Flow | Closest Analog (within file) | Match Quality |
|---------------|------|-----------|------------------------------|---------------|
| `src/main/personaExpansion.ts` | config / prompt-generator (main process) | request-response (LLM call) | existing 6-section `EXPANSION_SYSTEM` + `REQUIRED_SECTION_HEADERS` + `SECTION_LABELS` | exact (extend in place) |
| `src/bot/brain/prompts.js` | prompt template module | transform (pure string builders) | `renderProactivenessDirective` (new `# CORE` extractor mirrors it); existing `PERSONALITY_TOOL_DESCRIPTIONS.remember` / `BASELINE_INSTRUCTIONS` text | exact |
| `src/bot/brain/orchestrator.js` | service (brain orchestrator) | transform / event-driven | `composeSeedBlocks` tail (`speak_reminder` block) for `# CORE` re-injection; `rebuildPersonalitySystem` for cached prefix | exact |
| `src/bot/brain/memory/memoryLog.js` | utility (file I/O) | file-I/O (append-only) | `readMemoryForSeed` (verify-only; no structural change expected per D-08) | exact |
| `src/shared/characterSchema.ts` | model (Zod schema) | transform (validation) | `PersonaSchema` (`source`/`expanded`) | exact |

## Pattern Assignments

### `src/main/personaExpansion.ts` (config/prompt-generator, request-response)

**Restructure target:** the 6-section expander → add `# CORE` and split universal core vs Minecraft addendum (D-01, D-02, D-04).

**Current section contract** — `EXPANSION_SYSTEM` (lines 57-76). Six sections emitted in fixed order; the numbered list is at lines 62-67:

```
1. `# IDENTITY`                          (line 62)
2. `# VOICE`  (5-7 sample utterances)    (line 63)
3. `# DEFAULT DYNAMIC WITH THE PLAYER`   (line 64)  ← contains MC verbs (follow)
4. `# PROACTIVENESS`                     (line 65)  ← contains MC verbs (setGoal, biome, project goal-type)
5. `# REACTIONS`                         (line 66)
6. `# MEMORY`                            (line 67)
```

**Three parallel structures that MUST stay in lockstep** when adding/reordering sections (every edit touches all three or counts break):

1. `EXPANSION_SYSTEM` numbered list — lines 62-67 (the instruction text the model follows).
2. `REQUIRED_SECTION_HEADERS` — lines 158-167. Tolerant regex validators (`^\s*#+\s*<NAME>\b/im`). Add a `{ name: 'CORE', re: /^\s*#+\s*CORE\b/im }` entry here so a missing `# CORE` throws `missing sections`.
3. `SECTION_LABELS` — lines 175-182. Parallel progress-bar labels indexed by section position; `computeExpansionProgress` (line 207) divides the bar by `REQUIRED_SECTION_HEADERS.length`. Adding a 7th section makes the bar 7-segment automatically — but `SECTION_LABELS` MUST gain a parallel entry or the label lookup (`SECTION_LABELS[seen - 1]`) returns undefined for the new slot.

**Header-detection note (line 60):** the system prompt says "Output EXACTLY these six markdown sections" and "begin with the header line shown below (verbatim)". The literal word "six" appears at line 60 and in the docblock (lines 27-30). Update the count word(s) when adding `# CORE`.

**Tolerant-validator pattern to copy** (line 159) for the new `# CORE` regex:
```typescript
{ name: 'CORE', re: /^\s*#+\s*CORE\b/im },
```
Anchored to leading `#` (avoids false-positive on the word "core" in a body sentence); `+` accepts `##`; `i`/`m` flags tolerate casing + multiline. This is the established convention for every header.

**Universal/MC split (D-04):** sections 3 (`# DEFAULT DYNAMIC`) and 4 (`# PROACTIVENESS`) currently embed MC-specific verbs directly in their instruction bodies (`follow` at line 64; `setGoal`, "biome", project goal-types at line 65). The split means: keep identity/voice/values/stance/general-proactivity-flavor surface-agnostic, and move the MC-specific behaviors into a separate addendum block. The `PROACTIVENESS_TIER_HINTS` map (lines 254-258, in the USER message, not the cacheable system) also carries MC verbs (`setGoal`, "gathering wood", "placing walls") — these are flavor hints, decide with the planner whether they move to the addendum or stay (they are per-call, already not cached).

**`# CORE` authoring (D-01):** ~3-5 lines = name + ~3 defining traits + register; surface-agnostic (no MC verbs, D-02); deterministic/author-controlled (written at expansion time, lifted at runtime). Add it as a new numbered instruction near the top of `EXPANSION_SYSTEM` (logically first, so the model writes the distillation before the long sections).

**Stable-system invariant (lines 30-35 docblock):** `EXPANSION_SYSTEM` MUST stay free of per-call data (no player name, no session data) so it remains prompt-cacheable key-by-key. The `# CORE` instruction text added here is stable; it does not break this.

**Prompt-language constraint (D-00):** all instruction text added/edited here uses clear, objective, factual language — no rhetoric, no em-dashes. (Note: the existing bodies already use em-dashes liberally as prose connectors — D-00 governs NEW/edited text; do not mass-rewrite untouched lines unless planned.)

---

### `src/bot/brain/prompts.js` (prompt templates, transform)

This module is a flat collection of exported string constants + pure render functions. New work attaches as siblings to existing exports.

**`renderPersona` (lines 315-317)** — the consumer of `persona.expanded`. Currently:
```javascript
export function renderPersona(persona) {
  return `You are ${persona.name}.\n${persona.expanded}`
}
```
If the expander output structure changes (universal core vs MC addendum split), this is where the `expanded` string is dropped into the cached system prefix verbatim. The split may require this to render two blocks or to slice the addendum — coordinate with the orchestrator wiring below.

**New `# CORE` extractor — analog: `renderProactivenessDirective` (lines 160-164):**
```javascript
export function renderProactivenessDirective(proactiveness) {
  const lvl = Number.isInteger(proactiveness) ? proactiveness : 1
  const directive = PROACTIVENESS_DIRECTIVES[lvl] ?? PROACTIVENESS_DIRECTIVES[1]
  return `# PROACTIVENESS\n${directive}`
}
```
Copy this shape for a `renderCore(persona)` (or similar) that lifts the `# CORE` section out of `persona.expanded` and returns it for the recency-tail re-injection (D-01). The extraction regex should mirror personaExpansion's tolerant header detection (`/^\s*#+\s*CORE\b.../im`), slicing from the `# CORE` header to the next `# ` header. Claude's Discretion (CONTEXT line 50) covers exact format + detection.

**`BASELINE_INSTRUCTIONS` (lines 14-44)** — the universal mechanics block (cached system index 0). This is where the honest-mistakes instruction (D-06: own failures in character, `remember()` the failure, no detection code) and any proactivity-modulation framing (D-05) attach if they are surface-agnostic. The block is one large template literal; edits append/insert paragraphs. Lead-paragraph convention: each rule is a CAPS-prefixed paragraph (`HOW YOU SPEAK`, `LENGTH & STYLE`, `NEVER NARRATE...`). Follow that convention for any added rule.

**`PERSONALITY_TOOL_DESCRIPTIONS.remember` (lines 58-77)** — the `remember()` cadence + content contract (D-08: subjective entries, right cadence). Already has GOOD/BAD example shapes (lines 61-72) and a quality-bar paragraph (lines 74-75). This is the analog for tuning cadence guidance — edit the existing prose; the GOOD/BAD example block is the established pattern for steering Haiku.

**`PERSONALITY_TOOL_DESCRIPTIONS.say` (line 56)** — voice-related (PERSONA-04). Note: per D-03 the few-shot voice examples live in the **expander's `# VOICE` cached prefix**, NOT in this tool description — so PERSONA-04 work is mostly in `personaExpansion.ts` `# VOICE`, not here. This description governs say() mechanics, not voice samples.

**Proactivity-modulation (D-05):** persona-modulated proactive questions (cold asks fewer, warm asks more) is social/surface-agnostic → lives in the **universal persona core** (the expander), with possible reinforcement in `BASELINE_INSTRUCTIONS` or `PROACTIVENESS_DIRECTIVES` (lines 103-112). The runtime `PROACTIVENESS_DIRECTIVES` map is the cadence/agency dial (0/1/2); D-05 is about *who the bot talks to*, derived from persona warmth — decide with the planner whether it rides in the expander core or these directives.

---

### `src/bot/brain/orchestrator.js` (brain orchestrator, transform)

Two integration points: the cached system prefix and the per-loop seed tail.

**`composeSeedBlocks` (lines 271-383)** — builds the per-loop user-turn blocks in order. The ordering and cache breakpoints are load-bearing.

Current block order (the array `blocks`):
```
seed_player                 (287)
seed_cuboid_grammar         (291)  ← cache_control breakpoint #1
memory                      (310)  ← readMemoryForSeed, with memoryPreamble (lines 305-309)
heartbeat                   (338)  ← cache_control breakpoint #2; renderHeartbeat
companions                  (361)  ← only when other bots present
recent_player_chat          (364)
your_recent_messages        (367)
event                       (369)
snapshot                    (370)
speak_reminder              (374)  ← SPEAK_REMINDER, high-recency restate
player_message              (380)  ← LAST (highest recency), only on chat turns
```

**`# CORE` re-injection (D-01) — analog: the `speak_reminder` block (line 374):**
```javascript
blocks.push({ type: 'text', name: 'speak_reminder', text: SPEAK_REMINDER })
```
This is the established pattern for "restate a stable instruction at maximum recency because Haiku ignores the far-up cached copy" (see comment lines 371-373 and the SPEAK_REMINDER docblock at prompts.js lines 46-52). The `# CORE` block follows exactly this shape: a `blocks.push({ type:'text', name:'core', text: renderCore(config.persona) })` near the tail. Place it at the recency tail (after snapshot, near speak_reminder / before player_message) so it fights attention-decay drift. Note the comment at line 375-378: `player_message` is deliberately LAST so the bot answers the player — decide whether `# CORE` goes before or after `speak_reminder` but it should be in this tail cluster, not before the cache breakpoint.

**Important caching note:** blocks added AFTER `seed_cuboid_grammar` (line 291) and `heartbeat` (line 348) breakpoints re-bill per loop. `# CORE` is small (~3-5 lines) and re-injected every turn by design (D-01), so it correctly lives in the uncached recency tail — same cost profile as `speak_reminder`.

**`rebuildPersonalitySystem` (lines 815-834)** — the cached system prefix. The static block array (lines 824-831):
```javascript
cachedSystemBlocks = anthropic.buildCachedSystem(
  [
    BASELINE_INSTRUCTIONS,                                  // index 0
    renderPersona(config.persona),                         // index 1  ← persona
    adapter.capabilityParagraph(),                          // index 2  ← capability
    adapter.worldPrimer(),                                  // index 3
    adapter.actionRules(),                                  // index 4
    renderProactivenessDirective(config.persona?.proactiveness ?? 1), // index 5
  ],
  combinedToolsFor()
)
```
**Index invariant (lines 816-822 comment + log.js lines 132-134):** `src/bot/brain/log.js` indexes persona at `[1]` and capability at `[2]`. New cached blocks MUST be **appended** (after index 5), never inserted before capability, or the logger's section labels break. `buildCachedSystem` (anthropicClient.js lines 318-326) maps each string to `{type:'text', text}` and appends ONE `cache_control: ephemeral` marker on the trailing tool block — so the whole static prefix is cached as one segment.

D-03 (the `# VOICE` few-shot samples) is satisfied because `# VOICE` is inside `renderPersona(config.persona)` (the `expanded` string), which sits at cached index 1 — no orchestrator change needed for voice; only the expander's `# VOICE` body is tightened to be scenario-agnostic.

If the universal/MC split (D-04) changes `expanded` structure, `renderPersona` (index 1) is the seam; an MC addendum might become a new appended cached block (index 6) or stay folded into `renderPersona` — coordinate with the prompts.js / characterSchema changes.

---

### `src/bot/brain/memory/memoryLog.js` (file-I/O utility, append-only)

**Scope per D-08/D-09: verify injection correctness, do NOT add scoring/importance/facts-store.** Likely no structural change; the planner diagnoses whether `readMemoryForSeed` wiring is correct and fixes only what is off (Claude's Discretion, CONTEXT line 52).

**`readMemoryForSeed` (lines 150-192)** — the seed-injection path. Reads full file, returns as-is if under `budgetBytes`; else truncates oldest entries newest-first while preserving the `# Memory` header and ALL `## World N` markers. Called from `composeSeedBlocks` line 295-298 with `config.memory.seed_memory_budget_bytes ?? 8192`.

**Injection wiring to verify** (orchestrator composeSeedBlocks lines 293-317):
- gated on `config?.memory?.memory_md_path` (line 293) — if that path is unset in a config path, memory is silently NOT injected. Verify production always sets it.
- the `memory` block (line 310) is pushed with a `memoryPreamble` (lines 305-309) and is BEFORE the `heartbeat` cache breakpoint (line 348) — so a memory append every loop would invalidate that cache. Comment at lines 341-347 claims memory+heartbeat are "stable across consecutive loops" — verify this holds given `remember()` appends mid-session (potential drift between the cache assumption and append cadence).

**Invariants to preserve** (CLAUDE.md + lines 45-76): world-segmentation headers (`## World N — label`) are NOT entry lines (`- [`), and both `readMemoryForSeed` (line 158, 167-170, 188-190) and the segment-aware compactor preserve them. `forget()` (line 122) only deletes `- [` lines. `appendMemory` (lines 78-99) is one-arg `remember(text)` append-only (D-07: stays one-arg, no importance score).

---

### `src/shared/characterSchema.ts` (Zod model, transform)

**`PersonaSchema` (lines 19-24):**
```typescript
export const PersonaSchema = z.object({
  source: z.string().min(1),
  expanded: z.string().default(''),
});
export type Persona = z.infer<typeof PersonaSchema>;
```
`expanded` is a single opaque string. The `# CORE` section and universal/MC split (D-01, D-04) are encoded WITHIN `expanded` as additional markdown sections, so the schema likely needs **no shape change** if the structure stays string-embedded (consistent with how the existing 6 sections live inside one string). Only touch this if the planner decides to split `expanded` into structured sub-fields (e.g. `core`, `universal`, `mcAddendum`) — which would ripple to `renderPersona`, the expander output, and every `expanded` consumer. Default to keeping it one string (lowest-ripple, matches current convention).

**Migration concern (CONTEXT lines 96-97):** existing saved characters have old-format `expanded` (no `# CORE`, MC verbs inline). The runtime `# CORE` extractor MUST tolerate a missing `# CORE` (old characters) — fall back gracefully (e.g. derive a minimal core from `persona.name` + first lines, or skip the tail re-injection) rather than crash. This is an open question flagged in CONTEXT's Deferred — confirm migration/re-expansion strategy with the planner.

## Shared Patterns

### High-recency restate (anti-drift) — the core PERSONA-03 mechanism
**Source:** `composeSeedBlocks` `speak_reminder` block — `orchestrator.js:374`, text from `prompts.js:51-52` (SPEAK_REMINDER).
**Apply to:** the new `# CORE` re-injection block.
**Pattern:** a stable instruction the model ignores when buried in the far-up cached system prefix is restated as a small uncached user block at the recency tail of every turn. SPEAK_REMINDER (the say() contract) already does this; `# CORE` (the compressed persona) is the second instance. Both accept the per-turn re-bill cost because they are small and the recency placement is the whole point.

### Cached static system prefix (write-once-per-session)
**Source:** `rebuildPersonalitySystem` — `orchestrator.js:815-834` + `buildCachedSystem` — `anthropicClient.js:318-326`.
**Apply to:** any persona text that is STATIC for the session (the `# VOICE` samples via `renderPersona`, the proactiveness directive). Static → cached prefix (cheap). Dynamic / needs-recency → `composeSeedBlocks` tail (re-bills). The `# CORE` is the deliberate exception: static content placed in the dynamic tail to fight drift.
**Invariant:** persona at cached index 1, capability at index 2 (log.js:132-134) — append new cached blocks, never insert before capability.

### Tolerant markdown-header detection
**Source:** `REQUIRED_SECTION_HEADERS` — `personaExpansion.ts:158-167`.
**Apply to:** the new `# CORE` validator (in personaExpansion.ts) AND the runtime `# CORE` extractor (in prompts.js).
**Pattern:** `/^\s*#+\s*<NAME>\b/im` — leading-`#`-anchored, `##`-tolerant, case-insensitive, multiline. Haiku does not render headers byte-exact; every header parse in this codebase uses this shape.

### GOOD/BAD example steering for Haiku
**Source:** `PERSONALITY_TOOL_DESCRIPTIONS.remember` — `prompts.js:61-72`; mirrored in `EXPANSION_SYSTEM` section 6 — `personaExpansion.ts:67`.
**Apply to:** any tuned `remember()` cadence guidance (D-08) and the scenario-agnostic `# VOICE` samples (D-03 — show register, not situations).
**Pattern:** concrete GOOD examples in-voice + concrete BAD examples matching the failure shapes the model slips into, with an inline annotation of WHY each BAD one is wrong.

### Objective prompt language (D-00 — phase-wide)
**Apply to:** ALL prompt instruction/meta text added or edited this phase (BASELINE_INSTRUCTIONS, `# CORE` instruction, expander section instructions, persona scaffolding).
**Rule:** clear, objective, factual; no rhetoric; no em-dashes/en-dashes. Exception: an individual character's in-voice `say()` voice samples carry that character's voice. Governs new/edited text, not untouched legacy prose.

## No Analog Found

None. Every Phase 16 target is an in-place edit to existing, well-established prompt-assembly code. The one genuinely new construct — the runtime `# CORE` extractor/render function — has a direct same-file analog in `renderProactivenessDirective` (prompts.js:160-164), and its re-injection point has a direct analog in the `speak_reminder` block (orchestrator.js:374).

## Metadata

**Analog search scope:** `src/main/personaExpansion.ts`, `src/bot/brain/prompts.js`, `src/bot/brain/orchestrator.js`, `src/bot/brain/memory/memoryLog.js`, `src/bot/brain/anthropicClient.js`, `src/bot/brain/log.js`, `src/shared/characterSchema.ts`.
**Files scanned:** 7.
**Pattern extraction date:** 2026-06-25.
