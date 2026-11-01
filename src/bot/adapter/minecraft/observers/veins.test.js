/**
 * surveyBlocks (the snapshot's `nearby blocks:` list), pass 35 (261101).
 *
 * The old path used bot.findBlocks with "anything not air" and a 4096 cap.
 * findBlocks reads chunk sections in an octahedron and stops once it holds the
 * cap, so the buried stone under her filled it from the first few sections and
 * the diagonal sections were never read. smelt_iron benchmark, 2026-11-01:
 * standing at 174,71,-1 next to the player, the furnace at 179,71,2 (5.8
 * blocks, one section over on x and z) was missing, and she said "i don't see
 * a furnace near us". These tests use a real 1.21.11 registry, real chunks and
 * mineflayer's own findBlocks, so the regression case is the real algorithm.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { surveyBlocks, scanColumns } from './veins.js'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const VERSION = '1.21.11'
const registry = require('prismarine-registry')(VERSION)
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const injectBlocks = require('mineflayer/lib/plugins/blocks.js')

const S = (name) => registry.blocksByName[name].defaultState

/** The eval arena: stone to y=69, grass at y=70, open air above. */
function arenaBot({ chunksX = [8, 13], chunksZ = [-3, 2] } = {}) {
  const world = new World().sync
  for (let cx = chunksX[0]; cx <= chunksX[1]; cx++) {
    for (let cz = chunksZ[0]; cz <= chunksZ[1]; cz++) {
      const c = new Chunk({ minY: -64, worldHeight: 384 })
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = -64; y < 70; y++) c.setBlockStateId(new Vec3(x, y, z), S('stone'))
          c.setBlockStateId(new Vec3(x, 70, z), S('grass_block'))
        }
      }
      world.setColumn(cx, cz, c)
    }
  }
  const bot = new EventEmitter()
  bot.registry = registry
  bot._client = new EventEmitter()
  bot.game = { minY: -64, height: 384, dimension: 'overworld' }
  bot.version = VERSION
  injectBlocks(bot, { version: VERSION })
  bot.world = world
  bot.at = (x, y, z) => { bot.entity = { position: new Vec3(x + 0.5, y, z + 0.5) } }
  bot.set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), S(name))
  return bot
}

/** Same bot without chunk columns: surveyBlocks falls back to findBlocks. */
function findBlocksOnly(bot) {
  const b = Object.create(bot)
  b.world = { getColumn: undefined }
  return b
}

const names = (s) => s.groups.map(g => g.name)
const group = (s, n) => s.groups.find(g => g.name === n)

describe('surveyBlocks', () => {
  it('lists a furnace one section over on both axes (the smelt_iron miss)', () => {
    const bot = arenaBot()
    bot.set(179, 71, 2, 'furnace')
    bot.at(174, 71, -1)
    // The old path really misses it here (the regression this fixes).
    expect(names(surveyBlocks(findBlocksOnly(bot), { radius: 16, maxNames: 10 }))).not.toContain('furnace')
    const s = surveyBlocks(bot, { radius: 16, maxNames: 10 })
    expect(group(s, 'furnace')?.nearest).toEqual({ x: 179, y: 71, z: 2 })
  })

  it('lists exposed blocks out to the radius, not just the nearest 4096 solids', () => {
    const bot = arenaBot()
    bot.set(176, 71, 15, 'crafting_table') // 15 blocks south
    bot.at(176, 71, 0)
    const s = surveyBlocks(bot, { radius: 16 })
    expect(group(s, 'crafting_table')?.nearest).toEqual({ x: 176, y: 71, z: 15 })
    // Every grass block in the disc is on top and exposed: about pi*16^2.
    expect(group(s, 'grass_block').total).toBeGreaterThan(700)
  })

  it('leaves out blocks past the radius', () => {
    const bot = arenaBot()
    bot.set(179, 71, 2, 'furnace')
    bot.at(186, 71, -16) // 19 blocks away
    expect(names(surveyBlocks(bot, { radius: 16 }))).not.toContain('furnace')
  })

  it('never lists buried blocks (no xray), but does list one at an open face', () => {
    const bot = arenaBot()
    bot.set(176, 65, 0, 'iron_ore') // sealed in stone
    bot.set(180, 69, 0, 'coal_ore') // under air (cleared above it)
    bot.set(180, 70, 0, 'air')
    bot.set(172, 69, 0, 'diamond_ore') // under water: water counts as see-through
    bot.set(172, 70, 0, 'water')
    bot.at(176, 71, 0)
    const n = names(surveyBlocks(bot, { radius: 16 }))
    expect(n).not.toContain('iron_ore')
    expect(n).toContain('coal_ore')
    expect(n).toContain('diamond_ore')
    expect(n).toContain('water')
    expect(n).not.toContain('air')
  })

  it('anchors each name at its nearest member and ranks names nearest first', () => {
    const bot = arenaBot()
    bot.set(186, 71, 0, 'oak_log')
    bot.set(180, 71, 0, 'oak_log')
    bot.set(178, 71, 0, 'chest')
    bot.at(176, 71, 0)
    const s = surveyBlocks(bot, { radius: 16 })
    expect(group(s, 'oak_log')).toMatchObject({ total: 2, nearest: { x: 180, y: 71, z: 0 } })
    expect(names(s).slice(0, 3)).toEqual(['grass_block', 'chest', 'oak_log'])
  })

  it('caps the names and counts the rest', () => {
    const bot = arenaBot()
    const extra = ['chest', 'furnace', 'crafting_table', 'oak_log', 'birch_log', 'dirt', 'sand', 'gravel', 'cobblestone', 'oak_planks', 'glass']
    extra.forEach((n, i) => bot.set(178 + i, 71, 0, n))
    bot.at(176, 71, 0)
    const s = surveyBlocks(bot, { radius: 16, maxNames: 10 })
    expect(s.groups).toHaveLength(10)
    expect(s.more).toBe(2)
  })

  it('treats unloaded columns as opaque and empty', () => {
    // Only the bot's own column is loaded; the edge of it is not "exposed"
    // through the unloaded neighbour, and nothing outside is invented.
    const bot = arenaBot({ chunksX: [11, 11], chunksZ: [0, 0] })
    bot.at(184, 71, 8)
    const s = surveyBlocks(bot, { radius: 16 })
    expect(names(s)).toEqual(['grass_block'])
    expect(group(s, 'grass_block').total).toBe(256)
  })

  it('returns an empty survey with no loaded columns, and null scan without a world', () => {
    const bot = arenaBot({ chunksX: [0, -1], chunksZ: [0, -1] })
    bot.at(176, 71, 0)
    expect(surveyBlocks(bot, { radius: 16 })).toEqual({ groups: [], more: 0 })
    expect(scanColumns({}, { x: 0, y: 0, z: 0 }, 16)).toBeNull()
  })

  it('keeps the findBlocks fallback for mocks', () => {
    const mock = {
      entity: { position: new Vec3(0.5, 71, 0.5) },
      findBlocks: () => [new Vec3(1, 71, 0)],
      blockAt: (p) => (p.x === 1 && p.y === 71 && p.z === 0 ? { name: 'furnace', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
    }
    expect(surveyBlocks(mock).groups.map(g => g.name)).toEqual(['furnace'])
    expect(surveyBlocks({ entity: { position: new Vec3(0, 0, 0) } })).toEqual({ groups: [], more: 0 })
  })

  it('handles a NaN origin', () => {
    const bot = arenaBot()
    bot.entity = { position: new Vec3(NaN, 71, 0) }
    expect(surveyBlocks(bot)).toEqual({ groups: [], more: 0 })
  })
})
