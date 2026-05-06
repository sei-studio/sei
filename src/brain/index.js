// src/brain/index.js
//
// Brain entry point. Wires the orchestrator + memory layer + priority queue,
// then attaches the supplied adapter. Game-agnostic — no game-runtime
// import, no src/adapter/ import.
//
// Boot composer (src/index.js) provides:
//   - config (validated by src/config.js)
//   - adapter (an object satisfying src/brain/types.js's Adapter contract,
//     e.g. createMinecraftAdapter({ bot, config }))
//
// brain.start({ config, adapter }) returns { stop() } so the boot composer
// can shut down cleanly on SIGTERM / Electron quit / test teardown.

import { createOrchestrator } from './orchestrator.js'
import { createSessionState } from './sessionState.js'
import { createCompactor } from './compaction.js'
import { createDiary } from './memory/diary.js'
import { loadOwner, saveOwner, formatOwnerSeedBlock } from './memory/owner.js'
import { Priority, createPriorityQueue } from './fsm.js'

const REQUIRED_ADAPTER_MEMBERS = [
  'listActions', 'getActionSchema', 'getActionDescription', 'executeAction',
  'createSnapshotComposer', 'worldPrimer',
  'attach',
  'chat', 'setInflightProvider', 'closeAnySessions',
  // capabilities (booleans / accessors) — checked existence only
  'supportsAutoEat', 'supportsFollow',
  // identity
  'botUsername', 'getKnownPlayers',
]

function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('brain.start: adapter must be an object')
  }
  for (const k of REQUIRED_ADAPTER_MEMBERS) {
    if (!(k in adapter)) {
      throw new Error(`brain.start: adapter missing required member: ${k}`)
    }
  }
}

/**
 * Start the brain.
 *
 * @param {Object} args
 * @param {Object} args.config   Validated config (src/config.js).
 * @param {import('./types.js').Adapter} args.adapter
 * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [args.logger]
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function start({ config, adapter, logger = console }) {
  assertAdapter(adapter)

  // ── Memory layer ────────────────────────────────────────────────────
  const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }
  const diary = createDiary({
    path: config.memory.diary_md_path,
    seedDiaryBudgetBytes: config.memory.seed_diary_budget_bytes,
    logger,
  })

  // sessionState needs a `bot`-shaped object for player presence checks
  // (bot.players + bot.once('playerJoined', ...)). We hand it a thin shim
  // that proxies into the adapter so brain code stays game-agnostic.
  const sessionBotShim = {
    get players() { return adapter.getKnownPlayers() },
    get username() { return adapter.botUsername },
    once(eventName, listener) {
      if (eventName === 'playerJoined') {
        // Wire one-shot via attach handler chain. We re-attach a tiny
        // single-use joined hook on top of whatever brain.start already
        // wired by stashing it on the closure below — see attach call.
        _onceJoinedListeners.push(listener)
      }
    },
  }
  const _onceJoinedListeners = []

  const sessionState = await createSessionState({
    ownerMdPath: config.memory.owner_md_path,
    diary,
    config,
    bot: sessionBotShim,
    logger,
  })

  // ── Priority queue (brain-side FSM) ─────────────────────────────────
  // Defer creating the queue until after the orchestrator exists so the
  // dispatcher can route to handleDispatch.
  let queue = null
  const reenqueue = (event, data, priority = null) => {
    if (!queue) return
    let p = priority
    if (p == null) {
      // Choose default priority by event name (mirrors the old fsm.js
      // bot.on(...) priority assignments).
      switch (event) {
        case 'sei:attacked':       p = Priority.P0_SAFETY; break
        case 'sei:chat_received':  p = Priority.P1_CHAT; break
        case 'sei:joined':         p = Priority.P1_CHAT; break
        case 'sei:loop_terminal':  p = Priority.P2_5_LOOP_END; break
        case 'sei:loop_end':       p = Priority.P2_5_LOOP_END; break
        case 'sei:idle':           p = Priority.P3_IDLE; break
        default:                   p = Priority.P2_MOVEMENT; break
      }
    }
    // sei:loop_terminal is an internal signal — translate into a sei:loop_end
    // tick (unless the just-finished loop was itself triggered by loop_end,
    // matching the old fsm.js suppression rule).
    if (event === 'sei:loop_terminal') {
      queue.resetIdleTimer()
      if (data?.originatingEvent === 'sei:loop_end') return
      queue.enqueue(Priority.P2_5_LOOP_END, 'sei:loop_end', { originatingEvent: data?.originatingEvent ?? null })
      return
    }
    queue.enqueue(p, event, data)
  }

  // ── Orchestrator ────────────────────────────────────────────────────
  const orchestrator = createOrchestrator({
    adapter, config, logger,
    sessionState, ownerStore, diary,
    reenqueue,
  })

  // ── Compactor (Plan 3-03 / Pitfall 4 cache-hit guarantee) ──────────
  const compactor = createCompactor({
    anthropic: orchestrator._internal.anthropic,
    cachedSystemBlocks: orchestrator._internal.cachedSystemBlocks,
    diary,
    config,
    logger,
  })
  sessionState.setCompactor(compactor)

  // ── Build the priority queue with the orchestrator's handleDispatch ─
  queue = createPriorityQueue({
    onDispatch: (event, data, signal) => orchestrator.handleDispatch(event, data, signal),
    idleFallbackMs: config.llm?.idle_fallback_ms ?? 60_000,
    logger,
  })

  // ── Attach adapter handlers ────────────────────────────────────────
  adapter.attach({
    onPlayerJoined: (player) => {
      sessionState.onPlayerJoined(player).catch(err =>
        logger.warn?.(`[sei/brain] sessionState.onPlayerJoined failed: ${err.message}`))
      // Drain any once('playerJoined') listeners installed by sessionState
      // before the adapter wire was ready (Pitfall 2 belt-and-suspenders).
      while (_onceJoinedListeners.length > 0) {
        const l = _onceJoinedListeners.shift()
        try { l(player) } catch {}
      }
    },
    onPlayerLeft: (player) => {
      sessionState.onPlayerLeft(player).catch(err =>
        logger.warn?.(`[sei/brain] sessionState.onPlayerLeft failed: ${err.message}`))
    },
    onChat: (evt) => {
      // Record incoming chat in convoMemory so the next Loop's seed turn
      // carries it (chat.js used to call orchestrator.recordIncomingChat
      // directly; we keep that record path here so the adapter only emits
      // normalized events).
      try { orchestrator.recordIncomingChat?.(evt.username, evt.text) } catch {}
      // Enqueue with the adapter-compatible payload shape (chat.js produced
      // { username, message, addressed, ownerSpoke }; the priority queue's
      // owner-chat preemption keys on `data.ownerSpoke === true`, so we
      // pass through both `text` and `message` for compatibility).
      queue.enqueue(Priority.P1_CHAT, 'sei:chat_received', {
        username: evt.username,
        message: evt.text,
        text: evt.text,
        addressed: evt.addressed,
        ownerSpoke: evt.ownerSpoke,
      })
    },
    onAttacked: (evt) => {
      queue.enqueue(Priority.P0_SAFETY, 'sei:attacked', evt)
    },
    onSpawn: () => {
      // D-57: deferred owner-presence check after spawn settles.
      sessionState.onSpawn().catch(err =>
        logger.warn?.(`[sei/brain] sessionState.onSpawn failed: ${err.message}`))
    },
  })

  // Initial-greeting nudge: same priority as chat so the orchestrator opens
  // a fresh Loop and the bot speaks BEFORE the idle timer fires. We fire
  // this once, after a brief settle, so adapter behaviors finish loading.
  setTimeout(() => {
    try {
      queue.enqueue(Priority.P1_CHAT, 'sei:joined', {
        reason: 'just_connected',
        hint: 'You just connected to the server. Greet your owner if they are nearby; otherwise look around and say something brief about where you are. This is NOT an idle tick — react to the join itself.',
      })
    } catch (err) {
      logger.warn?.(`[sei/brain] join greeting enqueue failed: ${err.message}`)
    }
  }, config.memory?.spawn_settle_delay_ms ?? 500)

  orchestrator.start().catch(err => logger.warn?.(`[sei/brain] orchestrator.start failed: ${err.message}`))
  logger.info?.('[sei] Sei online.')

  return {
    async stop() {
      try { queue.dispose() } catch {}
      try { await adapter.closeAnySessions() } catch {}
    },
  }
}
