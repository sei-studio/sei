/**
 * Brain-side priority queue + idle timer (game-agnostic FSM core).
 *
 * Priority constants (D-08):
 *   P0   = safety (attacked, critical health)
 *   P1   = chat received
 *   P2   = movement/action completion
 *   P2.1 = action_complete (260513-wkd) — fired by the orchestrator when an
 *          in_flight long-running action (gather/dig/build/attack/goTo)
 *          settles. Distinct numeric tier above P2_MOVEMENT so a same-batch
 *          P2_MOVEMENT enqueue runs FIRST (e.g. a P2 movement event arrives
 *          alongside an action_complete: movement gets dequeued first by
 *          priority asc). Below P2_5_LOOP_END so action_complete cannot
 *          preempt a loop-end tick that was already in flight. Same-tier
 *          FIFO is no longer required for action_complete ordering — the
 *          numeric separation makes it explicit.
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
  // 260513-wkd: action_complete sits between P2_MOVEMENT and P2_5_LOOP_END.
  // Routed via index.js reenqueue switch (event: 'sei:action_complete').
  P2_ACTION_COMPLETE: 2.1,
  // 260516-0yw: action_tick fires every 10s while a long-runner is in_flight
  // so the model can comment or abort. LOCKED at 2.3 (NOT 2.4, NOT 2.5).
  // Sits strictly between P2_ACTION_COMPLETE (2.1) and P2_5_LOOP_END (2.5):
  //   - same-batch action_complete (2.1) drains BEFORE a queued action_tick
  //     (so a tick is naturally suppressed when the action just settled).
  //   - a queued loop_end (2.5) terminal still wins over a queued tick.
  //   - P1 chat (1) and P0 attack (0) preempt by construction.
  // NOTE: CONTEXT.md prose says "P2.5" for the tick, but that slot is already
  // P2_5_LOOP_END. The CONTEXT wording is a known bug; 2.3 is the locked value.
  P2_ACTION_TICK: 2.3,
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
 * @param {(event:string, data:any) => boolean} [opts.onPreempt]
 *   Synchronous hook called at ENQUEUE time for high-priority external events
 *   (player chat / attack) so the dispatcher can abort an in-flight LLM call
 *   that is currently parking the single dispatch thread. Without this, a chat
 *   that arrives while a mid-loop LLM call (e.g. an action_tick) is awaiting
 *   sits in the queue until that call returns — a slow call (30s+) reads as the
 *   bot ignoring the player. Returns true if the orchestrator fully CLAIMED the
 *   event (folded it into the running loop); then enqueue() skips queuing to
 *   avoid double-handling.
 * @param {number} [opts.idleFallbackMs=60000]  Idle timer fires after this many ms
 *   of inactivity, enqueueing a P3 'sei:idle' event.
 * @param {{warn?:Function,info?:Function,error?:Function,debug?:Function}} [opts.logger]
 * @returns {{ enqueue: Function, resetIdleTimer: Function, dispose: Function }}
 */
export function createPriorityQueue({ onDispatch, onPreempt = null, idleFallbackMs = 60_000, logger = console } = {}) {
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
    // Dedupe idempotent ticks. sei:loop_end and sei:idle are "settle" prompts
    // — only the next one matters. Without this guard, multiple back-to-back
    // higher-priority loops (joined → chat → ...) each leave a loop_end in
    // the queue and the bot drains them sequentially, emitting a redundant
    // "settle" say() per drain. The cross-loop suppression at index.js:114
    // only blocks ADDING loop_ends from a loop_end-triggered loop's terminal,
    // not accumulation in the queue itself.
    if ((event === 'sei:loop_end' || event === 'sei:idle') &&
        queue.some(q => q.event === event)) {
      return
    }
    // Player chat preempts in-flight non-P0 work. Without this, a chat-driven
    // dispatch (already P1) cannot be aborted by a fresh player chat (also P1)
    // — they queue equally and the in-flight movement keeps running until it
    // finishes, ignoring the new instruction. Promoting player chat to P0
    // *only when there is a non-P0 action in flight* makes processNext fire
    // the abort path so action handlers see signal.aborted and bail with
    // 'aborted', clearing inflight for the new chat dispatch.
    if (
      event === 'sei:chat_received' &&
      data?.playerSpoke === true &&
      currentAction &&
      currentAction.priority > Priority.P0_SAFETY
    ) {
      priority = Priority.P0_SAFETY
    }
    // Unblock the dispatch thread synchronously. If a mid-loop LLM call is
    // parked inside onDispatch (e.g. an action_tick awaiting Haiku), promoting
    // this chat to P0 above is not enough — processNext is suspended and won't
    // run the abort path until that call returns. Give the orchestrator a
    // chance to abort the in-flight LLM call right now. If it CLAIMS the event
    // (folds the player message into the running loop), skip enqueuing so the
    // later dispatch doesn't double-handle it (and doesn't cancel the action).
    if (
      onPreempt &&
      ((event === 'sei:chat_received' && data?.playerSpoke === true) || event === 'sei:attacked')
    ) {
      let claimed = false
      try { claimed = !!onPreempt(event, data) } catch (err) {
        logger.warn?.(`[sei/fsm] onPreempt threw: ${err && err.message}`)
      }
      if (claimed) return
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
      // Re-queue and KEEP processing=true so the
      // in-flight action's trailing drain (`if (queue.length > 0)
      // setImmediate(processNext)` below) re-schedules processNext after
      // the holder completes. Previously this set `processing = false`
      // and the queue stalled until the next external enqueue arrived,
      // because enqueue() / scheduleProcess() rely on `processing` to
      // gate work. The re-queue branch is reachable under any future
      // scheduling change that lets processNext run concurrently with
      // an in-flight action (e.g. a re-entrant dispatch path); leaving
      // it correct now closes the latent stall.
      queue.unshift(item)
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
