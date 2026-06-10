// Brain ↔ adapter seam (D-5/D-6). The orchestrator receives
// an `adapter` at construction (see createOrchestrator below) and consumes
// every game-shaped capability through it:
//   - adapter.createSnapshotComposer()  (was: ../observers/snapshot)
//   - adapter.closeAnySessions()        (was: ../behaviors/container)
//   - adapter.worldPrimer()             (was: ./persona.js minecraftPrimer)
//   - adapter.executeAction(...)        (registry calls, including chat tx)
// The orchestrator never imports from src/adapter/ — verify with
// `grep -r "from '../adapter" src/brain/`.

import { createLlmProvider } from './llm/index.js'
import { VISION_MESSAGES_PATH } from './anthropicClient.js'
import { createTokenBucket } from './rateLimiter.js'
import { createDebouncer, createThrottle } from './debounce.js'
import { createChainTracker } from './chains.js'
import { createLoop } from './loop.js'
import {
  BASELINE_INSTRUCTIONS,
  PERSONALITY_TOOL_DESCRIPTIONS,
  NUDGES,
  renderPersona,
} from './prompts.js'
import { buildAnthropicTools } from './schemaBridge.js'
import { createInflightTracker } from './inflight.js'
import { createConvoMemory } from './convoMemory.js'
import { logChatOut, logActionResult } from './log.js'
import { createMemoryLog, readMemoryForSeed } from './memory/memoryLog.js'
import { createMemoryCompactor } from './memory/compactor.js'

// Post-process say() text before it hits in-game chat. Safety-only:
// whitespace collapse (chat is single-line), force lowercase (hardcoded),
// and a high 256-char hard cap so a runaway response cannot DoS the chat
// box. Length and shape are the model's job, enforced via the prompt rules
// in src/bot/brain/prompts.js — truncating mid-sentence here ships
// nonsense, so we do not.
export function postProcessSay(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 256)
}

/**
 * Suppress duplicate-consecutive say() within sei:loop_end loops.
 * Predicate is byte-equality after normalize: lowercase + strip non-alphanumeric +
 * collapse whitespace. Window: 2000ms. Only fires for triggerEvent === 'sei:loop_end'
 * to keep chat-triggered duplication audible (different intent, same words is fine
 * if the player asked twice).
 *
 * Threshold rationale (D-7 / log evidence): 2000ms covers the 13ms gap between
 * memory-postfix.txt L21+L27 and the ~3s gap between hunt+sand-postfix L183/189/197
 * cross-loop. Exact-after-normalize (rather than fuzzy ≥0.9) avoids false positives
 * where the model intentionally rephrases.
 *
 * @param {Object} args
 * @param {string} args.triggerEvent  — loop._triggerEvent
 * @param {string} args.candidateLine — postProcessSay output
 * @param {{at:number,text:string}|null} args.lastSelf — convoMemory.recentChat.lastSelf()
 * @param {number} [args.now=Date.now()]
 * @param {number} [args.windowMs=2000]
 * @returns {boolean} true = suppress, false = allow
 */
export function shouldSuppressLoopEndSay({ triggerEvent, candidateLine, lastSelf, now = Date.now(), windowMs = 2000 }) {
  if (triggerEvent !== 'sei:loop_end') return false
  if (!lastSelf || !lastSelf.text) return false
  if ((now - lastSelf.at) >= windowMs) return false
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return norm(candidateLine) === norm(lastSelf.text)
}

// System prompt assembly: combined BASELINE_INSTRUCTIONS (game-agnostic,
// brain/prompts.js) + adapter.actionRules() (game-specific, adapter/prompts.js).
// Joined with a blank line so each side can be edited independently.
// One Haiku call per iteration handles both reasoning and dispatch. The
// assistant's `text` blocks ARE the player-visible chat channel (like Claude
// Code / OpenCode): the agent loop emits any mix of text + tool_use per turn;
// text goes straight to in-game chat, tools execute.

// Tool names that are personality-only (do not require a follow-up
// iteration). Anything outside this set is a movement-registry action and
// keeps the loop running so the model can react to its result.
// noteToSelf is personality-only — its result is always
// "noted" / "error: …" and never warrants a follow-up iteration on its own.
// follow/unfollow only mutate the follow target; the actual trailing happens on
// a 1s background tick (behaviors/follow.js). Treating them as movement keeps
// the iteration loop alive and the LLM hot-spams follow() each turn, starving
// the tick. Classify them as personality so a follow-only turn is terminal.
//
// 260514-ngj: `stop` retired — see `end_loop` notes above.
// 260514-ngj: `stop` tool retired, replaced by `end_loop` (clearer semantics
// — the model uses end_loop ONLY when it has decided the current loop is done
// or wants to abandon the current task). On P0/P1-triggered iterations, the
// model now has four response options (R1-R4): text-only continues, text +
// new action switches in-place, text + end_loop terminates, text + end_loop
// + new action terminates AND reseeds. On P2/P3-triggered iterations, text-
// only still terminates the loop (unchanged).
const PERSONALITY_NAMES = new Set(['remember', 'forget', 'follow', 'unfollow', 'end_loop'])
const BYTE_WARN_THRESHOLD = 100 * 1024  // Q3 sanity assert per Loop

// 260516-0yw: action-tick interval. Exported via a module-level let so the
// test harness (scripts/test-actionTick.mjs) can shorten it via the
// `_setTickIntervalForTests` hook below without booting an orchestrator.
let _TICK_INTERVAL_MS = 10_000
export function _setTickIntervalForTests(ms) { _TICK_INTERVAL_MS = ms }
export function _getTickIntervalForTests() { return _TICK_INTERVAL_MS }

/**
 * 260502-h6i: chat-event classification used by the dispatch single-flight
 * branch. Player chat preempts an active Loop; non-player chat (or non-chat
 * events) drops while a Loop is active. Exposed as a pure helper so the
 * verify harness can assert the wiring without booting an orchestrator.
 *
 * Player sources:
 *   - any chat event with `data.playerSpoke === true`
 *   - the legacy `player_chat` event name (no flag required)
 */
// Render dispatch event data as a short readable string. Default JSON.stringify
// of adapter-supplied Entity objects produced enormous, often-circular blobs
// that the LLM ignored — and for `sei:attacked` it left the model guessing
// the attacker from the snapshot, which mis-blamed a far-off creeper when a
// player landed the hit.
export function formatEventData(event, data) {
  if (!data || typeof data !== 'object') return String(data ?? '')
  if (event === 'sei:attacked') {
    const label = data.attackerLabel ?? data.attacker?.username ?? data.attacker?.name ?? 'unknown'
    const kind = data.attackerKind ?? (data.attacker?.username ? 'player' : 'mob')
    return `attacker: ${label} (${kind})`
  }
  if (typeof data.text === 'string') return `text: ${data.text}`
  if (typeof data.message === 'string') return `text: ${data.message}`
  try {
    return JSON.stringify(data, (_k, v) => {
      // Strip adapter-supplied Entity objects — keep only the cheap label fields.
      if (v && typeof v === 'object' && (v.username || (v.type && v.position))) {
        return { name: v.name, username: v.username, type: v.type, id: v.id }
      }
      return v
    })
  } catch {
    return '(unserializable)'
  }
}

export function classifyChatEvent(event, data) {
  const isChatEvent = event === 'chat' || event === 'sei:chat'
                   || event === 'player_chat' || event === 'sei:chat_received'
  const isPlayerChat = isChatEvent && (data?.playerSpoke === true || event === 'player_chat')
  return { isChatEvent, isPlayerChat }
}

/**
 * Silent-iteration cadence helper.
 * Pure mutator — increments loop.iterationsSinceLastSay (or resets to 0 when
 * hadSay is true) and returns whether the next iteration should receive a
 * one-shot soft nudge in its user content.
 *
 * Soft nudge fires when iterationsSinceLastSay >= SILENT_ITERATIONS_BEFORE_NUDGE
 * AND no nudge has fired yet for this silent run (_progressNudgeFired is reset
 * the moment say() is emitted again).
 */
export const SILENT_ITERATIONS_BEFORE_NUDGE = 4
export function _advanceIterationCadence({ loop, hadSay }) {
  if (hadSay) {
    loop.iterationsSinceLastSay = 0
    loop._progressNudgeFired = false
    return false
  }
  loop.iterationsSinceLastSay = (loop.iterationsSinceLastSay ?? 0) + 1
  if (loop.iterationsSinceLastSay >= SILENT_ITERATIONS_BEFORE_NUDGE && !loop._progressNudgeFired) {
    loop._progressNudgeFired = true
    return true
  }
  return false
}

/**
 * Compose the seed user-turn blocks for the first iteration of every fresh
 * Loop. Order matters for caching: blocks before the cache_control marker
 * (on seed_cuboid_grammar) get prompt-cache hits across loops in the
 * session; blocks after re-bill per loop.
 *
 * @param {Object} args
 * @param {Object} args.sessionState
 * @param {Object} args.playerStore    — { formatPlayerSeedBlock, ... }
 * @param {Object} args.config
 * @param {string} args.eventText
 * @param {string} args.snapshotText
 * @param {Object} [args.adapter]     — supplies cuboidGrammar(); optional in tests
 * @returns {Promise<Array<{type:'text', name:string, text:string}>>}
 */
export async function composeSeedBlocks({
  sessionState, playerStore, config, eventText, snapshotText,
  adapter = null,
  recentPlayerChatText = null,
  yourRecentMessagesText = null,
  logger = console,
}) {
  const player = sessionState.playerData()
  const seedPlayerText = playerStore.formatPlayerSeedBlock(player, config.memory.seed_player_budget_bytes)
  const cuboidGrammarText = (typeof adapter?.cuboidGrammar === 'function')
    ? adapter.cuboidGrammar()
    : ''
  const blocks = [
    { type: 'text', name: 'seed_player', text: seedPlayerText },
    // Cache breakpoint: seed_player + seed_cuboid_grammar are stable across
    // loops in a session. Everything after re-bills per loop (memory is
    // appended every loop so caching it would never hit).
    { type: 'text', name: 'seed_cuboid_grammar', text: cuboidGrammarText, cache_control: { type: 'ephemeral' } },
  ]
  if (config?.memory?.memory_md_path) {
    try {
      const memoryText = await readMemoryForSeed(
        config.memory.memory_md_path,
        config.memory.seed_memory_budget_bytes ?? 8192,
      )
      if (memoryText && memoryText.length > 0) {
        blocks.push({ type: 'text', name: 'memory', text: memoryText })
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT' && err.code !== 'EACCES') {
        logger.warn?.(`[sei/orch] memory read failed: ${err && err.message}`)
      }
    }
  }
  if (recentPlayerChatText) {
    blocks.push({ type: 'text', name: 'recent_player_chat', text: recentPlayerChatText })
  }
  if (yourRecentMessagesText) {
    blocks.push({ type: 'text', name: 'your_recent_messages', text: yourRecentMessagesText })
  }
  blocks.push({ type: 'text', name: 'event',    text: eventText })
  blocks.push({ type: 'text', name: 'snapshot', text: snapshotText })
  return blocks
}

/**
 * @param {object} deps
 * @param {object} deps.adapter        Adapter implementing src/brain/types.js
 *                                     contract. Replaces the old `bot` and
 *                                     `registry` parameters — every game-shaped
 *                                     capability flows through this object.
 * @param {object} deps.config
 * @param {{warn:Function,info:Function,error:Function,debug?:Function}} [deps.logger]
 * @param {object} [deps.sessionState] — optional during transition
 * @param {object} [deps.playerStore]   — { loadPlayer, savePlayer, formatPlayerSeedBlock }
 * @param {(event:string, data:any, priority?:number) => void} [deps.reenqueue]
 *   Brain-side dispatcher. Used by the orchestrator to re-fire events
 *   (sei:loop_terminal at P2.5, sei:attacked at P0) back through the
 *   priority queue. Required when the brain runs in production; defaults
 *   to a no-op for test harnesses.
 */
export function createOrchestrator({ adapter, config, logger = console, sessionState = null, playerStore = null, reenqueue = () => {}, onTerminalError = null, _anthropicOverride = null }) {
  if (!adapter) throw new Error('createOrchestrator: adapter required')
  // Locally re-bind into the same names the body uses; the registry surface
  // is exposed through the adapter rather than a separate parameter.
  const registry = {
    list: () => adapter.listActions(),
    schema: (name) => adapter.getActionSchema(name),
    description: (name) => adapter.getActionDescription(name),
    execute: (name, args, _bot, execOpts) => adapter.executeAction(name, args, execOpts),
  }
  // Phase 13: latched when the proxy returns 402 (cloud credits depleted).
  // Once latched, handleDispatch drops every subsequent event so the bot
  // stops emitting personality calls (which would all 402 again) and the
  // game-state-rich [haiku?] request log doesn't get printed for each fresh
  // chat/idle tick. The supervisor tears the process down on the lifecycle
  // 'error' that onTerminalError emits — this is just defense in depth in
  // case the bot survives long enough to see more events first.
  let _halted = false
  // 260513-wkd: _anthropicOverride is a verify-harness seam. The harness
  // (scripts/verify-260513-wkd.mjs) needs to drive a scripted sequence of
  // Haiku responses without hitting the real API. Production callers leave
  // this null. Phase 14: production path goes through `createLlmProvider`,
  // which selects an adapter from `config.llm.provider` (defaults to the
  // existing Anthropic path so configs that pre-date this phase are unchanged).
  const anthropic = _anthropicOverride ?? createLlmProvider(config)
  // MEMORY.md store — long-term memory the LLM writes via remember() /
  // forget() and reads back in the seed turn each loop.
  const memoryLog = createMemoryLog({ path: config.memory.memory_md_path })
  // Compactor: async Haiku-driven rewrite when MEMORY.md exceeds the
  // configured trigger size. Fired fire-and-forget after each successful
  // remember(); single-flight inside the compactor itself.
  const memoryCompactor = createMemoryCompactor({ anthropic, memoryLog, config, logger })
  const personalityBucket = createTokenBucket({
    capacity: config.llm.rate_limit_per_min,
    refillPerMin: config.llm.rate_limit_per_min,
  })
  const ingressDebouncer = createDebouncer(config.llm.debounce_ms)
  // Leading-edge throttle for interruptive events (e.g. attack bursts) — first
  // hit fires immediately; rapid follow-ups within debounce_ms are suppressed.
  const ingressThrottle = createThrottle(config.llm.debounce_ms)
  // Tracks the currently-running action so the snapshot can render `in_flight:`
  // and follow.js can pause for the entire action lifecycle (not just the
  // dispatch lifecycle). See ./inflight.js.
  const inflight = createInflightTracker()
  // Stateful snapshot composer — wraps the adapter's per-instance composer
  // and injects a `recent_events:` line with inventory/kill/hp deltas since
  // the prior snapshot for this orchestrator instance.
  const snapshotComposer = adapter.createSnapshotComposer()
  // Conversation memory (260505-iqo): split player/self recentChat sub-buffers
  // and a loopHistory ring of completed-loop summaries. Injected into the seed
  // user turn so the LLM has cross-loop continuity (short replies like "yes" /
  // "do it" need player context; loopHistory keeps the bot from re-asking
  // questions or rediscovering tasks across cold-composed loops).
  const convoMemory = createConvoMemory()
  // chains is a no-op shim (kept to preserve any stragglers referencing it).
  const chains = createChainTracker({ maxHops: config.llm.max_hops })

  // ─── Single-flight Loop state (Pitfall 6) ────────────────────────────
  // At most one Loop is active at any time. Idle dispatches are gated on
  // currentLoop === null (D-39 / SPEC A2). Player-chat dispatches that arrive
  // while a Loop is active enter the interrupt path (D-40). Anything else
  // is dropped with a structured warn (defense-in-depth; the FSM should
  // already prevent it).
  let currentLoop = null
  // Pending interrupt blocks supplied via abort signal — picked up by the
  // catch arm to render the PLAYER INTERRUPT user turn.
  let pendingInterrupt = null
  // 260505-twx: Pending attack to re-fire after the current loop's finally
  // clears currentLoop. Set when sei:attacked arrives mid-loop; consumed
  // by handleDispatch's finally block via reenqueue() so the brain's
  // priority queue re-enqueues the dispatch at P0, which then arrives with
  // currentLoop === null and opens a fresh loop with the attack seed
  // addendum.
  let pendingAttack = null

  // Personality-only tools: remember, forget, end_loop. Player-visible
  // speech is the assistant's `text` output (handled by the orchestrator's
  // chat-emit path); there is no `say` tool — text blocks ARE the chat channel.
  //
  // Tool descriptions live in src/bot/brain/prompts.js →
  // PERSONALITY_TOOL_DESCRIPTIONS.
  const personalityTools = [
    {
      name: 'remember',
      description: PERSONALITY_TOOL_DESCRIPTIONS.remember,
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, description: 'The line to write to memory, in your own voice.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'forget',
      description: PERSONALITY_TOOL_DESCRIPTIONS.forget,
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, description: 'A distinctive substring of the memory line(s) to remove. Case-insensitive.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'end_loop',
      description: PERSONALITY_TOOL_DESCRIPTIONS.end_loop,
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]

  // Combined tools = personality tools + movement registry tools.
  function combinedToolsFor() {
    const subRegistry = {
      list:   () => registry.list(),
      schema: (n) => registry.schema(n),
    }
    // Pull descriptions from the adapter (game-specific tool prompts live
    // in src/bot/adapter/<game>/prompts.js → ACTION_DESCRIPTIONS).
    const descMap = Object.fromEntries(
      subRegistry.list().map(n => [n, adapter.getActionDescription(n)])
    )
    // VIS-03 / D-10 belt-and-suspenders gate: even if `visualize` leaked into
    // the registry on a non-VLM provider, never offer it in the tool list. The
    // provider handle the orchestrator already holds exposes capabilities.vision
    // (anthropicProvider.js CAPABILITIES; other providers expose the same shape,
    // fail-closed false). This is the AUTHORITATIVE gate — the adapter-side
    // conditional registration (createDefaultRegistry visionEnabled) is the
    // second belt; either alone keeps a non-VLM model from ever seeing the tool.
    const visionOk = !!anthropic.capabilities?.vision
    const movementTools = buildAnthropicTools(subRegistry, descMap)
      .filter(t => visionOk || t.name !== 'visualize')
    const seen = new Set(personalityTools.map(t => t.name))
    const merged = [...personalityTools]
    for (const t of movementTools) {
      if (!seen.has(t.name)) { merged.push(t); seen.add(t.name) }
    }
    return merged
  }

  let cachedSystemBlocks = null
  function rebuildPersonalitySystem() {
    // Static blocks composed from brain (game-agnostic) + adapter (game-specific).
    // Order is fixed for cache-key stability and indexed by src/bot/brain/log.js
    // (persona at [1], capability at [2]).
    cachedSystemBlocks = anthropic.buildCachedSystem(
      [
        BASELINE_INSTRUCTIONS,
        renderPersona(config.persona),
        adapter.capabilityParagraph(),
        adapter.worldPrimer(),
        adapter.actionRules(),
      ],
      combinedToolsFor()
    )
  }
  rebuildPersonalitySystem()

  // Last result string from any registry.execute() this orchestrator has performed.
  // Fed back into the next personality turn via composeSnapshot's lastActionResult.
  let lastActionResult = null

  // VIS-07/D-09 one-shot: set true ONLY on the explicit-`visualize` completion
  // branch (never idle, never any other action), read+cleared by callPersonality
  // so EXACTLY the one post-visualize personality turn routes through the proxy
  // `/vision/v1/messages` per-hour cap — and only in cloud-proxy mode (D-11).
  let _pendingVisionTurn = false

  /**
   * VIS-02 + VIS-07/D-09: normalize a `visualize` action-completion result and,
   * for a successful EXPLICIT render, attach the frame as a FRESH user image
   * turn + arm the one-shot vision-path flag. Called by BOTH action-completion
   * paths (handleActionComplete and handleActionCompleteTickClaimed) BEFORE the
   * generic slot-fill / lastActionResult assignment so the structured
   * { text, image:{ mediaType, dataBase64 } } object NEVER leaks into the
   * tool_result content, into lastActionResult (a string-consumer — the
   * snapshot `last_action_result` line), or into conversation history as raw
   * base64 (hazard #2).
   *
   * The visualize result contract (15-04):
   *   SUCCESS  : { text:string, image:{ mediaType:string, dataBase64:string } }
   *   DEGRADE  : "I can't see clearly right now" (string)  -> VIS-08
   *   IDLE-SKIP: { skip:true }
   *   ABORTED  : 'aborted' (string)
   *
   * @param {object} loop
   * @param {*} result  data.result from the completion event
   * @param {{ idle?: boolean }} [opts]  idle render (15-07) sets idle:true — it
   *   attaches an image but NEVER arms the vision-path flag (D-09: idle stays on
   *   /v1/messages).
   * @returns {{ resultText: string }} the SHORT string to put in the tool_result
   *   content and lastActionResult (caller does the actual slot-fill).
   */
  function handleVisualizeResult(loop, result, { idle = false } = {}) {
    // Structured success — the ONLY shape that carries an image.
    if (result && typeof result === 'object' && result.image &&
        typeof result.text === 'string' &&
        typeof result.image.dataBase64 === 'string') {
      const { mediaType, dataBase64 } = result.image
      try {
        // Image rides a FRESH user turn (Pitfall 4 — never inside the
        // tool_result). Provider-neutral block (== Anthropic wire shape);
        // messageMappers translates it per provider. NO `name` on the image
        // block (the SDK has no name field there); the event text keeps `name`
        // so the snapshot-strip rules treat it like any other event line.
        loop.appendUserTurn([
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataBase64 } },
          { type: 'text', name: 'event', text: result.text },
        ])
      } catch (err) {
        logger.warn?.(`[sei/orch] visualize image append failed: ${err.message}`)
      }
      // VIS-07/D-09: arm the one-shot vision-path flag for EXPLICIT renders
      // only. Idle (15-07) passes idle:true and stays on /v1/messages.
      if (!idle) _pendingVisionTurn = true
      // The tool_result / lastActionResult get the SHORT text, not the object.
      return { resultText: result.text }
    }
    // Degrade string (VIS-08), 'aborted', or any other string: pass through as
    // the tool_result text; no image, no vision flag.
    if (typeof result === 'string') return { resultText: result }
    // { skip:true } idle near-duplicate, or any other shape: brief text, no image.
    if (result && typeof result === 'object' && result.skip === true) {
      return { resultText: 'no fresh view' }
    }
    // Fallback (shouldn't happen for visualize): stringify defensively so a raw
    // object never reaches a string-consumer.
    return { resultText: typeof result === 'string' ? result : 'done' }
  }

  // `start()` is a no-op kept for API compatibility — brain.start() calls
  // `orchestrator.start().catch(...)` after wiring the adapter.
  async function start() {}

  // ─── Snapshot helper ────────────────────────────────────────────────
  function snapshotText() {
    try {
      return snapshotComposer.next({
        lastActionResult,
        inFlight: inflight.current(),
        // Player-priority pin: keep the player in `nearby entities` even when
        // six other entities are closer. Without this, busy-area entity
        // congestion (sheep / foxes / traders / llamas) can evict the player
        // from the snapshot and the model loses player coords for goTo/follow.
        pinUsername: config.player_username ?? null,
      })
    } catch (err) {
      logger.warn(`[sei/orch] composeSnapshot failed: ${err.message}`)
      return '(snapshot unavailable)'
    }
  }

  // Walk loop history backwards to find the most recent in-flight task
  // worth resuming. Skips personality-only metadata tools. Returns a
  // short string suitable for inlining as `prior_task: <…>` in a PLAYER
  // INTERRUPT user turn, or null if nothing worth surfacing.
  function extractPriorTask(loop) {
    const msgs = loop._internal.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (let j = m.content.length - 1; j >= 0; j--) {
        const blk = m.content[j]
        if (!blk || blk.type !== 'tool_use') continue
        if (blk.name === 'remember' || blk.name === 'forget') continue
        // Combined-mode movement action.
        const a = blk.input ?? {}
        const parts = []
        if (typeof a.entity === 'string') parts.push(a.entity)
        else if (typeof a.target === 'string') parts.push(a.target)
        else if (typeof a.block === 'string') parts.push(a.block)
        else if (typeof a.player === 'string') parts.push(a.player)
        if (typeof a.times === 'number') parts.push(`times=${a.times}`)
        return `${blk.name}${parts.length ? ' ' + parts.join(' ') : ''}`.slice(0, 120)
      }
    }
    return null
  }

  // 260608-tik: the tool that aborts the currently-running action. follow is
  // PERSISTENT background state (a 1s pathfinder tick keeps it alive even after
  // the loop ends), so end_loop does NOT stop it — only `unfollow` does.
  // Everything else is a foreground task that end_loop aborts. `actionLabel` is
  // extractPriorTask's "name arg" string; we key off the leading tool name.
  function stopToolForAction(actionLabel) {
    const name = actionLabel ? actionLabel.split(' ')[0] : null
    return name === 'follow' ? 'unfollow' : 'end_loop'
  }

  // 260608-tik: unified mid-action interrupt text (Change 2). Every path that
  // delivers a player message while an action is running (handleActionTick P1
  // variant, repairAfterAbort, and the fold fallbacks) renders through this so
  // they read identically. The action is still considered live, so the framing
  // matches the silent action-tick monitor — it just carries the player's words.
  function interruptTurnText(loop, chatText, who = null) {
    const action = extractPriorTask(loop)
    return NUDGES.actionTurn({
      action,
      stopTool: stopToolForAction(action),
      playerLine: chatText ?? '',
      who: who ?? null,
    })
  }

  // 260514-gam D1 (B/A/A locked): every world-touching tool dispatches
  // non-blocking via startLongRunner so the loop suspends and is preemptible
  // by P1 player-chat / P0 attack within one signal tick. Only pure-metadata
  // tools (remember / forget / end_loop) stay inline — they complete in
  // microseconds and gain nothing from suspend/resume, and routing them
  // through action_complete would inflate iteration count and add a haiku
  // continuation per call for no benefit.
  //
  // Dispatch model after 260514-gam (refined by 260514-ngj):
  //   - INLINE_METADATA tool → fill result inline via inflight.start/end,
  //     keep processing the same batch.
  //   - Anything else → startLongRunner, stash remaining tool_uses on
  //     loop._pendingToolUses, suspend. handleActionComplete drains the
  //     queue one tool at a time. ONE haiku call fires per logical turn,
  //     not per tool.
  //   - R3 (end_loop) and R4 (end_loop + new action) abort
  //     loop.inFlight.abortController; since every non-inline tool now goes
  //     through startLongRunner, those branches transparently apply to sync
  //     tools too.
  const INLINE_METADATA = new Set(['remember', 'forget', 'end_loop'])
  function isInlineMetadata(name) {
    return INLINE_METADATA.has(name)
  }

  // The progress-flavored detection includes `gather` (in addition to
  // build + cuboid dig). Same onProgress channel as cuboid — no parallel
  // pattern, no invented config field (CONTEXT.md "Signal threading scope").
  function _buildExecOpts(name, args, execOpts, handle) {
    const isProgressFlavored = name === 'build'
      || name === 'gather'
      || (name === 'dig' && args && args.to)
    return isProgressFlavored
      ? { ...execOpts, onProgress: (p) => inflight.updateProgress(handle, p) }
      : execOpts
  }

  /**
   * 260513-wkd / 260514-gam: kick off a non-blocking tool dispatch in the
   * background. Returns synchronously with the action's promise + its own
   * AbortController + the inflight tracker handle. The caller wires
   * `.then`/`.catch`/`.finally` onto the promise (e.g. to reenqueue
   * sei:action_complete on settle).
   *
   * Since 260514-gam, this is the universal dispatch path for every
   * world-touching tool — sync (placeBlock, equip, find, lookAt, dropItem,
   * activateItem, sleep, openContainer, depositItem, withdrawItem,
   * consumeItem, follow, unfollow) and async (goTo, gather, dig, build,
   * attackEntity) alike. Only INLINE_METADATA (remember/forget/end_loop)
   * skip this path.
   *
   * The returned `abortController` is INDEPENDENT of the loop's outer
   * abortController. P0/P1 preempt aborts BOTH (loop's outer for the next
   * Haiku call; in_flight's for the running behavior).
   */
  function startLongRunner(name, args, execOpts) {
    const handle = inflight.start({ name, args })
    const abortController = new AbortController()
    const opts = _buildExecOpts(name, args, { ...execOpts, signal: abortController.signal }, handle)
    const promise = (async () => {
      try {
        return await registry.execute(name, args, null /* adapter owns bot */, opts)
      } finally {
        inflight.end(handle)
      }
    })()
    return { promise, abortController, handle, startedAt: handle.startedAt }
  }

/**
 * Dedup helper for PLAYER INTERRUPT preservation.
 * Stores the last-preserved signature on the loop and refuses to re-preserve
 * the same signature. Returns true iff the caller should proceed with
 * preservation. Pure-ish (mutates loop._lastPreservedSig) so the runtime
 * path is the source of truth.
 */
function shouldPreserveInterrupt(loop, sig) {
  if (loop._lastPreservedSig === sig) return false
  loop._lastPreservedSig = sig
  return true
}

// Serialize a registry action's return value into the short string fed back to
// the model (as tool_result content AND as the next snapshot's
// last_action_result line). Strings pass through; `{ok}` results use the
// long-standing `name:ok|fail` shorthand; richer structured payloads (e.g.
// `find` returning {found,id,pos,distance}) are JSON-stringified so the model
// can actually act on the data. Capped to keep snapshots bounded.
function formatToolResult(name, r) {
  if (typeof r === 'string') return r
  if (r == null) return 'done'
  if (typeof r !== 'object') return String(r)
  // VIS-02 (hazard #2): the structured `visualize` success result
  // ({ text, image:{ mediaType, dataBase64 } }) and the idle `{ skip:true }`
  // sentinel must reach handleActionComplete as OBJECTS, not JSON. If we
  // stringified here, the base64 would be baked into data.result before the
  // image-attach interception runs — leaking it into the tool_result and
  // last_action_result. Pass the structured visualize shape through untouched;
  // handleVisualizeResult downstream extracts the SHORT text for the tool_result
  // and rides the image on a fresh user turn.
  if (name === 'visualize' && (
    (r.image && typeof r.text === 'string') || r.skip === true
  )) {
    return r
  }
  if (typeof r.ok !== 'undefined' && Object.keys(r).length <= 2) {
    return `${name}:${r.ok ? 'ok' : 'fail'}`
  }
  let json
  try { json = JSON.stringify(r) } catch { return 'done' }
  if (json.length > 240) json = json.slice(0, 237) + '...'
  return json
}

function maybeWarnByteCap(loop, warned) {
    if (warned.flag) return warned
    if (loop.byteSize() > BYTE_WARN_THRESHOLD) {
      logger.warn(`[sei/orch] loop ${loop.id} exceeds ${BYTE_WARN_THRESHOLD} bytes (size=${loop.byteSize()}) — sanity warning (Q3)`)
      warned.flag = true
    }
    return warned
  }

  // ─── Main dispatch (Loop-driven, D-38..D-45) ─────────────────────────
  /**
   * Single entry point. Wired to FSM `sei:dispatch` events.
   *
   * Single-flight (D-39 / Pitfall 6):
   *  - currentLoop === null → start a fresh Loop and begin iterating.
   *  - currentLoop !== null AND event is player-chat → enter interrupt path.
   *    The dispatch handler triggers loop.abortController; whatever Anthropic
   *    call / action is in flight throws AbortError; the catch arm
   *    synthesizes paired tool_result blocks for orphan tool_uses and
   *    appends a PLAYER INTERRUPT user turn (D-40).
   *  - currentLoop !== null AND event is anything else → drop with warn.
   *
   * Idle gate (D-39 / SPEC A2): events of type `idle` are dropped if a Loop
   * is already running.
   */
  async function handleDispatch(event, data, signal) {
    // Phase 13: drop everything once cloud credits are depleted. Without this
    // gate, every chat/idle tick fires a fresh personality call which all 402
    // again — costing nothing but leaking the [haiku?] request log to stdout.
    if (_halted) return
    // 260502-h6i: chat events arrive from src/behaviors/chat.js as
    // `sei:chat_received` with an `playerSpoke` flag. The legacy `player_chat`
    // shape is preserved for backwards-compat.
    const { isPlayerChat } = classifyChatEvent(event, data)
    const isIdle     = event === 'idle' || event === 'sei:idle'

    // Defense-in-depth idle gate (D-39): the FSM should already prevent this,
    // but if an idle tick races into the orchestrator while a Loop is active,
    // drop it.
    if (isIdle && currentLoop !== null) {
      logger.debug?.(`[sei/orch] idle gated — currentLoop active (loop=${currentLoop.id}, iterations=${currentLoop.iterationCount})`)
      return
    }

    // 260513-wkd: sei:action_complete drives the next iteration when a
    // long-runner settles. Routed at Priority.P2_ACTION_COMPLETE (2.1).
    // Drops if no currentLoop (the loop already terminated before the
    // action_complete arrived — e.g. case 2 stop dropped the loop before the
    // aborted in_flight's settle handler fired). Drops if the loop is
    // already terminal (same scenario; the late action_complete is
    // informational only).
    if (event === 'sei:action_complete') {
      if (currentLoop === null) {
        logger.debug?.(`[sei/orch] sei:action_complete arrived with no currentLoop — drop (name=${data?.name}, aborted=${data?.aborted})`)
        return
      }
      if (currentLoop.isTerminal) {
        logger.debug?.(`[sei/orch] sei:action_complete arrived with terminal loop — drop (loop=${currentLoop.id})`)
        return
      }
      // 260517-fix: tick-claimed path. The action's tool_use was already
      // paired with a synthesized "in progress" tool_result by handleActionTick.
      // The real settle is informational — route it through the dedicated
      // handler instead of trying to fill a slot that no longer exists.
      if (data?.tickClaimed) {
        await handleActionCompleteTickClaimed(currentLoop, data)
        return
      }
      if (currentLoop._pendingActionUse && currentLoop._pendingActionUse.id === data?.tool_use_id) {
        await handleActionComplete(currentLoop, data)
      } else {
        logger.debug?.(`[sei/orch] sei:action_complete tool_use_id mismatch — pending=${currentLoop._pendingActionUse?.id}, got=${data?.tool_use_id}`)
      }
      return
    }

    // 260516-0yw: sei:action_tick drives ONE extra silent-default iteration
    // while a long-runner is in_flight. Drops if loop terminal or in_flight
    // already cleared (the tick raced against a settle / abort). Priority
    // 2.3 sits below P2_ACTION_COMPLETE (2.1), so a same-batch settle drains
    // first and the tick is naturally suppressed by the in_flight=null check.
    if (event === 'sei:action_tick') {
      if (currentLoop === null) {
        logger.debug?.(`[sei/orch] sei:action_tick arrived with no currentLoop — drop`)
        return
      }
      if (currentLoop.isTerminal) {
        logger.debug?.(`[sei/orch] sei:action_tick arrived with terminal loop — drop (loop=${currentLoop.id})`)
        return
      }
      if (!currentLoop.inFlight) {
        logger.debug?.(`[sei/orch] sei:action_tick arrived with no in_flight — drop (loop=${currentLoop.id})`)
        return
      }
      await handleActionTick(currentLoop, data)
      return
    }

    // Single-flight branch: while a Loop is active, player-chat preempts
    // (interrupt path) and sei:attacked aborts (re-fired by finally as a
    // fresh dispatch — 260505-twx). Anything else is dropped.
    if (currentLoop !== null) {
      if (isPlayerChat) {
        const chatText = (data && (data.text ?? data.message)) ?? JSON.stringify(data ?? {})
        const who = data?.username ?? data?.who ?? ''
        // PLAYER INTERRUPT dedup on a (username:text:500ms-bucket) signature;
        // the second arrival within the same bucket is dropped. 500ms matches
        // the FSM event debounce.
        const sig = `${who}:${chatText}:${Math.floor((data?.ts ?? Date.now()) / 500)}`
        if (!shouldPreserveInterrupt(currentLoop, sig)) {
          logger.debug?.(`[sei/orch] PLAYER INTERRUPT dedup — skipping duplicate (sig=${sig})`)
          return
        }
        // 260608-tik (Change 1): when an action is running and NO Haiku call is
        // parked, deliver the message through the action-tick machinery WITHOUT
        // aborting the action. The body keeps doing what it was doing; the model
        // decides — reply (R1, action survives), switch (R2 aborts + restarts),
        // or stop (end_loop / unfollow, R3). This is the common case: a chat
        // landing while the loop is suspended on a long-runner. handlePreempt
        // already covers the LLM-in-flight case (it aborts the stale call, not
        // the action). The abort-and-fold fallback below only fires in the rare
        // race where a call started between enqueue and here, or there is no
        // in_flight to monitor (transient between-action window).
        if (currentLoop.inFlight && !currentLoop._llmCallInFlight && !currentLoop.isTerminal) {
          await handleActionTick(currentLoop, { playerMessage: String(chatText), who })
          return
        }
        pendingInterrupt = { chatText: String(chatText), who }
        if (currentLoop.inFlight) {
          clearActionTick(currentLoop.inFlight)
          try { currentLoop.inFlight.abortController.abort() } catch {}
        }
        try { currentLoop.abortController.abort() } catch {}
        return
      }
      if (event === 'sei:attacked') {
        // P0 safety: drop the in-flight loop and re-fire the attack as a
        // fresh dispatch via teardownLoop.
        //
        // 260513-wkd: in the new non-blocking model, currentLoop.abortController
        // alone is no longer sufficient — the loop may be SUSPENDED with a
        // live in_flight (no callPersonality awaiting). Abort BOTH the
        // in_flight (so the long-runner halts) AND the outer signal (in
        // case the loop is mid-callPersonality). Then synchronously call
        // teardownLoop so the pendingAttack re-enqueue fires immediately.
        // Without this, the loop would suspend forever waiting for an
        // action_complete that arrives normally — but by then, the P0
        // attack semantics are lost.
        //
        // If a pending player-chat interrupt was set
        // before this attack arrived, FORWARD the chat text into the next
        // loop. The priority queue runs P0 before P1, so the attack opens a
        // fresh loop first; the chat then arrives as a normal P1 dispatch.
        const preservedInterrupt = pendingInterrupt
          ? { chatText: pendingInterrupt.chatText, who: pendingInterrupt.who ?? data?.who ?? 'player' }
          : null
        pendingAttack = { event, data, preservedInterrupt }
        pendingInterrupt = null  // explicit: attack-wins-with-preservation
        const dyingLoop = currentLoop
        if (dyingLoop.inFlight) {
          // 260516-0yw: clear the 10s action-tick BEFORE aborting the
          // in-flight on a P0 attack preempt. Use dyingLoop (the loop
          // variable in scope here), NOT `loop`.
          clearActionTick(dyingLoop.inFlight)
          try { dyingLoop.inFlight.abortController.abort() } catch {}
        }
        try { dyingLoop.abortController.abort() } catch {}
        // Flag terminal and tear down. teardownLoop fires the
        // pendingAttack re-enqueue at P0 so a fresh loop opens with the
        // attack seed addendum (verbal-first eventAddendum).
        terminateLoop(dyingLoop, 'P0-attack-preempt')
        await teardownLoop(dyingLoop)
        return
      }
      logger.warn(`[sei/orch] dispatch ${event} arrived while loop active — dropping`)
      return
    }

    // ── Fresh Loop ──
    // Pitfall 6: clean up any leaked container session from a prior dispatch.
    try { await adapter.closeAnySessions() } catch {}

    const loop = createLoop({ iterationCap: config.memory.iteration_cap, logger })
    currentLoop = loop
    // Capture trigger context for downstream gating (e.g. loop_end dedup of
    // text emissions). classifyChatEvent handles player_chat / sei:chat_received
    // aliases.
    loop._triggerEvent = event
    // 260514-ngj: capture the trigger event's data so R4 (end_loop + new
    // action) can reseed a fresh loop with the ORIGINAL trigger payload
    // (preserves player chat text, attacker label, etc.). Pre-260514-ngj this
    // was implicitly null, which made the case-3 reseed path lose the
    // player-chat context entirely.
    loop._triggerData = data ?? null
    loop._playerSpoke = !!data?.playerSpoke || event === 'player_chat'
    // 260514-ngj: per-iteration trigger flag. At loop creation it equals
    // _triggerEvent; handleActionComplete updates it to reflect the SOURCE
    // of each subsequent iteration (PLAYER INTERRUPT mid-loop preempt resets
    // it back to 'sei:chat_received'; a natural action_complete sets it to
    // 'sei:action_complete'). Used by runIterations to decide R1-R4 gating.
    loop._currentIterationTrigger = event
    // Track goTo cant_reach destinations seen this loop.
    // Key: `${x}|${y}|${z}|${range}`. Value: count. On count >= 2 we inject a
    // one-shot nudge referencing the SYSTEM_INSTRUCTIONS Pathfinder rule
    // rather than letting the LLM keep retrying. Per-loop scope so a fresh
    // dispatch starts clean.
    loop._cantReachMap = new Map()
    loop._cantReachNudgedKeys = new Set()
    // Silent-iteration cadence counter for the progress-narration soft nudge.
    loop.iterationsSinceLastSay = 0
    loop._progressNudgeFired = false
    // Capture the FSM-supplied signal so subsequent
    // replaceAbortController calls can re-bridge it onto the new internal
    // controller. Without this, only the FIRST external abort routes
    // through; any second-turn external interrupt is silently dropped.
    loop._externalSignal = signal ?? null
    loop._externalAbortListener = null
    logger.info?.(`[sei/orch] loop start (id=${loop.id}, event=${event})`)
    const byteWarn = { flag: false }

    // Compose the first user turn (D-45). When the memory layer
    // is wired (sessionState + playerStore + diary), inject seed_player +
    // seed_diary blocks and mark the turn `seed: true` so Loop preserves
    // them across iterations. Otherwise fall back to event/snapshot only.
    //
    // Per-event seed addendum supplied by the adapter (game-specific framing
    // for loop_end / idle / attacked lives in src/bot/adapter/<game>/prompts.js
    // → EVENT_GUIDANCE). Player-chat / attack iterations additionally get the
    // R1-R4 interrupt-response reminder (brain-level — NUDGES.playerInterruptHint).
    // 260608-tik (Change 2): safety events (attack; later hunger/critical
    // health) reseed a fresh loop. Give them the adapter's clean one-line
    // framing ("Interrupted — X hit you. Respond appropriately.") alone — no
    // Event/Data wrapper, no interrupt hint. Chat/idle/join keep the structured
    // form; P1 chat seeds still get the playerInterruptHint.
    const isSafetyEvent = event === 'sei:attacked'
    let eventText
    if (isSafetyEvent && typeof adapter.eventAddendum === 'function') {
      eventText = adapter.eventAddendum(event, data).trim()
    } else {
      let eventAddendum = (typeof adapter.eventAddendum === 'function')
        ? adapter.eventAddendum(event === 'idle' ? 'sei:idle' : event, data)
        : ''
      const isP1Event = event === 'player_chat' || event === 'sei:chat_received'
      if (isP1Event) {
        eventAddendum += NUDGES.playerInterruptHint
      }
      eventText = `Event: ${event}\nData: ${formatEventData(event, data)}${eventAddendum}`
    }
    if (sessionState && playerStore) {
      let seedBlocks
      try {
        seedBlocks = await composeSeedBlocks({
          sessionState, playerStore, config, adapter,
          eventText, snapshotText: snapshotText(),
          recentPlayerChatText: convoMemory.recentChat.formatPlayerBlock(),
          yourRecentMessagesText: convoMemory.recentChat.formatSelfBlock(),
          logger,
        })
      } catch (err) {
        logger.warn(`[sei/orch] seed-block compose failed: ${err.message}; falling back to non-seed turn`)
        seedBlocks = null
      }
      if (seedBlocks) {
        loop.appendUserTurn(seedBlocks, { seed: true })
      } else {
        loop.appendUserTurn([
          { type: 'text', name: 'snapshot', text: snapshotText() },
          { type: 'text', name: 'event',    text: eventText },
        ])
      }
    } else {
      loop.appendUserTurn([
        { type: 'text', name: 'snapshot', text: snapshotText() },
        { type: 'text', name: 'event',    text: eventText },
      ])
    }

    // ── VIS-04 (15-07): idle auto-render hook ────────────────────────────
    // On the existing P3 `sei:idle` tick (NO new timer — 15-PATTERNS.md "Idle
    // (P3) tick reuse"), BEFORE the normal idle LLM turn, run the composite
    // fail-closed gate (auto_render ON + provider VLM + owner ≤16 blocks + LOS
    // clear). When it passes, render the bot's POV (idle:true → D-02 pose-dedupe)
    // and attach the frame to THIS idle turn's user content via the SAME 15-06
    // mechanism (handleVisualizeResult). Gated-out, deduped ({skip:true}), and
    // degrade-string results attach nothing and the loop proceeds with the normal
    // idle turn. CRITICAL (D-09): idle uses the STANDARD LLM path — handleVisualizeResult
    // is called with idle:true so it does NOT arm the one-shot _pendingVisionTurn
    // flag; the idle turn is never routed through /vision/v1/messages (only the
    // EXPLICIT visualize path hits the per-hour cap). Reuses the adapter so the
    // bot reference stays adapter-side (brain↔adapter seam).
    if (isIdle && typeof adapter.shouldAutoRenderIdle === 'function') {
      try {
        if (adapter.shouldAutoRenderIdle(anthropic) && typeof adapter.renderIdleFrame === 'function') {
          const idleResult = await adapter.renderIdleFrame()
          // Attaches the frame on a fresh image user-turn for the structured
          // success shape; no-op (text only, no image) for {skip:true} / degrade.
          // idle:true ⇒ never arms _pendingVisionTurn (D-09 — standard path).
          handleVisualizeResult(loop, idleResult, { idle: true })
        }
      } catch (err) {
        // Auto-render is best-effort: any failure leaves the normal idle turn
        // intact. Never let a render hiccup wedge or abort the idle loop.
        logger.warn?.(`[sei/orch] idle auto-render skipped: ${err && err.message}`)
      }
    }

    // Bridge: external signal (FSM) -> loop.abortController so handlers
    // respect both. The fresh Loop's controller is what actions hook into.
    //
    // bridgeExternalAbort installs the listener and
    // is called both at loop creation AND from replaceAbortController on
    // every internal-controller swap. The previous { once: true } listener
    // would be consumed by the first external abort, leaving second-turn
    // external aborts undelivered to the new controller. The helper
    // re-installs a fresh { once: true } listener pointing at the current
    // abortController so subsequent external aborts route correctly.
    bridgeExternalAbort(loop)

    // 260513-wkd: stash the originating event + byteWarn on the loop so
    // teardownLoop can use them even if it runs after handleDispatch returns
    // (which is the new non-blocking dispatch contract — handleDispatch
    // returns once the first iteration step dispatches a long-runner; the
    // loop teardown runs later, in response to action_complete or a
    // mid-loop preempt that terminates the loop).
    loop._originatingEvent = event
    loop._byteWarn = byteWarn

    // Run the first iteration step. If it dispatches a long-runner,
    // runIterations early-returns (loop.inFlight set); handleDispatch then
    // returns immediately. If it terminates naturally (no tools, stop, etc.),
    // teardownLoop fires synchronously through the .then handler.
    try {
      await runIterations(loop, byteWarn)
    } catch (err) {
      logger.error?.(`[sei/orch] runIterations rejected (loop=${loop.id}): ${err && err.message}`)
      terminateLoop(loop, `error: ${err && err.message}`)
    }
    // Post-iteration disposition: if a long-runner is in_flight, leave the
    // loop active and return — sei:action_complete will resume. Otherwise
    // tear it down now.
    if (loop._terminated) {
      await teardownLoop(loop)
    } else if (loop.inFlight) {
      // Loop is suspended waiting for sei:action_complete. handleDispatch
      // returns; the FSM is free to dispatch other events (P1/P0).
      return
    } else {
      // Natural terminal (no tools, rate-limited, cap-close, etc.) without
      // an in_flight. Tear down.
      terminateLoop(loop, 'natural-after-step')
      await teardownLoop(loop)
    }
  }

  /**
   * 260513-wkd: tear down a terminal loop. Idempotent — repeat calls are
   * no-ops (guarded by loop._tornDown). Runs the loop-history push,
   * sei:loop_terminal re-enqueue, currentLoop=null reset, and pendingAttack
   * re-dispatch. Used by the fresh-loop natural-completion path AND by the
   * action_complete continuation path when its iteration step terminates
   * the loop (case 2 stop, case 3 reseed, text-only after action_complete).
   */
  async function teardownLoop(loop) {
    if (!loop || loop._tornDown) return
    loop._tornDown = true
    const event = loop._originatingEvent ?? 'unknown'
    logger.info?.(`[sei/orch] loop terminal (id=${loop.id}, iterations=${loop.iterationCount})`)
    if (sessionState) {
      try {
        const messagesByteSize = JSON.stringify(loop._internal.messages).length
        await sessionState.onLoopTerminal({
          messagesByteSize,
          loopMessages: loop._internal.messages,
          event,
        })
      } catch (err) {
        logger.warn?.(`[sei/orch] sessionState.onLoopTerminal failed: ${err.message}`)
      }
    }
    // Drop the live external-signal listener if still attached.
    if (loop._externalSignal && loop._externalAbortListener) {
      try { loop._externalSignal.removeEventListener?.('abort', loop._externalAbortListener) } catch {}
      loop._externalAbortListener = null
    }
    try {
      reenqueue('sei:loop_terminal', { loopId: loop.id, originatingEvent: event })
    } catch (err) {
      logger.warn?.(`[sei/orch] sei:loop_terminal re-enqueue failed: ${err.message}`)
    }
    currentLoop = null
    pendingInterrupt = null
    // 260505-twx: re-fire pendingAttack so the brain's priority queue
    // re-enqueues at P0 → fresh handleDispatch arrives with currentLoop === null
    // and opens a new loop with the attack seed addendum.
    if (pendingAttack) {
      const pa = pendingAttack
      pendingAttack = null
      try { reenqueue('sei:attacked', pa.data, 0 /* Priority.P0_SAFETY */) } catch (err) {
        logger.warn?.(`[sei/orch] sei:attacked re-enqueue failed: ${err.message}`)
      }
      if (pa.preservedInterrupt) {
        try {
          reenqueue('sei:chat_received', {
            username: pa.preservedInterrupt.who,
            text: pa.preservedInterrupt.chatText,
            message: pa.preservedInterrupt.chatText,
            playerSpoke: true,
          }, 1 /* Priority.P1_CHAT */)
          logger.info?.(`[sei/orch] preserved interrupt re-enqueued: ${pa.preservedInterrupt.chatText.slice(0, 64)}`)
        } catch (err) {
          logger.warn?.(`[sei/orch] preserved interrupt re-enqueue failed: ${err.message}`)
        }
      }
    }
    try { await adapter.closeAnySessions() } catch {}
  }

  /**
   * 260513-wkd: flag the loop as terminal. Idempotent — repeat calls are
   * no-ops. The actual teardown (currentLoop=null, sessionState.onLoopTerminal,
   * sei:loop_terminal re-enqueue, pendingAttack re-fire) is done by
   * teardownLoop, called from handleDispatch after runIterations returns
   * naturally OR from handleActionComplete after its continuation iteration
   * terminates.
   */
  function terminateLoop(loop, reason) {
    if (!loop || loop._terminated) return
    loop._terminated = true
    loop.isTerminal = true
    logger.debug?.(`[sei/orch] terminateLoop loop=${loop.id} reason=${reason}`)
  }

  /**
   * 260514-gam: execute an INLINE_METADATA tool (remember / forget / end_loop)
   * synchronously and produce its tool_result block. Pure-metadata —
   * no inflight registration, no action_complete reenqueue, no haiku
   * continuation. Returns `{ result, terminate }` where `terminate=true`
   * signals the caller that the loop should flag terminal (used by `end_loop`).
   *
   * Both the for-loop and the handleActionComplete batched-queue drain share
   * this helper — single source of truth.
   */
  async function executeInlineMetadata(loop, use) {
    if (use.name === 'end_loop') {
      // 260514-ngj: end_loop replaces stop. Same inline-metadata shape —
      // fill the result slot synchronously and flag terminate=true so the
      // caller flips loop.isTerminal. The actual R3/R4 dispatch logic
      // (in_flight abort + optional reseed) lives in runIterations.
      lastActionResult = 'loop ended'
      return { result: { type: 'tool_result', tool_use_id: use.id, content: 'loop ended', is_error: false }, terminate: true }
    }
    if (use.name === 'remember') {
      try {
        const text = String(use.input?.text ?? '').trim()
        if (!text) {
          lastActionResult = 'remember: empty'
          return { result: { type: 'tool_result', tool_use_id: use.id, content: 'remember: empty', is_error: true }, terminate: false }
        }
        await memoryLog.append(text, new Date())
        lastActionResult = 'remembered'
        memoryCompactor.maybeCompact().catch(err =>
          logger.warn?.(`[sei/orch] memoryCompactor.maybeCompact failed: ${err?.message ?? err}`))
        return { result: { type: 'tool_result', tool_use_id: use.id, content: 'remembered', is_error: false }, terminate: false }
      } catch (err) {
        lastActionResult = 'remember error'
        logger.warn(`[sei/orch] remember failed: ${err.message}`)
        return { result: { type: 'tool_result', tool_use_id: use.id, content: `error: ${err?.message ?? 'remember failed'}`, is_error: true }, terminate: false }
      }
    }
    if (use.name === 'forget') {
      try {
        const text = String(use.input?.text ?? '').trim()
        if (!text) {
          lastActionResult = 'forget: empty'
          return { result: { type: 'tool_result', tool_use_id: use.id, content: 'forget: empty', is_error: true }, terminate: false }
        }
        const removed = await memoryLog.forget(text)
        const content = removed > 0 ? `forgot ${removed}` : 'forgot 0 (no match)'
        lastActionResult = content
        return { result: { type: 'tool_result', tool_use_id: use.id, content, is_error: false }, terminate: false }
      } catch (err) {
        lastActionResult = 'forget error'
        logger.warn(`[sei/orch] forget failed: ${err.message}`)
        return { result: { type: 'tool_result', tool_use_id: use.id, content: `error: ${err?.message ?? 'forget failed'}`, is_error: true }, terminate: false }
      }
    }
    throw new Error(`[sei/orch] executeInlineMetadata: not an inline metadata tool: ${use.name}`)
  }

  /**
   * 260514-gam: attach the `.then`/`.catch` settle handler to a startLongRunner
   * promise. Fires sei:action_complete at P2.1 carrying { name, input, result,
   * aborted, tool_use_id }. Single source of truth — both the for-loop FIRST
   * dispatch and the handleActionComplete queue-drain re-dispatch call this.
   *
   * `inflightEntry` is the same object stashed on loop.inFlight; we null it
   * here on settle iff it's still the live entry (guards against a stale
   * settle racing with a fresh in_flight from queue-drain).
   */
  function attachSettleHandler(loop, runner, use, inflightEntry) {
    runner.promise
      .then(r => {
        const aborted = runner.abortController.signal.aborted
        const result = formatToolResult(use.name, r)
        try { logActionResult(use.name, r) } catch {}
        // 260517-fix: capture _tickClaimed BEFORE clearing/nulling, so the
        // dispatcher knows the tool_use was already paired via tick.
        const tickClaimed = !!inflightEntry._tickClaimed
        // 260516-0yw: clear the 10s action-tick BEFORE detaching the
        // in-flight reference. `loop` is in scope here (closure over the
        // dispatch call), so clearActionTick(loop.inFlight) is the right form.
        clearActionTick(loop.inFlight)
        if (loop.inFlight === inflightEntry) loop.inFlight = null
        try {
          reenqueue('sei:action_complete', {
            name: use.name,
            input: use.input,
            result,
            aborted,
            tool_use_id: use.id,
            tickClaimed,
          })
        } catch (err) {
          logger.warn?.(`[sei/orch] sei:action_complete re-enqueue failed: ${err.message}`)
        }
      })
      .catch(err => {
        const aborted = runner.abortController.signal.aborted ||
                        (err && (err.name === 'AbortError'))
        const result = aborted ? `aborted: ${use.name}` : `error: ${err?.message ?? 'unknown'}`
        try { logActionResult(use.name, `error: ${err?.message ?? 'unknown'}`) } catch {}
        const tickClaimed = !!inflightEntry._tickClaimed
        // 260516-0yw: clear the 10s action-tick BEFORE detaching the in-flight.
        clearActionTick(loop.inFlight)
        if (loop.inFlight === inflightEntry) loop.inFlight = null
        try {
          reenqueue('sei:action_complete', {
            name: use.name,
            input: use.input,
            result,
            aborted,
            tool_use_id: use.id,
            tickClaimed,
          })
        } catch (err) {
          logger.warn?.(`[sei/orch] sei:action_complete re-enqueue failed: ${err.message}`)
        }
      })
  }

  /**
   * 260516-0yw: action-tick helper. Idempotent. Clears the inflightEntry's
   * `_tickHandle` setInterval and nulls it so double-clears are safe (a tick
   * may be cleared from the settle handler AND from a preempt site that
   * aborts the in-flight on the same event-loop turn).
   *
   * Callers MUST pass the inflightEntry whose `_tickHandle` they want cleared
   * — at the in-flight abort sites the loop variable in scope at each site is
   * `loop` / `currentLoop` / `dyingLoop`, so the call is
   * `clearActionTick(<scope>.inFlight)`. NEVER inline `clearInterval` at call
   * sites; the helper is the single source of truth.
   */
  function clearActionTick(inflightEntry) {
    if (!inflightEntry) return
    const h = inflightEntry._tickHandle
    if (h == null) return
    try { clearInterval(h) } catch {}
    inflightEntry._tickHandle = null
  }

  /**
   * 260514-gam: dispatch a single non-inline tool_use via startLongRunner,
   * register it on the loop as in_flight, stash _pendingActionUse /
   * _pendingResults / _pendingByteWarn / _pendingToolUses (the remaining
   * batched queue), and attach the settle handler. The loop suspends; the
   * next sei:action_complete drives handleActionComplete which drains the
   * queue one entry at a time.
   *
   * Single source of truth for the dispatch payload — called from both the
   * per-tool for-loop on FIRST non-inline dispatch and from
   * handleActionComplete when the queue still has a non-inline entry.
   *
   * 260516-0yw: also starts an action-tick setInterval that fires
   * `sei:action_tick` at P2.3 every 10s while this in-flight remains live.
   * The interval handle is stashed on `inflightEntry._tickHandle` and
   * cleared by `clearActionTick(...)` in the settle handler (BEFORE
   * `loop.inFlight = null`) and at every in-flight abort site.
   */
  function dispatchSuspendingTool(loop, use, results, byteWarn, remainingQueue) {
    const runner = startLongRunner(use.name, use.input, {
      ...config,
    })
    const inflightEntry = {
      name: use.name,
      input: use.input,
      promise: runner.promise,
      abortController: runner.abortController,
      handle: runner.handle,
      startedAt: runner.startedAt,
      tool_use_id: use.id,
      _tickHandle: null,  // 260516-0yw: filled below
    }
    loop.inFlight = inflightEntry
    loop._pendingActionUse = { id: use.id, name: use.name, input: use.input }
    loop._pendingResults = results
    loop._pendingByteWarn = byteWarn
    loop._pendingToolUses = remainingQueue && remainingQueue.length > 0 ? remainingQueue : null
    // 260516-0yw: schedule the 10s action-tick. The tick reenqueues
    // sei:action_tick at P2.3 with { name, startedAt, elapsedMs } so the
    // tick iteration's seed can render an elapsed-seconds figure.
    inflightEntry._tickHandle = setInterval(() => {
      const elapsedMs = Date.now() - inflightEntry.startedAt
      try {
        reenqueue('sei:action_tick', {
          name: inflightEntry.name,
          startedAt: inflightEntry.startedAt,
          elapsedMs,
        })
      } catch (err) {
        logger.warn?.(`[sei/orch] action_tick reenqueue failed: ${err.message}`)
      }
    }, _TICK_INTERVAL_MS)
    logger.debug?.(`[sei/orch] dispatch suspend tool=${use.name} batch_remaining=${remainingQueue ? remainingQueue.length : 0}`)
    attachSettleHandler(loop, runner, use, inflightEntry)
  }

  /**
   * 260513-wkd: action_complete dispatch. Appends the long-runner's
   * tool_result into the pending results array, finalizes it via
   * loop.appendToolResults, then calls Haiku one more time and dispatches
   * the response per cancel-semantics:
   *   - case 1 — text only, no tools: loop stays alive (next event drives)
   *   - case 2 — `stop`: terminate loop (in_flight already null at this point)
   *   - case 3 — new long-running tool: gate on _triggerEvent
   *     - P0/P1 trigger: terminate loop AND re-enqueue the original
   *       triggering event so a fresh loop seeds with verbal-first eventAddendum
   *     - non-P0/P1: dispatch as new in_flight in SAME loop (old already
   *       settled by the time we get here)
   *   - synchronous tools only: process inline, append results + snapshot,
   *     and continue iterating (recursive call into runIterations).
   */
  async function handleActionComplete(loop, data) {
    const pendingResults = loop._pendingResults
    const pendingUse = loop._pendingActionUse
    const byteWarn = loop._pendingByteWarn ?? loop._byteWarn ?? { flag: false }
    if (!pendingResults || !pendingUse) {
      logger.warn?.(`[sei/orch] action_complete: no pending results/use on loop ${loop.id}`)
      return
    }
    // Find the slot for this tool_use_id.
    const slotIdx = pendingResults.findIndex(r => !r)
    // We expect the pending action's slot to be the unfilled one (it was
    // returned from the for-loop with `return` before the slot was filled).
    if (slotIdx < 0) {
      logger.warn?.(`[sei/orch] action_complete: no unfilled slot in pendingResults`)
      return
    }
    // VIS-02/VIS-07: intercept the `visualize` result BEFORE the generic fill
    // so the structured { text, image } object never lands in the tool_result
    // content, in lastActionResult (a string-consumer), or in history as raw
    // base64. The helper appends the image on a FRESH user turn and arms the
    // one-shot vision-path flag for an explicit render (idle path is 15-07).
    let resultContent = data.result ?? 'done'
    let resultForLast = data.result ?? null
    if (pendingUse.name === 'visualize') {
      const { resultText } = handleVisualizeResult(loop, data.result, { idle: !!data.idle })
      resultContent = resultText
      resultForLast = resultText
    }
    pendingResults[slotIdx] = {
      type: 'tool_result',
      tool_use_id: pendingUse.id,
      content: resultContent,
      is_error: false,
    }
    lastActionResult = resultForLast
    loop._pendingResults = null
    loop._pendingActionUse = null

    // 260513-wkd: P1 mid-loop preempt path (B7a). If pendingInterrupt is set
    // when action_complete arrives with `aborted: true`, the long-runner
    // was interrupted by an player-chat event — fold the PLAYER INTERRUPT
    // user turn into the appendToolResults eventText so the same loop
    // continues with the interrupt context. Mirror repairAfterAbort's
    // event-text format.
    let extraEventText = null
    if (pendingInterrupt && data.aborted) {
      // 260608-tik: unified mid-action interrupt framing (Change 2).
      extraEventText = interruptTurnText(loop, pendingInterrupt.chatText, pendingInterrupt.who)
      pendingInterrupt = null
      logger.info?.(`[sei/orch] action_complete + PLAYER INTERRUPT folded into loop=${loop.id}`)
      // 260514-ngj: the next iteration is driven by a PLAYER INTERRUPT —
      // re-classify it as P1-triggered so R1-R4 gating fires correctly
      // (text-only continues, end_loop terminates, etc.).
      loop._currentIterationTrigger = 'sei:chat_received'
    } else {
      // 260514-ngj: natural action_complete — the iteration is driven by
      // the long-runner settling, NOT by player chat or attack. P2-triggered;
      // R1-R4 gating does not apply (text-only terminates the loop as
      // before).
      loop._currentIterationTrigger = 'sei:action_complete'
    }

    // 260514-gam D3: drain the batched queue. The model emitted N tool_uses
    // in a single assistant turn; the for-loop dispatched the FIRST non-inline
    // tool and stashed the remaining tool_uses on loop._pendingToolUses. On
    // each sei:action_complete, fill the just-completed slot (above) and then
    // walk the queue:
    //   - inline-metadata entries fill their slot inline and we continue,
    //   - the FIRST non-inline entry dispatches via dispatchSuspendingTool
    //     and returns — the loop stays suspended waiting for the next
    //     action_complete (NO callPersonality yet).
    // Only when the queue is empty (or empty after draining the rest of an
    // inline-only tail) do we fall through to appendToolResults + one haiku
    // call. This is the "one haiku per logical turn, not per tool" invariant.
    //
    // PLAYER INTERRUPT abandon path: if pendingInterrupt was just folded
    // (extraEventText set), the remaining queue entries are abandoned —
    // synthesize aborted placeholders so pairing holds, then fall through
    // to appendToolResults so the PLAYER INTERRUPT turn renders ONCE.
    const queue = loop._pendingToolUses
    loop._pendingToolUses = null
    if (queue && queue.length > 0) {
      if (extraEventText) {
        for (const entry of queue) {
          pendingResults[entry.index] = {
            type: 'tool_result',
            tool_use_id: entry.use.id,
            content: 'aborted: player interrupt',
            is_error: false,
          }
        }
        // Fall through to appendToolResults below.
      } else {
        // Drain inline entries; on first non-inline, dispatch + return.
        while (queue.length > 0) {
          const entry = queue.shift()
          if (isInlineMetadata(entry.use.name)) {
            logger.debug?.(`[sei/orch] action_complete drain inline=${entry.use.name}`)
            try {
              const r = await executeInlineMetadata(loop, entry.use)
              pendingResults[entry.index] = r.result
              if (r.terminate) loop.isTerminal = true
            } catch (err) {
              logger.warn?.(`[sei/orch] action_complete drain inline ${entry.use.name} failed: ${err.message}`)
              pendingResults[entry.index] = {
                type: 'tool_result',
                tool_use_id: entry.use.id,
                content: `error: ${err.message}`,
                is_error: true,
              }
            }
            continue
          }
          // Non-inline entry — if the loop is already terminal (case-3 reseed
          // or stop drained inline above), synthesize an aborted placeholder
          // instead of dispatching. The for-loop's case-3 branch has the
          // same guard at the FIRST dispatch site; mirror it here for the
          // queue-drain path.
          if (loop.isTerminal) {
            pendingResults[entry.index] = {
              type: 'tool_result',
              tool_use_id: entry.use.id,
              content: `aborted: ${entry.use.name} (loop terminal)`,
              is_error: false,
            }
            continue
          }
          // Dispatch the next non-inline tool. The remaining queue (still
          // includes any tail inline metadata) goes onto loop._pendingToolUses
          // for the NEXT action_complete to drain.
          logger.debug?.(`[sei/orch] action_complete drain dispatch tool=${entry.use.name} remaining=${queue.length}`)
          dispatchSuspendingTool(loop, entry.use, pendingResults, byteWarn, queue.slice())
          return  // suspend; next sei:action_complete continues the drain
        }
        // Queue drained to empty without dispatching — all remaining entries
        // were inline metadata (or aborted via loop.isTerminal). Fall through
        // to appendToolResults + one haiku call below.
      }
    }

    // Append the now-complete results array + a fresh snapshot turn. This
    // mirrors the natural end-of-iteration path in runIterations (sans the
    // silence/cant_reach nudges, which are applied per-iteration; the
    // action_complete path is a continuation of the same iteration that
    // dispatched the long-runner, so nudges fire on the NEXT iteration's
    // own cadence check).
    try {
      loop.appendToolResults(pendingResults, {
        snapshot: snapshotText(),
        ...(extraEventText ? { eventText: extraEventText } : {}),
      })
    } catch (err) {
      logger.warn?.(`[sei/orch] appendToolResults failed in action_complete: ${err.message}`)
      terminateLoop(loop, 'append-fail')
      return
    }
    maybeWarnByteCap(loop, byteWarn)
    // 260514-ngj: _isContinuation flag removed. R1-R4 gating is now driven
    // by loop._currentIterationTrigger (set above based on whether this
    // continuation is a PLAYER INTERRUPT fold or a natural action_complete),
    // so the dispatcher no longer needs a separate "is this a continuation"
    // boolean — the trigger speaks for itself.
    // Reset the outer abortController since it was aborted by the P1 path.
    // Without this the next callPersonality immediately throws AbortError.
    if (loop.abortController.signal.aborted) {
      replaceAbortController(loop)
    }

    // Drive ONE more iteration. The next callPersonality response is the
    // R1-R4 decision point.
    try {
      await runIterations(loop, byteWarn)
      // Same post-condition handling as the initial fresh-loop call site.
      if (loop._terminated) {
        // Already terminal (case 2 stop, case 3 reseed) — tear down now.
      } else if (loop.inFlight) {
        // Loop is suspended waiting for the next action_complete.
        return
      } else {
        // Natural terminal (text-only response, no tools).
        terminateLoop(loop, 'natural-after-action-complete')
      }
    } catch (err) {
      logger.error?.(`[sei/orch] action_complete continuation failed: ${err && err.message}`)
      terminateLoop(loop, `error: ${err && err.message}`)
    }
    if (loop._terminated) {
      await teardownLoop(loop)
    }
  }

  /**
   * 260517-fix: action_complete for a tick-claimed in-flight. The tool_use
   * was already paired with a synthesized "in progress" tool_result by
   * handleActionTick; the real settle is informational only.
   *
   *   - If R2 replaced the in-flight with a NEW long-runner during the tick
   *     iteration, `loop.inFlight` is now the new entry — silently drop this
   *     stale settle so we don't disturb the new action.
   *   - Otherwise the loop is sitting suspended after a tick (R1 keep-alive)
   *     with no in-flight: append the result as a user-turn event annotation
   *     so the model sees the action completed, then drive ONE iteration to
   *     let it decide what's next (text-only → terminate via the standard
   *     trigger=sei:action_complete branch; new tool_use → R2; end_loop → R3).
   */
  async function handleActionCompleteTickClaimed(loop, data) {
    // A player chat that interrupts a *tick-claimed* long-runner takes the
    // handleDispatch interrupt path (lines ~684-692): it aborts the in-flight
    // and sets pendingInterrupt, expecting the resulting action_complete to
    // fold a PLAYER INTERRUPT turn — exactly as handleActionComplete does for
    // the non-tick-claimed case. Because the 10s tick already closed the
    // tool_use, that settle arrives HERE with aborted=true. Blindly dropping
    // every aborted tick-claimed settle discards the interrupt and zombies the
    // loop (currentLoop stays set, inFlight=null, never torn down), so every
    // later chat hits "loop active" and produces silence. So: when an abort
    // coincides with a pending interrupt, FOLD it and drive an iteration
    // instead of dropping. (Timing-gated bug: a chat arriving <10s into the
    // action — before any tick — routes through handleActionComplete, which
    // already folds correctly. Only the tick-claimed window broke.)
    const interrupting = !!(data?.aborted && pendingInterrupt)
    if (data?.aborted && !interrupting) {
      // Genuine stale/terminal abort. P0 attack (terminateLoop) and R3/R4
      // (loop.isTerminal) are already filtered by handleDispatch's null /
      // terminal guards before reaching here, so an aborted settle with no
      // pending interrupt is a stale settle we can safely drop.
      logger.debug?.(`[sei/orch] action_complete tick-claimed + aborted (no interrupt): drop (loop=${loop.id}, name=${data?.name})`)
      return
    }
    if (!interrupting && loop.inFlight) {
      logger.debug?.(`[sei/orch] action_complete tick-claimed but new in_flight present — drop stale settle (loop=${loop.id}, stale=${data?.name}, current=${loop.inFlight.name})`)
      return
    }

    // VIS-02/VIS-07: a `visualize` that somehow settled via the tick-claimed
    // path (would require the render to outlive a 10s tick — its 8s handler
    // timeout makes this practically unreachable, but cover it for safety).
    // The tool_use is already closed here, so the image rides a fresh user turn
    // and lastActionResult/eventText get the SHORT text, never the raw object.
    let resultForLast = data.result ?? null
    let visualizeText = null
    if (data?.name === 'visualize') {
      const { resultText } = handleVisualizeResult(loop, data.result, { idle: !!data.idle })
      resultForLast = resultText
      visualizeText = resultText
    }
    lastActionResult = resultForLast
    let eventText
    if (interrupting) {
      // Mirror handleActionComplete's P1 fold: render the PLAYER INTERRUPT turn
      // (with the prior-task hint + R1-R4 reminder) and re-classify this
      // iteration as P1-triggered. inFlight is null here (the settle nulled it),
      // so a text-only response terminates naturally after the bot replies; a
      // text+action response re-suspends via R2.
      // 260608-tik: unified mid-action interrupt framing (Change 2).
      eventText = interruptTurnText(loop, pendingInterrupt.chatText, pendingInterrupt.who)
      pendingInterrupt = null
      loop._currentIterationTrigger = 'sei:chat_received'
      logger.info?.(`[sei/orch] action_complete (tick-claimed) + PLAYER INTERRUPT folded into loop=${loop.id}`)
    } else {
      // Use the short visualize text (never the raw { text, image } object) in
      // the event annotation when this was a visualize settle.
      const resultStr = visualizeText ?? String(data?.result ?? 'done')
      eventText = `previous action completed: ${data?.name ?? 'action'} -> ${resultStr}`
      loop._currentIterationTrigger = 'sei:action_complete'
    }
    try {
      loop.appendUserTurn([
        { type: 'text', name: 'event',    text: eventText },
        { type: 'text', name: 'snapshot', text: snapshotText() },
      ])
    } catch (err) {
      logger.warn?.(`[sei/orch] action_complete (tick-claimed) appendUserTurn failed: ${err.message}`)
      return
    }

    if (loop.abortController.signal.aborted) {
      replaceAbortController(loop)
    }

    const byteWarn = loop._byteWarn ?? { flag: false }
    try {
      await runIterations(loop, byteWarn)
      if (loop._terminated) {
        // R3/R4 — teardown below.
      } else if (loop.inFlight) {
        // R2 dispatched a new long-runner; loop healthy.
        return
      } else {
        terminateLoop(loop, 'natural-after-tick-claimed-complete')
      }
    } catch (err) {
      logger.error?.(`[sei/orch] action_complete (tick-claimed) continuation failed: ${err && err.message}`)
      terminateLoop(loop, `error: ${err && err.message}`)
    }
    if (loop._terminated) {
      await teardownLoop(loop)
    }
  }

  /**
   * 260516-0yw: sei:action_tick handler. Fires every 10s while a long-runner
   * is in_flight, driving ONE silent-default LLM iteration so the bot can
   * comment or abort. Most ticks should produce empty text and no tool call
   * (silence is the default).
   *
   * Semantics:
   *  - 260517-fix: the tick DOES consume `_pendingResults` / `_pendingActionUse`
   *    by synthesizing an interim "in progress" tool_result. Anthropic's API
   *    requires every tool_use to be immediately followed by a tool_result;
   *    leaving the in-flight's tool_use open while appending a user turn for
   *    the tick produces a 400 and tears the loop down mid-action. The actual
   *    long-runner keeps executing; when it settles, the dispatcher routes
   *    via `tickClaimed=true` to handleActionCompleteTickClaimed.
   *  - `loop._currentIterationTrigger = 'sei:action_tick'` so the extended
   *    classifier (iterationKeepsLoopAlive) keeps the loop alive when the
   *    model returns text-only.
   *  - If the model returns end_loop or a new long-runner, the R1-R4
   *    dispatch in runIterations handles teardown/reseed normally; the
   *    abort-site clearActionTick calls clean up the interval before the
   *    in-flight is aborted.
   */
  async function handleActionTick(loop, data) {
    const elapsedSec = Math.max(0, Math.floor((data?.elapsedMs ?? 0) / 1000))
    // 260608-tik: this handler now serves TWO triggers through the same
    // machinery: the silent 10s monitor (no playerMessage) AND a player chat
    // that lands while an action is running (data.playerMessage set — Change 1).
    // The action is NOT aborted in either case; the model decides to reply,
    // switch (R2), or stop (end_loop/unfollow, R3).
    const playerMessage = (typeof data?.playerMessage === 'string') ? data.playerMessage : null
    const who = data?.who ?? null
    const action = extractPriorTask(loop)
    const tickEventText = NUDGES.actionTurn({
      action,
      stopTool: stopToolForAction(action),
      playerLine: playerMessage,
      who,
      elapsedSec: playerMessage == null ? elapsedSec : null,
    })

    // Set the iteration trigger BEFORE the haiku call so the R1-R4 gate keeps
    // the loop alive on a text-only response. A carried player message is
    // chat-triggered; a silent monitor stays action_tick. Both are in
    // iterationKeepsLoopAlive, so R1 keep-alive holds either way.
    loop._currentIterationTrigger = playerMessage == null ? 'sei:action_tick' : 'sei:chat_received'

    // 260517-fix: two modes.
    //
    //   Mode 1 — FIRST tick after a fresh dispatch: the in-flight's tool_use
    //   is open in the last assistant turn. Synthesize an "in progress"
    //   tool_result for it (and deferred placeholders for any queued
    //   non-inline tool_uses) so the API pairing invariant holds, then
    //   appendToolResults. Mark `inFlight._tickClaimed = true` so the
    //   eventual real settle routes through handleActionCompleteTickClaimed.
    //
    //   Mode 2 — SUBSEQUENT tick (the tool_use was already closed by a
    //   previous tick, model responded text-only via R1 keep-alive). The
    //   last assistant turn has no open tool_use, so appendUserTurn is
    //   safe and sufficient.
    //
    // Without Mode 1 the prior assistant's tool_use sits unclosed → 400 from
    // Anthropic and the loop dies mid-action. Without Mode 2 only the first
    // tick fires effectively; subsequent ticks during a long-runner are
    // dropped because _pendingActionUse is null.
    const inFlight = loop.inFlight
    if (!inFlight) {
      // Dispatcher gate filters this, but defensive.
      logger.warn?.(`[sei/orch] action_tick: no in_flight on loop ${loop.id} — drop tick`)
      return
    }
    const byteWarn = loop._pendingByteWarn ?? loop._byteWarn ?? { flag: false }

    if (loop._pendingActionUse) {
      // Mode 1: close open tool_use(s).
      const pendingResults = loop._pendingResults
      const pendingUse = loop._pendingActionUse
      const pendingQueue = loop._pendingToolUses
      if (!pendingResults) {
        logger.warn?.(`[sei/orch] action_tick: _pendingActionUse set but no _pendingResults on loop ${loop.id} — drop tick`)
        return
      }
      const slotIdx = pendingResults.findIndex(r => !r)
      if (slotIdx < 0) {
        logger.warn?.(`[sei/orch] action_tick: no unfilled slot in _pendingResults on loop ${loop.id} — drop tick`)
        return
      }
      pendingResults[slotIdx] = {
        type: 'tool_result',
        tool_use_id: pendingUse.id,
        content: `still in progress (${elapsedSec}s elapsed)`,
        is_error: false,
      }
      if (pendingQueue && pendingQueue.length > 0) {
        for (const entry of pendingQueue) {
          if (!pendingResults[entry.index]) {
            pendingResults[entry.index] = {
              type: 'tool_result',
              tool_use_id: entry.use.id,
              content: `deferred: not started (action_tick reclaimed the turn)`,
              is_error: false,
            }
          }
        }
      }
      inFlight._tickClaimed = true
      loop._pendingResults = null
      loop._pendingActionUse = null
      loop._pendingToolUses = null
      loop._pendingByteWarn = null
      try {
        loop.appendToolResults(pendingResults, {
          snapshot: snapshotText(),
          eventText: tickEventText,
        })
      } catch (err) {
        logger.warn?.(`[sei/orch] action_tick appendToolResults failed: ${err.message}`)
        return
      }
    } else {
      // Mode 2: tool_use already closed by prior tick. Safe to just append
      // a user turn with the tick event + fresh snapshot.
      try {
        loop.appendUserTurn([
          { type: 'text', name: 'event',    text: tickEventText },
          { type: 'text', name: 'snapshot', text: snapshotText() },
        ])
      } catch (err) {
        logger.warn?.(`[sei/orch] action_tick appendUserTurn (mode 2) failed: ${err.message}`)
        return
      }
    }

    // Reset the outer abortController if a prior abort left it tripped
    // (shouldn't happen on a tick, but defensive — mirrors the
    // handleActionComplete pattern).
    if (loop.abortController.signal.aborted) {
      replaceAbortController(loop)
    }

    // Drive ONE iteration. The R1-R4 dispatcher in runIterations decides
    // whether to keep the loop alive (text-only → keep, via extended
    // classifier) or terminate (end_loop → R3, end_loop+action → R4,
    // new long-runner alone → R2).
    try {
      await runIterations(loop, byteWarn)
      if (loop._terminated) {
        // Already terminal (R3/R4) — tear down below.
      } else if (loop.inFlight) {
        // Loop is suspended: either the original long-runner is still
        // live (R1 text-only kept the loop), or a new long-runner replaced
        // it (R2). Either way, return — no teardown.
        return
      } else {
        // No in_flight AND not terminated — should be rare on a tick, but
        // treat as natural terminal.
        terminateLoop(loop, 'natural-after-action-tick')
      }
    } catch (err) {
      logger.error?.(`[sei/orch] action_tick continuation failed: ${err && err.message}`)
      terminateLoop(loop, `error: ${err && err.message}`)
    }
    if (loop._terminated) {
      await teardownLoop(loop)
    }
  }

  /**
   * Iteration loop — runs until terminal response, abort-and-resume, or cap.
   *
   * On abort (loop.abortController.signal.aborted), the catch arm synthesizes
   * aborted tool_result blocks for any orphan tool_uses (Pitfall 3) and
   * appends a `PLAYER INTERRUPT:` user turn (D-40). Then iteration continues
   * on the same Loop.messages array — history is preserved.
   *
   * On iteration cap (loop.iterationCount >= cap, SPEC A9), one final call
   * is made with tools=[] forcing a text-only response that we emit as a
   * chat line. The Loop terminates gracefully; no exception is thrown.
   */
  async function runIterations(loop, byteWarn) {
    const cap = config.memory.iteration_cap

    while (true) {
      // Cap check before the next call.
      if (loop.iterationCount >= cap) {
        await gracefulCapClose(loop)
        return
      }

      const signal = loop.abortController.signal

      let resp
      try {
        resp = await callPersonality(loop, signal)
      } catch (err) {
        if (err && (err.name === 'AbortError' || signal.aborted)) {
          // 260505-twx: if the abort was caused by an incoming attack,
          // drop the entire loop. The handleDispatch finally block will
          // re-fire the attack as a fresh dispatch, which opens a new
          // loop with the attack seed addendum. Don't append a PLAYER
          // INTERRUPT turn — there isn't one.
          if (pendingAttack) return
          if (pendingInterrupt) {
            await repairAfterAbort(loop)
            replaceAbortController(loop)
            continue
          }
          // The FSM preempt hook (handlePreempt) aborted this in-flight LLM
          // call purely to UNBLOCK the dispatch thread for a queued P0 event —
          // there's no player message to fold here. Unwind cleanly: leave the
          // loop intact (its long-runner keeps running, the abort did not touch
          // loop.inFlight) and return so the queued event drives the next step
          // through its own dispatch branch. Without this guard the call would
          // fall through to repairAfterAbort and synthesize an empty PLAYER
          // INTERRUPT turn.
          return
        }
        // Phase 13: 402 from the cloud proxy means the user's ledger is empty
        // (depleted balance, no active subscription, trial already claimed).
        // The Anthropic SDK throws APIError with .status === 402; the proxy
        // also returns {error:'payment_required'} which the SDK exposes on
        // err.error. Surface ONE in-game line, latch the orchestrator so no
        // further personality calls fire (each would 402 again and leak the
        // [haiku?] request payload to local logs), and ask the supervisor to
        // tear the bot down so the renderer shows the depleted error banner.
        const is402 = err && (err.status === 402 || err?.error?.type === 'payment_required')
        if (is402) {
          _halted = true
          const friendly = 'out of cloud credits. top up in sei or plug in your own api key.'
          try { adapter.chat(friendly) } catch {}
          if (typeof onTerminalError === 'function') {
            try {
              onTerminalError({
                error: 'CLOUD_CREDITS_DEPLETED',
                message: 'Out of cloud credits — top up or switch to your own API key.',
              })
            } catch (cbErr) {
              logger.warn?.(`[sei/orch] onTerminalError callback threw: ${cbErr && cbErr.message}`)
            }
          }
          return
        }
        throw err
      }
      if (!resp) {
        // Rate-limited; bail.
        return
      }

      // Append assistant turn raw (preserves tool_use blocks 1:1)
      loop.appendAssistant(buildAssistantContent(resp))

      // Track responses-received so the first-turn-say predicate doesn't have
      // to deal with the seed-vs-non-seed iterationCount divergence (seed
      // user turn doesn't increment, fallback first user turn does — see
      // loop.js).
      loop._responsesReceived = (loop._responsesReceived ?? 0) + 1

      const toolUses = resp.toolUses ?? []

      // Text-as-chat: the assistant's text output IS the player-visible chat
      // line. Same emission path whether the response is terminal (no tools)
      // or mid-loop (text + tool_use). Empty text is fine — the model is free
      // to make tool calls without saying anything, like Claude Code.
      const respText = (resp.text ?? '').trim()
      if (respText) {
        const line = postProcessSay(respText)
        if (line) {
          const suppressed = shouldSuppressLoopEndSay({
            triggerEvent: loop._triggerEvent,
            candidateLine: line,
            lastSelf: convoMemory.recentChat.lastSelf?.() ?? null,
          })
          if (suppressed) {
            logger.info?.(`[sei/orch] dedupeSay suppressed loop_end duplicate (loop=${loop.id}): ${line.slice(0, 80)}`)
          } else {
            logChatOut(line)
            try { adapter.chat(line) } catch {}
            convoMemory.recentChat.pushSelf(config.persona.name, line)
          }
        }
      }

      // 260514-ngj: R1-R4 interrupt-response dispatcher. Keyed off the
      // CURRENT iteration's trigger (loop._currentIterationTrigger), NOT
      // the loop's originating event. This lets a single loop alternate
      // between P0/P1-triggered iterations (R1-R4 apply) and P2-triggered
      // iterations (text-only terminates as before) as different events
      // drive each iteration.
      //
      // 260516-0yw: renamed `iterationTriggerIsP0P1` →
      // `iterationKeepsLoopAlive` and extended to include
      // `sei:action_tick`. The tick fires every 10s while in_flight is
      // live and is expected to produce text-only (silent default ~95% of
      // the time); without this extension, the very first tick the model
      // responds to with empty text would fall through to the terminate
      // branch below and shred the long-runner the tick was meant to
      // monitor. The `loop.inFlight` guard ensures we don't accidentally
      // keep a no-inflight P1 fresh-loop alive forever.
      const iterationKeepsLoopAlive = (() => {
        const e = loop._currentIterationTrigger ?? loop._triggerEvent
        return e === 'player_chat' || e === 'sei:chat_received' || e === 'sei:attacked' || e === 'sei:action_tick'
      })()

      if (toolUses.length === 0) {
        if (iterationKeepsLoopAlive && loop.inFlight) {
          // R1 — text-only on a keep-alive iteration WITH an in_flight
          // long-runner still running: keep the loop alive. The body keeps
          // doing what it was doing; the next iteration is driven by
          // whatever event arrives next (action_complete from the natural
          // in_flight completion, another preempt, an attack, or the next
          // 10s action_tick). Return WITHOUT tearing down. The spoken text
          // was already emitted above via adapter.chat.
          //
          // Without the loop.inFlight guard, a keep-alive iteration with
          // no in_flight (e.g., fresh-loop first iteration where the
          // model just says "hi") would suspend forever — nothing would
          // drive it forward. With the guard, that case falls through to
          // natural terminal as expected.
          logger.debug?.(`[sei/orch] R1 text-only keep-alive iteration — loop stays alive (loop=${loop.id}, trigger=${loop._currentIterationTrigger}, in_flight=${loop.inFlight.name})`)
          return
        }
        // P2/P3-triggered iteration (action_complete, idle, loop_end) OR
        // P0/P1-triggered with no in_flight: text-only terminates the loop
        // as before. The outer handleDispatch / handleActionComplete tail
        // will call teardownLoop when neither loop.inFlight nor
        // loop._terminated holds.
        return
      }

      // 260514-ngj: tool composition predicates for R2/R3/R4.
      const hasEndLoop = toolUses.some(u => u.name === 'end_loop')
      // newSuspendingTools = every non-inline-metadata tool. INLINE_METADATA
      // is {remember, forget, end_loop}; everything else suspends the
      // loop via startLongRunner (260514-gam universal-inflight).
      const newSuspendingTools = toolUses.filter(u => !isInlineMetadata(u.name))

      if (hasEndLoop && newSuspendingTools.length > 0) {
        // R4 — text + end_loop + new action: terminate current loop AND
        // open a fresh one seeded with the ORIGINAL trigger event + data
        // (preserves player chat text / attacker label so the new loop's
        // seed_player block sees the original request). The model's mid-loop
        // response is already appended to history; it surfaces in the next
        // loop via recent_loop_history.
        //
        // The per-tool loop below synthesizes aborted placeholders for the
        // new long-runners (loop.isTerminal=true gates the dispatch). end_loop
        // itself fills its slot inline via executeInlineMetadata with content
        // 'loop ended'.
        logger.debug?.(`[sei/orch] R4 end_loop + new action: terminate + reseed trigger=${loop._currentIterationTrigger ?? loop._triggerEvent} new=${newSuspendingTools.map(u => u.name).join(',')}`)
        if (loop.inFlight) {
          // 260516-0yw: clear the 10s action-tick BEFORE aborting on R4.
          clearActionTick(loop.inFlight)
          try { loop.inFlight.abortController.abort() } catch {}
        }
        loop.isTerminal = true
        try {
          reenqueue(loop._triggerEvent, loop._triggerData ?? null)
        } catch (err) {
          logger.warn?.(`[sei/orch] R4 reseed re-enqueue failed: ${err.message}`)
        }
      } else if (hasEndLoop) {
        // R3 — text + end_loop (no new action): terminate the loop. Abort
        // any in_flight; end_loop's slot is filled by executeInlineMetadata.
        // No reseed.
        logger.debug?.(`[sei/orch] R3 end_loop alone: terminating loop=${loop.id}`)
        if (loop.inFlight) {
          // 260516-0yw: clear the 10s action-tick BEFORE aborting on R3.
          clearActionTick(loop.inFlight)
          try { loop.inFlight.abortController.abort() } catch {}
        }
        loop.isTerminal = true
      } else if (newSuspendingTools.length > 0) {
        // R2 (P0/P1-triggered) OR same-loop continuation (P2/P3-triggered)
        // with a new long-runner: abort any in_flight, new action becomes
        // in_flight in the SAME loop. Both paths converge — the dispatch
        // happens in the per-tool for-loop below. Loop stays alive.
        if (loop.inFlight) {
          logger.debug?.(`[sei/orch] R2/suppress new action — aborting old in_flight=${loop.inFlight.name} new=${newSuspendingTools.map(u => u.name).join(',')} trigger=${loop._currentIterationTrigger ?? loop._triggerEvent}`)
          // 260516-0yw: clear the 10s action-tick BEFORE aborting on R2.
          clearActionTick(loop.inFlight)
          try { loop.inFlight.abortController.abort() } catch {}
        } else {
          logger.debug?.(`[sei/orch] first-iter/no-inflight long-runner=${newSuspendingTools.map(u => u.name).join(',')} trigger=${loop._currentIterationTrigger ?? loop._triggerEvent}`)
        }
      } else {
        // text + only inline-metadata tools (remember / forget — end_loop
        // is handled above). Same-loop continuation, no abort, no terminal.
        logger.debug?.(`[sei/orch] inline-metadata only: trigger=${loop._currentIterationTrigger ?? loop._triggerEvent}`)
      }

      // Process tool_uses. Single-layer: every movement tool fires from the
      // same combined response — no separate movement layer.
      const movementCalls = toolUses.filter(u => !PERSONALITY_NAMES.has(u.name))

      // Cap parallel dig calls at
      // 1 per turn. The first dig executes; subsequent digs synthesize an
      // abort result. Decided cap=1 over chopping-2-block-tree regression
      // (RESEARCH A2): the 5-identical-dig and 7-way-dig storms outweigh the
      // legit case; the LLM can re-issue dig next turn.
      let _digSeen = false
      const _digCapped = new Set()
      for (const u of toolUses) {
        if (u.name !== 'dig') continue
        if (_digSeen) _digCapped.add(u.id)
        else _digSeen = true
      }

      // Same-turn follow + attackEntity collapse.
      // combat.js startAttacking already auto-pursues moving mobs, so an
      // explicit follow paired with attackEntity in the SAME tool batch is
      // redundant — and historically produced "target gone" because follow
      // resolves the entity reference before attack lands the first swing.
      const _attackTargets = new Set(
        toolUses
          .filter(u => u.name === 'attackEntity')
          .map(u => u.input?.target ?? u.input?.entity)
          .filter(Boolean)
      )
      const _followNoop = new Set(
        toolUses
          .filter(u => u.name === 'follow' && _attackTargets.has(u.input?.entity ?? u.input?.target))
          .map(u => u.id)
      )

      // Collect tool_results in the SAME order as toolUses so pairing holds.
      const results = new Array(toolUses.length)

      // 260514-gam: pre-fill the dig-cap and follow-noop placeholder results
      // for the ENTIRE batch BEFORE the for-loop runs. Required so the
      // batched-queue serialization path (handleActionComplete drain) sees
      // these slots as already-filled — without this, a non-inline tool early
      // in the batch would dispatch and suspend, then the queue would still
      // contain capped digs / follow-noops that handleActionComplete cannot
      // resolve (the digCapped / followNoop sets live in this for-loop's
      // closure only).
      for (let k = 0; k < toolUses.length; k++) {
        const uk = toolUses[k]
        if (_digCapped.has(uk.id)) {
          results[k] = {
            type: 'tool_result',
            tool_use_id: uk.id,
            content: 'aborted: only one dig per turn allowed; re-issue next turn or use {block:"<name>"} for repeat digs',
            is_error: false,
          }
        } else if (_followNoop.has(uk.id)) {
          results[k] = {
            type: 'tool_result',
            tool_use_id: uk.id,
            content: 'already pursuing: combat reflex auto-pursues moving mobs; attackEntity alone is enough',
            is_error: false,
          }
        }
      }

      try {
        for (let i = 0; i < toolUses.length; i++) {
          const u = toolUses[i]
          if (signal.aborted) throw makeAbortError()
          // Skip slots already pre-filled by the guards above. The
          // for-loop's pre-fill pass synthesizes dig-cap / follow-noop
          // placeholders; nothing else to do here.
          if (results[i]) continue
          if (isInlineMetadata(u.name)) {
            // 260514-gam: remember / forget / end_loop fill their result slot
            // synchronously via the shared executeInlineMetadata helper. No
            // inflight registration, no action_complete reenqueue, no haiku
            // continuation. `stop`'s terminate=true flag is honored by the
            // case-2 dispatcher above (which already set loop.isTerminal); we
            // also set it here in case the for-loop got here without the
            // pre-dispatch case-2 branch firing (defense-in-depth).
            try {
              const r = await executeInlineMetadata(loop, u)
              results[i] = r.result
              if (r.terminate) loop.isTerminal = true
            } catch (err) {
              lastActionResult = `${u.name} error`
              logger.warn(`[sei/orch] ${u.name} failed: ${err.message}`)
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: `error: ${err.message}`, is_error: true }
            }
          } else {
            // 260514-gam D1: every world-touching tool dispatches non-blocking
            // via startLongRunner so the loop suspends and is preemptible by
            // P1 player-chat / P0 attack within one signal tick.
            //
            // 260514-ngj: if R3 or R4 flagged the loop terminal during the
            // pre-dispatch R1-R4 gate, synthesize an aborted result instead
            // of launching the runner. For R4 the model's mid-loop response
            // is already appended to history; the reseeded fresh loop will
            // pick it up via recent_loop_history.
            if (loop.isTerminal) {
              results[i] = {
                type: 'tool_result',
                tool_use_id: u.id,
                content: `aborted: ${u.name} (R4 reseed)`,
                is_error: false,
              }
              continue
            }
            // 260514-gam D3: stash the REMAINING tool_uses on
            // loop._pendingToolUses so handleActionComplete can drain them
            // one at a time without a haiku call per tool. Each queue entry
            // carries the original slot index so the results array stays
            // 1:1 with the assistant turn's tool_use blocks.
            const remainingQueue = []
            for (let k = i + 1; k < toolUses.length; k++) {
              const nu = toolUses[k]
              // Skip entries that were already pre-filled by the cap / noop
              // guards above (digCapped, followNoop).
              if (results[k]) continue
              remainingQueue.push({ index: k, use: nu })
            }
            dispatchSuspendingTool(loop, u, results, byteWarn, remainingQueue)
            // Return early — runIterations will be re-entered via the
            // action_complete branch in handleDispatch, which drains the
            // batched queue one tool at a time.
            return
          }
        }
      } catch (err) {
        if (err && (err.name === 'AbortError' || signal.aborted)) {
          // 260505-twx: incoming attack — synthesize aborted results just
          // to keep any in-flight Anthropic streaming state coherent (we
          // never send this turn), then bail. The handleDispatch finally
          // block re-fires the attack as a fresh dispatch.
          if (pendingAttack) {
            for (let i = 0; i < toolUses.length; i++) {
              if (!results[i]) {
                results[i] = {
                  type: 'tool_result',
                  tool_use_id: toolUses[i].id,
                  content: 'aborted: incoming attack',
                  is_error: false,
                }
              }
            }
            return
          }
          // Abort fired mid-tool-dispatch. Synthesize results for any
          // un-filled slots so pairing holds, then run the standard repair.
          for (let i = 0; i < toolUses.length; i++) {
            if (!results[i]) {
              results[i] = {
                type: 'tool_result',
                tool_use_id: toolUses[i].id,
                content: 'aborted: player interrupt',
                is_error: false,
              }
            }
          }
          // 260608-tik: unified mid-action interrupt framing (Change 2).
          const interruptEventText = interruptTurnText(loop, pendingInterrupt?.chatText ?? '', pendingInterrupt?.who)
          loop.appendToolResults(results, { snapshot: snapshotText(), eventText: interruptEventText })
          maybeWarnByteCap(loop, byteWarn)
          pendingInterrupt = null
          replaceAbortController(loop)
          continue
        }
        throw err
      }

      // Determine whether to continue or terminate. If only personality-only
      // tools fired (no movement) the LLM is done — terminal.
      const continueLoop = movementCalls.length > 0

      // Per-loop cant_reach dedup. If the same goTo
      // destination returned cant_reach twice in this loop and we have NOT
      // already nudged for that key, append a one-shot reminder to the next
      // user turn so the LLM follows the SYSTEM_INSTRUCTIONS Pathfinder rule
      // (ask for help via say()) instead of silently retrying.
      let cantReachNudge = null
      for (let i = 0; i < toolUses.length; i++) {
        const u = toolUses[i]
        if (u.name !== 'goTo') continue
        const r = results[i]
        const content = typeof r?.content === 'string' ? r.content : ''
        if (!content.startsWith('cant_reach')) continue
        const x = u.input?.x, y = u.input?.y, z = u.input?.z, range = u.input?.range ?? 1
        if (![x, y, z].every(n => Number.isFinite(n))) continue
        const key = `${x}|${y}|${z}|${range}`
        const prev = loop._cantReachMap.get(key) ?? 0
        const next = prev + 1
        loop._cantReachMap.set(key, next)
        if (next >= 2 && !loop._cantReachNudgedKeys.has(key)) {
          loop._cantReachNudgedKeys.add(key)
          cantReachNudge = (typeof adapter.cantReachNudge === 'function')
            ? adapter.cantReachNudge({ x, y, z, range })
            : null
          break
        }
      }

      // Silent-iteration cadence. If the
      // model has gone N iterations without say(), inject a one-shot soft
      // nudge into the next user turn asking it to narrate progress briefly.
      // Reset on every say(). Bracketed format mirrors how PLAYER INTERRUPT
      // and other system-tagged prepends are styled in convo history.
      const hadTextThisTurn = respText.length > 0
      const shouldNudge = _advanceIterationCadence({ loop, hadSay: hadTextThisTurn })
      const silenceNudgeText = shouldNudge ? NUDGES.silence : null
      // cant_reach nudge wins over silence nudge — both
      // happen at "things are not progressing" but cant_reach is the proximate
      // cause and the LLM needs the specific instruction.
      const finalNudgeText = cantReachNudge ?? silenceNudgeText

      loop.appendToolResults(results, {
        snapshot: snapshotText(),
        ...(finalNudgeText ? { eventText: finalNudgeText } : {}),
      })
      maybeWarnByteCap(loop, byteWarn)

      // 260513-wkd: case 2 (stop) and case 3 (new long-runner reseed) set
      // loop.isTerminal. The legacy `continueLoop = movementCalls.length > 0`
      // would otherwise treat a case-3-fire response (which contains a
      // long-runner tool_use) as "keep iterating" — so we honor isTerminal
      // first.
      if (loop.isTerminal) return
      if (!continueLoop) return
    }
  }

  // Bridge external signal -> loop's CURRENT abortController. Called once
  // at loop creation AND again from
  // replaceAbortController whenever the internal controller is swapped.
  // The closure captures `loop` so the listener always reads the latest
  // loop.abortController via the getter.
  function bridgeExternalAbort(loop) {
    const ext = loop._externalSignal
    if (!ext) return
    if (ext.aborted) {
      try { loop.abortController.abort() } catch {}
      return
    }
    const onExternalAbort = () => {
      try { loop.abortController.abort() } catch {}
    }
    ext.addEventListener('abort', onExternalAbort, { once: true })
    // Save the listener on the loop so we can remove it on cleanup or
    // before installing a fresh one in replaceAbortController.
    loop._externalAbortListener = onExternalAbort
  }

  // Replace loop.abortController with a fresh one. Required after an abort
  // so subsequent iterations don't immediately see signal.aborted.
  //
  // Use loop._setAbortController instead of
  // Object.defineProperty so the loop's abortController getter cleanly
  // returns the new instance. Then re-bridge the external signal so a
  // SECOND external abort that arrives later in the loop's lifetime is
  // delivered to the new controller (the previous { once: true } listener
  // was consumed by the first abort).
  function replaceAbortController(loop) {
    const fresh = new AbortController()
    loop._setAbortController(fresh)
    // Drop the previous external-signal listener (already consumed if a
    // first external abort fired; still live if not). Either way the
    // listener targeted the OLD controller, so we re-bridge below to
    // point at `fresh`.
    if (loop._externalSignal && loop._externalAbortListener) {
      try { loop._externalSignal.removeEventListener?.('abort', loop._externalAbortListener) } catch {}
      loop._externalAbortListener = null
    }
    bridgeExternalAbort(loop)
  }

  function makeAbortError() {
    const err = new Error('aborted')
    err.name = 'AbortError'
    return err
  }

  // anthropicClient returns { toolUses, text, ... } — reconstruct the
  // assistant content array (text + tool_use blocks) for Loop append.
  function buildAssistantContent(resp) {
    // When extended thinking is enabled, `thinking` (and `redacted_thinking`)
    // blocks MUST be preserved verbatim in the assistant turn or Anthropic
    // 400s on the next call (whenever the turn also produced tool_use). Pass
    // through the raw response content so signatures/positions stay intact;
    // fall back to a synthesized array for callers / mocks without `content`.
    if (Array.isArray(resp.content) && resp.content.length > 0) {
      return resp.content.map(b => {
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        return b
      })
    }
    const out = []
    if (resp.text) out.push({ type: 'text', text: resp.text })
    for (const u of resp.toolUses ?? []) {
      out.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input })
    }
    return out
  }

  async function repairAfterAbort(loop) {
    const messages = loop._internal.messages
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistantIdx = i; break }
    }
    const last = lastAssistantIdx >= 0 ? messages[lastAssistantIdx] : null
    const toolUses = last ? last.content.filter(b => b && b.type === 'tool_use') : []

    // Collect tool_use_ids that already have a paired tool_result in any
    // user turn AFTER the last assistant turn. Pre-h6i this scan was missing
    // and we'd append a SECOND tool_result for the same id — Anthropic 400s
    // and the loop dies, dumping the entire conversation history.
    const alreadyPaired = new Set()
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
      const turn = messages[i]
      if (turn.role !== 'user') continue
      for (const blk of turn.content) {
        if (blk && blk.type === 'tool_result' && blk.tool_use_id) {
          alreadyPaired.add(blk.tool_use_id)
        }
      }
    }
    const orphans = toolUses.filter(u => !alreadyPaired.has(u.id))

    const aborted = orphans.map(u => ({
      type: 'tool_result',
      tool_use_id: u.id,
      content: 'aborted: player interrupt',
      is_error: false,
    }))

    // 260608-tik: unified mid-action interrupt framing (Change 2). The action
    // kept running across the aborted Haiku call, so this reads like a tick that
    // carries the player's words.
    const eventTextWithHint = interruptTurnText(loop, pendingInterrupt?.chatText ?? '', pendingInterrupt?.who)

    if (aborted.length > 0) {
      loop.appendToolResults(aborted, { snapshot: snapshotText(), eventText: eventTextWithHint })
    } else {
      // If the abort landed right after a turn that was already a user turn
      // (e.g. an action_tick closed the in-flight tool_use and appended its
      // event before this preempt-abort), merge the interrupt into that turn
      // instead of pushing a second consecutive user turn. Drop the now-stale
      // snapshot first so only one fresh snapshot remains. This path became
      // reachable with the FSM preempt hook (a chat can now abort a mid-tick
      // LLM call); before, repairAfterAbort only ran after an assistant turn.
      const last = messages[messages.length - 1]
      if (last && last.role === 'user') {
        last.content = last.content.filter(b => !(b && b.type === 'text' && b.name === 'snapshot'))
        last.content.push({ type: 'text', name: 'event', text: eventTextWithHint })
        last.content.push({ type: 'text', name: 'snapshot', text: snapshotText() })
      } else {
        loop.appendUserTurn([
          { type: 'text', name: 'event',    text: eventTextWithHint },
          { type: 'text', name: 'snapshot', text: snapshotText() },
        ])
      }
    }
    pendingInterrupt = null
    // 260514-ngj: repairAfterAbort is the PLAYER INTERRUPT path triggered
    // when callPersonality aborts. The next iteration is P1-triggered.
    loop._currentIterationTrigger = 'sei:chat_received'
    logger.info?.(`[sei/orch] PLAYER INTERRUPT preserved (loop=${loop.id}, history=${loop._internal.messages.length})`)
  }

  async function gracefulCapClose(loop) {
    logger.warn(`[sei/orch] iteration cap hit — forcing graceful close (loop=${loop.id}, iterations=${loop.iterationCount})`)
    // Final wrap: ask the model for one line in its own voice. If the call
    // fails or returns empty, stay silent — never substitute a hardcoded
    // string into chat. The loop terminates regardless.
    loop.appendUserTurn([
      { type: 'text', name: 'event',    text: NUDGES.capClose },
      { type: 'text', name: 'snapshot', text: snapshotText() },
    ])
    try {
      const resp = await anthropic.call({
        systemBlocks: cachedSystemBlocks,
        tools: [],
        messages: loop.buildAnthropicPayload(),
        namedUserBlocks: loop._internal.messages,
        signal: loop.abortController.signal,
        timeoutMs: Math.max(config.anthropic.timeout_ms, 8000),
      })
      loop.appendAssistant(buildAssistantContent(resp))
      const modelText = (resp.text ?? '').trim()
      if (modelText) {
        const text = postProcessSay(modelText)
        logChatOut(text)
        try { adapter.chat(text) } catch {}
        convoMemory.recentChat.pushSelf(config.persona.name, text)
      } else {
        logger.warn?.(`[sei/orch] cap-close: model returned empty text — staying silent`)
      }
    } catch (err) {
      logger.warn(`[sei/orch] graceful cap close call failed: ${err.message} — staying silent`)
    }
  }

  // ─── Personality call (single seam, single Anthropic combined turn) ──
  async function callPersonality(loop, signal) {
    if (!personalityBucket.tryAcquire()) {
      logger.warn('[sei/orch] Rate limit hit — dropping personality call')
      return null
    }
    const budget = config.anthropic.thinking_budget_tokens ?? 0
    // Mark the window where an LLM call is genuinely in flight (the loop is
    // mid-iteration, parking the FSM dispatch thread). handlePreempt reads this
    // to decide whether a P0/P1 enqueue needs to abort the call to unblock the
    // queue. Cleared in finally so a suspended-on-long-runner loop (no call in
    // flight) is correctly seen as NOT needing a preempt-abort.
    loop._llmCallInFlight = true
    // VIS-07/D-09: route EXACTLY the one post-explicit-`visualize` turn through
    // the proxy's per-hour vision-cap path, and ONLY in cloud-proxy mode
    // (config.anthropic.cloudMode is set only there — BYOK/local stay uncapped,
    // D-11). Consume the one-shot flag here so every subsequent turn reverts to
    // the default /v1/messages. Reading+clearing unconditionally (not gated on
    // cloudMode) guarantees the flag can never "stick" across a backend switch.
    const visionTurn = _pendingVisionTurn
    _pendingVisionTurn = false
    const visionPath = (visionTurn && config.anthropic.cloudMode) ? VISION_MESSAGES_PATH : undefined
    try {
      return await anthropic.call({
      systemBlocks: cachedSystemBlocks,
      tools: combinedToolsFor(),
      messages: loop.buildAnthropicPayload(),
      namedUserBlocks: loop._internal.messages,
      signal,
      timeoutMs: config.anthropic.timeout_ms,
      // Small private scratchpad so the model can recap state, plan, and
      // debug failures WITHOUT polluting in-game chat. Text blocks stay
      // reserved for deliberate in-character speech to the player.
      // max_tokens must exceed budget_tokens; bump headroom accordingly.
      ...(budget > 0 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      maxTokens: 1024 + (budget > 0 ? budget : 0),
      // /vision/v1/messages for the one post-visualize cloud turn; undefined
      // (the default) keeps the SDK on /v1/messages for every other turn.
      ...(visionPath ? { path: visionPath } : {}),
      })
    } finally {
      loop._llmCallInFlight = false
    }
  }

  /**
   * Synchronous FSM preempt hook (wired via createPriorityQueue's onPreempt).
   * Called at ENQUEUE time when a player chat (P1) or attack (P0) arrives. Its
   * job is narrow: if an LLM call is genuinely in flight (parking the dispatch
   * thread), abort THAT call so the FSM unblocks immediately, instead of the
   * event waiting in the queue for a possibly-slow call to return.
   *
   * It deliberately does NOT abort loop.inFlight (the long-runner). A tick's
   * LLM call lagging mid-follow should not cancel follow — we just deliver the
   * player message to the model faster and let the model decide whether to keep
   * following. The action keeps running across the abort.
   *
   * Returns true only for the player-chat case, where we set pendingInterrupt
   * so the runIterations abort-catch folds the message via repairAfterAbort
   * (keeping the loop + its long-runner alive). Claiming tells the FSM to skip
   * enqueuing so the later dispatch doesn't re-handle it (which would cancel the
   * action). For attacks we abort to unblock but return false: the attack is
   * dispatched through its own P0 branch, which tears the loop down and re-opens
   * with the attack seed (dropping the task IS correct under attack).
   */
  function handlePreempt(event, data) {
    const loop = currentLoop
    // Only act when an LLM call is actually parking the dispatch thread. When
    // the loop is suspended on a long-runner (no call in flight), the FSM is
    // free and the normal dispatch path handles the event — and must NOT have
    // its action aborted here.
    if (!loop || !loop._llmCallInFlight) return false
    if (event === 'sei:chat_received') {
      const chatText = (data && (data.text ?? data.message)) ?? ''
      // 260610: ACCUMULATE, don't overwrite. Two player messages can land
      // while one LLM call is parked (260609 incident: "can you build up i
      // dont have dirt" then "i wanna go up there" — the first was silently
      // dropped by last-writer-wins, so the model answered a context-free
      // "up there"). repairAfterAbort consumes and clears the whole batch.
      const prevText = pendingInterrupt?.chatText
      pendingInterrupt = {
        chatText: prevText ? `${prevText}\n${String(chatText)}` : String(chatText),
        who: data?.username ?? data?.who ?? '',
      }
      try { loop.abortController.abort() } catch {}
      return true
    }
    if (event === 'sei:attacked') {
      // Unblock only; the queued attack drives the existing P0 teardown/reseed.
      try { loop.abortController.abort() } catch {}
      return false
    }
    return false
  }

  return {
    start,
    handleDispatch,
    handlePreempt,
    get currentLoop()    { return currentLoop },
    debouncer: ingressDebouncer,
    throttle: ingressThrottle,
    inflight,
    /** Record an incoming chat line in convoMemory (chat.js calls this). */
    recordIncomingChat: (who, text) => convoMemory.recentChat.pushPlayer(who, text),
    /**
     * Phase 15 (D-10/VIS-03): the active provider's vision capability. Read by
     * the brain → src/bot/index.js so it can push `vision-capability` up the
     * port on summon-ready and re-emit it on a backend switch. Fail-closed:
     * returns false if the provider/capability is unreadable.
     */
    visionCapable: () => { try { return anthropic.capabilities?.vision === true } catch { return false } },
    /**
     * Phase 13-15 (PROXY-07): push a refreshed JWT into the live Anthropic
     * SDK for cloud-proxy mode. No-op when cloudMode is not active. Called
     * by brain.setAuthToken → src/bot/index.js's parentPort message handler.
     */
    setAuthToken: (token) => { try { anthropic.setAuthToken(token) } catch {} },
    /**
     * WR-05 follow-up: live-swap the AI backend (cloud-proxy ↔ BYOK) on the
     * running provider. Optional-chained because only the Anthropic provider
     * implements setBackend; non-Anthropic providers no-op.
     */
    setBackend: (backend) => { try { anthropic.setBackend?.(backend) } catch {} },
    _internal: {
      personalityBucket,
      callPersonality,
      chains, inflight,
      get currentLoop() { return currentLoop },
      get convoMemory() { return convoMemory },
      // Harness seam: expose the cached system blocks so the verifier can
      // prove PLAYER/MEMORY content does not leak into them.
      getCachedSystemBlocks: () => cachedSystemBlocks,
      // brain.start() reads these to construct the compactor
      // with the SAME anthropic client + cachedSystemBlocks reference
      // (Pitfall 4 cache hit guarantee — cache_control marker stays valid).
      get anthropic() { return anthropic },
      get cachedSystemBlocks() { return cachedSystemBlocks },
    },
  }
}
