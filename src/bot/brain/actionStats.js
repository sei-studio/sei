// src/bot/brain/actionStats.js — per-session action outcome counters (261011).
//
// Why: two paying users cancelled calling the Minecraft companion "too stupid",
// and nothing told us WHICH actions failed: bot logs stay on the user's PC and
// PostHog only saw a session-end reason. This module keeps privacy-safe
// aggregate counters for the life of one bot process (= one summon) and hands
// a compact snapshot up the port to main, which ships ONE `mc_session_actions`
// event when the play session closes (src/main/mcActionTelemetry.ts).
//
// Privacy contract: only counts, durations and short closed enums are stored.
// No chat text, player names, coordinates, item/block names or persona text
// ever enter this module's state. Action NAMES are registry identifiers
// (gather, goTo, ...), never model-supplied strings, and main re-validates them
// against a strict charset before anything leaves the machine.
//
// Process-level singleton (`sessionActionStats`): the runtime may rebuild the
// brain per connection (reconnects), but the session is the process.

/** Closed failure classes. Anything unrecognised falls to 'error'. */
export const FAIL_REASONS = Object.freeze([
  'no_path',
  'timeout',
  'missing_materials',
  'target_not_found',
  'aborted_by_preempt',
  'partial',
  'refused',
  'bad_args',
  'error',
])

/** Closed LLM error classes. */
export const LLM_ERROR_CLASSES = Object.freeze(['429', '401', '402', '5xx', 'timeout', 'other'])

/** A player line with no say() and no world action within this window counts as unanswered. */
export const UNANSWERED_MS = 20_000

const ACTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
/** Hard bound on distinct action names held (registry has ~30; this is a backstop). */
const MAX_ACTION_NAMES = 64

/**
 * Classify a returned result STRING. Returns a FAIL_REASONS member, or null
 * when the text reads as a success. Behaviors report most outcomes as plain
 * strings (see behaviors/*.js), so this is a pattern map over those strings,
 * not a contract; unknown shapes count as success rather than inventing a
 * failure.
 */
export function classifyResultText(text) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) return null
  // Free text the bot merely READ (sign contents) must not be pattern-matched.
  if (s.startsWith('sign:')) return null
  // follow keeps trailing after an interrupt: still doing what was asked.
  if (/still trailing/.test(s)) return null

  if (/^aborted\b|\(aborted|aborted after|\binterrupted\b/.test(s)) return 'aborted_by_preempt'

  // gather / dig progress "gathered K/W name": K<W is a short harvest, K=0 nothing.
  const prog = s.match(/^(?:gathered|dug) (\d+)\/(\d+)/)
  if (prog) {
    const got = Number(prog[1]), want = Number(prog[2])
    if (got >= want) return null
    return got === 0 ? 'target_not_found' : 'partial'
  }

  // A build that placed some cells but not all (its reason text names reach).
  if (/cells failed|^built nothing|^build halted/.test(s)) return 'partial'
  if (/\btimeout\b|timed out|ran out of time/.test(s)) return 'timeout'
  if (/cant_reach|can't reach|cannot reach|could ?n[o']t reach|unreachable|out of range|out of reach|too far|no path|nopath|no open spot in reach|no reachable/.test(s)) return 'no_path'
  if (/^no \S.* in inventory|you only have|ran out of|^no \S.* to (smelt|fuel|deposit)|needs a crafting table|no crafting recipe|not enough|holding nothing|no tool that can|^cannot hold/.test(s)) return 'missing_materials'
  if (/in loaded chunks|not found|no such|no known ids|target gone|^gone$|^no block|no sign there|no container open|no furnace open|no item named|target changed|nothing smelted|chest empty|not a bed|^no_bot$/.test(s)) return 'target_not_found'
  if (/^cannot |^can't |^couldn't |^could not |\bfailed\b|^busy |spar mode is off|food bar full|must specify|no item specified|inventory full/.test(s)) return 'refused'
  return null
}

/**
 * Outcome of one executeAction call. Returns null for success or a
 * FAIL_REASONS member.
 * @param {{ result?: unknown, error?: unknown, aborted?: boolean }} o
 */
export function classifyActionOutcome({ result, error, aborted = false } = {}) {
  if (error) {
    if (aborted || error?.name === 'AbortError') return 'aborted_by_preempt'
    if (error?.name === 'ZodError' || Array.isArray(error?.issues)) return 'bad_args'
    if (/^Unknown action/.test(String(error?.message ?? ''))) return 'bad_args'
    return classifyResultText(error?.message ?? String(error)) ?? 'error'
  }
  if (typeof result === 'string') return classifyResultText(result)
  if (result && typeof result === 'object') {
    if (result.found === false) return classifyResultText(result.reason) ?? 'target_not_found'
    if (result.ok === false) return classifyResultText(result.reason) ?? 'error'
    if (result.skip === true) return null
    if (typeof result.text === 'string') return classifyResultText(result.text)
  }
  return null
}

/** Classify an LLM call error into LLM_ERROR_CLASSES. */
export function classifyLlmError(err) {
  if (!err) return 'other'
  if (err.isTimeout === true || /timed? ?out/i.test(String(err.message ?? ''))) return 'timeout'
  const status = Number(err.status ?? err.statusCode)
  if (status === 429) return '429'
  if (status === 401) return '401'
  if (status === 402) return '402'
  if (status >= 500 && status < 600) return '5xx'
  return 'other'
}

function emptyAction() {
  return { n: 0, ok: 0, fail: 0, ms: 0, reasons: {} }
}

/**
 * @param {{ now?: () => number, unansweredMs?: number }} [opts]
 */
export function createActionStats({ now = () => Date.now(), unansweredMs = UNANSWERED_MS } = {}) {
  const startedAt = now()
  /** @type {Map<string, {n:number, ok:number, fail:number, ms:number, reasons:Record<string, number>}>} */
  let actions = new Map()
  let counters = {}
  let llmErrors = {}
  /** Arrival times of player lines not yet followed by a reply or action. */
  let pendingChats = []
  let meta = {}
  let metaProvider = null
  let dirty = false

  function reset() {
    actions = new Map()
    counters = {
      llm_turns: 0,
      silent_turns: 0,
      say_turns: 0,
      stuck: 0,
      deaths: 0,
      player_msgs: 0,
      voice_msgs: 0,
      unanswered: 0,
      replied: 0,
      reply_ms_total: 0,
    }
    llmErrors = {}
    pendingChats = []
    dirty = false
  }
  reset()

  function bump(key, by = 1) {
    counters[key] = (counters[key] ?? 0) + by
    dirty = true
  }

  /** Move player lines older than the window into `unanswered`. */
  function sweep(t = now()) {
    if (pendingChats.length === 0) return
    const keep = []
    for (const at of pendingChats) {
      if (t - at >= unansweredMs) bump('unanswered')
      else keep.push(at)
    }
    pendingChats = keep
  }

  /** The bot responded (said something, or started a world action). */
  function answer(t = now()) {
    sweep(t)
    if (pendingChats.length === 0) return
    // Latency is measured from the OLDEST waiting line: one reply answers the batch.
    bump('replied')
    bump('reply_ms_total', Math.max(0, t - pendingChats[0]))
    pendingChats = []
  }

  return {
    /**
     * One executeAction settled.
     * @param {string} name registry action name
     * @param {number} durationMs
     * @param {string|null} failReason null = success, else a FAIL_REASONS member
     */
    recordAction(name, durationMs, failReason = null) {
      if (typeof name !== 'string' || !ACTION_NAME_RE.test(name)) name = 'other'
      let a = actions.get(name)
      if (!a) {
        if (actions.size >= MAX_ACTION_NAMES) name = 'other'
        a = actions.get(name) ?? emptyAction()
        actions.set(name, a)
      }
      a.n += 1
      a.ms += Math.max(0, Math.round(Number(durationMs) || 0))
      if (failReason == null) {
        a.ok += 1
      } else {
        const r = FAIL_REASONS.includes(failReason) ? failReason : 'error'
        a.fail += 1
        a.reasons[r] = (a.reasons[r] ?? 0) + 1
      }
      dirty = true
    },
    /** A world action was dispatched: counts as a response to waiting player lines. */
    noteActionStarted() { answer() },
    /** One LLM response arrived; `said` = it carried a say() line. */
    noteLlmTurn({ said = false } = {}) {
      bump('llm_turns')
      bump(said ? 'say_turns' : 'silent_turns')
    },
    noteLlmError(err) {
      const c = classifyLlmError(err)
      llmErrors[c] = (llmErrors[c] ?? 0) + 1
      dirty = true
    },
    noteStuck() { bump('stuck') },
    noteDeath() { bump('deaths') },
    /** A player line that should get a response. `voice` lines are counted but not timed. */
    notePlayerChat({ voice = false } = {}) {
      sweep()
      if (voice) { bump('voice_msgs'); return }
      bump('player_msgs')
      pendingChats.push(now())
    },
    /** The bot spoke (say() reached chat or the call). */
    noteReply() { answer() },
    setMeta(patch) {
      if (patch && typeof patch === 'object') { meta = { ...meta, ...patch }; dirty = true }
    },
    /** Late-bound meta (model/provider can change mid-session on a backend switch). */
    setMetaProvider(fn) { metaProvider = typeof fn === 'function' ? fn : null },
    isDirty() { sweep(); return dirty },
    /** Plain JSON snapshot; clears the dirty flag. */
    snapshot() {
      const t = now()
      sweep(t)
      let provided = {}
      try { provided = metaProvider?.() ?? {} } catch {}
      dirty = false
      const acts = {}
      for (const [k, v] of actions) acts[k] = { n: v.n, ok: v.ok, fail: v.fail, ms: v.ms, reasons: { ...v.reasons } }
      return {
        v: 1,
        session_ms: Math.max(0, t - startedAt),
        meta: { ...meta, ...provided },
        actions: acts,
        counters: { ...counters, pending_chats: pendingChats.length },
        llm_errors: { ...llmErrors },
      }
    },
    /** Test seam. */
    _reset: reset,
  }
}

/** The one instance for this bot process (= this summon). */
export const sessionActionStats = createActionStats()

/** Provider kind for analytics: cloud proxy, the user's own key, or local Ollama. */
export function llmMetaFromConfig(config) {
  const provider = config?.llm?.provider ?? 'anthropic'
  const cloud = provider === 'anthropic' && !!config?.anthropic?.cloudMode
  const model = provider === 'anthropic'
    ? config?.anthropic?.model
    : config?.llm?.providers?.[provider]?.model
  return {
    provider_kind: cloud ? 'cloud' : provider === 'ollama' ? 'ollama' : 'byok',
    llm_provider: String(provider),
    model_id: typeof model === 'string' ? model : null,
  }
}
