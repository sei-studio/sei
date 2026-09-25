// src/bot/adapter/stardew/index.js — the Stardew Valley Adapter (the object
// the brain drives; contract in src/bot/brain/types.js, v2 members declared
// at the bottom). One instance per WebSocket connection; the runtime rebuilds
// it on reconnect. The body lives in the SMAPI mod; every world action is a
// `cmd` frame whose `detail` string comes back as the tool result.

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { COMMAND_TIMEOUT_MS } from './client.js'
import { createStardewRegistry } from './registry.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { wireStardewEvents } from './fsmWires.js'
import { createDashboardTelemetry } from './dashboard/telemetry.js'
import { createProgressionFlags, getProgression } from './observers/progression.js'
import { classifyConnectError } from './errors.js'
import {
  STARDEW_BASELINE,
  SESSION_END_CLAUSE,
  ACTION_STUCK_NUDGE,
  worldPrimer,
  capabilityParagraph,
  actionRules,
  describeAction,
  eventAddendum,
} from './prompts.js'

/**
 * @param {Object} args
 * @param {ReturnType<import('./client.js').createStardewClient>} args.client
 * @param {object} args.config       Parsed bot config (config.adapter.stardew, config.world_label).
 * @param {string} args.botUsername  The companion's in-game name.
 * @param {object} [args.logger]
 * @returns {import('../../brain/types.js').Adapter}
 */
export function createStardewAdapter({ client, config, botUsername, logger = console }) {
  if (!client) throw new Error('createStardewAdapter: client required')
  if (!config) throw new Error('createStardewAdapter: config required')

  /** The newest observation pushed by the mod (or fetched on demand). */
  let latestObs = null
  /** Save summary from the welcome / save frames (world identity). */
  let save = client.welcome?.hello?.save ?? null
  let _attachDispose = null
  let _handlers = null
  let paused = false

  // 260910: the progression frontier's one-way latches (visited town, deepest
  // mine level, cleared / foraged / harvested / fished / bought), fed by
  // every observation and every verb result.
  const latches = createProgressionFlags()
  const onObs = (f) => { if (f?.obs) { latestObs = f.obs; latches.observe(f.obs) } }
  const onSave = (f) => { if (f) save = { ...f } }
  const onWelcome = (f) => { if (f?.hello?.save) save = f.hello.save }
  client.on('obs', onObs)
  client.on('save', onSave)
  client.on('welcome', onWelcome)

  const registry = createStardewRegistry({
    send: async (name, args, { signal } = {}) => {
      let result
      try {
        result = await client.request({ t: 'cmd', name, args }, { timeoutMs: COMMAND_TIMEOUT_MS, signal })
      } catch (err) {
        if (signal?.aborted || /aborted/.test(String(err?.message))) return 'aborted'
        return `failed: ${err?.message ?? err}`
      }
      const detail = String(result?.detail ?? (result?.ok ? 'done' : 'failed'))
      const text = result?.ok ? detail : `failed: ${detail}`
      latches.result(name, args, text)
      // Refresh the observation before the result reaches the brain: the 2 Hz
      // push lags a warp by up to half a second, so the turn after a door
      // used to read the OLD map's coordinates and walk to them on the new
      // one (measured 260910: house tile 9,9 re-issued on the farm).
      try {
        const r = await client.request({ t: 'observe' }, { timeoutMs: 3_000 })
        if (r?.ok && r.obs) { latestObs = r.obs; latches.observe(r.obs) }
      } catch { /* the next push covers it */ }
      return text
    },
  })

  const companions = () => (Array.isArray(config._seiCompanions) ? config._seiCompanions : [])
  /**
   * The connected mod's version, from the welcome frame's hello. Prompt and
   * snapshot wording that only holds for a newer mod gates on it
   * (modVersion.js): the bundled mod DLL is rebuilt on a Mac, so the app can
   * ship ahead of the mod it talks to.
   */
  const modVersion = () => client.welcome?.hello?.version ?? null

  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ── Action surface ────────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => describeAction(name) || registry.description?.(name) || '',
    executeAction: async (name, args, ctx = {}) => {
      if (paused) return 'paused: the player paused the game'
      const execConfig = { ...config, ...ctx }
      return registry.execute(name, args, null, execConfig)
    },

    // ── Perception + prompt blocks ────────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({ getObs: () => latestObs, getModVersion: modVersion }),
    /** The newest observation (tests + telemetry). */
    getLatestObservation: () => latestObs,
    /** Ask the mod for a fresh observation now (the first turn after spawn). */
    refreshObservation: async () => {
      try {
        const r = await client.request({ t: 'observe' }, { timeoutMs: 5_000 })
        if (r?.ok && r.obs) latestObs = r.obs
      } catch (err) {
        logger.warn?.(`[sei/stardew] observe failed: ${err?.message ?? err}`)
      }
      return latestObs
    },
    worldPrimer,
    capabilityParagraph,
    actionRules: () => actionRules(modVersion()),
    eventAddendum,
    /**
     * The first-fortnight frontier (observers/progression.js) for the
     * heartbeat's "reachable next" list. The brain's `flags` argument is the
     * Minecraft dimension latches; Stardew keeps its own in `latches`.
     */
    getProgression: () => getProgression(latestObs, latches),

    // ── Session lifecycle ─────────────────────────────────────────────
    attach(handlers) {
      if (_attachDispose) { try { _attachDispose() } catch {} }
      _handlers = handlers
      _attachDispose = wireStardewEvents(client, handlers, { botName: botUsername, companions, logger })
    },
    /**
     * The runtime awaits the spawn result BEFORE the brain exists, so the
     * mod's `spawned` push is gone by the time the handlers are attached;
     * the runtime calls this once the brain is wired to run the onSpawn path.
     */
    signalSpawned() {
      try { _handlers?.onSpawn?.() } catch (err) { logger.warn?.(`[sei/stardew] onSpawn threw: ${err?.message ?? err}`) }
    },
    detach() {
      if (_attachDispose) {
        try { _attachDispose() } catch {}
        _attachDispose = null
      }
      _handlers = null
      client.off('obs', onObs)
      client.off('save', onSave)
      client.off('welcome', onWelcome)
    },
    /** 260725 play/pause: freeze the body (reflexes off, controller dropped). */
    setWorldPaused(next) {
      paused = next === true
      client.request({ t: 'pause', paused }, { timeoutMs: 5_000 }).catch((err) => {
        logger.warn?.(`[sei/stardew] pause(${paused}) failed: ${err?.message ?? err}`)
      })
    },

    // ── Effects ───────────────────────────────────────────────────────
    chat: (text) => {
      const line = String(text ?? '').trim()
      if (!line) return
      // Never let a model line start a chat command in the game's chat box.
      if (/^\s*\//.test(line)) {
        logger.warn?.(`[sei/stardew chat] dropped leading-slash line: ${line.slice(0, 80)}`)
        return
      }
      client.request({ t: 'say', text: line }, { timeoutMs: 5_000 }).catch((err) => {
        logger.warn?.(`[sei/stardew chat] say failed: ${err?.message ?? err}`)
      })
    },
    closeAnySessions: async () => {},

    // ── Capabilities ──────────────────────────────────────────────────
    supportsAutoEat: true,
    supportsFollow: true,

    // ── Identity ──────────────────────────────────────────────────────
    get botUsername() { return botUsername },
    getKnownPlayers: () => {
      const out = {}
      const obs = latestObs
      const add = (name, id) => {
        if (!name) return
        out[name] = { username: name, uuid: id ? `stardew:${id}` : `stardew:${name}` }
      }
      for (const e of Array.isArray(obs?.entities) ? obs.entities : []) {
        if (e.kind === 'player') add(e.name, e.farmerId)
      }
      if (obs?.player) add(obs.player.name, obs.player.farmerId)
      return out
    },

    // ── Contract v2 members ───────────────────────────────────────────
    gameName: 'Stardew Valley',
    wikiHosts: ['stardewvalleywiki.com'],
    // The in-game chat box wraps long lines but the bubble above the head
    // does not; keep say() lines short.
    chatMaxChars: 200,
    backgroundActions: { follow: 'unfollow' },
    progressActions: ['gather', 'water', 'harvest', 'chop', 'mine', 'goTo', 'fish'],
    visionActions: [],
    surfaceBaseline: () => STARDEW_BASELINE,
    sessionEndClause: () => SESSION_END_CLAUSE,
    stuckNudges: () => ({ vision: ACTION_STUCK_NUDGE, noVision: ACTION_STUCK_NUDGE }),
    /**
     * World identity for memory segmentation: the save's unique id is stable
     * for the life of the farm; the label is main's world_label (the farm
     * name from the watcher) or the farm name the mod reported.
     */
    getWorldIdentity: () => {
      const id = save?.uniqueId ?? latestObs?.saveId ?? null
      if (!id) return null
      const label = (config?.world_label && String(config.world_label).trim())
        || (save?.farmName ? `${save.farmName} Farm` : `farm ${id}`)
      return { fingerprint: `stardew:${id}`, label }
    },
    createTelemetry: ({ emit, logger: tlog }) =>
      createDashboardTelemetry({ getObs: () => latestObs, emit, logger: tlog ?? logger }),
    classifyConnectError,
  }
}
