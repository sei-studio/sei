#!/usr/bin/env node
// scripts/test-mineVein.mjs — D-NEW-SCAV-3 unit test for gatherAction.
//
// Tests use the `_deps` dependency-injection hook on gatherAction to stub
// goTo + digAction, plus a thin Bot shim providing entity.position, blockAt,
// and findBlocks. mcDataLib is forced into the function-form fallback path
// by passing an obviously-invalid bot.version.
//
// Coverage:
//   A) Single oak_log, {name:'wood'}        -> 'mined 1/1 oak_log'
//   B) 5-block oak_log row, {x,y,z} anchor  -> 'mined 5/5 oak_log', closest-first order
//   C) Signal pre-aborted                   -> 'aborted', zero goTo/digAction calls
//   D) Abort signal fires after 2 digs      -> 'aborted after 2/5 oak_log'
//   E) {name:'wood'} no matches             -> 'no wood in loaded chunks'
//   F) {x,y,z} pointing at air              -> 'no block at anchor'
//   G) 5x5x5 stone cube (125 blocks)        -> 'mined K/64 stone (vein-cap reached)', K<=64

import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { gatherAction } from '../src/bot/adapter/minecraft/behaviors/mineVein.js'
// (file kept at mineVein.js to minimize import-path churn; export is gatherAction)

function makeBot({ blocks, originPos = { x: 0, y: 64, z: 0 }, version = 'not-a-real-version' }) {
  function blockAt(p) {
    const k = `${p.x},${p.y},${p.z}`
    const name = blocks.get(k)
    if (!name) return { name: 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty' }
    return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: 'block', diggable: true }
  }
  function findBlocks({ matching, maxDistance, count, point }) {
    const origin = point ?? originPos
    const hits = []
    for (const [k, name] of blocks.entries()) {
      const [x, y, z] = k.split(',').map(Number)
      const block = { name, _id: 0 }
      const ok = typeof matching === 'function' ? matching(block) : false
      if (!ok) continue
      const d = Math.hypot(x - origin.x, y - origin.y, z - origin.z)
      if (d > maxDistance) continue
      hits.push({ v: new Vec3(x, y, z), d })
    }
    hits.sort((a, b) => a.d - b.d)
    return hits.slice(0, count).map(h => h.v)
  }
  return { version, entity: { position: originPos }, blockAt, findBlocks }
}

function makeDeps({ digResponses, abortAfter = null, controller = null } = {}) {
  const goToCalls = []
  const digCalls = []
  const goToStub = async (bot, x, y, z, range, timeoutMs) => {
    goToCalls.push({ x, y, z, range, timeoutMs })
    return 'reached'
  }
  const digActionStub = async (args, bot, config) => {
    digCalls.push({ ...args })
    if (config?.signal?.aborted) return 'aborted'
    // Drive the abort controller after the Nth dig if requested.
    if (controller && abortAfter != null && digCalls.length === abortAfter) {
      controller.abort()
    }
    if (typeof digResponses === 'function') return digResponses(args, digCalls.length)
    return `dug oak_log @${args.x},${args.y},${args.z}`
  }
  return { goTo: goToStub, digAction: digActionStub, goToCalls, digCalls }
}

let fails = 0
function pass(name) { console.log(`[test-mineVein] PASS ${name}`) }
function fail(name, err) {
  fails++
  console.error(`[test-mineVein] FAIL ${name}: ${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
}

// --- Test A: single oak_log + {name:'wood'} -> 'mined 1/1 oak_log'
try {
  const blocks = new Map([[`5,64,0`, 'oak_log']])
  const bot = makeBot({ blocks })
  const deps = makeDeps()
  const r = await gatherAction({ name: 'wood' }, bot, {}, deps)
  assert.equal(r, 'gathered 1/1 oak_log', `got: ${r}`)
  assert.equal(deps.goToCalls.length, 1, `goTo calls=${deps.goToCalls.length}`)
  assert.equal(deps.digCalls.length, 1, `dig calls=${deps.digCalls.length}`)
  assert.deepEqual(deps.digCalls[0], { x: 5, y: 64, z: 0 })
  pass('A (single oak_log, loose-term wood)')
} catch (e) { fail('A', e) }

// --- Test B: 5-block oak_log row via {x,y,z} anchor of leftmost
try {
  const blocks = new Map()
  for (let x = 5; x <= 9; x++) blocks.set(`${x},64,0`, 'oak_log')
  const bot = makeBot({ blocks })
  const deps = makeDeps()
  const r = await gatherAction({ x: 5, y: 64, z: 0 }, bot, {}, deps)
  assert.equal(r, 'gathered 5/5 oak_log', `got: ${r}`)
  assert.equal(deps.digCalls.length, 5)
  assert.equal(deps.goToCalls.length, 5)
  // First dig should be the leftmost (closest to origin 0,64,0): x=5.
  assert.equal(deps.digCalls[0].x, 5, `first dig x=${deps.digCalls[0].x}`)
  // All five x-coords 5..9 covered.
  const xs = deps.digCalls.map(c => c.x).sort((a, b) => a - b)
  assert.deepEqual(xs, [5, 6, 7, 8, 9])
  pass('B (5-block row, coord anchor)')
} catch (e) { fail('B', e) }

// --- Test C: signal pre-aborted -> 'aborted'
try {
  const controller = new AbortController()
  controller.abort()
  const blocks = new Map([[`5,64,0`, 'oak_log']])
  const bot = makeBot({ blocks })
  const deps = makeDeps()
  const r = await gatherAction({ name: 'wood' }, bot, { signal: controller.signal }, deps)
  assert.equal(r, 'aborted', `got: ${r}`)
  assert.equal(deps.goToCalls.length, 0)
  assert.equal(deps.digCalls.length, 0)
  pass('C (signal pre-aborted)')
} catch (e) { fail('C', e) }

// --- Test D: abort after 2 successful digs -> 'aborted after 2/5 oak_log'
try {
  const controller = new AbortController()
  const blocks = new Map()
  for (let x = 5; x <= 9; x++) blocks.set(`${x},64,0`, 'oak_log')
  const bot = makeBot({ blocks })
  const deps = makeDeps({ controller, abortAfter: 2 })
  const r = await gatherAction({ x: 5, y: 64, z: 0 }, bot, { signal: controller.signal }, deps)
  assert.equal(r, 'aborted after 2/5 oak_log', `got: ${r}`)
  pass('D (abort mid-vein, partial progress)')
} catch (e) { fail('D', e) }

// --- Test E: {name:'wood'} with no matches -> 'no wood in loaded chunks'
try {
  const blocks = new Map() // empty world
  const bot = makeBot({ blocks })
  const deps = makeDeps()
  const r = await gatherAction({ name: 'wood' }, bot, {}, deps)
  assert.equal(r, 'no wood in loaded chunks', `got: ${r}`)
  assert.equal(deps.digCalls.length, 0)
  pass('E (no matches, name-only)')
} catch (e) { fail('E', e) }

// --- Test F: {x,y,z} pointing at air -> 'no block at anchor'
try {
  const blocks = new Map() // (0,64,0) is air per default
  const bot = makeBot({ blocks })
  const deps = makeDeps()
  const r = await gatherAction({ x: 0, y: 64, z: 0 }, bot, {}, deps)
  assert.equal(r, 'no block at anchor', `got: ${r}`)
  assert.equal(deps.digCalls.length, 0)
  pass('F (anchor at air)')
} catch (e) { fail('F', e) }

// --- Test G: 5x5x5 stone cube (125 blocks) -> vein-cap reached
try {
  const blocks = new Map()
  for (let x = 5; x <= 9; x++) {
    for (let y = 64; y <= 68; y++) {
      for (let z = 5; z <= 9; z++) {
        blocks.set(`${x},${y},${z}`, 'stone')
      }
    }
  }
  const bot = makeBot({ blocks })
  const deps = makeDeps({
    digResponses: (args) => `dug stone @${args.x},${args.y},${args.z}`,
  })
  const r = await gatherAction({ x: 5, y: 64, z: 5 }, bot, {}, deps)
  // Expect: gathered 64/64 stone (cap reached)
  const m = /^gathered (\d+)\/(\d+) stone \(cap reached\)$/.exec(r)
  assert.ok(m, `expected cap result, got: ${r}`)
  const k = Number(m[1]), n = Number(m[2])
  assert.equal(n, 64, `total should equal BATCH_CAP=64, got ${n}`)
  assert.ok(k <= 64, `K=${k} must be <= 64`)
  assert.equal(k, 64, `K should equal N=64 when all stubbed digs succeed, got ${k}`)
  pass('G (batch-cap on 125-block stone cube)')
} catch (e) { fail('G', e) }

if (fails > 0) {
  console.error(`[test-mineVein] ${fails} test(s) failed`)
  process.exit(1)
}
console.log('[test-mineVein] all 7 tests passed')
