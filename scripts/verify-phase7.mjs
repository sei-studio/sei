#!/usr/bin/env node
// Phase 7 end-to-end verification harness.
//
// Exercises every Phase 7 requirement (R-01..R-06) plus the decision-level
// invariants documented in 07-CONTEXT (D-03..D-10) via offline stubs:
//
//   A. R-01 build schema: 16-cell pass, 324-cell reject, missing block reject,
//      hollow accepted, single-cell accepted.
//   B. R-02 dig schema: legacy {block}, legacy {x,y,z}, cuboid {x,y,z,to},
//      reject >256 cuboid, reject {block,to} missing-from-coords.
//   C. R-04 inventory check: build with empty inventory returns
//      `no <block> in inventory` BEFORE any placeBlock call.
//   D. R-05 cell counts: enumerateBuildCells solid + hollow + single-cell.
//   E. iteration order constants exported; first-cell minY for build,
//      maxY for dig.
//   F. R-06 unreachable hint: composeVerticalHint surfaces `try build to Y=N`
//      when target.y > bot.y + 2; suppressed when below.
//   G. D-05 occupied skip: build with 2/4 cells occupied returns
//      `2 placed, 2 skipped, of 4 cells`; placeBlock spy invoked exactly 2x.
//   H. D-06 air skip: digCuboid with 3/5 air cells reports `3 skipped air`.
//   I. D-04 scaffolding contract: scaffoldUp issues setControlState('jump',
//      true) and exits when bot.entity.position.y reaches targetY - 1.
//   J. D-08 grammar block: composeSeedBlocks returns seed_cuboid_grammar
//      BEFORE seed_diary; text mentions pillar/wall/platform/tunnel/hollow/256.
//   K. D-03 descriptions plumbed: adapter.getActionDescription returns
//      non-empty for build/placeBlock/equip; dig description mentions
//      'CUBOID MODE'.
//   L. D-10 snapshot enrichment: composeSnapshot with progress-bearing
//      inFlight renders `47/256` and `y=66`.
//   M. abort discipline: build + digCuboid with pre-aborted signal return
//      a string containing `aborted`.
//
// Pure-stub harness — no mineflayer boot, no Anthropic, no fs writes.
// Exit code 0 on full pass; non-zero with explicit label on any failure.
//
// Assertion manifest (13 PASS gates — keep in sync with the blocks below):
//   PASS A — R-01 build schema
//   PASS B — R-02 dig schema
//   PASS C — R-04 inventory short-circuit
//   PASS D — R-05 cell counts (solid / hollow / single)
//   PASS E — iteration order constants + first-cell Y
//   PASS F — R-06 composeVerticalHint
//   PASS G — D-05 build occupied skip
//   PASS H — D-06 dig air skip
//   PASS I — D-04 scaffoldUp contract
//   PASS J — D-08 seed_cuboid_grammar order + content
//   PASS K — D-03 adapter descriptions plumbed
//   PASS L — D-10 snapshot progress enrichment
//   PASS M — abort discipline (build + digCuboid)

import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'

let count = 0
function ok(letter, label) { console.log(`[verify-phase7] PASS ${letter} - ${label}`); count++ }
function bad(letter, err) {
  console.error(`[verify-phase7] FAIL ${letter}: ${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
}

// ─── Bot stub helper ────────────────────────────────────────────────────
// `blocks` is a Map<"x,y,z", string>. Missing keys read as air.
function makeBot({ blocks = new Map(), originPos = { x: 0, y: 64, z: 0 }, inv = [], placeBlockSpy = null, equipSpy = null } = {}) {
  const me = {
    position: new Vec3(originPos.x, originPos.y, originPos.z),
    onGround: true,
  }
  function blockAt(p) {
    const k = `${p.x},${p.y},${p.z}`
    const name = blocks.get(k)
    if (!name) return { name: 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty' }
    return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: 'block', diggable: true }
  }
  return {
    version: 'not-a-real-version',
    entity: me,
    entities: { 0: me },
    health: 20,
    food: 20,
    inventory: { items: () => inv },
    heldItem: null,
    blockAt,
    findBlocks: () => [],
    equip: equipSpy ?? (async () => {}),
    placeBlock: placeBlockSpy ?? (async () => { blocks.set('placed-marker', 'x') }),
    setControlState: () => {},
    game: { dimension: 'overworld' },
    biomeAt: () => ({ name: 'plains' }),
    registry: { biomes: { 0: { name: 'plains' } } },
    time: { isDay: true, timeOfDay: 6000 },
    isSleeping: false,
    experience: { level: 0 },
  }
}

// ─── A: build schema ────────────────────────────────────────────────────
let regMod
try {
  regMod = await import('../src/bot/adapter/minecraft/registry.js')
  const r = regMod.createDefaultRegistry()
  assert.ok(r.list().includes('build'), 'registry missing build')
  const s = r.schema('build')
  assert.ok(s, 'build schema null')
  // 16-cell (4x1x4)
  s.parse({ from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 64, z: 3 }, block: 'dirt' })
  // hollow:true accepted
  s.parse({ from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 66, z: 3 }, block: 'dirt', hollow: true })
  // single-cell
  s.parse({ from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 }, block: 'dirt' })
  // 324-cell (9x9x4) rejected
  assert.throws(
    () => s.parse({ from: { x: 0, y: 64, z: 0 }, to: { x: 8, y: 67, z: 8 }, block: 'dirt' }),
    /256|too large/i,
    'expected 324-cell reject',
  )
  // missing block rejected
  assert.throws(
    () => s.parse({ from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 64, z: 3 } }),
    /block/i,
    'expected missing-block reject',
  )
  ok('A', 'R-01 build schema (16 ok, hollow ok, single ok, 324 rejected, missing block rejected)')
} catch (e) { bad('A', e) }

// ─── B: dig schema ──────────────────────────────────────────────────────
try {
  const r = regMod.createDefaultRegistry()
  const s = r.schema('dig')
  assert.ok(s, 'dig schema null')
  // legacy {block}
  s.parse({ block: 'oak_log' })
  // legacy {x,y,z}
  s.parse({ x: 0, y: 64, z: 0 })
  // cuboid {x,y,z,to}
  s.parse({ x: 0, y: 64, z: 0, to: { x: 0, y: 65, z: 4 } })
  // cuboid >256 rejected (9*9*4 = 324)
  assert.throws(
    () => s.parse({ x: 0, y: 64, z: 0, to: { x: 8, y: 67, z: 8 } }),
    /256|too large/i,
    'expected 324-cell cuboid dig reject',
  )
  // {block, to} (missing x/y/z) rejected
  assert.throws(
    () => s.parse({ block: 'oak_log', to: { x: 0, y: 65, z: 4 } }),
    /missing|from coords|x,y,z/i,
    'expected {block,to} reject',
  )
  ok('B', 'R-02 dig schema (legacy block, legacy xyz, cuboid xyz+to, >256 reject, {block,to} reject)')
} catch (e) { bad('B', e) }

// ─── C: R-04 inventory check (no placeBlock invocation) ─────────────────
try {
  const { buildAction } = await import('../src/bot/adapter/minecraft/behaviors/build.js')
  let placeCalls = 0
  const bot = makeBot({
    inv: [], // empty inventory
    placeBlockSpy: async () => { placeCalls++ },
  })
  const result = await buildAction(
    { from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 64, z: 3 }, block: 'dirt' },
    bot,
    {},
  )
  assert.equal(result, 'no dirt in inventory', `got: ${result}`)
  assert.equal(placeCalls, 0, `placeBlock invoked ${placeCalls} times; expected 0`)
  ok('C', 'R-04 build({block}) with empty inventory short-circuits BEFORE placeBlock')
} catch (e) { bad('C', e) }

// ─── D: R-05 cell counts ────────────────────────────────────────────────
try {
  const { enumerateBuildCells } = await import('../src/bot/adapter/minecraft/behaviors/build.js')
  const solid = enumerateBuildCells({ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 3 }, false)
  assert.equal(solid.length, 16, `solid 4x1x4 expected 16, got ${solid.length}`)
  const hollow = enumerateBuildCells({ x: 0, y: 64, z: 0 }, { x: 3, y: 66, z: 3 }, true)
  // 4x3x4 region, perimeter per Y layer = 4+4+2+2 = 12; 3 Y layers = 36
  assert.equal(hollow.length, 36, `hollow 4x3x4 expected 36 walls, got ${hollow.length}`)
  // None of the hollow cells should be interior (1<=x<=2 AND 1<=z<=2)
  const interior = hollow.filter(c => c.x > 0 && c.x < 3 && c.z > 0 && c.z < 3)
  assert.equal(interior.length, 0, `hollow contained ${interior.length} interior cells`)
  const single = enumerateBuildCells({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, false)
  assert.equal(single.length, 1, `single-cell expected 1, got ${single.length}`)
  ok('D', 'R-05 cell counts (solid=16, hollow walls-only=36, single=1)')
} catch (e) { bad('D', e) }

// ─── E: iteration order constants + first-cell Y direction ──────────────
try {
  const bMod = await import('../src/bot/adapter/minecraft/behaviors/build.js')
  const dMod = await import('../src/bot/adapter/minecraft/behaviors/dig.js')
  assert.equal(typeof bMod.ITERATION_ORDER, 'string', 'build ITERATION_ORDER not exported')
  assert.match(bMod.ITERATION_ORDER, /Y-asc/, `build order: ${bMod.ITERATION_ORDER}`)
  assert.equal(typeof dMod.CUBOID_ITERATION_ORDER, 'string', 'dig CUBOID_ITERATION_ORDER not exported')
  assert.match(dMod.CUBOID_ITERATION_ORDER, /Y-desc/, `dig order: ${dMod.CUBOID_ITERATION_ORDER}`)
  const bCells = bMod.enumerateBuildCells({ x: 0, y: 64, z: 0 }, { x: 1, y: 66, z: 1 }, false)
  assert.equal(bCells[0].y, 64, `build first cell y expected minY=64, got ${bCells[0].y}`)
  const dCells = dMod.enumerateDigCells({ x: 0, y: 64, z: 0 }, { x: 1, y: 66, z: 1 }, false)
  assert.equal(dCells[0].y, 66, `dig first cell y expected maxY=66, got ${dCells[0].y}`)
  ok('E', 'iteration order constants exported; build minY first, dig maxY first')
} catch (e) { bad('E', e) }

// ─── F: R-06 unreachable hint via composeVerticalHint ───────────────────
try {
  const { composeVerticalHint } = await import('../src/bot/adapter/minecraft/behaviors/pathfind.js')
  // Elevated target — bot.y=64, target.y=70 → hint
  const elevatedBot = { entity: { position: { x: 0, y: 64, z: 0 } } }
  const hinted = composeVerticalHint(elevatedBot, 0, 70, 0, 'cant_reach')
  assert.match(hinted, /try build to Y=70/, `hint missing for elevated case: ${hinted}`)
  // Level-ish target — bot.y=64, target.y=65 → no hint (delta <= 2)
  const flatHint = composeVerticalHint(elevatedBot, 0, 65, 0, 'cant_reach')
  assert.ok(!flatHint.includes('try build'), `unexpected hint for flat case: ${flatHint}`)
  // Reached short-circuit
  const reached = composeVerticalHint(elevatedBot, 0, 70, 0, 'reached')
  assert.equal(reached, 'reached', `reached should bypass hint: ${reached}`)
  ok('F', 'R-06 composeVerticalHint surfaces try-build-to-Y on elevated, suppresses on flat')
} catch (e) { bad('F', e) }

// ─── G: D-05 occupied skip ──────────────────────────────────────────────
try {
  const { buildAction } = await import('../src/bot/adapter/minecraft/behaviors/build.js')
  // 4 cells in a row at y=64, z=0, x=0..3. Occupy x=0 and x=2 with dirt.
  // Bot stands at (1, 64, 0) so all cells are within reach. The two empty
  // cells (x=1 was bot, but blockAt at x=1 returns air → not occupied; bot
  // collision is a separate concern). To avoid bot-position confusion, use
  // y=65 cells with bot at y=64 so cells are clearly different.
  // Cuboid: from=(0,65,0) to=(3,65,0). Occupy x=0 and x=2. Need ref neighbors
  // — occupied cells themselves serve as references for adjacent cells.
  const blocks = new Map()
  blocks.set('0,65,0', 'dirt')
  blocks.set('2,65,0', 'dirt')
  // Also add some floor blocks so pickReferenceFace finds something for x=1
  // and x=3 (they look at floor at y=64 first).
  for (let x = 0; x <= 3; x++) blocks.set(`${x},64,0`, 'dirt')
  let placeCalls = 0
  const bot = makeBot({
    blocks,
    originPos: { x: 1, y: 65, z: 0 }, // bot at the level so all 4 cells in reach
    inv: [{ name: 'dirt', count: 32, type: 0, slot: 0 }],
    placeBlockSpy: async () => { placeCalls++ },
    equipSpy: async () => {},
  })
  const result = await buildAction(
    { from: { x: 0, y: 65, z: 0 }, to: { x: 3, y: 65, z: 0 }, block: 'dirt' },
    bot,
    {},
  )
  assert.match(result, /2 placed, 2 skipped, of 4 cells/, `got: ${result}`)
  assert.equal(placeCalls, 2, `placeBlock expected 2 calls, got ${placeCalls}`)
  ok('G', 'D-05 build skips occupied cells (2 placed, 2 skipped of 4)')
} catch (e) { bad('G', e) }

// ─── H: D-06 dig air skip ──────────────────────────────────────────────
try {
  const { digCuboid } = await import('../src/bot/adapter/minecraft/behaviors/dig.js')
  // 5 cells along z=0..4 at (0,64,z). Only z=0 and z=4 are solid; rest are air.
  const blocks = new Map()
  blocks.set('0,64,0', 'stone')
  blocks.set('0,64,4', 'stone')
  // Bot at (0,64,2) so all cells in dig reach (within 4.5m)
  let digCalls = 0
  const bot = makeBot({ blocks, originPos: { x: 0, y: 64, z: 2 } })
  // digCuboid calls bot.dig + bot.canDigBlock + goTo internally. Patch:
  bot.dig = async (block) => {
    digCalls++
    // simulate immediate removal
    blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`)
    return undefined
  }
  bot.canDigBlock = () => true
  bot.targetDigBlock = null
  bot.stopDigging = () => {}
  bot.pathfinder = { setMovements: () => {}, goto: async () => {}, stop: () => {} }
  // entity.position.distanceTo
  bot.entity.position.distanceTo = function (p) {
    const dx = this.x - p.x, dy = this.y - p.y, dz = this.z - p.z
    return Math.sqrt(dx*dx + dy*dy + dz*dz)
  }
  const result = await digCuboid(
    { x: 0, y: 64, z: 0, to: { x: 0, y: 64, z: 4 } },
    bot,
    { pathfinder_timeout_ms: 100 },
  )
  assert.match(result, /3 skipped air/, `got: ${result}`)
  ok('H', 'D-06 digCuboid skips air cells (3 skipped of 5)')
} catch (e) { bad('H', e) }

// ─── I: D-04 scaffolding contract ──────────────────────────────────────
try {
  const { scaffoldUp } = await import('../src/bot/adapter/minecraft/behaviors/build.js')
  let jumpCalls = 0
  const blocks = new Map()
  // Floor block under bot start position so refBlock lookup succeeds.
  blocks.set('0,63,0', 'dirt')
  // Add additional floor block one Y up each "place" simulates a successful pillar
  const bot = makeBot({
    blocks,
    originPos: { x: 0, y: 64, z: 0 },
    inv: [{ name: 'dirt', count: 32, type: 0, slot: 0 }],
    equipSpy: async () => {},
  })
  // Track jump invocations and simulate the bot rising on each jump.
  bot.setControlState = (state, on) => {
    if (state === 'jump' && on === true) {
      jumpCalls++
      // Simulate apex: rise by 1 block. Also need a new floor block to land on
      // after placeBlock is called — we'll synthesize that there.
      bot.entity.position.y += 1
    }
  }
  // placeBlock simulates adding a block at the bot's feet's floor (refPos)
  bot.placeBlock = async (refBlock, faceVec) => {
    const np = refBlock.position
    blocks.set(`${np.x},${np.y + 1},${np.z}`, 'dirt')
    return undefined
  }
  // targetY = 66 → loop ends when bot.y >= 65 (targetY - 1). With apex bump
  // of +1 per iter from y=64 → after 1 jump bot.y=65, exits.
  const r = await scaffoldUp(bot, 'dirt', 66, {})
  assert.equal(r, 'ok', `scaffoldUp expected 'ok', got: ${r}`)
  assert.ok(jumpCalls >= 1, `expected ≥1 jump, got ${jumpCalls}`)
  assert.ok(Math.floor(bot.entity.position.y) >= 65, `bot y expected ≥65, got ${bot.entity.position.y}`)
  ok('I', 'D-04 scaffoldUp issues jump and exits at targetY-1')
} catch (e) { bad('I', e) }

// ─── J: D-08 seed_cuboid_grammar block ─────────────────────────────────
try {
  const { composeSeedBlocks } = await import('../src/bot/brain/orchestrator.js')
  const stubSession = { ownerData: () => ({ name: 'tester' }) }
  const stubOwner = { formatOwnerSeedBlock: () => 'OWNER_BLOCK' }
  const stubDiary = { seedSlice: async () => 'DIARY_BLOCK' }
  const blocks = await composeSeedBlocks({
    sessionState: stubSession,
    ownerStore: stubOwner,
    diary: stubDiary,
    config: { memory: { seed_owner_budget_bytes: 1024 } },
    eventText: 'EVT',
    snapshotText: 'SNAP',
  })
  const names = blocks.map(b => b.name)
  const iGrammar = names.indexOf('seed_cuboid_grammar')
  const iDiary = names.indexOf('seed_diary')
  assert.ok(iGrammar >= 0, `seed_cuboid_grammar missing; got: ${names.join(',')}`)
  assert.ok(iDiary > iGrammar, `seed_cuboid_grammar must precede seed_diary (idx ${iGrammar} vs ${iDiary})`)
  const grammarText = blocks[iGrammar].text
  for (const word of ['pillar', 'wall', 'platform', 'tunnel', 'hollow', '256']) {
    assert.match(grammarText, new RegExp(word, 'i'), `seed_cuboid_grammar missing '${word}'`)
  }
  ok('J', 'D-08 seed_cuboid_grammar precedes seed_diary; mentions pillar/wall/platform/tunnel/hollow/256')
} catch (e) { bad('J', e) }

// ─── K: D-03 descriptions plumbed via adapter ──────────────────────────
try {
  const { createMinecraftAdapter } = await import('../src/bot/adapter/minecraft/index.js')
  const stubBot = makeBot({})
  stubBot.username = 'sei'
  stubBot.players = {}
  const adapter = createMinecraftAdapter({ bot: stubBot, config: { adapter: { minecraft: {} } } })
  for (const name of ['build', 'placeBlock', 'equip']) {
    const d = adapter.getActionDescription(name)
    assert.equal(typeof d, 'string', `${name} description not a string`)
    assert.ok(d.length > 20, `${name} description too short: "${d}"`)
  }
  const digDesc = adapter.getActionDescription('dig')
  assert.match(digDesc, /CUBOID MODE/, `dig description missing CUBOID MODE: ${digDesc.slice(0, 120)}`)
  ok('K', 'D-03 adapter exposes build/placeBlock/equip descriptions; dig description mentions CUBOID MODE')
} catch (e) { bad('K', e) }

// ─── L: D-10 snapshot enrichment ───────────────────────────────────────
try {
  const { composeSnapshot } = await import('../src/bot/adapter/minecraft/observers/snapshot.js')
  const bot = makeBot({})
  bot.players = {}
  const out = composeSnapshot(bot, {
    inFlight: {
      name: 'build',
      args: { block: 'oak_planks' },
      startedAt: Date.now() - 12000,
      progress: { placed: 47, total: 256, currentY: 66 },
    },
  })
  assert.match(out, /in_flight: build/, 'snapshot missing in_flight: build line')
  assert.match(out, /47\/256/, `snapshot missing progress 47/256: ${out}`)
  assert.match(out, /y=66/, `snapshot missing y=66: ${out}`)
  ok('L', 'D-10 composeSnapshot renders progress 47/256 and y=66 on the in_flight line')
} catch (e) { bad('L', e) }

// ─── M: abort discipline (build + digCuboid) ───────────────────────────
try {
  const { buildAction } = await import('../src/bot/adapter/minecraft/behaviors/build.js')
  const { digCuboid } = await import('../src/bot/adapter/minecraft/behaviors/dig.js')
  const controller = new AbortController()
  controller.abort()
  const buildBot = makeBot({ inv: [{ name: 'dirt', count: 32 }] })
  const bRes = await buildAction(
    { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 }, block: 'dirt' },
    buildBot,
    { signal: controller.signal },
  )
  assert.equal(bRes, 'aborted', `build pre-abort expected 'aborted', got: ${bRes}`)

  // For digCuboid, pre-abort short-circuits at the first guard.
  const digBot = makeBot({ originPos: { x: 0, y: 64, z: 0 } })
  digBot.pathfinder = { setMovements: () => {}, goto: async () => {}, stop: () => {} }
  digBot.targetDigBlock = null
  digBot.stopDigging = () => {}
  digBot.canDigBlock = () => true
  const dRes = await digCuboid(
    { x: 0, y: 64, z: 0, to: { x: 0, y: 64, z: 4 } },
    digBot,
    { signal: controller.signal },
  )
  assert.match(dRes, /aborted/, `digCuboid pre-abort expected /aborted/, got: ${dRes}`)
  ok('M', 'abort discipline (buildAction + digCuboid both honor pre-aborted signal)')
} catch (e) { bad('M', e) }

console.log(`\nPhase 7 harness: ${count}/13 PASS`)
if (count !== 13) {
  console.error(`Expected 13 PASS, got ${count}`)
  process.exit(1)
}
process.exit(0)
