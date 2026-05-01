---
phase: 03-memory-persistence
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/llm/loop.js
  - src/llm/orchestrator.js
  - src/llm/chains.js
  - src/llm/anthropicClient.js
  - src/config.js
  - scripts/verify-phase3-loop.js
  - .planning/phases/03-memory-persistence/03-SPEC.md
  - .planning/ROADMAP.md
autonomous: true
requirements: [MEM-01, MEM-02]
tags: [llm, orchestrator, conversation-history, abort, anthropic]

must_haves:
  truths:
    - "A `Loop` factory at src/llm/loop.js owns a canonical `messages` array across iterations until terminal response"
    - "Every Anthropic call inside the loop goes through `loop.buildAnthropicPayload()` so snapshot trimming and `name`-field stripping cannot be bypassed"
    - "Owner chat mid-loop synthesizes `aborted` tool_results for every unmatched tool_use and appends `PLAYER INTERRUPT: ...` as a new user turn — Loop.messages is preserved"
    - "The 10s idle probe never fires while a Loop is active (orchestrator gates on `currentLoop === null`)"
    - "A 20-iteration cap terminates a Loop gracefully with a final `say` rather than throwing"
    - "Both two-call (Ollama-healthy) and combined-call (Ollama-tripped) paths use the same Loop"
    - "`src/fsm.js` is NOT modified by this plan"
    - "SPEC.md req 5 / req 6 / A5 / A7 are rewritten against the new session/loop/iteration vocabulary (per CONTEXT spec_lock line 40)"
  artifacts:
    - path: "src/llm/loop.js"
      provides: "createLoop factory: appendUserTurn, appendAssistant, appendToolResults, buildAnthropicPayload, iterationCount, abortController, seed flag"
      min_lines: 80
    - path: "src/llm/orchestrator.js"
      provides: "Loop-aware dispatch shell with single-flight currentLoop gating, idle gate, abort-and-resume catch block, 20-iteration cap"
      contains: "currentLoop"
    - path: "src/config.js"
      provides: "memory.iteration_cap default 20 (D-59)"
      contains: "iteration_cap"
    - path: "scripts/verify-phase3-loop.js"
      provides: "Harness covering tool-pairing, interrupt, cap-graceful, combined-path, seed-content"
      min_lines: 60
    - path: ".planning/phases/03-memory-persistence/03-SPEC.md"
      provides: "Updated req 5 / req 6 / A5 / A7 wording against session/loop/iteration vocabulary"
      contains: "loop-batch"
  key_links:
    - from: "src/llm/orchestrator.js"
      to: "src/llm/loop.js"
      via: "createLoop() + loop.appendUserTurn / appendAssistant / appendToolResults / buildAnthropicPayload"
      pattern: "buildAnthropicPayload"
    - from: "src/llm/loop.js"
      to: "@anthropic-ai/sdk"
      via: "buildAnthropicPayload returns sanitized ContentBlockParam[] (no `name` field)"
      pattern: "type:\\s*['\"]text['\"]"
---

<objective>
Replace per-call stateless message construction in the orchestrator with an active-loop architecture. Introduce `createLoop()` (`src/llm/loop.js`) that owns the canonical `messages` array across iterations, exposes the locked public API from D-44 (`appendUserTurn`, `appendAssistant`, `appendToolResults`, `buildAnthropicPayload`), and enforces snapshot trimming via rebuild-on-call (D-43). Refactor `src/llm/orchestrator.js` to a thin Loop-aware dispatch shell with single-flight gating, abort-and-resume semantics (D-40), and a 20-iteration cap that gracefully terminates with a `say`.

Purpose: Establish the single seam through which Plans 3-02 (seed loader) and 3-03 (compaction) plug in. The loop refactor lands first as a separate merge per CONTEXT and SPEC.

Output: `src/llm/loop.js`, refactored `src/llm/orchestrator.js`, `chains.js` reduced to a no-op shim (Q1), `config.js` extended with `memory.iteration_cap` (and the rest of the `memory:` block placeholder is deferred to Plan 3-02 — only `iteration_cap` is consumed here), Anthropic client JSDoc widening, SPEC.md vocabulary update, and `scripts/verify-phase3-loop.js`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@CLAUDE.md
@.planning/phases/03-memory-persistence/03-CONTEXT.md
@.planning/phases/03-memory-persistence/03-SPEC.md
@.planning/phases/03-memory-persistence/03-RESEARCH.md
@.planning/phases/03-memory-persistence/03-PATTERNS.md
@.planning/phases/02-two-layer-llm-loop/02-CONTEXT.md
@.planning/phases/2.1-expand-actions-and-game-state/2.1-CONTEXT.md

@src/llm/orchestrator.js
@src/llm/anthropicClient.js
@src/llm/chains.js
@src/llm/inflight.js
@src/llm/goals.js
@src/llm/circuit.js
@src/llm/persona.js
@src/observers/snapshot.js
@src/config.js

<interfaces>
<!-- Locked from CONTEXT D-38, D-42, D-44 + verified against installed @anthropic-ai/sdk@0.91.1 -->

createLoop public API (D-38, D-44):
```typescript
type NamedTextBlock  = { type: 'text', name?: 'snapshot'|'event'|'seed_owner'|'seed_diary'|'tool_result_summary', text: string, cache_control?: any }
type ToolResultBlock = { type: 'tool_result', tool_use_id: string, content: string, is_error?: boolean }
type UserBlock       = NamedTextBlock | ToolResultBlock
type UserTurn        = { role: 'user', content: UserBlock[], seed?: boolean }
type AssistantTurn   = { role: 'assistant', content: any[] }  // tool_use blocks pass through

interface Loop {
  appendUserTurn(blocks: UserBlock[], opts?: { seed?: boolean }): void
  appendAssistant(content: any[]): void
  appendToolResults(results: ToolResultBlock[], opts?: { snapshot?: string, eventText?: string }): void
  buildAnthropicPayload(): { role: 'user'|'assistant', content: any }[]   // SDK-safe (no `name` field)
  readonly iterationCount: number
  readonly startedAt: number
  readonly abortController: AbortController
  readonly _internal: { messages: UserTurn|AssistantTurn[] }   // for harness assertions only
}

function createLoop(opts: { iterationCap: number, logger?: any }): Loop
```

Anthropic SDK ContentBlockParam (verified at node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:439, 887, 1187):
- TextBlockParam:       { type: 'text', text: string, cache_control?, citations? }   // NO `name` field
- ToolResultBlockParam: { type: 'tool_result', tool_use_id: string, content: string|Array, is_error? }
- ToolUseBlockParam:    { type: 'tool_use', id: string, name: string, input: any }

Existing orchestrator call signature (src/llm/orchestrator.js:225-253) — preserve:
```javascript
anthropic.call({ systemBlocks, tools, messages, signal, timeoutMs })
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement createLoop() and the buildAnthropicPayload trim algorithm</name>
  <files>src/llm/loop.js, scripts/verify-phase3-loop.js</files>
  <read_first>
    - src/llm/inflight.js (factory + closure-private state idiom — primary analog per PATTERNS.md)
    - src/llm/chains.js (lifecycle methods + _internal harness seam)
    - src/llm/goals.js (encapsulation + snapshot getter)
    - 03-RESEARCH.md "Pattern 1: Loop.buildAnthropicPayload() — rebuild-on-call trim" (lines 224-250)
    - 03-RESEARCH.md "Pitfall 1: name field on text blocks is not in Anthropic's schema"
    - 03-CONTEXT.md D-38, D-42, D-43, D-44, D-45
  </read_first>
  <behavior>
    - Test: A loop after `appendUserTurn([{type:'text',name:'snapshot',text:'S1'},{type:'text',name:'event',text:'E1'}])` has `_internal.messages.length === 1` and the last user turn carries the snapshot block.
    - Test: After three `appendUserTurn` calls each with a `{name:'snapshot'}` block, `buildAnthropicPayload()` returns three user turns where ONLY the last user turn contains a snapshot text block (older snapshot blocks stripped).
    - Test: `buildAnthropicPayload()` strips the `name` field from every text block in its output (deep-walk asserts no `name` key on any text block).
    - Test: `buildAnthropicPayload()` does NOT mutate `loop._internal.messages` — JSON.stringify before == after.
    - Test: A seed user turn (`appendUserTurn(blocks, { seed: true })`) keeps `seed_owner` / `seed_diary` blocks across all iterations, but its `snapshot` block IS stripped once a newer user turn exists (D-45).
    - Test: `appendToolResults(results)` asserts that the last assistant turn's tool_use ids match `results.map(r => r.tool_use_id)` 1:1; mismatched length or unmatched id throws.
    - Test: `iterationCount` increments by 1 each time a user turn is appended (after the seed turn — seed counts as iteration 0 or 1, document the choice).
  </behavior>
  <action>
    Create `src/llm/loop.js` as a named factory `createLoop({ iterationCap, logger = console })` mirroring `src/llm/inflight.js` factory + closure-private state idiom (PATTERNS.md primary analog).

    Internal state:
    - `messages: Array<UserTurn | AssistantTurn>` — canonical, never mutated by trim
    - `iterationCount: number`
    - `startedAt: number = Date.now()`
    - `abortController: AbortController = new AbortController()`

    Public methods (per D-44, signatures locked):
    - `appendUserTurn(blocks, { seed = false } = {})` — push `{ role:'user', content: blocks, seed }`. Increment iterationCount unless this is the very first call AND `seed === true`.
    - `appendAssistant(content)` — push `{ role:'assistant', content }`. Content is the raw assistant `content` array from Anthropic (tool_use blocks pass through).
    - `appendToolResults(results, { snapshot, eventText } = {})` — assert pairing invariant against the prior assistant turn's tool_use blocks: `results.length === toolUses.length` AND every `tool_use_id` matches; throw a descriptive Error otherwise. Build a user turn whose `content` = `[...results, ...(eventText ? [{type:'text',name:'event',text:eventText}] : []), ...(snapshot ? [{type:'text',name:'snapshot',text:snapshot}] : [])]` and append. Increment iterationCount.
    - `buildAnthropicPayload()` — implement Pattern 1 from RESEARCH.md verbatim:
      1. Walk `messages`; find the last user-turn index (`lastUserIdx`).
      2. For each user turn: build a new `content` array:
         - For `tool_result` blocks: pass through unchanged.
         - For `text` blocks: drop the `name` field; if `name === 'snapshot'` AND this turn is NOT the last user turn, skip it. Seed turns: keep `seed_owner` / `seed_diary` blocks regardless of position; the seed turn's snapshot block IS subject to the same "strip if not last" rule (D-45).
      3. Assistant turns pass through unchanged (their internal `tool_use` blocks are SDK-shaped already).
      4. Return the new array. NEVER mutate `messages` or any nested object — clone defensively.

    Expose `_internal: { messages }` for harness byte-equality assertions (PATTERNS.md: chains.js seam).

    Then implement `scripts/verify-phase3-loop.js`:
    - Argv `--case=<name>` selector.
    - Cases (each is a self-contained sync function calling `createLoop` and asserting):
      - `tool-pairing` — drives a 3-iteration sequence, asserts paired tool_use/tool_result.
      - `interrupt` — placeholder failing case; full logic lands in Task 2 once orchestrator integration exists. For Task 1, this case asserts a Loop with synthesized abort results has the correct shape.
      - `cap-graceful` — placeholder; populated in Task 2.
      - `seed-content` — appends a seed turn with `{name:'seed_owner'}`, `{name:'seed_diary'}`, `{name:'snapshot'}`; appends three more iterations; asserts `buildAnthropicPayload()` keeps `seed_owner` / `seed_diary` on the seed turn and strips snapshot blocks from all but the last user turn.
      - `combined-path` — placeholder for Task 2.
      - `name-field-stripped` — assert no text block in the payload has a `name` field.
      - `mutation-free` — JSON.stringify(messages) before == after `buildAnthropicPayload()`.
    - Exit code 0 on pass, non-zero with diff on fail.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=tool-pairing &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=seed-content &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=name-field-stripped &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=mutation-free</automated>
  </verify>
  <acceptance_criteria>
    - `src/llm/loop.js` exports `createLoop`; no default export.
    - All seven harness cases above pass.
    - No `name` field appears in `buildAnthropicPayload()` output (deep-walk grep test passes).
    - `loop._internal.messages` is byte-identical before and after every `buildAnthropicPayload()` call.
    - `appendToolResults` throws when the prior assistant turn's tool_use ids don't match the results 1:1.
  </acceptance_criteria>
  <done>Loop factory is the single seam for Anthropic message construction; all four trim/seed invariants enforced structurally.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Refactor orchestrator to use Loop, add idle gating, abort-and-resume catch, 20-iteration cap; reduce chains.js to no-op shim; widen anthropicClient JSDoc</name>
  <files>src/llm/orchestrator.js, src/llm/chains.js, src/llm/anthropicClient.js, src/config.js, scripts/verify-phase3-loop.js</files>
  <read_first>
    - src/llm/orchestrator.js (full — current dispatch loop at lines 255-436, the four call-site message constructions at lines ~204, 209, 233, 250, the catch block at lines 419-435)
    - src/llm/anthropicClient.js (lines 17, 23-34, 62-73 — JSDoc + cache_control invariant)
    - src/llm/chains.js (full — what to stub out)
    - src/config.js (lines 14-37 — Zod nested-block pattern)
    - 03-RESEARCH.md "Pattern 2: Synthetic aborted tool_results", "Pitfall 3: Mid-flight Anthropic abort leaves orphan tool_use blocks", "Pitfall 5: Loop.messages grows unboundedly", "Pitfall 6: Concurrent Loops despite single-flight invariant", "Open Question 1" (chains.js fate), "Open Question 3" (per-Loop hard byte cap)
    - 03-CONTEXT.md D-39, D-40, D-41, D-59
    - 03-PATTERNS.md "MODIFIED src/llm/orchestrator.js" section
  </read_first>
  <behavior>
    - Test (`combined-path`): With `circuit.isOpen() === true`, driving a dispatch through a stubbed `anthropic.call` that returns first a tool_use response then a terminal `say`, the orchestrator builds and reuses ONE Loop and calls `anthropic.call` with `loop.buildAnthropicPayload()` both times.
    - Test (`cap-graceful`): A stubbed `anthropic.call` that always returns a tool_use terminates after exactly 20 iterations and the final iteration sends a system override or `tools: []` request to force a `say`-only response (no infinite loop, no thrown exception).
    - Test (`interrupt`): While a Loop is active with one assistant tool_use turn pending, an abort signal is fired. The orchestrator's catch block synthesizes a `tool_result` for every tool_use in the last assistant turn with `content: 'aborted: player interrupt'` and `is_error: false`, then appends a user turn with `[...abortedResults, {type:'text',name:'event',text:'PLAYER INTERRUPT: ...'}, {type:'text',name:'snapshot',text:...}]`. Loop.messages history is preserved (count grows, not resets).
    - Test (`single-flight`): Two near-simultaneous `sei:dispatch` events with `currentLoop !== null` — the second one (if owner-chat) routes through the interrupt path; if it's an idle tick, it's dropped silently with a structured warn log.
    - Test (`idle-gated`): When `currentLoop !== null`, an incoming `sei:idle` event does NOT trigger any Anthropic call.
    - Test (`per-loop-byte-warn`): A Loop whose canonical `messages` exceed 100 KB serialized emits a warn-level structured log (Q3 sanity assert).
  </behavior>
  <action>
    **Refactor `src/llm/orchestrator.js`** preserving the dispatch loop skeleton at lines 255-436. Bind to D-39, D-40, D-41:

    1. **Single-flight Loop state:** at orchestrator scope, `let currentLoop = null`. Wrap dispatch entry: if `currentLoop === null` → start a new Loop via `createLoop({ iterationCap: config.memory.iteration_cap, logger })`. If `currentLoop !== null` AND event is owner-chat → enter interrupt path (D-40). If `currentLoop !== null` AND event is anything else → log warn and drop (defense-in-depth; FSM should already prevent this).

    2. **Idle gate (D-39):** at the top of the idle-tick handler, `if (currentLoop !== null) return` (with a structured debug log per A2).

    3. **Replace the four `messages: [{ role: 'user', content: ... }]` constructions** at lines ~204, 209, 233, 250. Use the locked replacement shape from PATTERNS.md "MODIFIED src/llm/orchestrator.js":
       ```javascript
       loop.appendUserTurn([
         { type: 'text', name: 'snapshot', text: composeSnapshot(...) },
         { type: 'text', name: 'event',    text: `Event: ${event}\nData: ${JSON.stringify(data)}` },
       ])
       const resp = await anthropic.call({
         systemBlocks: cachedSystemBlocks,
         tools: personalityTools,
         messages: loop.buildAnthropicPayload(),
         signal: loop.abortController.signal,
         timeoutMs: config.anthropic.timeout_ms,
       })
       loop.appendAssistant(resp.content)
       // dispatch tool_uses → collect results
       loop.appendToolResults(results, { snapshot: composeSnapshot(...) })
       ```
       Apply this same shape to BOTH the two-call (Ollama-healthy personality call) AND the combined-call paths so `loop.buildAnthropicPayload` is the single seam (D-44 / SPEC A10).

    4. **handOffToMovement synthetic tool_result (D-41):** when the personality emits a `handOffToMovement` tool_use, after dispatching the movement layer, build a synthetic tool_result of the form `{ type: 'tool_result', tool_use_id: handOffUseId, content: 'executed: <action_summary>; last_action_result: <string>', is_error: false }`. The summary string is action-name-free at the personality history layer (preserve Phase 2 D-04: no action names leak into personality reasoning) — e.g., "executed: 3 movement steps; last_action_result: dug oak_log". Movement layer's internal Ollama call stays stateless.

    5. **Abort/synth-tool_result catch (D-40):** on `signal.aborted` or `err.name === 'AbortError'`, BEFORE the next iteration:
       - Locate the last assistant turn in `loop._internal.messages` (or expose a helper `loop.lastAssistant()`).
       - For each `tool_use` block in its content, emit `{ type: 'tool_result', tool_use_id: u.id, content: 'aborted: player interrupt', is_error: false }`.
       - Edge case: if the assistant turn never landed (abort fired during streaming), there are no orphan tool_uses; skip the synthesis step.
       - Edge case (combined-call): for personality-only tool_uses that already executed before the abort (e.g., `say`, `setGoals`), include the actual result string instead of the aborted marker.
       - Append a single user turn: `[...abortedResults, { type:'text', name:'event', text:`PLAYER INTERRUPT: ${chatText}` }, { type:'text', name:'snapshot', text: composeSnapshot(...) }]`.
       - Continue the Loop with the next iteration.

    6. **20-iteration cap graceful termination (Pitfall 5 / SPEC A9):** when `loop.iterationCount >= config.memory.iteration_cap`:
       - Log warn `[sei/orch] iteration cap hit — forcing graceful close`.
       - Make ONE more `anthropic.call` with `tools: []` (forces text-only) and an extra user turn `{ type:'text', name:'event', text:'You have hit the iteration cap. Wrap up with one short say.' }`.
       - Append the assistant response. If it contains a `say` tool_use we cannot honor (since tools=[]), the model returns plain text — surface as a chat line via `bot.chat` directly (route through existing `say` path).
       - Set `currentLoop = null` (loop terminal).

    7. **Per-Loop byte-cap warn (Q3 / Pitfall 5):** after every `appendToolResults`, compute `JSON.stringify(loop._internal.messages).length`. If > 100 KB, emit a structured warn log once per Loop. Do not block; this is a sanity assert, not an enforcement.

    8. **Loop terminal hook:** when the assistant response contains zero `tool_use` blocks (or only a `say`), the Loop ends: log structured `[sei/orch] loop terminal (iterations=N)`, then `currentLoop = null`. **Reserve a hook point** here — `// PHASE 3-03: compaction hook lands here` — Plan 3-03 plugs in.

    9. **Preserve existing infrastructure** (per SPEC line 92): `inflight`, `circuit`, `personalityBucket`, `ingressDebouncer`, `ingressThrottle`, `lastActionResult`, container-session cleanup at lines 268, 293, 332, 390, 394, 399, 423, 428, 433. **Do NOT touch `src/fsm.js`** (D-39, ADR #3).

    **Reduce `src/llm/chains.js` to a no-op shim (Q1):** keep the file and the named exports `createChainTracker`, but the returned object's methods (`begin`, `continue`, `increment`, `end`) become no-ops that return safe defaults (`begin → 0`, `continue → null`, `increment → { hops: 0, capped: false, missing: false }`, `end → undefined`). Add a top-of-file JSDoc: `// Phase 3 D-59: chain tracker retired in favor of per-Loop iteration_cap. Kept as no-op shim during 3-01 to avoid breaking imports; full deletion is a follow-up cleanup.` Remove the 60s TTL sweep (Q4 — irrelevant under Loop ownership).

    **Widen `src/llm/anthropicClient.js` JSDoc** (line 17): `* @param {{role:'user'|'assistant',content:string|Array<any>}[]} req.messages — content may be a ContentBlockParam[] per Phase 3 D-42`. **Do NOT change the call body** — SDK union already accepts both shapes (verified in RESEARCH.md). Preserve the `cache_control` invariant on the last tool block at lines 62-73 — OWNER/DIARY content does NOT enter system blocks (Pitfall 4).

    **Extend `src/config.js`** with `memory.iteration_cap` (the only field consumed by Plan 3-01; the rest of the `memory:` block lands in Plan 3-02):
    ```javascript
    memory: z.object({
      iteration_cap: z.number().int().min(1).default(20),
    }).default({}),
    ```
    Keep `llm.max_hops` for backwards compat but route iteration tracking through `config.memory.iteration_cap` (RESEARCH.md State of the Art line 472).

    **Extend `scripts/verify-phase3-loop.js`** with a tiny in-memory `anthropic.call` stub (RESEARCH.md Wave 0 Gaps — does NOT violate D-19 since it stubs at the SDK boundary for deterministic harness, not in production). Implement the Task 2 cases: `interrupt`, `cap-graceful`, `combined-path`, `single-flight`, `idle-gated`, `per-loop-byte-warn`.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=interrupt &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=cap-graceful &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=combined-path &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=single-flight &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-loop.js --case=idle-gated</automated>
  </verify>
  <acceptance_criteria>
    - All harness cases above pass.
    - `git diff src/fsm.js` is empty (FSM untouched per D-39 / ADR #3).
    - `grep -c '\.appendUserTurn\|\.appendAssistant\|\.appendToolResults\|\.buildAnthropicPayload' src/llm/orchestrator.js` ≥ 6 (the four old call sites all rewired through Loop methods, plus interrupt path and graceful cap).
    - `grep -n "messages: \[{ role: 'user'" src/llm/orchestrator.js | grep -v '^#'` returns no matches (the old per-call message construction is gone).
    - `chains.js` exports `createChainTracker` returning no-op stubs; the file has the deprecation JSDoc.
    - `config.memory.iteration_cap` defaults to 20.
    - Manual sanity boot: `node` starts the bot against a test server, owner chats "follow me", chats "stop and dig that tree", logs show `[state] active→idle`, `[state] idle→active`, no `tool_use ids without matching tool_result` 400s. (Recorded by developer as part of verification; no automated check possible per D-19.)
  </acceptance_criteria>
  <done>Orchestrator dispatch is Loop-driven. Single-flight, idle-gated, abort-resilient, cap-bounded. The compaction hook point is reserved for Plan 3-03.</done>
</task>

<task type="auto">
  <name>Task 3: Update SPEC.md req 5 / req 6 / A5 / A7 against new vocabulary; refresh ROADMAP Phase 3 success criteria</name>
  <files>.planning/phases/03-memory-persistence/03-SPEC.md, .planning/ROADMAP.md</files>
  <read_first>
    - .planning/phases/03-memory-persistence/03-CONTEXT.md (lines 11-16 vocabulary block, line 40 spec_lock callout)
    - .planning/phases/03-memory-persistence/03-SPEC.md (current req 5 / req 6 / A5 / A7 wording at lines 53-61, 101, 103)
    - .planning/ROADMAP.md (Phase 3 success criteria at lines 78-83)
  </read_first>
  <action>
    Rewrite the four flagged pieces of SPEC.md prose against the locked vocabulary (`Session` = owner logon→logoff; `Loop` = one Sei task cycle; `Iteration` = one round-trip within a Loop):

    **Requirement 5 (DIARY.md long-term game progression — MEM-04):** rewrite Target paragraph and Acceptance to reflect the per-loop-batch cadence. Concretely: `DIARY.md` is appended on per-loop-batch terminals (≥10 loops since last DIARY write within the current session OR cumulative `Loop.messages` bytes since last write > `loop_batch_context_cap_bytes`, default 32 KB). Consolidation fires when ≥4 sessions have passed since the last consolidation OR `DIARY.md` > `diary_size_cap_bytes` (default 200 KB). Both run async on the loop-terminal hook (D-51, D-53).

    **Requirement 6 (LLM-directed compaction trigger — MEM-02):** rewrite to: per-loop-batch summary fires only when a Loop reaches its terminal response (no further tool_use, or only `say`) AND the loop-batch trigger is satisfied. Consolidation fires only on session-end (or async during a session if size-cap triggers). The 10-second idle probe never triggers compaction. The cadence (10 loops / 32 KB / 4 sessions) is a runtime gating policy ON TOP OF the semantic boundary, not a wall-clock timer (D-55).

    **Acceptance A5:** rewrite to: "After 3 sessions with ≥10 loops each (or accumulated >32 KB Loop bytes), `DIARY.md` contains ≥3 newest-first entries. After 4 sessions have passed, exactly one consolidation pass has run (size-cap permitting)."

    **Acceptance A7:** rewrite to: "Across a 60-minute test with multiple sessions and many idle ticks, `DIARY.md` is appended only on loop-batch terminals — never on idle ticks, never mid-Loop. Consolidation runs strictly on session-end or size-pressure, never on a wall-clock timer."

    Add a footnote under the Acceptance Criteria heading: "*Vocabulary updated 2026-04-30 per CONTEXT spec_lock — see 03-CONTEXT.md `<domain>` block for definitions of Session / Loop / Iteration.*"

    **ROADMAP.md Phase 3 success criteria (lines 78-83):** revise the five bullets against the new vocabulary. Specifically:
    - Bullet 1 (rolling in-session context): "Recent events and chat accumulate in a `Loop`-owned `messages` array across iterations until the Loop reaches its terminal response."
    - Bullet 3 (LLM-directed compaction): "Per-loop-batch summaries fire on Loop-terminal under a 10-loops-or-32-KB gate; consolidation fires on session-end (or size-pressure async) under a 4-sessions-or-200-KB gate. The 10s idle probe never compacts."
    - Bullet 5: replace "SQLite store" with "Markdown files (OWNER.md + DIARY.md) with atomic tmp+rename writes and a 200 KB soft size cap with consolidation."

    Update SPEC.md "Last updated" footer (if present) and add a one-line changelog entry: `- 2026-04-30: req 5 / req 6 / A5 / A7 / ROADMAP success criteria 1, 3, 5 rewritten against locked vocabulary (Plan 3-01 Task 3).`
  </action>
  <verify>
    <automated>grep -c "loop-batch" /Users/ouen/slop/sei/.planning/phases/03-memory-persistence/03-SPEC.md | grep -v '^0$' &amp;&amp; grep -c "loop-batch\|Loop-owned" /Users/ouen/slop/sei/.planning/ROADMAP.md | grep -v '^0$'</automated>
  </verify>
  <acceptance_criteria>
    - SPEC.md req 5, req 6, A5, A7 all reference loop-batch/session vocabulary; no remaining "1 DIARY entry per active session" prose.
    - ROADMAP.md Phase 3 success criteria 1, 3, 5 use new vocabulary.
    - SPEC.md changelog entry present.
    - Vocabulary footnote added under Acceptance Criteria.
  </acceptance_criteria>
  <done>SPEC.md and ROADMAP.md are aligned with the locked Session / Loop / Iteration vocabulary. Plans 3-02 and 3-03 reference an internally consistent SPEC.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Anthropic SDK ↔ Loop.buildAnthropicPayload | Client-side `name` annotations must NOT cross this boundary (Pitfall 1) |
| FSM abort signal ↔ orchestrator catch | Aborts can fire before, during, or after assistant streaming — orphan tool_uses must be repaired (Pitfall 3) |
| Owner chat ingress ↔ currentLoop state | Single-flight invariant must hold under concurrent `sei:dispatch` events (Pitfall 6) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-01 | Tampering | Loop.messages canonical array | mitigate | `buildAnthropicPayload` returns a fresh array; harness asserts byte-identical messages before/after (`mutation-free` case) |
| T-03-02 | Denial of Service | Iteration runaway | mitigate | 20-iteration cap + graceful `say` termination (Pitfall 5 / SPEC A9); per-Loop 100 KB warn (Q3) |
| T-03-03 | Tampering | Anthropic invariant violation (orphan tool_use) | mitigate | `appendToolResults` enforces 1:1 pairing assertion; abort-catch synthesizes results (D-40) |
| T-03-04 | Information disclosure | `name` field leaked to SDK | mitigate | `buildAnthropicPayload` strips `name`; harness asserts absence (Pitfall 1) |
| T-03-05 | Repudiation | Concurrent Loops | mitigate | `currentLoop !== null` gate at orchestrator scope; non-owner-chat events dropped with warn |
| T-03-06 | Spoofing | (N/A — single-user local bot) | accept | No multi-user surface this phase |
</threat_model>

<verification>
- All harness cases in `scripts/verify-phase3-loop.js` pass.
- `git diff src/fsm.js` is empty.
- Manual smoke test: run the bot, owner chats normally, owner interrupts a dig — observe in logs:
  - `[sei/orch] loop start`, `[sei/orch] iteration N`, `[sei/orch] PLAYER INTERRUPT preserved`, `[sei/orch] loop terminal (iterations=N)`.
  - No `400 messages: tool_use ids ... don't have matching tool_result blocks` errors.
- `grep -n "loop-batch" .planning/phases/03-memory-persistence/03-SPEC.md` matches.
</verification>

<success_criteria>
- `src/llm/loop.js` exports `createLoop` with the D-44 public API.
- Orchestrator uses Loop for both two-call and combined-call paths.
- 10s idle probe gated on `currentLoop === null` (A2).
- Owner-chat interrupt synthesizes aborted tool_results and appends `PLAYER INTERRUPT:` user turn (A3, D-40).
- 20-iteration cap terminates gracefully with a `say` (A9).
- `chains.js` is a no-op shim with deprecation JSDoc (Q1).
- SPEC.md req 5 / req 6 / A5 / A7 and ROADMAP Phase 3 success criteria 1, 3, 5 use the locked vocabulary.
- `src/fsm.js` is byte-unchanged.
</success_criteria>

<output>
After completion, create `.planning/phases/03-memory-persistence/03-01-SUMMARY.md` documenting:
- Loop public API as shipped
- Any deviations from D-38..D-45 (expected: none)
- chains.js status (no-op shim)
- SPEC.md / ROADMAP.md vocabulary updates
- Manual smoke-test result (recorded by developer)
- Hook reserved for Plan 3-03 (location in orchestrator.js)
</output>
