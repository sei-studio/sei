---
quick_id: 260516-0yw
slug: persona-expansion-action-tick-baseline-t
gathered: 2026-05-16
status: ready-for-planning
---

# Quick Task 260516-0yw: persona expansion + action tick + baseline trim + first-person memory — Context

**Gathered:** 2026-05-16
**Status:** Ready for planning

<domain>
## Task Boundary

Four coupled changes that collectively shift voice, tone, and proactiveness control from the baseline prompt into a per-character LLM-generated persona prompt:

1. **Persona prompt expansion at character creation.** When the user enters a short persona blurb in the GUI's character form, run a one-time Anthropic call (Haiku 4.5) that expands it into a structured long prompt (Identity / Voice / Dynamic / Proactiveness / Reactions / Memory / Sample lines). If the user edits the persona source, regenerate (with the prior expansion passed in for voice-continuity reference). The full expanded prompt is viewable in an expandable hidden tab inside the "Edit" sheet. Remove the legacy `description` field — the user-edited field is now the *source*, the LLM-generated text is the *expanded prompt*.

2. **Action tick (open-ended long actions).** `follow` becomes an open-ended long action (no auto-end). Any in-flight action lasting >10s fires a `sei:action_tick` event at P2.5 that drives one LLM iteration so the bot can comment / abort if it wants. Most ticks should produce no text and no tool call.

3. **Trim baseline prompt.** Move communication-style and proactiveness rules into the persona prompt. Baseline keeps only universal mechanics: length cap, in-game-chat semantics + no-monologue/reasoning, anti-prompt-injection / identity guardrails, tool / end_loop / action-tick mechanics.

4. **First-person colored memory.** `remember()` description and the persona's Memory section steer the bot to write entries in *their* voice from *their* perspective — same event, different framing per persona. The compactor preserves the emotional arc across compactions so an Eris-style bot can plausibly evolve from tsun and harsh to dere and kind over a *long* time.

</domain>

<decisions>
## Implementation Decisions

### Persona expansion call — main process, on save
- LLM call runs in the **main Electron process** (not renderer, not utility/bot). Main already holds Anthropic credentials via the existing config pipeline; renderer stays out of API-key territory.
- IPC contract: renderer submits raw `persona.source` (and, on edit, the existing `persona.expanded`); main calls Anthropic, persists both fields, returns the saved Character to the renderer.
- UI behavior: save action shows a loading state for the duration of the call (typical 3–8s). Failures surface as a save error; user retries with the same source text.

### Action tick — orchestrator-side per-in-flight interval
- Started at `dispatchSuspendingTool` when `loop.inFlight` is registered.
- Fires `sei:action_tick` (new event name) at priority P2.5 every 10s while the in-flight remains live.
- Cleared on `sei:action_complete` (the settle handler clears it) and on abort.
- Routed through the FSM like any other event so the existing chat/attack preemption ordering still applies (P1 chat still beats P2.5 tick).
- The tick iteration's seed text uses the silence-default wording (see "Tick wording" decision below).

### Storage shape — source + expanded, legacy `description` removed
- Character schema (`src/shared/characterSchema.ts`) gets `persona.source` (user's short blurb, required) and `persona.expanded` (LLM-generated long prompt, required after first save).
- The existing `description` field (if present on the Character schema) is removed outright. **No migration shim** — first save under the new code rewrites the JSON.
- Bot reads `persona.expanded` for the persona system block. `persona.source` is GUI-only.
- Regeneration on edit: main passes new `persona.source` + old `persona.expanded` (as a "previous version, for voice-continuity reference") to the LLM and replaces `persona.expanded` with the result.

### Baseline trim — what stays
- Length rule (≤12 words, one sentence) at the very top.
- In-game-chat semantics + no-monologue/reasoning/scratchpad-leak rule.
- Anti-prompt-injection + identity guardrails ("never describe yourself as AI/assistant/LLM").
- Tool mechanics: how `remember`/`forget`/`end_loop` work, that other tools exist (described in persona/adapter system blocks), and the action-tick contract ("if a tick fires while your action is ongoing, you do NOT have to speak").

### Baseline trim — what moves into the persona prompt
- Tone, voice, slang, casing, punctuation preferences.
- Proactiveness level (when to initiate, when to stay silent).
- Default dynamic with the player (servant / rival / friend / unknown).
- Reaction patterns (commanded / insulted / praised / ignored / attacked).
- Memory-framing examples (good vs bad entries for *this* character).

### Memory arc — compactor preserves emotional trajectory
- `MEMORY.md` stays append-only first-person entries; **no new schema**.
- The compactor (`src/bot/brain/memory/compactor.js`) system prompt is updated to explicitly preserve the EMOTIONAL ARC across entries when condensing (e.g. "if entries show a shift from hostility to warmth, the condensed version must still show that shift").
- Long-time relationship development emerges from compactor faithfully carrying forward arc signals, not from a structured affection field that would force categorical emotional buckets.

### Regeneration — old expansion is reference, not source
- LLM call receives: NEW `persona.source` (primary), OLD `persona.expanded` (reference, for voice continuity where appropriate).
- Instruction: "Honor the new source as the primary description. The old expansion is provided for reference — match its voice patterns where they remain consistent with the new source, but do not preserve content that contradicts it."
- Output fully replaces `persona.expanded`.

### Tick wording — silence-default with abort option
- Seed text: `Your action is still in progress (Xs elapsed). You do NOT have to speak. Continue silently unless something specific has changed or you want to abort. Most ticks should produce empty text and no tool call.`
- `end_loop` semantics: tick iteration is P2.5; per the existing R1-R4 dispatcher, text-only on P2.5 terminates. The model can also call a new action or `end_loop` if it wants to abandon.

### Claude's Discretion
- Exact prompt wording for the persona-expansion LLM call (template that produces consistent seven-section output).
- Exact wording for the updated compactor emotional-arc instruction.
- Exact wording for the slimmed baseline (must be tight; no over-explaining).
- Renderer UI specifics for the expanded-prompt hidden tab (collapse/expand interaction, copy button, read-only treatment).

</decisions>

<specifics>
## Specific Ideas

### Persona expansion template (sections to produce)
Each expanded prompt must contain:
1. `# IDENTITY` — name, backstory, who they are
2. `# VOICE` — register, casing, punctuation, 5–7 sample lines
3. `# DEFAULT DYNAMIC WITH THE PLAYER` — relationship default
4. `# PROACTIVENESS` — when to initiate vs stay silent
5. `# REACTIONS` — commanded / insulted / praised / ignored / attacked
6. `# MEMORY — write in YOUR voice` — good vs bad framing examples

Example reference shapes (Eris vs Mei) live in the prior conversation; planner / executor can pull from those for the expansion prompt template.

### Files that almost certainly change
- `src/shared/characterSchema.ts` — schema: drop `description`, add `persona.source` + `persona.expanded`.
- `src/main/characterStore.ts` — call site for expansion on save; persist both fields.
- `src/main/personaExpansion.ts` (NEW) — Anthropic call wrapper + expansion prompt template.
- `src/main/ipc.ts` — IPC handler for save / edit, surfaces loading state.
- `src/renderer/src/components/CharacterEdit*.tsx` (or equivalent) — source field, expanded preview tab, remove description.
- `src/bot/brain/prompts.js` — trim `BASELINE_INSTRUCTIONS`, update `remember` tool description, update `forget` if needed.
- `src/bot/brain/index.js` (or wherever `renderPersona` is called) — feed `persona.expanded` into the persona system block.
- `src/bot/brain/orchestrator.js` — action-tick scheduling at `dispatchSuspendingTool`; clear on settle/abort; seed text for tick iteration.
- `src/bot/brain/fsm.js` — register `sei:action_tick` at P2.5.
- `src/bot/brain/memory/compactor.js` — emotional-arc preservation in system prompt.
- `src/bot/adapter/minecraft/registry.js` / `behaviors/follow.js` — `follow` becomes open-ended (return shape may already be fine; verify it doesn't auto-settle).
- `src/bot/brain/types.js` — typedef updates for tick + persona shape.
- `src/bot/cli/index.js` — handle new persona shape in dev seed.

### Test surfaces
- New unit test for persona-expansion LLM call (with mocked Anthropic client).
- Smoke test that `loadPlayer` / `savePlayer` still round-trip after schema change.
- Smoke test that `setInterval`-backed action tick fires at 10s and clears on action_complete.

</specifics>

<canonical_refs>
## Canonical References

- `.planning/PROJECT.md` — system architecture, three-process Electron model.
- `CLAUDE.md` — key architecture decisions, especially "Closed action registry: LLM calls Zod-typed actions directly", "Event-sourced FSM with priority queue", "LLM-directed memory compaction".
- Prior conversation in this session (compacted summary above) — context for why baseline was already trimmed, why follow spammed, and the analytical breakdown that led to these four fixes. The Eris and Mei example prompts from that conversation define the expected shape of expanded personas.

</canonical_refs>
