#!/usr/bin/env node
// scripts/test-attackItemRefuse.mjs — D-H-15 regression: attackEntity refuses
// item-class, orb, and global entities before any swing; preserves player and
// mob behavior.

import assert from 'node:assert/strict'
import { attackEntityAction } from '../src/adapter/minecraft/behaviors/attack.js'

function makeBot(target) {
  const calls = []
  const me = { position: { distanceTo: () => 1 } }
  return {
    bot: {
      entity: me,
      entities: { 99: target },
      attack: () => calls.push('attack'),
      swingArm: () => calls.push('swing'),
      lookAt: () => {},
    },
    calls,
  }
}

// T5: dropped item refused
{
  const { bot, calls } = makeBot({ id: 99, type: 'object', name: 'item', position: { distanceTo: () => 1 } })
  const r = await attackEntityAction({ entity_id: 99 }, bot, {})
  assert.equal(r, 'cannot attack item (dropped item entity)', `T5 result: ${r}`)
  assert.equal(calls.length, 0, `T5 no swings expected`)
}

// T6: xp orb refused
{
  const { bot, calls } = makeBot({ id: 99, type: 'orb', name: 'xp_orb', position: { distanceTo: () => 1 } })
  const r = await attackEntityAction({ entity_id: 99 }, bot, {})
  assert.equal(r, 'cannot attack xp orb', `T6 result: ${r}`)
  assert.equal(calls.length, 0, `T6 no swings expected`)
}

// T7: zombie allowed (regression)
{
  const { bot, calls } = makeBot({
    id: 99, type: 'mob', name: 'zombie',
    position: { distanceTo: () => 1, offset: () => ({ x: 0, y: 0, z: 0 }) },
    height: 2,
  })
  await attackEntityAction({ entity_id: 99, times: 1 }, bot, {})
  assert.ok(calls.includes('attack'), `T7 zombie path: bot.attack should be called, calls=${calls.join(',')}`)
}

// T8: player refused (regression)
{
  const { bot, calls } = makeBot({ id: 99, type: 'player', username: 'SSk1tz', position: { distanceTo: () => 1 } })
  const r = await attackEntityAction({ entity_id: 99 }, bot, {})
  assert.equal(r, 'cannot attack player', `T8 result: ${r}`)
  assert.equal(calls.length, 0, `T8 no swings`)
}

console.log('attackItemRefuse: all cases passed')
