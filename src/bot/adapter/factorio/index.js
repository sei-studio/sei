// src/bot/adapter/factorio/index.js: the Factorio Adapter (the object the
// brain drives; contract in src/bot/brain/types.js). One instance per
// spawned body; the runtime rebuilds it after a reconnect. The body lives in
// the Lua mod (native/factorio-mod/sei-companion); every world action is one
// verb whose result text comes back as the tool result.

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { createFactorioRegistry } from './registry.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { wireFactorioEvents } from './fsmWires.js'
import { createDashboardTelemetry } from './dashboard/telemetry.js'
import { classifyConnectError } from './errors.js'
import { reflexKindOf } from './stats.js'
import {
  FACTORIO_BASELINE,
  SESSION_END_CLAUSE,
  ACTION_STUCK_NUDGE,
  worldPrimer,
  capabilityParagraph,
  actionRules,
  describeAction,
  eventAddendum,
} from './prompts.js'

/** How long without any answer from the game before actions report it paused. */
export const QUIET_PAUSED_MS = 15_000

/**
 * @param {Object} args
 * @param {ReturnType<import('./client.js').createFactorioClient>} args.client
 * @param {string} args.cid           The companion id the mod gave at spawn.
 * @param {object} args.config        Parsed bot config (config.adapter.factorio, config.world_label).
 * @param {string} args.botUsername
 * @param {{ world?: string, seed?: number }|null} [args.hello]  The mod's hello reply.
 * @param {ReturnType<import('./stats.js').createFactorioStats>} [args.stats]
 * @param {object} [args.logger]
 * @returns {import('../../brain/types.js').Adapter}
 */
export function createFactorioAdapter({ client, cid, config, botUsername, hello = null, stats = null, logger = console, now = () => Date.now() }) {
  if (!client) throw new Error('createFactorioAdapter: client required')
  if (!cid) throw new Error('createFactorioAdapter: cid required')
  let latestObs = null
  let _attachDispose = null
  let _handlers = null
  // appPaused: the in-app pause button (brain.setGamePaused -> setWorldPaused).
  // quietPaused: the runtime paused the brain because the game stopped
  // answering (single player pauses in the menu), so no turns are spent on a
  // frozen world. `internal` marks setWorldPaused calls that we caused.
  let appPaused = false
  let quietPaused = false
  let internal = false
  let brainRef = null
  const pauseBrain = (on) => {
    internal = true
    try { brainRef?.setGamePaused?.(on) } catch (err) { logger.warn?.(`[sei/factorio] brain pause threw: ${err?.message ?? err}`) }
    internal = false
  }
  const players = new Map()

  async function refreshObservation({ timeoutMs = 4_000 } = {}) {
    try {
      const r = await client.request({ op: 'observe', cid }, { timeoutMs })
      if (r?.ok && r.obs) latestObs = r.obs
    } catch (err) {
      logger.debug?.(`[sei/factorio] observe failed: ${err?.message ?? err}`)
    }
    return latestObs
  }

  const registry = createFactorioRegistry({
    run: async (verb, args, { signal }) => {
      const r = await client.command(cid, verb, args, { signal })
      // The result reaches the brain with a fresh view of the world.
      await refreshObservation({ timeoutMs: 2_000 })
      return r
    },
  })

  const gameQuiet = () => client.lastReplyAt > 0 && now() - client.lastReplyAt > QUIET_PAUSED_MS
  const companions = () => (Array.isArray(config._seiCompanions) ? config._seiCompanions : [])

  const onFeed = (ev) => {
    const k = reflexKindOf(ev)
    if (k) stats?.reflex(k)
    if (ev?.t === 'player_joined' && ev.name) players.set(String(ev.name), true)
    if (ev?.t === 'player_left' && ev.name) players.delete(String(ev.name))
  }
  client.on('event', onFeed)

  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ── Action surface ────────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => describeAction(name) || registry.description?.(name) || '',
    executeAction: async (name, args, ctx = {}) => {
      if (appPaused) return 'paused: the player paused the game'
      if (gameQuiet()) return 'failed: the game is not answering right now (it may be paused, saving, or in a menu); try again in a moment'
      let result
      try {
        result = await registry.execute(name, args, null, { ...config, ...ctx })
      } catch (err) {
        stats?.verb(name, `failed: ${err?.issues ? 'bad args' : err?.message ?? err}`)
        throw err
      }
      stats?.verb(name, result)
      return result
    },

    // ── Perception + prompt blocks ────────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({ getObs: () => latestObs }),
    getLatestObservation: () => latestObs,
    refreshObservation,
    worldPrimer,
    capabilityParagraph,
    actionRules,
    eventAddendum,
    getProgression: () => null,

    // ── Session lifecycle ─────────────────────────────────────────────
    attach(handlers) {
      if (_attachDispose) { try { _attachDispose() } catch {} }
      _handlers = handlers
      _attachDispose = wireFactorioEvents(client, handlers, { botName: botUsername, companions, logger })
    },
    signalSpawned() {
      try { _handlers?.onSpawn?.() } catch (err) { logger.warn?.(`[sei/factorio] onSpawn threw: ${err?.message ?? err}`) }
      const owner = latestObs?.owner
      if (owner?.name && !owner.missing) {
        try { _handlers?.onPlayerJoined?.({ username: String(owner.name), uuid: `factorio:${owner.name}` }) } catch {}
      }
    },
    detach() {
      if (_attachDispose) {
        try { _attachDispose() } catch {}
        _attachDispose = null
      }
      _handlers = null
      client.off('event', onFeed)
    },
    setWorldPaused(next) {
      if (internal) return
      appPaused = next === true
      client.request({ op: 'pause', cid, paused: appPaused }, { timeoutMs: 5_000 }).catch((err) => {
        logger.warn?.(`[sei/factorio] pause(${appPaused}) failed: ${err?.message ?? err}`)
      })
      // The player resumed in the app while the game itself is still frozen:
      // keep the brain held (after the brain's own unpause has finished).
      if (!appPaused && quietPaused) setTimeout(() => { if (quietPaused && !appPaused) pauseBrain(true) }, 0)
    },
    /** Runtime seam: the brain this adapter feeds (for the quiet-game hold). */
    bindBrain(brain) { brainRef = brain ?? null },
    /** Runtime seam: the game stopped (true) or resumed (false) answering. */
    setGameQuiet(quiet) {
      if (quiet && !quietPaused) {
        quietPaused = true
        if (!appPaused) pauseBrain(true)
      } else if (!quiet && quietPaused) {
        quietPaused = false
        if (!appPaused) pauseBrain(false)
      }
    },
    get gameQuiet() { return quietPaused },

    // ── Effects ───────────────────────────────────────────────────────
    chat: (text) => {
      const line = String(text ?? '').trim()
      if (!line) return
      client.command(cid, 'say', { text: line }).catch((err) => {
        logger.warn?.(`[sei/factorio chat] say failed: ${err?.message ?? err}`)
      })
    },
    closeAnySessions: async () => {},

    // ── Capabilities ──────────────────────────────────────────────────
    supportsAutoEat: false,
    supportsFollow: true,

    // ── Identity ──────────────────────────────────────────────────────
    get botUsername() { return botUsername },
    getKnownPlayers: () => {
      const out = {}
      const add = (name) => { if (name) out[name] = { username: name, uuid: `factorio:${name}` } }
      for (const name of players.keys()) add(name)
      const o = latestObs?.owner
      if (o?.name && !o.missing) add(String(o.name))
      return out
    },

    // ── Contract v2 members ───────────────────────────────────────────
    gameName: 'Factorio',
    wikiHosts: ['wiki.factorio.com'],
    // The chat line and the bubble above her head; the mod clips at 300.
    chatMaxChars: 200,
    backgroundActions: { follow: 'stay' },
    progressActions: [],
    visionActions: [],
    surfaceBaseline: () => FACTORIO_BASELINE,
    sessionEndClause: () => SESSION_END_CLAUSE,
    stuckNudges: () => ({ vision: ACTION_STUCK_NUDGE, noVision: ACTION_STUCK_NUDGE }),
    /** The mod keeps a per-save id in its storage (hello.world). */
    getWorldIdentity: () => {
      const id = hello?.world
      if (!id) return null
      const label = (config?.world_label && String(config.world_label).trim()) || `Factorio map ${hello?.seed ?? id}`
      return { fingerprint: `factorio:${id}`, label }
    },
    createTelemetry: ({ emit, logger: tlog }) =>
      createDashboardTelemetry({ getObs: () => latestObs, emit, logger: tlog ?? logger }),
    classifyConnectError,
  }
}
