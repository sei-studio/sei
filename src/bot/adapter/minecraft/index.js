// src/adapter/minecraft/index.js
//
// Minecraft Adapter implementation. Returns an object satisfying the contract
// in src/brain/types.js. The brain orchestrator receives one of these at
// construction and drives every game-shaped capability through it — no direct
// mineflayer references in brain code.
//
// See src/brain/types.js for the contract; ADAPTER_INTERFACE_VERSION === 2
// (game-adapters M0, 260908: the v2 members declared at the bottom carry the
// exact values the brain used to hardcode, so the prompt is byte-identical).

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { MINECRAFT_BASELINE, SESSION_END_CLAUSE, ACTION_STUCK_NUDGE_VISION, ACTION_STUCK_NUDGE_NOVISION } from '../../brain/promptLibrary.js'
import { prefilterToolBatch, postProcessToolBatch } from './toolBatch.js'
import { classifyConnectError } from './errors.js'
import { createDashboardTelemetry } from './dashboard/telemetry.js'
import { createDefaultRegistry } from './registry.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { getProgression as readProgression } from './observers/progression.js'
import { setWorldPaused } from './behaviors/pause.js'
import { closeContainerSession } from './behaviors/container.js'
import { closeFurnaceSession } from './behaviors/furnace.js'
import { wireBotEvents } from './fsmWires.js'
import { visualizeAction } from './behaviors/visualize.js'
import {
  WORLD_PRIMER as MINECRAFT_PRIMER,
  describeAction,
  worldPrimer,
  capabilityParagraph,
  actionRules,
  cuboidGrammar,
  eventAddendum,
  cantReachNudge,
} from './prompts.js'

/**
 * Construct a minecraft Adapter wrapped around a live mineflayer Bot.
 *
 * @param {Object} args
 * @param {object} args.bot           Mineflayer Bot instance (from createBotInstance).
 * @param {object} args.config        Validated config; passed through to action handlers.
 * @param {boolean} [args.visionEnabled=false]  D-10 gate — register the `look`
 *   action only when the active provider is VLM-capable (capabilities.vision).
 *   The construction site (src/bot/index.js) does not hold the provider handle,
 *   so it defaults false here; the orchestrator's tool-list filter (combinedToolsFor)
 *   is the authoritative belt-and-suspenders gate (VIS-03).
 * @returns {import('../../brain/types.js').Adapter}
 */
export function createMinecraftAdapter({ bot, config, visionEnabled = false }) {
  if (!bot) throw new Error('createMinecraftAdapter: bot required')
  if (!config) throw new Error('createMinecraftAdapter: config required')

  const registry = createDefaultRegistry({ visionEnabled })
  let _attachDispose = null

  return {
    // ─── Adapter contract version (stable identity) ───────────────────
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ─── Action surface ───────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => describeAction(name, config?.vision?.mode) ?? registry.description?.(name) ?? '',
    executeAction: async (name, args, ctx = {}) => {
      // Action handlers receive (args, bot, config). Brain context (signal)
      // is folded into the config-shaped 4th argument so existing handlers
      // don't need to change.
      const execConfig = { ...config, ...ctx }
      // The path-finder behavior reads pathfinder_timeout_ms from config; we
      // unify the shape so adapter-side fields (under config.adapter.minecraft)
      // surface back at the top level for backwards-compatible handler code.
      const mc = config.adapter?.minecraft
      if (mc) {
        if (execConfig.pathfinder_timeout_ms == null) execConfig.pathfinder_timeout_ms = mc.pathfinder_timeout_ms
        if (execConfig.follow_range == null) execConfig.follow_range = mc.follow_range
      }
      // 260709: while a world action executes, the head belongs to the action
      // (faceBlock + mineflayer's own dig/place looks), not to the cosmetic
      // owner-gaze — gaze.js checks this counter and stands down, otherwise
      // its 4 Hz lookAt(player) yanks the head back mid-dig and the bot
      // punches trees while staring at the player. A counter (not a flag)
      // because a preempting dispatch can overlap the tail of an aborting one.
      // follow's persistent trailing runs OUTSIDE execute (background tick),
      // so follow keeps its gaze pitch-tracking.
      bot._seiActionActive = (bot._seiActionActive ?? 0) + 1
      try {
        return await registry.execute(name, args, bot, execConfig)
      } finally {
        bot._seiActionActive = Math.max(0, (bot._seiActionActive ?? 1) - 1)
      }
    },

    // ─── World perception + prompt blocks ──────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({ bot }),
    /**
     * World-identity signals for the per-character world registry (worlds.js).
     * The world spawn point is deterministic from the seed and stable across
     * sessions, so it fingerprints the world; dimension disambiguates. Returns
     * floored coords or null when spawn isn't known yet (called post-spawn).
     */
    getWorldInfo: () => {
      const sp = bot.spawnPoint
      return {
        spawnPoint:
          sp && Number.isFinite(sp.x)
            ? { x: Math.floor(sp.x), y: Math.floor(sp.y), z: Math.floor(sp.z) }
            : null,
        dimension: bot.game?.dimension ?? null,
      }
    },
    /**
     * Minimal vanilla progression view (observers/progression.js). The brain
     * passes its caller-owned latched flags (entered_nether/entered_end/
     * killed_dragon); inventory, pickaxe tier and current dimension are read
     * live off the bot. Used to surface the reachable-next frontier into the
     * heartbeat and to detect milestone completion in JS (no LLM). Defensive:
     * never throws (degrades to an empty frontier).
     */
    getProgression: (flags = {}) => readProgression(bot, flags),
    /**
     * Contract v2 world identity (memory/worlds.js). The world spawn point is
     * deterministic from the seed and stable across sessions, so it
     * fingerprints the world; dimension disambiguates. The label is main's
     * world_label (the LAN MOTD) when it shipped one, else the spawn x,z.
     * null until spawn lands. Same assembly the brain's noteSpawn did pre-v2.
     */
    getWorldIdentity: () => {
      const sp = bot.spawnPoint
      if (!sp || !Number.isFinite(sp.x)) return null
      const x = Math.floor(sp.x), y = Math.floor(sp.y), z = Math.floor(sp.z)
      const dim = bot.game?.dimension || 'overworld'
      const label = (config?.world_label && String(config.world_label).trim()) || `spawn ${x},${z}`
      return { fingerprint: `${dim}@${x},${y},${z}`, label }
    },
    worldPrimer,
    capabilityParagraph: () => capabilityParagraph(config?.vision?.mode),
    actionRules: () => actionRules(config?.vision?.mode),
    cuboidGrammar,
    eventAddendum: (event, data) => eventAddendum(event, data, config?.vision?.mode),
    cantReachNudge,

    // ─── Session lifecycle ───────────────────────────────────────────
    attach(handlers) {
      if (_attachDispose) {
        try { _attachDispose() } catch {}
      }
      _attachDispose = wireBotEvents(bot, handlers, { config })
    },

    // Tear down listeners idempotently before the bot reference is discarded
    // on reconnect. Without this, the OLD bot's
    // listeners only become GC-eligible when the closure releases, leaving
    // a window where the adapter still has dangling listeners on a dead
    // mineflayer instance. Idempotent so the boot composer can call it
    // without state checks (no-op when nothing is attached).
    detach() {
      if (_attachDispose) {
        try { _attachDispose() } catch {}
        _attachDispose = null
      }
    },

    // ─── Effects ─────────────────────────────────────────────────────
    // SECURITY (260525-s09 H4): drop any chat string whose first non-whitespace
    // char is `/`. Rationale: the single-layer Haiku LLM could be tricked by
    // a player prompt-injection into emitting `/op MyName`. Forwarding that
    // verbatim to bot.chat causes the Minecraft server to execute it as an
    // operator command. We DROP (not strip-and-send, not escape) so that the
    // injection is fully neutralised — a stripped slash command would still
    // leak the attacker's intended payload as visible chat noise.
    chat: (text) => {
      if (typeof text === 'string' && /^\s*\//.test(text)) {
        try { console.warn('[adapter.chat] dropped leading-slash message (H4 guard):', text.slice(0, 80)) } catch {}
        return
      }
      try {
        bot.chat(text)
      } catch (err) {
        // Previously swallowed silently — a failed bot.chat (called after the
        // socket dropped, or a mineflayer chat-format error) left the user
        // staring at a silent companion with no signal why. Surface it.
        try { console.warn(`[adapter.chat] bot.chat failed: ${err && err.message}`) } catch {}
      }
    },
    /**
     * 260725 play/pause. OPTIONAL adapter member (not in
     * REQUIRED_ADAPTER_MEMBERS): the brain calls it, if present, from
     * brain.setGamePaused. Holding the FSM queue only stops LLM-driven work —
     * this freezes the BODY (follow trailing, reflex evasion, combat
     * retaliation, survival, gaze, auto-eat), so a paused companion stands
     * still like a player away from their keyboard. See behaviors/pause.js.
     */
    setWorldPaused: (paused) => setWorldPaused(bot, paused),
    closeAnySessions: async () => {
      try { await closeContainerSession() } catch {}
      try { await closeFurnaceSession() } catch {}
    },

    // ─── Automatic-view render seam ('continuous' Looking mode) ─────────
    // The orchestrator drives the periodic "look around" (a fixed per-turn
    // cadence) through the adapter so the bot reference stays
    // adapter-side (the brain↔adapter seam: the orchestrator never imports
    // mineflayer or src/adapter/). renderIdleFrame produces the deduped frame
    // via the SAME visualizeAction the explicit path uses, with idle:true so
    // D-02 pose-dedupe applies. Cadence renders use the STANDARD LLM path —
    // there is NO /vision routing here (D-09).
    renderIdleFrame: () => visualizeAction({ idle: true }, bot, config),

    // ─── Capabilities (read from registry / plugin presence) ─────────
    get supportsAutoEat() { return Boolean(bot.autoEat) },
    get supportsFollow() { return registry.list().includes('follow') },

    // ─── Identity ─────────────────────────────────────────────────────
    get botUsername() { return bot.username },
    getKnownPlayers: () => bot.players ?? {},

    // ─── Contract v2 members (src/bot/brain/types.js) ──────────────────
    // Each value is exactly what the brain hardcoded before M0; declaring
    // them here (rather than relying on brain/adapterDefaults.js) is what
    // lets a second game's adapter differ without the brain knowing.
    gameName: 'Minecraft',
    // Minecraft's chat packet caps a message at 256 characters (a vanilla
    // server kicks on more); the count is UTF-16 code units.
    chatMaxChars: 256,
    // follow only mutates the follow target; the trailing happens on a 1s
    // background tick (behaviors/follow.js), so a follow-only turn ends the
    // loop and the tool that stops it is unfollow.
    backgroundActions: { follow: 'unfollow' },
    // build, gather, and a cuboid dig (with a `to` corner) report progress.
    progressActions: (name, args) => name === 'build' || name === 'gather' || (name === 'dig' && !!args?.to),
    visionActions: ['look'],
    prefilterToolBatch,
    postProcessToolBatch: (toolUses, results, loopState) =>
      postProcessToolBatch(toolUses, results, loopState, cantReachNudge),
    surfaceBaseline: () => MINECRAFT_BASELINE,
    sessionEndClause: () => SESSION_END_CLAUSE,
    stuckNudges: () => ({ vision: ACTION_STUCK_NUDGE_VISION, noVision: ACTION_STUCK_NUDGE_NOVISION }),
    createTelemetry: ({ emit, logger }) =>
      createDashboardTelemetry({ bot, emit: (snapshot) => emit({ game: 'minecraft', ...snapshot }), logger }),
    classifyConnectError,
  }
}

// Re-export the primer so callers can compare cached-prefix bytes without
// also importing the primer module.
export { MINECRAFT_PRIMER }
