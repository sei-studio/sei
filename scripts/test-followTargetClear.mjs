#!/usr/bin/env node
// scripts/test-followTargetClear.mjs — D-H-16 regression: after explicit
// unfollow (or stopFollow), the snapshot's follow_target line reads `(none)`.

import assert from 'node:assert/strict'
import {
  setFollowTarget, getFollowTargetLabel, stopFollow,
} from '../src/adapter/minecraft/behaviors/follow.js'

// T1: setFollowTarget(player) → label is the username
setFollowTarget({ kind: 'player', username: 'SSk1tz' })
assert.equal(getFollowTargetLabel(), 'SSk1tz', 'T1 player follow label')

// T2: setFollowTarget(null) → null
setFollowTarget(null)
assert.equal(getFollowTargetLabel(), null, 'T2 explicit null clears label')

// T3: stopFollow() clears _target as defense-in-depth
setFollowTarget({ kind: 'entity', entityId: 42, label: 'sheep-42' })
assert.equal(getFollowTargetLabel(), 'sheep-42', 'T3a sheep label set')
stopFollow()
assert.equal(getFollowTargetLabel(), null, 'T3b stopFollow clears label (D-H-16)')

// T4: unfollow registry handler returns readback string AND clears label
const { createDefaultRegistry } = await import('../src/adapter/minecraft/registry.js')
const reg = createDefaultRegistry()
setFollowTarget({ kind: 'player', username: 'SSk1tz' })
assert.equal(getFollowTargetLabel(), 'SSk1tz', 'T4a pre-unfollow label')
const result = await reg.execute('unfollow', {}, /* bot */ {}, /* config */ {})
assert.equal(result, 'unfollowed (no longer following anyone)', `T4b result: ${result}`)
assert.equal(getFollowTargetLabel(), null, 'T4c post-unfollow label')

console.log('followTargetClear: all cases passed')
