/**
 * Event-sourced FSM with priority queue.
 *
 * Priority constants (D-08):
 *   P0 = safety (attacked, critical health)
 *   P1 = chat received
 *   P2 = movement/action completion
 *   P3 = idle fallback
 *
 * Phase 2 will inject LLM handlers by replacing the scripted
 * response functions. The 'sei:dispatch' event is the hook point.
 */

export const Priority = Object.freeze({
  P0_SAFETY: 0,
  P1_CHAT: 1,
  P2_MOVEMENT: 2,
  P3_IDLE: 3,
})

/**
 * @typedef {{ priority: number, event: string, data: any }} QueuedEvent
 */

/**
 * Create and attach the FSM to a bot instance.
 * @param {object} bot - mineflayer bot
 * @param {object} config - validated config
 * @param {object} registry - action registry (createDefaultRegistry())
 */
export function createFSM(bot, config, registry) {
  /** @type {QueuedEvent[]} */
  const queue = []

  /** Currently executing action token */
  let currentAction = null  // { controller: AbortController, priority: number }

  let processing = false

  // ─── Idle fallback timer ──────────────────────────────────────────────────
  let idleTimer = null

  function resetIdleTimer() {
    clearTimeout(idleTimer)
    const idleMs = config?.llm?.idle_fallback_ms ?? 60_000
    idleTimer = setTimeout(() => {
      enqueue(Priority.P3_IDLE, 'sei:idle', {})
    }, idleMs)
  }

  // ─── Event ingestion ─────────────────────────────────────────────────────

  function enqueue(priority, event, data) {
    // Owner chat preempts in-flight non-P0 work. Without this, a chat-driven
    // dispatch (already P1) cannot be aborted by a fresh owner chat (also P1)
    // — they queue equally and the in-flight movement keeps running until it
    // finishes, ignoring the new instruction. Promoting owner chat to P0
    // *only when there is a non-P0 action in flight* makes processNext fire
    // the abort path so action handlers see signal.aborted and bail with
    // 'aborted', clearing inflight for the new chat dispatch.
    if (
      event === 'sei:chat_received' &&
      data?.ownerSpoke === true &&
      currentAction &&
      currentAction.priority > Priority.P0_SAFETY
    ) {
      priority = Priority.P0_SAFETY
    }
    queue.push({ priority, event, data })
    // Sort by priority ascending (lower number = higher priority)
    queue.sort((a, b) => a.priority - b.priority)
    scheduleProcess()
  }

  // ─── Processing loop ─────────────────────────────────────────────────────

  function scheduleProcess() {
    if (!processing) {
      processing = true
      setImmediate(processNext)
    }
  }

  async function processNext() {
    const item = queue.shift()
    if (!item) {
      processing = false
      return
    }

    // Cancel current action if incoming has higher priority (lower number)
    if (currentAction && item.priority < currentAction.priority) {
      currentAction.controller.abort()
      currentAction = null
    }

    // Skip lower-priority events while a higher-priority action runs
    if (currentAction && item.priority > currentAction.priority) {
      // Re-queue for after current action completes
      queue.unshift(item)
      processing = false
      return
    }

    const controller = new AbortController()
    currentAction = { controller, priority: item.priority }

    resetIdleTimer()

    try {
      await handleEvent(item.event, item.data, controller.signal)
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(`[sei/fsm] Error handling ${item.event}:`, err.message)
      }
    } finally {
      if (currentAction?.controller === controller) {
        currentAction = null
      }
    }

    // Continue processing queue
    if (queue.length > 0) {
      setImmediate(processNext)
    } else {
      processing = false
    }
  }

  // ─── Event handlers ──────────────────────────────────────────────────────

  async function handleEvent(event, data, signal) {
    // Emit sei:dispatch FIRST — Phase 2 LLM orchestrator will listen here
    bot.emit('sei:dispatch', { event, data, signal })

    switch (event) {
      case 'sei:attacked': {
        // P0: self-defense — combat behavior already attacked back; FSM tracks it
        console.log(`[sei/fsm] P0 safety: attacked by ${data.attacker?.username ?? 'entity'}`)
        break
      }

      case 'sei:chat_received': {
        // Phase 2: handled by orchestrator via sei:dispatch above
        break
      }

      case 'sei:idle': {
        // Phase 2: handled by orchestrator via sei:dispatch above
        break
      }

      default:
        break
    }
  }

  // ─── Wire bot events into FSM ─────────────────────────────────────────────

  bot.on('sei:attacked', (data) => enqueue(Priority.P0_SAFETY, 'sei:attacked', data))
  bot.on('sei:chat_received', (data) => enqueue(Priority.P1_CHAT, 'sei:chat_received', data))
  // Initial-greeting on join. Same priority as chat so the orchestrator opens
  // a fresh Loop and the bot speaks BEFORE the idle timer fires. The idle
  // timer is reset by processNext so the next sei:idle is idle_fallback_ms
  // *after* the join greeting completes.
  bot.on('sei:joined', (data) => enqueue(Priority.P1_CHAT, 'sei:joined', data))

  // Start idle timer
  resetIdleTimer()

  return {
    enqueue,
    /** Expose registry for Phase 2 LLM dispatch */
    registry,
  }
}
