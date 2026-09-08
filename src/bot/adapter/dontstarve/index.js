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
import {
  DST_BASELINE, worldPrimer, CAPABILITY_PARAGRAPH, ACTION_RULES, describeAction,
  eventAddendum, SESSION_END_CLAUSE, STUCK_NUDGES,
} from './prompts.js'

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
      return registry.execute(name, args, null, execConfig)
    },

    // ─── Perception + prompt blocks ───────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({
      state: link.state,
      handles: link.handles,
      dst,
      getBodyState: () => link.body,
    }),
    worldPrimer: () => worldPrimer(dst.survivorBrief),
    capabilityParagraph: () => CAPABILITY_PARAGRAPH,
    actionRules: () => ACTION_RULES,
    eventAddendum,

    // ─── Session lifecycle ────────────────────────────────────────────
    attach(handlers) {
      if (_dispose) { try { _dispose() } catch {} }
      _dispose = wireLinkEvents(link.events, handlers, {
        botName: link.botName,
        companions: () => config._seiCompanions ?? [],
        playerName: config.player_username ?? null,
      })
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
    chatMaxChars: DST_CHAT_MAX_CHARS,
    backgroundActions: { follow: 'unfollow' },
    progressActions: ['gather', 'build'],
    visionActions: [],
    surfaceBaseline: () => DST_BASELINE,
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
