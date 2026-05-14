#!/usr/bin/env node
// scripts/test-nearbyVeins.mjs — unit test for surveyBlocks (was nearbyVeins).
//
// Covers:
//   A) Mixed block names in radius -> one entry per unique name, totaled,
//      anchored at nearest member
//   B) NaN origin -> empty result, no throw
//   C) maxNames cap + `more` counter
//   D) Air variants excluded from output

import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { surveyBlocks } from '../src/bot/adapter/minecraft/observers/veins.js'

const SEE_THROUGH = new Set(['air', 'cave_air', 'void_air'])

function makeBot({ blocks, originPos = { x: 0, y: 64, z: 0 } }) {
  const air = { name: 'air', boundingBox: 'empty' }
  function blockAt(p) {
    const k = `${p.x},${p.y},${p.z}`
    const name = blocks.get(k)
    if (!name) return air
    return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: 'block', diggable: true }
  }
  function findBlocks({ matching, maxDistance, count, point }) {
    const origin = point ?? originPos
    const hits = []
    for (const [k, name] of blocks.entries()) {
      if (SEE_THROUGH.has(name)) continue
      const [x, y, z] = k.split(',').map(Number)
      const block = { name, _id: 0 }
      const ok = typeof matching === 'function' ? matching(block) : false
      if (!ok) continue
      const dx = x - origin.x, dy = y - origin.y, dz = z - origin.z
      const d = Math.hypot(dx, dy, dz)
      if (d > maxDistance) continue
      hits.push({ v: new Vec3(x, y, z), d })
    }
    hits.sort((a, b) => a.d - b.d)
    return hits.slice(0, count).map(h => h.v)
  }
  return {
    version: 'not-a-real-version',
    entity: { position: originPos },
    blockAt,
    findBlocks,
  }
}

let fails = 0
function pass(name) { console.log(`[test-surveyBlocks] PASS ${name}`) }
function fail(name, err) { fails++; console.error(`[test-surveyBlocks] FAIL ${name}: ${err?.message ?? err}`) }

// --- Test A: 3 oak_logs + 1 cactus + 2 sand -> 3 unique names, correct totals
try {
  const blocks = new Map()
  blocks.set('2,64,0', 'oak_log')
  blocks.set('3,64,0', 'oak_log')
  blocks.set('4,64,0', 'oak_log')
  blocks.set('6,64,0', 'cactus')
  blocks.set('1,64,2', 'sand')
  blocks.set('1,64,3', 'sand')

  const bot = makeBot({ blocks })
  const r = surveyBlocks(bot, { radius: 16 })

  assert.equal(r.groups.length, 3, `expected 3 unique names, got ${r.groups.length}`)
  const byName = Object.fromEntries(r.groups.map(g => [g.name, g]))
  assert.equal(byName.oak_log.total, 3)
  assert.equal(byName.cactus.total, 1)
  assert.equal(byName.sand.total, 2)
  // oak_log nearest is at x=2 (closest of 2,3,4)
  assert.deepEqual(byName.oak_log.nearest, { x: 2, y: 64, z: 0 })
  // cactus only at x=6
  assert.deepEqual(byName.cactus.nearest, { x: 6, y: 64, z: 0 })
  pass('A (per-name aggregation, nearest-anchor)')
} catch (e) { fail('A', e) }

// --- Test B: NaN origin -> empty result, no throw
try {
  const bot = makeBot({
    blocks: new Map([['1,64,1', 'oak_log']]),
    originPos: { x: NaN, y: NaN, z: NaN },
  })
  const r = surveyBlocks(bot, { radius: 16 })
  assert.deepEqual(r, { groups: [], more: 0 })
  pass('B (NaN origin guard)')
} catch (e) { fail('B', e) }

// --- Test C: maxNames=2 with 4 unique names at varying distances
try {
  const blocks = new Map()
  blocks.set('2,64,0', 'oak_log')   // d ~2
  blocks.set('5,64,0', 'sand')      // d ~5
  blocks.set('8,64,0', 'cactus')    // d ~8
  blocks.set('11,64,0', 'stone')    // d ~11

  const bot = makeBot({ blocks })
  const r = surveyBlocks(bot, { radius: 16, maxNames: 2 })

  assert.equal(r.groups.length, 2)
  assert.equal(r.more, 2)
  // Closest two: oak_log then sand
  assert.equal(r.groups[0].name, 'oak_log')
  assert.equal(r.groups[1].name, 'sand')
  pass('C (maxNames cap + more counter)')
} catch (e) { fail('C', e) }

// --- Test D: air variants excluded
try {
  const blocks = new Map()
  blocks.set('1,64,0', 'air')
  blocks.set('2,64,0', 'cave_air')
  blocks.set('3,64,0', 'void_air')
  blocks.set('4,64,0', 'cactus')

  const bot = makeBot({ blocks })
  const r = surveyBlocks(bot, { radius: 16 })

  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].name, 'cactus')
  pass('D (air variants excluded)')
} catch (e) { fail('D', e) }

if (fails > 0) {
  console.error(`[test-surveyBlocks] ${fails} FAILED`)
  process.exit(1)
}
console.log('[test-surveyBlocks] all tests passed')
process.exit(0)
