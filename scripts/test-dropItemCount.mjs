#!/usr/bin/env node
// scripts/test-dropItemCount.mjs — NEW-W-A regression: dropItem aggregates
// across multiple inventory slots, returns "only N available" on undercount.

import assert from 'node:assert/strict'
import { dropItemAction } from '../src/adapter/minecraft/behaviors/drop.js'

function makeBot(inventory) {
  const tossCalls = []
  const items = () => inventory
  return {
    bot: {
      inventory: { items },
      toss: (type, metadata, count) => {
        tossCalls.push({ type, metadata, count })
        return Promise.resolve()
      },
    },
    tossCalls,
  }
}

// T1: 10 split across 2 slots, drop 10
{
  const { bot, tossCalls } = makeBot([
    { name: 'oak_log', type: 17, count: 1, metadata: null },
    { name: 'oak_log', type: 17, count: 9, metadata: null },
  ])
  const r = await dropItemAction({ item: 'oak_log', count: 10 }, bot, { drop_timeout_ms: 2000 })
  assert.equal(r, 'dropped 10 oak_log', `T1 result: ${r}`)
  assert.equal(tossCalls.length, 2, `T1 expected 2 toss calls, got ${tossCalls.length}`)
  assert.equal(tossCalls[0].count + tossCalls[1].count, 10, `T1 total tossed`)
}

// T2: single slot of 10
{
  const { bot, tossCalls } = makeBot([{ name: 'oak_log', type: 17, count: 10, metadata: null }])
  const r = await dropItemAction({ item: 'oak_log', count: 10 }, bot, { drop_timeout_ms: 2000 })
  assert.equal(r, 'dropped 10 oak_log', `T2 result: ${r}`)
  assert.equal(tossCalls.length, 1, `T2 single slot one toss`)
  assert.equal(tossCalls[0].count, 10, `T2 toss count`)
}

// T3: 7 available, 10 requested
{
  const { bot } = makeBot([
    { name: 'oak_log', type: 17, count: 4, metadata: null },
    { name: 'oak_log', type: 17, count: 3, metadata: null },
  ])
  const r = await dropItemAction({ item: 'oak_log', count: 10 }, bot, { drop_timeout_ms: 2000 })
  assert.equal(r, 'dropped 7 oak_log (only 7 available)', `T3 result: ${r}`)
}

// T4: no matching item
{
  const { bot } = makeBot([{ name: 'dirt', type: 3, count: 5, metadata: null }])
  const r = await dropItemAction({ item: 'oak_log', count: 1 }, bot, { drop_timeout_ms: 2000 })
  assert.equal(r, 'no oak_log in inventory', `T4 result: ${r}`)
}

console.log('dropItemCount: all cases passed')
