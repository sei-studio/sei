// Plan 03.1-05 Task 4: Progress narration cadence — soft nudge after N
// silent iterations (D-E-9, D-H-11). Pure helper test, no LLM round-trip.
//
// Test path is scripts/test-progressCadence.mjs (not test/progressCadence.test.js
// as the plan literally specified) — `test/` is gitignored at project root
// (.gitignore line 6). scripts/ is the canonical home for ad-hoc executable
// test runners (alongside test-firstTurnSay.mjs, test-affectLog.mjs, etc.).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  _advanceIterationCadence,
  SILENT_ITERATIONS_BEFORE_NUDGE,
} from '../src/brain/orchestrator.js'

function freshLoop() {
  return { iterationsSinceLastSay: 0, _progressNudgeFired: false }
}

test('fresh loop: no nudge', () => {
  const loop = freshLoop()
  const nudge = _advanceIterationCadence({ loop, hadSay: false })
  assert.equal(nudge, false)
  assert.equal(loop.iterationsSinceLastSay, 1)
})

test('3 silent iterations: no nudge yet', () => {
  const loop = freshLoop()
  for (let i = 0; i < 3; i++) {
    const nudge = _advanceIterationCadence({ loop, hadSay: false })
    assert.equal(nudge, false, `iter ${i + 1} should not nudge`)
  }
  assert.equal(loop.iterationsSinceLastSay, 3)
})

test('4 silent iterations: nudge fires once', () => {
  const loop = freshLoop()
  let nudges = 0
  for (let i = 0; i < SILENT_ITERATIONS_BEFORE_NUDGE; i++) {
    if (_advanceIterationCadence({ loop, hadSay: false })) nudges += 1
  }
  assert.equal(nudges, 1, 'exactly one nudge in 4 iterations')
  assert.equal(loop._progressNudgeFired, true)
  // Subsequent silent iterations should NOT nudge again until a say() resets.
  for (let i = 0; i < 5; i++) {
    assert.equal(_advanceIterationCadence({ loop, hadSay: false }), false)
  }
})

test('reset on say(): no nudge, counter zeroes', () => {
  const loop = freshLoop()
  for (let i = 0; i < 3; i++) _advanceIterationCadence({ loop, hadSay: false })
  const nudge = _advanceIterationCadence({ loop, hadSay: true })
  assert.equal(nudge, false, 'say() never nudges')
  assert.equal(loop.iterationsSinceLastSay, 0)
  assert.equal(loop._progressNudgeFired, false)
})

test('4 silents AFTER a reset: nudge fires again', () => {
  const loop = freshLoop()
  // first silent run
  for (let i = 0; i < SILENT_ITERATIONS_BEFORE_NUDGE; i++) {
    _advanceIterationCadence({ loop, hadSay: false })
  }
  assert.equal(loop._progressNudgeFired, true)
  // reset
  _advanceIterationCadence({ loop, hadSay: true })
  assert.equal(loop._progressNudgeFired, false)
  // second silent run
  let nudges = 0
  for (let i = 0; i < SILENT_ITERATIONS_BEFORE_NUDGE; i++) {
    if (_advanceIterationCadence({ loop, hadSay: false })) nudges += 1
  }
  assert.equal(nudges, 1, 'one nudge fires in the second silent run too')
})
