# Phase 3: Memory & Persistence - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the current per-call stateless prompting with an **active-loop architecture** owning conversation history across iterations, plus persist owner identity (UUID) and game progression to two human-readable markdown files (`OWNER.md`, `DIARY.md`) that load directly into every loop's seed message — so Sei recognizes her owner across restarts and references prior shared history without inventing it.

**Vocabulary (locked this discussion — overrides SPEC.md prose where the SPEC used "session" loosely):**

- **Session** = entire real-world play session, from owner logging onto the Minecraft server to logging off. Sei may experience many sessions across one bot uptime; bot uptime is independent of session count.
- **Loop** = one active Sei cycle that completes a task (e.g., "get wood", "raid a village"). Owns a `messages` array; lives until the personality LLM emits a terminal response with no `tool_use` (or only `say`). One session contains many loops.
- **Iteration** = one round-trip within a Loop (build user turn → Anthropic call → execute tool_uses → append tool_result). Bounded by the configured iteration cap (default 20).

Out of scope (carried from SPEC.md): SQLite (deferred to V2 — markdown files instead), vector/semantic retrieval (V2), per-non-owner-player memory (V2), cross-server memory, file encryption, schema migrations, and adding history to the movement layer (Qwen stays stateless).

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**6 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):**
- **Plan 3-01 (lands first, separate merge):** Active-loop `Loop` architecture, idle/active state, interrupt-on-chat with messages preservation, tool-result wrapping, iteration cap. Replaces the current per-call stateless dispatch.
- **Plan 3-02:** Markdown memory layer — `OWNER.md` + `DIARY.md`, owner UUID detection and persistence, seed-message loader.
- **Plan 3-03:** Compaction calls — per-loop-batch summary, periodic consolidation, prompt design.
- File-system writes for the two markdown files (atomic via `tmp + rename`).
- Configuration: file paths, iteration cap, loop-batch trigger thresholds, consolidation cadence, soft size cap.
- Updates to `SYSTEM_INSTRUCTIONS` and `COMBINED_SYSTEM` explaining the new history-aware loop semantics.

**Out of scope (from SPEC.md):**
- `better-sqlite3` (V2), vector/RAG (V2), per-non-owner-player memory (V2), cross-server, file encryption, token-cost telemetry, schema migrations, history on the movement layer.

**⚠ SPEC overrides locked here (planner must update SPEC.md):**
- SPEC requirement 5 + acceptance criteria A5 / A7 assume "1 DIARY entry per active session (active→idle terminal)". This discussion overrides that: DIARY entries are written **per loop-batch** (every 10 loops OR cumulative loop-bytes > cap within a session), and consolidation fires every 4 sessions (logon→logoff cycles) OR on file size cap. The planner MUST rewrite A5 / A7 / requirement 5 / requirement 6 wording in SPEC.md against the new vocabulary before finalizing the plan.

</spec_lock>

<decisions>
## Implementation Decisions

### Loop Architecture & FSM Integration (Plan 3-01)
- **D-38:** New `Loop` class lives at **`src/llm/loop.js`**, owned by the orchestrator. Holds `{messages, abortController, iterationCount, startedAt, seed: true on first user turn}`. Orchestrator becomes a thin shell: build user turn → `loop.appendUserTurn(blocks)` → call Anthropic → `loop.appendAssistant(content)` → execute tool_uses → `loop.appendToolResults(results, {snapshot})` → repeat until terminal response. Mirrors how `goalStore` / `inflight` / `persona` were factored out in Phase 2.
- **D-39:** **Idle vs active is an orchestrator-internal flag, FSM unchanged.** The existing event-sourced FSM keeps its priority queue (P0 safety → P1 chat → P2 completion → P3 idle). Orchestrator gates the 10s idle probe on `currentLoop === null`. New owner chat enters as P1, the FSM's existing preempt logic aborts the in-flight action, AbortController fires, orchestrator catches the signal and transitions active→preserved-and-resumed per requirement 3. Smallest surface area; respects the existing FSM contract.
- **D-40:** **Orchestrator's catch block synthesizes `aborted` tool_result blocks** when the FSM aborts the in-flight action mid-loop. It walks the last assistant turn's `tool_use` blocks, emits matching `tool_result` blocks with content `aborted: player interrupt` for each one, then appends `PLAYER INTERRUPT: <text>` as a new user turn. Keeps the Anthropic invariant in one place; Loop class doesn't need to know about the FSM. Also handles the case where AbortController fires before the action handler runs (those `tool_use` blocks still need synthetic results).
- **D-41:** **Two-call (Ollama-healthy) path:** Loop.messages contains the personality layer's view only. Each `handOffToMovement` `tool_use` from personality gets a synthetic `tool_result` summarizing what the movement layer actually did (e.g., `executed: dig×3, last_action_result: dug oak_log`). The movement layer's internal Ollama call stays stateless — but its outcome enters the personality history as a `tool_result`, satisfying SPEC A10 without leaking action-name strings into personality reasoning (preserves Phase 2 D-04).

### Loop.messages Shape & Snapshot Trimming
- **D-42:** **Each user turn in Loop.messages is a multi-block content array** of typed blocks: `{type:'text', name:'snapshot', text:'...'}`, `{type:'text', name:'event', text:'...'}`, plus any `{type:'tool_result', ...}` blocks. Anthropic accepts arrays of content blocks natively; named blocks make trimming unambiguous and the structure is self-documenting.
- **D-43:** **Snapshot trimming uses rebuild-on-call:** Loop.messages keeps full history including all prior snapshots (canonical, easy to inspect during debugging). Before each Anthropic request, the orchestrator builds a trimmed copy where only the last user turn carries a `name:'snapshot'` block — older user turns get their snapshot block removed from the copy. The original `Loop.messages` is never mutated by trimming.
- **D-44:** **Trim helpers are `Loop` class methods** — `loop.appendUserTurn(blocks)`, `loop.appendAssistant(content)`, `loop.appendToolResults(results, {snapshot})`, and `loop.buildAnthropicPayload()` (returns the trimmed copy). Both the two-call and combined-call paths go through these methods so the trimming invariant cannot be bypassed on either path.
- **D-45:** **Seed user turn is permanent in Loop.messages.** The first user turn (carrying `OWNER.md` + `DIARY.md` slice + first event + first snapshot) is marked `seed: true`. The trimmer in `buildAnthropicPayload()` skips OWNER/DIARY content on seed turns — those stay visible to the LLM throughout the entire Loop. The seed turn's *snapshot block specifically* IS trimmed when iteration 2 arrives, so the Loop stays grounded in the latest world state, not the loop-start state.

### OWNER.md Schema
- **D-46:** **`OWNER.md` = YAML frontmatter + freeform `# Notes` section.** Frontmatter holds machine-readable fields the runtime parses; the prose Notes section is LLM-owned and grows over time. Pasted whole into every Loop's seed user turn under `# Owner`.
- **D-47:** **OWNER.md fields (v1):**
  - `owner_uuid` (required, source of truth for recognition)
  - `owner_username` (current display name; updated on every connect; not used for recognition)
  - `first_seen` (ISO timestamp)
  - `last_seen` (ISO timestamp)
  - `total_sessions` (integer counter; incremented on each session-start)
  - `preferred_name`, `pronouns` (cosmetic; LLM-managed)
- **D-48:** **Owner UUID resolution:** On the first owner-chat ever (or first session-start where owner is present), resolve `bot.players[config.owner_username].uuid` and write to `OWNER.md`. After that, owner-recognition uses the persisted UUID; username changes don't break recognition. If `OWNER.md` exists at boot but `owner_uuid` is unset (file was hand-edited weirdly), fall back to first-chat resolution.

### DIARY.md Schema & Truncation
- **D-49:** **`DIARY.md` = newest-first dated entries with short prose body.** Each entry: `## YYYY-MM-DD HH:MM — <topic>` heading (orchestrator-composed deterministic prefix; `<topic>` is the first chunk of the LLM-generated summary, ≤ ~6 words), then 2–4 sentences of in-character prose below. After consolidation, older entries get rewritten into a single `## Earlier (consolidated through YYYY-MM-DD)` block at the bottom. Newest-first matches recency-truncation cleanly.
- **D-50:** **Seed-load truncation: keep newest entries until byte budget hit, drop oldest.** On Loop start, read `DIARY.md`, walk entries newest-first, accumulate until adding the next would exceed `seed_diary_budget_bytes` (default ~3 KB after OWNER.md ~1 KB and headers, fitting the SPEC's 6 KB seed cap). Drop everything older from the seed slice. The consolidated block always lives near the bottom and is large enough to be a single entry — usually it gets included as one of the most recent items if recent enough, otherwise it's the most-likely-to-be-truncated thing, which is fine because consolidation re-runs on cadence. Byte-budget (no tokenizer) — within ~10% of token count for plain markdown, sufficient for a soft cap.

### Compaction (Plan 3-03) — REVISED CADENCE
- **D-51:** **Per-loop-batch summary trigger** (writes one new entry to `DIARY.md`): fires when **either** of these holds:
  - **Loop count:** ≥ 10 loops have completed since the last DIARY write within the current session.
  - **Context-bytes pressure:** cumulative bytes of completed `Loop.messages` arrays since the last DIARY write within the current session > `loop_batch_context_cap_bytes` (default ~32 KB, configurable in `config.json`).

  After a write, both counters reset for the current session. Acceptance overrides SPEC A5 / A7.
- **D-52:** **Per-loop-batch summary prompt:** freeform narrative, in-character. Prompt body: "You just finished a stretch of activity. In 2–4 sentences, write a diary entry summarizing what happened from your perspective — who you were with, what you did, how it felt. Plain markdown, no headings, no metadata." Sent as a final user turn appended to a *concatenation of the recent Loop.messages arrays since the last DIARY write* (so the model sees what actually happened across multiple loops). Same Haiku 3 + same cached system/persona/tool prefix → cache hit, ~zero marginal prefix cost. One extra Anthropic call per batch.
- **D-53:** **Consolidation pass trigger** (rewrites older `DIARY.md` into one denser block): fires when **either** of these holds, **async** (kicked off from the per-loop-batch write path, doesn't block the bot):
  - **Session count:** ≥ 4 sessions (full owner logon→logoff cycles) have passed since the last consolidation.
  - **Size pressure:** `DIARY.md` file size > 200 KB (soft cap, configurable).
- **D-54:** **Consolidation prompt:** split `DIARY.md` into recent half (most recent N entries) and older half. Send the older half to Haiku with: "These are diary entries you wrote earlier. Compress them into a single denser narrative paragraph that preserves names, accomplishments, and any recurring themes. Drop minor day-to-day details. Plain markdown, no headings." Replace the older half on disk with the resulting `## Earlier (consolidated through YYYY-MM-DD)` block. Atomic via tmp+rename. Keeps newest-first ordering; drops volume without losing facts.
- **D-55:** **MEM-02 satisfaction:** Compaction is still LLM-directed — both triggers fire only at semantic boundaries (loop terminal = LLM emitted no further `tool_use`; session terminal = owner left). The 10s idle probe never triggers compaction. The cadence shift (10 loops / 32 KB / 4 sessions) is a runtime *gating policy* on top of the semantic boundary, not a wall-clock timer.

### Session Boundary Detection
- **D-56:** **Session start/end = owner playerJoined / playerLeft (UUID-filtered).** Mineflayer fires `bot.on('playerJoined', player => …)` / `bot.on('playerLeft', player => …)` for every player. Filter to the owner UUID (loaded from OWNER.md after D-48 has resolved it once; before that, fall back to `config.owner_username` matching). Session-start handler: increment `total_sessions`, set `first_seen` if unset, set `last_seen` = now, reset the `loop_count` and `cumulative_loop_bytes` counters used by D-51, increment the `sessions_since_consolidation` counter used by D-53, fire consolidation async if D-53 triggers met. Session-end handler: persist `last_seen` = now, flush any pending diary write if there are uncompacted loops accumulated within this session.
- **D-57:** **Bot starts/restarts while owner is already on-server:** On `bot.on('spawn')`, after a short settle delay (mineflayer `bot.players` populates a few ticks after spawn), check `bot.players` for the owner (by UUID if known, else by username). If present, fire the session-start handler immediately. Handles cold-starts, crash-recoveries, and the case where Sei restarts mid-owner-session — the diary doesn't lose a session just because Sei restarted.
- **D-58:** **Bot disconnect (without owner leaving the server):** Sei's own `bot.on('end')` does NOT end a session on its own. The session is bounded by *owner* presence, not bot connection. On reconnect, D-57 re-checks owner presence and either re-opens the same session (if cumulative-bytes counters survive in memory across the reconnect) or treats it as a new session (if the process restarted). Trade-off accepted: a process crash mid-owner-session counts as a session boundary in v1; re-using prior cumulative-bytes counters across crashes is V2.

### Configuration Additions (`config.json`)
- **D-59:** New `memory:` config block with sensible defaults:
  - `owner_md_path` (default `./OWNER.md`)
  - `diary_md_path` (default `./DIARY.md`)
  - `iteration_cap` (default `20`) — replaces / unifies with Phase 2 hop cap (LLM-04)
  - `loop_batch_loop_count_cap` (default `10`)
  - `loop_batch_context_cap_bytes` (default `32768`)
  - `sessions_per_consolidation` (default `4`)
  - `diary_size_cap_bytes` (default `204800` — 200 KB)
  - `seed_diary_budget_bytes` (default `3072` — 3 KB)
  - `seed_owner_budget_bytes` (default `1024` — 1 KB)

### Claude's Discretion
- Exact bytes-vs-tokens tuning for the seed budget (target SPEC's 6 KB seed cap; defaults above are starting points)
- Internal layout of `Loop` class methods — the public API listed in D-44 is fixed but private helpers, error wrapping, and metric hooks are open
- Per-block `name` field schema — MUST include `snapshot`, `event`; additional names (`tool_result_summary`, `seed_owner`, `seed_diary`) are at the planner's discretion
- Whether the seed loader emits one combined block or three blocks (seed_owner / seed_diary / event/snapshot) on the seed user turn — must satisfy D-45
- Exact prose wording of compaction prompts (constraints captured in D-52, D-54)
- Settle-delay duration after `bot.on('spawn')` before checking `bot.players` (D-57) — start with ~500 ms
- Internal storage of cumulative-bytes counter and loop-counter (in-memory on orchestrator vs Loop vs new `sessionState` object — pick what reads cleanly)
- Whether to log a structured event on each session-start / session-end / loop-batch-write / consolidation-fire (recommended yes, log shape is open)
- Test strategy: real Haiku per Phase 2 D-19 (no mock LLM); manual verification harness for the active-loop path; file-system fixtures for OWNER.md / DIARY.md round-trips

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### This Phase (locked)
- `.planning/phases/03-memory-persistence/03-SPEC.md` — **Locked requirements, boundaries, and acceptance criteria. MUST read before planning.** Note the SPEC overrides flagged in `<spec_lock>` above (A5 / A7 / req 5 / req 6 wording will be updated by the planner against the new session/loop vocabulary).

### Architecture & Constraints
- `CLAUDE.md` — ADRs #1 (two-layer hand-off), #2 (closed registry), #3 (FSM priority queue + AbortController), #4 (LLM-directed memory compaction), #5 (every external call has a timeout). **Read first.**
- `.planning/PROJECT.md` — core value, three-process Electron architecture context.
- `.planning/REQUIREMENTS.md` — MEM-01 through MEM-05 (note MEM-05 SQLite is deferred to V2 per SPEC pivot), V2 backlog (MEM-V2-01 per-player memory, MEM-V2-02 vector retrieval).
- `.planning/ROADMAP.md` — Phase 3 success criteria (recall the 5 success-criteria bullets need updating against the new vocabulary too).

### Prior Phase Decisions (carry-forward — do NOT re-decide)
- `.planning/phases/02-two-layer-llm-loop/02-CONTEXT.md` — D-04 (NL hand-off, no action names in personality), D-11–D-12 (5-hop cap → repurposed as 20-iteration cap in D-59), D-13–D-14 (Ollama circuit), D-17–D-18 (cached-prefix order, ephemeral cache_control), D-19 (no mock LLM).
- `.planning/phases/2.1-expand-actions-and-game-state/2.1-CONTEXT.md` — D-26–D-29 (snapshot shape, ~500 token soft cap, personality-only, truncation strategy), D-30–D-32 (capability paragraph, primer, "still learning" persona trait), D-33–D-34 (movement LLM stays NL→tool_call only), D-35–D-36 (handler returns deterministic what-only result strings → these become tool_result content in D-41 / D-43).

### Existing Source (loop refactor must preserve these)
- `src/llm/orchestrator.js` — current per-call dispatch (lines 204, 209, 233, 250 build `messages` from scratch each call; loop refactor replaces these). Main dispatch loop at line 255+ with hop cap and AbortController plumbing — must be preserved.
- `src/llm/inflight.js` — in-flight tracker (Phase 2.1). Must keep working through the loop refactor.
- `src/llm/circuit.js` — Ollama circuit breaker; must keep working through D-41.
- `src/llm/debounce.js` — ingestion debouncer + leading-edge throttle for interruptive events.
- `src/llm/persona.js` — persona renderer + capability paragraph + minecraft primer + still-learning line. Cached prefix is built from these.
- `src/llm/anthropicClient.js` — current Anthropic call site; loop refactor will change the request shape (multi-block content arrays per D-42) but not the cache_control strategy.
- `src/observers/snapshot.js` — `composeSnapshot()` produces the per-turn snapshot block (Phase 2.1). Must continue to be the single source for snapshot content; the change is *where* it's injected (D-42 named block), not *how* it's composed.
- `src/fsm.js` — event-sourced FSM with priority queue. **NOT modified** by this phase (D-39); only the orchestrator's gating around it changes.
- `src/bot.js` — already has `bot.on('spawn'/'death'/'end'/'kicked')` and reconnect timer. Add `bot.on('playerJoined'/'playerLeft')` listeners feeding the session-boundary handlers (D-56, D-57).
- `src/config.js` — config schema + defaults; extend with `memory:` block per D-59.

### External APIs (downstream researcher should fetch current docs)
- **Anthropic SDK** — multi-block content arrays in user/assistant turns, `tool_use` / `tool_result` invariant, `cache_control: { type: 'ephemeral' }` placement on the cached-prefix tail. Already in use; verify no v1.x API drift since Phase 2.
- **mineflayer** — `bot.on('playerJoined', (player) => ...)`, `bot.on('playerLeft', (player) => ...)`, `bot.players[username].uuid` shape, timing of `bot.players` population after `bot.on('spawn')` (relevant to D-57 settle delay).
- **Node.js `fs`** — `fs.writeFile(tmp); fs.rename(tmp, target)` atomic-write idiom; `fs.readFile` + parse for OWNER.md frontmatter. No third-party YAML lib needed for v1 — flat key/value frontmatter is regex-parseable; if it grows, swap in `yaml` package.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `composeSnapshot` (`src/observers/snapshot.js`) → continues to produce snapshot content; new home is the `name:'snapshot'` block in user turns (D-42).
- `createInflightTracker` (`src/llm/inflight.js`) → keeps reporting in-flight action state into the snapshot; loop refactor doesn't change its API.
- `createOllamaCircuit` (`src/llm/circuit.js`) → still trips after 3 consecutive Qwen errors; trips also flip the dispatch path to combined-call (executor=api), which now uses Loop.messages per D-43.
- `createDebouncer` / `createThrottle` (`src/llm/debounce.js`) → ingestion debounce stays; loop iteration is internal and not debounced.
- `renderPersona` + `capabilityParagraph` + `minecraftPrimer` + `stillLearningLine` (`src/llm/persona.js`) → cached system prefix unchanged; OWNER.md / DIARY.md slice goes in the seed *user turn*, not the system prefix.
- Reconnect timer in `src/bot.js` → unchanged; session boundaries are owner-driven (D-56), not bot-connection-driven (D-58).
- Existing `bot.on('sei:dispatch', ...)` plumbing in `src/bot.js` → orchestrator's entrypoint stays the same; what changes is what the orchestrator does internally with the dispatched event.

### Established Patterns
- **Factored modules:** Phase 2 / 2.1 extracted `goalStore`, `inflight`, `persona`, `snapshot`, `targeting`, `circuit`, `debounce` into their own files for the same reason (orchestrator readability). Loop continues that pattern in `src/llm/loop.js` (D-38).
- **Closed Zod registry + AbortController + timeout-wrapping:** any new dispatch sites (compaction calls) MUST follow Phase 1 patterns — wall-clock timeout on every external call (CLAUDE.md ADR #5), AbortController plumbing through the call.
- **Atomic file writes** are not yet present in the codebase. Establish the `tmp+rename` helper in Plan 3-02 (or a small `src/storage/atomicWrite.js`) and use it for both OWNER.md and DIARY.md writes plus consolidation rewrites.
- **No mock LLM** (Phase 2 D-19). Iterate against real Haiku for the loop refactor and compaction prompts; budget a small token spend.

### Integration Points
- **Loop refactor seam:** all four Anthropic call sites in `src/llm/orchestrator.js` (lines ~204 / 209 / 233 / 250) get replaced by `loop.appendUserTurn(...)` + Anthropic call(`loop.buildAnthropicPayload()`) + `loop.appendAssistant(...)` + dispatch + `loop.appendToolResults(...)` cycle inside the new dispatch loop (replacing the current line-255+ dispatch loop).
- **FSM seam:** the existing P0 owner-chat preempt path in `src/fsm.js` continues to fire; orchestrator gains a catch site that wraps the abort with `loop.appendToolResults(synthetic_aborted_results)` + `loop.appendUserTurn([{name:'event', text:'PLAYER INTERRUPT: ...'}, {name:'snapshot', text:fresh}])` per D-40.
- **Config seam:** `src/config.js` gets the `memory:` block (D-59); existing config consumers untouched.
- **Lifecycle seam:** `src/bot.js` `setupEventHandlers()` (or wherever event handlers are wired) gains `playerJoined` / `playerLeft` listeners forwarded into a new `src/llm/sessionState.js` (or equivalent) that owns the session counters and fires session-start/end handlers per D-56 / D-57.

</code_context>

<specifics>
## Specific Ideas

- **Class naming locked:** `Loop` (not `Session`) — see vocabulary block in `<domain>`.
- **File naming locked:** `src/llm/loop.js` for the new class.
- **DIARY entry heading format locked:** `## YYYY-MM-DD HH:MM — <topic>` with `<topic>` derived deterministically from the LLM summary's first chunk.
- **OWNER.md layout locked:** YAML frontmatter (machine fields) + `# Notes` (LLM-prose).
- **Truncation strategy locked:** byte-budget (not token-budget); newest-first walk; drop oldest.
- **Compaction model locked:** same Haiku 3 + same cached prefix (no separate cheap model in v1).
- **Trim mechanism locked:** rebuild-on-call (not strip-on-append) — Loop.messages stays canonical and untouched by trimming.

</specifics>

<deferred>
## Deferred Ideas

- **Re-using cumulative-bytes / loop-counter counters across a process crash mid-session** (D-58) — V2. Requires persisting counters to disk on each loop terminal. v1 accepts that a crash counts as a session boundary.
- **Anthropic-tokenizer-based seed budgeting** instead of byte-budget (D-50) — V2 if budget pressure becomes a problem in practice.
- **Per-non-owner-player memory** (MEM-V2-01) — V2.
- **Vector / semantic retrieval over `DIARY.md`** (MEM-V2-02) — V2. The fixed-size recency-load in v1 will become the fallback; vector retrieval will return the top-K relevant entries on top of the recency slice.
- **Hot-reload of OWNER.md** — Phase 4 (Electron GUI), so the user can hand-edit notes and have Sei pick them up without restart.
- **Cost telemetry / cache-hit metrics** for the loop refactor — defer until cost becomes a concern; SPEC explicitly excludes from this phase.

</deferred>

---

*Phase: 03-memory-persistence*
*Context gathered: 2026-04-30*
