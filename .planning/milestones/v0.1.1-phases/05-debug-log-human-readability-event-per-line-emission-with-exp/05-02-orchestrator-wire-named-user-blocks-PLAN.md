---
phase: 05-debug-log-human-readability-event-per-line-emission-with-exp
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/bot/brain/orchestrator.js
autonomous: true
requirements: []
must_haves:
  truths:
    - "Every anthropic.call({...}) invocation from the orchestrator passes a `namedUserBlocks` field carrying the canonical pre-strip user-content array (with `name` fields preserved on text blocks)."
    - "The Anthropic API payload — what is actually sent to sdk.messages.create — is byte-identical to the pre-Phase-5 behavior."
  artifacts:
    - path: "src/bot/brain/orchestrator.js"
      provides: "namedUserBlocks plumbing into both anthropic.call sites — the main personality call (around L1432) and the cap-close call (around L1385)."
      contains: "namedUserBlocks:"
  key_links:
    - from: "src/bot/brain/orchestrator.js callPersonality + cap-close call"
      to: "src/bot/brain/anthropicClient.js call() namedUserBlocks param"
      via: "loop._internal.messages or equivalent pre-strip messages snapshot"
      pattern: "namedUserBlocks:\\s*loop\\._internal\\.messages"
---

<objective>
Wire `src/bot/brain/orchestrator.js` to pass the canonical (pre-`buildAnthropicPayload`) messages array — which preserves `name` fields on text blocks — to `anthropic.call(...)` as a new optional `namedUserBlocks` field. This lets `logHaikuQuery` (Plan 05-01 Task 2) hash the `seed_diary` block by its raw text. Zero changes to the actual Anthropic API request shape.

Purpose: Plan 05-01 added the optional `namedUserBlocks` parameter and a `raw:` fallback for when it's absent. This plan removes the fallback path by feeding the named blocks in from the orchestrator's two `anthropic.call` sites.
Output: Both `anthropic.call({...})` invocations include `namedUserBlocks: loop._internal.messages`.
</objective>

<execution_context>
@/Users/ouen/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ouen/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-CONTEXT.md
@/Users/ouen/slop/sei/.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-01-logger-multiline-emit-and-hash-dictionary-PLAN.md
@/Users/ouen/slop/sei/src/bot/brain/orchestrator.js
@/Users/ouen/slop/sei/src/bot/brain/loop.js
@/Users/ouen/slop/sei/src/bot/brain/anthropicClient.js

<interfaces>
From src/bot/brain/loop.js (existing — DO NOT change):
```js
return {
  appendUserTurn, appendAssistant, appendToolResults,
  buildAnthropicPayload,             // strips `name` from text blocks
  byteSize,
  get iterationCount(),
  get startedAt(),
  get abortController(),
  _setAbortController(c),
  _internal: { messages },           // ← canonical, named-block-preserving (Loop's "harness seam" per L12)
}
```

`loop._internal.messages` is the canonical array. Its user turns' `content` arrays carry text blocks with `name` set (e.g., `{ type:'text', name:'seed_diary', text:'...' }`). This is what we forward to the logger.

From src/bot/brain/anthropicClient.js (post-Plan-05-01 state):
```js
async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024, namedUserBlocks }) { ... }
```

The two existing call sites in orchestrator.js (both pass `messages: loop.buildAnthropicPayload()`):
- L1385–L1394: cap-close call (one-shot graceful wrap-up; tools=[])
- L1432–L1438: callPersonality (the hot path; one call per loop iteration)
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add namedUserBlocks to both anthropic.call sites in orchestrator.js</name>
  <files>src/bot/brain/orchestrator.js</files>
  <read_first>
    - /Users/ouen/slop/sei/src/bot/brain/orchestrator.js lines 1380-1440 (BOTH call sites)
    - /Users/ouen/slop/sei/src/bot/brain/loop.js lines 145-180 (the returned `_internal.messages` seam)
  </read_first>
  <action>
Make exactly two edits to `src/bot/brain/orchestrator.js`:

**Edit A — cap-close call (around line 1385):**

Change from:
```js
const resp = await anthropic.call({
  systemBlocks: cachedSystemBlocks,
  tools: [],
  messages: loop.buildAnthropicPayload(),
  signal: loop.abortController.signal,
  timeoutMs: Math.max(config.anthropic.timeout_ms, 8000),
})
```

To:
```js
const resp = await anthropic.call({
  systemBlocks: cachedSystemBlocks,
  tools: [],
  messages: loop.buildAnthropicPayload(),
  namedUserBlocks: loop._internal.messages,
  signal: loop.abortController.signal,
  timeoutMs: Math.max(config.anthropic.timeout_ms, 8000),
})
```

**Edit B — callPersonality (around line 1432):**

Change from:
```js
return await anthropic.call({
  systemBlocks: cachedSystemBlocks,
  tools: combinedToolsFor(),
  messages: loop.buildAnthropicPayload(),
  signal,
  timeoutMs: config.anthropic.timeout_ms,
})
```

To:
```js
return await anthropic.call({
  systemBlocks: cachedSystemBlocks,
  tools: combinedToolsFor(),
  messages: loop.buildAnthropicPayload(),
  namedUserBlocks: loop._internal.messages,
  signal,
  timeoutMs: config.anthropic.timeout_ms,
})
```

No other lines change. The `messages` field — what is actually sent to the Anthropic API — is identical to today's behavior (still `loop.buildAnthropicPayload()`).

If you discover a `loop` reference that does not expose `_internal.messages` (e.g., a unit-test harness loop), use optional chaining: `namedUserBlocks: loop?._internal?.messages` so production hot paths stay free of runtime guards but any partial mock loop still survives.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei &amp;&amp; node --check src/bot/brain/orchestrator.js &amp;&amp; test "$(grep -c 'namedUserBlocks:' src/bot/brain/orchestrator.js)" = "2" &amp;&amp; test "$(grep -c 'loop\\.buildAnthropicPayload()' src/bot/brain/orchestrator.js)" = "2" &amp;&amp; echo OK</automated>
  </verify>
  <acceptance_criteria>
    - Exactly TWO `namedUserBlocks:` occurrences in src/bot/brain/orchestrator.js (one per `anthropic.call` site).
    - The two `loop.buildAnthropicPayload()` invocations remain (the API payload is unchanged).
    - `node --check src/bot/brain/orchestrator.js` exits 0.
    - `git diff src/bot/brain/orchestrator.js` shows ONLY additions of the `namedUserBlocks:` lines — no other modifications.
  </acceptance_criteria>
  <done>Both call sites forward the canonical named user blocks; the API request body is unchanged.</done>
</task>

</tasks>

<verification>
- The verify command in Task 1 prints `OK`.
- `git diff --stat src/bot/brain/orchestrator.js` reports 2 insertions and 0 deletions (or 2 insertions, 0 deletions plus a trailing-whitespace stub if your formatter normalizes — but no semantic deletions).
</verification>

<success_criteria>
- A live `[haiku?]` event on the SECOND iteration of a loop shows `<diary @sha=...>` instead of inlining the full diary body. (This is the user-visible payoff verified end-to-end in Plan 05-04.)
</success_criteria>

<output>
After completion, create `.planning/phases/05-debug-log-human-readability-event-per-line-emission-with-exp/05-02-SUMMARY.md` noting the two edited line ranges and confirming the API payload is unchanged.
</output>
