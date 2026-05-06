// ─── TODO_ADAPTER (Plan 03.1-02) ────────────────────────────────────────────
// The brain layer must NOT import directly from the game adapter. The three
// imports below cross the brain ↔ adapter seam and will be replaced by calls
// through the Adapter interface (see src/brain/types.js, ADAPTER_INTERFACE_VERSION):
//   - createSnapshotComposer  → adapter.createSnapshotComposer()
//   - closeContainerSession   → adapter.closeAnySessions()
//   - setInflightProvider     → adapter.setInflightProvider(fn)
// (`pauseFollow` is imported but currently unused; drop in Plan 02.)
// `composeSnapshot` named import is also unused at the call sites (only
// createSnapshotComposer is used) — Plan 02 will prune.
//
// These imports remain in place during Plan 01 (mechanical relocation only)
// and intentionally break the build at the consumer layer until Plan 02 wires
// the Adapter interface. DO NOT auto-rewrite in this plan.
// ────────────────────────────────────────────────────────────────────────────

import { createAnthropicClient } from './anthropicClient.js'
import { createGoalStore } from './goals.js'
import { createTokenBucket } from './rateLimiter.js'
import { createDebouncer, createThrottle } from './debounce.js'
import { createChainTracker } from './chains.js'
import { createLoop } from './loop.js'
import { renderPersona, capHitLine, capabilityParagraph, minecraftPrimer, stillLearningLine } from './persona.js'
import { buildAnthropicTools } from './schemaBridge.js'
import { composeSnapshot, createSnapshotComposer } from '../observers/snapshot.js'
import { closeContainerSession } from '../behaviors/container.js'
import { pauseFollow, setInflightProvider } from '../behaviors/follow.js'
import { createInflightTracker } from './inflight.js'
import { createConvoMemory } from './convoMemory.js'
import { logChatOut, logActionResult } from './log.js'

// Single combined system prompt — one Haiku call per iteration handles both
// reasoning and dispatch. Prod chat rules are folded in: `say` is the only
// player-visible channel; assistant `text` stays internal scratch.
const SYSTEM_INSTRUCTIONS = [
  'You are a Minecraft companion bot. You are a peer to the owner — pick things to do, decide what is interesting, propose plans. Reacting to chat and world events is part of the job; waiting passively for instructions is not.',
  'Communicate to the owner ONLY via the `say` tool. Your assistant `text` field is private scratch reasoning — it never reaches the player. If you have nothing to say to the owner this turn, do not produce text.',
  'Keep `say` lines short — one line, max 15 words, like player chat (no paragraphs, no narration).',
  'Use `say` frequently, not just at the start and end of work. Good moments: when you start a task, when you spot something relevant, when you hit a problem, before/after a noticeable action, when you finish. Skip it for purely internal thinking.',
  'say() cadence: REQUIRED on the FIRST turn of a loop (so the owner knows you noticed the trigger) and on the LAST turn (so they know you finished or what you concluded). OPTIONAL in middle turns — speak only if you have something genuinely new. Do NOT restate inventory counts, position, or status the snapshot already shows. Mention numbers only when they just changed (e.g. "got the last 2 logs", not "I have 8 logs").',
  'You decide WHAT to do at a high level AND directly invoke the body actions to do it.',
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
  follow: 'Continuously trail an entity at follow_range. Pass `player` (username), or `entity` / `entity_id` / `target` for a mob. Does NOT attack — pair with attackEntity if you want hits. The body trails the target on a 1s tick; an attackEntity call can land a swing as soon as the target is within reach. Default-on at spawn for the owner; the snapshot shows `follow_target` so you know who you are trailing.',
  unfollow: 'Stop trailing the current follow target. The body holds position until you issue another movement.',
  attackEntity: 'Swing at an entity. `times` (1–10, default 1) hits the target up to N times in one call with ~600ms between swings; stops early if the target dies, moves out of reach, or you are interrupted. Use a higher `times` when hunting to amortize LLM round-trips — e.g. `times: 5` for sheep/pig, `times: 8` for tougher mobs.',
  dig: 'Break a block. Prefer `{ block: "<name>" }` to dig the NEAREST EXPOSED block of that name within maxDistance (default 32, max 64) — you do NOT need to read coordinates from the snapshot first. Use `{ target: "#N" }` for a specific snapshot handle. Use `{ x, y, z }` only when you must dig a precise coordinate. The bot pathfinds into reach automatically; if "out of range" comes back, it walked as close as it could — call `dig` again or move with `goTo` first.',
}

// Tool names that are personality-only (do not require a follow-up
// iteration). Anything outside this set is a movement-registry action and
// keeps the loop running so the model can react to its result.
const PERSONALITY_NAMES = new Set(['say', 'setGoals'])
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
export async function composeSeedBlocks({
  sessionState, ownerStore, diary, config, eventText, snapshotText,
  recentLoopHistoryText = null,
  recentOwnerChatText = null,
  yourRecentMessagesText = null,
}) {
  const owner = sessionState.ownerData()
  const seedOwnerText = ownerStore.formatOwnerSeedBlock(owner, config.memory.seed_owner_budget_bytes)
  const seedDiaryText = await diary.seedSlice()
  const blocks = [
    { type: 'text', name: 'seed_owner', text: seedOwnerText },
    // Cache breakpoint: owner+diary are static within a session. Marking the
    // last static block extends the cached prefix (system + tools + seed_owner
    // + seed_diary) across every loop in the session. Dynamic blocks
    // (recent_*, event, snapshot) stay uncached and re-bill per loop.
    { type: 'text', name: 'seed_diary', text: seedDiaryText, cache_control: { type: 'ephemeral' } },
  ]
  if (recentLoopHistoryText) {
    blocks.push({ type: 'text', name: 'recent_loop_history', text: recentLoopHistoryText })
  }
  if (recentOwnerChatText) {
    blocks.push({ type: 'text', name: 'recent_owner_chat', text: recentOwnerChatText })
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
  // Conversation memory (260505-iqo): split owner/self recentChat sub-buffers
  // and a loopHistory ring of completed-loop summaries. Injected into the seed
  // user turn so the LLM has cross-loop continuity (short replies like "yes" /
  // "do it" need owner context; loopHistory keeps the bot from re-asking
  // questions or rediscovering tasks across cold-composed loops).
  const convoMemory = createConvoMemory()
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
  // 260505-twx: Pending attack to re-fire after the current loop's finally
  // clears currentLoop. Set when sei:attacked arrives mid-loop; consumed
  // by handleDispatch's finally block via bot.emit so the FSM re-enqueues
  // the dispatch at P0, which then arrives with currentLoop === null and
  // opens a fresh loop with the attack seed addendum.
  let pendingAttack = null

  // Personality-only tools: setGoals, say
  const personalityTools = [
    {
      name: 'say',
      description: ACTION_DESCRIPTIONS.say,
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
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

  // Combined tools = personality tools + movement registry tools (excluding
  // setGoals, which is already on the personality side).
  function combinedToolsFor() {
    const subRegistry = {
      list:   () => registry.list().filter(n => n !== 'setGoals'),
      schema: (n) => registry.schema(n),
    }
    const movementTools = buildAnthropicTools(subRegistry, ACTION_DESCRIPTIONS)
    const seen = new Set(personalityTools.map(t => t.name))
    const merged = [...personalityTools]
    for (const t of movementTools) {
      if (!seen.has(t.name)) { merged.push(t); seen.add(t.name) }
    }
    return merged
  }

  let cachedSystemBlocks = null
  function rebuildPersonalitySystem() {
    cachedSystemBlocks = anthropic.buildCachedSystem(
      SYSTEM_INSTRUCTIONS,
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
  }
  rebuildPersonalitySystem()

  // Last result string from any registry.execute() this orchestrator has performed.
  // Fed back into the next personality turn via composeSnapshot's lastActionResult.
  let lastActionResult = null

  // `start()` is a no-op kept for API compatibility with bot.js, which calls
  // `orchestrator.start().catch(...)` at spawn-wire time.
  async function start() {}

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

    // Single-flight branch: while a Loop is active, owner-chat preempts
    // (interrupt path) and sei:attacked aborts (re-fired by finally as a
    // fresh dispatch — 260505-twx). Anything else is dropped.
    if (currentLoop !== null) {
      if (isOwnerChat) {
        const chatText = (data && (data.text ?? data.message)) ?? JSON.stringify(data ?? {})
        pendingInterrupt = { chatText: String(chatText) }
        try { currentLoop.abortController.abort() } catch {}
        return
      }
      if (event === 'sei:attacked') {
        // P0 safety: drop the in-flight loop and re-fire the attack as a
        // fresh dispatch once the current loop's finally has cleared
        // currentLoop. We stash the dispatch here, abort the loop, and the
        // finally block emits it back into the FSM pipeline.
        pendingAttack = { event, data }
        try { currentLoop.abortController.abort() } catch {}
        return
      }
      logger.warn(`[sei/orch] dispatch ${event} arrived while loop active — dropping`)
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
    //
    // 260505-iqo: per-event seed addendum. loop_end nudges the model toward
    // a follow-up sub-goal; idle reframes from "wait for instructions" to
    // "you are a peer, pick something". Default events are unchanged.
    let eventAddendum = ''
    if (event === 'sei:loop_end') {
      eventAddendum = '\n\nYou just finished a task. Decide: continue toward a related sub-goal, propose a follow-up, or settle. Do not re-ask anything you already asked recently. Do not ask the owner what to do — pick something yourself; you can always change course later.'
    } else if (event === 'sei:idle' || event === 'idle') {
      eventAddendum = '\n\n60 seconds have passed with no activity. You are a peer, not a subordinate — pick something to do. Asking the owner what to do is a last resort. Never repeat a question you already asked.'
    } else if (event === 'sei:attacked') {
      // 260505-twx: P0 reaction. Name the attacker, demand a verbal-first
      // reaction, and set the player-vs-mob policy so the model doesn't try
      // attackEntity on a peer (auto-PvP is off — that call would be refused).
      const label = data?.attackerLabel ?? data?.attacker?.username ?? data?.attacker?.name ?? 'unknown'
      const kind = data?.attackerKind ?? (data?.attacker?.username ? 'player' : 'mob')
      const reactClause = (kind === 'player' || kind === 'players')
        ? 'this is a peer; could be a nudge, a joke, or a real threat. Use judgment — call them out, dodge with goTo, or shrug it off. Auto-PvP is off so attackEntity on players is refused; do not try.'
        : 'mobs get hit back. Call attackEntity (use `times: 5+` to amortize swings) once you have spoken. follow first if it is moving.'
      eventAddendum = `\n\n${label} (${kind}) just hit you. React out loud first — short, in-character. Then decide: ${reactClause} Resume any prior task only if it still makes sense.`
    }
    const eventText = `Event: ${event}\nData: ${formatEventData(event, data)}${eventAddendum}`
    if (sessionState && ownerStore && diary) {
      let seedBlocks
      try {
        seedBlocks = await composeSeedBlocks({
          sessionState, ownerStore, diary, config,
          eventText, snapshotText: snapshotText(),
          recentLoopHistoryText: convoMemory.loopHistory.formatBlock(),
          recentOwnerChatText: convoMemory.recentChat.formatOwnerBlock(),
          yourRecentMessagesText: convoMemory.recentChat.formatSelfBlock(),
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
      // Push completed-loop summary BEFORE clearing currentLoop so that any
      // observers (none today, but defensive) see consistent state.
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
      // 260505-iqo: emit sei:loop_terminal so the FSM can reset its idle
      // timer and (unless we were already in a sei:loop_end loop) enqueue a
      // sei:loop_end tick. The FSM listener fires synchronously; the
      // resulting enqueue runs through the normal queue → processNext →
      // sei:dispatch path AFTER currentLoop = null below, so the
      // single-flight gate accepts it cleanly.
      try {
        bot.emit('sei:loop_terminal', { loopId: loop.id, originatingEvent: event })
      } catch (err) {
        logger.warn?.(`[sei/orch] sei:loop_terminal emit failed: ${err.message}`)
      }
      currentLoop = null
      pendingInterrupt = null
      // 260505-twx: if a sei:attacked arrived mid-loop and aborted us,
      // re-emit it now (after currentLoop = null) so the FSM re-enqueues
      // at P0 → processNext → fresh dispatch arrives at handleDispatch
      // with currentLoop === null and opens a new loop with the attack
      // seed addendum. Order matters: sei:loop_terminal already fired
      // above; that enqueues sei:loop_end at P2.5 which is below the P0
      // sei:attacked we are about to fire, so the attack wins the queue
      // race.
      if (pendingAttack) {
        const pa = pendingAttack
        pendingAttack = null
        try { bot.emit('sei:attacked', pa.data) } catch (err) {
          logger.warn?.(`[sei/orch] sei:attacked re-emit failed: ${err.message}`)
        }
      }
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
        resp = await callPersonality(loop, signal)
      } catch (err) {
        if (err && (err.name === 'AbortError' || signal.aborted)) {
          // 260505-twx: if the abort was caused by an incoming attack,
          // drop the entire loop. The handleDispatch finally block will
          // re-fire the attack as a fresh dispatch, which opens a new
          // loop with the attack seed addendum. Don't append a PLAYER
          // INTERRUPT turn — there isn't one.
          if (pendingAttack) return
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
        // Terminal: text-only response. Assistant `text` is private scratch —
        // in `chat` mode (default) it stays internal. In `full` mode the same
        // text is relayed to chat with a `[think] ` prefix so the owner can
        // watch the bot's reasoning. The model is otherwise expected to call
        // `say` for player-facing speech.
        const text = (resp.text ?? '').trim()
        if (text) {
          if (config.chat_mode === 'full') {
            const line = ('[think] ' + text).slice(0, 256)
            logChatOut(line)
            try { bot.chat(line) } catch {}
            convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
          } else {
            logger.debug?.(`[sei/orch] terminal text (private, not relayed): ${text}`)
          }
        }
        return
      }

      // Mid-task narration: when the model emits text alongside tool_uses
      // (and didn't call `say`). In `chat` mode (default) this stays at
      // debug only. In `full` mode it is relayed to chat with `[think] `
      // prefix (260505-iqo say/think separation preserved by the prefix).
      const midText = (resp.text ?? '').trim()
      if (midText) {
        const calledSay = toolUses.some(u => u.name === 'say')
        if (!calledSay) {
          if (config.chat_mode === 'full') {
            const line = ('[think] ' + midText).slice(0, 256)
            logChatOut(line)
            try { bot.chat(line) } catch {}
            convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
          } else {
            logger.debug?.(`[sei/orch] mid-loop text (private, not relayed): ${midText}`)
          }
        }
      }

      // Process tool_uses. Single-layer: every movement tool fires from the
      // same combined response — no separate movement layer.
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
            convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
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
      // tools fired (no movement) the LLM is done — terminal.
      const continueLoop = movementCalls.length > 0
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
        systemBlocks: cachedSystemBlocks,
        tools: [],
        messages: loop.buildAnthropicPayload(),
        signal: loop.abortController.signal,
        timeoutMs: config.anthropic.timeout_ms,
      })
      loop.appendAssistant(buildAssistantContent(resp))
      // Cap-close is a one-shot terminal wrap-up: the prior iteration forced
      // tools=[], so the model has no `say` tool available. Treat the returned
      // text (or capHitLine fallback) as the equivalent of a `say` and surface
      // it on chat + convoMemory so the timeline stays coherent.
      const text = (resp.text ?? '').trim() || capHitLine(config.persona)
      logChatOut(text)
      try { bot.chat(text) } catch {}
      convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', text)
    } catch (err) {
      logger.warn(`[sei/orch] graceful cap close call failed: ${err.message}; falling back to capHitLine`)
      const fallback = capHitLine(config.persona)
      try { bot.chat(fallback) } catch {}
      convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', fallback)
    }
  }

  // ─── Personality call (single seam, single Anthropic combined turn) ──
  async function callPersonality(loop, signal) {
    if (!personalityBucket.tryAcquire()) {
      logger.warn('[sei/orch] Rate limit hit — dropping personality call')
      return null
    }
    return await anthropic.call({
      systemBlocks: cachedSystemBlocks,
      tools: combinedToolsFor(),
      messages: loop.buildAnthropicPayload(),
      signal,
      timeoutMs: config.anthropic.timeout_ms,
    })
  }

  return {
    start,
    handleDispatch,
    get currentLoop()    { return currentLoop },
    goals,
    debouncer: ingressDebouncer,
    throttle: ingressThrottle,
    inflight,
    /** Record an incoming chat line in convoMemory (chat.js calls this). */
    recordIncomingChat: (who, text) => convoMemory.recentChat.pushOwner(who, text),
    _internal: {
      personalityBucket,
      callPersonality,
      chains, inflight,
      get currentLoop() { return currentLoop },
      get convoMemory() { return convoMemory },
      // Plan 3-02 harness seam: expose the cached system blocks so the
      // verifier can prove OWNER/DIARY content does not leak into them.
      getCachedSystemBlocks: () => cachedSystemBlocks,
      // Plan 3-03: bot.js reads these to construct the compactor with the
      // SAME anthropic client + cachedSystemBlocks reference (Pitfall 4
      // cache hit guarantee — cache_control marker stays valid).
      get anthropic() { return anthropic },
      get cachedSystemBlocks() { return cachedSystemBlocks },
    },
  }
}
