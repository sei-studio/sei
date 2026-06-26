# Phase 16: Persona & Memory Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-25
**Phase:** 16-persona-memory-core
**Areas discussed:** Persona core (drift fix), Memory importance & scoring, Active recall feel, Surface-agnostic persona

> Mid-discussion the user reviewed the updated ROADMAP (deep research, 7 streams, folded in). The research settled several questions by default (importance 1-10 at write, BM25 lexical scoring, core = name+traits+register). The user then **descoped the entire scored-memory overhaul** ("don't score"), narrowing the memory work to correct injection + proper `remember()` usage.

---

## Persona core (drift fix)

### Where the compressed persona core comes from

| Option | Description | Selected |
|--------|-------------|----------|
| Expander writes a `# CORE` section | 7th section authored at save time: identity + tics + signature say() lines; deterministic, cacheable, no runtime cost | ✓ |
| Programmatic compression at runtime | Mechanically derive core from existing sections at session start; heuristic, no author control | |
| Runtime LLM re-compression | Small LLM call compresses persona each session; adaptive but nondeterministic, fights cache | |

**User's choice:** Expander writes a `# CORE` section.

### Where the few-shot say() voice examples live

| Option | Description | Selected |
|--------|-------------|----------|
| Bundle 1-2 into the re-injected core | say() examples ride the tail every turn at high recency | |
| Cached prefix only | All say() examples stay in cached `# VOICE`; core re-injects identity + tics only | ✓ |
| Full set cached + 2 rotating in core | Full set cached, 2 rotate in the core for variety | |

**User's choice:** Cached prefix only.
**Notes:** Later clarified the voice examples must be **character-specific but scenario-agnostic** (demonstrate register, not tied to "gathering wood"/"being attacked").

### How "honest about mistakes" (PERSONA-06) is driven

| Option | Description | Selected |
|--------|-------------|----------|
| Prompt instruction only | Model owns mistakes from context; no machinery | |
| Prompt + explicit wrong-signal | Detect player corrections / action-result contradictions and nudge acknowledgment | |
| Prompt + memory of corrections | Write corrections to memory so it doesn't repeat them | partial |

**User's choice:** Prompt instruction + instruction to `remember()` failures (when something doesn't work, add it to memory), but **no hardcoded failure detection**.

---

## Memory importance & scoring

### How importance is assigned (question paused, then descoped)

**User's choice:** **Don't score.** After reviewing the roadmap research (which recommended model-rated 1-10 importance + Generative Agents scored retrieval), the user descoped scored retrieval and importance ratings entirely. Memory stays append-only; Phase 16 only ensures MEMORY.md is properly injected and `remember()` is used properly.

### Atomic-facts store (asked, then dropped)

| Option | Description | Selected |
|--------|-------------|----------|
| New structured player-facts store | Dedicated always-on atomic facts, user-editable | |
| Upgrade PLAYER.md in place | Give PLAYER.md atomic structure, always load full | |
| No separate store — score facts out of MEMORY.md | Rely on retrieval over unified MEMORY.md | ✓ (then superseded) |

**User's choice:** No separate store — and subsequently "don't score" at all. Net: no atomic-facts store, no scoring; active recall falls out of MEMORY.md being injected + persona prompting.

---

## Active recall feel

**User's choice:** Reframed away from a recall mechanism. Active recall is not built as machinery; instead **proactive questions / interaction are persona-modulated** — a cold character asks the player fewer questions, a warm one more. In character, not uniform.

---

## Surface-agnostic persona

| Option | Description | Selected |
|--------|-------------|----------|
| Keep MC-shaped, defer split to Phase 18 | Smallest scope; only voice + CORE go scenario-agnostic | (first answer) |
| Split persona now: universal core + MC addendum | Restructure expander so identity/voice/values/stance are surface-agnostic; MC behaviors move to a separate addendum | ✓ (final) |
| Just make CORE + voice surface-agnostic | Middle path; whole expander unchanged | |

**User's choice:** Split persona now — universal core + Minecraft addendum (user re-asked and changed from "defer" to "split now").

---

## Claude's Discretion

- Exact length/format and runtime extraction of the `# CORE` section.
- Precise wording of the `remember()` cadence + honesty/self-deprecation instructions.
- Diagnosis and fix mechanism for "MEMORY.md properly injected."

## Deferred Ideas

- Scored memory retrieval + importance ratings (Generative Agents) — descoped; reconcile MEM-01/MEM-02 in REQUIREMENTS/ROADMAP.
- Atomic-facts store about the player — not added.
- Per-surface (chat/voice/minigame) persona addenda — Phase 18.
- Cross-surface memory continuity (MEM-05) — Phase 18.
- Dynamic tone/relationship state machine — later milestone.
- Local-backend persona control vectors (repeng) — future local-only spike.
