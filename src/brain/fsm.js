/**
 * Brain-side priority queue + idle timer (game-agnostic FSM core).
 *
 * Priority constants (D-08):
 *   P0   = safety (attacked, critical health)
 *   P1   = chat received
 *   P2   = movement/action completion
 *   P2.5 = end-of-loop tick (260505-iqo) — fires after every real-activity
 *          loop terminal, prompting the model to decide a follow-up sub-goal
 *          rather than wait for the 60s idle fallback. Above P3 so it
 *          preempts a queued idle; below P2 so chat preempts it.
 *   P3   = idle fallback (60s)
 *
 * The priority queue is the brain's view of the FSM. Adapter-side wires
 * (see src/adapter/<game>/fsmWires.js — the minecraft impl is the
 * reference) translate game-specific events into AdapterHandlers calls,
 * which brain.start() then routes through this queue's enqueue() with
 * the correct priority.
 */

export const Priority = Object.freeze({
  P0_SAFETY: 0,
  P1_CHAT: 1,
  P2_MOVEMENT: 2,
  P2_5_LOOP_END: 2.5,
  P3_IDLE: 3,
})

/**
 * @typedef {{ priority: number, event: string, data: any }} QueuedEvent
 */

/**
 * Create a priority queue with a single-flight dispatcher and an idle timer.
 *
 * @param {Object} opts
 * @param {(event:string, data:any, signal:AbortSignal) => Promise<void>|void} opts.onDispatch
 *   Called for every dequeued event. Awaited; abort signal fires when a
 *   higher-priority event preempts.
 * @param {number} [opts.idleFallbackMs=60000]  Idle timer fires after this many ms
 *   of inactivity, enqueueing a P3 'sei:idle' event.
 * @param {{warn?:Function,info?:Function,error?:Function,debug?:Function}} [opts.logger]
 * @returns {{ enqueue: Function, resetIdleTimer: Function, dispose: Function }}
 */
export function createPriorityQueue({ onDispatch, idleFallbackMs = 60_000, logger = console } = {}) {
  if (typeof onDispatch !== 'function') {
    throw new Error('createPriorityQueue: onDispatch required')
  }

  /** @type {QueuedEvent[]} */
  const queue = []
  /** Currently executing action token */
  let currentAction = null  // { controller: AbortController, priority: number }
  let processing = false
  let idleTimer = null
  let disposed = false

  function resetIdleTimer() {
    clearTimeout(idleTimer)
    if (disposed) return
    idleTimer = setTimeout(() => {
      enqueue(Priority.P3_IDLE, 'sei:idle', {})
    }, idleFallbackMs)
  }

  function enqueue(priority, event, data) {
    if (disposed) return
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
    // 260505-iqo: any event ingestion postpones the idle fallback so the 60s
    // timer counts from the latest activity, not from the last processNext
    // dequeue. Safe to call repeatedly (clearTimeout + setTimeout).
    resetIdleTimer()
    scheduleProcess()
  }

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

    try {
      await onDispatch(item.event, item.data, controller.signal)
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        logger.error?.(`[sei/fsm] Error handling ${item.event}: ${err.message}`)
      }
    } finally {
      if (currentAction?.controller === controller) {
        currentAction = null
      }
    }

    if (queue.length > 0) {
      setImmediate(processNext)
    } else {
      processing = false
    }
  }

  function dispose() {
    disposed = true
    clearTimeout(idleTimer)
    idleTimer = null
    if (currentAction) {
      try { currentAction.controller.abort() } catch {}
      currentAction = null
    }
    queue.length = 0
  }

  // Start idle timer at construction so the bot picks up an idle dispatch
  // even if no events arrive immediately after start.
  resetIdleTimer()

  return { enqueue, resetIdleTimer, dispose }
}
