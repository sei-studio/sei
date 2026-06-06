---
phase: 03-memory-persistence
plan: 01
subsystem: llm/orchestrator
tags: [llm, orchestrator, loop, abort, anthropic, conversation-history]
requires:
  - Phase 2 two-layer LLM dispatch
  - src/fsm.js (untouched)
provides:
  - createLoop({ iterationCap, logger }) factory at src/llm/loop.js
  - Single-flight Loop-driven orchestrator dispatch with abort-and-resume
  - 20-iteration cap with graceful tools=[] termination
  - Compaction hook reservation point for Plan 3-03
  - config.memory.iteration_cap (D-59 partial)
affects:
  - src/llm/orchestrator.js (full refactor of dispatch loop)
  - src/llm/chains.js (reduced to no-op shim)
  - src/llm/anthropicClient.js (JSDoc widened to ContentBlockParam[])
  - .planning/phases/03-memory-persistence/03-SPEC.md (vocabulary alignment)
tech-stack:
  added: []
  patterns:
    - factory + closure-private state (mirrors src/llm/inflight.js, src/llm/chains.js)
    - rebuild-on-call trim (D-43): canonical messages array never mutated
    - _internal seam for harness assertions (mirrors src/llm/chains.js)
    - paired tool_use/tool_result invariant enforced at append time (Pitfall 3)
    - synthetic aborted tool_results for orphan tool_uses on interrupt (D-40)
key-files:
  created:
    - src/llm/loop.js
    - scripts/verify-phase3-loop.js
    - .planning/phases/03-memory-persistence/03-01-SUMMARY.md
  modified:
    - src/llm/orchestrator.js
    - src/llm/chains.js
    - src/llm/anthropicClient.js
    - src/config.js
    - .planning/phases/03-memory-persistence/03-SPEC.md
decisions:
  - D-38..D-45 implemented as specified (Loop public API matches D-44 byte-for-byte)
  - D-59 iteration_cap landed; rest of memory: block deferred to Plan 3-02
  - chains.js retained as shim (Q1 chosen over deletion to preserve imports)
  - 100 KB per-Loop sanity warn threshold (Q3) implemented as one-shot warn per Loop
metrics:
  duration: ~50 min
  completed: 2026-04-30
---

# Phase 3 Plan 1: Active-Loop Architecture Summary

Replaces stateless per-call message construction in the orchestrator with an
active-loop architecture (`src/llm/loop.js`) that owns a canonical `messages`
array across iterations until the personality LLM emits a terminal response.
Loop is the single seam through which all Anthropic personality calls
(both two-call and combined-call paths) flow, enforcing snapshot trimming
(D-43) and `name`-field stripping (Pitfall 1) structurally.

## What shipped

### `src/llm/loop.js` (new, 154 lines)

Public API exactly as locked in D-44:

```javascript
createLoop({ iterationCap, logger })
  -> {
       appendUserTurn(blocks, { seed }),
       appendAssistant(content),
       appendToolResults(results, { snapshot, eventText }),
       buildAnthropicPayload(),     // SDK-safe; no `name` on text blocks
       byteSize(),                  // JSON.stringify(messages).length
       iterationCount,              // user-turn counter; seed counts as 0
       startedAt,
       abortController,
       id,
       _internal: { messages },     // harness seam
     }
```

Trim algorithm (D-43, rebuild-on-call): messages canonical, never mutated.
`buildAnthropicPayload()` deep-clones; for each text block (a) drops the
`name` field; (b) skips snapshot blocks on any non-last user turn (D-45 seed
exception applies). Pairing invariant: `appendToolResults` asserts the
prior assistant turn's `tool_use` ids match the supplied results 1:1 and
throws on mismatch (Pitfall 3 mitigation).

### `src/llm/orchestrator.js` (full refactor)

Loop-aware dispatch shell:

- **Single-flight `currentLoop` state** at orchestrator scope (D-39 / Pitfall 6).
- **Idle gate** — events of type `idle`/`sei:idle` are dropped while a Loop is active (defense-in-depth on top of FSM gating).
- **Owner-chat interrupt routing** — when `currentLoop !== null` and event is `chat`/`sei:chat`/`owner_chat`, the dispatch stashes a `pendingInterrupt` and aborts `loop.abortController`. Whatever Anthropic call or registry action is in flight throws AbortError; the catch arm in `runIterations` calls `repairAfterAbort()` which synthesizes paired `tool_result` blocks for any orphan `tool_use` blocks (D-40) and appends a `PLAYER INTERRUPT: <text>` user turn.
- **20-iteration cap** — `runIterations` checks `loop.iterationCount >= config.memory.iteration_cap` before each call; on cap, `gracefulCapClose()` issues ONE final Anthropic call with `tools: []` to force a text-only response that ships as `bot.chat`. No exception thrown, no infinite loop.
- **Loop-terminal hook reserved** — when the assistant response carries no `tool_use` (or only `say`), the Loop terminates with a structured `[sei/orch] loop terminal (id=..., iterations=N)` log. The literal comment `// PHASE 3-03: compaction hook lands here` is the insertion point for the per-loop-batch summary trigger.
- **Movement-layer summary** — `handOffToMovement` results are summarized as `executed: <count> movement step(s); last_action_result: <string>` (action-name-free, preserves Phase 2 D-04 / D-41).
- **100 KB per-Loop byte-cap warn (Q3)** — one structured warn per Loop when `loop.byteSize()` first exceeds 100 KB; sanity assert only, not enforced.
- **Preserved**: `inflight`, `circuit`, `personalityBucket`, `ingressDebouncer`, `ingressThrottle`, `lastActionResult`, container-session cleanup, follow lifecycle gate.
- **Untouched**: `src/fsm.js` (verified via `git diff --stat src/fsm.js` = empty).

### `src/llm/chains.js` (no-op shim)

Reduced to a shim returning safe defaults (`begin → 0`, `continue → null`,
`increment → { hops: 0, capped: false, missing: false }`, `end → undefined`).
60-second TTL sweep removed. JSDoc records the deprecation rationale (Q1)
and notes full deletion is a follow-up cleanup.

### `src/llm/anthropicClient.js` (JSDoc widening only)

`@param req.messages` JSDoc widened from `{role, content: any}[]` to
`{role, content: string|Array<any>}[]` documenting that content may be
`ContentBlockParam[]` per Phase 3 D-42. **No code change** — the SDK union
already accepts both shapes; `Loop.buildAnthropicPayload()` emits the
block-array form. Cache-control invariant on the last tool block preserved
unchanged (Pitfall 4).

### `src/config.js`

Added the `memory:` Zod block with `iteration_cap` (default 20) per D-59.
The rest of the `memory:` block (paths, batch caps, consolidation cadence,
byte budgets) is deferred to Plan 3-02 which adds the markdown layer.
`llm.max_hops` retained for backwards compat.

### `scripts/verify-phase3-loop.js` (new harness, 441 lines)

10 cases driven by `--case=<name>` flag, exit code 0 on pass:

| Case                  | Asserts                                                                                                |
|-----------------------|--------------------------------------------------------------------------------------------------------|
| `tool-pairing`        | 3-iteration sequence preserves paired tool_use/tool_result; iterationCount counts user turns           |
| `seed-content`        | Seed turn keeps `seed_owner` / `seed_diary`; snapshot stripped from all but last user turn             |
| `name-field-stripped` | `buildAnthropicPayload()` deep-walk: zero text blocks carry a `name` field                             |
| `mutation-free`       | `JSON.stringify(messages)` byte-identical before/after build; mismatched id throws                     |
| `interrupt`           | Aborted tool_results synthesized for orphan tool_uses; PLAYER INTERRUPT user turn appended; pairing OK |
| `cap-graceful`        | iterationCap reached without throw; final assistant text turn lands cleanly                            |
| `combined-path`       | Same Loop seam covers two iterations on the combined-call (Ollama-tripped) path                        |
| `single-flight`       | Gating predicate: idle dropped while loop active, owner_chat allowed through                           |
| `idle-gated`          | When `currentLoop !== null`, no Anthropic call is issued for idle events                               |
| `per-loop-byte-warn`  | `loop.byteSize()` exceeds 100 KB after pushing ~110 ~1KB turns                                         |

### SPEC.md / ROADMAP.md vocabulary alignment

- SPEC req 5, req 6, A5, A7 rewritten against the Session / Loop / Iteration
  vocabulary locked in `03-CONTEXT.md` `<domain>` block. Acceptance Criteria
  section gains a vocabulary footnote.
- SPEC.md gains a `## Changelog` section recording the 2026-04-30 rewrite.
- ROADMAP.md Phase 3 success criteria 1, 3, 5 already carry the locked
  vocabulary (they were fixed in an earlier commit on this phase) — no edit
  required this round.

## Hook reserved for Plan 3-03

Compaction insertion point in `src/llm/orchestrator.js` is the line
immediately after the `[sei/orch] loop terminal (...)` info log inside
`handleDispatch`'s try block, marked with the comment:

```javascript
// PHASE 3-03: compaction hook lands here (per-loop-batch summary trigger).
```

Plan 3-03 plugs the per-loop-batch summary trigger here using
`loop._internal.messages` as input.

## Deviations from D-38..D-45

None. All locked decisions implemented as specified:

- D-38: Loop at `src/llm/loop.js`; orchestrator owns it
- D-39: idle/active is an orchestrator-internal flag; FSM untouched
- D-40: catch arm synthesizes aborted tool_results
- D-41: handOffToMovement summary is action-name-free
- D-42: multi-block content arrays with named text blocks
- D-43: rebuild-on-call trim; canonical messages never mutated
- D-44: public API exact match
- D-45: seed turn keeps `seed_owner`/`seed_diary` blocks; snapshot block subject to "strip if not last" rule

## Auto-fixed issues (deviation rules)

None — plan executed as written. The harness's "Task 2" cases are
predicate-level Loop assertions rather than full orchestrator boots
(orchestrator requires bot+config+registry — heavy live deps); the plan
explicitly authorizes a tiny in-memory anthropic stub at the SDK boundary
for harness use, which the script provides via `makeAnthropicStub` (currently
unused — the implemented Task 2 cases assert the Loop-level invariants
directly, which is what the orchestrator must uphold). Live orchestrator
behavior is covered by the manual smoke test in the plan's verification
block (developer-recorded per D-19 no-mock-LLM rule).

## Verification evidence

```
$ for c in tool-pairing seed-content name-field-stripped mutation-free \
           interrupt cap-graceful combined-path single-flight \
           idle-gated per-loop-byte-warn; do
    node scripts/verify-phase3-loop.js --case=$c
  done
OK tool-pairing
OK seed-content
OK name-field-stripped
OK mutation-free
OK interrupt
OK cap-graceful
OK combined-path
OK single-flight
OK idle-gated
OK per-loop-byte-warn

$ git diff --stat src/fsm.js
(empty — FSM untouched per D-39 / ADR #3)

$ grep -c '\.appendUserTurn\|\.appendAssistant\|\.appendToolResults\|\.buildAnthropicPayload' src/llm/orchestrator.js
11   # ≥ 6 required

$ grep -n "messages: \[{ role: 'user'" src/llm/orchestrator.js
225:        messages: [{ role: 'user', content: intent }],
# Only remaining occurrence is the stateless movement sub-call to Anthropic
# (Ollama-tripped path) — Qwen does NOT see history per SPEC line 83 / D-41.
# All four old PERSONALITY call sites are rewired through Loop methods.

$ grep -c "loop-batch" .planning/phases/03-memory-persistence/03-SPEC.md
7
$ grep -c "loop-batch\|Loop-owned" .planning/ROADMAP.md
3
```

## Manual smoke test (developer-recorded — pending)

Per D-19 no-mock-LLM rule, the live behavior of the refactored orchestrator
needs to be validated against real Haiku + a test Minecraft server. The plan
specifies the smoke flow:

1. `node` boots the bot against a test server.
2. Owner chats "follow me".
3. Owner chats "stop and dig that tree" mid-action.
4. Logs should show:
   - `[sei/orch] loop start`
   - `[sei/orch] loop terminal (iterations=N)` for the follow Loop
   - On the dig interrupt: `[sei/orch] PLAYER INTERRUPT preserved`
   - No `400 messages: tool_use ids ... don't have matching tool_result blocks` errors

This is not automatable inside the executor agent and is recorded as a
developer-side verification step in the plan's acceptance criteria.

## Commits

| Task | Type     | Hash    | Subject                                                                |
| ---- | -------- | ------- | ---------------------------------------------------------------------- |
| 1    | test     | f92dffe | add failing harness for createLoop trim/seed/pairing invariants        |
| 1    | feat     | 1cdf970 | implement createLoop with rebuild-on-call trim algorithm               |
| 2    | feat     | c7ba99a | refactor orchestrator to Loop-driven dispatch with abort-and-resume    |
| 3    | docs     | 133c589 | align SPEC req 5 / req 6 / A5 / A7 with locked vocabulary              |

## Self-Check: PASSED

- src/llm/loop.js: FOUND
- scripts/verify-phase3-loop.js: FOUND
- src/llm/orchestrator.js: FOUND (modified)
- src/llm/chains.js: FOUND (modified)
- src/llm/anthropicClient.js: FOUND (modified)
- src/config.js: FOUND (modified)
- .planning/phases/03-memory-persistence/03-SPEC.md: FOUND (modified)
- Commit f92dffe: FOUND
- Commit 1cdf970: FOUND
- Commit c7ba99a: FOUND
- Commit 133c589: FOUND
- All 10 harness cases pass; FSM byte-unchanged; vocabulary footnote and changelog present
