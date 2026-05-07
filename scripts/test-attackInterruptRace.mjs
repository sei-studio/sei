#!/usr/bin/env node
/**
 * Plan 03.1-10 Task 2: WR-02 (replaceAbortController re-bridges external
 * signal) + WR-04 (attack/interrupt race preservation).
 *
 * WR-02 cases here are tested via loop._setAbortController on a fresh loop;
 * the actual orchestrator-side re-bridging is grep-verified in acceptance
 * criteria. WR-04's full end-to-end flow is grep-verified + live replay;
 * the unit-level proof here is that loop's abortController getter returns
 * the swapped instance after _setAbortController.
 */
import assert from 'node:assert/strict'
import { createLoop } from '../src/brain/loop.js'

// T1: replaceAbortController via loop._setAbortController works
{
  const loop = createLoop({ iterationCap: 5 })
  const original = loop.abortController
  const fresh = new AbortController()
  loop._setAbortController(fresh)
  assert.equal(loop.abortController, fresh, 'T1 abortController getter returns new instance')
  assert.notEqual(loop.abortController, original, 'T1 not the original')
  fresh.abort()
  assert.equal(loop.abortController.signal.aborted, true, 'T1 fresh abort fires')
  assert.equal(original.signal.aborted, false, 'T1 original NOT aborted by fresh')
}

// T2: _setAbortController rejects non-controller arg
{
  const loop = createLoop({ iterationCap: 5 })
  let threw = false
  try { loop._setAbortController({}) } catch { threw = true }
  assert.equal(threw, true, 'T2 rejects non-AbortController arg')
}

// T3: multiple swaps — only the latest is exposed
{
  const loop = createLoop({ iterationCap: 5 })
  const a = new AbortController()
  const b = new AbortController()
  const c = new AbortController()
  loop._setAbortController(a)
  assert.equal(loop.abortController, a, 'T3 a active after first swap')
  loop._setAbortController(b)
  assert.equal(loop.abortController, b, 'T3 b active after second swap')
  loop._setAbortController(c)
  assert.equal(loop.abortController, c, 'T3 c active after third swap')
  // Aborting earlier controllers does not affect the active one
  a.abort()
  b.abort()
  assert.equal(loop.abortController.signal.aborted, false, 'T3 latest unaffected by older aborts')
  c.abort()
  assert.equal(loop.abortController.signal.aborted, true, 'T3 latest aborts when its own controller fires')
}

console.log('attackInterruptRace: WR-02 cases passed (WR-04 verified via grep gates and live replay)')
