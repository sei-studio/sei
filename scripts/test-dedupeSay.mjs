#!/usr/bin/env node
// Plan 03.1-07 Task 2 — shouldSuppressLoopEndSay() unit tests (D-NEW-DM-1/2/3).
// Suppresses byte-equal-after-normalize say() within sei:loop_end loops where
// the last self line was within `windowMs` (default 2000ms).
import assert from 'node:assert/strict'
import { shouldSuppressLoopEndSay } from '../src/brain/orchestrator.js'

const t0 = 1_000_000

// Test 1: byte-equal within window — suppress
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:loop_end',
    candidateLine: 'plains is solid',
    lastSelf: { at: t0, text: 'plains is solid' },
    now: t0 + 500,
  }),
  true,
  'T1 byte-equal within 2s suppresses',
)

// Test 2: not loop_end — allow
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:chat_received',
    candidateLine: 'plains is solid',
    lastSelf: { at: t0, text: 'plains is solid' },
    now: t0 + 500,
  }),
  false,
  'T2 chat trigger does NOT suppress',
)

// Test 3: stale window — allow
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:loop_end',
    candidateLine: 'plains is solid',
    lastSelf: { at: t0, text: 'plains is solid' },
    now: t0 + 2500,
  }),
  false,
  'T3 stale window allows',
)

// Test 4: normalized differs — allow
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:loop_end',
    candidateLine: 'all 10 wood is down',
    lastSelf: { at: t0, text: 'plains is solid' },
    now: t0 + 500,
  }),
  false,
  'T4 different normalized allows',
)

// Test 5: no prior self line — allow
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:loop_end',
    candidateLine: 'first message',
    lastSelf: null,
    now: t0,
  }),
  false,
  'T5 no prior allows',
)

// Test 6: substring-not-equal — allow (we are NOT fuzzy)
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:loop_end',
    candidateLine: 'all 10 woods down what are we building',
    lastSelf: { at: t0, text: 'all 10 woods down now' },
    now: t0 + 500,
  }),
  false,
  'T6 different tails NOT suppressed',
)

// Bonus: punctuation-only delta still suppresses (normalize strips punct)
assert.equal(
  shouldSuppressLoopEndSay({
    triggerEvent: 'sei:loop_end',
    candidateLine: 'plains, is solid!',
    lastSelf: { at: t0, text: 'plains is solid' },
    now: t0 + 500,
  }),
  true,
  'punct-only delta suppresses',
)

console.log('dedupeSay: all cases passed')
