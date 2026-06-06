# Phase 2: Two-Layer LLM Loop - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire the personality LLM (Haiku 3) and movement LLM (Ollama Qwen 2.5) into the Phase 1 FSM with the natural-language hand-off pattern, hard guardrails (5-hop recursion cap, 500ms debounce, 30/min rate limit, AbortController-based cancellation), a configurable persona that forms the cached Anthropic prefix, and a goal-driven idle behavior. Out of scope: SQLite persistence (Phase 3), Electron GUI (Phase 4), screenshot/vision (deferred to v2).

</domain>

<decisions>
## Implementation Decisions

### Tool-Calling Protocol (Movement LLM)
- **D-01:** Movement LLM uses **native Ollama tool-calling**. Zod schemas in the action registry are converted to JSON Schema and passed as `tools` to Ollama; Qwen returns structured `tool_calls` that the orchestrator validates and dispatches.
- **D-02:** Haiku-as-executor fallback uses **Anthropic `tool_use`** with the same JSON Schema. One protocol shape, two providers — the dispatch layer is provider-agnostic.
- **D-03:** **Full registry is sent every call** (no per-call filtering). Registry is small enough (~10–20 actions) that the cached prefix absorbs the cost. Revisit if registry grows substantially.

### Personality → Movement Hand-off
- **D-04:** Hand-off is **free natural-language prose**. Personality emits intent like "go check what shawn is building over by the water"; movement LLM resolves to action calls. Personality never sees action names or coordinates — preserves CLAUDE.md ADR #2 (closed registry, LLM never generates code or coordinates).
- **D-05:** **Spike note (deferred experiment):** Qwen 2.5's reliability translating arbitrary NL prose to correct action calls is unproven. If quality is poor in practice, run a parallel test branch using a structured intent vocabulary (e.g., constrained verb list) as the hand-off shape. Decision point: after first end-to-end testing.

### Idle Behavior + Goal Model
- **D-06:** Bot maintains **two in-memory goal lists**: `owner_goals: string[]` (assigned by owner via chat) and `self_goals: string[]` (chosen by the bot for fun). Each goal is a short NL string. No persistence in Phase 2 — that's Phase 3 (MEM-04).
- **D-07:** **Goal mutation** happens through the personality LLM via a small `setGoals` registry action (add/remove from either list). Both owner-driven ("hey kill some cows") and bot-autonomous ("I think I want to get iron next") edits flow through the same code path.
- **D-08:** **Idle tick decision logic** lives in the personality LLM prompt template, not in code. The prompt instructs: "If you have owner_goals, prioritize progressing them. Otherwise pick a self_goal or freely play." This keeps the orchestrator dumb — one cycle, three implicit modes.
- **D-09:** **"Follow me" override is FSM-native** — direct chat is P1, idle is P3, so an "@bot follow me" preempts idle goal work automatically. No special override logic needed.
- **D-10:** Commentary (PERS-04 proactive observations) is **orthogonal to mode** — personality LLM may emit chat lines on any turn (idle or task) when something is worth saying. Rate-limited by the global 30/min cap.

### Recursion Cap + Abort
- **D-11:** **One LLM call = one hop** against the 5-hop cap (LLM-04). Personality call = 1, movement call = 1. A typical chain (chat → personality → movement → completion → personality → movement) consumes 4 hops.
- **D-12:** **Cap-hit handler:** AbortController cancels any in-flight movement action, the personality LLM emits a single short in-character line ("hmm, getting dizzy — let me catch my breath"), event chain terminates. Logged at warn level.

### Ollama Fallback (LLM-08)
- **D-13:** **Startup probe + on-error circuit breaker.** On boot: ping Ollama's `/api/tags`. If unreachable, log a plain-English warning and start in Haiku-only mode for the session.
- **D-14:** **Mid-session circuit breaker:** 3 consecutive Qwen errors/timeouts → flip to Haiku-as-executor for the rest of the session (no flapping). User-visible status field tracks current executor (`qwen` | `haiku-fallback`). Manual recheck or restart re-probes Ollama.

### Persona Configuration
- **D-15:** Persona lives in **`config.json`** as a `persona: { name, backstory, tone }` block (extends Phase 1 config). Phase 4 GUI will write the same file. Tone is a string enum: `friendly | sarcastic | serious | curious` (PERS-03).
- **D-16:** **No hot-reload in Phase 2.** Persona changes require restart. Hot-reload can come with the GUI in Phase 4 if needed.

### Anthropic Prompt Caching (PERS-05)
- **D-17:** Cached prefix (in order): **system instructions → persona block → tool/action JSON Schema definitions**. All three are stable across a session and re-cacheable across sessions when persona/registry don't change. Recent events, current goals, and the user's latest input go *after* the cache breakpoint.
- **D-18:** Use Anthropic's `cache_control: { type: "ephemeral" }` marker on the last block of the cached prefix.

### Dev/Test Strategy
- **D-19:** **No mock LLM layer.** Iterate against real Haiku + Ollama; budget a small Haiku token spend for dev. Keeps Phase 2 focused on shipping the loop, not test infrastructure. Revisit if iteration cost becomes painful.

### Claude's Discretion
- Exact Ollama and Anthropic timeout values (reasonable defaults: Ollama 30s, Haiku 20s)
- Specific debounce implementation (per CLAUDE.md the requirement is 500ms; mechanism is implementation-detail)
- Hop counter storage (per-event-chain object vs. AbortController metadata)
- In-character "cap hit" line phrasing (should respect persona tone)
- Internal module layout for `personality/`, `movement/`, `goals/` files within `src/`
- `setGoals` action's exact Zod shape (likely `{ list: 'owner' | 'self', op: 'add' | 'remove', goal: string }`)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & Constraints
- `CLAUDE.md` — ADRs #1 (two-layer LLM hand-off), #2 (closed registry), #3 (FSM priority queue + AbortController), #4 (LLM-directed compaction — Phase 3 context), #5 (every external call has a timeout). **Read first.**
- `ARCHITECTURE.md` — System data flow graph

### Requirements
- `.planning/REQUIREMENTS.md` §LLM Orchestration (LLM-01–08) and §Personality (PERS-01–05) — Phase 2 acceptance criteria
- `.planning/ROADMAP.md` §Phase 2 — Success criteria

### Carry-forward from Phase 1
- `.planning/phases/01-bot-substrate/01-CONTEXT.md` — Phase 1 decisions (FSM shape, action registry, config.json structure, owner identification, timeout pattern)
- `.planning/phases/01-bot-substrate/01-VERIFICATION.md` and `01-SUMMARY.md` files — what shipped vs. what was deferred

### External APIs (downstream researcher should fetch current docs)
- Ollama tool-calling API (Qwen 2.5 model) — JSON Schema `tools` parameter, structured `tool_calls` response
- Anthropic Messages API: tool_use, prompt caching (`cache_control: { type: "ephemeral" }`), Haiku 3 model ID

### Reference Implementation
- `../sui/mindcraft-0.1.4/` — prior-art for action-style protocols (note: mindcraft uses text-tag commands; we deliberately chose tool-calling instead — see D-01)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phase 1)
- **Action registry** (Zod-typed, closed): the schemas convert directly to JSON Schema for Ollama `tools` and Anthropic `tool_use`
- **FSM with priority queue (P0–P3)**: idle tick is already P3; chat is already P1 — the goal-override behavior (D-09) requires zero new orchestration
- **AbortController pattern**: already wraps movement actions in Phase 1 — extend the same controller to cancel on hop-cap-hit (D-12)
- **Pathfinder timeout wrapper** (D-09 from Phase 1): the pattern (wall-clock timeout returning a first-class result) is the template for Ollama and Anthropic clients (D-19 implies same shape, per CLAUDE.md ADR #5)
- **`config.json` loader**: extend with `persona` block (D-15)

### Established Patterns
- All bot logic lives in a self-contained module behind `start(config)` / `stop()` (Phase 1 D-07) — Phase 2 LLM clients live inside this module so Phase 4's utilityProcess wrapping stays trivial
- Plain-English error messages (Phase 1 D-04 spirit) — apply to Ollama-down and Anthropic-error surfacing

### Integration Points
- New code attaches to the FSM's existing P1/P2/P3 event hooks (no FSM changes expected)
- `setGoals` becomes a new action in the registry — tested with the same harness as Phase 1 actions
- Provider-agnostic dispatch layer (D-02) is a new internal seam between FSM and LLM clients

</code_context>

<specifics>
## Specific Ideas

- **Spike to schedule (post-Phase-2):** Qwen 2.5 NL→tool-call reliability test. If translation quality is weak, the structured-intent fallback (constrained verb vocabulary) gets prototyped in a test branch — see D-05.
- The "feels alive" core value (PROJECT.md) hinges on the goal model (D-06–D-09). Self-goals are what differentiate Sei from a scripted bot when no one is giving it instructions.
- Status field showing current executor (`qwen` | `haiku-fallback`) is for log/debug now; Phase 4 GUI surfaces it to the user.

</specifics>

<deferred>
## Deferred Ideas

- **Goal persistence across restarts** — Phase 3 (MEM-04 covers world progression which subsumes long-term goal memory)
- **Hot-reload of persona config** — Phase 4 with the GUI, if needed
- **Mock LLM layer + scenario harness** — revisit if dev iteration cost becomes painful (D-19 chose budget-Haiku for now)
- **Recorded transcript replay for regression tests** — Phase 3+ enhancement
- **Per-call action filtering / two-tier registry** — only if the registry grows large enough to bloat the cached prefix (D-03)
- **Structured-intent hand-off (constrained verb list)** — test branch experiment if Qwen NL translation underperforms (D-05)
- **Manual Ollama recheck UI / command** — Phase 4 GUI affordance; for now, restart re-probes (D-14)

</deferred>

<addendum>
## Addendum (2026-04-25, post-research)

- **D-20:** Personality LLM is **`claude-haiku-4-5-20251001`** (Haiku 3 retired 2026-04-20). Pricing $1/$5 per MTok. Note: prompt-cache minimum is 4096 tokens — verify cache hits via `usage.cache_creation_input_tokens` after build.
- **D-21:** Movement LLM is **Qwen 3.5 — instruct variant only** (e.g. `qwen3.5:7b-instruct` via Ollama). Non-instruct Qwen variants emit thinking traces that break tool-call parsing. Hard requirement: `*-instruct` model tag, not thinking/reasoning variants.
</addendum>

---

*Phase: 02-two-layer-llm-loop*
*Context gathered: 2026-04-25 (addendum 2026-04-25)*
