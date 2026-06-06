---
phase: 260505-iqo
plan: 01
type: quick
quick_id: 260505-iqo
completed: 2026-05-05
commits:
  - ce9e69f
  - c36f34b
  - 28f439e
files_created:
  - src/llm/convoMemory.js
files_deleted:
  - src/llm/ollamaClient.js
  - src/llm/circuit.js
  - src/llm/chatRingBuffer.js
files_modified:
  - src/llm/orchestrator.js
  - src/llm/schemaBridge.js
  - src/log.js
  - src/config.js
  - src/cli/index.js
  - src/bot.js
  - src/fsm.js
  - scripts/verify-phase2.js
  - scripts/verify-phase2_1.js
  - scripts/verify-phase3-loop.js
  - scripts/verify-phase3-memory.js
  - package.json
  - CLAUDE.md
  - .planning/STATE.md
---

# Quick Task 260505-iqo: memory and loop architecture refactor

Five coordinated changes from the wood.txt session analysis landed as three
atomic dependency-ordered commits. The bot now runs a single Anthropic call
per iteration (no Ollama, no circuit breaker, no two-layer hand-off), keeps a
split owner/self chat memory plus a 20-loop activity timeline, and ticks a
distinct `sei:loop_end` event after every real-activity loop so the model can
decide a follow-up sub-goal instead of waiting 60s for the idle fallback.

## Commits

| Commit  | Subject |
|---------|---------|
| ce9e69f | refactor(260505-iqo): collapse two-layer LLM to API-only single combined call |
| c36f34b | feat(260505-iqo): convoMemory split-buffer + loopHistory + say/think separation |
| 28f439e | feat(260505-iqo): split idle from loop-end events; per-event seed prompts |

## What changed, by task

### Task 1 — API-only refactor (ce9e69f)

- Deleted `src/llm/ollamaClient.js` and `src/llm/circuit.js`.
- `src/llm/orchestrator.js`: dropped `createOllamaClient`,
  `createOllamaCircuit`, `MOVEMENT_SYSTEM`, the two-call personality system
  prompt, `callPersonalityTwoCall`, `callPersonalityCombined`, `callMovement`,
  `probeOllamaWithRetry`, the `handOffToMovement` tool definition, the
  `handoffCall` branch in `runIterations`, the `extractPriorTask` handoff
  branch, the chat-mode guidance constants (`DEV_CHAT_GUIDANCE`,
  `PROD_CHAT_GUIDANCE`, `chatModeGuidance`), the dual cached-system-blocks
  build (`cachedCombinedSystemBlocks`), and `executorStatus` / circuit /
  Ollama internals from the public + `_internal` exports. Renamed
  `COMBINED_SYSTEM` → `SYSTEM_INSTRUCTIONS` and folded the prod chat-mode
  rules (≤15 words, frequent `say`, no narration) directly into it.
  `start()` is preserved as a no-op so `bot.js` wiring stays unchanged.
- `src/config.js`: dropped the entire `ollama` schema block and the
  `llm.executor` field.
- `config.json`: dropped the `ollama` block and `llm.executor`.
- `src/cli/index.js`: dropped the `ollama` default in `DEFAULT_CONFIG`.
- `src/bot.js`: replaced `Sei online. Executor: ${...}` with `Sei online.`
- `src/log.js`: dropped `logOllamaQuery` / `logOllamaResponse` and updated
  the file header.
- `src/llm/schemaBridge.js`: dropped `buildOllamaTools`.
- `package.json`: dropped the `ollama` dependency.
- `scripts/verify-phase2.js`: dropped the `ollama.model` assertion, the
  `executorStatus` assertion, and the post-probe executor log.
- `scripts/verify-phase2_1.js`: rewrote the LIVE-mode adversarial harness
  for single-layer combined tools — `say` + `setGoals` + a sample `goTo`
  movement tool. Decline detection now flags any movement-registry call as
  the "tried to do it" signal instead of looking for a `handOffToMovement`
  tool that no longer exists.
- `scripts/verify-phase3-loop.js`: removed Ollama references from the
  `combined-path` case docstrings.
- `scripts/verify-phase3-memory.js`: dropped the `ollama` field and the
  `executor: 'api'` field from the test config; consolidated the dual
  cached-blocks scan into a single `getCachedSystemBlocks` walk.
- `CLAUDE.md`: rewrote project tagline (single-layer combined Haiku);
  updated key architecture decisions #1 and #2; replaced the two-layer
  runaway pitfall with iteration-cap framing for single-layer.
- `.planning/STATE.md`: replaced two-layer/Ollama lines with single-layer
  decisions and added the API-only landing entry.

### Task 2 — convoMemory + say/think separation (c36f34b)

- New `src/llm/convoMemory.js` exporting `createConvoMemory()`:
  - `recentChat.pushOwner(who, text)` / `pushSelf(who, text)` push into
    capacity-10 sub-buffers with 240-char per-line truncation.
  - `recentChat.formatOwnerBlock()` and `formatSelfBlock()` return seed-block
    text (or `null` when empty). The self block carries an explicit "do NOT
    repeat" guard.
  - `loopHistory.push({ loopId, startedAt, endedAt, event, loopMessages })`
    synthesizes a 1-line title from the loop's first `say()` line + the
    most-frequent non-personality tool name, plus a mutation summary
    extracted from the latest snapshot's `recent_events:` line. Capacity 20.
    No extra API call.
  - `loopHistory.formatBlock()` returns the timeline as a single block.
- Deleted `src/llm/chatRingBuffer.js`.
- `src/llm/orchestrator.js`:
  - Replaced the import + the `chatBuffer = createChatRingBuffer({...})`
    construction with `convoMemory = createConvoMemory()`.
  - `composeSeedBlocks` signature changed: `recentChatText` →
    `recentLoopHistoryText` + `recentOwnerChatText` + `yourRecentMessagesText`.
    Block ordering: `seed_owner` → `seed_diary` (cache_control ephemeral) →
    `recent_loop_history?` → `recent_owner_chat?` → `your_recent_messages?`
    → `event` → `snapshot`. Each `recent_*` block is omitted when its
    formatter returns `null`.
  - `say()` tool handler is now the SOLE site that calls `bot.chat()` AND
    the SOLE site that pushes self lines into convoMemory.
  - Terminal text-only responses log at `debug` only (`[sei/orch] terminal
    text (private, not relayed): …`) and never reach chat or memory.
  - Mid-loop assistant text alongside tool_uses logs at `debug` only when
    the model didn't also call `say`.
  - `SYSTEM_INSTRUCTIONS` carries the explicit "communicate via `say` only;
    `text` is private scratch" rule.
  - `handleDispatch` finally block pushes a completed-loop summary into
    `convoMemory.loopHistory` before clearing `currentLoop`.
  - `recordIncomingChat` now routes through `convoMemory.recentChat.pushOwner`.
  - Cap-close path (the `tools=[]` forced-terminal say) now pushes the
    cap-line into convoMemory so the cross-loop timeline stays coherent.
  - Added `convoMemory` getter to `_internal` for verifier access.
- `src/config.js`: dropped the entire `chat: z.object({ mode: ... })`
  schema and the dev/prod-mode comment block.
- `src/cli/index.js`: dropped the `chat: { mode: 'prod' }` default config
  field, dropped the chat-mode interactive picker from onboarding, and
  added a `delete cfg.chat` line to strip the legacy field if a previous
  onboarding wrote it.

### Task 3 — idle/loop-end split (28f439e)

- `src/fsm.js`:
  - Added `Priority.P2_5_LOOP_END = 2.5` (between movement and idle).
  - Added a `bot.on('sei:loop_terminal', …)` listener that resets the idle
    timer and enqueues `sei:loop_end` UNLESS the just-finished loop was
    itself triggered by `sei:loop_end` (daisy-chain suppression).
  - Removed `resetIdleTimer()` from inside `processNext`. Added it to
    `enqueue()` so any event ingestion postpones the 60s fallback. The
    `loop_terminal` listener also resets it. Net: the idle timer always
    counts from the latest activity, never from a stale dequeue.
  - Added a `case 'sei:loop_end'` no-op in `handleEvent` for symmetry — the
    real handling rides on `sei:dispatch`.
- `src/llm/orchestrator.js`:
  - `handleDispatch`'s `finally` block emits
    `bot.emit('sei:loop_terminal', { loopId, originatingEvent: event })`
    after the convoMemory push and before `currentLoop = null`, so the
    enqueued `sei:loop_end` runs through the normal queue → processNext →
    `sei:dispatch` path AFTER the single-flight gate clears.
  - Per-event seed-text addendum: `sei:loop_end` nudges "decide a follow-up
    sub-goal, do not re-ask, do not ask the owner what to do — pick
    something yourself"; `sei:idle` reframes "you are a peer, pick
    something, asking the owner is a last resort, never repeat a question".
    Other events keep the unchanged `Event: … Data: …` body.
  - `SYSTEM_INSTRUCTIONS` opens with peer framing ("you are a peer to the
    owner — pick things to do, decide what is interesting, propose plans;
    reacting to chat and world events is part of the job; waiting passively
    for instructions is not"), replacing the old "you react to chat, world
    events, and idle ticks".
- `.planning/STATE.md`: appended the idle/loop-end decision and the
  Quick Tasks Completed row for 260505-iqo with commit hash 28f439e.

## Cleanliness Verification

The user explicitly demanded zero dead code, no `// removed` comments, no
`_unused` renames, no backwards-compat shims for removed config keys, and a
final tree-wide grep sweep across `src/` for the listed symbols. Sweep
results:

| Symbol | `src/` matches | `scripts/` matches | Notes |
|--------|---------------|-------------------|-------|
| `ollama` / `Ollama` / `OLLAMA` | 0 | 0 | All references purged. |
| `handOffToMovement` | 0 | 0 | Tool definition + branches gone. |
| `callMovement` / `callPersonalityCombined` / `callPersonalityTwoCall` | 0 | 0 | Replaced by single `callPersonality`. |
| `DEV_CHAT_GUIDANCE` / `PROD_CHAT_GUIDANCE` / `chatModeGuidance` | 0 | 0 | Folded into `SYSTEM_INSTRUCTIONS`. |
| `MOVEMENT_SYSTEM` / `COMBINED_SYSTEM` | 0 | 0 | Renamed `COMBINED_SYSTEM` → `SYSTEM_INSTRUCTIONS` (single seam). |
| `chatBuffer` (legacy variable) | 0 | 0 | Replaced by `convoMemory`. |
| `chatRingBuffer` (file or import) | 0 | 0 | File deleted. |
| `executor: 'api'` / `config.llm.executor` / `ollama.host` / `ollama.model` | 0 | 0 | Schema field removed; verify scripts updated. |
| `executorStatus` | 0 | 0 | Public + `_internal` exports gone; bot.js log line replaced. |
| `PERSONALITY_NAMES` | 2 (orchestrator.js:51, :565) | 0 | Kept intentionally — used to classify movement vs personality-only tool calls in single-layer dispatch (decides whether the loop continues or terminates). Not a carve-out leftover; carries semantics for the new architecture. |

**File deletions:** `src/llm/ollamaClient.js`, `src/llm/circuit.js`,
`src/llm/chatRingBuffer.js` — all gone.

**File creations:** `src/llm/convoMemory.js`.

**Comment hygiene:** No `// removed`, `// deleted`, or `_unused` markers
introduced. All commit-hash labels in code comments use the standard
`260505-iqo:` prefix only where they document the new architectural
decision (peer framing, per-event addendum, P2_5_LOOP_END constant), not
historical removals.

## Architectural invariants preserved

- **Three-process Electron seam:** unchanged. The orchestrator and
  `convoMemory` still run in the utilityProcess that owns mineflayer +
  Anthropic. CLAUDE.md updated to call out single-layer LLM (the count
  changed from "LLMs" to "LLM").
- **Closed Zod-typed action registry:** unchanged. The combined call
  invokes registry tools directly via `buildAnthropicTools(subRegistry, …)`.
- **Event-sourced FSM with priority queue:** extended with P2.5 between
  movement and idle. P0 chat preempt rule unchanged.
- **LLM-directed memory compaction:** unchanged. `sessionState.onLoopTerminal`
  is still called from `handleDispatch`'s try block with the originating
  event, gating diary writes to idle-driven loops.
- **Every external call has a timeout:** unchanged. Anthropic calls still
  pass `timeoutMs: config.anthropic.timeout_ms`. Pathfinder timeouts in the
  registry are untouched. The Ollama timeout no longer applies (no
  Ollama).
- **Iteration-cap runaway guard:** unchanged at default 20 (config.memory.iteration_cap).
  CLAUDE.md pitfalls list updated to reflect this is the new runaway gate.

## Verification performed

- `node --check` syntax-validated every modified `.js` file across all
  three commits.
- `node -e "import('./src/llm/orchestrator.js')…"` confirmed the orchestrator
  module loads and `createOrchestrator` is a function after each task.
- `node -e "import('./src/llm/convoMemory.js')…"` exercised
  `pushOwner` / `pushSelf` / `loopHistory.push` / all three
  `formatBlock` paths and asserted the owner-block contains the speaker
  name, the self-block carries the "Do NOT repeat" guard, and the
  loop-history block contains the synthesized first-say title plus the
  tool-frequency tag.
- `node -e "ConfigSchema.safeParse(config.json + api_key)"` confirmed the
  schema rejects `ollama` and `executor` (they're stripped by Zod since
  the schema no longer permits them).
- FSM smoke test simulated `sei:loop_terminal` from both `sei:idle` and
  `sei:loop_end` origins — listener wired without throwing; the
  daisy-chain suppression branch returns early on the second emit.
- Tree-wide grep sweep across `src/`, `scripts/`, and `CLAUDE.md` for the
  full list of forbidden symbols returned zero matches except the
  intentional `PERSONALITY_NAMES` retention noted above.

## Open follow-ups

- **package-lock.json** still references the `ollama` package in its
  resolved-tree section. It will rewrite on the next `npm install`. Not
  in this commit set because regenerating without running `npm install`
  is fragile, and the runtime no longer imports `ollama` so the listing
  is harmless metadata.
- **Live in-game smoke test** (manual, not automatable in this harness):
  - On connect, observe `[sei] Sei online.` (no executor mention).
  - First loop runs at `sei:joined` priority; on terminal,
    `sei:loop_terminal` fires → FSM enqueues `sei:loop_end` at P2.5
    → orchestrator dispatches a fresh loop with the loop_end addendum.
  - `[chat->]` lines come ONLY from `say` tool calls; no relayed
    text fallbacks.
  - Idle fallback fires 60s after the LAST event ingestion or loop
    terminal, not 60s from process start.

## Self-Check: PASSED

Commits exist:

- `ce9e69f` — `git log --oneline | grep ce9e69f` ✔
- `c36f34b` — `git log --oneline | grep c36f34b` ✔
- `28f439e` — `git log --oneline | grep 28f439e` ✔

Files created:

- `src/llm/convoMemory.js` — present ✔

Files deleted:

- `src/llm/ollamaClient.js` — gone ✔
- `src/llm/circuit.js` — gone ✔
- `src/llm/chatRingBuffer.js` — gone ✔
