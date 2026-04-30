# Phase 3: Memory & Persistence - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 03-memory-persistence
**Areas discussed:** Session & FSM integration, Memory file schemas (OWNER/DIARY), Compaction prompt design, Snapshot trimming in messages, Session boundary detection

---

## Session & FSM Integration

### Q1 — Where should the Session class live and how should it own state vs the existing orchestrator?

| Option | Description | Selected |
|--------|-------------|----------|
| New `src/llm/session.js` (later renamed to `loop.js`), owned by orchestrator | Stateful object created on idle→active transition, holds `{messages, abortController, iterationCount, startedAt}`; orchestrator becomes thin shell | ✓ |
| Inline state inside `orchestrator.js` | Closure variable; cheaper diff but orchestrator already 477 lines | |
| Top-level FSM-owned Session | Tighter coupling; harder to reason about across two temporal scales | |

**User's choice:** New module file owned by orchestrator (renamed `Loop` → `src/llm/loop.js` after vocab pivot)
**Notes:** Mirrors how `goalStore` / `inflight` / `persona` were factored out in Phase 2.

### Q2 — How should the idle/active state machine layer onto the existing FSM?

| Option | Description | Selected |
|--------|-------------|----------|
| Active = orchestrator-internal flag, FSM unchanged | Orchestrator gates 10s idle probe on `currentLoop === null`; FSM priority queue handles the rest | ✓ |
| Promote idle/active to first-class FSM states | Duplicates priority-queue logic; risks two sources of truth | |
| Separate state machine alongside the FSM | Most plumbing; no obvious need | |

**User's choice:** FSM unchanged; orchestrator owns the idle/active flag.

### Q3 — When the FSM aborts mid-loop, who synthesizes the `aborted` tool_result blocks Anthropic requires?

| Option | Description | Selected |
|--------|-------------|----------|
| Orchestrator's catch block | Walks last assistant turn's tool_use blocks, emits matching tool_results, then appends PLAYER INTERRUPT user turn | ✓ |
| Loop class auto-pairs on abort | Cleaner encapsulation but couples Loop to the action-handler return-string convention | |
| Action handlers emit their own aborted result string | Doesn't solve cases where AbortController fires before handler runs | |

**User's choice:** Orchestrator's catch block.

### Q4 — On the two-call (Ollama-healthy) path, what gets appended to Loop.messages?

| Option | Description | Selected |
|--------|-------------|----------|
| Personality assistant turn + synthetic tool_result for handOff | Movement layer stays stateless; outcome enters personality history as tool_result | ✓ |
| Personality assistant turn only; movement invisible | Loses Anthropic invariant; personality won't know if handOff succeeded | |
| Full two-layer trace in Loop.messages | Burns tokens; breaks D-04 (personality never sees action names) | |

**User's choice:** Personality + synthetic handOff tool_result.

---

## Memory File Schemas (OWNER.md / DIARY.md)

### Q5 — How should OWNER.md be structured on disk?

| Option | Description | Selected |
|--------|-------------|----------|
| YAML frontmatter + freeform `# Notes` section | Frontmatter for machine fields, prose section for LLM-managed notes | ✓ |
| Pure markdown with labeled sections | Regex-y to parse owner_uuid reliably | |
| JSON-in-markdown fenced block | Robust parse but uglier for hand-edit | |

**User's choice:** YAML frontmatter + Notes.

### Q6 — How should DIARY.md entries be shaped?

| Option | Description | Selected |
|--------|-------------|----------|
| Newest-first dated entries with short prose body | Heading + 2–4 sentences; recency-truncation trivial | ✓ |
| Structured entry with fields | Queryable but reads clinical when pasted into seed | |
| Append-only event log | Blows budget within a few sessions | |

**User's choice:** Newest-first dated prose entries.

### Q7 — How should the seed-message loader truncate DIARY.md when total size exceeds the token budget?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep newest entries until byte budget hit, drop oldest | Byte-budget within ~10% of token count; no tokenizer needed | ✓ |
| Token-based truncation via tokenizer | More accurate but adds dependency for trimming only | |
| Always include consolidated block + last K verbatim entries | Predictable but can blow budget on verbose entries | |

**User's choice:** Newest-first byte-budget truncation.

### Q8 (multiSelect) — Which fields should OWNER.md track in v1?

| Option | Description | Selected |
|--------|-------------|----------|
| owner_uuid (required) | Source of truth for recognition (MEM-03) | ✓ |
| owner_username (current) | Display name for chat addressing; updated on connect | ✓ |
| first_seen, last_seen, total_sessions | Lightweight session-level counters | ✓ |
| Cosmetic (preferred_name, pronouns) | Optional; LLM-managed | ✓ |

**User's choice:** All four.

---

## Compaction Prompt Design

### Q9 — How should the per-session-summary call be prompted?

| Option | Description | Selected |
|--------|-------------|----------|
| Freeform narrative, in-character | 2–4 sentences in Sei's voice; no headings; pastes under deterministic heading | ✓ (with major reframing — see notes) |
| Structured field extraction | Reads clinical when pasted | |
| Hybrid — short structured header + prose body | Heading is orchestrator-composable anyway | |

**User's choice:** Freeform narrative.

**Notes (vocabulary pivot — significant):** User clarified the meaning of "session" differs from SPEC.md's usage:
- **Session** = entire real-world play session (owner logon → logoff).
- **Loop** = one active Sei cycle that completes a task (was "Session" in SPEC.md prose).
- The summary call now fires **every 10 loops OR when our context limit (configurable, not the model's) is hit** — NOT once per loop terminal.
- This overrides SPEC.md acceptance criteria A5 / A7 — flagged in CONTEXT.md `<spec_lock>` for the planner to update.

### Q10 — Which model + prompt-prefix strategy?

| Option | Description | Selected |
|--------|-------------|----------|
| Same Haiku 3 + same cached system/persona prefix | Cache hit; consistent voice between in-loop and diary | ✓ |
| Haiku 3 with different stripped-down prompt (no tools) | Loses cache; risks voice drift | |
| Cheaper model (Haiku 3.5 / Sonnet downgrade) | Adds second client; rare-call savings don't justify | |

**User's choice:** Same Haiku 3 + same cached prefix.

### Q11 — How should the consolidation pass work?

| Option | Description | Selected |
|--------|-------------|----------|
| Rewrite older half into one denser narrative block | Newest-first preserved; drops volume without losing facts | ✓ (with cadence override) |
| Always-rewrite of full DIARY.md into one block | Telephone-game drift on newest entries | |
| Sliding-window: keep last K verbatim, drop the rest | Violates SPEC req 5 (no LLM call); silently loses progression | |

**User's choice:** Older-half rewrite. Cadence override: every **N=4 sessions** (full owner logon→logoff cycles, regardless of loops per session) **OR** on file size cap.

### Q12 — When does consolidation actually fire?

| Option | Description | Selected |
|--------|-------------|----------|
| Check after each per-session-summary write; fire async if either trigger met | Inline keeps file-state coherent | ✓ |
| Defer to next idle tick after trigger | Adds state flag; SPEC said compaction fires on active→idle, not idle ticks | |
| Background queue with retry | Robust but introduces queue + persistence concerns | |

**User's choice:** Async if either trigger met (4 sessions or size cap).

### Q13 (clarifier) — What does "our context limit" mean as the loop-batch-summary trigger?

| Option | Description | Selected |
|--------|-------------|----------|
| Cumulative loop-messages bytes within the current session | Direct read of "our limit, not Anthropic's"; easy to measure & tune | ✓ |
| Seed-message budget pressure | Conflates trigger with truncation | |
| Anthropic input-token estimate per loop crossing a threshold | More precise but needs tokenizer | |

**User's choice:** Cumulative loop-messages bytes; default ~32 KB; configurable.

---

## Snapshot Trimming in Messages

(Re-asked once after vocabulary pivot to consistently use Loop terminology.)

### Q14 — Where does world-snapshot trimming happen — on append (write-time) or on rebuild (read-time)?

| Option | Description | Selected |
|--------|-------------|----------|
| Strip-on-append: prior user turn rewritten when new one is added | Loop.messages stays canonical with the trim invariant baked in | |
| Rebuild-on-call: trim a copy before each Anthropic request | Loop.messages keeps full history including prior snapshots; trimmed copy built per request | ✓ |
| Snapshot stored separately from Loop.messages | Cleanest separation but most invasive | |

**User's choice:** Rebuild-on-call. Loop.messages stays canonical with full history; orchestrator builds trimmed payload per Anthropic request.

### Q15 — What's the structural shape of a user turn in Loop.messages?

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-block content array: `[snapshot_block, event_block, tool_results...]` with named blocks | Self-documenting; trim has unambiguous target | ✓ |
| Single concatenated string with sentinel headers | Fragile parsing | |
| Two-field user turn: `{snapshot, body}` | Requires flatten step at every send | |

**User's choice:** Multi-block content array with named blocks.

### Q16 — Where does the trim helper live so both two-call and combined-call paths share it?

| Option | Description | Selected |
|--------|-------------|----------|
| Loop class methods (`appendUserTurn` / `appendToolResults` / `appendAssistant` / `buildAnthropicPayload`) | Trimming invariant cannot be bypassed | ✓ |
| Free function in `src/llm/loop.js` | Caller has to remember to call them | |
| Inline in orchestrator at each append site | High duplication risk | |

**User's choice:** Loop class methods.

### Q17 — How does the seed user turn (OWNER+DIARY) interact with snapshot trimming on subsequent turns of that Loop?

| Option | Description | Selected |
|--------|-------------|----------|
| Seed turn permanent; OWNER/DIARY content stays visible all loop; only the seed's *snapshot block* trims when iteration 2 arrives | LLM always grounded in owner identity AND latest world state | ✓ |
| Seed gets trimmed like any other user turn | LLM forgets owner mid-loop | |
| Seed OWNER+DIARY re-rendered into every user turn | Wasteful | |

**User's choice:** Seed permanent; only its embedded snapshot block trims.

---

## Session Boundary Detection

### Q18 — What event marks a session boundary?

| Option | Description | Selected |
|--------|-------------|----------|
| Owner playerJoined / playerLeft (UUID-filtered) | Matches the locked vocabulary; bot connection is independent | ✓ |
| First owner-chat → idle-after-N-min-without-owner-presence | Smoother for noisy join/leave but ambiguous | |
| Bot's own connection lifecycle (`bot.on('spawn'/'end')`) | Doesn't match vocabulary; bot may sit alone | |

**User's choice:** Owner playerJoined / playerLeft.

### Q19 — What if the bot starts (or restarts) while owner is already on-server?

| Option | Description | Selected |
|--------|-------------|----------|
| Treat as session-start: open immediately on `bot.on('spawn')` if owner is in `bot.players` | Handles cold-starts & crash-recoveries | ✓ |
| Wait for next playerJoined event regardless | Loses session tracking on crash mid-session | |
| Treat `bot.on('spawn')` as session-start always | Inflates count when Sei is alone | |

**User's choice:** Spawn-time check + immediate session-start if owner present.

---

## Claude's Discretion

The user explicitly left these to Claude (captured in CONTEXT.md `<decisions>` → "Claude's Discretion" subsection):
- Exact bytes-vs-tokens tuning for the seed budget defaults
- Internal layout of `Loop` class private helpers, error wrapping, metric hooks
- Per-block `name` field schema beyond the required `snapshot` and `event` names
- Whether the seed loader emits one combined block or separate blocks (must satisfy D-45)
- Exact prose wording of compaction prompts (constraints in D-52, D-54)
- Settle-delay duration after `bot.on('spawn')` before checking `bot.players` (start ~500 ms)
- Internal storage of cumulative-bytes / loop-counter (orchestrator vs Loop vs new sessionState module)
- Logging shape for session-start / session-end / loop-batch-write / consolidation-fire events

## Deferred Ideas

- **Re-using cumulative-bytes / loop-counter counters across a process crash mid-session** → V2.
- **Anthropic-tokenizer-based seed budgeting** instead of byte-budget → V2 if budget pressure becomes a problem.
- **Per-non-owner-player memory** (MEM-V2-01) → V2.
- **Vector / semantic retrieval over `DIARY.md`** (MEM-V2-02) → V2.
- **Hot-reload of OWNER.md** → Phase 4 (Electron GUI).
- **Cost telemetry / cache-hit metrics** for the loop refactor → defer until cost becomes a concern.
