// src/adapter/minecraft/index.js
//
// Minecraft Adapter implementation. Returns an object satisfying the contract
// in src/brain/types.js. The brain orchestrator receives one of these at
// construction and drives every game-shaped capability through it — no direct
// mineflayer references in brain code.
//
// See src/brain/types.js for the contract; ADAPTER_INTERFACE_VERSION === 1.

import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js'
import { createDefaultRegistry } from './registry.js'
import { createSnapshotComposer } from './observers/snapshot.js'
import { getProgression as readProgression } from './observers/progression.js'
import { closeContainerSession } from './behaviors/container.js'
import { wireBotEvents } from './fsmWires.js'
import { visualizeAction } from './behaviors/visualize.js'
import {
  WORLD_PRIMER as MINECRAFT_PRIMER,
  ACTION_DESCRIPTIONS,
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
    getActionDescription: (name) => ACTION_DESCRIPTIONS[name] ?? registry.description?.(name) ?? '',
    executeAction: (name, args, ctx = {}) => {
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
      return registry.execute(name, args, bot, execConfig)
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
    worldPrimer,
    capabilityParagraph,
    actionRules,
    cuboidGrammar,
    eventAddendum,
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
    closeAnySessions: async () => {
      try { await closeContainerSession() } catch {}
    },

    // ─── Passive-look render seam ──────────────────────────────────────
    // The orchestrator drives the periodic "look around" (per-turn cadence,
    // vision.interval_turns) through the adapter so the bot reference stays
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
  }
}

// Re-export the primer so callers can compare cached-prefix bytes without
// also importing the primer module.
export { MINECRAFT_PRIMER }
