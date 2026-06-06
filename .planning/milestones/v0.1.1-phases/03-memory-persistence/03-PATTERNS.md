# Phase 3: Memory & Persistence — Pattern Map

**Mapped:** 2026-04-30
**Files analyzed:** 10 (5 NEW + 5 MODIFIED)
**Analogs found:** 9 / 10 (atomicWrite has no in-repo analog — first storage helper)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| NEW `src/llm/loop.js` | factored stateful module (class-like factory) | request-response state accumulator | `src/llm/inflight.js` (factory + private state + small public API) AND `src/llm/goals.js` (encapsulated mutable list with snapshot) AND `src/llm/chains.js` (lifecycle: begin / continue / increment / end) | exact (role + data flow) |
| NEW `src/storage/atomicWrite.js` | utility (file I/O helper) | file-I/O (one-shot write) | *None in repo* — closest is the plain `readFileSync` in `src/config.js:41`; this phase introduces the storage layer | no analog (introduce pattern from RESEARCH.md Pattern 3) |
| NEW `src/memory/owner.js` | service (read/parse/write OWNER.md) | file-I/O + transform | `src/config.js:40-47` (read-from-disk + Zod-shaped parse + safe defaults) for the read+parse half; `atomicWrite.js` for write half | role-match (file read+parse) |
| NEW `src/memory/diary.js` | service (append/slice/consolidate DIARY.md) | file-I/O + batch transform | `src/llm/goals.js` (encapsulated list with controlled mutators + `snapshot()`) + future `atomicWrite.js` | partial (encapsulation pattern only — file-batch transform is novel) |
| NEW `src/llm/sessionState.js` | factored stateful module (counters + handlers) | event-driven (player join/leave) | `src/llm/inflight.js` (factory pattern, mutable singleton entry) AND `src/llm/chains.js` (lifecycle counters + TTL sweep) | exact |
| NEW `src/llm/compaction.js` | service (Anthropic call dispatcher) | request-response (LLM call) | `src/llm/orchestrator.js:225-253` (`callPersonality` / `callCombined` — same Haiku, same cached prefix, AbortSignal+timeout plumbing) | exact |
| MODIFIED `src/llm/orchestrator.js` | controller (dispatch shell) | event-driven dispatcher | itself (current shape is the analog; refactor preserves the dispatch loop skeleton at lines 255-436 while replacing per-call message construction) | self-refactor |
| MODIFIED `src/llm/anthropicClient.js` | client (SDK wrapper) | request-response | itself — extend the JSDoc on `messages` param to allow `ContentBlockParam[]` (already accepted at runtime; SDK type union supports it) | self-extension |
| MODIFIED `src/bot.js` | wiring (event listeners) | event-driven | `src/bot.js:68-90` (existing `bot.on('spawn'/'death'/'error'/'kicked'/'end')` block — add `playerJoined`/`playerLeft` in the same shape) | exact |
| MODIFIED `src/config.js` | config (Zod schema) | config load | `src/config.js:14-37` (existing nested `persona`/`anthropic`/`ollama`/`llm` Zod blocks with `.default({})`) | exact |

## Pattern Assignments

### NEW `src/llm/loop.js` (factored stateful module, request-response state accumulator)

**Primary analog:** `src/llm/inflight.js` (factory + closure-private state + small public API).
**Secondary analog:** `src/llm/chains.js` (lifecycle methods: begin/continue/increment/end with sweep), `src/llm/goals.js` (encapsulation + snapshot getter).

This is the closest factored-module precedent in the repo. Phase 2/2.1 factored `goalStore`, `inflight`, `persona`, `circuit`, `chains` into single-file factories that return a small object with closure-trapped state. D-38 explicitly tells you to mirror that. Use Loop as a `createLoop(...)` factory (consistent with the rest of `src/llm/`), not a literal `class`.

**Imports pattern** (from `src/llm/inflight.js:1-13` and `src/llm/chains.js:1-16`):
```javascript
// Header JSDoc explaining role + collaborators
// No-default exports of named factory functions only
// Private module-level counters (e.g. _nextId) live above the factory
```

**Factory + closure-private state pattern** (from `src/llm/inflight.js:19-48`):
```javascript
let _nextId = 1

export function createInflightTracker() {
  /** @type {{ id:number, name:string, args:any, startedAt:number } | null} */
  let entry = null

  function start({ name, args }) {
    const handle = { id: _nextId++, name, args, startedAt: Date.now() }
    entry = handle
    return handle
  }

  function end(handle) {
    if (entry && handle && entry.id === handle.id) entry = null
  }

  function current() { return entry }
  function currentBlocking() { /* …filtered view… */ }

  return { start, end, current, currentBlocking }
}
```

**Lifecycle methods pattern** (from `src/llm/chains.js:17-52`) — mirrors D-44's `appendUserTurn` / `appendAssistant` / `appendToolResults` / `buildAnthropicPayload` shape:
```javascript
export function createChainTracker({ maxHops, ttlMs = 60_000 }) {
  const chains = new Map()
  let counter = 0

  function begin(seedEvent)    { /* … */ return id }
  function continueChain(id)   { /* … */ return chains.get(id) ?? null }
  function increment(id)       { /* … */ return { hops, capped, missing } }
  function end(id)             { chains.delete(id) }

  return { begin, continue: continueChain, increment, end, size, _internal: { chains } }
}
```

**Encapsulation + snapshot getter pattern** (from `src/llm/goals.js:5-29`) — Loop's `messages` array stays canonical (D-43); expose a getter that returns a copy or the live array, NOT a mutator:
```javascript
return {
  get owner_goals() { return [...owner_goals] },
  get self_goals()  { return [...self_goals] },
  add(list, goal) { /* controlled mutator */ },
  snapshot() {
    return { owner_goals: [...owner_goals], self_goals: [...self_goals] }
  },
}
```

**Test seam pattern** (from `src/llm/chains.js:51`): expose `_internal: { messages }` so harness scripts in `scripts/verify-phase3-loop.js` can byte-assert the canonical array is never mutated by `buildAnthropicPayload()`.

---

### NEW `src/storage/atomicWrite.js` (utility, file-I/O)

**Analog:** *None in repo.* The only existing fs usage is `readFileSync` in `src/config.js:41`. This phase introduces the storage layer. Use the canonical pattern from `03-RESEARCH.md` Pattern 3 (lines 259-274) and the verified shape in RESEARCH "Atomic write idiom" example (lines 419-431).

**Module-header pattern** (mirroring `src/llm/inflight.js:1-13` JSDoc style):
```javascript
/**
 * Atomic file replace via tmp + rename. Standard Unix idiom — kernel rename(2)
 * is atomic on the same filesystem, so readers either see the old file or the
 * new one, never a partial write.
 *
 * Tmp file MUST live in the same directory as target (NOT os.tmpdir()) to avoid
 * EXDEV cross-filesystem rename errors.
 *
 * Used by: src/memory/owner.js, src/memory/diary.js, compaction rewrites.
 */
```

**Implementation** (verbatim from RESEARCH.md lines 423-431, the verified pattern):
```javascript
import { writeFile, rename } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

export async function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}.${Date.now()}`)
  await writeFile(tmp, contents, 'utf8')
  await rename(tmp, path)
}
```

**Pitfall guards to encode** (from RESEARCH.md "Pitfalls" lines 270-274):
- Tmp must be in same dir as target (NOT `os.tmpdir()`) — research-locked.
- No fsync needed for v1 (CONTEXT/SPEC do not require crash-durability).

---

### NEW `src/memory/owner.js` (service, file-I/O + transform)

**Read/parse analog:** `src/config.js:40-47` (read-from-disk + parse + safe defaults pattern).
**Write analog:** `src/storage/atomicWrite.js` (this phase, see above).

**Read+parse+default pattern** (from `src/config.js:40-47`):
```javascript
export function loadConfig(path = './config.json') {
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  // Safe-default fallback for missing field (matches D-48 "fall back to first-chat resolution")
  if (!raw.anthropic?.api_key) {
    raw.anthropic = { ...(raw.anthropic ?? {}), api_key: process.env.ANTHROPIC_API_KEY ?? '' }
  }
  return ConfigSchema.parse(raw)
}
```

Apply the same shape to OWNER.md: `loadOwner(path)` returns `{ owner_uuid, owner_username, first_seen, last_seen, total_sessions, preferred_name, pronouns, notes }` with safe defaults (treat absent file as fresh-install per SPEC A6 / line 91 — return placeholder, do not throw).

**Frontmatter parse strategy** (from RESEARCH.md "Don't Hand-Roll" line 301): flat `^([a-z_]+):\s*(.*)$` regex, no `js-yaml` dep. v1 fields are flat per D-47.

**Validation tolerance** (from RESEARCH.md V5 / Security row): "v1 reads what's there and ignores fields it doesn't understand" (SPEC line 82). Do not throw on unknown frontmatter keys; tolerate missing fields with placeholders.

---

### NEW `src/memory/diary.js` (service, file-I/O + batch transform)

**Encapsulation analog:** `src/llm/goals.js:5-29` (small public API guarding a list).
**Append/slice analog:** *Novel* — no in-repo precedent for append-newest-first markdown. Follow D-49 / D-50 prose.

**Module shape mirroring goals.js** (controlled mutators, no direct list exposure):
```javascript
export function createDiary({ path, seedDiaryBudgetBytes }) {
  // private cache; lazy-load on first read
  let cached = null

  async function readAll()         { /* fs.readFile + parse, treat absent as empty */ }
  async function appendEntry(text) { /* prepend new entry, atomicWrite */ }
  async function seedSlice()       { /* newest-first byte-budget walk, D-50 */ }
  async function consolidateOlderHalf(rewriter) { /* D-54 */ }

  return { readAll, appendEntry, seedSlice, consolidateOlderHalf }
}
```

**Heading format pattern** (locked at CONTEXT.md line 71, D-49): `## YYYY-MM-DD HH:MM — <topic>` deterministic prefix; topic from LLM summary's first chunk (≤ ~6 words).

**Atomic-write coupling:** Every write goes through `src/storage/atomicWrite.js` (D-59 / SPEC line 90).

**Mutex pattern for consolidation race** (from RESEARCH.md "Pitfall 7" lines 363-367): module-level `let consolidationLock = false`; per-loop-batch waits or drops if locked. Keep in this file (single source of truth for diary writes).

---

### NEW `src/llm/sessionState.js` (factored stateful module, event-driven)

**Primary analog:** `src/llm/inflight.js` (factory + closure singleton).
**Secondary analog:** `src/llm/chains.js:17-52` (lifecycle counters + sweep).

**Public API shape** (from D-56 / D-57 / D-58 + RESEARCH.md recommended structure line 207):
```javascript
export function createSessionState({ ownerMd, diary, config, logger }) {
  // private counters (D-51, D-53)
  let loopCount = 0
  let cumulativeLoopBytes = 0
  let sessionsSinceConsolidation = 0
  let activeOwnerUuid = null  // null when owner not present

  function onPlayerJoined(player) { /* D-56 + D-48 cold path */ }
  function onPlayerLeft(player)   { /* D-56 session-end + flush */ }
  function onLoopTerminal(loop)   { /* D-51 trigger check + DIARY append */ }
  function onSpawn()              { /* D-57 settle-delay owner check */ }
  function ownerPresent()         { return activeOwnerUuid != null }

  return { onPlayerJoined, onPlayerLeft, onLoopTerminal, onSpawn, ownerPresent, _internal: { /* counters for tests */ } }
}
```

**Owner UUID resolution** (verified shape from RESEARCH.md lines 433-444 + mineflayer source):
```javascript
const player = bot.players[config.owner_username]
const uuid = player?.uuid
// uuid undefined → owner not connected (or settle delay not yet elapsed)
// uuid present → write OWNER.md atomically
```

**Settle-delay pattern** (RESEARCH.md "Pitfall 2" lines 333-337): ~500ms `setTimeout` after `bot.on('spawn')`, plus belt-and-suspenders one-shot `bot.once('playerJoined', ...)` listener for the "owner connects after Sei" race.

---

### NEW `src/llm/compaction.js` (service, request-response LLM call)

**Analog:** `src/llm/orchestrator.js:225-253` (`callPersonality` and `callCombined` — same Haiku model, same cached prefix, AbortSignal + timeout plumbing).

**Anthropic call pattern** (verbatim shape from `src/llm/orchestrator.js:225-236`):
```javascript
async function callPersonality(userBlock, signal) {
  if (!personalityBucket.tryAcquire()) {
    logger.warn('[sei/orch] Rate limit hit — dropping personality call')
    return null
  }
  return await anthropic.call({
    systemBlocks: cachedSystemBlocks,
    tools: personalityTools,
    messages: [{ role: 'user', content: userBlock }],
    signal,
  })
}
```

**Apply to compaction:**
- Reuse the SAME `cachedSystemBlocks` (D-52 / RESEARCH.md "Pitfall 4" lines 345-349) — DO NOT build a new system prefix; this is the cache-hit guarantee.
- Tools = `[]` (compaction is text-only; no tool_use expected).
- `messages` = concatenation of recent `Loop.messages` since last DIARY write + final user turn carrying the prompt body from D-52.
- `signal` plumbed through from caller (sessionState terminal hook); timeout via `anthropic.call({timeoutMs})` per CLAUDE.md ADR #5.

**Two prompts to encode** (D-52 per-loop-batch, D-54 consolidation): export `summarizeLoopBatch(messages, signal)` and `consolidateOlderHalf(diaryText, signal)`. Both go through `anthropic.call` (NOT a separate client).

---

### MODIFIED `src/llm/orchestrator.js` (controller, dispatch shell)

**Analog:** itself — the existing dispatch loop at lines 255-436 is the skeleton to preserve. The refactor replaces only the four `messages: [{ role: 'user', content: ... }]` constructions (lines 204, 209, 233, 250) with Loop method calls.

**Existing call-site pattern to replace** (`src/llm/orchestrator.js:230-235` and `:247-252`):
```javascript
return await anthropic.call({
  systemBlocks: cachedSystemBlocks,
  tools: personalityTools,
  messages: [{ role: 'user', content: userBlock }],   // ← REPLACE
  signal,
})
```

**Replacement shape** (per D-44):
```javascript
loop.appendUserTurn([
  { type: 'text', name: 'snapshot', text: composeSnapshot(...) },
  { type: 'text', name: 'event',    text: `Event: ${event}\nData: ${JSON.stringify(data)}` },
  // …prior tool_results if any
])
const resp = await anthropic.call({
  systemBlocks: cachedSystemBlocks,
  tools: personalityTools,
  messages: loop.buildAnthropicPayload(),
  signal,
})
loop.appendAssistant(resp.content)  // raw assistant blocks for tool_use/tool_result invariant
// …dispatch tool_uses…
loop.appendToolResults(results, { snapshot: composeSnapshot(...) })
```

**Abort/synth-tool_result pattern** (NEW per D-40, no in-repo analog — see RESEARCH.md Pattern 2 lines 252-258 + code example lines 401-417). Bolt onto the existing catch block at `src/llm/orchestrator.js:419-435`:
```javascript
// In the catch when err.name === 'AbortError' || signal.aborted:
const lastAssistant = /* last assistant turn from loop.messages */
const abortedResults = lastAssistant.content
  .filter(b => b.type === 'tool_use')
  .map(u => ({ type: 'tool_result', tool_use_id: u.id, content: 'aborted: player interrupt', is_error: false }))
loop.appendUserTurn([
  ...abortedResults,
  { type: 'text', name: 'event', text: `PLAYER INTERRUPT: ${chatText}` },
  { type: 'text', name: 'snapshot', text: composeSnapshot(...) },
])
```

**Single-flight gating pattern** (NEW per RESEARCH.md "Pitfall 6" lines 358-361): `let currentLoop = null` at orchestrator scope; gate idle dispatches AND interrupt routing through it.

**Preserve existing infrastructure** (per SPEC line 92): `inflight`, `chains` (or noop-stub per RESEARCH.md Open Question 1), `circuit`, `personalityBucket`, `ingressDebouncer`, `ingressThrottle`, `lastActionResult`, container cleanup at lines 268, 293, 332, 390, 394, 399, 423, 428, 433.

---

### MODIFIED `src/llm/anthropicClient.js` (client, request-response)

**Analog:** itself — only the JSDoc on `call({ messages })` at line 17 widens to permit `ContentBlockParam[]` content (already accepted at runtime; SDK type union supports it per RESEARCH.md line 130).

**No code change to call-body required.** The existing `sdk.messages.create` at line 25 passes `messages` straight through; the SDK union already accepts both `string` and block-array content.

**JSDoc widening** (line 17 currently):
```javascript
* @param {{role:'user'|'assistant',content:any}[]} req.messages
```
Tighten to document the new shape:
```javascript
* @param {{role:'user'|'assistant',content:string|ContentBlockParam[]}[]} req.messages  // user content may be ContentBlockParam[] per Phase 3 D-42
```

**Cache-control invariant** (preserve `src/llm/anthropicClient.js:62-73`): the cached prefix in `buildCachedSystem` keeps `cache_control` on the LAST tool block. Phase 3 must NOT add OWNER/DIARY content to system blocks (RESEARCH.md "Pitfall 4" lines 345-349) — they go in the seed user turn only.

---

### MODIFIED `src/bot.js` (wiring, event-driven)

**Analog:** itself — the existing event-handler block at lines 68-119 is the pattern. Add `playerJoined`/`playerLeft` listeners in the same shape.

**Existing event-handler pattern** (`src/bot.js:68-90`):
```javascript
let _spawned = false
bot.on('spawn', () => {
  logStatus(`Connected to ${config.host}:${config.port} as ${config.username}`)
  if (!_spawned) {
    _spawned = true
    bot.loadPlugin(pathfinder)
    startPosHealer(bot)
    startAutoEat(bot)
    /* …other startup wiring… */
    const orchestrator = createOrchestrator({ bot, config, registry, logger: { /* … */ } })
    bot.on('sei:dispatch', ({ event, data, signal }) => { orchestrator.handleDispatch(event, data, signal) })
    /* … */
  } else {
    startFollow(bot, config)
  }
})
```

**Apply to Phase 3** — add to the same `if (!_spawned)` block (D-56 / D-57):
```javascript
const sessionState = createSessionState({ ownerMd, diary, config, logger: ... })
bot.on('playerJoined', (player) => sessionState.onPlayerJoined(player))
bot.on('playerLeft',   (player) => sessionState.onPlayerLeft(player))
// D-57 settle delay for cold-start owner-already-present
setTimeout(() => sessionState.onSpawn(), 500)
```

**Reconnect / disconnect untouched** (lines 105-119): D-58 — bot disconnect ≠ session end. Do NOT add session-end calls into `bot.on('end')`.

---

### MODIFIED `src/config.js` (config, Zod schema)

**Analog:** itself — extend the existing nested-block pattern at lines 14-37.

**Existing nested-block pattern** (`src/config.js:14-37`):
```javascript
persona: z.object({
  name: z.string().min(1),
  backstory: z.string(),
  tone: z.enum(['friendly', 'sarcastic', 'serious', 'curious']),
}),
anthropic: z.object({
  api_key: z.string().min(1),
  model: z.string().default('claude-haiku-4-5-20251001'),
  timeout_ms: z.number().int().min(1000).default(20_000),
}),
ollama: z.object({
  host: z.string().default('http://127.0.0.1:11434'),
  model: z.string().default('qwen3.5:7b-instruct'),
  timeout_ms: z.number().int().min(1000).default(30_000),
}).default({}),
llm: z.object({
  rate_limit_per_min: z.number().int().min(1).default(30),
  debounce_ms: z.number().int().min(0).default(500),
  max_hops: z.number().int().min(1).default(5),
  idle_fallback_ms: z.number().int().min(1000).default(10_000),
  executor: z.enum(['auto', 'api']).default('auto'),
}).default({}),
```

**Apply to Phase 3** (per D-59):
```javascript
memory: z.object({
  owner_md_path: z.string().default('./OWNER.md'),
  diary_md_path: z.string().default('./DIARY.md'),
  iteration_cap: z.number().int().min(1).default(20),
  loop_batch_loop_count_cap: z.number().int().min(1).default(10),
  loop_batch_context_cap_bytes: z.number().int().min(1024).default(32768),
  sessions_per_consolidation: z.number().int().min(1).default(4),
  diary_size_cap_bytes: z.number().int().min(1024).default(204800),
  seed_diary_budget_bytes: z.number().int().min(256).default(3072),
  seed_owner_budget_bytes: z.number().int().min(256).default(1024),
}).default({}),
```

Per RESEARCH.md "State of the Art" line 472: keep `llm.max_hops` for backwards compat but route iteration tracking through `memory.iteration_cap`.

---

## Shared Patterns

### Cached system prefix (do NOT touch)
**Source:** `src/llm/anthropicClient.js:62-73` + `src/llm/orchestrator.js:147-167`
**Apply to:** ALL Anthropic calls in Phase 3 (orchestrator personality, orchestrator combined, compaction summary, compaction consolidation)

```javascript
function buildCachedSystem(systemInstructions, personaText, capabilityParagraph, primer, learningLine, tools) {
  return [
    { type: 'text', text: systemInstructions },
    { type: 'text', text: `${personaText}\n${learningLine}` },
    { type: 'text', text: capabilityParagraph },
    { type: 'text', text: primer },
    { type: 'text', text: toolBlock, cache_control: { type: 'ephemeral' } },
  ]
}
```

OWNER.md / DIARY.md slices go in the **seed user turn**, NOT in any system block. Reuse `cachedSystemBlocks` for compaction calls (zero marginal prefix cost).

### AbortSignal + timeout plumbing
**Source:** `src/llm/anthropicClient.js:23-34`
**Apply to:** All new Anthropic calls in `src/llm/compaction.js`, all loop-internal calls.

```javascript
async function call({ systemBlocks, tools, messages, signal, timeoutMs, maxTokens = 1024 }) {
  /* … */
  const resp = await sdk.messages.create(
    { model, max_tokens: maxTokens, system: systemBlocks, tools: tools?.length ? tools : undefined, messages },
    { signal, timeout: timeoutMs ?? defaultTimeoutMs }
  )
}
```

Per CLAUDE.md ADR #5: every external call has a timeout — no exceptions. `defaultTimeoutMs` from `config.anthropic.timeout_ms`.

### Factored-module shape (`src/llm/*.js`)
**Source:** `src/llm/inflight.js`, `src/llm/goals.js`, `src/llm/chains.js`, `src/llm/circuit.js`
**Apply to:** `src/llm/loop.js`, `src/llm/sessionState.js`, `src/llm/compaction.js`

Common idioms:
- Header JSDoc explaining role + collaborators (`inflight.js:1-13` is canonical).
- Default-export-free; named factory function `createXxx({...deps})`.
- Closure-private state; small public surface returned as plain object.
- Optional `_internal: { ... }` field for harness/tests (`chains.js:51`).
- No I/O at module-load; deps injected via factory args.

### Logger shape
**Source:** `src/bot.js:80` and `src/llm/orchestrator.js:67`
**Apply to:** All new modules taking a `logger` dep.

```javascript
{ info: (m) => logStatus(m), warn: (m) => logStatus(m), error: (m) => logStatus(m) }
```

Default to `console` if logger is omitted: `function createXxx({ logger = console })`.

### Atomic-write contract
**Source:** `src/storage/atomicWrite.js` (NEW this phase)
**Apply to:** All `OWNER.md` and `DIARY.md` writes (D-59, SPEC line 90), including consolidation rewrites.

Tmp file MUST share the target's directory; never `os.tmpdir()`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/storage/atomicWrite.js` | utility | file-I/O | First storage helper in repo. Use the canonical pattern from RESEARCH.md Pattern 3 (verified against Node `fs/promises` docs). |

The append-newest-first markdown logic in `src/memory/diary.js` and the multi-block content array building in `src/llm/loop.js` (D-42) also have no in-repo analog at the *byte* level — but the surrounding factory/encapsulation shells do, so they are not listed here as "no analog". Use RESEARCH.md "Code Examples" (lines 373-417) for the block-shape reference and RESEARCH.md Pattern 1 (lines 224-250) for the trim algorithm.

## Metadata

**Analog search scope:** `src/llm/`, `src/observers/`, `src/`, `src/behaviors/` (not entered — wiring lives in `src/bot.js`).
**Files scanned:** `src/llm/inflight.js`, `src/llm/goals.js`, `src/llm/chains.js`, `src/llm/circuit.js`, `src/llm/persona.js`, `src/llm/orchestrator.js`, `src/llm/anthropicClient.js`, `src/config.js`, `src/bot.js`.
**Pattern extraction date:** 2026-04-30
