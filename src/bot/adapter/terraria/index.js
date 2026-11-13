// src/bot/adapter/terraria/index.js — the Terraria Adapter (the object the
// brain drives; contract in src/bot/brain/types.js). One instance per
// WebSocket connection; the runtime rebuilds it on reconnect. The body lives
// in the tModLoader mod; every world action is a `cmd` frame whose `detail`
// comes back as the tool result.

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { commandTimeouts, nextId } from './client.js'
import { createTerrariaRegistry } from './registry.js'
import { createSnapshotComposer, parseBagEntry } from './observers/snapshot.js'
import { wireTerrariaEvents } from './fsmWires.js'
import { createDashboardTelemetry } from './dashboard/telemetry.js'
import { classifyConnectError } from './errors.js'
import {
  TERRARIA_BASELINE,
  SESSION_END_CLAUSE,
  ACTION_STUCK_NUDGE,
  worldPrimer,
  capabilityParagraph,
  actionRules,
  describeAction,
  eventAddendum,
} from './prompts.js'

/** "mined 3/5" / "chopped 1/2" progress lines as the in-flight {dug,total} shape. */
export function progressFromText(text) {
  const m = /^(?:mined|chopped)\s+(\d+)\/(\d+)/.exec(String(text ?? ''))
  return m ? { dug: Number(m[1]), total: Number(m[2]) } : null
}

/** give's ok line: "gave Wood x12 to Ouen". */
const GAVE_RE = /^gave (.+?)(?: x(\d+))? to (.+)$/

/**
 * @param {Object} args
 * @param {ReturnType<import('./client.js').createTerrariaClient>} args.client
 * @param {object} args.config       Parsed bot config (config.adapter.terraria, config.world_label).
 * @param {string} args.botUsername  The companion's in-game name.
 * @param {object} [args.logger]
 * @param {ReturnType<import('./stats.js').createTerrariaStats>} [args.stats]  session counters (shape only)
 * @returns {import('../../brain/types.js').Adapter}
 */
export function createTerrariaAdapter({ client, config, botUsername, logger = console, stats = null }) {
  if (!client) throw new Error('createTerrariaAdapter: client required')
  if (!config) throw new Error('createTerrariaAdapter: config required')

  let latestObs = null
  let world = client.welcome?.hello?.world ?? null
  let _attachDispose = null
  let _handlers = null
  let paused = false

  const onObs = (f) => { if (f?.obs) latestObs = f.obs }
  const onWelcome = (f) => { if (f?.hello?.world) world = f.hello.world }
  client.on('obs', onObs)
  client.on('welcome', onWelcome)

  const registry = createTerrariaRegistry({
    send: async (name, args, { signal, onProgress } = {}) => {
      const id = nextId()
      const onFrame = (f) => {
        if (f?.id !== id || typeof onProgress !== 'function') return
        const p = progressFromText(f.text)
        if (p) { try { onProgress(p) } catch {} }
      }
      client.on('progress', onFrame)
      let result
      try {
        result = await client.request({ id, t: 'cmd', name, args }, { ...commandTimeouts(name, args), signal })
      } catch (err) {
        if (signal?.aborted || /aborted/.test(String(err?.message))) return 'aborted'
        return `failed: ${err?.message ?? err}`
      } finally {
        client.off('progress', onFrame)
      }
      const detail = String(result?.detail ?? (result?.ok ? 'done' : 'failed'))
      // Refresh before the result reaches the brain, so the next turn reads
      // the body where the job left it, not up to a second behind.
      try {
        const r = await client.request({ t: 'observe' }, { timeoutMs: 3_000 })
        if (r?.ok && r.obs) latestObs = r.obs
      } catch { /* the next push covers it */ }
      return result?.ok ? detail : `failed: ${detail}`
    },
  })

  const companions = () => (Array.isArray(config._seiCompanions) ? config._seiCompanions : [])

  const bagCounts = () => {
    const m = new Map()
    for (const s of Array.isArray(latestObs?.bag) ? latestObs.bag : []) {
      const e = parseBagEntry(s)
      if (e) m.set(e[0].toLowerCase(), (m.get(e[0].toLowerCase()) ?? 0) + e[1])
    }
    return m
  }

  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ── Action surface ────────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => describeAction(name) || registry.description?.(name) || '',
    executeAction: async (name, args, ctx = {}) => {
      if (paused) return 'paused: the player paused the game'
      let result
      try {
        result = await registry.execute(name, args, null, { ...config, ...ctx })
        return result
      } finally {
        // Only registered names: a tool name the model made up is model text.
        try { if (registry.schema(name)) stats?.verb(name, result ?? 'failed: error') } catch {}
      }
    },

    // ── Perception + prompt blocks ────────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({ getObs: () => latestObs }),
    getLatestObservation: () => latestObs,
    refreshObservation: async () => {
      try {
        const r = await client.request({ t: 'observe' }, { timeoutMs: 5_000 })
        if (r?.ok && r.obs) latestObs = r.obs
      } catch (err) {
        logger.warn?.(`[sei/terraria] observe failed: ${err?.message ?? err}`)
      }
      return latestObs
    },
    worldPrimer,
    capabilityParagraph,
    actionRules,
    eventAddendum,

    // ── Session lifecycle ─────────────────────────────────────────────
    attach(handlers) {
      if (_attachDispose) { try { _attachDispose() } catch {} }
      _handlers = handlers
      _attachDispose = wireTerrariaEvents(client, handlers, { botName: botUsername, companions, logger, stats })
    },
    /** The spawn result is awaited before the brain exists; the runtime raises onSpawn once it is wired. */
    signalSpawned() {
      try { _handlers?.onSpawn?.() } catch (err) { logger.warn?.(`[sei/terraria] onSpawn threw: ${err?.message ?? err}`) }
    },
    detach() {
      if (_attachDispose) {
        try { _attachDispose() } catch {}
        _attachDispose = null
      }
      _handlers = null
      client.off('obs', onObs)
      client.off('welcome', onWelcome)
    },
    setWorldPaused(next) {
      paused = next === true
      client.request({ t: 'pause', paused }, { timeoutMs: 5_000 }).catch((err) => {
        logger.warn?.(`[sei/terraria] pause(${paused}) failed: ${err?.message ?? err}`)
      })
    },

    // ── Effects ───────────────────────────────────────────────────────
    chat: (text) => {
      const line = String(text ?? '').trim()
      if (!line) return
      // Never let a model line run a chat command.
      if (/^\s*\//.test(line)) {
        logger.warn?.(`[sei/terraria chat] dropped leading-slash line: ${line.slice(0, 80)}`)
        return
      }
      client.request({ t: 'say', text: line }, { timeoutMs: 5_000 }).catch((err) => {
        logger.warn?.(`[sei/terraria chat] say failed: ${err?.message ?? err}`)
      })
    },
    closeAnySessions: async () => {},

    // ── Capabilities ──────────────────────────────────────────────────
    // The heal reflex runs in the mod; there is no hunger.
    supportsAutoEat: false,
    supportsFollow: true,

    // ── Identity ──────────────────────────────────────────────────────
    get botUsername() { return botUsername },
    getKnownPlayers: () => {
      const out = {}
      for (const p of Array.isArray(latestObs?.players) ? latestObs.players : []) {
        if (p?.name) out[p.name] = { username: p.name, uuid: `terraria:${p.name}` }
      }
      return out
    },

    // ── Contract v2 members ───────────────────────────────────────────
    gameName: 'Terraria',
    wikiHosts: ['terraria.wiki.gg'],
    // The chat line wraps on screen; keep say() lines short.
    chatMaxChars: 200,
    backgroundActions: { follow: 'unfollow' },
    progressActions: ['mine', 'chop'],
    visionActions: [],
    fightActions: ['attack'],
    surfaceBaseline: () => TERRARIA_BASELINE,
    sessionEndClause: () => SESSION_END_CLAUSE,
    stuckNudges: () => ({ vision: ACTION_STUCK_NUDGE, noVision: ACTION_STUCK_NUDGE }),
    handOverResult: (name, text) => (name === 'give' ? GAVE_RE.test(String(text ?? '')) : null),
    handOverDetail: (name, text) => {
      if (name !== 'give') return null
      const m = GAVE_RE.exec(String(text ?? ''))
      return m ? { item: m[1], n: m[2] ? Number(m[2]) : 1, to: m[3] || null } : null
    },
    workItems: (name, args) => {
      if (name === 'craft' || name === 'take') return typeof args?.item === 'string' ? [args.item] : []
      if (name === 'chop') return ['Wood']
      if (name === 'mine') return typeof args?.block === 'string' && args.block.toLowerCase() !== 'ore' ? [args.block] : []
      return []
    },
    carriedCounts: (names) => {
      const m = bagCounts()
      const out = {}
      for (const n of Array.isArray(names) ? names : []) out[n] = m.get(String(n).toLowerCase()) ?? 0
      return out
    },
    /** The world's unique id is stable for the life of the world file. */
    getWorldIdentity: () => {
      const id = world?.uniqueId ?? null
      if (!id) return null
      const label = (config?.world_label && String(config.world_label).trim()) || world?.name || `world ${id}`
      return { fingerprint: `terraria:${id}`, label }
    },
    createTelemetry: ({ emit, logger: tlog }) =>
      createDashboardTelemetry({ getObs: () => latestObs, emit, logger: tlog ?? logger }),
    classifyConnectError,
  }
}
