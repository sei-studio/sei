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
import { worldPrimer, MINECRAFT_PRIMER } from './primer.js'
import { setInflightProvider } from './behaviors/follow.js'
import { closeContainerSession } from './behaviors/container.js'
import { wireBotEvents } from './fsmWires.js'

// Free-text tool descriptions surfaced through getActionDescription. These
// were inlined in the orchestrator before; they are inherently
// minecraft-shaped (talk about digging, attacking mobs, etc.) so the adapter
// owns them now.
const ACTION_DESCRIPTIONS = {
  goTo: 'Move the bot to the given (x, y, z) coordinates within `range` blocks.',
  setGoals: 'Add or remove a goal from owner_goals or self_goals.',
  say: 'Speak the given text in in-game chat.',
  follow: 'Continuously trail an entity at follow_range. Pass `player` (username), or `entity` / `entity_id` / `target` for a mob. Does NOT attack — pair with attackEntity if you want hits. The body trails the target on a 1s tick; an attackEntity call can land a swing as soon as the target is within reach. Default-on at spawn for the owner; the snapshot shows `follow_target` so you know who you are trailing.',
  unfollow: 'Stop trailing the current follow target. The body holds position until you issue another movement.',
  attackEntity: 'Swing at an entity. `times` (1–10, default 1) hits the target up to N times in one call with ~600ms between swings; stops early if the target dies, moves out of reach, or you are interrupted. Use a higher `times` when hunting to amortize LLM round-trips — e.g. `times: 5` for sheep/pig, `times: 8` for tougher mobs.',
  // Plan 03.1-05 Task 2 (D-W-3, D-W-6): canonical text lives next to dig.js
  // as DIG_DESCRIPTION; the orchestrator keeps an LLM-facing copy in sync.
  dig: 'Break a block. Prefer `{ block: "<name>" }` to dig the NEAREST EXPOSED block of that name within maxDistance (default 32, max 64) — `maxDistance` is a SEARCH RADIUS for finding the named block, not a reach radius. Actual swing reach is fixed at 4.5m and the bot pathfinds into reach automatically. For repeated digs of the same block type, prefer `{block:"<name>"}` which auto-finds nearest each call. `#N` references (e.g. {target:"#3"}) rotate every snapshot — only valid in the SAME turn the snapshot listed them; switch to `{block:"<name>"}` if you see "stale target". Use `{ x, y, z }` only when you must dig a precise coordinate.',
}

/**
 * Construct a minecraft Adapter wrapped around a live mineflayer Bot.
 *
 * @param {Object} args
 * @param {object} args.bot         Mineflayer Bot instance (from createBotInstance).
 * @param {object} args.config      Validated config; passed through to action handlers.
 * @returns {import('../../brain/types.js').Adapter}
 */
export function createMinecraftAdapter({ bot, config }) {
  if (!bot) throw new Error('createMinecraftAdapter: bot required')
  if (!config) throw new Error('createMinecraftAdapter: config required')

  const registry = createDefaultRegistry()
  let _attachDispose = null

  return {
    // ─── Adapter contract version (stable identity) ───────────────────
    interfaceVersion: ADAPTER_INTERFACE_VERSION,

    // ─── Action surface ───────────────────────────────────────────────
    listActions: () => registry.list(),
    getActionSchema: (name) => registry.schema(name),
    getActionDescription: (name) => ACTION_DESCRIPTIONS[name] ?? registry.description?.(name) ?? '',
    executeAction: (name, args, ctx = {}) => {
      // Action handlers receive (args, bot, config). Brain context (signal,
      // _goalStore) is folded into the config-shaped 4th argument so existing
      // handlers don't need to change.
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

    // ─── World perception ─────────────────────────────────────────────
    createSnapshotComposer: () => createSnapshotComposer({ bot }),
    worldPrimer,

    // ─── Session lifecycle ───────────────────────────────────────────
    attach(handlers) {
      if (_attachDispose) {
        try { _attachDispose() } catch {}
      }
      _attachDispose = wireBotEvents(bot, handlers, { config })
    },

    // Plan 03.1-09 (WR-07): tear down listeners idempotently before the bot
    // reference is discarded on reconnect. Without this, the OLD bot's
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
    chat: (text) => { try { bot.chat(text) } catch {} },
    setInflightProvider,
    closeAnySessions: async () => {
      try { await closeContainerSession() } catch {}
    },

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
