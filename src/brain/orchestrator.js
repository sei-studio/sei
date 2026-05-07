// Brain ↔ adapter seam (D-5/D-6, Plan 03.1-02). The orchestrator receives
// an `adapter` at construction (see createOrchestrator below) and consumes
// every game-shaped capability through it:
//   - adapter.createSnapshotComposer()  (was: ../observers/snapshot)
//   - adapter.closeAnySessions()        (was: ../behaviors/container)
//   - adapter.setInflightProvider(fn)   (was: ../behaviors/follow)
//   - adapter.worldPrimer()             (was: ./persona.js minecraftPrimer)
//   - adapter.executeAction(...)        (registry calls, including chat tx)
// The orchestrator never imports from src/adapter/ — verify with
// `grep -r "from '../adapter" src/brain/`.

import { createAnthropicClient } from './anthropicClient.js'
import { createGoalStore } from './goals.js'
import { createTokenBucket } from './rateLimiter.js'
import { createDebouncer, createThrottle } from './debounce.js'
import { createChainTracker } from './chains.js'
import { createLoop } from './loop.js'
import { renderPersona, capHitLine, capabilityParagraph, stillLearningLine } from './persona.js'
import { buildAnthropicTools } from './schemaBridge.js'
import { createInflightTracker } from './inflight.js'
import { createConvoMemory } from './convoMemory.js'
import { logChatOut, logActionResult } from './log.js'
import { createAffectLog, readAffectFull } from './memory/affectLog.js'
import { setPreferredName, appendNote } from './memory/owner.js'

// Post-process say() text per D-7 (Plan 03.1-03), refined per D-NEW-TONE-1
// (Plan 03.1-07) to match the user's verbatim spec from memory-postfix.txt
// header item 5: "add back punctuations, just avoid \"–\", only use \",\"
// \"!\" \"?\" and dont end sentences in \".\""
//
// SURVIVES (kept): commas (,), exclamation marks (!), question marks (?),
//   apostrophes ('), semicolons (;), colons (:) — all "punctuations" the
//   user is "adding back".
// STRIPPED (replaced with space): periods (.), em-dash (—, U+2014),
//   en-dash (–, U+2013), double quote ("), backtick (`).
//
// lowercase, collapse whitespace, cap at 256 chars.
// Internal `text` (think) is exempt — it never passes through this; full-mode
// `[think] ` debug relay also bypasses this on purpose so reasoning text stays
// readable in chat for the operator.
// Implementation note: stripped chars are replaced with a SPACE (not empty)
// so word-joining cases like "move—shelter" become "move shelter", not
// "moveshelter". The trailing whitespace collapse + trim folds the extra
// spaces back down to a single one (or zero at edges).
export function postProcessSay(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[.—–"`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256)
}

// Single combined system prompt — one Haiku call per iteration handles both
// reasoning and dispatch. Prod chat rules are folded in: `say` is the only
// player-visible channel; assistant `text` stays internal scratch.
const SYSTEM_INSTRUCTIONS = [
  'You are a Minecraft companion bot — a peer to the owner, not a servant. Pick what is interesting, propose plans, react to chat and world events. Waiting passively is not the job.',
  'say() is the only owner-visible channel. Your assistant `text` is private scratch reasoning; never write chat-style sentences there. Don\'t address the owner in text — that goes nowhere. Keep reasoning under 3 sentences.',
  'say() lines are short — one line, max 15 words, lowercase, like player chat. say() output has punctuation stripped automatically (no periods, commas, em-dashes); don\'t bother adding them, they\'ll be removed. Apostrophes are kept.',
  'Frame things as "we" / "us" / "the owner" — never "you", "me", or "the user". We are partners along for the ride, not handed tasks.',
  'say() cadence: REQUIRED on the FIRST turn of any new owner-triggered loop. The first say() must ACKNOWLEDGE what we are undertaking — name the action ("alright getting sand", "going hunting", "dropping the oak"). A `text` block about the task does NOT count. If starting an action, say() goes in the SAME tool batch as the action call.',
  'say() cadence: REQUIRED on the LAST turn too — when the loop ends (task complete, blocked, or aborted), the final turn must include a say().',
  'During long tasks, narrate progress every few iterations in say() — not "i have 3 logs" (numbers stay quiet) but "this oak is stubborn" or "almost there". Silence past 4 iterations feels broken to the owner.',
  'When entities or biome features are nearby in the snapshot — animals, terrain change, structures — casually acknowledge them in say() instead of narrating generically. "passed a pod of salmon" beats "nice river".',
  'Don\'t restate inventory the snapshot already shows. Mention numbers only when they just changed ("got the last 2 logs"), not every turn.',
  'Closed action registry: only call tools from the registry. Never invent tool names, generate code, or emit raw coordinates in prose — just call the tools.',
  'Movement rule: at most ONE TYPE of movement action per response (ten dig calls is fine; dig + goTo together is not). If the snapshot shows an `in_flight:` line, the body is already doing that — do NOT call any movement this turn. You may say() while busy.',
  'Hunting rule: to kill a moving mob, call follow on the target then attackEntity with `times` set high (e.g. 5 for sheep, 8 for tougher mobs). One attackEntity swings up to N times, stopping early if the mob dies or moves out of reach. If "moved out of reach" comes back, just call attackEntity again. Don\'t chase with goTo. Call unfollow when dead.',
  'dig accepts {block:\'oak_log\'} to dig the nearest matching block — prefer this over coords for parallel batches.',
  'Pathfinder rule: if goTo returns cant_reach twice for the same destination, ask for help in say() instead of trying again.',
  'Owner messages preempt the body and abort the in-flight action. After answering, decide explicitly: resume, drop, or switch. The aborted task is in tool_use history — resume by re-issuing if it still makes sense.',
  'The loop has a 30-iteration cap; if you hit it, the orchestrator aborts. Decide task completion yourself — don\'t pad. End the loop by emitting only say() (or no tool calls).',
  'If you have owner_goals, prioritize progressing them. Otherwise pick a self_goal or freely play.',
].join('\n')

const ACTION_DESCRIPTIONS = {
  goTo: 'Move the bot to the given (x, y, z) coordinates within `range` blocks.',
  setGoals: 'Add or remove a goal from owner_goals or self_goals.',
  say: 'Speak the given text in in-game chat.',
  follow: 'Continuously trail an entity at follow_range. Pass `player` (username), or `entity` / `entity_id` / `target` for a mob. Does NOT attack — pair with attackEntity if you want hits. The body trails the target on a 1s tick; an attackEntity call can land a swing as soon as the target is within reach. Default-on at spawn for the owner; the snapshot shows `follow_target` so you know who you are trailing.',
  unfollow: 'Stop trailing the current follow target. The body holds position until you issue another movement.',
  attackEntity: 'Swing at an entity. `times` (1–10, default 1) hits the target up to N times in one call with ~600ms between swings; stops early if the target dies, moves out of reach, or you are interrupted. Use a higher `times` when hunting to amortize LLM round-trips — e.g. `times: 5` for sheep/pig, `times: 8` for tougher mobs.',
  // Plan 03.1-05 Task 2 (D-W-3, D-W-6): canonical text lives next to dig.js
  // as DIG_DESCRIPTION; this string is kept in sync so the LLM-facing copy
  // and the adapter contract docstring don't drift.
  dig: 'Break a block. Prefer `{ block: "<name>" }` to dig the NEAREST EXPOSED block of that name within maxDistance (default 32, max 64) — `maxDistance` is a SEARCH RADIUS for finding the named block, not a reach radius. Actual swing reach is fixed at 4.5m and the bot pathfinds into reach automatically. For repeated digs of the same block type, prefer `{block:"<name>"}` which auto-finds nearest each call. `#N` references (e.g. {target:"#3"}) rotate every snapshot — only valid in the SAME turn the snapshot listed them; switch to `{block:"<name>"}` if you see "stale target". Use `{ x, y, z }` only when you must dig a precise coordinate.',
}

// Tool names that are personality-only (do not require a follow-up
// iteration). Anything outside this set is a movement-registry action and
// keeps the loop running so the model can react to its result.
// Plan 03.1-04: noteToSelf is personality-only — its result is always
// "noted" / "error: …" and never warrants a follow-up iteration on its own.
const PERSONALITY_NAMES = new Set(['say', 'setGoals', 'noteToSelf'])
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
 * Plan 03.1-05 Task 1 (D-1, D-H-1): hard-enforce first-turn say() at the
 * orchestrator level. Pure predicate so the runtime path and the unit test
 * share one implementation.
 *
 * Returns true iff the orchestrator should:
 *   - synthesize aborted tool_results for every tool_use in this turn,
 *   - append a reminder user turn instructing the model to re-issue with
 *     a say() in the same batch (e.g. "alright getting sand", "going
 *     hunting", "dropping the oak"), and
 *   - skip dispatch for this iteration.
 *
 * Conditions for a reprompt:
 *   - loop was triggered by an owner-chat event (sei:chat_received with
 *     ownerSpoke=true OR the legacy owner_chat shape),
 *   - this is iteration #1 (the model's FIRST response in the loop),
 *   - the model emitted at least one tool_use,
 *   - none of those tool_uses is `say`,
 *   - and we have not already reprompted this loop (one reprompt max — D-H-1
 *     was multi-turn but a re-loop would be infinite without this guard).
 *
 * Non-owner-triggered loops (idle, loop_end, attacked, world_event) NEVER
 * trigger this enforcement. Empty tool_uses (text-only response) is handled
 * by the existing first/last-turn rule from Plan 03 — not by this predicate.
 */
export function shouldRepromptForFirstTurnSay({
  triggerEvent, ownerSpoke, iterationCount, toolUses, alreadyReprompted,
}) {
  const isOwnerTriggered = (
    (triggerEvent === 'sei:chat_received' || triggerEvent === 'owner_chat') &&
    ownerSpoke === true
  )
  if (!isOwnerTriggered) return false
  if (iterationCount !== 1) return false
  if (alreadyReprompted) return false
  if (!Array.isArray(toolUses) || toolUses.length === 0) return false
  const calledSay = toolUses.some(u => u.name === 'say')
  return !calledSay
}

/**
 * Plan 03.1-05 Task 4 (D-E-9, D-H-11): silent-iteration cadence helper.
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
  // Plan 03.1-04 (D-M-1): inject AFFECT.md in FULL after seed_diary, before
  // recent_loop_history. AFFECT.md is small by construction (one line per
  // noteToSelf emission) so we don't budget it. A best-effort read — if the
  // path is unreadable we silently skip rather than break the loop.
  if (config?.memory?.affect_md_path) {
    try {
      const affectLogText = await readAffectFull(config.memory.affect_md_path)
      if (affectLogText && affectLogText.length > 0) {
        blocks.push({ type: 'text', name: 'affect_log', text: affectLogText })
      }
    } catch {
      // intentional: missing/unreadable affect log is non-fatal
    }
  }
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
 * @param {object} deps.adapter        Adapter implementing src/brain/types.js
 *                                     contract. Replaces the old `bot` and
 *                                     `registry` parameters — every game-shaped
 *                                     capability flows through this object.
 * @param {object} deps.config
 * @param {{warn:Function,info:Function,error:Function,debug?:Function}} [deps.logger]
 * @param {object} [deps.sessionState] — Phase 3 Plan 3-02 (optional during transition)
 * @param {object} [deps.ownerStore]   — { loadOwner, saveOwner, formatOwnerSeedBlock }
 * @param {object} [deps.diary]        — createDiary instance
 * @param {(event:string, data:any, priority?:number) => void} [deps.reenqueue]
 *   Brain-side dispatcher. Used by the orchestrator to re-fire events
 *   (sei:loop_terminal at P2.5, sei:attacked at P0) back through the
 *   priority queue. Required when the brain runs in production; defaults
 *   to a no-op for test harnesses.
 */
export function createOrchestrator({ adapter, config, logger = console, sessionState = null, ownerStore = null, diary = null, reenqueue = () => {} }) {
  if (!adapter) throw new Error('createOrchestrator: adapter required')
  // Locally re-bind into the same names the body uses; the registry surface
  // is exposed through the adapter rather than a separate parameter.
  const registry = {
    list: () => adapter.listActions(),
    schema: (name) => adapter.getActionSchema(name),
    description: (name) => adapter.getActionDescription(name),
    execute: (name, args, _bot, execOpts) => adapter.executeAction(name, args, execOpts),
  }
  const goals = createGoalStore()
  const anthropic = createAnthropicClient(config)
  // Plan 03.1-04 (D-M-1): affectLog is the immediate-write side of the
  // noteToSelf tool. AFFECT.md is small by construction and loaded in full
  // into every Loop's seed user turn (composeSeedBlocks below).
  const affectLog = createAffectLog({ path: config.memory.affect_md_path })
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
  // Conversation memory (260505-iqo): split owner/self recentChat sub-buffers
  // and a loopHistory ring of completed-loop summaries. Injected into the seed
  // user turn so the LLM has cross-loop continuity (short replies like "yes" /
  // "do it" need owner context; loopHistory keeps the bot from re-asking
  // questions or rediscovering tasks across cold-composed loops).
  const convoMemory = createConvoMemory()
  // Wire follow's lifecycle gate — follow yields while a *movement* action
  // is in flight. Personality-only entries (setGoals/say) don't pause
  // follow; see currentBlocking() in inflight.js.
  adapter.setInflightProvider(() => inflight.currentBlocking() != null)
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
  // by handleDispatch's finally block via reenqueue() so the brain's
  // priority queue re-enqueues the dispatch at P0, which then arrives with
  // currentLoop === null and opens a fresh loop with the attack seed
  // addendum.
  let pendingAttack = null

  // Personality-only tools: setGoals, say, noteToSelf
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
    // Plan 03.1-04 (D-M-1, D-M-4): noteToSelf is the explicit channel for
    // Haiku to record moments worth remembering across sessions. Writes go
    // to AFFECT.md (always) and OWNER.md (kind=name|preference). The
    // description is the prompt the LLM reads — do not paraphrase.
    {
      name: 'noteToSelf',
      description: 'Privately record a moment worth remembering across sessions: praise from owner, an inside joke, a stated preference, a name they revealed, a milestone reached. Will be written to your diary. Use sparingly — only for things you would want to remember weeks later. When recording a name, set kind="name" and pass the actual name in the `name` field (not embedded in summary).',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['praise', 'preference', 'name', 'milestone', 'moment'] },
          summary: { type: 'string' },
          name: { type: 'string', description: 'When kind="name", the actual name to record (e.g. "Shawn"). Required when kind="name".' },
        },
        required: ['kind', 'summary'],
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
      adapter.worldPrimer(),
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

  // `start()` is a no-op kept for API compatibility — brain.start() calls
  // `orchestrator.start().catch(...)` after wiring the adapter.
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
      return await registry.execute(name, args, null /* adapter owns bot */, execOpts)
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

/**
 * Plan 03.1-05 Task 3 (D-H-8): dedup helper for PLAYER INTERRUPT preservation.
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
        // Plan 03.1-05 Task 3 (D-H-8): PLAYER INTERRUPT dedup. RESEARCH
        // theorized a race between the in-flight haiku call and the
        // interrupt-injection (both the chat-receive event and an internal
        // re-fire path could trigger the preservation path). We dedupe on
        // a (username:text:500ms-bucket) signature; the second arrival
        // within the same bucket is dropped. 500ms matches the FSM event
        // debounce.
        const who = data?.username ?? data?.who ?? ''
        const sig = `${who}:${chatText}:${Math.floor((data?.ts ?? Date.now()) / 500)}`
        if (shouldPreserveInterrupt(currentLoop, sig)) {
          pendingInterrupt = { chatText: String(chatText) }
          try { currentLoop.abortController.abort() } catch {}
        } else {
          logger.debug?.(`[sei/orch] PLAYER INTERRUPT dedup — skipping duplicate (sig=${sig})`)
        }
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
    try { await adapter.closeAnySessions() } catch {}

    const loop = createLoop({ iterationCap: config.memory.iteration_cap, logger })
    currentLoop = loop
    // Plan 03.1-05 Task 1: capture trigger context for first-turn-say
    // enforcement in runIterations. classifyChatEvent already handles the
    // owner_chat / sei:chat_received aliases.
    loop._triggerEvent = event
    loop._ownerSpoke = !!data?.ownerSpoke || event === 'owner_chat'
    loop._firstTurnReprompted = false
    loop._dropItemReprompted = false
    // Plan 03.1-05 Task 4: silent-iteration cadence counter for the
    // progress-narration soft nudge.
    loop.iterationsSinceLastSay = 0
    loop._progressNudgeFired = false
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
      // Plan 03.1-05 Task 3 (D-W-1): loop_end is observational. The bot was
      // auto-starting world-mutating actions on loop_end (D-W-1: opened a chest
      // and started moving items unprompted) which felt like "agent runaway"
      // to the owner. Settle, acknowledge, yield — explicitly forbid auto-
      // starting a new task without an explicit owner_goal or self_goal.
      eventAddendum = '\n\nYou finished a task. Settle, no need to start a new task without an explicit owner_goal or self_goal that demands it. Acknowledge briefly with say() and yield. Do NOT auto-start any world-mutating action (dig, place, drop, openContainer, attack) on loop_end.'
    } else if (event === 'sei:idle' || event === 'idle') {
      // Plan 03.1-05 Task 3 (D-E-8): idle is observational, not a task prompt.
      // Earlier "you are a peer, pick something to do" wording read as a
      // command to start mutating the world; the bot would dig random sand or
      // wander off. Reframe as "observe, comment if natural, silence is fine".
      eventAddendum = '\n\nYou have been quiet for a minute. Observe something around you, or comment if natural — silence is fine, you do not need to call any tool. Do NOT auto-start a world-mutating action (dig, place, drop, openContainer, attack) without an explicit owner_goal that demands it.'
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
      // 260505-iqo: re-enqueue sei:loop_terminal so the brain's priority
      // queue can reset its idle timer and (unless we were already in a
      // sei:loop_end loop) enqueue a sei:loop_end tick at P2.5. The
      // re-enqueue runs through the normal queue → processNext → handler
      // path AFTER currentLoop = null below, so the single-flight gate
      // accepts it cleanly. brain.start() handles the loop_terminal →
      // loop_end translation outside the orchestrator.
      try {
        reenqueue('sei:loop_terminal', { loopId: loop.id, originatingEvent: event })
      } catch (err) {
        logger.warn?.(`[sei/orch] sei:loop_terminal re-enqueue failed: ${err.message}`)
      }
      currentLoop = null
      pendingInterrupt = null
      // 260505-twx: if a sei:attacked arrived mid-loop and aborted us,
      // re-fire it now (after currentLoop = null) so the brain's priority
      // queue re-enqueues at P0 → processNext → fresh handleDispatch
      // arrives with currentLoop === null and opens a new loop with the
      // attack seed addendum. Order matters: sei:loop_terminal already
      // fired above; that enqueues sei:loop_end at P2.5 which is below the
      // P0 sei:attacked we are about to fire, so the attack wins the
      // queue race.
      if (pendingAttack) {
        const pa = pendingAttack
        pendingAttack = null
        try { reenqueue('sei:attacked', pa.data, 0 /* Priority.P0_SAFETY */) } catch (err) {
          logger.warn?.(`[sei/orch] sei:attacked re-enqueue failed: ${err.message}`)
        }
      }
      try { await adapter.closeAnySessions() } catch {}
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

      // Plan 03.1-05 Task 1 (D-1, D-H-1): track responses-received so the
      // first-turn-say predicate doesn't have to deal with the seed-vs-non-seed
      // iterationCount divergence (seed user turn doesn't increment, fallback
      // first user turn does — see loop.js D-44).
      loop._responsesReceived = (loop._responsesReceived ?? 0) + 1

      const toolUses = resp.toolUses ?? []

      // Plan 03.1-05 Task 1 (D-1, D-H-1): hard-enforce first-turn say().
      // If the first response in an owner-chat-triggered loop emitted tool_uses
      // without say(), synthesize aborted tool_results, append a reminder
      // user turn (e.g. "alright getting sand", "going hunting"), and skip
      // dispatch. One reprompt max per loop (loop._firstTurnReprompted).
      if (shouldRepromptForFirstTurnSay({
        triggerEvent: loop._triggerEvent,
        ownerSpoke: loop._ownerSpoke,
        iterationCount: loop._responsesReceived,
        toolUses,
        alreadyReprompted: loop._firstTurnReprompted,
      })) {
        loop._firstTurnReprompted = true
        const aborted = toolUses.map(u => ({
          type: 'tool_result',
          tool_use_id: u.id,
          content: 'aborted: first-turn say() required before action',
          is_error: false,
        }))
        loop.appendToolResults(aborted, {
          snapshot: snapshotText(),
          eventText: 'You started work without calling say() to acknowledge the owner. Re-issue your tool calls, but include a say() in the SAME batch that names what you are doing (e.g., "alright getting sand", "going hunting", "dropping the oak").',
        })
        maybeWarnByteCap(loop, byteWarn)
        continue
      }

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
            try { adapter.chat(line) } catch {}
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
            try { adapter.chat(line) } catch {}
            convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
          } else {
            logger.debug?.(`[sei/orch] mid-loop text (private, not relayed): ${midText}`)
          }
        }
      }

      // Process tool_uses. Single-layer: every movement tool fires from the
      // same combined response — no separate movement layer.
      const movementCalls = toolUses.filter(u => !PERSONALITY_NAMES.has(u.name))

      // Plan 03.1-05 Task 2 (D-W-10): dropItem of ≥4 items requires a paired
      // say() in the SAME turn. If missing, synthesize aborts for every
      // tool_use and append a reminder. One reprompt max via
      // _dropItemReprompted.
      const bigDrop = toolUses.find(u => u.name === 'dropItem' && Number(u.input?.count ?? 1) >= 4)
      if (bigDrop && !toolUses.some(t => t.name === 'say') && !loop._dropItemReprompted) {
        loop._dropItemReprompted = true
        const aborted = toolUses.map(u => ({
          type: 'tool_result',
          tool_use_id: u.id,
          content: 'aborted: dropping 4+ items requires a say() in the same turn explaining why',
          is_error: false,
        }))
        const cnt = Number(bigDrop.input?.count ?? 1)
        const itm = bigDrop.input?.item ?? 'items'
        loop.appendToolResults(aborted, {
          snapshot: snapshotText(),
          eventText: `You tried to drop ${cnt} ${itm} without saying anything to the owner. Re-issue with a say() in the same batch (e.g., "dropping the sand, we need wood now").`,
        })
        maybeWarnByteCap(loop, byteWarn)
        continue
      }

      // Plan 03.1-05 Task 2 (D-W-2, D-W-3, D-H-5): cap parallel dig calls at
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

      // Plan 03.1-05 Task 2 (D-H-6): same-turn follow + attackEntity collapse.
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

      try {
        for (let i = 0; i < toolUses.length; i++) {
          const u = toolUses[i]
          if (signal.aborted) throw makeAbortError()
          if (_digCapped.has(u.id)) {
            // Parallel-dig cap (D-W-2 / D-W-3 / D-H-5): only one dig per turn.
            results[i] = {
              type: 'tool_result',
              tool_use_id: u.id,
              content: 'aborted: only one dig per turn allowed; re-issue next turn or use {block:"<name>"} for repeat digs',
              is_error: false,
            }
            continue
          }
          if (_followNoop.has(u.id)) {
            // follow + attackEntity in same turn (D-H-6): combat reflex
            // auto-pursues, so the explicit follow becomes a no-op rather
            // than racing the attack and returning "target gone".
            results[i] = {
              type: 'tool_result',
              tool_use_id: u.id,
              content: 'already pursuing: combat reflex auto-pursues moving mobs; attackEntity alone is enough',
              is_error: false,
            }
            continue
          }
          if (u.name === 'say') {
            // D-7 (Plan 03.1-03): strip punctuation/lowercase/cap before
            // transmit AND before pushing to convoMemory.recentChat.pushSelf
            // so the bot's "memory" of what it said matches what the owner saw.
            const line = postProcessSay(u.input?.text)
            // Plan 03.1-05 Task 2 (D-W-4): empty-text turns are excluded from
            // the convoMemory self-buffer entirely so the bot never sees itself
            // restating inventory / a blank message in your_recent_messages.
            if (line && line.trim().length > 0) {
              logChatOut(line)
              try { adapter.chat(line) } catch {}
              convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
            } else {
              logger.debug?.(`[sei/orch] empty say() output skipped from chat + self-buffer (D-W-4)`)
            }
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
          } else if (u.name === 'noteToSelf') {
            // Plan 03.1-04 (D-M-1, D-M-4). Dispatch:
            //   AFFECT.md  ← always (any kind)
            //   OWNER.md preferred_name ← when kind='name' and `name` field
            //                              is a valid Unicode-letter token
            //   OWNER.md notes section  ← when kind='preference'
            // Validation: the explicit `name` field is the source of truth
            // for kind='name' (D-M-4 Warning #4 fix — no extraction from
            // summary). If the field is missing/invalid we still log to
            // AFFECT.md (the durable record) but skip the OWNER.md write.
            try {
              const kind = u.input?.kind
              const summary = u.input?.summary
              await affectLog.append({ kind, summary, when: new Date() })
              if (kind === 'name') {
                const raw = String(u.input?.name ?? '').trim()
                if (raw.length >= 2 && /^[\p{L}][\p{L}\p{M}\p{N}'\-\s]*$/u.test(raw)) {
                  await setPreferredName(config.memory.owner_md_path, raw)
                } else {
                  logger.debug?.(`[sei/orch] noteToSelf kind=name skipped OWNER.md write — name field missing or invalid`)
                }
              } else if (kind === 'preference') {
                await appendNote(config.memory.owner_md_path, summary)
              }
              loop._affectMarked = true
              lastActionResult = 'noted'
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: 'noted', is_error: false }
            } catch (err) {
              lastActionResult = 'noteToSelf error'
              logger.warn(`[sei/orch] noteToSelf failed: ${err.message}`)
              results[i] = { type: 'tool_result', tool_use_id: u.id, content: `error: ${err?.message ?? 'note failed'}`, is_error: true }
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

      // Plan 03.1-05 Task 4 (D-E-9, D-H-11): silent-iteration cadence. If the
      // model has gone N iterations without say(), inject a one-shot soft
      // nudge into the next user turn asking it to narrate progress briefly.
      // Reset on every say(). Bracketed format mirrors how PLAYER INTERRUPT
      // and other system-tagged prepends are styled in convo history.
      const hadSayThisTurn = toolUses.some(u => u.name === 'say')
      const shouldNudge = _advanceIterationCadence({ loop, hadSay: hadSayThisTurn })
      const nudgeText = shouldNudge
        ? '[silence past 4 iterations — narrate progress briefly using say(), still optional if nothing changed. avoid restating numbers (we already saw the inventory). a single short observation is enough.]'
        : null

      loop.appendToolResults(results, {
        snapshot: snapshotText(),
        ...(nudgeText ? { eventText: nudgeText } : {}),
      })
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
      try { adapter.chat(text) } catch {}
      convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', text)
    } catch (err) {
      logger.warn(`[sei/orch] graceful cap close call failed: ${err.message}; falling back to capHitLine`)
      const fallback = capHitLine(config.persona)
      try { adapter.chat(fallback) } catch {}
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
      // Plan 3-03: brain.start() reads these to construct the compactor
      // with the SAME anthropic client + cachedSystemBlocks reference
      // (Pitfall 4 cache hit guarantee — cache_control marker stays valid).
      get anthropic() { return anthropic },
      get cachedSystemBlocks() { return cachedSystemBlocks },
    },
  }
}
