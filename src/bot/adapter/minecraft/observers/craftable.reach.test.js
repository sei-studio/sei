// 261126 (O5, T554): craftingTableInReach must say "a table is in reach"
// exactly when mineflayer's findBlock (what detectCraftingTable runs) finds
// one (mineflayer's scan is slow, about 0.1 s a call here, hence the
// trial count). Checked against the REAL mineflayer blocks plugin on a real
// prismarine-world, with tables placed around section edges and corners
// (findBlock only searches the feet section and its 6 face neighbours, so a
// table 2 blocks away across a section corner is NOT found, and must not be
// here either).
import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { craftingTableInReach, detectCraftingTable, CRAFT_TABLE_REACH } from './craftable.js'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const VERSION = '1.21.1'
const registry = require('prismarine-registry')(VERSION)
const injectBlocks = require('mineflayer/lib/plugins/blocks.js')
const World = require('prismarine-world')(registry)
const Chunk = require('prismarine-chunk')(registry)
const TABLE = registry.blocksByName.crafting_table
const FILLER = ['stone', 'dirt', 'oak_planks', 'cobblestone', 'oak_log'].map((n) => registry.blocksByName[n].defaultState)

function makeBot() {
  const bot = new EventEmitter()
  bot.registry = registry
  bot.version = VERSION
  bot._client = new EventEmitter()
  bot.supportFeature = registry.supportFeature
  bot.game = { minY: -64, height: 384 }
  injectBlocks(bot, { version: VERSION })
  bot.world = new World(null).sync
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) bot.world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }))
  bot.entity = { position: new Vec3(0, 0, 0) }
  return bot
}

// Small deterministic PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

describe('craftingTableInReach (261126)', () => {
  let bot
  beforeAll(() => { bot = makeBot() })

  it('agrees with mineflayer findBlock across section edges, corners and reach', () => {
    const rand = rng(261126)
    let found = 0
    let missed = 0
    for (let trial = 0; trial < 120; trial++) {
      const placed = []
      // Feet near a section corner most of the time (where the section rule bites).
      const corner = rand() < 0.7
      const fx = corner ? 16 * Math.floor(rand() * 3 - 1) + (rand() < 0.5 ? 0 : 15) : Math.floor(rand() * 48 - 24)
      const fz = corner ? 16 * Math.floor(rand() * 3 - 1) + (rand() < 0.5 ? 0 : 15) : Math.floor(rand() * 48 - 24)
      const fy = corner ? 16 * Math.floor(rand() * 3) + (rand() < 0.5 ? 0 : 15) : Math.floor(rand() * 40)
      bot.entity.position = new Vec3(fx + rand(), fy + rand() * 0.9, fz + rand())
      // Filler so sections get a real palette, then 0-2 tables within 6 blocks.
      for (let i = 0; i < 6; i++) {
        const p = new Vec3(fx + Math.floor(rand() * 13 - 6), fy + Math.floor(rand() * 13 - 6), fz + Math.floor(rand() * 13 - 6))
        bot.world.setBlockStateId(p, FILLER[i % FILLER.length]); placed.push(p)
      }
      let tables = Math.floor(rand() * 3)
      for (let i = 0; i < tables; i++) {
        const p = new Vec3(fx + Math.floor(rand() * 13 - 6), fy + Math.floor(rand() * 13 - 6), fz + Math.floor(rand() * 13 - 6))
        bot.world.setBlockStateId(p, TABLE.defaultState); placed.push(p)
      }
      // Half the corner trials: a table 1-2 blocks across BOTH x and z section
      // edges (inside reach, but in a diagonal section findBlock skips).
      if (corner && rand() < 0.5) {
        const step = (f) => ((f & 15) === 15 ? 1 : -1) * (1 + Math.floor(rand() * 2))
        const p = new Vec3(fx + step(fx), fy, fz + step(fz))
        bot.world.setBlockStateId(p, TABLE.defaultState); placed.push(p); tables += 1
      }
      // A quarter of trials: a table within 3 blocks (often in reach).
      if (rand() < 0.25) {
        const p = new Vec3(fx + Math.floor(rand() * 7 - 3), fy + Math.floor(rand() * 3 - 1), fz + Math.floor(rand() * 7 - 3))
        bot.world.setBlockStateId(p, TABLE.defaultState); placed.push(p); tables += 1
      }
      const want = bot.findBlock({ matching: TABLE.id, maxDistance: CRAFT_TABLE_REACH, point: bot.entity.position }) != null
      const got = craftingTableInReach(bot)
      expect({ trial, has: got != null }).toEqual({ trial, has: want })
      if (got) expect(got.type).toBe(TABLE.id)
      if (trial % 20 === 0) expect(detectCraftingTable(bot) != null).toBe(want)
      if (want) found += 1
      else if (tables > 0) missed += 1
      for (const p of placed) bot.world.setBlockStateId(p, 0)
    }
    // The sample covered both answers, including tables out of the searched set.
    expect(found).toBeGreaterThan(10)
    expect(missed).toBeGreaterThan(10)
  }, 60_000)

  it('a table two blocks away across a section corner is not in reach (as findBlock)', () => {
    bot.entity.position = new Vec3(15.5, 64, 15.5)
    const diag = new Vec3(17, 64, 17)
    bot.world.setBlockStateId(diag, TABLE.defaultState)
    expect(bot.findBlock({ matching: TABLE.id, maxDistance: CRAFT_TABLE_REACH, point: bot.entity.position })).toBeNull()
    expect(craftingTableInReach(bot)).toBeNull()
    const face = new Vec3(17, 64, 15)
    bot.world.setBlockStateId(face, TABLE.defaultState)
    expect(craftingTableInReach(bot)?.position).toEqual(face)
    bot.world.setBlockStateId(diag, 0)
    bot.world.setBlockStateId(face, 0)
  })

  it('falls back to detectCraftingTable on a bot with no world', () => {
    const table = { name: 'crafting_table' }
    const stub = { version: VERSION, entity: { position: { x: 0, y: 64, z: 0 } }, findBlock: () => table }
    expect(craftingTableInReach(stub)).toBe(table)
    expect(craftingTableInReach({})).toBeNull()
  })
})
