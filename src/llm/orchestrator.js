import { createAnthropicClient } from './anthropicClient.js'
import { createOllamaClient } from './ollamaClient.js'
import { createGoalStore } from './goals.js'
import { createTokenBucket } from './rateLimiter.js'
import { createDebouncer, createThrottle } from './debounce.js'
import { createOllamaCircuit } from './circuit.js'
import { createChainTracker } from './chains.js'
import { createLoop } from './loop.js'
import { renderPersona, capHitLine, capabilityParagraph, minecraftPrimer, stillLearningLine } from './persona.js'
import { buildAnthropicTools, buildOllamaTools } from './schemaBridge.js'
import { composeSnapshot, createSnapshotComposer } from '../observers/snapshot.js'
import { closeContainerSession } from '../behaviors/container.js'
import { pauseFollow, setInflightProvider } from '../behaviors/follow.js'
import { createInflightTracker } from './inflight.js'
import { createChatRingBuffer } from './chatRingBuffer.js'
import { logChatOut, logActionResult } from '../log.js'

// Appended to system prompts when config.chat.mode === 'prod'. Pulled into a
// module constant so both SYSTEM_INSTRUCTIONS and COMBINED_SYSTEM share one
// source of truth and the cached system prefix stays byte-stable across
// instances using the same mode.
const PROD_CHAT_GUIDANCE = [
  'CHAT MODE: prod. The ONLY way to speak to the player is `say`. Your text/reasoning never reaches the player — it is just for your own thinking.',
  'Keep `say` lines short — one line, max 15 words, like player chat (no paragraphs, no narration).',
  'Use `say` frequently, not just at the start and end of work. Good moments: when you start a task, when you spot something relevant, when you hit a problem, before/after a noticeable action, when you finish. Skip it for purely internal thinking.',
].join('\n')

const DEV_CHAT_GUIDANCE = [
  'CHAT MODE: dev. Every natural-language string you emit reaches the player\'s chat — your `say` calls AND any text/reasoning alongside or instead of tool calls. Treat your text as part of the conversation.',
].join('\n')

const SYSTEM_INSTRUCTIONS = [
  'You are the personality layer of a Minecraft companion bot.',
  'You react to chat, world events, and idle ticks.',
  'You decide WHAT to do at a high level — never mention coordinates, action names, or code.',
  'When you want the body to move or interact with the world, call handOffToMovement with a short natural-language instruction (e.g. "go check what shawn is building over by the water").',
  'When you want to speak in chat, call say with the exact line.',
  'When the owner sets a goal or you decide on a self-goal, call setGoals.',
  'You may call multiple tools in one response. Keep responses brief — under 3 sentences of internal reasoning.',
  'If you have owner_goals, prioritize progressing them. Otherwise pick a self_goal or freely play.',
  'If the snapshot shows an `in_flight:` line, your body is already doing that thing — do NOT hand off another movement intent this turn. You may `say` to acknowledge or report progress, then return.',
  'When the player gives a new instruction mid-task, the runtime aborts whatever was in flight and you will see a `PLAYER INTERRUPT:` line with their message. Acknowledge them with `say` and address the new request. The aborted task is visible in your prior tool_use history — if it still makes sense after handling the interrupt, you may resume it (and briefly say so). If not, drop it.',
  'EVERY owner message — not just stop verbs — pauses the body and aborts whatever movement was in flight. After answering, decide explicitly: resume the prior task (re-issue the same intent), drop it, or switch to what the owner just asked for. Do not assume the body is still doing the prior thing.',
  'If you have tried the same approach 2+ times and it keeps failing (e.g. repeated `out of range`, `cant_reach`, `target gone`, `cannot break …`, or you are stuck in a hole with no climb path), STOP retrying. Use `say` to tell the owner what you tried, what is blocking you, and ask them for help (e.g. "I am stuck in a 1-wide pit, can you toss me dirt?"). Asking for help is correct behavior, not failure.',
  'You are running inside an iteration loop: when you emit a tool_use, the runtime executes it and you will see the result on the next turn. End the loop by emitting only `say` (or no tool calls).',
].join('\n')

const MOVEMENT_SYSTEM = [
  'You translate natural-language intent into one or more registered action calls.',
  'You ONLY emit tool_calls — no prose. Pick the action(s) that best fulfill the intent.',
  'If the intent is unclear or no action fits, emit no tool_calls.',
].join('\n')

// Single-call fallback (executor=api or Ollama tripped). Combines personality
// reasoning and movement dispatch into one Haiku turn so we pay one API
// round-trip instead of two. handOffToMovement is omitted — there is no
// second layer to hand off to.
const COMBINED_SYSTEM = [
  'You are a Minecraft companion bot. You react to chat, world events, and idle ticks.',
  'You decide WHAT to do at a high level AND directly invoke the body actions to do it — there is no separate movement layer in this mode.',
  'In a single response you may: speak in chat (`say`), set goals (`setGoals`), and/or invoke movement actions (e.g. `goTo`, `dig`, `attack`, `equip`, `place`, `consume`, `sleep`, etc.).',
  'Movement rule: in one response you may emit AT MOST ONE TYPE of movement action. Multiple calls of the SAME movement action are fine and recommended (e.g. ten `dig` calls to chop a whole tree). Mixing different movement types (e.g. `dig` and `goTo` together) is not — pick one type per turn. Multiple same-type calls run sequentially: each waits for the prior to finish.',
  'In-flight rule: if the snapshot shows an `in_flight:` line, the bot is already doing that thing. Do NOT call any movement action this turn. You may `say` to the player (e.g. "still chopping the tree, give me a sec") or emit no tool calls.',
  'Interrupt rule: when the player chats mid-task, the runtime aborts whatever was in flight and you will see a `PLAYER INTERRUPT:` line with their message. Acknowledge them with `say` and address the new request. The aborted task is visible in your prior tool_use history — if it still makes sense after handling the interrupt, you may resume it (and briefly say so). If not, drop it.',
  'EVERY owner message — not just stop verbs — pauses the body and aborts the in-flight action. After answering, decide explicitly: resume the prior task (re-issue the action), drop it, or switch to what the owner just asked for. Do not assume the body kept going.',
  'Hunting rule: to kill a moving mob, FIRST call `follow` with the target so the body trails it, THEN call `attackEntity` with `times` set high enough to amortize round-trips (e.g. `times: 5` for a sheep, `times: 8` for tougher mobs). One attackEntity call swings up to N times in a row, stopping early if the mob dies, moves out of reach, or you are interrupted. If it returns "moved out of reach", the follow is still active — just call attackEntity again. Do not chase manually with goTo for hunts; that is what follow is for. Call `unfollow` once the mob is dead.',
  'If you have tried the same approach 2+ times and it keeps failing (repeated `out of range`, `cant_reach`, `target gone`, `cannot break …`, or you are stuck somewhere you cannot climb out of), STOP retrying. Use `say` to tell the owner what you tried, what is blocking you, and ask them for help (e.g. "I am stuck in a 1-wide pit, can you toss me some dirt?"). Asking for help is correct behavior, not failure.',
  'You may always `say` to the player, even while busy — use it to acknowledge new instructions or report progress.',
  'Pick the smallest set of tool calls that fulfils the situation. Never describe coordinates or action names in prose; just call the tools.',
  'If you have owner_goals, prioritize progressing them. Otherwise pick a self_goal or freely play.',
  'Keep any internal reasoning under 3 sentences.',
  'You are running inside an iteration loop: when you emit a tool_use, the runtime executes it and you will see the result on the next turn. End the loop by emitting only `say` (or no tool calls).',
].join('\n')

const ACTION_DESCRIPTIONS = {
  goTo: 'Move the bot to the given (x, y, z) coordinates within `range` blocks.',
  setGoals: 'Add or remove a goal from owner_goals or self_goals.',
  say: 'Speak the given text in in-game chat.',
  handOffToMovement: 'Hand off a natural-language movement/interaction intent to the movement layer.',
  follow: 'Continuously trail an entity at follow_range. Pass `player` (username), or `entity` / `entity_id` / `target` for a mob. Does NOT attack — pair with attackEntity if you want hits. The body trails the target on a 1s tick; an attackEntity call can land a swing as soon as the target is within reach. Default-on at spawn for the owner; the snapshot shows `follow_target` so you know who you are trailing.',
  unfollow: 'Stop trailing the current follow target. The body holds position until you issue another movement.',
  attackEntity: 'Swing at an entity. `times` (1–10, default 1) hits the target up to N times in one call with ~600ms between swings; stops early if the target dies, moves out of reach, or you are interrupted. Use a higher `times` when hunting to amortize LLM round-trips — e.g. `times: 5` for sheep/pig, `times: 8` for tougher mobs.',
}

// 260502-h6i: 'look' removed — snapshot already rides every user turn, so the
// extra round-trip yielded no new information.
const PERSONALITY_NAMES = new Set(['say', 'setGoals', 'handOffToMovement'])
const BYTE_WARN_THRESHOLD = 100 * 1024  // Q3 sanity assert per Loop

/**
 * 260502-h6i: chat-event classification used by the dispatch single-flight
 * branch. Owner chat preempts an active Loop; non-owner chat (or non-chat
 * events) drops while a Loop is active. Exposed as a pure helper so the
 * verify harness can assert the wiring without booting an orchestrator.
 *
 * Owner sources:
 *   - any chat event with `data.ownerSpoke === true`
 *   - the legacy `owner_chat` event name (no flag required)
 */
// Render dispatch event data as a short readable string. Default JSON.stringify
// of mineflayer Entity objects produced enormous, often-circular blobs that the
// LLM ignored — and for `sei:attacked` it left the model guessing the attacker
// from the snapshot, which mis-blamed a far-off creeper when a player landed
// the hit.
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
      // Strip mineflayer Entity objects — keep only the cheap label fields.
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
                   || event === 'owner_chat' || event === 'sei:chat_received'
  const isOwnerChat = isChatEvent && (data?.ownerSpoke === true || event === 'owner_chat')
  return { isChatEvent, isOwnerChat }
}

/**
 * Compose the seed_owner + seed_diary + event + snapshot blocks for the
 * first user turn of every fresh Loop (D-45). Exposed as a top-level export
 * so the verification harness can drive it without booting the full
 * orchestrator.
 *
 * @param {Object} args
 * @param {Object} args.sessionState  — createSessionState instance
 * @param {Object} args.ownerStore    — { formatOwnerSeedBlock, ... }
 * @param {Object} args.diary         — createDiary instance
 * @param {Object} args.config
 * @param {string} args.eventText
 * @param {string} args.snapshotText
 * @returns {Promise<Array<{type:'text', name:string, text:string}>>}
 */
export async function composeSeedBlocks({ sessionState, ownerStore, diary, config, eventText, snapshotText, recentChatText = null }) {
  const owner = sessionState.ownerData()
  const seedOwnerText = ownerStore.formatOwnerSeedBlock(owner, config.memory.seed_owner_budget_bytes)
  const seedDiaryText = await diary.seedSlice()
  const blocks = [
    { type: 'text', name: 'seed_owner', text: seedOwnerText },
    // Cache breakpoint: owner+diary are static within a session. Marking the
    // last static block extends the cached prefix (system + tools + seed_owner
    // + seed_diary) across every loop in the session. Dynamic blocks (event,
    // snapshot, recent_chat) stay uncached and re-bill per loop.
    { type: 'text', name: 'seed_diary', text: seedDiaryText, cache_control: { type: 'ephemeral' } },
  ]
  if (recentChatText) {
    blocks.push({ type: 'text', name: 'recent_chat', text: `Recent chat (last few lines, oldest first):\n${recentChatText}` })
  }
  blocks.push({ type: 'text', name: 'event',    text: eventText })
  blocks.push({ type: 'text', name: 'snapshot', text: snapshotText })
  return blocks
}

/**
 * @param {object} deps
 * @param {object} deps.bot
 * @param {object} deps.config
 * @param {object} deps.registry  // result of createDefaultRegistry() — already includes setGoals
 * @param {{warn:Function,info:Function,error:Function,debug?:Function}} [deps.logger]
 * @param {object} [deps.sessionState] — Phase 3 Plan 3-02 (optional during transition)
 * @param {object} [deps.ownerStore]   — { loadOwner, saveOwner, formatOwnerSeedBlock }
 * @param {object} [deps.diary]        — createDiary instance
 */
export function createOrchestrator({ bot, config, registry, logger = console, sessionState = null, ownerStore = null, diary = null }) {
  const goals = createGoalStore()
  const anthropic = createAnthropicClient(config)
  const ollama = createOllamaClient(config)
  const circuit = createOllamaCircuit({ tripAt: 3 })
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
  // Stateful snapshot composer — wraps composeSnapshot and injects a
  // `recent_events:` line with inventory/kill/hp deltas since the prior
  // snapshot for this orchestrator instance. See observers/snapshot.js.
  const snapshotComposer = createSnapshotComposer({ bot })
  // Recent chat ring buffer — injected into seed user turn so the LLM has
  // context for short replies like "yes" / "do it" that would otherwise be
  // ambiguous given Loop history is reset per dispatch (D-39).
  const chatBuffer = createChatRingBuffer({ capacity: 10 })
  // Wire follow's lifecycle gate — follow yields while a *movement* action
  // is in flight. Personality-only entries (setGoals/say) don't pause
  // follow; see currentBlocking() in inflight.js.
  setInflightProvider(() => inflight.currentBlocking() != null)
  // Phase 3 D-59: chains is a no-op shim (kept to preserve any stragglers
  // referencing it from prior phases).
  const chains = createChainTracker({ maxHops: config.llm.max_hops })

  // ─── Phase 3 single-flight Loop state (D-39 / Pitfall 6) ─────────────
  // At most one Loop is active at any time. Idle dispatches are gated on
  // currentLoop === null (D-39 / SPEC A2). Owner-chat dispatches that arrive
  // while a Loop is active enter the interrupt path (D-40). Anything else
  // is dropped with a structured warn (defense-in-depth; the FSM should
  // already prevent it).
  let currentLoop = null
  // Pending interrupt blocks supplied via abort signal — picked up by the
  // catch arm to render the PLAYER INTERRUPT user turn.
  let pendingInterrupt = null

  // Personality-only tools: setGoals, say, handOffToMovement
  const personalityTools = [
    {
      name: 'say',
      description: ACTION_DESCRIPTIONS.say,
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'handOffToMovement',
      description: ACTION_DESCRIPTIONS.handOffToMovement,
      input_schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] },
    },
    {
      name: 'setGoals',
      description: ACTION_DESCRIPTIONS.setGoals,
      input_schema: {
        type: 'object',
        properties: {
          list: { type: 'string', enum: ['owner', 'self'] },
          op:   { type: 'string', enum: ['add', 'remove'] },
          goal: { type: 'string', minLength: 1 },
        },
        required: ['list', 'op', 'goal'],
      },
    },
  ]

  // Movement registry tools (exclude setGoals — that's personality-only)
  function movementToolsFor(provider) {
    const subRegistry = {
      list:   () => registry.list().filter(n => n !== 'setGoals'),
      schema: (n) => registry.schema(n),
    }
    return provider === 'anthropic'
      ? buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)
      : buildOllamaTools(subRegistry, ACTION_DESCRIPTIONS)
  }

  // Combined tools = personality tools (minus handOffToMovement, useless in
  // single-call mode) + movement registry tools (minus setGoals, which is
  // already on the personality side).
  function combinedToolsFor() {
    const movementTools = movementToolsFor('anthropic')
    const personalityForCombined = personalityTools.filter(t => t.name !== 'handOffToMovement')
    const seen = new Set(personalityForCombined.map(t => t.name))
    const merged = [...personalityForCombined]
    for (const t of movementTools) {
      if (!seen.has(t.name)) { merged.push(t); seen.add(t.name) }
    }
    return merged
  }

  // Chat-mode guidance: prepended to the cached system prefix so the model
  // sees the active mode upfront. Bytes-stable per mode so prompt cache hits
  // hold across loops within a session.
  const chatModeGuidance = config.chat?.mode === 'dev' ? DEV_CHAT_GUIDANCE : PROD_CHAT_GUIDANCE

  let cachedSystemBlocks = null
  let cachedCombinedSystemBlocks = null
  function rebuildPersonalitySystem() {
    cachedSystemBlocks = anthropic.buildCachedSystem(
      `${SYSTEM_INSTRUCTIONS}\n\n${chatModeGuidance}`,
      renderPersona(config.persona),
      capabilityParagraph(),
      minecraftPrimer(),
      stillLearningLine(),
      personalityTools
    )
    cachedCombinedSystemBlocks = anthropic.buildCachedSystem(
      `${COMBINED_SYSTEM}\n\n${chatModeGuidance}`,
      renderPersona(config.persona),
      capabilityParagraph(),
      minecraftPrimer(),
      stillLearningLine(),
      combinedToolsFor()
    )
    // Pitfall 4 (cache invariant): OWNER/DIARY content MUST NOT live in the
    // cached system prefix. Structural defense — fail fast at construction
    // time if a regression introduces them.
    assertNoMemoryInSystemBlocks(cachedSystemBlocks, 'cachedSystemBlocks')
    assertNoMemoryInSystemBlocks(cachedCombinedSystemBlocks, 'cachedCombinedSystemBlocks')
  }
  rebuildPersonalitySystem()

  // Last result string from any registry.execute() this orchestrator has performed.
  // Fed back into the next personality turn via composeSnapshot's lastActionResult.
  let lastActionResult = null

  // ─── Startup probe (D-13) — 3 retries × 2s ───
  async function probeOllamaWithRetry() {
    for (let i = 0; i < 3; i++) {
      if (await ollama.probe()) return true
      await new Promise(r => setTimeout(r, 2000))
    }
    return false
  }

  async function start() {
    if (config.llm.executor === 'api') {
      circuit.trip('forced api-only via config.llm.executor')
      logger.info('[sei/orch] Forced API-only mode — Haiku-as-executor for both layers; skipping Ollama probe.')
      return
    }
    const ok = await probeOllamaWithRetry()
    if (!ok) {
      circuit.trip('startup probe failed')
      logger.warn('[sei/orch] Ollama unreachable at startup — using Haiku-as-executor for this session.')
    } else {
      logger.info(`[sei/orch] Ollama reachable at ${ollama.host} — model ${ollama.model}`)
    }
  }

  // ─── Movement dispatch (LLM-03 / LLM-08) ───
  // Stays stateless per SPEC: Qwen does NOT see history. The personality Loop
  // sees the movement layer's outcome via a synthetic tool_result (D-41).
  async function callMovement(intent, signal) {
    const tools = movementToolsFor(circuit.isOpen() ? 'anthropic' : 'ollama')
    if (circuit.isOpen()) {
      const resp = await anthropic.call({
        systemBlocks: [{ type: 'text', text: MOVEMENT_SYSTEM }],
        tools,
        messages: [{ role: 'user', content: intent }],
        signal,
      })
      return { toolCalls: resp.toolUses.map(u => ({ name: u.name, args: u.input })) }
    }
    const messages = [
      { role: 'system', content: MOVEMENT_SYSTEM },
      { role: 'user',   content: intent },
    ]
    try {
      const resp = await ollama.call({ messages, tools, signal })
      circuit.recordSuccess()
      return { toolCalls: resp.toolCalls }
    } catch (err) {
      const newState = circuit.recordFailure()
      logger.warn(`[sei/orch] Ollama call failed (${err.message}); circuit state=${newState}`)
      throw err
    }
  }

  // ─── Snapshot helper ────────────────────────────────────────────────
  function snapshotText() {
    try {
      return snapshotComposer.next({ goals: goals.snapshot(), lastActionResult, inFlight: inflight.current() })
    } catch (err) {
      logger.warn(`[sei/orch] composeSnapshot failed: ${err.message}`)
      return '(snapshot unavailable)'
    }
  }

  // Walk loop history backwards to find the most recent in-flight task
  // worth resuming. Skips personality-only tools (say/setGoals). Returns a
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
        if (blk.name === 'say' || blk.name === 'setGoals') continue
        if (blk.name === 'handOffToMovement') {
          const intent = String(blk.input?.intent ?? '').slice(0, 120)
          return intent ? `intent="${intent}"` : null
        }
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

  function withPriorTaskHint(loop, eventText) {
    const priorTask = extractPriorTask(loop)
    if (!priorTask) return eventText
    return `${eventText}\nprior_task: ${priorTask}\n(If the new request is a sub-task or quick favor, resume prior_task after handling it. If it replaces the goal, drop prior_task.)`
  }

  // Run a registry action with inflight tracking so the snapshot reflects
  // what the bot is doing right now AND follow yields for its full lifecycle.
  async function runWithInflight(name, args, execOpts) {
    const handle = inflight.start({ name, args })
    try {
      return await registry.execute(name, args, bot, execOpts)
    } finally {
      inflight.end(handle)
    }
  }

  // Build a deterministic action-name-free summary string for personality
  // history (D-04 preserved through D-41). Personality only ever sees:
  //   "executed: <count> movement step(s); last_action_result: <string>"
  function summarizeMovementBatch(results) {
    const count = results.length
    const last = results.length ? results[results.length - 1] : null
    const lastStr = typeof last === 'string'
      ? last
      : (last && typeof last.ok !== 'undefined' ? `ok=${last.ok}` : '')
    return `executed: ${count} movement step${count === 1 ? '' : 's'}${lastStr ? `; last_action_result: ${lastStr}` : ''}`
  }

  // Pitfall 4 cache invariant: scan a system blocks array for OWNER/DIARY
// markdown headers. Throws if any text block contains them. Defense-in-depth
// against regressions that would invalidate the cached prefix.
function assertNoMemoryInSystemBlocks(blocks, label) {
  if (!Array.isArray(blocks)) return
  for (const blk of blocks) {
    const text = typeof blk === 'string' ? blk : (blk && blk.text) ?? ''
    if (typeof text !== 'string') continue
    if (text.includes('# Owner') || text.includes('# Diary')) {
      throw new Error(`[sei/orch] cache invariant violated: ${label} contains OWNER/DIARY markdown — these must live in the seed user turn only (Pitfall 4).`)
    }
  }
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
   *  - currentLoop !== null AND event is owner-chat → enter interrupt path.
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
    // 260502-h6i: chat events arrive from src/behaviors/chat.js as
    // `sei:chat_received` with an `ownerSpoke` flag. The legacy `owner_chat`
    // shape is preserved for backwards-compat.
    const { isOwnerChat } = classifyChatEvent(event, data)
    const isIdle     = event === 'idle' || event === 'sei:idle'

    // Defense-in-depth idle gate (D-39): the FSM should already prevent this,
    // but if an idle tick races into the orchestrator while a Loop is active,
    // drop it.
    if (isIdle && currentLoop !== null) {
      logger.debug?.(`[sei/orch] idle gated — currentLoop active (loop=${currentLoop.id}, iterations=${currentLoop.iterationCount})`)
      return
    }

    // Single-flight branch: while a Loop is active, only owner-chat is
    // allowed in (interrupt). Anything else is dropped.
    if (currentLoop !== null) {
      if (!isOwnerChat) {
        logger.warn(`[sei/orch] dispatch ${event} arrived while loop active — dropping`)
        return
      }
      // Owner chat mid-loop: signal interrupt.
      const chatText = (data && (data.text ?? data.message)) ?? JSON.stringify(data ?? {})
      pendingInterrupt = { chatText: String(chatText) }
      try { currentLoop.abortController.abort() } catch {}
      return
    }

    // ── Fresh Loop ──
    // Pitfall 6: clean up any leaked container session from a prior dispatch.
    try { await closeContainerSession() } catch {}

    const loop = createLoop({ iterationCap: config.memory.iteration_cap, logger })
    currentLoop = loop
    logger.info?.(`[sei/orch] loop start (id=${loop.id}, event=${event})`)
    const byteWarn = { flag: false }

    // Compose the first user turn (D-45 / Plan 3-02). When the memory layer
    // is wired (sessionState + ownerStore + diary), inject seed_owner +
    // seed_diary blocks and mark the turn `seed: true` so Loop preserves
    // them across iterations. Otherwise fall back to event/snapshot only.
    const eventText = `Event: ${event}\nData: ${formatEventData(event, data)}`
    if (sessionState && ownerStore && diary) {
      let seedBlocks
      try {
        seedBlocks = await composeSeedBlocks({
          sessionState, ownerStore, diary, config,
          eventText, snapshotText: snapshotText(),
          recentChatText: chatBuffer.size ? chatBuffer.format() : null,
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

    // Bridge: external signal (FSM) -> loop.abortController so handlers
    // respect both. The fresh Loop's controller is what actions hook into.
    const onExternalAbort = () => { try { loop.abortController.abort() } catch {} }
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      await runIterations(loop, byteWarn)
      logger.info?.(`[sei/orch] loop terminal (id=${loop.id}, iterations=${loop.iterationCount})`)
      // Plan 3-02: hand the terminal Loop to sessionState so it can update
      // per-loop-batch counters. No disk writes from this hook — Plan 3-03
      // will subscribe here to fire the per-loop-batch summary trigger
      // immediately AFTER sessionState.onLoopTerminal updates the counters.
      if (sessionState) {
        try {
          const messagesByteSize = JSON.stringify(loop._internal.messages).length
          // Pass the originating event so sessionState can gate the diary
          // write to idle-driven loops only — chat-driven and join-driven
          // loops accumulate counters but defer the actual compaction call
          // until the bot returns to idle.
          await sessionState.onLoopTerminal({
            messagesByteSize,
            loopMessages: loop._internal.messages,
            event,
          })
        } catch (err) {
          logger.warn?.(`[sei/orch] sessionState.onLoopTerminal failed: ${err.message}`)
        }
      }
    } catch (err) {
      logger.error?.(`[sei/orch] loop error (id=${loop.id}): ${err && err.message}`)
    } finally {
      if (signal) try { signal.removeEventListener?.('abort', onExternalAbort) } catch {}
      currentLoop = null
      pendingInterrupt = null
      try { await closeContainerSession() } catch {}
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
        if (circuit.isOpen()) {
          resp = await callPersonalityCombined(loop, signal)
        } else {
          resp = await callPersonalityTwoCall(loop, signal)
        }
      } catch (err) {
        if (err && (err.name === 'AbortError' || signal.aborted)) {
          await repairAfterAbort(loop)
          replaceAbortController(loop)
          continue
        }
        throw err
      }
      if (!resp) {
        // Rate-limited; bail.
        return
      }

      // Append assistant turn raw (preserves tool_use blocks 1:1)
      loop.appendAssistant(buildAssistantContent(resp))

      const toolUses = resp.toolUses ?? []
      if (toolUses.length === 0) {
        // Terminal: text-only response. In dev mode, emit any text content as
        // chat so the model's reasoning is visible in-game. In prod mode the
        // text is internal-only — log it but do not relay to the player.
        const text = (resp.text ?? '').trim()
        if (text) {
          logChatOut(text)
          if (chatModeGuidance === DEV_CHAT_GUIDANCE) {
            try { bot.chat(text) } catch {}
            chatBuffer.push(config.persona?.name ?? 'sei', text)
          }
        }
        return
      }

      // Mid-task narration: when the model emits text alongside tool_uses
      // (and didn't call `say` itself). In dev mode this gets relayed to chat
      // so the player sees the model's reasoning. In prod mode it's internal
      // only — the model is expected to call `say` for player-facing speech.
      const midText = (resp.text ?? '').trim()
      const calledSay = toolUses.some(u => u.name === 'say')
      if (midText && !calledSay) {
        logChatOut(midText)
        if (chatModeGuidance === DEV_CHAT_GUIDANCE) {
          try { bot.chat(midText) } catch {}
          chatBuffer.push(config.persona?.name ?? 'sei', midText)
        }
      }

      // Process tool_uses. Two-call vs combined handles dispatch differently:
      // in combined mode, movement actions execute here; in two-call mode the
      // personality emits handOffToMovement which fans out to Ollama.
      const handoffCall = toolUses.find(u => u.name === 'handOffToMovement')
      const movementCalls = toolUses.filter(u => !PERSONALITY_NAMES.has(u.name))

      // Collect tool_results in the SAME order as toolUses so pairing holds.
      const results = new Array(toolUses.length)

      try {
        for (let i = 0; i < toolUses.length; i++) {
          const u = toolUses[i]
          if (signal.aborted) throw makeAbortError()
          if (u.name === 'say') {
            const line = String(u.input?.text ?? '').slice(0, 256)
            logChatOut(line)
            try { bot.chat(line) } catch {}
            chatBuffer.push(config.persona?.name ?? 'sei', line)
            results[i] = { type: 'tool_result', tool_use_id: u.id, content: 'said', is_error: false }
          } else if (u.name === 'setGoals') {
            try {
              const r = await runWithInflight('setGoals', u.input, { ...config, _goalStore: goals })
              const s = typeof r === 'string' ? r : (r && typeof r.ok !== 'undefined' ? `setGoals:${r.ok ? 'ok' : 'fail'}` : 'setGoals:done')
              lastActionResult = s
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: s, is_error: false }
            } catch (err) {
              lastActionResult = 'setGoals error'
              logger.warn(`[sei/orch] setGoals failed: ${err.message}`)
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: `error: ${err.message}`, is_error: true }
            }
          } else if (u.name === 'handOffToMovement') {
            const intent = String(u.input?.intent ?? '')
            let summary
            try {
              const movement = await callMovement(intent, signal)
              const moveResults = []
              for (const call of movement.toolCalls) {
                if (signal.aborted) throw makeAbortError()
                try {
                  const r = await runWithInflight(call.name, call.args, {
                    ...config,
                    _goalStore: goals,
                    signal,
                  })
                  const s = typeof r === 'string' ? r : (r && typeof r.ok !== 'undefined' ? `${call.name}:${r.ok ? 'ok' : 'fail'}` : 'done')
                  lastActionResult = s
                  moveResults.push(s)
                  logActionResult(call.name, r)
                } catch (err) {
                  if (err && (err.name === 'AbortError' || signal.aborted)) throw err
                  lastActionResult = `${call.name} error`
                  moveResults.push(`error: ${err.message}`)
                  logActionResult(call.name, `error: ${err.message}`)
                }
              }
              summary = summarizeMovementBatch(moveResults)
            } catch (err) {
              if (err && (err.name === 'AbortError' || signal.aborted)) throw err
              summary = `movement layer error: ${err.message}`
            }
            results[i] = { type: 'tool_result', tool_use_id: u.id, content: summary, is_error: false }
          } else {
            // Combined-path movement action: execute via registry directly.
            try {
              const r = await runWithInflight(u.name, u.input, {
                ...config,
                _goalStore: goals,
                signal,
              })
              const s = typeof r === 'string' ? r : (r && typeof r.ok !== 'undefined' ? `${u.name}:${r.ok ? 'ok' : 'fail'}` : 'done')
              lastActionResult = s
              logActionResult(u.name, r)
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: s, is_error: false }
            } catch (err) {
              if (err && (err.name === 'AbortError' || signal.aborted)) throw err
              lastActionResult = `${u.name} error`
              logActionResult(u.name, `error: ${err.message}`)
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: `error: ${err.message}`, is_error: true }
            }
          }
        }
      } catch (err) {
        if (err && (err.name === 'AbortError' || signal.aborted)) {
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
          const interruptEventText = pendingInterrupt?.chatText
            ? `PLAYER INTERRUPT: ${pendingInterrupt.chatText}`
            : 'PLAYER INTERRUPT'
          loop.appendToolResults(results, { snapshot: snapshotText(), eventText: withPriorTaskHint(loop, interruptEventText) })
          maybeWarnByteCap(loop, byteWarn)
          pendingInterrupt = null
          replaceAbortController(loop)
          continue
        }
        throw err
      }

      // Determine whether to continue or terminate. If only personality-only
      // tools fired (no handoff/movement) the LLM is done — terminal.
      const continueLoop = !!handoffCall || movementCalls.length > 0
      loop.appendToolResults(results, { snapshot: snapshotText() })
      maybeWarnByteCap(loop, byteWarn)

      if (!continueLoop) return
    }
  }

  // Replace loop.abortController with a fresh one. Required after an abort
  // so subsequent iterations don't immediately see signal.aborted.
  function replaceAbortController(loop) {
    const fresh = new AbortController()
    Object.defineProperty(loop, 'abortController', {
      configurable: true,
      get() { return fresh },
    })
  }

  function makeAbortError() {
    const err = new Error('aborted')
    err.name = 'AbortError'
    return err
  }

  // anthropicClient returns { toolUses, text, ... } — reconstruct the
  // assistant content array (text + tool_use blocks) for Loop append.
  function buildAssistantContent(resp) {
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

    const chatText = pendingInterrupt?.chatText ?? ''
    const eventText = chatText ? `PLAYER INTERRUPT: ${chatText}` : 'PLAYER INTERRUPT'
    const eventTextWithHint = withPriorTaskHint(loop, eventText)

    if (aborted.length > 0) {
      loop.appendToolResults(aborted, { snapshot: snapshotText(), eventText: eventTextWithHint })
    } else {
      loop.appendUserTurn([
        { type: 'text', name: 'event',    text: eventTextWithHint },
        { type: 'text', name: 'snapshot', text: snapshotText() },
      ])
    }
    pendingInterrupt = null
    logger.info?.(`[sei/orch] PLAYER INTERRUPT preserved (loop=${loop.id}, history=${loop._internal.messages.length})`)
  }

  async function gracefulCapClose(loop) {
    logger.warn(`[sei/orch] iteration cap hit — forcing graceful close (loop=${loop.id}, iterations=${loop.iterationCount})`)
    loop.appendUserTurn([
      { type: 'text', name: 'event',    text: 'You have hit the iteration cap. Wrap up with one short say.' },
      { type: 'text', name: 'snapshot', text: snapshotText() },
    ])
    try {
      const resp = await anthropic.call({
        systemBlocks: cachedCombinedSystemBlocks,
        tools: [],
        messages: loop.buildAnthropicPayload(),
        signal: loop.abortController.signal,
        timeoutMs: config.anthropic.timeout_ms,
      })
      loop.appendAssistant(buildAssistantContent(resp))
      const text = (resp.text ?? '').trim() || capHitLine(config.persona)
      logChatOut(text)
      try { bot.chat(text) } catch {}
    } catch (err) {
      logger.warn(`[sei/orch] graceful cap close call failed: ${err.message}; falling back to capHitLine`)
      try { bot.chat(capHitLine(config.persona)) } catch {}
    }
  }

  // ─── Personality call helpers (D-44 single seam) ─────────────────────
  async function callPersonalityTwoCall(loop, signal) {
    if (!personalityBucket.tryAcquire()) {
      logger.warn('[sei/orch] Rate limit hit — dropping personality call')
      return null
    }
    return await anthropic.call({
      systemBlocks: cachedSystemBlocks,
      tools: personalityTools,
      messages: loop.buildAnthropicPayload(),
      signal,
      timeoutMs: config.anthropic.timeout_ms,
    })
  }

  async function callPersonalityCombined(loop, signal) {
    if (!personalityBucket.tryAcquire()) {
      logger.warn('[sei/orch] Rate limit hit — dropping combined call')
      return null
    }
    return await anthropic.call({
      systemBlocks: cachedCombinedSystemBlocks,
      tools: combinedToolsFor(),
      messages: loop.buildAnthropicPayload(),
      signal,
      timeoutMs: config.anthropic.timeout_ms,
    })
  }

  return {
    start,
    handleDispatch,
    get executorStatus() { return circuit.state },
    get currentLoop()    { return currentLoop },
    goals,
    debouncer: ingressDebouncer,
    throttle: ingressThrottle,
    inflight,
    /** Record an incoming chat line in the ring buffer (chat.js calls this). */
    recordIncomingChat: (who, text) => chatBuffer.push(who, text),
    _internal: {
      circuit, personalityBucket,
      callPersonalityTwoCall, callPersonalityCombined, callMovement,
      chains, inflight,
      get currentLoop() { return currentLoop },
      // Plan 3-02 harness seam: expose the cached system blocks so the
      // verifier can prove OWNER/DIARY content does not leak into them.
      getCachedSystemBlocks: () => cachedSystemBlocks,
      getCachedCombinedSystemBlocks: () => cachedCombinedSystemBlocks,
      // Plan 3-03: bot.js reads these to construct the compactor with the
      // SAME anthropic client + cachedSystemBlocks reference (Pitfall 4
      // cache hit guarantee — cache_control marker stays valid).
      get anthropic() { return anthropic },
      get cachedSystemBlocks() { return cachedSystemBlocks },
    },
  }
}
