// src/bot/adapter/dontstarve/index.js — the Don't Starve Together Adapter
// (game-adapters M2, 260908). Satisfies REQUIRED_ADAPTER_MEMBERS
// (src/bot/brain/index.js) and declares the contract v2 members
// (src/bot/brain/types.js) so the brain stays game-agnostic: the body is a
// mod-spawned survivor reached over the runtime's loopback link
// (runtime.js), never a mineflayer bot.

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { createDefaultRegistry } from './registry.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { wireLinkEvents } from './fsmWires.js'
import { createDashboardTelemetry } from './dashboard/telemetry.js'
import { classifyConnectError } from './errors.js'
import { createAlertWatcher, lightMeans } from './observers/alerts.js'
import { createHabitLog } from './observers/habits.js'
import { createProgressionLatches, getProgression } from './observers/progression.js'
import {
  dstBaseline, worldPrimer, capabilityParagraph, actionRules, describeAction,
  eventAddendum, SESSION_END_CLAUSE, STUCK_NUDGES,
} from './prompts.js'

/** How often the alert watcher re-reads the 3 Hz observation. */
const ALERT_CHECK_MS = 2000

/** Short attacker labels for alert wakes (formatEventData prints them). */
const ALERT_LABELS = { starving: 'hunger', low_health: 'low health', freezing: 'the cold', overheating: 'the heat' }

/** In-game chat/talker line cap (speak.lua clips at 160). */
export const DST_CHAT_MAX_CHARS = 160

/**
 * @param {object} args
 * @param {import('./runtime.js').Link} args.link
 * @param {object} args.config  Parsed bot config (adapter.kind === 'dontstarve').
 */
export function createDontStarveAdapter({ link, config }) {
  if (!link) throw new Error('createDontStarveAdapter: link required')
  if (!config) throw new Error('createDontStarveAdapter: config required')
  const dst = config.adapter?.dontstarve ?? {}
  const registry = createDefaultRegistry({ link })
  // Mod 0.3.0+ (modVersion.js CAPS_MIN_MOD): survival habits, give, richer
  // perception. The adapter is built after the spawn, so the version is known
  // here and in the cached system prefix; an older helper keeps the 0.2
  // prompts, wake routing and verb set.
  const hasCaps = () => link.hasCaps === true
  const habits = createHabitLog(link.events)
  const latches = createProgressionLatches()
  const players = () => {
    const out = {}
    for (const e of link.state.nearby((x) => x.flags.includes('player'))) {
      const name = e.name ?? e.prefab
      out[name] = { username: name, uuid: String(e.guid) }
    }
    return out
  }
  let _dispose = null

  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ─── Action surface ───────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => describeAction(name) || registry.description(name),
    executeAction: async (name, args, ctx = {}) => {
      const execConfig = { ...config, ...ctx }
      const result = await registry.execute(name, args, null, execConfig)
      latches.result(name, result)
      return result
    },

    // ─── Perception + prompt blocks ───────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({
      state: link.state,
      handles: link.handles,
      dst,
      getBodyState: () => link.body,
      getSelfGuid: () => link.guid ?? null,
      getHabits: () => (hasCaps() ? habits.recent() : []),
    }),
    worldPrimer: () => worldPrimer(dst.survivorBrief),
    capabilityParagraph: () => capabilityParagraph(hasCaps()),
    actionRules: () => actionRules(hasCaps()),
    eventAddendum: (event, data) => eventAddendum(event, data, { hasCaps: hasCaps() }),
    /** The DST spine (observers/progression.js) for the heartbeat frontier. */
    getProgression: () => getProgression(link.state, latches),

    // ─── Session lifecycle ────────────────────────────────────────────
    attach(handlers) {
      if (_dispose) { try { _dispose() } catch {} }
      const unwire = wireLinkEvents(link.events, handlers, {
        botName: link.botName,
        companions: () => config._seiCompanions ?? [],
        playerName: config.player_username ?? null,
        hasCaps,
        darkNeedsBrain: () => !lightMeans(link.state).any,
      })
      // Proactive alerts (observers/alerts.js): the situations a good
      // partner notices. Only with the 0.3.0 habits: an older helper still
      // wakes on every reflex, and the alert prose assumes the habits.
      let lastCheck = 0
      const watcher = createAlertWatcher({
        state: link.state,
        onWake: (a) => handlers.onAttacked?.({
          attacker: null,
          attackerLabel: ALERT_LABELS[a.key] ?? 'trouble',
          attackerKind: 'reflex',
          survivalKind: 'alert',
          alert: a.key,
          alertText: a.text,
          count: 1,
        }),
        onNudge: (a) => handlers.onIdleNudge?.({ reason: 'alert', alert: a.key, text: a.text }),
      })
      const onObs = () => {
        if (!hasCaps() || link.paused) return
        const now = Date.now()
        if (now - lastCheck < ALERT_CHECK_MS) return
        lastCheck = now
        try { watcher.check() } catch (err) { console.error?.(`[sei/dst] alert check threw: ${err && err.message}`) }
      }
      const onDeath = () => { watcher.reset(); habits.clear() }
      link.events.on('obs', onObs)
      link.events.on('death', onDeath)
      _dispose = () => {
        unwire()
        link.events.off('obs', onObs)
        link.events.off('death', onDeath)
      }
    },
    detach() {
      if (_dispose) { try { _dispose() } catch {} }
      _dispose = null
    },
    /** 260725 play/pause: freeze the body (the mod holds its BT). */
    setWorldPaused: (paused) => { link.setPaused(paused === true) },

    // ─── Effects ──────────────────────────────────────────────────────
    chat: (text) => { link.say(text) },
    closeAnySessions: async () => {},

    // ─── Capabilities ─────────────────────────────────────────────────
    supportsAutoEat: true,
    supportsFollow: true,

    // ─── Identity ─────────────────────────────────────────────────────
    get botUsername() { return link.botName },
    getKnownPlayers: players,

    // ─── Contract v2 ──────────────────────────────────────────────────
    gameName: "Don't Starve Together",
    wikiHosts: ['dontstarve.wiki.gg'],
    chatMaxChars: DST_CHAT_MAX_CHARS,
    backgroundActions: { follow: 'unfollow' },
    progressActions: ['gather', 'build'],
    visionActions: [],
    surfaceBaseline: () => dstBaseline(hasCaps()),
    sessionEndClause: () => SESSION_END_CLAUSE,
    stuckNudges: () => ({ ...STUCK_NUDGES }),
    getWorldIdentity: () => {
      const session = link.session || dst.session
      if (!session) return null
      const label = (config?.world_label && String(config.world_label).trim()) || dst.label || 'the Constant'
      return { fingerprint: `dst:${session}`, label }
    },
    createTelemetry: ({ emit, logger }) =>
      createDashboardTelemetry({ state: link.state, emit, logger, prefab: dst.prefab }),
    classifyConnectError,
  }
}
