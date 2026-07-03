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
import { loadPlayer, savePlayer, formatPlayerSeedBlock } from './memory/player.js'
import { Priority, createPriorityQueue, attackedPriority } from './fsm.js'
import { idleCadenceMs } from './prompts.js'

const REQUIRED_ADAPTER_MEMBERS = [
  'listActions', 'getActionSchema', 'getActionDescription', 'executeAction',
  'createSnapshotComposer', 'worldPrimer',
  'attach',
  'chat', 'closeAnySessions',
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
export async function start({ config, adapter, logger = console, onTerminalError = null, onAuthExpired = null, onSeiChatReply = null, onQuitRequested = null }) {
  assertAdapter(adapter)

  // ── Memory layer ────────────────────────────────────────────────────
  const playerStore = { loadPlayer, savePlayer, formatPlayerSeedBlock }

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
  // 260508-nkk follow-up: gates the initial-greeting nudge so it fires once
  // per session (first real spawn), not on every reconnect-respawn cycle.
  let greetingFired = false

  const sessionState = await createSessionState({
    playerMdPath: config.memory.player_md_path,
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
        // 260514-ngj: sei:joined retired — spawn first-fire enqueues
        // sei:idle (P3) instead. Routing left absent on purpose so a
        // stray sei:joined would land at default (P2_MOVEMENT) and surface
        // as the bug it is.
        case 'sei:loop_terminal':  p = Priority.P2_5_LOOP_END; break
        // 260513-wkd: action_complete fires when an in_flight long-running
        // action settles (resolve OR abort). Routed at P2.1 so a same-batch
        // P2_MOVEMENT enqueue dequeues first (sort by priority asc); the new
        // mid-loop iteration runs on the next processNext tick.
        case 'sei:action_complete': p = Priority.P2_ACTION_COMPLETE; break
        // 260516-0yw: action_tick fires while a long-runner is in_flight to
        // give the model a chance to comment / abort. Priority 2.3 sits
        // between action_complete (2.1) and loop_end (2.5) so a same-batch
        // settle drains FIRST and the tick is suppressed naturally.
        case 'sei:action_tick':    p = Priority.P2_ACTION_TICK; break
        case 'sei:loop_end':       p = Priority.P2_5_LOOP_END; break
        case 'sei:idle':           p = Priority.P3_IDLE; break
        default:                   p = Priority.P2_MOVEMENT; break
      }
    }
    // sei:loop_terminal is an internal signal — reset the idle timer and stop.
    // The previous loop_end auto-tick was removed: it doubled brain calls on
    // every input and produced redundant acknowledgement messages. Idle ticks
    // (sei:idle, P3) are now the only non-input wake-up path; the model
    // controls within-loop iteration via tool_use chains.
    if (event === 'sei:loop_terminal') {
      queue.resetIdleTimer()
      return
    }
    queue.enqueue(p, event, data)
  }

  // ── Orchestrator ────────────────────────────────────────────────────
  const orchestrator = createOrchestrator({
    adapter, config, logger,
    sessionState, playerStore,
    reenqueue,
    onTerminalError,
    onAuthExpired,
    // Task 4 — where to send a reply when the turn was triggered by a Sei-chat
    // message (route to chat surface), and how to honor a quit() tool call.
    onSeiChatReply,
    onQuitRequested,
  })

  // ── Build the priority queue with the orchestrator's handleDispatch ─
  queue = createPriorityQueue({
    onDispatch: (event, data, signal) => orchestrator.handleDispatch(event, data, signal),
    // Synchronous preempt hook: lets a player chat / attack abort an in-flight
    // LLM call that is parking the dispatch thread, so the interrupt reaches the
    // model in one round-trip instead of waiting out a slow mid-loop call.
    onPreempt: (event, data) => orchestrator.handlePreempt(event, data),
    // 260615: idle cadence is driven by the proactiveness tier (Passive 10min /
    // Reactive 1min / Agentic 5s), so a self-directed character resumes its
    // goal fast while a passive one only stirs rarely. An explicit
    // llm.idle_fallback_ms in config still wins as a manual override.
    idleFallbackMs: config.llm?.idle_fallback_ms ?? idleCadenceMs(config.persona?.proactiveness),
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
      // normalized events). This runs ALWAYS — even for a suppressed line —
      // so a message aimed at a sibling still lands in this bot's chat history.
      try { orchestrator.recordIncomingChat?.(evt.username, evt.text) } catch {}
      // 260618 (M1): a message aimed only at another companion, or a sibling
      // bot's own chatter, is recorded above but must NOT interrupt this bot.
      // chat.js set the flag; honoring it here keeps the line in history while
      // skipping the wake (the "only goes in chat history" behavior).
      if (evt.suppressInterrupt) return
      // Enqueue with the adapter-compatible payload shape (chat.js produced
      // { username, message, addressed, playerSpoke }; the priority queue's
      // player-chat preemption keys on `data.playerSpoke === true`, so we
      // pass through both `text` and `message` for compatibility).
      queue.enqueue(Priority.P1_CHAT, 'sei:chat_received', {
        username: evt.username,
        message: evt.text,
        text: evt.text,
        addressed: evt.addressed,
        playerSpoke: evt.playerSpoke,
      })
    },
    onAttacked: (evt) => {
      // Tier by attackerKind: a reflex (proactive threat warning — the bot was
      // NOT hit) is conversation-tier (P1_CHAT) so it never preempts/aborts a
      // player-chat reply; a real attack (player/mob) stays safety-tier
      // (P0_SAFETY). The event NAME stays 'sei:attacked' — downstream dispatch
      // and the reflex-vs-attack prompt framing key on attackerKind, not the
      // name. See attackedPriority in ./fsm.js.
      queue.enqueue(attackedPriority(evt), 'sei:attacked', evt)
    },
    onSpawn: () => {
      // D-57: deferred player-presence check after spawn settles.
      sessionState.onSpawn().catch(err =>
        logger.warn?.(`[sei/brain] sessionState.onSpawn failed: ${err.message}`))
      // World awareness: resolve which world this is (stable number + label),
      // segment MEMORY.md, and feed the current world into the snapshot. The
      // spawn point is known by now, so the fingerprint is computable.
      orchestrator.noteSpawn?.().catch(err =>
        logger.warn?.(`[sei/brain] orchestrator.noteSpawn failed: ${err.message}`))
      // Initial-greeting nudge moved here from a top-level setTimeout
      // (260508-nkk follow-up). Was previously fired unconditionally on
      // brain start, even when mineflayer never spawned — so a connect
      // failure + reconnect loop produced one Haiku call per retry, with
      // every loop running on `(snapshot unavailable)` because bot.entity
      // was undefined. Gating on the actual spawn event stops the API burn
      // and ensures the greeting only fires when there's a real world.
      // greetingFired guards against re-firing on respawn-after-death.
      if (greetingFired) return
      greetingFired = true
      setTimeout(() => {
        try {
          // 260514-ngj: spawn first-fire now enqueues sei:idle at P3 rather
          // than sei:joined at P1. The greeting flows through the normal
          // idle-tick path; the R1-R4 interrupt-response model only applies
          // to P0/P1-triggered iterations, and a join is not an interrupt of
          // an existing loop — it's the very first tick. P3 also means the
          // greeting cannot starve a P0 attack or P1 chat that lands a beat
          // later. The 'hint' field is dropped — idle is observational by
          // construction, the seed prompt handles framing.
          queue.enqueue(Priority.P3_IDLE, 'sei:idle', { reason: 'just_connected_first_spawn' })
        } catch (err) {
          logger.warn?.(`[sei/brain] spawn-idle enqueue failed: ${err.message}`)
        }
      }, config.memory?.spawn_settle_delay_ms ?? 500)
    },
  })

  orchestrator.start().catch(err => logger.warn?.(`[sei/brain] orchestrator.start failed: ${err.message}`))
  // ITEM 2 (quick/260523-t8d): system messages emitted by the brain into the
  // LogsBar console are prefixed with [CONSOLE] at the START of the line
  // (before any timestamp prefix the logger adds). Casing is preserved as-is
  // — no upper/lowercase coercion is applied anywhere on the system-message
  // path; the literal "Sei online." capitalization the user typed renders
  // unchanged. The [CONSOLE] tag distinguishes brain-emitted notices from
  // bot-runtime chat / haiku / action tags.
  logger.info?.('[CONSOLE] [sei] Sei online.')

  return {
    // Task 4 — deliver a message that arrived over Sei chat (player is NOT
    // in-game) as a priority chat event on THIS session, framed so the bot knows
    // it's out-of-band and that quit() leaves the game. Its reply routes back to
    // the chat surface via onSeiChatReply (see orchestrator._emitSayLine).
    deliverSeiChat({ from, text } = {}) {
      const raw = String(text ?? '').trim()
      if (!raw) return
      const who = String(from || 'The player')
      const framed =
        `${who} messaged you through Sei chat — they are NOT in the game with you right now. ` +
        `They said: "${raw}". Reply to them in chat. If you would rather stop playing to talk, call quit().`
      try { orchestrator.recordIncomingChat?.(who, raw) } catch {}
      try {
        queue.enqueue(Priority.P1_CHAT, 'sei:chat_received', {
          username: who,
          message: framed,
          text: framed,
          addressed: true,
          playerSpoke: true,
          seiChat: true,
        })
      } catch (err) {
        logger.warn?.(`[sei/brain] deliverSeiChat enqueue failed: ${err.message}`)
      }
    },
    async stop() {
      // Order matters. dispose() FIRST flips the FSM's `disposed` flag (so the
      // sei:action_complete that an action-abort fires is dropped, not
      // re-dispatched) and aborts any in-flight DISPATCH (a parked LLM call).
      try { queue.dispose() } catch {}
      // THEN abort the in-flight long-runner. dispose() can't reach it: when a
      // gather/dig/explore/goTo/follow is running, the loop is suspended on
      // sei:action_complete and the FSM's currentAction is null, so the action
      // lives on currentLoop.inFlight's own controller. Without this, a stop
      // pressed mid-action didn't cancel anything — the action ran to
      // completion and the stop only took effect once bot.quit() dropped the
      // connection (the stop-button lag).
      try { orchestrator.abortActive?.() } catch {}
      try { await adapter.closeAnySessions() } catch {}
    },
    /**
     * Phase 13-15 (PROXY-07): forward a refreshed JWT to the Anthropic SDK
     * for cloud-proxy mode. No-op when cloudMode is absent (BYOK).
     */
    setAuthToken: (token) => { try { orchestrator.setAuthToken?.(token) } catch {} },
    /**
     * 260618: update the roster of OTHER AI companion usernames sharing this
     * world. src/bot/index.js calls this from the {type:'roster'} port message
     * (and once from the init payload). No-op for single-bot sessions.
     */
    setCompanions: (names) => { try { orchestrator.setCompanions?.(names) } catch {} },
    /**
     * WR-05 follow-up: live-swap the AI backend (cloud-proxy ↔ BYOK) on the
     * running orchestrator without re-summoning. No-op when the orchestrator
     * or provider doesn't implement it.
     */
    setBackend: (backend) => { try { orchestrator.setBackend?.(backend) } catch {} },
    /**
     * Phase 15 (D-10/VIS-03): the active provider's vision capability boolean.
     * src/bot/index.js reads this after summon-ready (and after a backend
     * switch) to push `vision-capability` up the port → main → renderer.
     * Fail-closed: false if the orchestrator/provider can't report it.
     */
    visionCapable: () => { try { return orchestrator.visionCapable?.() === true } catch { return false } },
  }
}
