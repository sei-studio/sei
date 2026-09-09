// src/bot/brain/adapterDefaults.js — contract v2 member defaults (M0, 260908).
//
// Every OPTIONAL v2 member of the Adapter contract (see ./types.js) resolves
// through resolveAdapterCaps(): the adapter's own declaration when present,
// else the value the brain used to hardcode. The defaults are the MINECRAFT
// values on purpose — a v1 adapter, or a test fake that declares none of
// them, keeps the exact pre-v2 behavior, which is what makes the refactor a
// no-op for Minecraft (pinned by systemBlocks.minecraft.test.js) while a new
// game's adapter declares only what differs.
//
// Do NOT add game logic here. A default that needs the game's runtime (the
// dashboard telemetry) has no default: absent means "no dashboard".

import { MINECRAFT_BASELINE, SESSION_END_CLAUSE, ACTION_STUCK_NUDGE_VISION, ACTION_STUCK_NUDGE_NOVISION } from './promptLibrary.js'

/** The pre-v2 brain's hardcoded values, kept together so a reader can see
 *  every Minecraft name that used to live in orchestrator.js. */
export const ADAPTER_DEFAULTS = Object.freeze({
  gameName: 'Minecraft',
  // Minecraft's chat packet caps a message at 256 characters (a vanilla server
  // kicks on more) and the count is UTF-16 code units, so the clip is too.
  chatMaxChars: 256,
  // follow/unfollow only mutate the follow target; the actual trailing happens
  // on a 1s background tick (behaviors/follow.js). Treating them as movement
  // keeps the iteration loop alive and the LLM hot-spams follow() each turn,
  // starving the tick. So a follow-only turn is terminal, and the tool that
  // stops a running follow is unfollow (end_loop does not).
  backgroundActions: Object.freeze({ follow: 'unfollow' }),
  // The progress-flavored detection: build, gather, and a cuboid dig (with a
  // `to` corner). Same onProgress channel for all three.
  progressActions: (name, args) => name === 'build'
    || name === 'gather'
    || (name === 'dig' && !!(args && args.to)),
  visionActions: Object.freeze(['look']),
  // 260910: the game wikis every search() also asks directly, whether or not
  // the query names the game (src/bot/web/webTools.js GAME_WIKIS hosts).
  wikiHosts: Object.freeze(['minecraft.wiki']),
  prefilterToolBatch: () => [],
  postProcessToolBatch: () => ({ nudge: null }),
  surfaceBaseline: () => MINECRAFT_BASELINE,
  sessionEndClause: () => SESSION_END_CLAUSE,
  // The mid-action check-in's "path is not working" instruction. With Looking
  // off there is no look() tool, so the hint must not name it.
  stuckNudges: () => ({ vision: ACTION_STUCK_NUDGE_VISION, noVision: ACTION_STUCK_NUDGE_NOVISION }),
  // A dropped live session and an exhausted initial-connect retry both arrive
  // tagged "LAN_NOT_OPEN:"; an unsupported world version is
  // "UNSUPPORTED_MC_VERSION:"; a Forge/NeoForge world that turns a vanilla
  // client away is "MODDED_HOST_REJECTED:"; a silent spawn stall (connect.js's
  // wall-clock guard) is a BOT_START_TIMEOUT.
  classifyConnectError: (message) => {
    const m = String(message ?? '')
    return m.startsWith('UNSUPPORTED_MC_VERSION')
      ? 'UNSUPPORTED_MC_VERSION'
      : m.startsWith('MODDED_HOST_REJECTED')
        ? 'MODDED_HOST_REJECTED'
        : m.startsWith('LAN_NOT_OPEN')
          ? 'LAN_NOT_OPEN'
          : 'BOT_START_TIMEOUT'
  },
})

/**
 * Resolve the v2 members for an adapter: declared value, else default.
 * Functions are bound to the adapter so a declaration written as a method
 * (`surfaceBaseline() { ... }`) can read `this`.
 *
 * `getWorldIdentity` has a default that needs the adapter + config, so it is
 * resolved here rather than in ADAPTER_DEFAULTS: the pre-v2 brain assembled
 * `${dimension}@${x},${y},${z}` from getWorldInfo() and labeled the world with
 * config.world_label (was lan_motd) or `spawn x,z`.
 *
 * @param {import('./types.js').Adapter} adapter
 * @param {object} config
 */
export function resolveAdapterCaps(adapter, config) {
  const pick = (name) => {
    const own = adapter?.[name]
    if (own === undefined || own === null) return ADAPTER_DEFAULTS[name]
    return typeof own === 'function' ? own.bind(adapter) : own
  }
  const progress = pick('progressActions')
  const isProgressAction = typeof progress === 'function'
    ? progress
    : (name) => Array.isArray(progress) && progress.includes(name)
  const getWorldIdentity = typeof adapter?.getWorldIdentity === 'function'
    ? adapter.getWorldIdentity.bind(adapter)
    : () => {
        let info = null
        try { info = adapter.getWorldInfo?.() } catch { /* adapter may not implement it */ }
        const sp = info?.spawnPoint
        if (!sp) return null
        const dim = info.dimension || 'overworld'
        const fingerprint = `${dim}@${sp.x},${sp.y},${sp.z}`
        const label = (config?.world_label && String(config.world_label).trim()) || `spawn ${sp.x},${sp.z}`
        return { fingerprint, label }
      }
  return {
    gameName: String(pick('gameName')),
    chatMaxChars: Number(pick('chatMaxChars')) || ADAPTER_DEFAULTS.chatMaxChars,
    backgroundActions: { ...pick('backgroundActions') },
    isProgressAction,
    visionActions: new Set(pick('visionActions')),
    prefilterToolBatch: pick('prefilterToolBatch'),
    postProcessToolBatch: pick('postProcessToolBatch'),
    surfaceBaseline: pick('surfaceBaseline'),
    sessionEndClause: pick('sessionEndClause'),
    stuckNudges: pick('stuckNudges'),
    getWorldIdentity,
    classifyConnectError: pick('classifyConnectError'),
  }
}
