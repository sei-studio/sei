# Phase 3: Memory & Persistence — Research

**Researched:** 2026-04-30
**Domain:** Active-loop conversation architecture + flat-file persistence (markdown) + LLM-directed compaction
**Confidence:** HIGH — most decisions are locked in CONTEXT; this research verifies SDK invariants, mineflayer event semantics, fs idioms, and surfaces planner-relevant pitfalls.

## Summary

Phase 3 has two unusually well-locked artifacts (`03-SPEC.md` + `03-CONTEXT.md`) — most architectural decisions are already made (D-38 through D-59). The research surface is: (a) verifying that the Anthropic SDK installed in this repo actually supports the message shapes the plan assumes, (b) verifying mineflayer player-event timing/semantics for D-56/D-57, (c) the atomic-write idiom for the two markdown files, and (d) surfacing pitfalls the planner must encode as task-level guards. SQLite/RAG are explicitly out of scope (CONTEXT line 17, SPEC line 76).

The single biggest planner-facing surprise: **D-42's `name` field on text blocks is a client-side annotation only — Anthropic's `TextBlockParam` schema has no `name` field** (verified against installed `@anthropic-ai/sdk@0.91.1` at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:887`). The Loop class must keep `name`-tagged blocks in its canonical `messages` array, and `buildAnthropicPayload()` must strip them down to `{type:'text', text}` before the SDK call. The trim/seed-protection logic operates on the canonical (tagged) form; the API call sees the stripped form.

**Primary recommendation:** Plan 3-01 first (loop refactor, no persistence) — merge before 3-02/3-03. Establish `Loop` + `buildAnthropicPayload()` as the single seam. Plans 3-02 and 3-03 then plug into well-defined extension points (`seed:true` user turn for 3-02, "Loop terminal" hook for 3-03) without touching dispatch logic.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Conversation history ownership | Orchestrator (`src/llm/loop.js`) | — | Personality LLM is the only consumer; movement Qwen stays stateless (SPEC §Out of scope). |
| Idle/active gating | Orchestrator (internal flag) | FSM (event delivery) | D-39 locks: FSM unchanged; orchestrator gates 10s probe on `currentLoop === null`. |
| Mid-loop abort + tool_use/tool_result repair | Orchestrator catch block | FSM (signals abort via existing P0 promotion) | D-40 locks: orchestrator owns synthesis of `aborted` tool_results so Loop class stays FSM-agnostic. |
| Owner identity persistence | Storage layer (`OWNER.md` + atomic-write helper) | mineflayer (`bot.players`/`bot.uuidToUsername`) | Source of truth is the file; mineflayer is the lookup for fresh username/UUID resolution. |
| Session boundary detection | mineflayer event handlers (`playerJoined`/`playerLeft`/`spawn`) | New `sessionState` module (counters, fires handlers) | Owner presence (not bot connection, D-58) defines session edges. |
| Compaction call dispatch | Orchestrator (post-loop hook) | Anthropic client (same cached prefix) | Reuses cached system blocks → ~zero marginal prefix cost. |
| Atomic file writes | New `src/storage/atomicWrite.js` | Node `fs/promises` (`writeFile` + `rename`) | Single helper consumed by OWNER and DIARY writers + consolidation rewrite. |
| Snapshot composition | Existing `src/observers/snapshot.js` (unchanged) | New `Loop.appendUserTurn` (places it as a tagged block) | Phase 2.1 D-26 still owns *what* the snapshot is; Phase 3 only changes *where* it goes. |

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MEM-01 | Rolling in-session context window | `Loop.messages` array per D-38; multi-block content arrays per D-42 confirmed supported by SDK 0.91.1 (verified) |
| MEM-02 | LLM-directed compaction at semantic boundaries | D-55 reframes: cadence (10 loops / 32KB / 4 sessions) is *gating* on top of the semantic boundary (loop-terminal = no further `tool_use`); 10s idle never triggers compaction |
| MEM-03 | Owner identity by UUID, not username | mineflayer exposes `bot.players[name].uuid` and `bot.uuidToUsername[uuid]` (verified at `node_modules/mineflayer/lib/plugins/entities.js:649-650`); both populated by the player-info packet handler |
| MEM-04 | Long-term game progression record | `DIARY.md` newest-first dated entries per D-49; consolidation per D-53/D-54 |
| MEM-05 | Durable persistence with atomic writes + soft size cap | **SQLite deferred to V2** (SPEC line 76, CONTEXT line 17). Phase 3 satisfies *intent* via: atomic `writeFile(tmp)+rename(tmp,target)` (D-59 / SPEC line 90), 200KB soft cap on DIARY.md (D-53), consolidation as the size-pressure response. |

## User Constraints (from CONTEXT.md)

### Locked Decisions
**Vocabulary** (CONTEXT lines 11-16): `Session` = owner logon→logoff; `Loop` = one Sei task cycle owning a `messages` array; `Iteration` = one round-trip within a Loop.

**Plan 3-01 (loop refactor, lands first):**
- D-38: New `Loop` class at `src/llm/loop.js` with `{messages, abortController, iterationCount, startedAt, seed}`. Public API: `appendUserTurn(blocks)`, `appendAssistant(content)`, `appendToolResults(results, {snapshot})`, `buildAnthropicPayload()`.
- D-39: Idle/active is an orchestrator-internal flag; **FSM unchanged**; gates 10s probe on `currentLoop === null`.
- D-40: Orchestrator catch block synthesizes `aborted` tool_results when FSM aborts mid-loop.
- D-41: `handOffToMovement` `tool_use` gets a synthetic `tool_result` summarizing what movement did (preserves Phase 2 D-04 — no action names leak into personality reasoning).
- D-42: User-turn content = multi-block array of named text blocks (`snapshot`, `event`) plus `tool_result` blocks.
- D-43: **Rebuild-on-call trim** — `Loop.messages` keeps full history (canonical, debug-friendly); `buildAnthropicPayload()` returns a copy with snapshot blocks stripped from all but the last user turn. Original is never mutated.
- D-44: All trim helpers are `Loop` methods so two-call AND combined-call paths cannot bypass.
- D-45: Seed user turn is permanent in `Loop.messages`; `buildAnthropicPayload()` skips OWNER/DIARY content on seed turns from trimming, but **the seed turn's snapshot block IS trimmed** when iteration 2 arrives.

**Plan 3-02 (markdown layer):**
- D-46: `OWNER.md` = YAML frontmatter + `# Notes` freeform section.
- D-47: Frontmatter v1 fields: `owner_uuid`, `owner_username`, `first_seen`, `last_seen`, `total_sessions`, `preferred_name`, `pronouns`.
- D-48: UUID resolution on first owner-chat or first session-start where owner present, via `bot.players[config.owner_username].uuid`. After persisted, recognition is UUID-only.
- D-49: `DIARY.md` = newest-first, `## YYYY-MM-DD HH:MM — <topic>` heading + 2–4 sentences body. Consolidation produces one `## Earlier (consolidated through YYYY-MM-DD)` block at the bottom.
- D-50: Seed-load truncation = byte-budget (no tokenizer), newest-first walk, drop oldest. Defaults `seed_diary_budget_bytes=3072`, `seed_owner_budget_bytes=1024`.

**Plan 3-03 (compaction):**
- D-51: Per-loop-batch summary trigger: ≥10 loops since last DIARY write within current session **OR** cumulative bytes > 32KB. Counters reset on write.
- D-52: Per-loop-batch prompt: 2–4 in-character sentences narrative, prepended with concatenation of recent `Loop.messages` since last DIARY write. Same Haiku 3 + same cached prefix.
- D-53: Consolidation trigger (async, non-blocking): ≥4 sessions since last consolidation **OR** DIARY.md > 200KB.
- D-54: Consolidation prompt: split DIARY into recent half / older half; rewrite older half into one denser narrative paragraph; replace older half on disk atomically.
- D-55: MEM-02 satisfaction = both triggers fire only at semantic boundaries (loop-terminal, session-terminal); 10s idle never compacts.

**Session boundary (D-56/D-57/D-58):**
- D-56: Session start/end = owner `playerJoined`/`playerLeft` filtered by UUID. Session-start handler increments `total_sessions`, sets `first_seen` if unset, resets per-session counters, increments `sessions_since_consolidation`. Session-end handler persists `last_seen` and flushes any pending diary write.
- D-57: On `bot.on('spawn')`, after a settle delay (~500ms — `bot.players` populates a few ticks after spawn), check for owner; if present, fire session-start.
- D-58: Bot disconnect ≠ session end. Session is bounded by *owner* presence. v1 accepts: process crash mid-session counts as a session boundary; reuse-across-crash is V2.

**Config additions (D-59 — `memory:` block):** `owner_md_path`, `diary_md_path`, `iteration_cap=20` (replaces Phase 2 hop cap LLM-04), `loop_batch_loop_count_cap=10`, `loop_batch_context_cap_bytes=32768`, `sessions_per_consolidation=4`, `diary_size_cap_bytes=204800`, `seed_diary_budget_bytes=3072`, `seed_owner_budget_bytes=1024`.

**SPEC overrides (planner MUST update SPEC.md):** SPEC requirement 5, A5, A7 reference "1 DIARY entry per active session". CONTEXT overrides to "per loop-batch (10 loops OR 32KB)" + "consolidation every 4 sessions OR on size cap". Planner rewrites those four pieces of SPEC prose against the new vocabulary before finalizing plans.

### Claude's Discretion
- Exact bytes-vs-tokens tuning for seed budget (target 6KB cap; D-59 defaults are starting points).
- Internal `Loop` private helpers, error wrapping, metric hooks — public API in D-44 is fixed.
- Per-block `name` schema additions beyond `snapshot`/`event` — `tool_result_summary`, `seed_owner`, `seed_diary` are at planner's discretion.
- Whether seed loader emits one combined block or three blocks (must satisfy D-45).
- Exact prose wording of compaction prompts (constraints in D-52, D-54).
- Settle-delay duration after `bot.on('spawn')` for D-57 — start with ~500ms.
- Internal storage of cumulative-bytes/loop counters (in-memory on orchestrator vs. Loop vs. new `sessionState` object — pick what reads cleanly; recommendation below in §Architecture Patterns).
- Whether to emit structured log events on session-start/session-end/loop-batch-write/consolidation-fire (recommended yes, shape is open).
- Test strategy: real Haiku per Phase 2 D-19 (no mock LLM); manual harness; fs fixtures for round-trips.

### Deferred Ideas (OUT OF SCOPE)
- Re-using cumulative-bytes/loop-counter counters across a process crash mid-session (D-58) — V2.
- Anthropic-tokenizer-based seed budgeting instead of byte-budget — V2 if pressure appears.
- Per-non-owner-player memory (MEM-V2-01) — V2.
- Vector / semantic retrieval over `DIARY.md` (MEM-V2-02) — V2.
- Hot-reload of OWNER.md — Phase 4 (Electron GUI).
- Cost telemetry / cache-hit metrics for the loop refactor — defer.

## Project Constraints (from CLAUDE.md)

- **Two-layer LLM hand-off (ADR #1):** Personality decides; movement executes. D-41 must preserve: `handOffToMovement` is the only seam, movement Qwen stays stateless (SPEC line 83 reaffirms).
- **Closed action registry (ADR #2):** Compaction calls do NOT add registry actions; they are direct `anthropic.call(...)` invocations against the same cached prefix.
- **FSM stays unchanged (ADR #3 / D-39):** Plan 3-01 must NOT touch `src/fsm.js`. Touching it is a planning red flag.
- **Every external call has a timeout (ADR #5):** New compaction calls (D-52/D-54) MUST go through `anthropicClient.call({timeoutMs: ...})` — never bypass. Atomic file writes have implicit kernel timeouts; no extra wrapper needed.
- **Native ABI mismatch warning:** N/A this phase — markdown files have zero native deps. (Becomes relevant again if SQLite returns in V2.)

## Standard Stack

### Core (already in repo, no new deps required)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | 0.91.1 [VERIFIED: package.json + node_modules] | Personality LLM + compaction calls | Already wired through `anthropicClient.js`; supports multi-block content arrays + `tool_use`/`tool_result` invariant |
| `mineflayer` | ^4.23.0 [VERIFIED: package.json] | Bot core; player events + `bot.players[name].uuid` lookups | Already in use; `playerJoined`/`playerLeft` events verified at `node_modules/mineflayer/lib/plugins/entities.js:661,733,752` |
| `zod` | ^3.22.4 [VERIFIED] | Config schema extension for `memory:` block | Already used by `src/config.js`; extend in place |
| Node `fs/promises` | (built-in) | `writeFile`/`rename`/`readFile` | Standard atomic-write idiom; no third-party needed |

### Supporting (NOT to add)
| Decision | Rationale |
|----------|-----------|
| **No `js-yaml` / `yaml` package for v1** | OWNER.md frontmatter v1 is flat key:value (D-47). Regex-parseable. Add `yaml` only if frontmatter grows nested structures (CONTEXT line 150 explicitly authorizes deferring). |
| **No tokenizer (`@anthropic-ai/tokenizer` or `tiktoken`)** | D-50 locks byte-budget. Within ~10% of token count for plain markdown — sufficient for a soft cap. V2 may add a tokenizer if pressure appears. |
| **No `proper-lockfile` / `write-file-atomic`** | Single-process bot, no concurrent writers. Plain `fs.writeFile(tmp); fs.rename(tmp, target)` is the standard Unix atomic-replace idiom on macOS+Linux; on Windows, `fs.rename` is also atomic for same-volume replacement (Node ≥10.x uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`). [VERIFIED: Node fs docs] |

### Alternatives Considered (and rejected per CONTEXT)
| Instead of | Could Use | Why CONTEXT rejects |
|------------|-----------|---------------------|
| Markdown files | `better-sqlite3` | SPEC line 76: "10 MB of session text is not a database problem." SQLite returns in V2 with vector retrieval. |
| Recency-truncated DIARY slice | Vector retrieval / RAG | MEM-V2-02 — V2. v1's recency slice becomes the fallback baseline. |
| Token-budget seed | Byte-budget seed | D-50 — within ~10% for plain markdown; tokenizer dep not justified yet. |
| Two summary tiers (per-loop + per-session) | Single tier | D-51/D-53 explicitly chose two-tier with revised cadence (10 loops / 4 sessions). |

**Installation:** No new dependencies. Phase 3 is a pure source-code phase against existing deps.

**Version verification:** `@anthropic-ai/sdk@0.91.1` confirmed installed; SDK 0.91.x supports `messages.create({system: TextBlockParam[], messages: [{role, content: ContentBlockParam[]}]})` with `tool_use`/`tool_result` invariant — verified at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:439` (`ContentBlockParam` union includes `ToolUseBlockParam` and `ToolResultBlockParam`). [VERIFIED: installed types]

## Architecture Patterns

### System Architecture Diagram

```
                    ┌──────────────────┐
  Minecraft chat ──▶│  bot.on('chat')  │
  world events  ──▶ │   FSM (P0–P3)    │ (UNCHANGED — ADR #3 / D-39)
  10s idle      ──▶ │  AbortController │
                    └────────┬─────────┘
                             │ sei:dispatch  (event, data, signal)
                             ▼
                  ┌─────────────────────────┐
                  │  Orchestrator (gated)   │
                  │  if currentLoop:        │
                  │    appendUserTurn       │
                  │    (interrupt path)     │
                  │  else:                  │
                  │    new Loop()           │
                  │    seedFromOWNER+DIARY  │
                  └────────────┬────────────┘
                               │
                ┌──────────────┴───────────────┐
                ▼                              ▼
   ┌────────────────────────┐      ┌──────────────────────┐
   │ Loop (src/llm/loop.js) │◀────▶│ anthropic.call(      │
   │  messages: [...]       │      │   buildAnthropicPay  │
   │  iterationCount        │      │   load())            │
   │  abortController       │      └──────────┬───────────┘
   │  seed: bool            │                 │
   │  appendUserTurn        │                 ▼
   │  appendAssistant       │     [tool_use blocks dispatched
   │  appendToolResults     │      via Phase 1 registry,
   │  buildAnthropicPayload │      handOffToMovement→ Ollama
   │   (strips name fields) │      stateless call (D-04)]
   └────────────────────────┘                 │
                                              ▼
                                  [tool_result wrapped back
                                   into Loop via
                                   appendToolResults]
                               │
            Loop terminal (no tool_use, or only `say`)
                               │
                               ▼
              ┌──────────────────────────────────┐
              │  loopBatch counter ++            │
              │  loopBatch bytes += msg-bytes    │
              │  if ≥10 loops OR ≥32KB:          │
              │    compaction call → DIARY.md    │
              │    (atomic write)                │
              │    reset counters                │
              └──────────────────────────────────┘

      ┌──────────────────────────────────────────────┐
      │  Session boundary (orthogonal):              │
      │  bot.on('playerJoined') filtered by owner    │
      │  bot.on('playerLeft')   filtered by owner    │
      │  bot.on('spawn') + ~500ms settle → check     │
      │    bot.players for owner (D-57)              │
      │  on session-start: bump total_sessions,      │
      │    write OWNER.md (atomic)                   │
      │  on session-end: flush pending diary,        │
      │    if ≥4 sessions OR DIARY>200KB:            │
      │      consolidation (async, non-blocking)     │
      └──────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/
├── llm/
│   ├── orchestrator.js     # thin shell after refactor; owns Loop lifecycle
│   ├── loop.js             # NEW (Plan 3-01): Loop class — D-38, D-42, D-43, D-44, D-45
│   ├── sessionState.js     # NEW (Plan 3-02): owner UUID detection, session counters,
│   │                       # in-memory loop-batch counters; wires playerJoined/playerLeft
│   ├── memoryStore.js      # NEW (Plan 3-02): OWNER.md/DIARY.md read+parse+seed-load
│   ├── compactor.js        # NEW (Plan 3-03): per-loop-batch + consolidation prompts/calls
│   ├── anthropicClient.js  # UNCHANGED (request shape change is in payload-builder, not client)
│   ├── ollamaClient.js     # UNCHANGED
│   ├── persona.js          # UNCHANGED — cached prefix unchanged (OWNER/DIARY go in seed user turn)
│   ├── inflight.js         # UNCHANGED
│   ├── circuit.js          # UNCHANGED
│   └── debounce.js         # UNCHANGED
├── storage/
│   └── atomicWrite.js      # NEW (Plan 3-02): writeFile(tmp); rename(tmp, target)
├── observers/
│   └── snapshot.js         # UNCHANGED — composeSnapshot() output now lands in a tagged block
├── fsm.js                  # UNCHANGED (ADR #3, D-39)
├── bot.js                  # MODIFIED: add playerJoined/playerLeft listeners → sessionState
└── config.js               # MODIFIED: add `memory:` block per D-59
```

### Pattern 1: `Loop.buildAnthropicPayload()` — rebuild-on-call trim
**What:** Walk `Loop.messages`; for every user turn that is NOT the most recent, drop blocks where `block.name === 'snapshot'`. For seed turns, additionally KEEP `seed_owner`/`seed_diary` blocks (D-45). Strip the client-side `name` field from every text block before returning (Anthropic's `TextBlockParam` schema only accepts `{type, text, cache_control?, citations?}`; unknown fields may be ignored today but are not contractually accepted — verified at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:887-895`).

**When to use:** Every Anthropic call inside the loop. Both two-call (Ollama-healthy) personality call AND combined-call (Ollama tripped) call go through this — D-44.

**Pseudo-shape (planner-level, not code):**
```
buildAnthropicPayload():
  out = []
  lastUserIdx = index of last role=='user' in messages
  for i, msg in messages:
    if msg.role == 'user':
      blocks = []
      for b in msg.content:
        if b.type == 'text':
          isSnapshot = b.name == 'snapshot'
          isSeedSpecial = msg.seed && b.name in ('seed_owner','seed_diary')
          if isSnapshot && i != lastUserIdx: skip
          // (seed_owner/seed_diary are kept regardless of position, per D-45)
          blocks.push({type:'text', text: b.text, cache_control: b.cache_control})
        else if b.type == 'tool_result':
          blocks.push(b)  // pass through unchanged (already SDK-shape)
      out.push({role:'user', content: blocks})
    else:
      out.push(msg)  // assistant turns pass through; SDK handles tool_use blocks natively
  return out
```

### Pattern 2: Synthetic `aborted` tool_results on FSM preempt — D-40
**What:** When the FSM aborts mid-loop (owner chat preempts), `signal.aborted === true` propagates into the orchestrator's catch block. Walk the LAST assistant turn's `tool_use` blocks; for each one, emit a matching `{type:'tool_result', tool_use_id: u.id, content: 'aborted: player interrupt', is_error: false}`. Append all of them as a single user turn (Anthropic invariant: tool_results live in the next user turn). THEN append a second user turn (or merge into the same content array — pick one and stick to it; recommendation: same content array, since Anthropic accepts `[tool_result..., text...]` mixed) carrying `{type:'text', name:'event', text:'PLAYER INTERRUPT: <text>'}` + `{type:'text', name:'snapshot', text: composeSnapshot(...)}`. Then continue the loop.

**Edge case the planner must handle:** AbortController fires *before* the action handler runs (or between handlers in a multi-tool_use turn). Those tool_use blocks still need synthetic results — the catch block walks ALL of them, including ones that never started. D-40 covers this explicitly.

**Edge case for combined-call path:** The combined call may emit personality-only blocks (`say`, `setGoals`, `look`) that already executed before the abort, AND movement blocks that didn't. Each `tool_use` still needs a paired `tool_result`. For executed personality calls, include the actual result string; for unexecuted ones, `aborted: player interrupt`.

### Pattern 3: Atomic write via `writeFile(tmp); rename(tmp, target)`
**What:** Standard Unix atomic-replace. The kernel guarantees `rename(2)` is atomic on the same filesystem — readers either see the old file or the new file, never a partial one.

**Pseudo-shape:**
```
async function atomicWrite(path, contents):
  tmp = path + '.tmp.' + process.pid + '.' + Date.now()
  await fs.writeFile(tmp, contents, 'utf8')   // implicitly fsyncs in many Node versions; explicit fsync optional
  await fs.rename(tmp, path)
```

**Pitfall — fsync expectations:** `fs.writeFile` does NOT fsync by default. On a power-loss / kernel panic, the file may be empty or truncated even after `rename` "succeeded" from the process's view. For v1 single-user bot on a desktop, this is acceptable (CONTEXT/SPEC do not require crash-durability). If the planner wants to be belt-and-suspenders, `await fh.sync()` before `rename` adds a real fsync — but it's a meaningful perf hit and not required by spec.

**Pitfall — Windows atomicity:** `fs.rename` over an existing file on Windows pre-Node-10 was non-atomic and could fail with EEXIST. Node ≥10 uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` and replaces atomically. Project targets modern Node, so this is fine. If a Windows-specific issue surfaces, swap to `fs.copyFile` + `fs.unlink` or use `write-file-atomic`. [VERIFIED: Node fs docs, Node 10+ rename behavior]

**Pitfall — same-filesystem requirement:** `rename` only atomically replaces if `tmp` and `target` are on the same filesystem. Since both live in the project root, this is automatic. If `OWNER.md` ever gets configured to a path on a different mount, atomicity breaks and `EXDEV` errors appear. Plan 3-02 should put `tmp` in the same directory as the target (NOT `os.tmpdir()`).

### Pattern 4: Owner UUID resolution — D-48
**What:** Two paths.

1. **Cold (no OWNER.md):** First time owner-chat fires (`bot.on('chat', (username, message) => ...`) AND `username === config.owner_username`, look up `bot.players[username].uuid` (verified at `node_modules/mineflayer/lib/plugins/entities.js:649` — `bot.players[player.username] = player` where `player.uuid` is set). Write `OWNER.md` atomically with `owner_uuid`, `owner_username`, `first_seen=now`, `last_seen=now`, `total_sessions=1`.

2. **Warm (OWNER.md exists):** Read at boot. On every owner-event, check by UUID: `bot.uuidToUsername[owner_uuid]` returns current display name (verified at `entities.js:650`). If username changed, update `owner_username` field on next session-start.

**Pitfall — `bot.players` is keyed by username, not UUID:** The natural lookup is `bot.players[name]`. To go UUID→player, use `bot.uuidToUsername[uuid]` then `bot.players[<resolved-name>]`. Mineflayer maintains both maps in sync (`entities.js:650` and `entities.js:732,750`).

**Pitfall — D-57 settle delay:** `bot.players` does NOT populate from `bot.on('spawn')`. The player_info packet arrives separately, typically within a few server ticks (50ms each). Empirically ~500ms is safe; 100ms is borderline. Recommend 500ms default with a config override for slow connections. Symptom of too-short delay: session-start fires but `bot.players[owner_username]` is `undefined` → silent miss. Mitigation: if owner not present after settle, attach a one-shot `bot.on('playerJoined')` listener that fires the session-start handler when the owner does appear (handles "owner connects ~1s after Sei").

### Anti-Patterns to Avoid
- **Mutating `Loop.messages` during trimming.** D-43 explicitly forbids: messages must stay canonical. The trimmer returns a fresh array. Test by asserting `Loop.messages` is byte-identical before and after `buildAnthropicPayload()`.
- **Putting OWNER/DIARY content in the cached system prefix.** They are session-mutable; would invalidate the cache on every owner update. CONTEXT line 162 explicitly: "OWNER.md / DIARY.md slice goes in the seed *user turn*, not the system prefix."
- **Adding history to the movement (Qwen) layer.** SPEC line 83 + Phase 2 D-04. Qwen stays stateless; history is personality-only. The compaction call also runs against Haiku, not Qwen.
- **Using `os.tmpdir()` for the atomic-write tmp file.** Cross-filesystem rename ≠ atomic; breaks on `EXDEV`. Tmp must live in the same directory as target.
- **Calling `setTimeout(..., compactionDelay)` and treating it as compaction trigger.** MEM-02 / D-55 — wall-clock timers are explicitly forbidden as compaction triggers. Trigger must be at semantic boundary (loop-terminal or session-terminal).
- **Forgetting to pair every `tool_use` with a `tool_result`.** SDK enforces this — a missing pair returns `400` with "messages: tool_use ids found in `assistant` turn that don't have matching tool_result blocks in the user turn that follows." This is the single most common bug in agentic loops; D-40 + the `appendToolResults` invariant are the structural defense.
- **Touching `src/fsm.js`.** ADR #3 + D-39. Any plan that proposes FSM edits is a planning-error red flag; bounce back to discussion.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file replace | Custom write-then-fsync-then-rename with retries and fallback | `fs.writeFile(tmp); fs.rename(tmp, target)` | Kernel rename(2) is already atomic on same FS. Don't reinvent. |
| YAML frontmatter parser (v1) | Heavy regex pyramid for nested structures | Simple `^([a-z_]+):\s*(.*)$` line-by-line regex | v1 fields are flat (D-47). No nesting needed. Add `yaml` package only if v2 frontmatter grows. |
| Tool_use/tool_result pairing | Manual tracking outside Loop | Make `appendAssistant` + `appendToolResults` enforce the invariant. `appendToolResults(results, ...)` should assert that the prior assistant turn contained tool_use blocks and that `results.length === tool_use.length` AND each `tool_use_id` is matched. | One assertion in one place catches the bug-class structurally. |
| Session-counter persistence across crashes | Periodic checkpoint of in-memory counters to disk | Accept the v1 trade-off (D-58: crash = session boundary). | CONTEXT explicitly defers to V2. Building it now adds I/O complexity and a corruption surface for a v1 cosmetic property. |
| DIARY.md tokenizer-based trim | `tiktoken` / `@anthropic-ai/tokenizer` | Byte-budget walk per D-50 | Within ~10% for plain markdown. Adds a native dep for marginal benefit. |
| Snapshot-block stripping logic in two places (two-call AND combined-call) | Copy-paste the trim in each call site | Both go through `Loop.buildAnthropicPayload()` (D-44) | One trim seam = invariant cannot be bypassed. Direct corollary of D-44. |
| Owner UUID lookup helper | Custom `findOwnerEntity()` walker | `bot.players[config.owner_username]?.uuid` + `bot.uuidToUsername[uuid]` | mineflayer already maintains both maps. |

**Key insight:** This phase has unusually little novel infrastructure. The work is plumbing well-defined seams (Loop class, atomic-write helper, session-state module, two compaction prompts) into existing factored modules. Resist the urge to add dependencies.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | None — Phase 3 is the *introduction* of stored data (`OWNER.md`, `DIARY.md`). No prior runtime state exists to migrate. | None. Plan 3-02 creates the files; backwards-compat is "if file missing, treat as fresh install" (SPEC constraint A6 / line 91). |
| **Live service config** | None — no external services (no Datadog, n8n, Tailscale, etc. in this project). | None. |
| **OS-registered state** | None — Sei runs as a Node child process under Electron utilityProcess; no Task Scheduler / launchd / systemd registration of phase-3-renamed strings. | None. |
| **Secrets and env vars** | `ANTHROPIC_API_KEY` env var is referenced in `src/config.js:44`. Phase 3 adds NO new secrets or env vars. | None. |
| **Build artifacts / installed packages** | No native modules added. (`better-sqlite3` would have triggered `@electron/rebuild` per CLAUDE.md; this phase explicitly skips SQLite.) | None. The phase is pure JS. |

**Verified by:** Phase 3 introduces persistence rather than renaming/refactoring it. The carry-forward concern is whether the *vocabulary* shift (D-39 "session"→"loop", D-51 cadence change) leaves stale strings in code or docs. Searching the source tree:

- `src/llm/orchestrator.js` uses "dispatch", "chain", "hop" — none collide with new vocabulary.
- SPEC.md and ROADMAP.md use "session" loosely; CONTEXT line 40 flags four pieces of SPEC prose for the planner to rewrite (req 5, A5, A7, req 6). ROADMAP success criteria for Phase 3 may also need a vocabulary pass — recommend planner check.

## Common Pitfalls

### Pitfall 1: `name` field on text blocks is not in Anthropic's schema
**What goes wrong:** Sending `{type:'text', text:'...', name:'snapshot'}` directly to `sdk.messages.create` either gets the field silently ignored (current behavior) or, in some future SDK strict-mode, returns a 400. The `name` field is a CONTEXT D-42 client-side annotation; it must NOT cross the SDK boundary.
**Why it happens:** D-42 names blocks for trimming clarity ("self-documenting"). Easy to forget that "self-documenting" only applies to *our* code.
**How to avoid:** `Loop.buildAnthropicPayload()` is the single seam (D-44). It MUST strip `name` (and any other client-side annotations) from every block before returning. Add an assertion in unit tests: deep-walk the returned payload, assert no text block contains a `name` field. Verified shape at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:887-895` — `TextBlockParam` accepts only `{type, text, cache_control?, citations?}`.
**Warning signs:** Loop runs without errors but with cache misses (extra fields might invalidate the prefix-cache key on some implementations); strange schema-validation 400s during a future SDK upgrade.

### Pitfall 2: `bot.players` is empty for ~few-hundred-ms after `bot.on('spawn')`
**What goes wrong:** D-57 session-start handler fires on `spawn`, checks `bot.players[owner_username]`, sees `undefined`, decides owner is offline, never opens a session. Diary stops getting written.
**Why it happens:** The `player_info` packet arrives separately from spawn; the player table populates a few server ticks later. Empirically ~50–500ms.
**How to avoid:** Settle delay (D-57 recommends ~500ms). Belt-and-suspenders: also attach a one-shot `bot.once('playerJoined', ...)` listener after spawn that fires the session-start handler if owner appears within a grace window (e.g., 30s). This handles "owner connects after Sei boots" naturally.
**Warning signs:** First session after every reboot is missed; `total_sessions` increments slowly relative to actual play sessions.

### Pitfall 3: Mid-flight Anthropic abort leaves orphan `tool_use` blocks
**What goes wrong:** Owner sends chat while Sei is mid-loop. FSM aborts; `signal.aborted === true`; the in-flight Anthropic call rejects with `AbortError`. The last assistant turn (already committed to `Loop.messages`) contains `tool_use` blocks. Next iteration sends to Anthropic — 400 error: "tool_use ids without matching tool_result."
**Why it happens:** Anthropic's invariant is strict: every assistant `tool_use` MUST be paired by a `tool_result` in the immediately-following user turn.
**How to avoid:** D-40 — orchestrator's catch block synthesizes `aborted` tool_results for every unmatched `tool_use` BEFORE appending the `PLAYER INTERRUPT:` user turn. Edge case: the abort fires *during* Anthropic streaming, before the assistant turn is fully received — in this case, no orphan tool_use exists (the assistant turn never landed in `Loop.messages`); just append the interrupt user turn.
**Warning signs:** Cryptic 400 errors in the orchestrator log: `messages.{n}.content: tool_use ids found in 'assistant' turn that don't have matching tool_result blocks`. This is the canonical symptom.

### Pitfall 4: Cache invalidation from OWNER.md / DIARY.md updates
**What goes wrong:** OWNER.md gets pasted into the cached system prefix; every session-start updates `last_seen` and `total_sessions`; cache invalidates; cost balloons.
**Why it happens:** Anthropic prompt caching keys on byte-equality of the cached prefix.
**How to avoid:** OWNER.md and DIARY.md slices live in the **seed user turn** (D-45 / CONTEXT line 162), AFTER the cache breakpoint. The cached prefix in `anthropicClient.buildCachedSystem()` already ends at the tools block (`anthropicClient.js:71`); nothing memory-related goes above it. Verify in Plan 3-02: any change to where OWNER goes that puts it in `cachedSystemBlocks` is a regression.
**Warning signs:** `usage.cache_read_input_tokens` drops to zero; `usage.cache_creation_input_tokens` keeps growing each call.

### Pitfall 5: Loop.messages grows unboundedly across iterations
**What goes wrong:** Long task (60+ iterations of dig→dig→dig) accumulates massive history. Even with snapshot trimming, the tool_result content + assistant text grows linearly. Cost spirals, and the 20-iteration cap may not engage if the LLM keeps progressing.
**Why it happens:** D-43 keeps full history canonical for debugging.
**How to avoid:** The 20-iteration cap (D-59 `iteration_cap=20`, replaces Phase 2 LLM-04 hop cap) is the structural bound. The graceful termination per A9 / SPEC line 105 is: at iteration 20, force the next call to be a final `say`-only response (e.g., omit tools or pass a system override "wrap up with one say"). Plan 3-01 must define this graceful-cap behavior — *not* an exception throw.
**Warning signs:** Cost-per-loop drift; loops that "feel stuck" but technically progressing.

### Pitfall 6: Concurrent Loops despite single-flight invariant
**What goes wrong:** A second `sei:dispatch` arrives while a Loop is still active (e.g., FSM bug, race in event delivery). Two Loops run in parallel, both writing to DIARY.md, counters double-increment.
**Why it happens:** SPEC constraint "single-flight session" (line 89) is enforced by orchestrator gating; FSM does NOT enforce it (FSM only knows about actions, not Loops).
**How to avoid:** Orchestrator holds `let currentLoop = null`. On `sei:dispatch`: if `currentLoop` exists AND event is owner-chat → interrupt path (D-40, append to existing Loop). If `currentLoop` exists AND event is anything else (idle tick, world event) → drop (FSM's priority queue should already prevent this, but defense-in-depth). If `currentLoop` is null → start a new Loop. Assert at start of every dispatch handler.
**Warning signs:** DIARY entries with overlapping timestamps; `total_sessions` increments out of sync with logon events; messages arrays containing interleaved dispatches.

### Pitfall 7: Consolidation collides with active write
**What goes wrong:** Consolidation runs async (D-53) and rewrites DIARY.md. A per-loop-batch write fires during the consolidation read→LLM-call→write window. The rewrite clobbers the new entry, or vice versa.
**Why it happens:** Two writers, no coordination.
**How to avoid:** Either (a) make consolidation read+write under a simple in-process `let consolidationLock = false` mutex (per-loop-batch waits if locked, OR drops with a logged warning — bot keeps moving), OR (b) sequence: per-loop-batch ALWAYS appends, then consolidation reads, computes, and atomically replaces — but the consolidation window is "read snapshot at T0; LLM call returns at T1; if file mtime > T0, retry consolidation with new snapshot, else write." Recommend (a) — simpler, deterministic. Loss of one diary entry is acceptable (the next batch gets it).
**Warning signs:** Diary entries disappear after consolidation runs; `## Earlier (consolidated through ...)` block contains data from after the consolidation timestamp.

## Code Examples

> Verified shapes from installed dependencies. The planner consumes these as reference for plan-level interface design — not as task code.

### Anthropic multi-block user turn with tool_result + text mix
```javascript
// Source: @anthropic-ai/sdk@0.91.1, ContentBlockParam union (messages.d.ts:439)
// Verified: ToolResultBlockParam shape at messages.d.ts:1187-1196
// Verified: TextBlockParam shape at messages.d.ts:887-895
//
// User turn for iteration N (post tool_use response):
{
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'dug oak_log' },
    { type: 'tool_result', tool_use_id: 'toolu_def', content: 'dug oak_log' },
    { type: 'text', text: '<event content>' },           // was {name:'event', text:...} in Loop.messages
    { type: 'text', text: '<fresh snapshot content>' },  // was {name:'snapshot', text:...} in Loop.messages
  ]
}
//
// Older user turn (after trim by buildAnthropicPayload):
{
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'looked' },
    { type: 'text', text: '<event content>' },
    // snapshot block STRIPPED (this is not the most recent user turn)
  ]
}
```

### Synthetic aborted tool_results (D-40)
```javascript
// On abort, walk the assistant turn that just landed:
// assistantTurn.content = [{type:'tool_use', id:'toolu_a', name:'dig', ...}, {type:'tool_use', id:'toolu_b', ...}]
//
// Synthesize:
const abortedResults = assistantTurn.content
  .filter(b => b.type === 'tool_use')
  .map(u => ({ type: 'tool_result', tool_use_id: u.id, content: 'aborted: player interrupt', is_error: false }))

// Then append a user turn with these results + the interrupt event + fresh snapshot:
loop.appendUserTurn([
  ...abortedResults,
  { type: 'text', name: 'event', text: `PLAYER INTERRUPT: ${chatText}` },
  { type: 'text', name: 'snapshot', text: composeSnapshot(bot, ...) },
])
```

### Atomic write idiom (Plan 3-02 helper)
```javascript
// Source: Node fs/promises (built-in). Standard Unix atomic-replace pattern.
// Tmp file MUST live in same directory as target (same filesystem) to avoid EXDEV.
import { writeFile, rename } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

export async function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}.${Date.now()}`)
  await writeFile(tmp, contents, 'utf8')
  await rename(tmp, path)
}
```

### Owner UUID resolution (D-48 cold path)
```javascript
// Source: mineflayer entities plugin (verified at node_modules/mineflayer/lib/plugins/entities.js:649-650)
// bot.players[username] = {username, uuid, ping, gamemode, entity}
// bot.uuidToUsername[uuid] = username

// Cold (no OWNER.md): on first owner chat
const player = bot.players[config.owner_username]
const uuid = player?.uuid
// uuid undefined → owner not connected (or settle delay not yet elapsed)
// uuid present → write OWNER.md atomically
```

### mineflayer player events (verified)
```javascript
// Source: node_modules/mineflayer/lib/plugins/entities.js:661 (playerJoined),
//         entities.js:733,752 (playerLeft, two emit sites)
//
// Both events fire with the same player object shape (uuid, username, ping, gamemode, entity).
bot.on('playerJoined', (player) => {
  if (player.uuid !== ownerUuid && player.username !== config.owner_username) return
  // session-start
})
bot.on('playerLeft', (player) => {
  if (player.uuid !== ownerUuid) return
  // session-end
})
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-call stateless `messages: [{role:'user', content:string}]` (Phase 2.1) | Active-loop `messages: ContentBlockParam[]` accumulating across iterations | Phase 3 (this phase) | Anthropic charges for accumulated input tokens; cached prefix mitigates the system-prompt cost; new cost is the linear growth of the user/assistant turn array. Iteration cap (20) bounds it. |
| 5-hop cap per chain (Phase 2 LLM-04) | 20-iteration cap per Loop (D-59) | This phase | Loops are longer-lived than chains. Old hop cap was for runaway recursion across FSM completions; new iteration cap is for runaway tool-use cycles within one Loop. They're semantically distinct; D-59 retires LLM-04 by replacing it. |
| `setHandles()` snapshot-handle table refreshed every personality call | UNCHANGED — still refreshed every call | (Phase 2.1 D-25) | The handles live in a per-snapshot module-level map (`src/observers/targeting.js`); since every iteration's `buildAnthropicPayload` includes a fresh snapshot, handles refresh exactly when expected. No change needed. |
| Idle = 10s timer fires `sei:idle` regardless of state | Idle = 10s timer fires only if `currentLoop === null` | This phase, D-39 | A2 acceptance criterion: "10s idle probe NEVER fires while session active." Implementation: orchestrator checks `currentLoop` before responding to `sei:idle` event. FSM still queues the event; orchestrator decides whether to act. |

**Deprecated/outdated:**
- Phase 2 hop cap (`config.llm.max_hops`, default 5): logically retired by D-59's `iteration_cap`. Plan 3-01 should keep `max_hops` config key for backwards compatibility but route the loop's iteration tracking through the new `iteration_cap` value. The `chains` tracker (`src/llm/chains.js`) may be vestigial after Plan 3-01 — check whether it's still needed or can be removed; defer the call to the planner.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | macOS+Linux `fs.rename` of an existing file is atomic on the same filesystem | Pattern 3 (atomic write) | LOW — POSIX-guaranteed. If wrong, file corruption on power loss. Mitigation: add `await fh.sync()` before rename. [VERIFIED via Node fs docs general pattern; not re-verified this session] |
| A2 | Windows `fs.rename` over an existing file with Node ≥10 is atomic | Pattern 3 | LOW — Node uses `MoveFileEx + MOVEFILE_REPLACE_EXISTING`. If wrong on edge-case Windows configs, Plan 3-02 needs a Windows-specific fallback. [ASSUMED based on Node 10+ release notes; not re-verified this session] |
| A3 | `bot.players` populates within ~500ms after `bot.on('spawn')` | Pitfall 2 | MEDIUM — empirical. Slow connections may need >500ms. Mitigation: belt-and-suspenders one-shot `playerJoined` listener (see Pitfall 2). [ASSUMED based on prior project experience and mineflayer architecture; not benchmarked] |
| A4 | Sending `name` field on a text block to Anthropic SDK 0.91.1 silently ignores it (does not error) | Pitfall 1 | LOW current / MEDIUM future — SDK validators are typically permissive on extra fields. If wrong NOW, the loop never works at all (loud failure, easy to debug). If wrong FUTURE on a strict-mode upgrade, regression hits. Mitigation = strip the field structurally in `buildAnthropicPayload`. [ASSUMED based on current SDK schema validation norms; not tested live] |
| A5 | The `chains` tracker in `src/llm/chains.js` is rendered vestigial by Plan 3-01 | State of the Art (Deprecated) | LOW — even if kept, it's harmless. Plan 3-01 can defer the deletion. [ASSUMED — did not read `chains.js` this session] |
| A6 | `usage.cache_creation_input_tokens` reports correctly when OWNER/DIARY land in user turns (not system) | Pitfall 4 | LOW — Anthropic prompt caching is documented as system-prefix-only by default; the user-turn placement avoids invalidation by design. [ASSUMED — verified architecturally, not via a test request] |
| A7 | Per-loop-batch concatenated `Loop.messages` will fit in a single Haiku call's context window for the compaction prompt (D-52) | Don't Hand-Roll / Pattern 1 | LOW — at 32KB cumulative cap (D-59) and Haiku's 200K context, there's >6× headroom. If wrong (e.g., very tool-heavy loops blow the budget), the planner can chunk by loop. [ASSUMED based on Haiku 4.5 200K window; not benchmarked against representative Loop content] |

**If this table looks long:** It's representative — the architecture is locked, but several runtime properties (settle delay, fs atomicity edge cases, SDK extra-field tolerance) cannot be verified without execution and are accepted as v1 risk per CONTEXT's bias toward "ship the simple thing, defer hardening."

## Open Questions

1. **Should `chains.js` (Phase 2 chain tracker) be deleted or kept as a no-op shim during Plan 3-01?**
   - What we know: D-59 retires the 5-hop cap in favor of the 20-iteration cap. The chain tracker also handles container-session cleanup on chain end (`orchestrator.js:267`).
   - What's unclear: Whether other code (FSM completion re-entries, container behaviors) still depends on `_chainId` plumbing.
   - Recommendation: Plan 3-01 keeps the import as a no-op (replace `chains.begin/continue/increment/end` with stubs that don't gate anything) and lets a follow-up cleanup task remove the file. Do NOT block Plan 3-01 on the deletion.

2. **Should the Loop's per-iteration budget include a hard byte-cap on `Loop.messages` independent of the 20-iteration cap?**
   - What we know: 20 iterations bounds count; cumulative-bytes (D-51) bounds the *compaction* trigger, not the Loop's own size.
   - What's unclear: A pathological 20-iteration Loop with very large tool_result content (e.g., a chest-listing dump) could individually exceed the 32KB compaction trigger AND a sane Anthropic-call payload size.
   - Recommendation: Add an internal sanity assert (e.g., warn-log if a single Loop's serialized messages > 100KB). Don't block on it; revisit if pressure appears in V2.

3. **What happens to `OWNER.md` / `DIARY.md` if the bot starts before owner has *ever* connected?**
   - What we know: SPEC A6 / line 91: "fresh install MUST start cleanly with empty memory; seed message contains placeholder text like `(no prior history yet)`."
   - What's unclear: Whether `OWNER.md` is created at all before owner connects, or only on first owner interaction.
   - Recommendation: Don't create files until first owner-chat (or first session-start with owner present). The seed-loader treats absent files as empty. Aligns with D-48 cold path. Avoids spurious empty files cluttering the project.

4. **Does the 60s chain TTL in `chains.js` interact with long Loops?**
   - What we know: `orchestrator.js:417` references "Chain TTL (60s) sweeps if no continuation arrives."
   - What's unclear: A Loop spanning more than 60s of bot-time may be inside a chain that the tracker has reaped.
   - Recommendation: Tied to Open Question 1. If chains.js is no-op'd, the TTL becomes irrelevant. The Loop's lifecycle is owned by `currentLoop`, not chain TTL.

5. **For the consolidation prompt (D-54), should the "older half" be by entry count or by byte size?**
   - What we know: D-54 says "split into recent half (most recent N entries) and older half".
   - What's unclear: N is described as count-based, but D-53 trigger is partly size-based (200KB).
   - Recommendation: Plan 3-03 picks one and documents it. Recommend "split at 50% of file bytes from top" — preserves more recent detail when entries vary in length. This is at planner's discretion.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `@anthropic-ai/sdk` | Plan 3-01, 3-03 | ✓ | 0.91.1 (verified at `node_modules/@anthropic-ai/sdk/package.json`) | — |
| `mineflayer` | Plan 3-02 (player events, bot.players) | ✓ | ^4.23.0 | — |
| `zod` | Plan 3-02 (config schema extension) | ✓ | ^3.22.4 | — |
| Node `fs/promises` | Plan 3-02 (atomic writes) | ✓ | Built-in | — |
| Node `path` | Plan 3-02 | ✓ | Built-in | — |
| Anthropic API key | Plans 3-01, 3-03 (compaction calls hit the API) | ✓ | env `ANTHROPIC_API_KEY` per `src/config.js:44` | — |
| Real Haiku for dev iteration | All plans (D-19 — no mock LLM) | ✓ | `claude-haiku-4-5-20251001` per D-20 | None — D-19 explicitly chose budget-Haiku over mock. Token spend accepted. |
| Test framework | Phase has no `nyquist_validation` config requiring it; project skips formal tests per Phase 2 D-19 (manual + real LLM) | ✓ via `npm run verify:phase2` exists (`package.json` `scripts.verify:phase2`) | — | Manual verification harness extension; see §Validation Architecture below. |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None.

## Validation Architecture

> `nyquist_validation` is not explicitly set to false in `.planning/config.json`; treating as enabled, but acknowledging Phase 2 D-19 ("no mock LLM") and that the project's test posture is "manual harness + budget Haiku."

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None formal — project uses manual scripted verifications under `scripts/verify-phase*.js` (precedent: `scripts/verify-phase2.js` per `package.json:scripts.verify:phase2`) |
| Config file | None — plain Node scripts |
| Quick run command | `node scripts/verify-phase3-loop.js` (planner creates per-plan harness) |
| Full suite command | `node scripts/verify-phase3.js` (planner creates phase-level wrapper) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MEM-01 / SPEC A1 | Loop.messages contains paired tool_use/tool_result blocks across iterations | unit (in-memory Loop driving against a stub `anthropic.call` returning canned tool_uses) | `node scripts/verify-phase3-loop.js --case=tool-pairing` | ❌ Wave 0 — Plan 3-01 creates harness |
| SPEC A2 | 10s idle never fires while session active | integration (run real bot against test server, drive a chat, log idle dispatches; assert zero during active) | manual + log assertion | ❌ Wave 0 |
| SPEC A3 / D-40 | Chat mid-action aborts session, preserves messages, appends `PLAYER INTERRUPT:` | unit (in-memory Loop + mock FSM signal) | `node scripts/verify-phase3-loop.js --case=interrupt` | ❌ Wave 0 |
| MEM-03 / SPEC A4 | OWNER.md gets owner_uuid; survives username change | integration (stub `bot.players` map + atomic-write fixture) | `node scripts/verify-phase3-memory.js --case=owner-uuid` | ❌ Wave 0 — Plan 3-02 creates |
| MEM-04 / SPEC A5 (overridden by D-51) | DIARY.md grows per loop-batch; consolidation fires per D-53 | integration (stub Anthropic compaction call returning canned summary; assert file state after N loops) | `node scripts/verify-phase3-memory.js --case=diary-growth` | ❌ Wave 0 — Plan 3-03 creates |
| MEM-02 / SPEC A7 | Across many idle ticks, zero diary writes; only loop-batch terminals trigger | integration (synthesize idle events; assert zero file mutation) | `node scripts/verify-phase3-memory.js --case=idle-no-write` | ❌ Wave 0 |
| SPEC A6 | Fresh install with no memory files boots cleanly with placeholder text | unit (call seed-loader with non-existent paths, assert placeholder string present) | `node scripts/verify-phase3-memory.js --case=fresh-install` | ❌ Wave 0 |
| SPEC A8 | Seed user turn visibly contains OWNER + DIARY slice under headings | unit (build a Loop with seeded files, inspect the seed user turn's content blocks) | `node scripts/verify-phase3-loop.js --case=seed-content` | ❌ Wave 0 |
| SPEC A9 | 20-iteration cap → graceful final `say`, no infinite loop | unit (stub `anthropic.call` to keep returning tool_uses; assert termination at 20 with a `say`) | `node scripts/verify-phase3-loop.js --case=cap-graceful` | ❌ Wave 0 |
| SPEC A10 | Combined-call path uses Loop.messages | unit (with `circuit.isOpen() === true`, drive a Loop, assert messages array used) | `node scripts/verify-phase3-loop.js --case=combined-path` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `node scripts/verify-phase3-loop.js` (Plan 3-01 commits) or relevant memory subset
- **Per wave merge:** `node scripts/verify-phase3.js` (full suite)
- **Phase gate:** Full suite green + manual real-Haiku end-to-end run before `/gsd-verify-work 3`

### Wave 0 Gaps
- [ ] `scripts/verify-phase3-loop.js` — Plan 3-01 wave-0 task (loop semantics, interrupt, cap)
- [ ] `scripts/verify-phase3-memory.js` — Plan 3-02 wave-0 task (OWNER/DIARY round-trip, fresh install, owner UUID)
- [ ] `scripts/verify-phase3.js` — phase-level wrapper invoking both above
- [ ] In-memory `anthropic.call` stub (test-only) — used by tool-pairing, interrupt, cap-graceful, combined-path cases (does NOT violate D-19 — D-19 forbids a *production* mock, allows test stubs at the SDK boundary for deterministic harness runs)
- [ ] `fs` fixture helper — write/read OWNER.md, DIARY.md to a temp directory under `os.tmpdir()/sei-test-<pid>/` then atomic-write into it (mimicking real path); assert file contents

## Security Domain

> `security_enforcement` is not set in config; defaulting to enabled per researcher protocol. Phase 3 has minimal security surface — listing applicable categories.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Owner identity is in-game UUID, not a credential. Anthropic API key is already managed by Phase 2 (`src/config.js`); no new auth surface. |
| V3 Session Management | partial | "Session" here is a Minecraft play session, not an HTTP session. Single-user local bot — no session token / cookie / TLS surface. |
| V4 Access Control | partial | Owner UUID gates which player can drive Sei (already enforced by `config.owner_username` matching in chat handlers; D-48 hardens to UUID). No multi-user authz. |
| V5 Input Validation | yes | (a) Chat input from the owner is passed verbatim to Haiku — already covered by the personality LLM's own input handling (Phase 2). (b) `OWNER.md` / `DIARY.md` are user-readable files that may be hand-edited; the seed-loader MUST tolerate malformed YAML / missing fields without throwing (SPEC line 82: "schema migrations or backwards compatibility... markdown is forgiving; v1 reads what's there and ignores fields it doesn't understand"). |
| V6 Cryptography | no | "Encrypting memory files at rest" is explicitly out of scope (SPEC line 80). OS-level disk encryption is sufficient. No hand-rolled crypto in this phase. |

### Known Threat Patterns for Sei (Phase 3 surface)
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal in `memory.owner_md_path` / `diary_md_path` (a hostile config could point at `../../etc/passwd`) | Tampering | Single-user local bot writing to user's own filesystem; the user controls config. Low risk. Plan 3-02 should resolve paths via `path.resolve(cwd, configured)` to normalize, log the resolved path at startup, and refuse paths outside a configurable root if Phase 4 GUI lets the user enter them at runtime. v1 trusts `config.json`. |
| OWNER.md / DIARY.md as arbitrary-content injection into LLM prompt | Tampering / Information disclosure | Files are user-readable and user-editable by design (CONTEXT specifically chose markdown for human-editability). The owner is the only writer. Risk surface is "owner edits OWNER.md to instruct Sei to do X" — but the owner can already chat to do that. No new threat. |
| Race-condition file corruption between per-loop-batch write and consolidation | Tampering / Availability | Pattern 3 atomic writes + Pitfall 7 mutex / sequencing. |
| Replay of stale OWNER.md after manual revert | Tampering | Out of scope — single-user. |

## Sources

### Primary (HIGH confidence)
- Installed `@anthropic-ai/sdk@0.91.1` types — `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`
  - `TextBlockParam`: line 887-895 (no `name` field)
  - `ToolResultBlockParam`: line 1187-1196
  - `ContentBlockParam` union: line 439
- Installed `mineflayer@^4.23.0` source — `node_modules/mineflayer/lib/plugins/entities.js`
  - `playerJoined` emit: line 661, 702
  - `playerLeft` emit: line 733, 752
  - `bot.players[username] = player` assignment: line 649
  - `bot.uuidToUsername[uuid] = username` reverse map: line 650, 680
  - Player object shape (`{username, uuid, ping, gamemode, entity}`): line 676-684
- Repo source files read this session: `src/llm/orchestrator.js`, `src/llm/anthropicClient.js`, `src/llm/persona.js`, `src/llm/inflight.js`, `src/llm/circuit.js`, `src/llm/debounce.js`, `src/observers/snapshot.js`, `src/fsm.js`, `src/bot.js`, `src/config.js`, `package.json`
- Phase artifacts read: `03-CONTEXT.md`, `03-SPEC.md`, `02-CONTEXT.md`, `2.1-CONTEXT.md`, `REQUIREMENTS.md`, `STATE.md`, `CLAUDE.md`

### Secondary (MEDIUM confidence)
- Atomic file replace via `fs.rename` on POSIX is standard Node practice (general knowledge; not re-verified against current Node docs this session).
- mineflayer `bot.players` settle-delay (~500ms after spawn) is empirical norm from prior project experience; not benchmarked against this server config.

### Tertiary (LOW confidence)
- Specific edge-case behavior of `fs.rename` on Windows under Electron's bundled Node may differ from system Node; out-of-scope for v1 since Plan 3-02's atomic-write helper is straightforward to swap to `write-file-atomic` if a Windows issue surfaces.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified installed package versions in `node_modules/`
- Architecture: HIGH — locked by 03-CONTEXT.md (D-38 to D-59); research confirmed nothing in the design contradicts SDK or mineflayer reality
- SDK invariants (tool_use/tool_result, multi-block content): HIGH — verified against installed SDK type definitions
- Mineflayer event semantics: HIGH — verified against installed mineflayer source
- Pitfalls (especially: `name` field stripping, settle delay, abort tool_result repair, cache invalidation): HIGH — derived from verified sources
- Atomic-write pattern: MEDIUM — standard idiom but Windows edge cases assumed not benchmarked
- Validation/test architecture: MEDIUM — project's "no mock LLM" stance (D-19) makes formal unit testing of compaction prompts impractical; recommendations bias toward stub-at-SDK-boundary for deterministic loop tests, manual real-Haiku for prompt quality

**Research date:** 2026-04-30
**Valid until:** 2026-05-30 (30 days; SDK 0.91.x is stable; mineflayer 4.x is stable; revalidate if either bumps a major)
