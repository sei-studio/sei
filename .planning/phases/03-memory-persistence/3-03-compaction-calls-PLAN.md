---
phase: 03-memory-persistence
plan: 03
type: execute
wave: 3
depends_on: ["3-01", "3-02"]
files_modified:
  - src/llm/compaction.js
  - src/llm/sessionState.js
  - src/llm/orchestrator.js
  - src/bot.js
  - scripts/verify-phase3-memory.js
  - scripts/verify-phase3.js
autonomous: true
requirements: [MEM-02, MEM-04]
tags: [llm, compaction, anthropic, memory, async]

must_haves:
  truths:
    - "Per-loop-batch summary fires on Loop-terminal when ≥10 loops have completed since the last DIARY write within the current session OR cumulative Loop.messages bytes since last write > 32 KB (D-51)"
    - "Per-loop-batch summary uses Haiku with the same `cachedSystemBlocks` (cache hit, ~zero marginal prefix cost — D-52)"
    - "Per-loop-batch prompt is in-character, 2–4 sentences, no headings, no metadata; appended to a concatenation of Loop.messages arrays since the last DIARY write"
    - "Successful DIARY write resets `loopCount` and `cumulativeLoopBytes` for the current session; increments `sessionsSinceConsolidation` only on session-end (not loop-batch)"
    - "Consolidation fires async (non-blocking) when ≥4 sessions have passed since last consolidation OR DIARY.md size > 200 KB (D-53)"
    - "Consolidation prompt rewrites the older 50% of entries (by entry count, with min 5 entries kept untouched at top — Q5) into a single `## Earlier (consolidated through YYYY-MM-DD)` block"
    - "The 10s idle probe NEVER triggers compaction (D-55, SPEC A7)"
    - "All compaction Anthropic calls have a wall-clock timeout (CLAUDE.md ADR #5)"
    - "Q2 resolved: Loop lifecycle owns its own bounds; chains.js TTL is irrelevant (Plan 3-01 reduced chains.js to a no-op shim)"
  artifacts:
    - path: "src/llm/compaction.js"
      provides: "createCompactor({ anthropic, cachedSystemBlocks, diary, config, logger }): { summarizeLoopBatch, consolidateOlderHalf }"
      min_lines: 100
    - path: "src/llm/sessionState.js"
      provides: "onLoopTerminal now invokes compactor.summarizeLoopBatch when D-51 trigger satisfied; onPlayerLeft invokes consolidateOlderHalf async when D-53 trigger satisfied"
      contains: "summarizeLoopBatch"
    - path: "scripts/verify-phase3.js"
      provides: "Phase-level wrapper invoking verify-phase3-loop.js + verify-phase3-memory.js (all cases)"
      min_lines: 30
  key_links:
    - from: "src/llm/sessionState.js"
      to: "src/llm/compaction.js"
      via: "compactor.summarizeLoopBatch on D-51 trigger; compactor.consolidateOlderHalf async on D-53 trigger"
      pattern: "summarizeLoopBatch|consolidateOlderHalf"
    - from: "src/llm/compaction.js"
      to: "src/llm/anthropicClient.js"
      via: "anthropic.call with same cachedSystemBlocks (zero marginal prefix cost)"
      pattern: "cachedSystemBlocks"
    - from: "src/llm/compaction.js"
      to: "src/memory/diary.js"
      via: "diary.appendEntry (loop-batch summary) + diary.replaceOlderHalf (consolidation)"
      pattern: "appendEntry|replaceOlderHalf"
---

<objective>
Implement the compaction call dispatcher: per-loop-batch summaries (writes one DIARY entry) and async consolidation (rewrites the older half of DIARY.md). Both calls reuse the same Haiku model and the same `cachedSystemBlocks` from the orchestrator (cache hit guarantee, ~zero marginal prefix cost). The triggers are gated on top of semantic boundaries (Loop terminal for summaries, session-end for consolidation), satisfying MEM-02's "LLM-directed compaction" intent.

Purpose: Close the loop on long-term game progression (MEM-04) and LLM-directed compaction (MEM-02). After this plan, Sei's diary grows steadily through play and self-consolidates without unbounded file size.

Output: `src/llm/compaction.js`, sessionState extensions to call into the compactor, an async, non-blocking consolidation path, integration tests in `verify-phase3-memory.js`, and a phase-level wrapper `scripts/verify-phase3.js`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@.planning/phases/03-memory-persistence/03-CONTEXT.md
@.planning/phases/03-memory-persistence/03-SPEC.md
@.planning/phases/03-memory-persistence/03-RESEARCH.md
@.planning/phases/03-memory-persistence/03-PATTERNS.md
@.planning/phases/03-memory-persistence/03-01-SUMMARY.md
@.planning/phases/03-memory-persistence/03-02-SUMMARY.md

@src/llm/loop.js
@src/llm/orchestrator.js
@src/llm/sessionState.js
@src/llm/compaction.js
@src/llm/anthropicClient.js
@src/memory/diary.js
@src/memory/owner.js
@src/llm/persona.js

<interfaces>
<!-- Locked from CONTEXT D-51..D-55, plus Q5 resolution (50% by entry count, min 5 kept) -->

Compactor (src/llm/compaction.js):
```typescript
interface Compactor {
  // D-52: per-loop-batch summary. Returns the topic + body that was written, or null on rate-limit/timeout.
  summarizeLoopBatch(opts: {
    loopMessagesBatch: Array<UserTurn|AssistantTurn>,   // concatenated Loop.messages arrays since last DIARY write
    when?: Date,
    signal?: AbortSignal,
  }): Promise<{ topic: string, body: string } | null>

  // D-54: consolidation. Async (caller fires-and-forgets). Returns true on successful rewrite, false on skip.
  consolidateOlderHalf(opts: {
    signal?: AbortSignal,
  }): Promise<boolean>
}

function createCompactor(opts: {
  anthropic: AnthropicClient,
  cachedSystemBlocks: TextBlockParam[],   // SAME blocks the orchestrator uses (cache hit guarantee)
  diary: Diary,
  config: Config,
  logger?: any,
}): Compactor
```

Loop.messages serialization for prompts:
- Walk the batch's messages array (already canonical from Loop._internal). Render as plain text, role-prefixed:
  - assistant turns: `[sei] ${text-blocks-joined}` ; tool_use blocks rendered as `(action: ${name})` (no internal IDs).
  - user turns: `[event] ${text-block-content}` for `name:'event'` blocks; `[result] ${content}` for tool_result blocks; skip snapshot blocks (too noisy for the summary prompt).
- Concatenate with newlines.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement createCompactor with summarizeLoopBatch and consolidateOlderHalf; reserve same cachedSystemBlocks</name>
  <files>src/llm/compaction.js, scripts/verify-phase3-memory.js</files>
  <read_first>
    - src/llm/orchestrator.js (lines ~225-253 — existing callPersonality/callCombined for the Anthropic call shape; this is the canonical pattern per PATTERNS.md)
    - src/llm/anthropicClient.js (call signature + cache_control invariant at lines 62-73)
    - src/memory/diary.js (Plan 3-02 — appendEntry, replaceOlderHalf, readAll signatures)
    - 03-CONTEXT.md D-51, D-52, D-53, D-54
    - 03-RESEARCH.md "Pitfall 4: Cache invalidation" (cachedSystemBlocks reuse), "Pitfall 7: Consolidation collides with active write", "Open Question 5" (split rule)
    - 03-PATTERNS.md "src/llm/compaction.js" section
  </read_first>
  <behavior>
    - Test (`summarize-prompt-shape`): With a stubbed `anthropic.call` that records arguments, `summarizeLoopBatch({ loopMessagesBatch: [/*…some messages…*/] })` calls `anthropic.call` with: (a) `systemBlocks` === the same `cachedSystemBlocks` reference (identity check), (b) `tools: []`, (c) `messages` ending with one user turn whose content includes the locked D-52 prompt body and a serialized rendering of the batch.
    - Test (`summarize-output-parses`): Stub `anthropic.call` to return `{ content: [{ type:'text', text: 'Today I chopped wood with shawn near the river. It was peaceful and rainy.' }] }`. `summarizeLoopBatch` returns `{ topic: 'chopped wood with shawn', body: 'Today I chopped wood with shawn near the river. It was peaceful and rainy.' }` (topic is the first ≤6 words of the output, deterministic prefix).
    - Test (`summarize-writes-diary`): Verify the call results in `diary.appendEntry({ topic, body, when })` being invoked exactly once with the parsed values.
    - Test (`summarize-rate-limited`): If `anthropic.call` throws/aborts (timeout, network), `summarizeLoopBatch` returns `null`, logs a warn, and does NOT call `diary.appendEntry`.
    - Test (`consolidate-prompt-shape`): With a diary of 10 entries, `consolidateOlderHalf` calls `anthropic.call` with the locked D-54 prompt body and the older half of entries serialized in-line. Topic is fixed: `Earlier (consolidated through YYYY-MM-DD)`.
    - Test (`consolidate-min-entries`): With a diary of 4 entries, `consolidateOlderHalf` returns `false` and does NOT call `anthropic.call` (Q5: min 5 entries kept untouched ⇒ nothing to consolidate when N ≤ 5).
    - Test (`consolidate-split-50pct`): With a diary of 12 entries (E0 newest…E11 oldest), `consolidateOlderHalf` keeps `max(ceil(12/2), 5) === 6` newest (E0..E5), consolidates E6..E11. The replacement block has heading `## Earlier (consolidated through <E11.date>)`.
    - Test (`compaction-uses-cached-system-blocks`): `compactor.summarizeLoopBatch(...)` and `compactor.consolidateOlderHalf(...)` both pass the EXACT same `cachedSystemBlocks` array reference (Pitfall 4 — cache hit guarantee). Use a Symbol or identity check.
    - Test (`compaction-has-timeout`): Both calls pass `timeoutMs: config.anthropic.timeout_ms` to `anthropic.call` (CLAUDE.md ADR #5).
  </behavior>
  <action>
    Implement `src/llm/compaction.js` mirroring the call pattern at `src/llm/orchestrator.js:225-253`:

    ```javascript
    export function createCompactor({ anthropic, cachedSystemBlocks, diary, config, logger = console }) {
      const TIMEOUT_MS = config.anthropic.timeout_ms

      async function summarizeLoopBatch({ loopMessagesBatch, when = new Date(), signal }) {
        try {
          const serialized = serializeMessagesForPrompt(loopMessagesBatch)
          const promptBody = [
            'You just finished a stretch of activity. In 2–4 sentences, write a diary entry summarizing what happened from your perspective — who you were with, what you did, how it felt.',
            'Plain markdown, no headings, no metadata.',
            '',
            '--- Recent activity ---',
            serialized,
          ].join('\n')
          const resp = await anthropic.call({
            systemBlocks: cachedSystemBlocks,
            tools: [],
            messages: [{ role: 'user', content: promptBody }],
            signal,
            timeoutMs: TIMEOUT_MS,
          })
          const text = (resp.content?.find(b => b.type === 'text')?.text ?? '').trim()
          if (!text) { logger.warn('[sei/compact] empty summary; skipping diary append'); return null }
          const topic = deriveTopic(text)   // first 6 words, lowercased, no trailing punctuation
          await diary.appendEntry({ topic, body: text, when })
          logger.info(`[sei/compact] diary entry written: ${topic}`)
          return { topic, body: text }
        } catch (err) {
          logger.warn(`[sei/compact] summarize failed: ${err.message}`)
          return null
        }
      }

      async function consolidateOlderHalf({ signal } = {}) {
        const entries = await diary.readAll()
        const keep = Math.max(Math.ceil(entries.length / 2), 5)
        if (entries.length <= keep) {
          logger.info(`[sei/compact] consolidate skip: ${entries.length} entries ≤ keep threshold ${keep}`)
          return false
        }
        const older = entries.slice(keep)
        try {
          const olderSerialized = older.map(e => `${e.headingLine}\n${e.body}`).join('\n\n')
          const promptBody = [
            'These are diary entries you wrote earlier. Compress them into a single denser narrative paragraph that preserves names, accomplishments, and any recurring themes. Drop minor day-to-day details.',
            'Plain markdown, no headings.',
            '',
            '--- Older entries ---',
            olderSerialized,
          ].join('\n')
          const resp = await anthropic.call({
            systemBlocks: cachedSystemBlocks,
            tools: [],
            messages: [{ role: 'user', content: promptBody }],
            signal,
            timeoutMs: TIMEOUT_MS,
          })
          const dense = (resp.content?.find(b => b.type === 'text')?.text ?? '').trim()
          if (!dense) { logger.warn('[sei/compact] empty consolidation; skipping rewrite'); return false }
          const through = older[0]?.dateIso ?? new Date().toISOString().slice(0, 10)
          const replacement = `## Earlier (consolidated through ${through.slice(0, 10)})\n${dense}\n`
          await diary.replaceOlderHalf(replacement)
          logger.info(`[sei/compact] consolidation written; older=${older.length} kept=${keep}`)
          return true
        } catch (err) {
          logger.warn(`[sei/compact] consolidation failed: ${err.message}`)
          return false
        }
      }

      return { summarizeLoopBatch, consolidateOlderHalf }
    }
    ```

    Helpers:
    - `serializeMessagesForPrompt(batch)` per the locked rendering rules in `<interfaces>`.
    - `deriveTopic(text)` — first 6 words, strip leading/trailing punctuation, max 60 chars.

    `diary.readAll()` should expose `dateIso` (parsed from heading) per the Plan 3-02 interface — if it doesn't, extend it here as part of this task. (Plan 3-02's `DiaryEntry` interface already has `headingLine`; add `dateIso: string | null` parsed from the `## YYYY-MM-DD HH:MM` prefix.)

    **Add cases to `scripts/verify-phase3-memory.js`** matching all behaviors above. Use the same in-memory `anthropic.call` stub from Plan 3-01's harness.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=summarize-prompt-shape &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=summarize-output-parses &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=summarize-writes-diary &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=summarize-rate-limited &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=consolidate-prompt-shape &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=consolidate-min-entries &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=consolidate-split-50pct &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=compaction-uses-cached-system-blocks &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=compaction-has-timeout</automated>
  </verify>
  <acceptance_criteria>
    - All nine harness cases above pass.
    - `compaction.js` exports `createCompactor`; no default export.
    - `grep -c "cachedSystemBlocks" src/llm/compaction.js | grep -v '^#'` ≥ 2 (used in both call sites).
    - `grep -c "timeoutMs" src/llm/compaction.js | grep -v '^#'` ≥ 2 (every external call has a timeout — ADR #5).
    - Q5 resolution documented in code comment near the split logic: `// Q5: split at max(ceil(N/2), 5) — min 5 entries always kept untouched at top`.
  </acceptance_criteria>
  <done>Compaction calls dispatch correctly through the same cached prefix. Both summary and consolidation produce well-shaped diary mutations. Errors are non-fatal.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire compactor into sessionState; trigger summaries on loop-terminal (D-51) and consolidation on session-end (D-53, async)</name>
  <files>src/llm/sessionState.js, src/llm/orchestrator.js, src/bot.js, scripts/verify-phase3-memory.js</files>
  <read_first>
    - src/llm/sessionState.js (Plan 3-02 — onLoopTerminal, onPlayerLeft, currentSessionLoopBatch)
    - src/llm/orchestrator.js (the loop-terminal hook reserved by Plan 3-01/3-02)
    - src/bot.js (the wiring block from Plan 3-02)
    - 03-CONTEXT.md D-51 (loop-batch trigger), D-53 (consolidation trigger), D-55 (semantic boundary intent), D-56 (session-end flush)
    - 03-RESEARCH.md "Pitfall 6: Concurrent Loops" — same single-flight discipline applies to async consolidation
  </read_first>
  <behavior>
    - Test (`d51-loop-count-trigger`): After 9 `onLoopTerminal({ messagesByteSize: 1000 })` calls within one session, no diary write. After the 10th call, `compactor.summarizeLoopBatch` is invoked exactly once with the concatenated `Loop.messages` since the last write. After the call, `loopCount` and `cumulativeLoopBytes` reset to 0.
    - Test (`d51-bytes-trigger`): With `loop_batch_loop_count_cap: 100` (high) and `loop_batch_context_cap_bytes: 32768`, after several `onLoopTerminal` calls totalling > 32 KB, the trigger fires and resets counters.
    - Test (`d51-trigger-survives-failure`): If `compactor.summarizeLoopBatch` returns `null` (call failed), counters do NOT reset (so the next loop-terminal will retry). Document this as an explicit decision: failed-summary leaves the batch intact for retry on the next terminal.
    - Test (`d53-session-trigger`): On `onPlayerLeft(owner)`, if `sessionsSinceConsolidation >= 4`, fire `compactor.consolidateOlderHalf` async (do NOT await before returning from `onPlayerLeft`). After the async call resolves, `sessionsSinceConsolidation` resets to 0.
    - Test (`d53-size-trigger`): On `onLoopTerminal` (within session), if `diary.getFileSizeBytes() > diary_size_cap_bytes`, fire `consolidateOlderHalf` async (independent of session count).
    - Test (`d53-async-non-blocking`): `onPlayerLeft` returns within 50ms even when consolidation takes seconds (async fire-and-forget). Use a stubbed slow `anthropic.call` to verify.
    - Test (`a7-no-idle-write`): A sequence of 100 simulated idle-tick events (no Loop) results in zero `diary.appendEntry` calls (SPEC A7 / D-55). Verified via spy on `diary.appendEntry`.
    - Test (`session-end-flush`): On `onPlayerLeft`, if there are pending uncompacted loops in the current session (loopCount > 0 OR cumulativeBytes > 0), fire `compactor.summarizeLoopBatch` ONCE for the residual batch (D-56 session-end flush), then reset counters and check D-53 consolidation trigger.
  </behavior>
  <action>
    **Modify `src/llm/sessionState.js`** to accept a `compactor` dependency and add a `loopBatchAccumulator` (the concatenated `Loop.messages` since the last DIARY write):

    1. Extend the factory signature: `createSessionState({ ownerMdPath, diary, compactor, config, bot, logger })`.
    2. Add private state:
       - `let loopBatchMessages: Array<any> = []` — accumulator of finished `Loop.messages` arrays since last DIARY write
       - `let consolidationLock: boolean = false` — Pitfall 6 single-flight for async consolidation
    3. Modify `onLoopTerminal({ messagesByteSize, loopMessages })` to also accept `loopMessages` (the canonical Loop._internal.messages from the orchestrator). Push `loopMessages` onto `loopBatchMessages`. Increment counters as before. Then check D-51:
       ```javascript
       const loopCap   = config.memory.loop_batch_loop_count_cap
       const bytesCap  = config.memory.loop_batch_context_cap_bytes
       if (loopCount >= loopCap || cumulativeLoopBytes >= bytesCap) {
         const result = await compactor.summarizeLoopBatch({ loopMessagesBatch: loopBatchMessages.flat(), when: new Date() })
         if (result) {
           loopCount = 0
           cumulativeLoopBytes = 0
           loopBatchMessages = []
         } else {
           logger.warn('[sei/session] loop-batch summary failed; leaving batch for retry')
         }
       }
       // D-53 size-pressure check (independent of session count)
       const diarySize = await diary.getFileSizeBytes()
       if (diarySize > config.memory.diary_size_cap_bytes && !consolidationLock) {
         consolidationLock = true
         compactor.consolidateOlderHalf({}).finally(() => { consolidationLock = false })
         // intentionally NOT awaited — async fire-and-forget
       }
       ```

    4. Modify `onPlayerLeft(player)` (D-56 session-end flush + D-53 session-count trigger):
       ```javascript
       if (player.uuid !== activeOwnerUuid) return
       // Flush residual loop-batch
       if (loopCount > 0 || cumulativeLoopBytes > 0) {
         const result = await compactor.summarizeLoopBatch({ loopMessagesBatch: loopBatchMessages.flat(), when: new Date() })
         if (result) {
           loopCount = 0
           cumulativeLoopBytes = 0
           loopBatchMessages = []
         }
       }
       // D-53 session-count consolidation trigger
       if (sessionsSinceConsolidation >= config.memory.sessions_per_consolidation && !consolidationLock) {
         consolidationLock = true
         compactor.consolidateOlderHalf({})
           .then(success => { if (success) sessionsSinceConsolidation = 0 })
           .finally(() => { consolidationLock = false })
         // intentionally NOT awaited
       }
       // Update last_seen + save OWNER.md
       ownerData.last_seen = new Date().toISOString()
       await saveOwner(ownerMdPath, ownerData)
       activeOwnerUuid = null
       logger.info('[sei/session] end uuid=...')
       ```

    5. **Modify `src/llm/orchestrator.js`** at the loop-terminal hook reserved by Plan 3-01/3-02:
       ```javascript
       const messagesByteSize = JSON.stringify(loop._internal.messages).length
       await sessionState.onLoopTerminal({
         messagesByteSize,
         loopMessages: loop._internal.messages,
       })
       currentLoop = null
       ```
       (No further changes — the hook now does the work.)

    6. **Modify `src/bot.js`** to construct the compactor and pass it to sessionState:
       ```javascript
       const compactor = createCompactor({
         anthropic: orchestrator._internal.anthropic,         // or whatever the orchestrator exposes
         cachedSystemBlocks: orchestrator._internal.cachedSystemBlocks,
         diary,
         config,
         logger,
       })
       const sessionState = await createSessionState({ ownerMdPath: ..., diary, compactor, config, bot, logger })
       ```
       This requires the orchestrator factory to expose `_internal.anthropic` and `_internal.cachedSystemBlocks` (one-line addition). Alternative: reorder `bot.js` so `cachedSystemBlocks` and `anthropic` are constructed at the bot level and passed into both the orchestrator AND the compactor (recommended — keeps the contract explicit).

    7. **Add cases to `scripts/verify-phase3-memory.js`** matching all behaviors above. The test harness drives `sessionState` directly with a stubbed compactor and stubbed diary to verify trigger logic. Separate cases drive an integration with a real (in-memory stub) compactor + filesystem diary fixture.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=d51-loop-count-trigger &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=d51-bytes-trigger &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=d51-trigger-survives-failure &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=d53-session-trigger &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=d53-size-trigger &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=d53-async-non-blocking &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=a7-no-idle-write &amp;&amp; node /Users/ouen/slop/sei/scripts/verify-phase3-memory.js --case=session-end-flush</automated>
  </verify>
  <acceptance_criteria>
    - All eight integration cases above pass.
    - `grep -c "summarizeLoopBatch\|consolidateOlderHalf" src/llm/sessionState.js | grep -v '^#'` ≥ 2.
    - `grep -n "await compactor.consolidateOlderHalf" src/llm/sessionState.js | grep -v '^#'` returns no matches (consolidation is fire-and-forget, never awaited inline).
    - Manual smoke test: run the bot for ≥10 chat-driven Loops in one owner-presence session; observe `[sei/compact] diary entry written: ...` log line; inspect `DIARY.md` — exactly one new dated entry appears.
    - Manual smoke test: simulate 4 sessions worth of activity (or set `sessions_per_consolidation: 1` and run 1 session); observe `[sei/compact] consolidation written` log line; `DIARY.md` ends with a `## Earlier (consolidated through ...)` block.
    - Manual smoke test: leave bot idle (no chat) for 5 minutes — observe ≥30 idle ticks in logs but ZERO `[sei/compact]` entries (SPEC A7 / D-55).
  </acceptance_criteria>
  <done>Compaction triggers fire on semantic boundaries, gated by D-51/D-53 cadence. Async consolidation is non-blocking. Idle ticks never compact.</done>
</task>

<task type="auto">
  <name>Task 3: Create phase-level test wrapper scripts/verify-phase3.js + final integration smoke</name>
  <files>scripts/verify-phase3.js</files>
  <read_first>
    - scripts/verify-phase2.js (existing pattern for phase-level wrappers)
    - scripts/verify-phase3-loop.js (Plan 3-01)
    - scripts/verify-phase3-memory.js (Plans 3-02, 3-03)
  </read_first>
  <action>
    Create `scripts/verify-phase3.js` mirroring the pattern of `scripts/verify-phase2.js`:
    - Define a list of test cases for each sub-harness.
    - Spawn each via `child_process.spawnSync('node', ['scripts/verify-phase3-loop.js', '--case=...'])` and `verify-phase3-memory.js` similarly.
    - Aggregate results: print a summary table (case, pass/fail, duration). Exit 0 if all pass, 1 if any fail.
    - Cases to invoke (the union from 3-01, 3-02, 3-03 harnesses): tool-pairing, seed-content, name-field-stripped, mutation-free, interrupt, cap-graceful, combined-path, single-flight, idle-gated, atomic-write, fresh-install, owner-roundtrip, diary-lazy-create, diary-newest-first, diary-byte-budget, diary-heading-format, diary-replace-older-half, owner-uuid-cold, owner-uuid-warm, username-change-recognition, owner-uuid-fallback, spawn-settle-delay, per-loop-batch-counter, seed-content-shape, seed-content-fresh-install, seed-budget-respected, seed-permanent-across-iterations, seed-not-in-system-blocks, summarize-prompt-shape, summarize-output-parses, summarize-writes-diary, summarize-rate-limited, consolidate-prompt-shape, consolidate-min-entries, consolidate-split-50pct, compaction-uses-cached-system-blocks, compaction-has-timeout, d51-loop-count-trigger, d51-bytes-trigger, d51-trigger-survives-failure, d53-session-trigger, d53-size-trigger, d53-async-non-blocking, a7-no-idle-write, session-end-flush.

    Add an npm script entry to `package.json`: `"verify:phase3": "node scripts/verify-phase3.js"`.
  </action>
  <verify>
    <automated>node /Users/ouen/slop/sei/scripts/verify-phase3.js</automated>
  </verify>
  <acceptance_criteria>
    - All listed cases pass under the wrapper.
    - Exit code 0.
    - `package.json` has `verify:phase3` script.
    - Manual integration smoke (recorded by developer): a real bot session against a real Minecraft test server with real Haiku — owner connects, chats with Sei for 10+ Loops, leaves, reconnects after 4 sessions worth of activity. Observed:
      - DIARY.md grows (≥1 entry per loop-batch trigger).
      - Consolidation runs after the 4th session-end (or on size cap).
      - OWNER.md `total_sessions` matches play sessions.
      - No 400 errors from Anthropic.
      - No idle-tick-driven diary writes.
  </acceptance_criteria>
  <done>Phase 3 verification harness ships. Manual integration smoke confirms Sei now remembers her owner and writes a diary across real play.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Compactor ↔ Anthropic | Compaction calls share the cached system prefix; must NOT alter it (Pitfall 4) |
| Async consolidation ↔ active diary writer | Two writers (Pitfall 7) — mutex required |
| Loop-terminal trigger ↔ idle-tick path | Only Loop terminals may compact (D-55); idle ticks must never reach diary.appendEntry |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-13 | Denial of Service | Compaction call timeout/hang | mitigate | Every call passes `timeoutMs: config.anthropic.timeout_ms` (ADR #5); failures are non-fatal (return null/false, log warn) |
| T-03-14 | Tampering | Async consolidation race vs concurrent appendEntry | mitigate | `consolidationLock` mutex in sessionState + diary's internal write mutex (Plan 3-02 / Pitfall 7) |
| T-03-15 | Information disclosure | Cache invalidation if cachedSystemBlocks deviates | mitigate | Both compaction calls reuse the SAME object reference; harness asserts identity (compaction-uses-cached-system-blocks case) |
| T-03-16 | Tampering | Idle tick triggers diary write (regression) | mitigate | Trigger gating lives only in onLoopTerminal / onPlayerLeft, never in idle handler; harness explicitly tests no-write under idle (a7-no-idle-write) |
| T-03-17 | Repudiation | Failed summary loses batch | mitigate | On null result, counters NOT reset → retry on next loop-terminal; documented behavior |
</threat_model>

<verification>
- `node scripts/verify-phase3.js` exits 0.
- `git diff src/fsm.js` empty across the whole phase.
- Manual integration smoke (recorded in 03-03-SUMMARY.md):
  - 60-minute play session with mixed chat + idle
  - Observed N Loops, M loop-batch DIARY writes, 0 idle-driven writes (A7)
  - Observed 1 consolidation pass after the cadence threshold
  - OWNER.md final state matches expected counters
- `grep -nE "(# Owner|# Diary)" src/llm/persona.js src/llm/anthropicClient.js` returns no matches (cache invariant unchanged).
</verification>

<success_criteria>
- `src/llm/compaction.js` exports `createCompactor` with `summarizeLoopBatch` and `consolidateOlderHalf`.
- Both calls reuse the same `cachedSystemBlocks` reference (cache hit guarantee).
- Triggers fire only on semantic boundaries (loop-terminal, session-end) with the D-51/D-53 cadence gating.
- Async consolidation never blocks the bot.
- Idle ticks NEVER trigger compaction (A7 / D-55).
- `scripts/verify-phase3.js` is the phase-level harness wrapper.
- Q2 / Q5 resolutions documented in code comments.
- `src/fsm.js` byte-unchanged across the entire phase.
</success_criteria>

<output>
After completion, create `.planning/phases/03-memory-persistence/03-03-SUMMARY.md` documenting:
- Compactor public API as shipped
- Trigger statistics from a real 60-minute play session (loops, summaries, consolidations, idle ticks)
- Q2 resolution: chains.js no-op shim + Loop ownership of lifecycle
- Q5 resolution: 50% by entry count, min 5 kept untouched
- Final OWNER.md and DIARY.md sample contents (anonymized if needed)
- Confirmation that all five MEM requirements have observable evidence
</output>
