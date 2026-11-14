// src/bot/adapter/sts2/index.js: the Slay the Spire 2 Adapter (the object the
// brain drives; contract in src/bot/brain/types.js). One per session; the
// game link (link.js) may lose and regain its seat underneath it (a game
// restart), and the adapter always reads the CURRENT seat.
//
// act() sends ONE move and waits for the game's action/result, then for the
// game to settle on its next decision point (a new actions/force) for up to
// SETTLE_MS, so the brain's follow-up turn sees the new hand. Card and target
// names are mapped to the game's index args right before each send
// (state.js resolveArgs), which is what makes a multi-play response safe.

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { createSts2Registry } from './registry.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { wireSts2Events } from './fsmWires.js'
import { createDashboardTelemetry } from './dashboard/telemetry.js'
import { classifyConnectError } from './errors.js'
import { resolveArgs, actionSignature } from './state.js'
import {
  STS2_BASELINE,
  SESSION_END_CLAUSE,
  worldPrimer,
  capabilityParagraph,
  actionRules,
  eventAddendum,
  SEI_ACT_DESCRIPTION,
} from './prompts.js'

/** After a move, how long to wait for the next decision point before returning. */
export const SETTLE_MS = 2_500
/** end_turn hands the round to the others: return almost at once. */
export const END_TURN_SETTLE_MS = 400
export const MAX_RECENT = 6

/**
 * @param {Object} args
 * @param {ReturnType<import('./link.js').createSts2Link>} args.link
 * @param {object} args.config        Parsed bot config (config.adapter.sts2).
 * @param {string} args.botUsername
 * @param {ReturnType<import('./stats.js').createSts2Stats>} [args.stats]
 * @param {object} [args.logger]
 * @returns {import('../../brain/types.js').Adapter}
 */
export function createSts2Adapter({ link, config, botUsername, stats = null, logger = console, settleMs = SETTLE_MS, endTurnSettleMs = END_TURN_SETTLE_MS, nudgeMs = 25_000 }) {
  if (!link) throw new Error('createSts2Adapter: link required')
  let _attachDispose = null
  let _handlers = null
  let appPaused = false
  let acting = 0
  let chain = Promise.resolve()
  let batchRun = 0
  const recent = []
  const noteRecent = (line) => {
    recent.push(line)
    if (recent.length > MAX_RECENT) recent.shift()
  }

  const seat = () => (link.seat && link.seat.open !== false ? link.seat : null)

  /** Resolves with the next force on `s` (or null after `ms`). */
  function nextForce(s, sinceSeq, ms) {
    if (s.force && s.force.seq > sinceSeq) return Promise.resolve(s.force)
    return new Promise((resolve) => {
      const t = setTimeout(() => { s.off('force', on); resolve(null) }, ms)
      const on = (f) => { clearTimeout(t); s.off('force', on); resolve(f) }
      s.on('force', on)
    })
  }

  async function runMove(action, args, { signal } = {}) {
    const s = seat()
    if (!s) return 'failed: your game window is not connected right now; wait for it to come back'
    if (appPaused) return 'paused: the player paused you in the app'
    const a = s.actions.get(action)
    if (!a) {
      const now = s.force ? s.force.actionNames.filter((n) => s.actions.has(n)) : []
      const list = now.length ? now : [...s.actions.keys()]
      return `failed: ${action} is not available right now. Available: ${list.map((n) => actionSignature(s.actions.get(n))).join(', ') || 'nothing (wait for your move)'}`
    }
    if (s.force && !s.force.actionNames.includes(action) && !/^query|info$/.test(action)) {
      return `failed: ${action} is not one of the moves the game is asking for now (${s.force.actionNames.join(', ')})`
    }
    const r = resolveArgs(a, args, s.seiState)
    if (r.error) return `failed: ${r.error}`
    const sinceSeq = s.force?.seq ?? 0
    let res
    try {
      res = await s.sendAction(action, r.data, { signal })
    } catch (err) {
      if (/aborted/.test(String(err?.message))) return 'aborted'
      return `failed: ${err?.message ?? err}`
    }
    // A refused move leaves the same decision point open (link.js).
    if (!res.success) return `failed: ${res.message || 'the game refused that move'}`
    const f = await nextForce(s, sinceSeq, action === 'end_turn' ? endTurnSettleMs : settleMs)
    const msg = (res.message || 'done').replace(/\s+/g, ' ').trim()
    return f ? msg : `${msg} (no new move for you yet)`
  }

  const registry = createSts2Registry({
    run: (action, args, opts) => {
      // One move at a time, in the order the brain called them.
      const p = chain.then(() => runMove(action, args, opts))
      chain = p.catch(() => {})
      return p
    },
  })

  const view = () => ({ seat: seat(), paused: appPaused, recent })

  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ── Action surface ────────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => (name === 'act' ? SEI_ACT_DESCRIPTION : ''),
    executeAction: async (name, args, ctx = {}) => {
      acting += 1
      batchRun += 1
      stats?.batch?.(batchRun)
      let result
      try {
        result = await registry.execute(name, args, null, { ...config, ...ctx })
      } catch (err) {
        stats?.act(args?.action ?? name, false, err?.issues ? 'needs bad args' : String(err?.message ?? err))
        throw err
      } finally {
        acting -= 1
        // A batch is the plays queued back to back; it ends when nothing is in flight.
        if (acting === 0) setTimeout(() => { if (acting === 0) batchRun = 0 }, 50)
      }
      const ok = !/^(failed|paused|aborted)/.test(result)
      stats?.act(args?.action ?? name, ok, ok ? null : result)
      return result
    },

    // ── Perception + prompt blocks ────────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({ getView: view }),
    getLatestObservation: () => seat()?.seiState ?? null,
    refreshObservation: async () => seat()?.seiState ?? null,
    worldPrimer,
    capabilityParagraph,
    actionRules,
    eventAddendum,
    getProgression: () => null,

    // ── Session lifecycle ─────────────────────────────────────────────
    attach(handlers) {
      if (_attachDispose) { try { _attachDispose() } catch {} }
      _handlers = handlers
      _attachDispose = wireSts2Events(link, handlers, {
        isActing: () => acting > 0,
        isPaused: () => appPaused,
        stats,
        logger,
        nudgeMs,
        onRecent: noteRecent,
      })
    },
    signalSpawned() {
      try { _handlers?.onSpawn?.() } catch (err) { logger.warn?.(`[sei/sts2] onSpawn threw: ${err?.message ?? err}`) }
    },
    detach() {
      if (_attachDispose) { try { _attachDispose() } catch {} _attachDispose = null }
      _handlers = null
    },
    setWorldPaused(next) {
      appPaused = next === true
      for (const s of [link.seat, link.host]) {
        try { s?.send?.('sei/pause', { paused: appPaused }) } catch {}
      }
    },

    // ── Effects ───────────────────────────────────────────────────────
    chat: (text) => {
      const line = String(text ?? '').trim()
      if (!line) return
      stats?.say?.()
      // A speech bubble over her character in both windows (Sei fork; upstream ignores it).
      for (const s of [link.seat, link.host]) {
        try { s?.send?.('sei/say', { text: line.slice(0, 300) }) } catch {}
      }
    },
    closeAnySessions: async () => {},

    // ── Capabilities ──────────────────────────────────────────────────
    supportsAutoEat: false,
    supportsFollow: false,

    // ── Identity ──────────────────────────────────────────────────────
    get botUsername() { return botUsername },
    getKnownPlayers: () => {
      const out = {}
      const add = (name) => { if (name) out[name] = { username: name, uuid: `sts2:${name}` } }
      add(link.host?.hello?.player)
      for (const a of Array.isArray(seat()?.seiState?.allies) ? seat().seiState.allies : []) if (a?.is_player) add(a.name)
      return out
    },
    /** Runtime seam: is a move in flight (tests, wires). */
    isActing: () => acting > 0,
    /** Test seam: the current seat session (force, seiState). */
    currentSeat: () => seat(),

    // ── Contract v2 members ───────────────────────────────────────────
    gameName: 'Slay the Spire 2',
    wikiHosts: ['slaythespire.wiki.gg'],
    // Speech bubble over her character (the mod clips at 300).
    chatMaxChars: 200,
    backgroundActions: {},
    progressActions: [],
    visionActions: [],
    surfaceBaseline: () => STS2_BASELINE,
    sessionEndClause: () => SESSION_END_CLAUSE,
    stuckNudges: () => ({ vision: 'pick a different move from YOUR MOVE', noVision: 'pick a different move from YOUR MOVE' }),
    /** Runs are not worlds: one memory section for every StS2 session, so she remembers past runs. */
    getWorldIdentity: () => ({ fingerprint: 'sts2:runs', label: (config?.world_label && String(config.world_label).trim()) || 'Slay the Spire 2 runs' }),
    createTelemetry: ({ emit, logger: tlog }) =>
      createDashboardTelemetry({
        getState: () => seat()?.seiState ?? null,
        getInfo: () => ({ connected: !!seat(), coop: !!(seat()?.hello?.coop || link.host), yourMove: !!seat()?.force }),
        emit,
        logger: tlog ?? logger,
      }),
    classifyConnectError,
  }
}
