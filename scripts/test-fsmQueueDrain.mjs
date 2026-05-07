#!/usr/bin/env node
/**
 * Plan 03.1-10 Task 1 (WR-01): FSM priority-queue drain regression.
 *
 * The bug: when a lower-priority event is re-queued during a higher-priority
 * hold, processNext sets `processing = false` and returns. No further enqueue
 * is scheduled, so the re-queued item sits forever until the next external
 * event arrives. The fix keeps `processing = true` on the re-queue branch and
 * relies on the in-flight action's trailing `setImmediate(processNext)` drain.
 */
import assert from 'node:assert/strict'
import { createPriorityQueue, Priority } from '../src/brain/fsm.js'

function defer(ms) { return new Promise(r => setTimeout(r, ms)) }

const silentLogger = { warn(){}, info(){}, error(){}, debug(){} }

// T1: P0 + P3 — P3 must drain after P0 completes
{
  const order = []
  let p0Resolve
  const p0Done = new Promise(r => { p0Resolve = r })
  const queue = createPriorityQueue({
    onDispatch: async (event) => {
      order.push(`start:${event}`)
      if (event === 'p0') {
        await p0Done
      }
      order.push(`end:${event}`)
    },
    idleFallbackMs: 999_999_999,
    logger: silentLogger,
  })
  queue.enqueue(Priority.P0_SAFETY, 'p0', {})
  await defer(5)
  queue.enqueue(Priority.P3_IDLE, 'p3', {})
  await defer(5)
  p0Resolve()
  await defer(50)
  assert.deepEqual(
    order,
    ['start:p0', 'end:p0', 'start:p3', 'end:p3'],
    `T1 order: ${order.join(',')}`
  )
  queue.dispose()
}

// T2: lone P3 — runs (regression)
{
  const order = []
  const queue = createPriorityQueue({
    onDispatch: async (event) => { order.push(event) },
    idleFallbackMs: 999_999_999,
    logger: silentLogger,
  })
  queue.enqueue(Priority.P3_IDLE, 'p3-only', {})
  await defer(20)
  assert.deepEqual(order, ['p3-only'], `T2 order: ${order.join(',')}`)
  queue.dispose()
}

// T3: two P0 sequentially — both run
{
  const order = []
  const queue = createPriorityQueue({
    onDispatch: async (event) => {
      order.push(`s:${event}`)
      await defer(5)
      order.push(`e:${event}`)
    },
    idleFallbackMs: 999_999_999,
    logger: silentLogger,
  })
  queue.enqueue(Priority.P0_SAFETY, 'a', {})
  queue.enqueue(Priority.P0_SAFETY, 'b', {})
  await defer(50)
  assert.deepEqual(order, ['s:a', 'e:a', 's:b', 'e:b'], `T3 order: ${order.join(',')}`)
  queue.dispose()
}

// T4: P2 holds, P3 enqueued during hold — drains after P2
{
  const order = []
  let p2Resolve
  const p2Done = new Promise(r => { p2Resolve = r })
  const queue = createPriorityQueue({
    onDispatch: async (event) => {
      order.push(`s:${event}`)
      if (event === 'p2') await p2Done
      order.push(`e:${event}`)
    },
    idleFallbackMs: 999_999_999,
    logger: silentLogger,
  })
  queue.enqueue(Priority.P2_MOVEMENT, 'p2', {})
  await defer(5)
  queue.enqueue(Priority.P3_IDLE, 'p3-after-p2', {})
  await defer(5)
  p2Resolve()
  await defer(50)
  assert.deepEqual(
    order,
    ['s:p2', 'e:p2', 's:p3-after-p2', 'e:p3-after-p2'],
    `T4 order: ${order.join(',')}`
  )
  queue.dispose()
}

console.log('fsmQueueDrain: all cases passed')
