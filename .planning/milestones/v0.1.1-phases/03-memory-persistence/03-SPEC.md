# Phase 3: Memory & Persistence — Specification

**Created:** 2026-04-30
**Ambiguity score:** 0.11 (gate: ≤ 0.20)
**Requirements:** 6 locked

## Goal

Replace per-call stateless prompting with a Claude-Code-style active-loop session that owns conversation history, supports interrupt-on-chat, and on transition back to idle persists durable memory to two markdown files (`OWNER.md` + `DIARY.md`) loaded into every future session's seed message — so Sei recognizes her owner across restarts and references prior shared history without inventing it.

## Background

**What exists today (Phase 2.1 complete):**

- Two-layer LLM dispatch (Haiku personality → Ollama Qwen movement, with Haiku-as-executor fallback when Ollama is unreachable / `executor: 'api'`).
- Single-call combined fallback that emits personality + movement tool_uses in one Anthropic request.
- Closed Zod-typed action registry, in-flight tracker (`src/llm/inflight.js`), follow-lifecycle gate, FSM with priority queue and AbortController, owner-chat P0 preemption.
- `composeSnapshot` produces a per-turn world snapshot that includes `in_flight:` and `last_action_result:` lines.
- The 10-second idle timer fires `sei:idle` events that trigger one-shot Anthropic dispatches.

**What is missing (delta):**

- Every Anthropic call rebuilds `messages: [{ role: 'user', content: userBlock }]` from scratch. The model never sees its own prior `tool_use` blocks. There is **no rolling in-session context window** — MEM-01 has no implementation surface yet.
- `say` / `setGoals` / `dig` happen in independent calls; the LLM cannot reason "I already started chopping that tree, just continue" because the next turn arrives stateless.
- No persistence layer of any kind exists. No file is read at startup other than `config.json`. Restart erases everything Sei has experienced.
- No notion of "active session" vs "idle Sei". Today it's a continuous loop of one-shot dispatches driven by chat / world events / 10s idle.
- No owner UUID is captured anywhere — the bot recognizes the owner by `config.owner_username`, which fails the moment anyone changes their display name.

**Architectural pivot (locked in interview round 3):** REQUIREMENTS.md MEM-05 specifies `better-sqlite3` with atomic writes and a hard size cap. **This SPEC defers SQLite to V2** in favor of two human-readable markdown files. Rationale: ~10MB of session text is not a database problem; it's a "two text files plus periodic summarization" problem. Markdown files are diff-able, hand-editable, debug-friendly, and load directly into the seed message as text. SQLite + vector retrieval can return when V2 introduces semantic recall (MEM-V2-02).

## Requirements

1. **Active-loop session architecture (MEM-01)**: The orchestrator owns a `Session` object whose `messages` array accumulates the full conversation across iterations until the session terminates.
   - Current: Each Anthropic call re-builds `messages` from scratch — `[{role:'user', content: snapshot+event}]`. No history is preserved between calls.
   - Target: A `Session` class holds `messages`, `abortController`, `iterationCount`. Iteration loop: build user turn (snapshot + event/tool_results), call Anthropic, append assistant turn to messages, execute tool_uses, append tool_result user turn, repeat until response contains zero `tool_use` (or only `say`). The session lives until terminal response or interrupt.
   - Acceptance: A session that emits `dig → dig → dig → say "done"` is one Session whose final `messages` contains 1 seed user turn + (3 × assistant tool_use turn + tool_result user turn) + 1 terminal assistant turn. Inspection of `messages` shows tool_use ids paired with their tool_result blocks. Iteration count is bounded by a configured cap (default 20).

2. **Idle ↔ Active state machine**: Sei is explicitly in one of two states: idle (10s probe + follow only) or active (looped session running).
   - Current: No states exist. Every event triggers an independent dispatch.
   - Target: `idle` state — 10s timer fires a single Anthropic probe; if response contains movement tool_use, transition to `active` and let that response begin the session; if response is empty or only `say`, stay idle. `active` state — a Session is running; new chat from the owner aborts it (per requirement 3) but does not start a parallel session.
   - Acceptance: Logs show exactly one `[state] idle→active` transition per chat that produces movement, and exactly one `[state] active→idle` transition per session terminal. No two sessions ever overlap. The 10s probe never fires while a session is active.

3. **Interrupt-on-chat semantics (preserves working memory)**: Owner chat mid-session aborts the in-flight Anthropic call and the in-flight action, but does NOT discard the session's `messages` history.
   - Current: `src/fsm.js` already promotes owner chat to P0 when a non-P0 action is in flight; the action handler returns `'aborted'`. There is no `messages` array to preserve, so this requirement is not yet meaningful.
   - Target: When the FSM aborts the active session: (a) the in-flight action returns `'aborted'`, (b) any partially-completed tool_use blocks get matching tool_result blocks (with `aborted` content) appended so Anthropic's tool-use/tool-result invariant holds, (c) the new chat is appended as a fresh user turn formatted as `PLAYER INTERRUPT: <text>` followed by a fresh snapshot, (d) the session continues with the next iteration on the same `messages` array.
   - Acceptance: A test scenario where Sei is mid-`dig` and chat says "come here" produces a `messages` array containing the original goal, the partial dig (with `aborted` tool_result), the `PLAYER INTERRUPT: come here` user turn, and Sei's next assistant turn — verifiable by inspecting the live session's `messages` after the interrupt.

4. **Owner identity by UUID (MEM-03)**: Sei pins her owner to a Minecraft player UUID, not a username, and persists it.
   - Current: `config.owner_username` is the only owner reference. No UUID is recorded anywhere.
   - Target: On first owner interaction (chat from `config.owner_username`), Sei resolves the player's UUID via `bot.players[name].uuid` and writes it to `OWNER.md`. On subsequent boots, owner-recognition uses the persisted UUID; username changes don't break recognition. `OWNER.md` is loaded into every session's seed user message.
   - Acceptance: Boot the bot, chat with the owner, kill the bot, change the owner's Minecraft display name, reboot the bot, owner chats — Sei recognizes the owner by UUID and `OWNER.md` is unchanged in its `owner_uuid:` field.

5. **DIARY.md long-term game progression (MEM-04)**: Past loop-batches, accomplishments, and shared experiences accumulate in a chronological diary file that is loaded into every Loop's seed message.
   - Current: No file is written or read for long-term memory.
   - Target: `DIARY.md` exists at a configured path. Per-loop-batch summary writes append a new entry whenever, within the current Session, ≥10 Loops have completed since the last DIARY write OR cumulative `Loop.messages` bytes since the last write exceed `loop_batch_context_cap_bytes` (default 32 KB) — both counters reset on write. Consolidation Anthropic calls fire async when ≥4 Sessions have passed since the last consolidation OR when `DIARY.md` exceeds `diary_size_cap_bytes` (default 200 KB), rewriting the older portion of the diary into a denser narrative. Both `OWNER.md` and `DIARY.md` are read at Loop-start and pasted into the seed user message under headings `# Owner` and `# Diary (recent first)`.
   - Acceptance: After three Sessions each containing ≥10 Loops (or accumulating >32 KB of Loop bytes), `DIARY.md` contains ≥3 dated entries newest-first. After ≥4 Sessions have passed, exactly one consolidation pass has run (size-cap permitting). After bot restart, the next Loop's seed user message verifiably includes those entries (logged by the orchestrator).

6. **LLM-directed compaction trigger (MEM-02)**: Compaction (per-loop-batch summary + periodic consolidation) fires on the LLM's natural decision to terminate a Loop and on Session-boundary semantic events, not on a wall-clock timer.
   - Current: There are no compaction calls. The 10-second idle timer is a mechanical trigger but it does not write to disk.
   - Target: Per-loop-batch summary fires only when a Loop reaches its terminal response (no further `tool_use`, or only `say`) AND the loop-batch trigger from req 5 (10 Loops or 32 KB) is satisfied within the current Session. Consolidation fires only on Session-end (or async during a Session if the size-cap triggers). The 10-second idle probe never triggers compaction. The cadence (10 Loops / 32 KB / 4 Sessions) is a runtime gating policy ON TOP OF the semantic boundary, not a wall-clock timer — both triggers fire only at semantic boundaries (Loop terminal = LLM emitted no further `tool_use`; Session terminal = owner left).
   - Acceptance: Across a 60-minute test with multiple Sessions and many idle ticks, `DIARY.md` is appended only on loop-batch terminals — never on idle ticks, never mid-Loop. Consolidation runs strictly on Session-end or size-pressure, never on a wall-clock timer.

## Boundaries

**In scope:**

- **Plan 3-01 (lands first, separate merge):** Active-loop `Session` architecture, idle/active state machine, interrupt-on-chat with messages preservation, tool-result message wrapping, iteration cap. Replaces the current per-call stateless dispatch.
- **Plan 3-02:** Markdown memory layer — `OWNER.md` + `DIARY.md` files, owner UUID detection and persistence, seed-message loader that pastes both files into every session's first user turn.
- **Plan 3-03:** Compaction calls — per-session summary on active→idle, periodic consolidation every N=10 summaries OR on size cap, prompt design for both calls.
- File-system writes for the two markdown files (atomic via `tmp + rename`).
- Configuration: file paths, iteration cap, consolidation cadence (N), soft size cap.
- Updates to system prompts (`SYSTEM_INSTRUCTIONS` and `COMBINED_SYSTEM`) explaining the new history-aware loop semantics.

**Out of scope:**

- **better-sqlite3** — REQUIREMENTS.md MEM-05 deferred to V2. v1 uses two markdown files instead. SQLite returns when V2 introduces vector/semantic retrieval (MEM-V2-02).
- **Vector / semantic retrieval (RAG)** — MEM-V2-02 is V2. v1 uses recency-based fixed-size loading: always-load `OWNER.md` + the most recent portion of `DIARY.md` truncated to fit token budget.
- **Per-player memory for non-owner players** — MEM-V2-01 is V2.
- **Cross-server memory** — one bot, one server per install in v1.
- **Encrypting memory files at rest** — local single-user bot; OS-level disk encryption is sufficient.
- **Token-cost telemetry / cache-hit metrics** — useful but not required for this phase; can be added later if cost becomes a concern.
- **Schema migrations or backwards compatibility for memory files** — markdown is forgiving; v1 reads what's there and ignores fields it doesn't understand.
- **The two-call (Ollama-healthy) movement layer** — Qwen still gets the existing one-shot dispatch with no history. Conversation memory is personality-only, both for the two-call and combined paths. Movement remains stateless. (Rationale: Qwen's job is "translate intent to actions," not "remember the conversation"; adding history doesn't help and would explode local-model token cost.)

## Constraints

- **Token budget:** Sessions must terminate within 20 iterations. Seed user message + `OWNER.md` + `DIARY.md` (recent slice) must fit in ≤ 6 KB so the cached system prefix retains its hit rate. The orchestrator MUST drop snapshots from older user turns when appending new ones (only the most recent user turn carries a snapshot — historical user turns get truncated to the event/tool_result content).
- **Anthropic invariant:** Every `tool_use` block must have a paired `tool_result` block in the next user turn. Aborted tool_uses get a synthetic `'aborted'` tool_result so the conversation remains valid for resumption.
- **Single-flight session:** At most one active Session exists at any time. New chat aborts the in-flight session; it does not spawn a parallel one.
- **File atomicity:** All writes to `OWNER.md` and `DIARY.md` go through `fs.writeFile(tmp); fs.rename(tmp, target)` so a crash mid-write cannot corrupt the file.
- **Backwards compatibility:** A bot starting with no `OWNER.md` / `DIARY.md` (fresh install) MUST start cleanly with empty memory; the seed message contains placeholder text like "(no prior history yet)".
- **Active loop must respect existing infrastructure:** in-flight tracker, follow-lifecycle gate, owner-chat P0 preemption, hop cap (now repurposed as iteration cap), AbortController plumbing — all stay; the loop refactor must preserve them.
- **MEM-V2 features deferred:** vector retrieval (MEM-V2-02), per-player memory (MEM-V2-01) — call sites must be designed to allow these to land additively in V2 without a second refactor.

## Acceptance Criteria

*Vocabulary updated 2026-04-30 per CONTEXT spec_lock — see `03-CONTEXT.md` `<domain>` block for definitions of Session / Loop / Iteration. Where this section says "Loop" it means one active Sei task cycle; "Session" means one owner logon→logoff cycle; "Iteration" means one round-trip within a Loop.*

- [ ] **A1**: Running a Loop that emits multiple tool_uses across multiple Iterations produces a `messages` array where every `tool_use` block has a paired `tool_result` block in the immediately-following user turn.
- [ ] **A2**: The 10-second idle probe NEVER fires while an active Loop is in flight (verifiable via logs).
- [ ] **A3**: An owner chat sent mid-action aborts the in-flight Loop, preserves its `messages` history, appends `PLAYER INTERRUPT: <text>` as a new user turn, and the next Iteration runs on the same array.
- [ ] **A4**: After first interaction with the configured owner, `OWNER.md` exists with an `owner_uuid:` field matching `bot.players[name].uuid`. After the owner's display name changes server-side and the bot restarts, owner recognition still works.
- [ ] **A5**: After 3 Sessions with ≥10 Loops each (or accumulated >32 KB Loop bytes), `DIARY.md` contains ≥3 newest-first entries with timestamps and short summaries. After ≥4 Sessions have passed, exactly one consolidation pass has run (size-cap permitting).
- [ ] **A6**: A bot started with no memory files boots cleanly; the first Loop's seed user message contains placeholder text (not a missing-file error).
- [ ] **A7**: Across a 60-minute test with multiple Sessions and many idle ticks, `DIARY.md` is appended only on loop-batch terminals — never on idle ticks, never mid-Loop. Consolidation runs strictly on Session-end or size-pressure, never on a wall-clock timer.
- [ ] **A8**: At session start, the seed user message visibly includes the contents of `OWNER.md` and a recency-truncated slice of `DIARY.md` under `# Owner` / `# Diary` headings.
- [ ] **A9**: A session that exceeds the 20-iteration cap terminates gracefully with a final `say` line; it does not loop indefinitely.
- [ ] **A10**: The combined-call (executor=api) path uses `Session.messages` as conversation history. The two-call (Ollama-healthy) path keeps the existing stateless movement-layer call but uses session history for the personality call.

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                                                  |
|--------------------|-------|------|--------|----------------------------------------------------------------------------------------|
| Goal Clarity       | 0.90  | 0.75 | ✓      | Three concrete deliverables: loop refactor, MD files, compaction trigger.              |
| Boundary Clarity   | 0.95  | 0.70 | ✓      | SQLite explicitly deferred to V2; vector retrieval, non-owner players, encryption out. |
| Constraint Clarity | 0.85  | 0.65 | ✓      | Token budget ≤6 KB, iteration cap 20, file atomicity, single-flight session.           |
| Acceptance Criteria| 0.85  | 0.70 | ✓      | 10 pass/fail criteria, all observable from logs or filesystem state.                   |
| **Ambiguity**      | 0.11  | ≤0.20| ✓      | Gate passed.                                                                            |

## Interview Log

| Round | Perspective                | Question summary                                                | Decision locked                                                                                          |
|-------|----------------------------|-----------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1     | Researcher                 | Is the active-loop refactor inside Phase 3?                     | Yes — Plan 3-01 inside Phase 3.                                                                          |
| 1     | Simplifier                 | Does Plan 3-01 land first as its own merge?                     | Yes — loop refactor merges first; persistence follows.                                                   |
| 1     | Researcher                 | How does the LLM signal compact-now?                            | Implicit — compact on active→idle transition; the LLM's decision to terminate the loop is the signal.    |
| 2     | Simplifier                 | How is the per-session summary generated?                       | Extra Anthropic call on active→idle; **not** every 10s idle tick. Optional N-session batched consolidation.|
| 2     | Researcher                 | What does "owner" mean for v1 memory?                           | Single configured owner pinned by Minecraft UUID. Non-owner players are V2 (MEM-V2-01).                  |
| 2     | Researcher                 | Hard size cap on persistent store?                              | 10 MB envelope (later relaxed since storage is text files, not DB). Per-file soft cap ~200 KB triggers consolidation.|
| 3     | Boundary Keeper            | One-tier or two-tier compaction?                                | Two-tier — per-session summary on active→idle; periodic consolidation every N=10 sessions or size pressure.|
| 3     | Boundary Keeper            | What's explicitly out of scope?                                 | MEM-V2 features (per-player, vector), cross-server, file encryption.                                     |
| 3     | Boundary Keeper            | Restart-recognition acceptance test?                            | Both — file contains `owner_uuid:` matching live UUID, AND Sei references prior session topic in chat.   |
| 3     | Boundary Keeper (followup) | How does memory enter context without RAG?                      | **Pivot:** defer SQLite + RAG entirely; use two markdown files (`OWNER.md`, `DIARY.md`) loaded directly into every seed message. SQLite + RAG are V2.|

---

## Changelog

- 2026-04-30: req 5 / req 6 / A5 / A7 / ROADMAP success criteria 1, 3, 5 rewritten against locked vocabulary (Plan 3-01 Task 3). Vocabulary footnote added under Acceptance Criteria. References to "active session" / "session terminal" / "1 DIARY entry per session" replaced with the loop-batch / Session / Loop-terminal terms from `03-CONTEXT.md` `<domain>` block.

---

*Phase: 03-memory-persistence*
*Spec created: 2026-04-30*
*Last updated: 2026-04-30*
*Next step: `/gsd-discuss-phase 3` — implementation decisions (Loop class shape, message-array snapshot trimming, OWNER.md/DIARY.md schema, compaction prompt design, etc.)*
