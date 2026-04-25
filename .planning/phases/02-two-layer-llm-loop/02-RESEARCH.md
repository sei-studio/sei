# Phase 2: Two-Layer LLM Loop - Research

**Researched:** 2026-04-25
**Domain:** Multi-provider LLM orchestration (Anthropic Messages API + Ollama tool-calling) wired into an existing event-sourced FSM
**Confidence:** HIGH on external API shapes, model availability, and integration seams; MEDIUM on Qwen NL→tool-call reliability (acknowledged as a deferred spike in CONTEXT.md D-05)

## Summary

This phase wires two LLMs into a Phase 1 FSM that already exposes the right hook points (`sei:dispatch` event, P0–P3 priority queue, AbortController-tracked single outstanding action, idle timer at 10s, closed Zod-typed registry). Almost no FSM surgery is required — the work is (1) building a provider-agnostic dispatch layer that can call either Anthropic or Ollama with the same `tools` payload, (2) constructing the cached Anthropic prefix in the right order, (3) enforcing four guardrails (5-hop cap, 500ms debounce, 30/min rate limit, AbortController fan-out), (4) adding a `setGoals` action and the two in-memory goal lists, (5) wiring the persona block into config, and (6) implementing a circuit breaker for the Ollama path with a Haiku-as-executor fallback.

**Primary recommendation:** Implement the orchestrator as a single new module that subscribes to the FSM's existing `sei:dispatch` event, owns hop-count + abort state per event chain, and routes through a thin `LLMClient` interface with two implementations (`AnthropicClient`, `OllamaClient`). Convert the existing Zod registry schemas to JSON Schema once at startup using `zod-to-json-schema` (or Zod 4's native `.toJSONSchema()` if upgrading) and reuse for both providers.

**⚠️ BLOCKER for the planner — model ID:** Claude Haiku 3 (`claude-3-haiku-20240307`) was **retired on April 20, 2026 — five days before this research date**. REQUIREMENTS.md and CONTEXT.md both reference "Haiku 3" by name. The current minimum Haiku is `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`). Phase 2 cannot ship calling Haiku 3. See "User Constraints" below — this needs explicit user acknowledgement before planning.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Tool-Calling Protocol (Movement LLM)**
- D-01: Movement LLM uses native Ollama tool-calling. Zod schemas in the action registry are converted to JSON Schema and passed as `tools` to Ollama; Qwen returns structured `tool_calls` that the orchestrator validates and dispatches.
- D-02: Haiku-as-executor fallback uses Anthropic `tool_use` with the same JSON Schema. One protocol shape, two providers — the dispatch layer is provider-agnostic.
- D-03: Full registry is sent every call (no per-call filtering). Registry is small enough (~10–20 actions) that the cached prefix absorbs the cost.

**Personality → Movement Hand-off**
- D-04: Hand-off is free natural-language prose. Personality emits intent like "go check what shawn is building over by the water"; movement LLM resolves to action calls. Personality never sees action names or coordinates.
- D-05: Spike note (deferred experiment): Qwen 2.5's reliability translating arbitrary NL prose to correct action calls is unproven. If quality is poor in practice, run a parallel test branch using a structured intent vocabulary as the hand-off shape.

**Idle Behavior + Goal Model**
- D-06: Bot maintains two in-memory goal lists: `owner_goals: string[]` and `self_goals: string[]`. Each goal is a short NL string. No persistence in Phase 2.
- D-07: Goal mutation happens through the personality LLM via a small `setGoals` registry action (add/remove from either list).
- D-08: Idle tick decision logic lives in the personality LLM prompt template, not in code.
- D-09: "Follow me" override is FSM-native — direct chat is P1, idle is P3, so an "@bot follow me" preempts idle goal work automatically.
- D-10: Commentary (PERS-04 proactive observations) is orthogonal to mode — personality LLM may emit chat lines on any turn. Rate-limited by the global 30/min cap.

**Recursion Cap + Abort**
- D-11: One LLM call = one hop against the 5-hop cap (LLM-04). Personality call = 1, movement call = 1.
- D-12: Cap-hit handler: AbortController cancels any in-flight movement action, the personality LLM emits a single short in-character line, event chain terminates. Logged at warn level.

**Ollama Fallback (LLM-08)**
- D-13: Startup probe + on-error circuit breaker. On boot: ping Ollama's `/api/tags`. If unreachable, log a plain-English warning and start in Haiku-only mode for the session.
- D-14: Mid-session circuit breaker: 3 consecutive Qwen errors/timeouts → flip to Haiku-as-executor for the rest of the session (no flapping). User-visible status field tracks current executor (`qwen` | `haiku-fallback`). Manual recheck or restart re-probes Ollama.

**Persona Configuration**
- D-15: Persona lives in `config.json` as a `persona: { name, backstory, tone }` block. Tone is a string enum: `friendly | sarcastic | serious | curious`.
- D-16: No hot-reload in Phase 2.

**Anthropic Prompt Caching (PERS-05)**
- D-17: Cached prefix (in order): system instructions → persona block → tool/action JSON Schema definitions. Recent events, current goals, and the user's latest input go *after* the cache breakpoint.
- D-18: Use Anthropic's `cache_control: { type: "ephemeral" }` marker on the last block of the cached prefix.

**Dev/Test Strategy**
- D-19: No mock LLM layer. Iterate against real Haiku + Ollama; budget a small Haiku token spend for dev.

### Claude's Discretion

- Exact Ollama and Anthropic timeout values (reasonable defaults: Ollama 30s, Haiku 20s)
- Specific debounce implementation (per CLAUDE.md the requirement is 500ms; mechanism is implementation-detail)
- Hop counter storage (per-event-chain object vs. AbortController metadata)
- In-character "cap hit" line phrasing (should respect persona tone)
- Internal module layout for `personality/`, `movement/`, `goals/` files within `src/`
- `setGoals` action's exact Zod shape (likely `{ list: 'owner' | 'self', op: 'add' | 'remove', goal: string }`)

### Deferred Ideas (OUT OF SCOPE)

- Goal persistence across restarts — Phase 3 (MEM-04)
- Hot-reload of persona config — Phase 4
- Mock LLM layer + scenario harness — revisit if dev iteration cost becomes painful
- Recorded transcript replay for regression tests — Phase 3+
- Per-call action filtering / two-tier registry — only if registry grows large
- Structured-intent hand-off (constrained verb list) — test branch experiment if Qwen NL translation underperforms
- Manual Ollama recheck UI / command — Phase 4 GUI affordance
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LLM-01 | Personality LLM (Haiku) on event-driven loop: chat / movement-completion / world events / 10s idle fallback | FSM already emits `sei:dispatch` on every event and has a 10s idle timer (`fsm.js:43-48, 117`). Orchestrator subscribes here. Replace scripted P1/P3 handlers with LLM calls. |
| LLM-02 | Personality LLM sends NL movement instructions to movement LLM; never code or coordinates | Two-layer call: personality LLM is prompted to emit prose intent; orchestrator passes prose as the user message to movement LLM. Personality LLM has NO `tools` parameter except `setGoals` and (optionally) `say`. |
| LLM-03 | Movement LLM (Ollama Qwen 2.5) calls registered actions from Zod-typed registry | Convert Zod → JSON Schema with `zod-to-json-schema`; pass to Ollama `tools` param. Validate `tool_calls.function.arguments` with the original Zod schema before dispatching to `registry.execute()`. |
| LLM-04 | Hard recursion cap (5 hops per event) | Per-event-chain hop counter incremented on each LLM call. At 5, abort + emit cap-hit chat line. See D-11/D-12. |
| LLM-05 | Events debounced 500ms | Coalesce repeat events of the same kind within 500ms before enqueueing to FSM. Implement at the source-event ingestion layer, not in the FSM. |
| LLM-06 | Personality LLM rate-limited 30 calls/min | Token bucket: 30 tokens, refill 30/min. On empty bucket: queue (preferred for chat) or drop (acceptable for idle). |
| LLM-07 | One outstanding movement action; new instruction cancels via AbortController | FSM already enforces this (`fsm.js:75-87`). Orchestrator must propagate the FSM-issued `signal` into both LLM calls AND any in-flight pathfinder action. |
| LLM-08 | Graceful degradation when Ollama unavailable (Haiku for both layers) | Startup probe of `/api/tags` (D-13) + 3-strike mid-session circuit breaker (D-14). When tripped, route movement calls to AnthropicClient with same JSON Schema tools (D-02). |
| PERS-01 | Configurable name used in-game and consistently in speech | Already in code as `username` (see `config.js:8`); persona.name reused for in-character references. Persona block referenced in cached system prompt. |
| PERS-02 | Configurable backstory informs personality | `persona.backstory` (string) inlined into cached system block per D-17. |
| PERS-03 | Configurable tone preset (friendly / sarcastic / serious / curious) | `persona.tone` enum; expanded to 1-2 sentence tone-shaping instruction in the cached system block. |
| PERS-04 | Rate-limited proactive observations when idle near owner | Personality LLM is invoked on the 10s idle tick (already in FSM); prompt instructs it to optionally emit chat. Rate limit shared with LLM-06 cap. |
| PERS-05 | Personality prompt stable across sessions, forms cached prefix | `cache_control: { type: "ephemeral" }` marker on the last block of the [system → persona → tools] prefix. Verify hits via `usage.cache_read_input_tokens`. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Event ingestion (chat, world, idle) | FSM (existing) | — | Phase 1 already routes these via `bot.on(...) → enqueue(...)`. |
| Event debounce (LLM-05) | Orchestrator (new) | — | Debounce belongs at the source-event boundary, before FSM enqueue, so storm-suppression doesn't deprive the FSM of priority info. |
| Priority queueing + preemption | FSM (existing) | — | `fsm.js` already does this; LLM-07 cancellation falls out for free. |
| Hop counting (LLM-04) | Orchestrator (new) | — | Per-event-chain state; the FSM is intentionally dumb about LLM semantics. |
| Rate limiting (LLM-06) | Orchestrator (new) | — | Bucket guards the personality LLM call site only; movement calls are downstream of personality and inherit cap via the 5-hop ceiling. |
| Personality LLM call (Haiku) | AnthropicClient (new) | — | Provider-specific HTTP and prompt-caching mechanics. |
| Movement LLM call (Qwen) | OllamaClient (new) | AnthropicClient (fallback executor) | D-02: same `tools` payload, two providers. |
| Provider selection (qwen vs haiku-fallback) | Orchestrator (new) | — | Tracks circuit breaker state, exposes `executorStatus`. |
| Action validation + dispatch | Existing `registry.execute()` | — | Already Zod-validates args and throws on unknown action. Reused as-is. |
| Goal lists state | Orchestrator (new) | — | In-memory only in Phase 2; Phase 3 lifts to SQLite. Mutation only via `setGoals` action. |
| Persona config | `config.js` (extend existing) | — | Add Zod `persona` block; loader is unchanged in shape. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | ^0.91.1 | Personality LLM (Haiku 4.5) client; prompt caching; tool_use blocks | [VERIFIED: npm view 2026-04-25] Official Anthropic TS SDK. AbortController support documented (`messages.stream().abort()` and `messages.create({ ..., stream: true })` accepting standard AbortSignal). |
| `ollama` (ollama-js) | ^0.6.3 | Movement LLM (Qwen 2.5) client; tool-calling; `/api/tags` probe | [VERIFIED: npm view 2026-04-25] Official Ollama JS client. Supports `tools` param and `ollama.abort()` for stream cancellation. [CITED: github.com/ollama/ollama-js helpers.md] |
| `zod-to-json-schema` | ^3.25.2 | Convert existing Zod action schemas to JSON Schema for both Ollama `tools` and Anthropic `tool_use` definitions | [VERIFIED: npm view 2026-04-25] Standard converter. **NOTE:** package will not be actively maintained going forward — Zod 4 has native `.toJSONSchema()`. Project currently uses Zod 3.22.4; staying on `zod-to-json-schema` for Phase 2 is correct (no Zod-4 migration in scope). [CITED: zod.dev/json-schema] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `limiter` | ^3.0.0 (latest stable) | Token-bucket implementation for the 30/min personality cap (LLM-06) | If a battle-tested library is preferred over a ~30-LOC hand-rolled bucket. [ASSUMED] — version not pinned in this research; planner should `npm view limiter version` to confirm. |
| (none — hand-roll) | — | Debounce, hop counter, circuit breaker — all <50 LOC each, no dep needed | These are trivial pieces of state machinery that don't justify a dependency. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `zod-to-json-schema` | Upgrade to Zod 4 (native `.toJSONSchema()`) | Phase-creep: requires touching all existing Zod schemas + Phase 1 callsites. Not worth it for Phase 2. |
| `ollama` JS client | Raw `fetch` to `/api/chat` and `/api/tags` | Fewer deps; loses ergonomic `abort()`. Defer unless dep weight matters in packaging (Phase 4 question). |
| `limiter` package | Hand-rolled token bucket (~30 LOC) | Hand-roll wins on dep minimalism for a long-running Node process; library wins on battle-testing. Either is fine — D-19 spirit favors keeping deps small. |
| `setImmediate` debounce | `lodash.debounce` or `p-debounce` | Trivial enough to hand-roll. Lodash is heavyweight for one function. |

**Installation (estimated):**
```bash
npm install @anthropic-ai/sdk ollama zod-to-json-schema
```

**Version verification (planner: re-run before pinning):**
```bash
npm view @anthropic-ai/sdk version          # 0.91.1 verified 2026-04-25
npm view ollama version                     # 0.6.3 verified 2026-04-25
npm view zod-to-json-schema version         # 3.25.2 verified 2026-04-25
```

## ⚠️ Critical Model ID Issue

**Claude Haiku 3 is retired.** [VERIFIED: platform.claude.com/docs/en/about-claude/model-deprecations]

| Model ID | Status | Notes |
|----------|--------|-------|
| `claude-3-haiku-20240307` | **Retired April 20, 2026** | Requests will fail. Cannot be used. |
| `claude-3-5-haiku-20241022` | Retired Feb 19, 2026 | Cannot be used. |
| `claude-haiku-4-5-20251001` | **Active** (alias `claude-haiku-4-5`) | Recommended replacement. Pricing: $1 / $5 per MTok input/output. 200k context, 64k max output. |

**Implications:**
1. REQUIREMENTS.md (LLM-01, PERS-05) and CONTEXT.md still name "Haiku 3". Phase 2 must use `claude-haiku-4-5-20251001`.
2. Cost: Haiku 4.5 is more capable but pricier than Haiku 3 was. Per-call cost is acceptable given the 30/min cap and prompt caching. [VERIFIED: platform.claude.com/docs/en/about-claude/models/overview]
3. Prompt-caching minimum cacheable tokens for Haiku 4.5 is **4,096** tokens. [VERIFIED: platform.claude.com/docs/en/docs/build-with-claude/prompt-caching] The cached prefix (system + persona + tool schemas) needs to clear 4k tokens to actually cache; a small registry (~10 actions) plus persona may NOT cross 4k by itself. Planner action: budget for the cached prefix to include a sufficiently detailed system instruction block (or accept that prompt caching won't kick in until the registry grows). Verify post-implementation by inspecting `usage.cache_creation_input_tokens` — if it's 0 on the first call, the prefix didn't meet the minimum.

**Planner action required:** Confirm with user that Phase 2 ships against `claude-haiku-4-5-20251001` (since the literal "Haiku 3" decision is no longer realizable). This is not a re-design; it's a model-ID swap with a pricing footnote and the 4k-min-cacheable caveat above.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────────┐
                     │  Mineflayer events (chat, hurt, spawn, ...) │
                     └──────────────────┬──────────────────────────┘
                                        │
                            ┌───────────▼──────────┐
                            │  Debouncer (500ms)    │  ← LLM-05
                            │  per event-kind        │
                            └───────────┬──────────┘
                                        │
                  ┌─────────────────────▼─────────────────────┐
                  │   FSM (existing — fsm.js)                  │
                  │   Priority queue P0/P1/P2/P3               │
                  │   AbortController on currentAction         │
                  │   Emits: sei:dispatch { event, data, signal} ← LLM-07
                  └─────────────────────┬─────────────────────┘
                                        │
                       ┌────────────────▼────────────────┐
                       │  Orchestrator (NEW)              │
                       │  - subscribes to sei:dispatch     │
                       │  - per-chain hopCount (LLM-04)    │
                       │  - rate limiter 30/min (LLM-06)   │
                       │  - executorStatus circuit breaker │
                       │  - reads/writes goal lists        │
                       └────────────────┬────────────────┘
                                        │
                       ┌────────────────▼────────────────┐
                       │  PersonalityClient (Haiku 4.5)   │
                       │  System: cached prefix           │
                       │   [system → persona → tools]     │
                       │  Tools: setGoals, say,           │
                       │         handOffToMovement(prose) │
                       └────────────────┬────────────────┘
                          tool_use ↓
                          tool_result ↑
                                        │
                       ┌────────────────▼────────────────┐
                       │  Movement dispatch                │
                       │  - if executorStatus=qwen:        │
                       │      OllamaClient (Qwen 2.5)      │
                       │  - if haiku-fallback:             │
                       │      AnthropicClient (same tools) │
                       └────────────────┬────────────────┘
                          tool_calls ↓
                                        │
                       ┌────────────────▼────────────────┐
                       │  registry.execute(name, args,    │
                       │                    bot, config)   │
                       │  (existing Zod-validated)         │
                       └────────────────┬────────────────┘
                                        │
                       ┌────────────────▼────────────────┐
                       │  Mineflayer action               │
                       │  (e.g., pathfind.goTo)            │
                       │  Receives FSM signal              │
                       └──────────────────────────────────┘
```

Key data flows:
- Inbound events are debounced before they hit the FSM, so the FSM still gets priority-correct enqueues but without storm bursts.
- The FSM emits `sei:dispatch` and the orchestrator owns everything LLM-related from that hook forward.
- The orchestrator passes the FSM-issued `signal` into both `AnthropicClient` (via `messages.create`'s AbortSignal support) and `OllamaClient` (via per-client `abort()` — note ollama-js's abort cancels ALL streams on that client, so use one client per active call OR use a fresh client per chain).
- Goal mutations and `say` (chat) calls are tools the personality LLM invokes; movement intent is a tool that hands NL prose to the movement LLM.

### Component Responsibilities

| Component | File (proposed) | Responsibility |
|-----------|-----------------|----------------|
| Orchestrator | `src/orchestrator/index.js` | Subscribes to `sei:dispatch`; manages hop count, rate limiter, circuit breaker, goal lists. Single entry: `handleDispatch(event, data, signal)`. |
| AnthropicClient | `src/orchestrator/anthropicClient.js` | Wraps `@anthropic-ai/sdk`. Builds cached system block (persona + tools). Returns `{ toolUses, text, usage }`. Honors AbortSignal. |
| OllamaClient | `src/orchestrator/ollamaClient.js` | Wraps `ollama` package. Probes `/api/tags`. Calls `/api/chat` with `tools`. Returns `{ toolCalls }`. Honors AbortSignal (per-call client instance). |
| Debouncer | `src/orchestrator/debounce.js` | 500ms coalescing per event-kind, called from event ingestion sites. |
| Rate limiter | `src/orchestrator/rateLimiter.js` | 30/min token bucket with `tryAcquire()` and `awaitAcquire(timeout)`. |
| Persona prompt | `src/orchestrator/persona.js` | Renders persona to system text and tone instruction; pure function of `config.persona`. |
| Goal store | `src/orchestrator/goals.js` | `{ owner_goals, self_goals, add(list, goal), remove(list, goal), snapshot() }`. |
| `setGoals` action | `src/registry.js` (extend `createDefaultRegistry`) | Registry action for goal mutation (D-07). |
| Schema converter | (call site in orchestrator init) | `zodToJsonSchema(schema, { name })` once per registered action at startup. |

### Pattern 1: Provider-agnostic LLM call shape

```typescript
// Source: synthesis of Anthropic + Ollama docs and CONTEXT.md D-02
interface ToolDef {
  name: string
  description: string
  inputSchema: object  // JSON Schema
}

interface LLMRequest {
  systemPrefix: { text: string, cache: boolean }[]   // ordered blocks
  messages: { role: 'user' | 'assistant' | 'tool', content: any }[]
  tools: ToolDef[]
  signal: AbortSignal
  timeoutMs: number
}

interface LLMResponse {
  toolCalls: { name: string, args: unknown }[]
  text: string | null
  usage?: { cacheRead?: number, cacheCreate?: number, input?: number, output?: number }
}

// Two implementations of `call(req: LLMRequest): Promise<LLMResponse>` —
// AnthropicClient maps to Messages API tool_use; OllamaClient maps to /api/chat tools.
// `signal` is forwarded to fetch in both cases.
```

### Pattern 2: Anthropic prompt-cache prefix construction (D-17, D-18)

```typescript
// Source: platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1024,
  system: [
    { type: 'text', text: SYSTEM_INSTRUCTIONS },                  // 1. stable
    { type: 'text', text: renderPersona(config.persona) },        // 2. stable per session
    { type: 'text',
      text: `Available actions:\n${renderToolDescriptions(tools)}`,
      cache_control: { type: 'ephemeral' }                        // ← breakpoint on LAST block of prefix
    },
  ],
  tools,                                                          // schemas for tool_use
  messages: [
    // Recent events + current goals + latest input go HERE — not cached
    { role: 'user', content: renderRecentContext(events, goals, input) },
  ],
})

// Verify cache:
console.log(response.usage.cache_read_input_tokens)    // > 0 on cache hit
console.log(response.usage.cache_creation_input_tokens) // > 0 only on first call
```

**Caveat:** Haiku 4.5's minimum cacheable prefix is **4,096 tokens**. If the prefix is under 4k, `cache_*_input_tokens` will both be 0 and there's no error. The planner should ensure the system instruction block is substantive enough (or document that prompt caching activates once the registry grows).

### Pattern 3: Ollama tool-call dispatch loop

```typescript
// Source: github.com/ollama/ollama-js/blob/main/examples/tools/calculator.ts (verified pattern)
import { Ollama } from 'ollama'

const client = new Ollama({ host: 'http://127.0.0.1:11434' })

// 1. Probe (D-13)
async function probe(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch { return false }
}

// 2. Movement call
const response = await client.chat({
  model: 'qwen2.5:7b',
  messages: [
    { role: 'system', content: MOVEMENT_SYSTEM_PROMPT },
    { role: 'user', content: personalityProse },  // e.g., "go check what shawn is building"
  ],
  tools: jsonSchemaTools,                          // converted from Zod registry
  stream: false,
})

// 3. Validate + dispatch
for (const call of response.message.tool_calls ?? []) {
  const name = call.function.name
  const args = call.function.arguments  // already an object (NOT a JSON string in ollama-js)
  await registry.execute(name, args, bot, config)  // Zod re-validates
}
```

**Important difference from OpenAI:** ollama-js returns `arguments` as a parsed object, not a string. No `JSON.parse` needed.

### Pattern 4: AbortController fan-out (LLM-07)

```typescript
// FSM hands the orchestrator a `signal`. The orchestrator must:
async function handleDispatch(event, data, signal) {
  // (1) Both LLM clients receive signal. Anthropic SDK natively accepts AbortSignal.
  const personalityResp = await anthropic.call({ ..., signal, timeoutMs: 20_000 })

  // (2) For Ollama, use a per-call client to make abort() granular:
  const ollamaCallClient = new Ollama({ host })
  signal.addEventListener('abort', () => ollamaCallClient.abort(), { once: true })
  const movementResp = await ollamaCallClient.chat({ ..., signal /* also forwarded */ })

  // (3) Registry actions (e.g., pathfind.goTo) already accept signal/timeout in Phase 1.
  //     The orchestrator forwards the same signal so cancellation cascades.
  await registry.execute(name, args, bot, { ...config, signal })
}
```

**Pitfall:** `ollama-js`'s `client.abort()` aborts ALL in-flight streams on that client instance. Per the ollama-js README: *"If there is a need to manage streams with timeouts, it is recommended to have one Ollama client per stream."* Plan accordingly. [CITED: github.com/ollama/ollama-js helpers.md]

### Pattern 5: Hop counter + cap (LLM-04, D-11/D-12)

```typescript
class EventChain {
  hops = 0
  readonly MAX = 5
  step() {
    if (++this.hops > this.MAX) throw new HopCapHit()
  }
}

// On HopCapHit:
//  - signal.abort()
//  - emit a single in-character chat line via bot.chat() (do NOT call personality LLM again to phrase it; pre-render from persona.tone)
//  - log warn
```

### Pattern 6: Circuit breaker for Ollama (D-13/D-14)

```typescript
class OllamaCircuit {
  state: 'qwen' | 'haiku-fallback' = 'qwen'   // set after startup probe
  consecutiveFailures = 0
  readonly TRIP_AT = 3

  recordSuccess() { this.consecutiveFailures = 0 }
  recordFailure() {
    if (++this.consecutiveFailures >= this.TRIP_AT) {
      this.state = 'haiku-fallback'
      log.warn('[sei] Ollama disabled for session — using Haiku-as-executor.')
    }
  }
}
```

No half-open state — D-14 says no flapping. Manual recheck (Phase 4) or restart resets.

### Pattern 7: Token-bucket rate limiter (LLM-06)

```typescript
// 30 tokens, refill 30/min = 1 token / 2s. Hand-roll is ~30 LOC; alternative is `limiter` package.
class TokenBucket {
  tokens = 30
  readonly capacity = 30
  readonly refillIntervalMs = 60_000 / 30  // 2000ms
  lastRefill = Date.now()

  tryAcquire(): boolean {
    this.refill()
    if (this.tokens >= 1) { this.tokens -= 1; return true }
    return false
  }
  private refill() {
    const elapsed = Date.now() - this.lastRefill
    const add = Math.floor(elapsed / this.refillIntervalMs)
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add)
      this.lastRefill += add * this.refillIntervalMs
    }
  }
}
```

Drop policy: idle ticks dropped when bucket empty; chat events queued (max 5 deep) and processed when refill makes room. Document this in the orchestrator.

### Anti-Patterns to Avoid

- **Treating personality LLM as a tool-caller for movement primitives:** The personality LLM should NOT see action names or coordinates (CLAUDE.md ADR #2, D-04). Its only "tools" are `setGoals`, `say` (chat), and `handOffToMovement(prose)`. The closed registry of mineflayer actions is exposed only to the movement LLM.
- **Re-using one Ollama client across concurrent calls:** `client.abort()` cancels everything. See Pitfall in Pattern 4.
- **Calling the personality LLM to phrase the cap-hit message:** that would itself consume a hop. Pre-render from persona.tone.
- **Putting the cache breakpoint after the user's latest input:** the prefix being cached must be stable. The breakpoint goes on the LAST stable block (tool descriptions), with all dynamic content after it.
- **Treating `tool_calls.function.arguments` as a string in ollama-js:** it's already an object. (It IS a string in OpenAI's SDK — easy to mix up.)
- **Hand-rolling JSON Schema:** use `zod-to-json-schema` against the existing Phase 1 Zod schemas; don't author JSON Schema by hand and risk drift.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Zod → JSON Schema conversion | Recursive schema walker | `zod-to-json-schema` v3.25.2 | Handles unions, refinements, nested objects, optionals correctly. Avoids drift between registry validation and tool definitions. |
| Anthropic Messages API HTTP | Raw fetch with manual streaming + retries | `@anthropic-ai/sdk` v0.91.1 | Built-in retries, AbortSignal support, type-safe message construction, prompt-cache plumbing. |
| Ollama `/api/chat` HTTP | Raw fetch + JSONL stream parser | `ollama` v0.6.3 | Same reasoning. The package also gives `client.abort()`. |
| AbortController for HTTP cancellation | Custom signal plumbing | Native `AbortController` + SDK signal forwarding | Both SDKs accept standard AbortSignal. |
| 500ms debounce | (consider hand-rolling — trivial) | Or `lodash.debounce`/`p-debounce` if a dep is preferred | <10 LOC; not worth a dep, but use a library if dep weight isn't a concern. |
| Token bucket | (consider hand-rolling — trivial) | Or `limiter` package | <30 LOC; either path is fine. |

**Key insight:** This phase is mostly orchestration plumbing wired around two well-supported SDKs. The risk is NOT in implementing primitives; it's in correctly composing prompt-cache layout, abort propagation, hop counting, and the circuit breaker — none of which a library will give you. Build those carefully, lean on SDKs for the I/O.

## Common Pitfalls

### Pitfall 1: Haiku 3 retired, code still references it
**What goes wrong:** API calls return errors; bot fails to start.
**Why it happens:** REQUIREMENTS.md and CONTEXT.md were drafted before April 20, 2026 retirement.
**How to avoid:** Use `claude-haiku-4-5-20251001`. Make the model ID a config field (`config.anthropic.model`) with that as the default so future migrations don't require code changes.
**Warning signs:** First Anthropic call returns 404 / model_not_found.

### Pitfall 2: Prompt cache silently doesn't activate (under-4k prefix)
**What goes wrong:** Spend more on Haiku than expected; PERS-05 is "satisfied" but doing nothing.
**Why it happens:** Haiku 4.5 minimum cacheable is 4,096 tokens. A short persona + small registry can fall under.
**How to avoid:** Log `usage.cache_creation_input_tokens` on first call after restart. If 0, the prefix is too short — pad the system instruction or accept caching won't activate yet.
**Warning signs:** Both `cache_creation_input_tokens` AND `cache_read_input_tokens` are 0 across multiple calls.

### Pitfall 3: ollama-js `client.abort()` cancels ALL in-flight calls
**What goes wrong:** A new high-priority FSM event aborts an unrelated concurrent Ollama call.
**Why it happens:** Documented behavior of the JS client (see Pattern 4).
**How to avoid:** Per-call client instance, or treat the orchestrator as serial (one in-flight LLM chain at a time, which the FSM already enforces via single AbortController on currentAction).
**Warning signs:** AbortError thrown in chains that were not the target of cancellation.

### Pitfall 4: Qwen 2.5 produces malformed tool_calls
**What goes wrong:** Action dispatch fails Zod validation; bot stalls.
**Why it happens:** Qwen tool-calling reliability is model-size and prompt dependent. Documented caveat from Qwen team: *"It is not guaranteed that the model generation will always follow the protocol even with proper prompting or templates."* [CITED: qwen.readthedocs.io/en/latest/framework/function_call.html]
**How to avoid:** (1) Validate every tool_call with the Zod schema (already happens via `registry.execute`). (2) On validation failure, retry once with the validation error appended as a tool message ("your last call's args failed: <error>"). (3) After 2 failures in a chain, give up and let the cap-hit handler take over. (4) Honor D-05: if reliability is poor in practice, switch to structured-intent vocabulary.
**Warning signs:** High Zod-throw rate from registry.execute. Track in metrics.

### Pitfall 5: Two-layer LLM runaway loop
**What goes wrong:** Personality → movement → completion → personality → movement → ... unbounded.
**Why it happens:** Movement completion is itself a P2 FSM event that triggers the personality LLM. Without the hop cap, this never terminates.
**How to avoid:** Hop counter per event chain, cap at 5 (LLM-04). Each LLM call increments — both personality and movement. The handler MUST be defensive: even if a single chain only legitimately needs 2 hops, the cap is the safety net.
**Warning signs:** Cap-hit log lines appearing in normal operation = chain design is wrong, not the cap.

### Pitfall 6: Storm of events from one game situation
**What goes wrong:** Bot is hit 5x in 200ms by an arrow swarm; FSM enqueues 5 P0 attacks; each triggers a personality LLM call.
**Why it happens:** No debounce.
**How to avoid:** 500ms debounce per event-kind at the source-event boundary (LLM-05). Coalesce repeats; pass the most recent event data forward. Debounce BEFORE FSM enqueue so the FSM still sees one priority-correct event.
**Warning signs:** Token bucket draining unexpectedly fast.

### Pitfall 7: Persona block changes invalidate cache mid-session
**What goes wrong:** First call after a persona edit creates a new cache; old cache wasted.
**Why it happens:** Any byte change in the cached prefix invalidates the entry.
**How to avoid:** D-16 already mandates no hot-reload. Document this clearly so Phase 4 GUI changes are aware.

### Pitfall 8: Ollama probe on boot races against Ollama startup on user's machine
**What goes wrong:** Probe fails because Ollama is starting; bot enters Haiku-fallback for the whole session unnecessarily.
**Why it happens:** Cold OS / app launch.
**How to avoid:** Probe with retry — e.g., 3 attempts at 2s intervals before declaring Ollama unreachable. Document this delay budget (~6s max boot delay if Ollama is truly down).
**Warning signs:** Users reporting "always in fallback mode" when they have Ollama installed.

## Runtime State Inventory

> Phase 2 is greenfield additions to existing code (no rename/refactor). Skipping this section.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Ollama daemon | Movement LLM (Qwen 2.5) | Unknown — user-machine dependent | — | Haiku-as-executor (D-13/D-14) |
| Qwen 2.5 model in Ollama | Movement LLM | Unknown | — | Haiku-as-executor |
| Anthropic API key | Personality LLM (and fallback executor) | Required | — | None — phase cannot run without it |
| Node.js (existing) | Project runtime | ✓ | ESM module type set in package.json | — |

**Missing dependencies with no fallback:** ANTHROPIC_API_KEY env var or config field. Planner must add a clean failure mode: detect missing key at startup, log plain-English error per CLAUDE.md ADR-style guidance, exit cleanly.

**Missing dependencies with fallback:** Ollama and Qwen model — fallback is Haiku-as-executor (D-02 / D-13 / D-14 spec the entire fallback path).

**Probe at boot (planner action):**
```bash
# Document for users
ollama --version              # check installed
ollama list | grep qwen2.5    # check model pulled
curl http://127.0.0.1:11434/api/tags   # check daemon running
```

## Code Examples

### Converting Phase 1 registry to JSON Schema tools (one-time at orchestrator init)

```typescript
// Source: synthesis of zod-to-json-schema docs + Phase 1 registry shape
import { zodToJsonSchema } from 'zod-to-json-schema'

function buildToolsFromRegistry(registry) {
  return registry.list().map(name => {
    const schema = registry.schema(name)
    const jsonSchema = zodToJsonSchema(schema, { name, $refStrategy: 'none' })
    return {
      // Ollama shape:
      type: 'function',
      function: {
        name,
        description: actionDescriptions[name] ?? '',
        parameters: jsonSchema,
      },
      // For Anthropic, transform to: { name, description, input_schema: jsonSchema }
    }
  })
}
```

The orchestrator builds two parallel arrays — one Ollama-shaped, one Anthropic-shaped — from the same JSON Schema source.

### Anthropic call with cache + tool_use loop (full)

```typescript
// Source: platform.claude.com/docs/en/docs/build-with-claude/tool-use + prompt-caching
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

async function callPersonality({ systemBlocks, tools, messages, signal }) {
  const resp = await client.messages.create(
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemBlocks,    // last block has cache_control
      tools,                    // [{ name, description, input_schema }]
      messages,
    },
    { signal, timeout: 20_000 }
  )

  // resp.stop_reason === 'tool_use' indicates Claude wants to call tools
  // resp.content is an array of blocks: text and tool_use
  const toolUses = resp.content.filter(b => b.type === 'tool_use')
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('')

  return { toolUses, text, usage: resp.usage }
}

// Multi-turn loop: append assistant message, then user message with tool_result blocks
//   { role: 'user', content: [{ type: 'tool_result', tool_use_id, content: result }] }
```

### Ollama call with tools + abort

```typescript
// Source: github.com/ollama/ollama-js examples/tools/calculator.ts (verified pattern)
import { Ollama } from 'ollama'

async function callMovement({ messages, tools, signal, host }) {
  const client = new Ollama({ host })
  const onAbort = () => client.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const resp = await client.chat({
      model: 'qwen2.5:7b',
      messages,
      tools,
      stream: false,
    })
    return { toolCalls: resp.message.tool_calls ?? [] }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
```

### Extending config.js for persona

```typescript
// Source: extension of existing src/config.js
import { z } from 'zod'

export const ConfigSchema = z.object({
  // ... existing Phase 1 fields
  persona: z.object({
    name: z.string().min(1),                                            // PERS-01
    backstory: z.string(),                                              // PERS-02
    tone: z.enum(['friendly', 'sarcastic', 'serious', 'curious']),       // PERS-03
  }),
  anthropic: z.object({
    api_key: z.string().min(1),
    model: z.string().default('claude-haiku-4-5-20251001'),
    timeout_ms: z.number().int().min(1000).default(20_000),
  }),
  ollama: z.object({
    host: z.string().default('http://127.0.0.1:11434'),
    model: z.string().default('qwen2.5:7b'),
    timeout_ms: z.number().int().min(1000).default(30_000),
  }),
  llm: z.object({
    rate_limit_per_min: z.number().int().min(1).default(30),
    debounce_ms: z.number().int().min(0).default(500),
    max_hops: z.number().int().min(1).default(5),
    idle_fallback_ms: z.number().int().min(1000).default(10_000),
  }).default({}),
})
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `claude-3-haiku-20240307` for low-cost | `claude-haiku-4-5-20251001` | Haiku 3 retired April 20, 2026 | Mandatory model swap. Pricing slightly higher; capability significantly higher. |
| `claude-3-5-haiku-20241022` | `claude-haiku-4-5-20251001` | Haiku 3.5 retired Feb 19, 2026 | Same — only Haiku 4.5 remains active. |
| Hand-rolled JSON Schema for tool defs | Zod 4 native `.toJSONSchema()` (or zod-to-json-schema for Zod 3) | Zod 4 released; zod-to-json-schema unmaintained as of Nov 2025 | Phase 2 stays on Zod 3 + zod-to-json-schema. Phase-creep avoided. |
| Text-tag command protocols (e.g., mindcraft `!command(arg)`) | Native tool-calling on both Ollama and Anthropic | 2024-2026 | CONTEXT.md D-01 already chose tool-calling. Mindcraft is reference only. |

**Deprecated/outdated:**
- Haiku 3 and Haiku 3.5: **RETIRED**. Cannot be called.
- `prompt-engineering` style "ReAct" (Thought/Action/Observation) prose for reasoning models: Qwen team explicitly recommends Hermes-style tool use for Qwen3+, not ReAct. Qwen 2.5 instruct works with native tool-calling — no ReAct needed.
- `JSON.parse` on tool args from ollama-js: not needed (already parsed). Confused with OpenAI SDK where args ARE strings.

## Project Constraints (from CLAUDE.md)

| Constraint | Source | Implication for Phase 2 |
|------------|--------|-------------------------|
| Three-process Electron; mineflayer in utilityProcess only | CLAUDE.md Architecture #1 | Phase 2 still ships as a CLI module (Phase 4 wraps it). Keep all LLM I/O behind clean module boundaries with no renderer assumptions. |
| Closed action registry; movement LLM never generates code or coordinates | CLAUDE.md #2; CONTEXT.md D-04 | Personality LLM does NOT see action names or coordinates. Movement LLM gets the registry tools. Both must be enforced in prompt construction and in the available `tools` array per call. |
| Event-sourced FSM with priority queue + AbortController | CLAUDE.md #3 | Already in place (`src/fsm.js`). Orchestrator subscribes to `sei:dispatch`. |
| LLM-directed memory compaction | CLAUDE.md #4 | Phase 3 concern; not Phase 2. |
| **Every external call has a timeout** | CLAUDE.md #5 | MANDATORY: Ollama (~30s), Anthropic (~20s), and AbortSignal forwarded into both. Apply same pattern as Phase 1's pathfinder wrapper (Promise.race or SDK-native timeout). |
| Two-layer LLM runaway → hard 5-hop cap + 500ms debounce from day one | CLAUDE.md Pitfalls | LLM-04 + LLM-05; not optional. |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `limiter` npm package is the suitable rate-limit library for our case (version unverified in this research) | Standard Stack — Supporting | Low — hand-roll alternative is ~30 LOC; planner can pick. |
| A2 | Hand-rolled debounce/circuit-breaker/hop-counter at <50 LOC each is the right call vs. dependencies | Don't Hand-Roll | Low — these are textbook patterns; both choices acceptable. |
| A3 | Cached prefix may not reach Haiku 4.5's 4,096-token minimum with a small registry + short persona | Critical Model ID Issue / Pitfall 2 | Medium — caching might silently no-op. Verifiable post-build via `usage.cache_creation_input_tokens`. |
| A4 | Ollama probe with 3 retries × 2s is appropriate for cold-start race | Pitfall 8 | Low — easy to tune after first user reports. |
| A5 | Qwen 2.5 7B is the right size for movement LLM (vs. 14B) | (implicit in CONTEXT — model size not pinned) | Medium — 14B more reliable for tool-calling but heavier on local hardware. Defer to user/hardware constraints. Planner should make `ollama.model` a config field with a sensible default and document the tradeoff. |
| A6 | 30/min cap applies at the personality-call site; movement calls inherit cap implicitly via the 5-hop ceiling per chain | Architectural Responsibility Map | Low — explicit in REQUIREMENTS.md (LLM-06 names the personality LLM specifically). |
| A7 | Per-call Ollama client instance is the cleanest fix for `abort()`'s "cancels all" behavior | Pattern 4 / Pitfall 3 | Low — documented in ollama-js README. |
| A8 | The cap-hit chat line should be pre-rendered from persona.tone (not LLM-generated) to avoid consuming a hop | Pattern 5 / Anti-Patterns | Low — clearly the right call given the cap is meant to terminate. |

## Open Questions

1. **Which Qwen 2.5 size: 7B, 14B, or 32B?**
   - What we know: Larger sizes are more reliable for tool-calling; 7B is more universally runnable on user hardware.
   - What's unclear: User's expected hardware floor for Sei (this is a hobbyist/companion app — laptop-class is plausible).
   - Recommendation: Default to `qwen2.5:7b` in config; document the upgrade path. Hardware constraint is a user choice, not a Phase 2 design decision.

2. **Should `setGoals` be a tool the personality LLM calls, or a side-effect of NL prose to the movement LLM?**
   - What we know: D-07 says "via personality LLM via a small `setGoals` registry action."
   - What's unclear: Personality LLM normally does NOT call registry actions (per ADR #2 — that's the movement LLM's job). `setGoals` is the intentional exception.
   - Recommendation: Implement `setGoals` as a tool exposed ONLY to the personality LLM (not the movement LLM). Separate `personalityTools = [setGoals, say, handOffToMovement]` from `movementTools = registry.list()`.

3. **How is the "10s idle fallback" reconciled with ongoing chains?**
   - What we know: FSM resets the idle timer on every dispatch (`fsm.js:92`). So idle only fires when nothing has happened in 10s.
   - What's unclear: Should idle be skipped entirely while an LLM chain is mid-execution?
   - Recommendation: Yes — idle ticks should be debounced/dropped if a chain is active. The FSM already serializes via the priority queue; a P3 idle event behind an in-progress P0/P1/P2 will sit in the queue. After the chain ends, the queued idle tick may already be stale — drop it if newer events arrived.

4. **Cache TTL: 5 minutes default vs 1 hour extended?**
   - What we know: 5m at 1.25× write cost; 1h at 2× write cost. Reads are 0.1× regardless.
   - What's unclear: Bot session length expectations.
   - Recommendation: Default `{ type: 'ephemeral' }` (5m). If sessions are typically multi-hour and prefix is unchanged, switch to 1h. Decision is reversible in code.

5. **What happens when `say` and `handOffToMovement` are both called in one personality response?**
   - What we know: Anthropic supports multiple tool_use blocks per response.
   - What's unclear: Should both fire? Or treat as parallel?
   - Recommendation: Execute `say` first (it's a fast bot.chat call), then `handOffToMovement` (which will start a movement chain). Document the ordering.

## Validation Architecture

> Skipped per `.planning/config.json`: `workflow.nyquist_validation: false`.

## Security Domain

`security_enforcement` is not configured (defaults to enabled). Phase 2 has limited attack surface (no user-facing endpoints, no untrusted file IO), but a few categories apply:

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Phase 4 handles API key storage via OS keychain; Phase 2 reads from config.json (acceptable for dev). |
| V3 Session Management | no | No user sessions. |
| V4 Access Control | partial | The "closed registry" IS the access control surface — LLM cannot call anything outside it. Enforced by Zod schema validation in `registry.execute`. ALREADY in place from Phase 1. |
| V5 Input Validation | yes | Tool-call args MUST be Zod-validated before dispatch. Already enforced by `registry.execute(name, args, ...)` parsing args with the registered schema. |
| V6 Cryptography | no | No new crypto in Phase 2. |
| V7 Error Handling & Logging | yes | Plain-English error messages per CLAUDE.md / Phase 1 D-04 spirit. Don't log API keys. |
| V8 Data Protection | partial | Anthropic API key is sensitive — read from config and don't log it. Phase 4 will move it to OS keychain. |
| V13 API & Web Service | partial | Both Ollama and Anthropic are external APIs called over HTTP(S). Use SDKs (which handle TLS correctly). Don't pin to HTTP for Anthropic. |

### Known Threat Patterns for two-layer LLM systems

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection via in-game chat → LLM exfiltrates persona/system prompt | Information Disclosure | The personality LLM's system prompt is not particularly sensitive (persona.backstory). Risk acknowledged, no mitigation needed for v1. |
| Prompt injection → LLM calls action with malicious args | Tampering | Closed registry + Zod validation prevents arbitrary code/coordinates. CLAUDE.md ADR #2 is THE mitigation. |
| Runaway LLM loop → cost explosion | Denial-of-Service (cost) | Hop cap (LLM-04) + rate limit (LLM-06) + Anthropic timeout. |
| API key exfiltration via prompt injection | Information Disclosure | Never include API key in any LLM-visible context. Read from env / config; pass to SDK only. |
| Ollama localhost call from utilityProcess | Spoofing (low) | Default to `http://127.0.0.1:11434`. Document risk if user reconfigures to a remote Ollama. |

## Sources

### Primary (HIGH confidence)
- [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview) — current Haiku 4.5 model ID, pricing, context window
- [Anthropic Model Deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) — Haiku 3 retired April 20, 2026; Haiku 3.5 retired Feb 19, 2026
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) — cache_control syntax, breakpoint placement, cache_creation_input_tokens / cache_read_input_tokens, pricing, 4,096-token minimum for Haiku 4.5
- [Anthropic Tool Use](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use) — tool_use response blocks, stop_reason, multi-turn pattern
- [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md) — /api/chat tools shape, /api/tags response
- [ollama-js README/helpers](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md) (Anthropic SDK helpers — AbortController support)
- [ollama-js examples/tools/calculator.ts](https://github.com/ollama/ollama-js/blob/main/examples/tools/calculator.ts) — verified tool-call dispatch pattern
- npm registry verification (2026-04-25) for `@anthropic-ai/sdk@0.91.1`, `ollama@0.6.3`, `zod-to-json-schema@3.25.2`, `zod@4.3.6`

### Secondary (MEDIUM confidence)
- [Zod JSON Schema docs](https://zod.dev/json-schema) — note that zod-to-json-schema unmaintained as of Nov 2025; Zod 4 has native support
- [Qwen Function Call docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html) — caveat about non-guaranteed protocol adherence (page is Qwen3-focused but principle applies)
- [Ollama tool support blog](https://ollama.com/blog/tool-support) — general agent loop pattern guidance
- [Ollama structured outputs blog](https://ollama.com/blog/structured-outputs) — confirms Ollama's native Zod integration recommendation

### Tertiary (LOW confidence)
- WebSearch result on `limiter`/`tokenbucket` Node packages (no version pin done; planner should verify if going library route)
- Qwen 2.5 7B vs 14B tool-calling reliability — community-reported, no benchmark cited; flagged as deferred spike (D-05)

## Metadata

**Confidence breakdown:**
- External APIs (Anthropic + Ollama): HIGH — fetched current docs; SDK versions verified against npm
- Model availability and pricing: HIGH — verified via official Anthropic deprecations page (critical: Haiku 3 retired)
- Architecture / integration with Phase 1 FSM: HIGH — read all Phase 1 source; FSM already exposes the right hooks
- Standard stack library choices: HIGH for SDKs, MEDIUM for rate-limit/debounce (acceptable to choose either lib or hand-roll)
- Qwen 2.5 NL→tool-call reliability: MEDIUM — Qwen team itself caveats this; CONTEXT.md D-05 acknowledges and defers
- Prompt-cache effectiveness for our specific prefix size: MEDIUM — depends on final prompt length crossing 4k

**Research date:** 2026-04-25
**Valid until:** 2026-05-25 (model deprecation cadence is the primary risk; recheck deprecation page before phase ship)
