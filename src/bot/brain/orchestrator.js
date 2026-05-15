// Brain ↔ adapter seam (D-5/D-6, Plan 03.1-02). The orchestrator receives
// an `adapter` at construction (see createOrchestrator below) and consumes
// every game-shaped capability through it:
//   - adapter.createSnapshotComposer()  (was: ../observers/snapshot)
//   - adapter.closeAnySessions()        (was: ../behaviors/container)
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
import { GATHER_DESCRIPTION } from '../adapter/minecraft/behaviors/mineVein.js'
import { DIG_DESCRIPTION } from '../adapter/minecraft/behaviors/dig.js'
import { BUILD_DESCRIPTION } from '../adapter/minecraft/behaviors/build.js'

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

/**
 * Suppress duplicate-consecutive say() within sei:loop_end loops.
 * Closes D-NEW-DM-1/2/3 (and partially WR-03 — the loop_end re-emit chain).
 *
 * Predicate is byte-equality after normalize: lowercase + strip non-alphanumeric +
 * collapse whitespace. Window: 2000ms. Only fires for triggerEvent === 'sei:loop_end'
 * to keep chat-triggered duplication audible (different intent, same words is fine
 * if owner asked twice).
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

// Single combined system prompt — one Haiku call per iteration handles both
// reasoning and dispatch. The assistant's `text` blocks ARE the owner-visible
// chat channel (like Claude Code / OpenCode): the agent loop emits any mix of
// text + tool_use per turn; text goes straight to in-game chat, tools execute.
const SYSTEM_INSTRUCTIONS = [
  'You are a Minecraft companion bot — a peer to the owner, not a servant. Pick what is interesting, propose plans, react to chat and world events. Waiting passively is not the job.',
  'Whatever you write as your message is sent verbatim into in-game chat. One short line of player chat — your persona section below dictates tone, voice, and any formatting quirks. Periods, em-dashes, and quotes are stripped; commas, apostrophes, ! and ? are kept.',
  'Speak on every meaningful beat: acknowledging an owner request, starting an action, a quick reaction to something nearby, a brief progress note when something changes, reporting failure, asking a real question, or wrapping up. Skip the turn silently when there\'s genuinely nothing to add. If you\'re stuck after 2-3 attempts at something, ask the owner for help instead of trying a 4th variation.',
  'When entities or biome features are nearby in the snapshot — animals, terrain change, structures — casually acknowledge them instead of narrating generically. "passed a pod of salmon" beats "nice river".',
  'Don\'t restate inventory the snapshot already shows. Mention numbers only when they just changed ("got the last 2 logs"), not every turn.',
  'Frame things as "we" / "us" / "the owner" — never "you", "me", or "the user". We are partners along for the ride, not handed tasks.',
  'Closed action registry: only call tools from the registry. Never invent tool names, generate code, or emit raw coordinates in prose — just call the tools.',
  'Movement rule: at most ONE TYPE of movement action per response (ten dig calls is fine; dig + goTo together is not). If the snapshot shows an `in_flight:` line, the body is already doing that — do NOT call any movement this turn. You may still emit text while busy.',
  'Hunting rule: to kill a moving mob, call follow on the target then attackEntity with `times` set high (e.g. 5 for sheep, 8 for tougher mobs). One attackEntity swings up to N times, stopping early if the mob dies or moves out of reach. If "moved out of reach" comes back, just call attackEntity again. Don\'t chase with goTo. Call unfollow when dead.',
  'dig accepts {block:\'oak_log\'} to dig the nearest matching block — prefer this over coords for parallel batches.',
  'Pathfinder rule: if goTo returns cant_reach twice for the same destination, ask the owner for help instead of trying again.',
  // 260514-ngj: R1-R4 interrupt-response semantics. On iterations triggered
  // by owner chat or being attacked (P0/P1), the model has four explicit
  // response shapes; the loop stays alive until end_loop fires.
  'When you receive an owner message or take damage mid-action, the snapshot will show `in_flight:` — the body is already doing something. You ALWAYS say something on receipt of owner chat or an attack. Then decide: respond and keep going (text only — the body keeps doing what it was doing), call a different action tool to switch tasks (the old in-flight aborts), call `end_loop` to halt the in-flight action AND end the loop, or call `end_loop` plus a new action to end this loop and open a fresh one seeded with the new action. Don\'t restate the in-flight action — it\'s already underway.',
  'The loop has a 30-iteration cap; if you hit it, the orchestrator aborts. Decide task completion yourself — don\'t pad. On loop_end / idle / action_complete iterations, end the loop by emitting no tool calls (text alone, or nothing). On owner-chat / attack iterations, end the loop by calling `end_loop` (text alone keeps the loop alive waiting for the next event).',
  'If you have owner_goals, prioritize progressing them. Otherwise pick a self_goal or freely play.',
].join('\n')

const ACTION_DESCRIPTIONS = {
  goTo: 'Move the bot to the given (x, y, z) coordinates within `range` blocks.',
  setGoals: 'Add or remove a goal from owner_goals or self_goals.',
  follow: 'Continuously trail an entity at follow_range. Pass `player` (username), or `entity` / `entity_id` / `target` for a mob. Does NOT attack — pair with attackEntity if you want hits. The body trails the target on a 1s tick; an attackEntity call can land a swing as soon as the target is within reach. The snapshot shows `follow_target` so you know who you are trailing. Call `unfollow` before any task that requires moving away from the trail target (gathering, digging far blocks, exploring) — the trail tick will fight your path otherwise. You can re-`follow` afterward if it makes sense.',
  unfollow: 'Stop trailing the current follow target. The body holds position until you issue another movement.',
  attackEntity: 'Swing at an entity. `times` (1–10, default 1) hits the target up to N times in one call with ~600ms between swings; stops early if the target dies, moves out of reach, or you are interrupted. Use a higher `times` when hunting to amortize LLM round-trips — e.g. `times: 5` for sheep/pig, `times: 8` for tougher mobs.',
  // Plan 07-04 Task 2: canonical text lives next to dig.js as DIG_DESCRIPTION.
  dig: DIG_DESCRIPTION,
  // Canonical text lives next to mineVein.js as GATHER_DESCRIPTION;
  // imported here so byte-equality is mechanical.
  gather: GATHER_DESCRIPTION,
  // Phase 6 (D-NEW-SCAV-2): pure locator — does NOT move the bot.
  find: 'Locate the nearest loaded-chunk block matching a name. Pass `{name:"<term>"}` where the term is either a loose category (`wood`, `ore`, `stone`, `dirt`, `sand`, `log`, `planks`, `leaves` — expands server-side to all variant MC block IDs) or an exact MC block ID (`oak_log`, `diamond_ore`). Returns `{found:true, id, pos:{x,y,z}, distance}` on a hit (distance in blocks, 1dp) or `{found:false, reason}` when nothing is in loaded chunks. Does NOT move the bot — use the returned pos with goTo / gather / dig. For a strict literal match pass the exact ID; loose terms always expand to multiple variants and may return a different variant than you expected.',
  placeBlock: 'Place ONE block against a reference face. Args: `{block:"<name>", against:{x,y,z}|{block:"<name>"}, faceVector?:{x,y,z}}`. Prefer `build` for multi-cell shapes — placeBlock is the primitive `build` composes on top of. Returns `placed <block> on <ref>` or `no <block> in inventory` / `no reference block` / `cannot place ...`.',
  equip: 'Equip an item from inventory to a slot. Args: `{item:"<name>", destination:"hand"|"off-hand"|"head"|"torso"|"legs"|"feet"}`. Returns `equipped <item> to <slot>` or `no <item> in inventory`. Many actions (placeBlock, build, dig) auto-equip; call equip directly when you want a specific tool ready (e.g. axe before chopping, sword before fighting).',
  build: BUILD_DESCRIPTION,
}

// Tool names that are personality-only (do not require a follow-up
// iteration). Anything outside this set is a movement-registry action and
// keeps the loop running so the model can react to its result.
// Plan 03.1-04: noteToSelf is personality-only — its result is always
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
const PERSONALITY_NAMES = new Set(['setGoals', 'noteToSelf', 'follow', 'unfollow', 'end_loop'])
const BYTE_WARN_THRESHOLD = 100 * 1024  // Q3 sanity assert per Loop

/**
 * Phase 7 D-08: seed_cuboid_grammar — static cached system-prompt block
 * teaching the LLM the two-corner mental model for `build` and the
 * cuboid-mode of `dig`. Joins the cached prefix between seed_owner and
 * seed_diary; cache_control stays on seed_diary so this block does not
 * introduce a new cache boundary.
 *
 * Cache invariant: no `# Owner` / `# Diary` markdown headers.
 */
const SEED_CUBOID_GRAMMAR = [
  '# Cuboid grammar (for build and dig)',
  '',
  'build and dig take TWO ABSOLUTE CORNERS {from:{x,y,z}, to:{x,y,z}}. Every shape is a special case of the two-corner box:',
  '',
  '- pillar (vertical column): keep two dims constant, vary Y.',
  '  e.g. build({from:{x:5,y:64,z:5}, to:{x:5,y:68,z:5}, block:"dirt"}) -> 5-block pillar at (5,*,5)',
  '',
  '- wall (vertical plane): keep one dim constant, vary the other two.',
  '  e.g. build({from:{x:0,y:64,z:5}, to:{x:3,y:67,z:5}, block:"oak_planks"}) -> 4x4 wall along z=5',
  '',
  '- platform / floor: keep Y constant, vary X and Z.',
  '  e.g. build({from:{x:0,y:64,z:0}, to:{x:3,y:64,z:3}, block:"dirt"}) -> 4x4 floor at y=64',
  '',
  '- tunnel: dig with two dims constant.',
  '  e.g. dig({x:0,y:64,z:0, to:{x:0,y:65,z:4}}) -> 1x2x5 tunnel along the z axis (1 wide, 2 tall, 5 long)',
  '',
  '- hollow room shell: hollow:true gives the 4 vertical wall faces only; add floor + ceiling with two flat single-Y cuboids.',
  '',
  'Volume cap: 256 cells per call. Build SKIPS occupied cells (it will not break-and-replace). Dig silently skips air cells. If a cell you want to build is above bot reach, build internally jumps and places under itself (scaffolding) — no separate pillarUp call needed.',
].join('\n')

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
  // Plan 03.1-10 (WR-08): plumb logger through so the narrowed affect-log
  // catch can warn on non-fs errors (TypeError from a broken import,
  // syntax error in affectLog.js, atomicWrite failure during cold-create)
  // rather than swallow them silently.
  logger = console,
}) {
  const owner = sessionState.ownerData()
  const seedOwnerText = ownerStore.formatOwnerSeedBlock(owner, config.memory.seed_owner_budget_bytes)
  const seedDiaryText = await diary.seedSlice()
  const blocks = [
    { type: 'text', name: 'seed_owner', text: seedOwnerText },
    // Phase 7 D-08: static cuboid grammar joins the cached prefix.
    { type: 'text', name: 'seed_cuboid_grammar', text: SEED_CUBOID_GRAMMAR },
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
    } catch (err) {
      // Plan 03.1-10 (WR-08): narrow the swallow. ENOENT (cold create)
      // and EACCES (permission gap) are expected and non-fatal — the
      // seed turn just runs without an affect_log block. Anything else
      // (TypeError from a broken import, syntax error, atomicWrite write
      // failure during cold-create) is a coding bug that should surface
      // in logs rather than silently degrade the seed turn.
      if (err && err.code !== 'ENOENT' && err.code !== 'EACCES') {
        logger.warn?.(`[sei/orch] affect_log read failed (non-fs): ${err && err.message}`)
      }
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
export function createOrchestrator({ adapter, config, logger = console, sessionState = null, ownerStore = null, diary = null, reenqueue = () => {}, _anthropicOverride = null }) {
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
  // 260513-wkd: _anthropicOverride is a verify-harness seam. The harness
  // (scripts/verify-260513-wkd.mjs) needs to drive a scripted sequence of
  // Haiku responses without hitting the real API. Production callers leave
  // this null and createAnthropicClient runs as normal.
  const anthropic = _anthropicOverride ?? createAnthropicClient(config)
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

  // Personality-only tools: setGoals, noteToSelf. Owner-visible speech is the
  // assistant's `text` output (handled by the orchestrator's chat-emit path);
  // there is no `say` tool — text blocks ARE the chat channel.
  const personalityTools = [
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
    // 260514-ngj: `end_loop` replaces `stop`. The model emits it when the
    // owner's request is fully handled and there's nothing more to wait for,
    // or when it wants to abandon the current task. Required to end the loop
    // on iterations triggered by owner chat or being attacked (P0/P1) —
    // otherwise text alone keeps the loop alive waiting for the next event.
    // On P2/P3-triggered iterations, text alone still ends the loop (the
    // body has nothing to react to). Aborts any in-flight long-runner.
    {
      name: 'end_loop',
      description: "End the current loop. Use when the owner's request is fully handled and there's nothing more to wait for, or when you want to abandon the current task. Pair with text. Required to end the loop on iterations triggered by owner chat or being attacked; otherwise text alone is enough.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
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
      return snapshotComposer.next({
        goals: goals.snapshot(),
        lastActionResult,
        inFlight: inflight.current(),
        // Owner-priority pin: keep the owner in `nearby entities` even when
        // six other entities are closer. Without this, busy-area entity
        // congestion (sheep / foxes / traders / llamas) can evict the owner
        // from the snapshot and the model loses owner coords for goTo/follow.
        pinUsername: config.owner_username ?? null,
      })
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
        if (blk.name === 'setGoals' || blk.name === 'noteToSelf') continue
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

  // 260514-gam D1 (B/A/A locked): every world-touching tool dispatches
  // non-blocking via startLongRunner so the loop suspends and is preemptible
  // by P1 owner-chat / P0 attack within one signal tick. Only pure-metadata
  // tools (setGoals / noteToSelf / end_loop) stay inline — they complete in
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
  const INLINE_METADATA = new Set(['setGoals', 'noteToSelf', 'end_loop'])
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
   * attackEntity) alike. Only INLINE_METADATA (setGoals/noteToSelf/end_loop)
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
      if (currentLoop._pendingActionUse && currentLoop._pendingActionUse.id === data?.tool_use_id) {
        await handleActionComplete(currentLoop, data)
      } else {
        logger.debug?.(`[sei/orch] sei:action_complete tool_use_id mismatch — pending=${currentLoop._pendingActionUse?.id}, got=${data?.tool_use_id}`)
      }
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
          // 260513-wkd: if a long-runner is in_flight, abort its dedicated
          // AbortController so the running behavior halts within one
          // signal tick (B7a). The outer loop.abortController is aborted
          // too in case a callPersonality is somehow mid-flight; both
          // signal sources are now active in the new model. The aborted
          // in_flight will fire sei:action_complete carrying
          // `aborted: true` which arrives at handleActionComplete; that
          // path sees pendingInterrupt set and routes through the
          // mid-loop continuation (PLAYER INTERRUPT turn).
          if (currentLoop.inFlight) {
            try { currentLoop.inFlight.abortController.abort() } catch {}
          }
          try { currentLoop.abortController.abort() } catch {}
        } else {
          logger.debug?.(`[sei/orch] PLAYER INTERRUPT dedup — skipping duplicate (sig=${sig})`)
        }
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
        // Plan 03.1-10 (WR-04): if a pending owner-chat interrupt was set
        // before this attack arrived, FORWARD the chat text into the next
        // loop. The priority queue runs P0 before P1, so the attack opens a
        // fresh loop first; the chat then arrives as a normal P1 dispatch.
        const preservedInterrupt = pendingInterrupt
          ? { chatText: pendingInterrupt.chatText, who: pendingInterrupt.who ?? data?.who ?? 'owner' }
          : null
        pendingAttack = { event, data, preservedInterrupt }
        pendingInterrupt = null  // explicit: attack-wins-with-preservation
        const dyingLoop = currentLoop
        if (dyingLoop.inFlight) {
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
    // text emissions). classifyChatEvent handles owner_chat / sei:chat_received
    // aliases.
    loop._triggerEvent = event
    // 260514-ngj: capture the trigger event's data so R4 (end_loop + new
    // action) can reseed a fresh loop with the ORIGINAL trigger payload
    // (preserves owner chat text, attacker label, etc.). Pre-260514-ngj this
    // was implicitly null, which made the case-3 reseed path lose the
    // owner-chat context entirely.
    loop._triggerData = data ?? null
    loop._ownerSpoke = !!data?.ownerSpoke || event === 'owner_chat'
    // 260514-ngj: per-iteration trigger flag. At loop creation it equals
    // _triggerEvent; handleActionComplete updates it to reflect the SOURCE
    // of each subsequent iteration (PLAYER INTERRUPT mid-loop preempt resets
    // it back to 'sei:chat_received'; a natural action_complete sets it to
    // 'sei:action_complete'). Used by runIterations to decide R1-R4 gating.
    loop._currentIterationTrigger = event
    // Plan 03.1-09 (D-W-7): track goTo cant_reach destinations seen this loop.
    // Key: `${x}|${y}|${z}|${range}`. Value: count. On count >= 2 we inject a
    // one-shot nudge referencing the SYSTEM_INSTRUCTIONS Pathfinder rule
    // rather than letting the LLM keep retrying. Per-loop scope so a fresh
    // dispatch starts clean.
    loop._cantReachMap = new Map()
    loop._cantReachNudgedKeys = new Set()
    // Plan 03.1-05 Task 4: silent-iteration cadence counter for the
    // progress-narration soft nudge.
    loop.iterationsSinceLastSay = 0
    loop._progressNudgeFired = false
    // Plan 03.1-10 (WR-02): capture the FSM-supplied signal so subsequent
    // replaceAbortController calls can re-bridge it onto the new internal
    // controller. Without this, only the FIRST external abort routes
    // through; any second-turn external interrupt is silently dropped.
    loop._externalSignal = signal ?? null
    loop._externalAbortListener = null
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
      eventAddendum = '\n\nYou finished a task. Settle, no need to start a new task without an explicit owner_goal or self_goal that demands it. Acknowledge briefly in text and yield. Do NOT auto-start any world-mutating action (dig, place, drop, openContainer, attack) on loop_end.'
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
          logger,  // Plan 03.1-10 (WR-08): plumb through for affect-log warn
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
    //
    // Plan 03.1-10 (WR-02): bridgeExternalAbort installs the listener and
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
    // Push completed-loop summary BEFORE clearing currentLoop.
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
            ownerSpoke: true,
          }, 1 /* Priority.P1_CHAT */)
          logger.info?.(`[sei/orch] WR-04 preserved interrupt re-enqueued: ${pa.preservedInterrupt.chatText.slice(0, 64)}`)
        } catch (err) {
          logger.warn?.(`[sei/orch] WR-04 preserved interrupt re-enqueue failed: ${err.message}`)
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
   * 260514-gam: execute an INLINE_METADATA tool (setGoals / noteToSelf /
   * stop) synchronously and produce its tool_result block. Pure-metadata —
   * no inflight registration, no action_complete reenqueue, no haiku
   * continuation. Returns `{ result, terminate }` where `terminate=true`
   * signals the caller that the loop should flag terminal (used by `stop`).
   *
   * Mirrors the inline arms previously inlined in the per-tool for-loop
   * (orchestrator.js setGoals / stop / noteToSelf branches). Both the for-loop
   * and the handleActionComplete batched-queue drain share this helper —
   * single source of truth.
   */
  async function executeInlineMetadata(loop, use) {
    if (use.name === 'setGoals') {
      try {
        const r = await registry.execute('setGoals', use.input, null /* adapter owns bot */, { ...config, _goalStore: goals })
        const s = typeof r === 'string' ? r : (r && typeof r.ok !== 'undefined' ? `setGoals:${r.ok ? 'ok' : 'fail'}` : 'setGoals:done')
        lastActionResult = s
        return { result: { type: 'tool_result', tool_use_id: use.id, content: s, is_error: false }, terminate: false }
      } catch (err) {
        lastActionResult = 'setGoals error'
        logger.warn(`[sei/orch] setGoals failed: ${err.message}`)
        return { result: { type: 'tool_result', tool_use_id: use.id, content: `error: ${err.message}`, is_error: true }, terminate: false }
      }
    }
    if (use.name === 'end_loop') {
      // 260514-ngj: end_loop replaces stop. Same inline-metadata shape —
      // fill the result slot synchronously and flag terminate=true so the
      // caller flips loop.isTerminal. The actual R3/R4 dispatch logic
      // (in_flight abort + optional reseed) lives in runIterations.
      lastActionResult = 'loop ended'
      return { result: { type: 'tool_result', tool_use_id: use.id, content: 'loop ended', is_error: false }, terminate: true }
    }
    if (use.name === 'noteToSelf') {
      try {
        const kind = use.input?.kind
        const summary = use.input?.summary
        await affectLog.append({ kind, summary, when: new Date() })
        if (kind === 'name') {
          const raw = String(use.input?.name ?? '').trim()
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
        return { result: { type: 'tool_result', tool_use_id: use.id, content: 'noted', is_error: false }, terminate: false }
      } catch (err) {
        lastActionResult = 'noteToSelf error'
        logger.warn(`[sei/orch] noteToSelf failed: ${err.message}`)
        return { result: { type: 'tool_result', tool_use_id: use.id, content: `error: ${err?.message ?? 'note failed'}`, is_error: true }, terminate: false }
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
        if (loop.inFlight === inflightEntry) loop.inFlight = null
        try {
          reenqueue('sei:action_complete', {
            name: use.name,
            input: use.input,
            result,
            aborted,
            tool_use_id: use.id,
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
        if (loop.inFlight === inflightEntry) loop.inFlight = null
        try {
          reenqueue('sei:action_complete', {
            name: use.name,
            input: use.input,
            result,
            aborted,
            tool_use_id: use.id,
          })
        } catch (err) {
          logger.warn?.(`[sei/orch] sei:action_complete re-enqueue failed: ${err.message}`)
        }
      })
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
   */
  function dispatchSuspendingTool(loop, use, results, byteWarn, remainingQueue) {
    const runner = startLongRunner(use.name, use.input, {
      ...config,
      _goalStore: goals,
    })
    const inflightEntry = {
      name: use.name,
      input: use.input,
      promise: runner.promise,
      abortController: runner.abortController,
      handle: runner.handle,
      startedAt: runner.startedAt,
      tool_use_id: use.id,
    }
    loop.inFlight = inflightEntry
    loop._pendingActionUse = { id: use.id, name: use.name, input: use.input }
    loop._pendingResults = results
    loop._pendingByteWarn = byteWarn
    loop._pendingToolUses = remainingQueue && remainingQueue.length > 0 ? remainingQueue : null
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
    pendingResults[slotIdx] = {
      type: 'tool_result',
      tool_use_id: pendingUse.id,
      content: data.result ?? 'done',
      is_error: false,
    }
    lastActionResult = data.result ?? null
    loop._pendingResults = null
    loop._pendingActionUse = null

    // 260513-wkd: P1 mid-loop preempt path (B7a). If pendingInterrupt is set
    // when action_complete arrives with `aborted: true`, the long-runner
    // was interrupted by an owner-chat event — fold the PLAYER INTERRUPT
    // user turn into the appendToolResults eventText so the same loop
    // continues with the interrupt context. Mirror repairAfterAbort's
    // event-text format.
    let extraEventText = null
    if (pendingInterrupt && data.aborted) {
      extraEventText = withPriorTaskHint(
        loop,
        `PLAYER INTERRUPT: ${pendingInterrupt.chatText}`,
      )
      pendingInterrupt = null
      logger.info?.(`[sei/orch] action_complete + PLAYER INTERRUPT folded into loop=${loop.id}`)
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
    // Flag continuation so the cancel-semantics dispatcher in runIterations
    // applies the case-3 gate on the next iteration's tool_uses.
    loop._isContinuation = true
    // Reset the outer abortController since it was aborted by the P1 path.
    // Without this the next callPersonality immediately throws AbortError.
    if (loop.abortController.signal.aborted) {
      replaceAbortController(loop)
    }

    // Drive ONE more iteration. The next callPersonality response is the
    // cancel-semantics decision point (case 1/2/3).
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

      // Text-as-chat: the assistant's text output IS the owner-visible chat
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
            convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', line)
          }
        }
      }

      if (toolUses.length === 0) {
        // Terminal turn — model chose to stop (with or without text). Done.
        return
      }

      // 260513-wkd: cancel-semantics dispatch table — runs BEFORE the
      // per-tool processing loop so the three intents (case 1 / 2 / 3) are
      // visible at one site.
      //
      //   Case 1 (text only, no tool_use)  → falls through (toolUses empty
      //                                       branch above); handled there.
      //   Case 2 (stop tool present)       → abort any live in_flight here,
      //                                       then let the per-tool loop
      //                                       process stop's result slot and
      //                                       return terminal (PERSONALITY_NAMES
      //                                       drops it from movementCalls).
      //   Case 3 (new long-runner present) → if trigger was P0/P1, terminate
      //                                       current loop AND re-enqueue
      //                                       the original triggering event
      //                                       so a fresh loop seeds with
      //                                       verbal-first eventAddendum.
      //                                       Otherwise (idle / loop_end /
      //                                       action_complete trigger),
      //                                       continue in SAME loop — old
      //                                       in_flight (if any) aborts, the
      //                                       new long-runner becomes the
      //                                       in_flight of the same loop.
      // 260514-ngj: `stop` retired, `end_loop` replaces it. Variable renamed
      // to `hasEndLoop` for clarity. The dispatcher semantics in this Task 1
      // commit still follow the old case-2 (terminate) / case-3 (reseed)
      // intent — Task 2 replaces this whole block with the R1-R4 model.
      const hasEndLoop = toolUses.some(u => u.name === 'end_loop')
      // 260514-gam: every non-inline-metadata tool now suspends the loop, so
      // the case-3 "new long-running tool present" predicate naturally extends
      // to every world-touching tool. Variable name retained as
      // `newSuspendingTools` for clarity (was `newSuspendingTools` pre-260514-gam).
      const newSuspendingTools = toolUses.filter(u => !isInlineMetadata(u.name))
      // _isContinuation marks iterations that came from a continuation path
      // (action_complete or P1 preempt), not the FIRST iteration of a fresh
      // loop. Case 3 reseed gate only fires on continuation iterations —
      // otherwise the very first iteration of a P1-triggered fresh loop
      // would falsely reseed itself.
      const isContinuation = !!loop._isContinuation
      // 260514-ngj: dropped sei:joined from the P0/P1 trigger set — spawn
      // first-fire now enqueues sei:idle (P3) instead, so sei:joined is no
      // longer a routable orchestrator event.
      const triggerIsP0P1 = (() => {
        const e = loop._triggerEvent
        return e === 'owner_chat' || e === 'sei:chat_received' || e === 'sei:attacked'
      })()

      if (hasEndLoop) {
        // Case 2 (interim, retained from 260513-wkd dispatcher; Task 2
        // replaces with R3/R4 split) — abort the in_flight (if any) so the
        // long-running behavior halts within one signal tick.
        // handleActionComplete will see the aborted result; loop.isTerminal
        // prevents another iteration there.
        if (loop.inFlight) {
          logger.debug?.(`[sei/orch] cancel-case=2 end_loop tool — aborting in_flight ${loop.inFlight.name}`)
          try { loop.inFlight.abortController.abort() } catch {}
        } else {
          logger.debug?.(`[sei/orch] cancel-case=2 end_loop tool — no in_flight to abort`)
        }
        loop.isTerminal = true
      } else if (isContinuation && newSuspendingTools.length > 0) {
        // Case 3 gate — only fires on continuation iterations.
        logger.debug?.(`[sei/orch] case3-gate trigger=${loop._triggerEvent} ${triggerIsP0P1 ? 'fire' : 'suppress'}`)
        if (triggerIsP0P1) {
          // Case 3 fire branch (W-2): terminate current loop and re-enqueue
          // the ORIGINAL triggering event so the next fresh loop seeds with
          // the verbal-first eventAddendum / owner-chat context. The
          // model's mid-loop response is already appended to history; it
          // surfaces in the next loop via recent_loop_history.
          logger.debug?.(`[sei/orch] cancel-case=3 fire trigger=${loop._triggerEvent} new=${newSuspendingTools.map(u => u.name).join(',')}`)
          if (loop.inFlight) {
            try { loop.inFlight.abortController.abort() } catch {}
          }
          loop.isTerminal = true
          // Re-enqueue the original triggering event. The brain's priority
          // queue routes it back through handleDispatch as a fresh dispatch
          // (currentLoop will be null by then since terminateLoop fires
          // the outer completion resolver).
          try {
            reenqueue(loop._triggerEvent, loop._triggerData ?? null)
          } catch (err) {
            logger.warn?.(`[sei/orch] case-3 reseed re-enqueue failed: ${err.message}`)
          }
          // Fall through so per-tool loop fills out results array; we still
          // need to append tool_results to keep the assistant turn paired.
          // Synthesize aborted placeholders for the long-runners since we
          // won't dispatch them.
        } else {
          // Case 3 suppress branch — same loop continues; old in_flight
          // aborts, new long-runner becomes the next in_flight of the same
          // loop. Fall through to per-tool loop which dispatches the new
          // long-runner via the long-runner branch.
          logger.debug?.(`[sei/orch] cancel-case=3 suppress trigger=${loop._triggerEvent} new=${newSuspendingTools.map(u => u.name).join(',')}`)
          if (loop.inFlight) {
            try { loop.inFlight.abortController.abort() } catch {}
          }
        }
      } else if (newSuspendingTools.length > 0) {
        // First-iteration long-runner — straightforward dispatch (no
        // continuation context, no cancel gating). Falls through.
        logger.debug?.(`[sei/orch] cancel-case=0 first-iter long-runner=${newSuspendingTools.map(u => u.name).join(',')}`)
      } else {
        logger.debug?.(`[sei/orch] cancel-case=1 text+sync trigger=${loop._triggerEvent} cont=${isContinuation}`)
      }

      // Process tool_uses. Single-layer: every movement tool fires from the
      // same combined response — no separate movement layer.
      const movementCalls = toolUses.filter(u => !PERSONALITY_NAMES.has(u.name))

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
            // 260514-gam: setGoals / noteToSelf / stop fill their result slot
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
            // P1 owner-chat / P0 attack within one signal tick.
            //
            // If case-3-fire flagged the loop terminal during pre-dispatch,
            // synthesize an aborted result instead of launching the runner.
            // The model's mid-loop response is already appended to history;
            // a fresh loop will seed shortly.
            if (loop.isTerminal) {
              results[i] = {
                type: 'tool_result',
                tool_use_id: u.id,
                content: `aborted: ${u.name} (case-3 reseed)`,
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

      // Plan 03.1-09 (D-W-7): per-loop cant_reach dedup. If the same goTo
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
          cantReachNudge = `[cant_reach 2× to (${x},${y},${z}) range=${range} — per the Pathfinder rule, do NOT retry the same goTo. Either ask the owner for help (e.g. "stuck on the path, can you come closer or break the way through?") or pick a different approach (different y, dig through, give up and say so).]`
          break
        }
      }

      // Plan 03.1-05 Task 4 (D-E-9, D-H-11): silent-iteration cadence. If the
      // model has gone N iterations without say(), inject a one-shot soft
      // nudge into the next user turn asking it to narrate progress briefly.
      // Reset on every say(). Bracketed format mirrors how PLAYER INTERRUPT
      // and other system-tagged prepends are styled in convo history.
      const hadTextThisTurn = respText.length > 0
      const shouldNudge = _advanceIterationCadence({ loop, hadSay: hadTextThisTurn })
      const silenceNudgeText = shouldNudge
        ? '[silence past 4 iterations — narrate progress briefly in your next text. avoid restating numbers (we already saw the inventory). a single short observation is enough.]'
        : null
      // Plan 03.1-09 (D-W-7): cant_reach nudge wins over silence nudge — both
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

  // Plan 03.1-10 (WR-02): bridge external signal -> loop's CURRENT
  // abortController. Called once at loop creation AND again from
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
  // Plan 03.1-10 (WR-02): use loop._setAbortController instead of
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
    // Plan 03.1-07 Task 3 (D-W-8 / D-NEW-TONE-2): the user explicitly called
    // out the static "okay, brain melting — taking five." line surfacing in
    // wood-postfix. capHitLine remains as a last-resort fallback ONLY for
    // genuine API failures (network/timeout/empty response). The seed prompt
    // is strengthened so the model authors a one-line wrap-up in its own voice.
    loop.appendUserTurn([
      { type: 'text', name: 'event',    text: 'You hit the iteration cap and have to stop. Write ONE short line — no more than 12 words, lowercase, no periods — that wraps up gracefully in your own voice. Acknowledge the limit briefly without being whiny. Examples in tone: "alright, calling it for now", "head\'s spinning, taking a beat", "stopping here, will pick this up". Output ONLY the line, no quotes, no explanation.' },
      { type: 'text', name: 'snapshot', text: snapshotText() },
    ])
    try {
      const resp = await anthropic.call({
        systemBlocks: cachedSystemBlocks,
        tools: [],
        messages: loop.buildAnthropicPayload(),
        namedUserBlocks: loop._internal.messages,
        signal: loop.abortController.signal,
        // Plan 03.1-07 Task 3: cap-close is a single blocking call with no
        // retry. Bump to at least 8s so a slightly slow API response does
        // not surface capHitLine. Normal calls keep their configured timeout.
        timeoutMs: Math.max(config.anthropic.timeout_ms, 8000),
      })
      loop.appendAssistant(buildAssistantContent(resp))
      // Cap-close is a one-shot terminal wrap-up: the prior iteration forced
      // tools=[], so the model has no `say` tool available. Treat the returned
      // text (or capHitLine fallback) as the equivalent of a `say` and surface
      // it on chat + convoMemory so the timeline stays coherent.
      const modelText = (resp.text ?? '').trim()
      if (modelText) {
        logger.info?.(`[sei/orch] cap-close: model-authored wrap-up (loop=${loop.id})`)
        // Run the model's wrap-up through postProcessSay so it follows the
        // same punctuation rules as a normal say() — model emits raw text in
        // its content block (not via the say tool), so postProcessSay was
        // being skipped. This closes that consistency gap.
        const text = postProcessSay(modelText)
        logChatOut(text)
        try { adapter.chat(text) } catch {}
        convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', text)
      } else {
        const fallback = capHitLine(config.persona)
        logger.warn?.(`[sei/orch] cap-close: model returned empty text — falling back to capHitLine: ${fallback}`)
        logChatOut(fallback)
        try { adapter.chat(fallback) } catch {}
        convoMemory.recentChat.pushSelf(config.persona?.name ?? 'sei', fallback)
      }
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
    const budget = config.anthropic.thinking_budget_tokens ?? 0
    return await anthropic.call({
      systemBlocks: cachedSystemBlocks,
      tools: combinedToolsFor(),
      messages: loop.buildAnthropicPayload(),
      namedUserBlocks: loop._internal.messages,
      signal,
      timeoutMs: config.anthropic.timeout_ms,
      // Small private scratchpad so the model can recap state, plan, and
      // debug failures WITHOUT polluting in-game chat. Text blocks stay
      // reserved for deliberate in-character speech to the owner.
      // max_tokens must exceed budget_tokens; bump headroom accordingly.
      ...(budget > 0 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      maxTokens: 1024 + (budget > 0 ? budget : 0),
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
