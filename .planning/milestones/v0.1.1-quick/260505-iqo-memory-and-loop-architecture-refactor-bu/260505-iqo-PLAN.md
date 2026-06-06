---
phase: 260505-iqo
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/llm/orchestrator.js
  - src/llm/ollamaClient.js
  - src/llm/circuit.js
  - src/llm/chatRingBuffer.js
  - src/llm/convoMemory.js
  - src/config.js
  - config.json
  - src/cli/index.js
  - src/bot.js
  - src/fsm.js
  - src/behaviors/chat.js
  - scripts/verify-phase2.js
  - scripts/verify-phase2_1.js
  - scripts/verify-phase3-memory.js
  - CLAUDE.md
  - .planning/STATE.md
autonomous: true
quick_id: 260505-iqo
---

<objective>
Land the five coordinated changes from the wood.txt session analysis as three atomic, dependency-ordered commits:

1. API-only refactor — collapse two-layer (Haiku+Ollama) into a single combined Anthropic call. Delete every artifact of the old two-layer architecture; no shims, no leftover constants, no dead config.
2. Conversation-memory module + say/think separation — replace the single mixed `chatBuffer` with a `convoMemory` module exposing `recentChat` (split owner/self sub-buffers, larger capacity) and `loopHistory` (ring of completed-loop summaries with title + mutation deltas). Wire all three new seed blocks into `composeSeedBlocks`. Strip the dev/prod chat-mode toggle: assistant `text` is private scratch, `say` is the only player-visible channel.
3. Idle timing split — separate end-of-loop ticks from the 60s idle fallback. New `sei:loop_end` event fires after every real-activity loop; `sei:idle` keeps its 60s fallback. Branch the seed event addendum so each prompts the model differently.

Purpose: the bot loops at idle cadence even mid-task, repeats itself in chat, loses continuity across loops, and has a vestigial Ollama executor that never runs in practice. This refactor fixes all four in one coherent landing.

Output: Three commits, single Anthropic code path, zero dead code, single chat mode, idle and loop-end as distinct events with distinct prompts.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@src/llm/orchestrator.js
@src/llm/loop.js
@src/llm/sessionState.js
@src/fsm.js
@src/llm/chatRingBuffer.js
@src/config.js
@config.json
@src/bot.js
@src/behaviors/chat.js

<interfaces>
<!-- Key contracts the executor needs. Extracted from the codebase. -->

From src/llm/loop.js — Loop has `_internal.messages`, `iterationCount`, `id`, `abortController`. The orchestrator's `handleDispatch` finally block (orchestrator.js:576-581) already runs after every loop terminal — this is where Task 2 will push to `loopHistory` and where Task 3 will emit `sei:loop_terminal`.

From src/llm/orchestrator.js:149 — composeSeedBlocks signature:
```js
composeSeedBlocks({ sessionState, ownerStore, diary, config, eventText, snapshotText, recentChatText = null }) -> Array<{type:'text', name, text, cache_control?}>
```
Order today: seed_owner, seed_diary (cache_control), recent_chat?, event, snapshot.
Task 2 changes the signature to accept a convoMemory facade and emit blocks in this order:
seed_owner, seed_diary (cache_control), recent_loop_history?, recent_owner_chat?, your_recent_messages?, event, snapshot.

From src/fsm.js — Priority enum P0_SAFETY=0, P1_CHAT=1, P2_MOVEMENT=2, P3_IDLE=3. New `sei:loop_end` lands at priority 2.5 → use a new constant P2_5_LOOP_END = 2.5 (between movement and idle, above idle so it preempts an idle that's about to fire, below chat so chat preempts it).

From src/llm/sessionState.js — onLoopTerminal({ messagesByteSize, loopMessages, event }) is called in orchestrator's `try` block (orchestrator.js:558-573). Already receives `event`. No signature change needed.

From src/behaviors/chat.js:37 — calls `orchestrator.recordIncomingChat(username, message)`. Task 2 keeps this method name but rewires its body to push into `convoMemory.recentChat` (owner side).
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: API-only refactor — single Anthropic path, delete Ollama/circuit/handOff</name>
  <files>
src/llm/orchestrator.js,
src/llm/ollamaClient.js (delete),
src/llm/circuit.js (delete),
src/config.js,
config.json,
src/cli/index.js,
src/bot.js,
scripts/verify-phase2.js,
scripts/verify-phase2_1.js,
scripts/verify-phase3-memory.js,
CLAUDE.md,
.planning/STATE.md
  </files>
  <action>
Collapse the two-layer LLM architecture into a single combined Haiku call. Zero compat shims, zero dead code, zero "// removed" comments.

**Delete files:**
- `rm src/llm/ollamaClient.js`
- `rm src/llm/circuit.js`

**src/llm/orchestrator.js — surgical removals:**
1. Drop imports: `createOllamaClient`, `createOllamaCircuit` (lines 2, 6).
2. Delete `MOVEMENT_SYSTEM` constant (lines 48-52).
3. Delete `SYSTEM_INSTRUCTIONS` (the two-call version, lines 32-46) and rename `COMBINED_SYSTEM` (lines 58-73) to `SYSTEM_INSTRUCTIONS`. The new combined `SYSTEM_INSTRUCTIONS` is the only system prompt.
4. Drop `handOffToMovement` from `ACTION_DESCRIPTIONS` (line 79). Drop it from `PERSONALITY_NAMES` (line 87) — `PERSONALITY_NAMES` is now `new Set(['say', 'setGoals'])`.
5. Delete the `handOffToMovement` entry from the `personalityTools` array (orchestrator.js:230-234).
6. Delete `function movementToolsFor(provider)` (lines 251-259) — replace with a single inline call `buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)` inside `combinedToolsFor`. The `subRegistry` filter still excludes `setGoals`.
7. In `combinedToolsFor()` (lines 264-273) drop the `.filter(t => t.name !== 'handOffToMovement')` — `personalityTools` no longer contains it. Otherwise unchanged.
8. Delete the `ollama`, `circuit` instances at orchestrator.js:182-183.
9. Delete `cachedSystemBlocks` (the personality-only variant, line 280) and `rebuildPersonalitySystem`'s first `anthropic.buildCachedSystem(...)` call (lines 282-290). Keep ONLY `cachedCombinedSystemBlocks`, but rename it to `cachedSystemBlocks` everywhere (the cap-close path, the harness seam exports, the compactor wiring in bot.js — see step 18 below).
10. Delete `chatModeGuidance`, `PROD_CHAT_GUIDANCE`, `DEV_CHAT_GUIDANCE` (orchestrator.js:18-30, 278). The combined system prompt absorbs the prod-mode rules (`say` is the only player channel, ≤15 words, frequent calls). Add the lines from `PROD_CHAT_GUIDANCE` (lines 22-26) directly after the existing combined-system bullet list, BEFORE the `.join('\n')`.
11. Delete `function probeOllamaWithRetry()` (lines 312-318) and the entire body of `start()` — replace `start()` with a no-op that returns immediately, OR remove the `start` export and update bot.js to drop the `orchestrator.start().catch(...)` line. Choose: keep `start` as a no-op `async function start() {}` to minimise bot.js churn. Drop `executorStatus` getter (line 909). Update bot.js (step 18) to remove the `executorStatus` log line.
12. Delete `async function callMovement(...)` (lines 338-362).
13. Delete `async function callPersonalityTwoCall(...)` (lines 878-890) and `async function callPersonalityCombined(...)` (lines 892-904). Replace with a single `async function callPersonality(loop, signal)` that mirrors the body of the old `callPersonalityCombined`: rate-limit gate, `anthropic.call({ systemBlocks: cachedSystemBlocks, tools: combinedToolsFor(), messages: loop.buildAnthropicPayload(), signal, timeoutMs: config.anthropic.timeout_ms })`.
14. In `runIterations` (lines 596-776) replace the `if (circuit.isOpen()) ... else ...` branch (lines 610-614) with a single `resp = await callPersonality(loop, signal)`.
15. In `runIterations` delete the `handoffCall` lookup (line 664), the `else if (u.name === 'handOffToMovement')` branch (lines 691-721), and the `handOffToMovement` filter exclusion. The `movementCalls` filter at line 665 (`!PERSONALITY_NAMES.has(u.name)`) still works since `handOffToMovement` is gone from the set.
16. In the `continueLoop` calc (line 770) drop the `!!handoffCall ||` term — keep only `movementCalls.length > 0`.
17. In `extractPriorTask` (lines 378-403) delete the `handOffToMovement` branch (lines 387-390). Combined-mode movement actions are the only path now.
18. Delete `_internal.callPersonalityTwoCall`, `_internal.callPersonalityCombined`, `_internal.callMovement`, `_internal.circuit` from the returned object (lines 918-919). Keep `personalityBucket`, `chains`, `inflight`, `currentLoop`, `getCachedSystemBlocks`, `anthropic`, `cachedSystemBlocks`. Drop `getCachedCombinedSystemBlocks` — there is only one cached system blocks object now.
19. Drop the `executorStatus` getter from the public return (line 909).

**src/config.js:**
- Drop the entire `ollama: z.object({...}).default({})` schema (lines 24-28).
- In `llm: z.object({...})` drop the `executor` field (line 36) and the `// 'auto' = ...` / `// 'api' = ...` comments above it (lines 34-35).

**config.json:**
- Drop the entire `"ollama": {...}` block (lines 19-22).
- Drop `"executor": "api"` from `"llm"` (line 28). Trailing comma cleanup.

**src/cli/index.js:**
- Drop the line `ollama: { host: 'http://127.0.0.1:11434', model: 'qwen3.5:7b-instruct' },` (line 58) from the inline default-config object.

**src/bot.js:**
- Remove the `logStatus(\`Sei online. Executor: ${orchestrator.executorStatus}\`)` line (line 135). Replace with `logStatus('Sei online.')`.

**scripts/verify-phase2.js:**
- Read the file. Delete the `assert(config.ollama?.model?.includes('instruct'), ...)` line (line 28). Delete the `executorStatus` assertion (line 55). Delete the post-probe executor-state log (line 65). Anything else that references `ollama` or `circuit` or `executor` or `qwen` — delete.

**scripts/verify-phase2_1.js:**
- Read the file. Delete the `handOffToMovement` tool-definition fixture (line 141), the system-prompt bullet referencing it (line 148), and the `resp.toolUses.find(u => u.name === 'handOffToMovement')` assertion (line 171). If those were load-bearing for the script, replace with combined-mode equivalents that find a movement tool by registry name (e.g. `goTo`).

**scripts/verify-phase3-memory.js:**
- Read line 718. Drop the `ollama: { host: 'http://x', model: 'q', timeout_ms: 1000 }` field from the test-config fixture.

**CLAUDE.md updates:**
- "## Key Architecture Decisions" item #1: change `Three-process Electron: main ↔ renderer (contextIsolation) ↔ utilityProcess (bot + LLMs). Mineflayer must run in utilityProcess only.` — this stays accurate (LLMs plural is fine; the Anthropic client and compactor still live in utilityProcess). NO CHANGE needed for #1.
- Item #2 currently says `Closed action registry: movement LLM calls Zod-typed actions, never generates code or coordinates`. Change to: `Closed action registry: the LLM calls Zod-typed actions directly, never generates code or coordinates. Single Haiku layer combines reasoning + dispatch in one call.`
- "## Critical Pitfalls" — drop the entire bullet `Pathfinder silent hangs → ...` ONLY if you can confirm it no longer applies (it still does — keep it). Drop the bullet `Two-layer LLM runaway loop → hard recursion cap (5 hops) + 500ms debounce from day one` (no longer relevant — single layer can't loop on itself the same way; the recursion cap stays in code as `max_hops` but isn't a "two-layer" pitfall anymore). Replace with: `Single-layer iteration runaway → iteration_cap (default 20) bounds tool-use chains; abort on owner chat preempts mid-iteration.`

**.planning/STATE.md updates:**
- Edit the "Decisions (from PROJECT.md / research)" section. Replace the line `Two-layer LLM: Haiku 3 personality + Ollama Qwen 2.5 movement, natural-language hand-off` with `Single-layer LLM: Haiku 4.5 combined personality + movement dispatch, single API call per iteration (collapsed from two-layer architecture in 260505-iqo).`
- Replace the line `Default Ollama model qwen3.5:7b-instruct (non-instruct emits thinking traces, D-21)` with — actually, just delete the entire line. Ollama is gone.
- Delete `Per-call new Ollama() instance to isolate abort() scope (Pitfall 3)`.
- Replace `Personality LLM tools restricted to say/handOffToMovement/setGoals; mineflayer registry actions reserved for movement layer (D-04)` with `LLM tools: say, setGoals + full mineflayer registry (combined call). setGoals lives in registry but tools list filters it out to avoid duplication (D-04 collapsed into combined-call rules in 260505-iqo).`
- Append a new line at end of Decisions section: `API-only architecture (260505-iqo): Ollama executor + circuit breaker + handOffToMovement tool removed. Single Anthropic call per iteration with full combined tool set.`
- Append to "Quick Tasks Completed" table: `| 260505-iqo | API-only refactor + memory module + idle/loop-end split | 2026-05-05 | (commit-hash-after-T3) | [260505-iqo-...](./quick/260505-iqo-memory-and-loop-architecture-refactor-bu/) |` — but note: this entry is appended AFTER Task 3 commits, with the actual commit hash filled in then. Skip in Task 1.

Verify nothing else in the tree references the removed symbols. Run a final grep (see verify) and fix any stragglers.

**Single commit at end:** `refactor(260505-iqo): collapse two-layer LLM to API-only single combined call`. Body lists: deleted ollamaClient.js + circuit.js, removed handOffToMovement tool + callMovement + callPersonalityTwoCall + executor config + ollama config, renamed COMBINED_SYSTEM → SYSTEM_INSTRUCTIONS, folded prod chat guidance into the single system prompt (dev/prod toggle is a Task 2 removal but the chatModeGuidance string concatenation goes here for cleanliness — re-read step 10 to confirm), updated CLAUDE.md + STATE.md.
  </action>
  <verify>
    <automated>
# Symbols must be gone from the entire tree (excluding node_modules and the planning/quick directories which document the change):
test -z "$(grep -rn --include='*.js' --include='*.json' --include='*.md' 'ollamaClient\|createOllamaClient\|createOllamaCircuit\|MOVEMENT_SYSTEM\|callPersonalityTwoCall\|callPersonalityCombined\|callMovement\|handOffToMovement\|executorStatus\|DEV_CHAT_GUIDANCE\|PROD_CHAT_GUIDANCE\|chatModeGuidance' src scripts CLAUDE.md 2>/dev/null | grep -v '^[^:]*:[[:space:]]*//\|^[^:]*:[[:space:]]*\*' )"
# Files deleted:
test ! -f src/llm/ollamaClient.js && test ! -f src/llm/circuit.js
# Config schema clean:
node -e "import('./src/config.js').then(m => { const r = m.ConfigSchema.safeParse({...JSON.parse(require('fs').readFileSync('./config.json','utf-8')), anthropic:{api_key:'x'}}); if(!r.success){console.error(r.error); process.exit(1)} if('ollama' in r.data){console.error('ollama leaked'); process.exit(1)} if('executor' in (r.data.llm||{})){console.error('executor leaked'); process.exit(1)} console.log('OK')})"
# Orchestrator constructs cleanly:
node -e "import('./src/llm/orchestrator.js').then(m => { console.log(typeof m.createOrchestrator === 'function' ? 'OK' : 'FAIL') }).catch(e => { console.error(e.message); process.exit(1) })"
# Existing verify scripts still parse + execute up to their LLM-call gates (network calls may stub-fail; the import-side must succeed):
node -e "import('./scripts/verify-phase2.js').catch(e => { if(/network\|fetch\|connect/i.test(e.message)) process.exit(0); console.error(e); process.exit(1)})"
    </automated>
  </verify>
  <done>
- src/llm/ollamaClient.js and src/llm/circuit.js deleted.
- Single SYSTEM_INSTRUCTIONS constant remains in orchestrator.js (combined version, with prod chat rules folded in).
- No reference anywhere in src/, scripts/, CLAUDE.md to: ollamaClient, MOVEMENT_SYSTEM, callPersonalityTwoCall, callMovement, handOffToMovement, executorStatus, PROD_CHAT_GUIDANCE, DEV_CHAT_GUIDANCE, chatModeGuidance.
- config.json has no `ollama` block and no `llm.executor` field.
- src/config.js schema rejects `ollama` and `executor` (or — equivalently — they're stripped by Zod since the schema doesn't permit them; either is fine).
- Single git commit `refactor(260505-iqo): collapse two-layer LLM to API-only single combined call`.
- CLAUDE.md and .planning/STATE.md decisions updated to reflect single-layer architecture.
  </done>
</task>

<task type="auto">
  <name>Task 2: convoMemory module + seed integration + say/think separation</name>
  <files>
src/llm/convoMemory.js (new),
src/llm/chatRingBuffer.js (delete),
src/llm/orchestrator.js,
src/behaviors/chat.js
  </files>
  <action>
Replace the single mixed-direction chat ring buffer with a richer `convoMemory` module exposing two structures (recentChat with split owner/self sub-buffers, and loopHistory). Wire all three new seed blocks into `composeSeedBlocks`. Strip the assistant-text-as-chat fallback paths so `say` is the sole player-visible channel and the sole source of bot lines pushed to memory.

**Create src/llm/convoMemory.js:**

```js
/**
 * Conversation memory for Sei (260505-iqo).
 *
 * Two structures:
 *   recentChat   — split owner/self sub-buffers, capacity 10 each, 240-char per-line
 *                  truncation. Renders into TWO seed blocks so the model sees
 *                  what the owner said separately from what it itself said.
 *   loopHistory  — ring of completed-loop summaries (capacity 20). Each entry
 *                  carries a 1-line title synthesized from the loop's first
 *                  say() output + most-frequent tool name (no extra API call,
 *                  no doubling of end-of-loop cost). Used for cross-loop
 *                  continuity in the seed turn.
 *
 * Why split owner/self: the prior single-buffer mixed both directions,
 * which trained the model to treat its OWN prior lines as conversational
 * input from the player. Splitting lets us prompt-engineer self-lines
 * with an explicit "do not repeat" guard.
 *
 * Why loopHistory exists: every Loop is composed cold from seed_owner +
 * seed_diary + event + snapshot. Without an explicit timeline of what
 * happened in recent loops, the bot keeps re-asking questions it already
 * asked five minutes ago and rediscovering tasks it just finished.
 */

const RECENT_CHAT_CAPACITY = 10
const RECENT_CHAT_LINE_TRUNC = 240
const LOOP_HISTORY_CAPACITY = 20
const LOOP_TITLE_BASE_TRUNC = 80

function pushRing(arr, item, cap) {
  arr.push(item)
  while (arr.length > cap) arr.shift()
}

function fmtAgo(now, at) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

export function createConvoMemory() {
  /** @type {{ at:number, who:string, text:string }[]} */
  const ownerLines = []
  /** @type {{ at:number, who:string, text:string }[]} */
  const selfLines = []
  /** @type {{ loopId:string, startedAt:number, endedAt:number, event:string, title:string, mutations:string }[]} */
  const loopHistory = []

  function pushOwner(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(ownerLines, { at: Date.now(), who: String(who || '?'), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function pushSelf(who, text) {
    if (!text) return
    const line = String(text).trim()
    if (!line) return
    pushRing(selfLines, { at: Date.now(), who: String(who || 'sei'), text: line.slice(0, RECENT_CHAT_LINE_TRUNC) }, RECENT_CHAT_CAPACITY)
  }

  function formatOwnerBlock() {
    if (ownerLines.length === 0) return null
    const now = Date.now()
    const body = ownerLines.map(({ at, who, text }) => `[${fmtAgo(now, at)}] ${who}: ${text}`).join('\n')
    return `Recent owner messages, oldest first:\n${body}`
  }

  function formatSelfBlock() {
    if (selfLines.length === 0) return null
    const now = Date.now()
    const body = selfLines.map(({ at, text }) => `[${fmtAgo(now, at)}] you: ${text}`).join('\n')
    return `Things you (Sei) said recently. Do NOT repeat — if your next message would substantially duplicate one of these, say something different or stay silent.\n${body}`
  }

  /**
   * Synthesize a title from a completed Loop's messages — no extra API call.
   * Strategy: first say() line truncated to ~80 chars + most-frequent
   * non-personality tool name as a tag. If neither exists, fall back to event.
   */
  function synthesizeTitle(loopMessages, originatingEvent) {
    let firstSay = null
    const toolFreq = new Map()
    for (const msg of loopMessages || []) {
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const blk of msg.content) {
        if (!blk || blk.type !== 'tool_use') continue
        if (blk.name === 'say') {
          if (!firstSay) firstSay = String(blk.input?.text ?? '').trim()
        } else if (blk.name !== 'setGoals') {
          toolFreq.set(blk.name, (toolFreq.get(blk.name) || 0) + 1)
        }
      }
    }
    let topTool = null
    let topCount = 0
    for (const [name, count] of toolFreq) {
      if (count > topCount) { topTool = name; topCount = count }
    }
    const sayPart = firstSay ? firstSay.slice(0, LOOP_TITLE_BASE_TRUNC) : ''
    const toolPart = topTool ? `[${topTool}×${topCount}]` : ''
    if (sayPart && toolPart) return `${sayPart} ${toolPart}`
    if (sayPart) return sayPart
    if (toolPart) return `${originatingEvent || 'loop'} ${toolPart}`
    return `${originatingEvent || 'loop'} (no output)`
  }

  /**
   * Synthesize a 1-line mutation summary from snapshot deltas captured during
   * the loop. The snapshot's `recent_events:` line carries inventory/kill/hp
   * deltas — we scan tool_result text blocks (which carry the snapshot text)
   * for the latest one and extract that line. Best-effort; empty string OK.
   */
  function synthesizeMutations(loopMessages) {
    let latest = ''
    for (const msg of loopMessages || []) {
      if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const blk of msg.content) {
        if (!blk || blk.type !== 'text' || blk.name !== 'snapshot' || typeof blk.text !== 'string') continue
        const m = blk.text.match(/recent_events:\s*([^\n]+)/)
        if (m && m[1]) latest = m[1].trim()
      }
    }
    return latest
  }

  /**
   * Push a completed-loop summary. Called from orchestrator's handleDispatch
   * finally block at loop terminal.
   */
  function pushLoop({ loopId, startedAt, endedAt, event, loopMessages }) {
    const title = synthesizeTitle(loopMessages, event)
    const mutations = synthesizeMutations(loopMessages)
    pushRing(loopHistory, { loopId, startedAt, endedAt, event, title, mutations }, LOOP_HISTORY_CAPACITY)
  }

  function formatLoopHistoryBlock() {
    if (loopHistory.length === 0) return null
    const now = Date.now()
    const body = loopHistory.map(({ endedAt, event, title, mutations }) => {
      const ago = fmtAgo(now, endedAt)
      const mu = mutations ? ` — ${mutations}` : ''
      return `[${ago}] (${event}) ${title}${mu}`
    }).join('\n')
    return `Your recent activity timeline (loop-by-loop, oldest first):\n${body}`
  }

  return {
    recentChat: {
      pushOwner,
      pushSelf,
      formatOwnerBlock,
      formatSelfBlock,
      get ownerSize() { return ownerLines.length },
      get selfSize() { return selfLines.length },
      _internal: { ownerLines, selfLines },
    },
    loopHistory: {
      push: pushLoop,
      formatBlock: formatLoopHistoryBlock,
      get size() { return loopHistory.length },
      _internal: { entries: loopHistory },
    },
  }
}
```

**Delete src/llm/chatRingBuffer.js.**

**src/llm/orchestrator.js — rewire seed blocks + say/think separation:**

1. Drop import `import { createChatRingBuffer } from './chatRingBuffer.js'`. Replace with `import { createConvoMemory } from './convoMemory.js'`.

2. Replace `const chatBuffer = createChatRingBuffer({ capacity: 10 })` (line 203) with `const convoMemory = createConvoMemory()`.

3. Rewrite `composeSeedBlocks` (lines 149-167) signature and body. Drop the `recentChatText` param. Add three new optional text params: `recentLoopHistoryText`, `recentOwnerChatText`, `yourRecentMessagesText`. Order in the returned blocks array: `seed_owner`, `seed_diary` (cache_control stays here), `recent_loop_history` (if present), `recent_owner_chat` (if present), `your_recent_messages` (if present), `event`, `snapshot`. Block names are: `recent_loop_history`, `recent_owner_chat`, `your_recent_messages`. The text bodies are exactly the strings returned by `convoMemory.loopHistory.formatBlock()` / `convoMemory.recentChat.formatOwnerBlock()` / `convoMemory.recentChat.formatSelfBlock()` — those formatters already include their own headers, so don't add another.

4. In `handleDispatch` (orchestrator.js:516-527) update the `composeSeedBlocks` call site:
```js
seedBlocks = await composeSeedBlocks({
  sessionState, ownerStore, diary, config,
  eventText, snapshotText: snapshotText(),
  recentLoopHistoryText: convoMemory.loopHistory.formatBlock(),
  recentOwnerChatText: convoMemory.recentChat.formatOwnerBlock(),
  yourRecentMessagesText: convoMemory.recentChat.formatSelfBlock(),
})
```

5. **say/think separation.** In `runIterations`:
   - Delete the entire terminal-text fallback block (lines 632-645). Replace with: log the `text` at debug level only. New body:
     ```js
     if (toolUses.length === 0) {
       const text = (resp.text ?? '').trim()
       if (text) logger.debug?.(`[sei/orch] terminal text (private, not relayed): ${text}`)
       return
     }
     ```
   - Delete the entire mid-text fallback block (lines 647-659). Replace with:
     ```js
     const midText = (resp.text ?? '').trim()
     if (midText) {
       const calledSay = toolUses.some(u => u.name === 'say')
       if (!calledSay) logger.debug?.(`[sei/orch] mid-loop text (private, not relayed): ${midText}`)
     }
     ```
     (We keep the calledSay check only to avoid noisy debug logs when the model is being well-behaved. The behavior collapses to "internal text never reaches bot.chat or memory buffers".)

6. The `say()` tool handler (orchestrator.js:674-679) becomes the SOLE source of bot.chat() and memory pushes:
```js
} else if (u.name === 'say') {
  const line = String(u.input?.text ?? '').slice(0, 256)
  logChatOut(line)
  try { bot.chat(line) } catch {}
  convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
  results[i] = { type: 'tool_result', tool_use_id: u.id, content: 'said', is_error: false }
}
```

7. Update the SYSTEM_INSTRUCTIONS constant (the renamed combined system from Task 1). Add this line near the top, immediately after "You are a Minecraft companion bot. ...":
```
'Communicate to the owner ONLY via the `say` tool. Your assistant `text` field is private scratch reasoning — it never reaches the player. If you have nothing to say to the owner this turn, do not produce text.',
```

8. **Push loopHistory at loop terminal.** In `handleDispatch`'s `finally` block (orchestrator.js:576-581), BEFORE clearing `currentLoop = null`, call:
```js
try {
  convoMemory.loopHistory.push({
    loopId: loop.id,
    startedAt: loop.startedAt,
    endedAt: Date.now(),
    event,
    loopMessages: loop._internal.messages,
  })
} catch (err) {
  logger.warn?.(`[sei/orch] convoMemory.loopHistory.push failed: ${err.message}`)
}
```
Place this AFTER the existing `if (signal) try { signal.removeEventListener... }` line and BEFORE `currentLoop = null`. (Doing it before `currentLoop = null` means the memory state is consistent with `currentLoop !== null` semantics for any other observers — though there are none currently.)

9. **Wire `recordIncomingChat` to the new module.** Replace the public method (orchestrator.js:916):
```js
recordIncomingChat: (who, text) => convoMemory.recentChat.pushOwner(who, text),
```
The chat.js call site is unchanged — it still calls `orchestrator.recordIncomingChat(username, message)`.

10. Update `_internal` exports — drop nothing else, but add `convoMemory` for the verify harness:
```js
get convoMemory() { return convoMemory },
```

11. Drop the `chat: z.object({ mode: ... }).default({})` schema from src/config.js (the dev/prod chat-mode toggle). Drop `"chat": { "mode": "prod" }` if present in config.json (it's not in the file currently — verify with grep). Drop `chat: { mode: 'prod' }` from src/cli/index.js (line 60). Drop the chat-mode comment block in src/config.js (lines 39-48). NOTE: the chat config block is added to Task 1's removals if it overlaps with the chatModeGuidance work — coordinate by doing this here in Task 2 only if Task 1 hasn't already removed it. To be unambiguous: REMOVE the chat-mode config knob in Task 2.

**src/behaviors/chat.js:**
- The `orchestrator?.recordIncomingChat?.(username, message)` call (line 37) stays unchanged. The orchestrator's facade now writes to convoMemory under the hood.

**Single commit at end:** `feat(260505-iqo): convoMemory split-buffer + loopHistory + say/think separation`. Body lists: new src/llm/convoMemory.js with recentChat (owner/self split, capacity 10 each) + loopHistory (capacity 20, title synthesized from first say + tool freq, no extra API call); deleted src/llm/chatRingBuffer.js; rewired composeSeedBlocks to emit recent_loop_history + recent_owner_chat + your_recent_messages blocks; assistant text is now private (no bot.chat fallback, no memory push); say() is the sole player-visible channel; chat-mode config knob removed.
  </action>
  <verify>
    <automated>
# convoMemory module imports and exposes the expected shape:
node -e "import('./src/llm/convoMemory.js').then(m => { const cm = m.createConvoMemory(); cm.recentChat.pushOwner('alice','hi'); cm.recentChat.pushSelf('sei','yo'); cm.loopHistory.push({loopId:'l1',startedAt:Date.now()-1000,endedAt:Date.now(),event:'sei:idle',loopMessages:[{role:'assistant',content:[{type:'tool_use',name:'say',input:{text:'hello world'}},{type:'tool_use',name:'goTo',input:{}}]}]}); const ob=cm.recentChat.formatOwnerBlock(); const sb=cm.recentChat.formatSelfBlock(); const lh=cm.loopHistory.formatBlock(); if(!ob||!ob.includes('alice')){console.error('owner block fail');process.exit(1)} if(!sb||!sb.includes('Do NOT repeat')){console.error('self block fail');process.exit(1)} if(!lh||!lh.includes('hello world')||!lh.includes('goTo')){console.error('loopHistory fail: '+lh);process.exit(1)} console.log('OK')})"
# chatRingBuffer file deleted:
test ! -f src/llm/chatRingBuffer.js
# Orchestrator imports the new module and exposes convoMemory:
grep -q 'createConvoMemory' src/llm/orchestrator.js
grep -q "from './convoMemory.js'" src/llm/orchestrator.js
! grep -q 'createChatRingBuffer\|chatRingBuffer' src/llm/orchestrator.js
# composeSeedBlocks emits the three new block names:
grep -q 'recent_loop_history' src/llm/orchestrator.js
grep -q 'recent_owner_chat' src/llm/orchestrator.js
grep -q 'your_recent_messages' src/llm/orchestrator.js
! grep -q "name: 'recent_chat'" src/llm/orchestrator.js
# say/think separation: no bot.chat in the text-fallback paths anymore.
# (Look for the old patterns; they should be gone.)
! grep -E "bot\.chat\(text\)|bot\.chat\(midText\)" src/llm/orchestrator.js
# chat-mode toggle gone:
! grep -q 'chat: { mode' src/config.js
! grep -q '"chat"' config.json
! grep -q "chat: { mode" src/cli/index.js
# Orchestrator still constructs:
node -e "import('./src/llm/orchestrator.js').then(m => { console.log(typeof m.createOrchestrator==='function'?'OK':'FAIL') }).catch(e=>{console.error(e.message);process.exit(1)})"
    </automated>
  </verify>
  <done>
- src/llm/convoMemory.js exists with createConvoMemory exporting recentChat (pushOwner, pushSelf, formatOwnerBlock, formatSelfBlock) and loopHistory (push, formatBlock).
- src/llm/chatRingBuffer.js deleted.
- composeSeedBlocks emits blocks named recent_loop_history / recent_owner_chat / your_recent_messages in the documented order.
- say() tool handler is the sole site that calls bot.chat() and pushes to convoMemory.recentChat.pushSelf.
- Terminal-text and mid-text branches log at debug only, never call bot.chat or push to memory.
- SYSTEM_INSTRUCTIONS contains the explicit "say is the only player channel; text is private scratch" rule.
- handleDispatch finally block calls convoMemory.loopHistory.push(...) at every loop terminal.
- Chat-mode config knob removed from config.js, config.json, cli/index.js.
- recordIncomingChat public method routes through convoMemory.recentChat.pushOwner.
- Single git commit `feat(260505-iqo): convoMemory split-buffer + loopHistory + say/think separation`.
  </done>
</task>

<task type="auto">
  <name>Task 3: Idle timing split — sei:loop_end event + 60s idle fallback + per-event seed prompt</name>
  <files>
src/fsm.js,
src/llm/orchestrator.js,
.planning/STATE.md
  </files>
  <action>
Separate the end-of-loop tick from the 60s idle fallback. Today the FSM's `resetIdleTimer()` runs only inside `processNext` — meaning if a Loop completes without any new events, the next `sei:idle` doesn't fire until 60s after the LAST event went through processNext (which can be ~immediately, leaving the bot to wait 60s after every loop). Worse, the bot has no way to react "I just finished a thing, what next?" — it has to wait for an idle tick that's actually meant for "nothing's happening".

This task adds a `sei:loop_end` event that fires after every real-activity loop, with a different seed prompt that nudges the model to continue toward a sub-goal rather than wait passively. The 60s `sei:idle` fallback stays for "actually nothing's happened". Both events reset the idle timer.

**src/fsm.js:**

1. Add a new priority constant. Update `Priority` (lines 14-19):
```js
export const Priority = Object.freeze({
  P0_SAFETY: 0,
  P1_CHAT: 1,
  P2_MOVEMENT: 2,
  P2_5_LOOP_END: 2.5,  // 260505-iqo: above idle, below movement; preempts a queued idle but yields to chat.
  P3_IDLE: 3,
})
```

2. After the existing `bot.on('sei:joined', ...)` listener (line 166), add:
```js
// 260505-iqo: end-of-loop tick. Distinct from sei:idle (60s fallback). Fires
// after every real-activity loop terminal so the model can decide "continue
// toward a sub-goal" instead of waiting for the idle fallback. The
// orchestrator emits this event from its handleDispatch finally block, with
// data.originatingEvent set to the event that started the just-finished loop
// — we suppress the daisy-chain by NOT enqueueing a fresh sei:loop_end when
// the just-finished loop was itself triggered by sei:loop_end.
bot.on('sei:loop_terminal', (data) => {
  // Reset the idle timer so the 60s countdown restarts from the actual end of
  // activity, not from whenever processNext last ran.
  resetIdleTimer()
  // Daisy-chain suppression:
  if (data?.originatingEvent === 'sei:loop_end') return
  enqueue(Priority.P2_5_LOOP_END, 'sei:loop_end', { originatingEvent: data?.originatingEvent ?? null })
})
```

3. Remove the `resetIdleTimer()` call inside `processNext` (line 108). Justification: the previous behavior reset the idle timer every time the FSM dequeued an event. With the new `sei:loop_terminal` listener, both event-dispatch (via the existing `bot.on(...)` handlers feeding `enqueue`) AND loop-completion drive `resetIdleTimer()`. The event-side coverage is implicit — every event that arrives via FSM also produces a `sei:loop_terminal` when its dispatch loop ends, and `sei:loop_terminal` resets the timer. To make this airtight, ALSO call `resetIdleTimer()` inside `enqueue` (right after the `queue.sort` line, line 71). That guarantees: any event ingestion resets the timer immediately AND every loop-terminal resets it. Safe to call twice (clearTimeout + setTimeout is idempotent).

   Final wiring in `enqueue`:
```js
queue.push({ priority, event, data })
queue.sort((a, b) => a.priority - b.priority)
resetIdleTimer()  // 260505-iqo: any event ingestion postpones the idle fallback.
scheduleProcess()
```

4. Add the new event to `handleEvent` switch (line 132-156) — just a no-op case so the orchestrator (which listens to `sei:dispatch`) drives behavior:
```js
case 'sei:loop_end': {
  // 260505-iqo: orchestrator handles via sei:dispatch above.
  break
}
```

**src/llm/orchestrator.js:**

1. **Emit `sei:loop_terminal` from the finally block.** In `handleDispatch`'s `finally` (orchestrator.js:576-581, after Task 2's loopHistory push), add:
```js
try {
  bot.emit('sei:loop_terminal', { loopId: loop.id, originatingEvent: event })
} catch (err) {
  logger.warn?.(`[sei/orch] sei:loop_terminal emit failed: ${err.message}`)
}
```
Place this AFTER `convoMemory.loopHistory.push(...)` and BEFORE `currentLoop = null`. The FSM's listener will fire synchronously on emit, but its work (resetTimer + maybe enqueue) is non-blocking; the enqueued `sei:loop_end` runs through the normal queue → processNext → sei:dispatch path AFTER `currentLoop = null`, so the orchestrator's single-flight gate accepts it.

2. **Per-event seed prompt addendum.** In the seed-block path inside `handleDispatch` (around orchestrator.js:515 where `eventText` is constructed), branch the addendum:
```js
let eventAddendum = ''
if (event === 'sei:loop_end') {
  eventAddendum = '\n\nYou just finished a task. Decide: continue toward a related sub-goal, propose a follow-up, or settle. Do not re-ask anything you already asked recently. Do not ask the owner what to do — pick something yourself; you can always change course later.'
} else if (event === 'sei:idle' || event === 'idle') {
  eventAddendum = '\n\n60 seconds have passed with no activity. You are a peer, not a subordinate — pick something to do. Asking the owner what to do is a last resort. Never repeat a question you already asked.'
}
const eventText = `Event: ${event}\nData: ${formatEventData(event, data)}${eventAddendum}`
```
Replace the existing `const eventText = ...` line. The addendum is concatenated into the existing event block — no new block name needed; the model already reads the event block as steering input.

3. **Remove the passive framing from SYSTEM_INSTRUCTIONS.** Find the line `'You are a Minecraft companion bot. You react to chat, world events, and idle ticks.'` (the renamed COMBINED_SYSTEM, post-Task-1) and replace with:
```
'You are a Minecraft companion bot. You are a peer to the owner — pick things to do, decide what is interesting, propose plans. Reacting to chat and world events is part of the job; waiting passively for instructions is not.',
```

4. **STATE.md update.** Append to the Decisions section:
```
- Idle/loop-end split (260505-iqo): FSM emits `sei:loop_end` (P2.5) at every real-activity loop terminal via `sei:loop_terminal`; `sei:idle` (P3) keeps its 60s fallback. Daisy-chain suppressed (a sei:loop_end loop does NOT trigger another sei:loop_end). Both events reset the idle timer; `enqueue` also resets it on every ingestion.
```

5. **STATE.md "Quick Tasks Completed" entry.** Append the row from Task 1's deferred update, now with the actual final commit hash for Task 3 (the executor will fill this in via `git rev-parse HEAD` AFTER the Task 3 commit lands):
```
| 260505-iqo | API-only refactor + convoMemory + idle/loop-end split | 2026-05-05 | <fill-from-git-rev-parse-HEAD> | [260505-iqo-...](./quick/260505-iqo-memory-and-loop-architecture-refactor-bu/) |
```

**Single commit at end:** `feat(260505-iqo): split idle from loop-end events; per-event seed prompts`. Body: new sei:loop_end event at P2.5 between movement and idle; FSM listens for sei:loop_terminal (emitted by orchestrator finally block); enqueues sei:loop_end except when originating event was already sei:loop_end (no daisy-chain); both events reset idle timer; orchestrator branches the seed event text by event type (loop_end → "decide next sub-goal", idle → "pick something, last resort to ask owner"); SYSTEM_INSTRUCTIONS reframed as peer not reactor.
  </action>
  <verify>
    <automated>
# Priority constant present:
grep -q 'P2_5_LOOP_END' src/fsm.js
# loop_terminal listener wired:
grep -q "bot.on('sei:loop_terminal'" src/fsm.js
# Daisy-chain suppression:
grep -q "originatingEvent === 'sei:loop_end'" src/fsm.js
# Idle timer reset moved into enqueue + still in loop_terminal listener:
test "$(grep -c 'resetIdleTimer()' src/fsm.js)" -ge 3
# Orchestrator emits sei:loop_terminal:
grep -q "bot.emit('sei:loop_terminal'" src/llm/orchestrator.js
# Per-event addendum branches present:
grep -q "event === 'sei:loop_end'" src/llm/orchestrator.js
grep -q "event === 'sei:idle'" src/llm/orchestrator.js
# Passive framing replaced (the new line is present):
grep -q 'peer to the owner' src/llm/orchestrator.js
! grep -q 'You react to chat, world events, and idle ticks' src/llm/orchestrator.js
# FSM still constructs cleanly:
node -e "import('./src/fsm.js').then(m=>{const stub={on:()=>{},emit:()=>{},once:()=>{}};m.createFSM(stub,{llm:{idle_fallback_ms:1000}},{});console.log('OK')}).catch(e=>{console.error(e.message);process.exit(1)})"
# End-to-end smoke: simulate a loop_terminal emission and verify enqueue happens (and is suppressed for sei:loop_end origin):
node -e "
import('./src/fsm.js').then(m => {
  const events = [];
  const listeners = {};
  const bot = {
    on: (e, h) => { (listeners[e] = listeners[e] || []).push(h); },
    once: () => {},
    emit: (e, d) => { (listeners[e] || []).forEach(h => h(d)); events.push({e, d}); },
  };
  const fsm = m.createFSM(bot, { llm: { idle_fallback_ms: 60000 } }, {});
  // Fire a loop_terminal from a sei:idle origin → should enqueue sei:loop_end:
  bot.emit('sei:loop_terminal', { originatingEvent: 'sei:idle' });
  // Fire a loop_terminal from a sei:loop_end origin → should NOT enqueue:
  bot.emit('sei:loop_terminal', { originatingEvent: 'sei:loop_end' });
  // The dispatch order is async; rely on processNext scheduling. We just
  // confirm the listener was wired without throwing.
  console.log('OK');
}).catch(e => { console.error(e.message); process.exit(1); });
"
    </automated>
  </verify>
  <done>
- src/fsm.js has Priority.P2_5_LOOP_END = 2.5 and a `bot.on('sei:loop_terminal', ...)` listener that resets the idle timer and enqueues sei:loop_end (with daisy-chain suppression).
- enqueue() resets the idle timer on every ingestion.
- src/llm/orchestrator.js emits `sei:loop_terminal` from handleDispatch's finally block with `{ loopId, originatingEvent: event }`.
- Seed `eventText` is suffixed with a per-event addendum: loop_end → "decide next sub-goal, do not re-ask" / idle → "peer not subordinate, pick something" / others → unchanged.
- SYSTEM_INSTRUCTIONS opens with peer framing instead of "you react to chat, world events, and idle ticks".
- STATE.md Decisions section documents the split. Quick Tasks Completed table appended with the 260505-iqo row (real commit hash filled in).
- Single git commit `feat(260505-iqo): split idle from loop-end events; per-event seed prompts`.
  </done>
</task>

</tasks>

<verification>
After all three commits land:

1. **Tree-wide grep for dead symbols (must be empty):**
   ```sh
   grep -rn --include='*.js' --include='*.json' \
     'ollamaClient\|createOllamaClient\|MOVEMENT_SYSTEM\|callPersonalityTwoCall\|callPersonalityCombined\|callMovement\|handOffToMovement\|executorStatus\|DEV_CHAT_GUIDANCE\|PROD_CHAT_GUIDANCE\|chatModeGuidance\|createChatRingBuffer\|chatRingBuffer\|recent_chat' \
     src scripts
   ```
   Expected: zero matches.

2. **Files deleted:**
   ```sh
   test ! -f src/llm/ollamaClient.js
   test ! -f src/llm/circuit.js
   test ! -f src/llm/chatRingBuffer.js
   test -f src/llm/convoMemory.js
   ```

3. **All three modules import cleanly:**
   ```sh
   node -e "import('./src/llm/orchestrator.js').then(()=>console.log('orch OK'))"
   node -e "import('./src/llm/convoMemory.js').then(()=>console.log('convo OK'))"
   node -e "import('./src/fsm.js').then(()=>console.log('fsm OK'))"
   ```

4. **Three commits present in `git log`:**
   - `refactor(260505-iqo): collapse two-layer LLM to API-only single combined call`
   - `feat(260505-iqo): convoMemory split-buffer + loopHistory + say/think separation`
   - `feat(260505-iqo): split idle from loop-end events; per-event seed prompts`

5. **Smoke test against the live bot (manual; not automated):** start the bot, observe that:
   - At connect: `[sei] Sei online.` (no executor mention).
   - First loop runs, emits `[sei/orch] loop start (id=loop-1-..., event=sei:joined)` → `loop terminal` → followed shortly by another `loop start (id=loop-2-..., event=sei:loop_end)`.
   - `[chat->]` lines come ONLY from `say` tool calls; no relayed text fallbacks.
   - Idle fallback fires 60s after the LAST event ingestion or loop terminal, not 60s from process start.
</verification>

<success_criteria>
- Three atomic commits, each independently buildable.
- Zero references to ollama, circuit, handOffToMovement, callMovement, callPersonalityTwoCall/Combined, executorStatus, DEV_CHAT_GUIDANCE, PROD_CHAT_GUIDANCE, chatModeGuidance, createChatRingBuffer in src/ and scripts/.
- src/llm/convoMemory.js exposes the documented createConvoMemory shape with split owner/self recentChat sub-buffers (capacity 10 each, 240-char truncation) and loopHistory (capacity 20).
- composeSeedBlocks emits exactly six block names in order: seed_owner, seed_diary, recent_loop_history, recent_owner_chat, your_recent_messages, event, snapshot — with cache_control on seed_diary only. Optional blocks (recent_*) skip when their formatter returns null.
- Assistant `text` is logged at debug level only and never reaches bot.chat or convoMemory.
- FSM emits a sei:loop_end event at P2.5 priority for every loop_terminal that did NOT originate from sei:loop_end; enqueue() and the loop_terminal listener both reset the idle timer.
- Per-event seed addendum differentiates loop_end from idle from default.
- CLAUDE.md and .planning/STATE.md decisions reflect the new single-layer + idle/loop-end split architecture, with a Quick Tasks Completed entry for 260505-iqo.
</success_criteria>

<output>
No SUMMARY file required for quick-mode tasks; the three commit messages and the STATE.md update collectively serve as the trail.
</output>
