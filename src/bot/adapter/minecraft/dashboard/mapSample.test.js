// Minimap sampling + cell encoding for the Minecraft dashboard (260721).
// Pins the block-name → palette classifier, the packed-byte layout (low
// nibble palette, high nibble height+8), and a full sampleMap round trip
// against a synthetic bot — including the shared-TS decoder so the bot-side
// encoder and the renderer-side decoder can never drift apart.

import { describe, it, expect } from 'vitest'
import {
  PALETTE,
  classifyBlockName,
  packCell,
  cellPalette,
  cellHeight,
  encodeCells,
  sampleMap,
} from './mapSample.js'
import {
  MC_DASH_PALETTE,
  decodeMcDashCells,
  mcDashCellPalette,
  mcDashCellHeight,
} from '../../../../shared/mcDashboardIpc'

describe('classifyBlockName', () => {
  it('classifies representative overworld blocks', () => {
    expect(classifyBlockName('grass_block')).toBe(PALETTE.GRASS)
    expect(classifyBlockName('dirt')).toBe(PALETTE.DIRT)
    expect(classifyBlockName('stone')).toBe(PALETTE.STONE)
    expect(classifyBlockName('deepslate')).toBe(PALETTE.STONE)
    expect(classifyBlockName('water')).toBe(PALETTE.WATER)
    expect(classifyBlockName('lava')).toBe(PALETTE.LAVA)
    expect(classifyBlockName('oak_log')).toBe(PALETTE.WOOD)
    expect(classifyBlockName('oak_leaves')).toBe(PALETTE.LEAVES)
    expect(classifyBlockName('short_grass')).toBe(PALETTE.PLANT)
    expect(classifyBlockName('snow_block')).toBe(PALETTE.SNOW)
    expect(classifyBlockName('iron_ore')).toBe(PALETTE.ORE)
    expect(classifyBlockName('netherrack')).toBe(PALETTE.NETHER)
    expect(classifyBlockName('end_stone')).toBe(PALETTE.END)
    expect(classifyBlockName('white_wool')).toBe(PALETTE.BUILT)
    expect(classifyBlockName('chest')).toBe(PALETTE.MISC)
  })

  it('routes air and unknowns safely', () => {
    expect(classifyBlockName('air')).toBe(PALETTE.VOID)
    expect(classifyBlockName('cave_air')).toBe(PALETTE.VOID)
    expect(classifyBlockName(null)).toBe(PALETTE.VOID)
  })

  it('orders specific families before the generic stone bucket', () => {
    expect(classifyBlockName('sandstone')).toBe(PALETTE.SAND)
    expect(classifyBlockName('blackstone')).toBe(PALETTE.NETHER)
    expect(classifyBlockName('end_stone')).toBe(PALETTE.END)
    expect(classifyBlockName('stone_bricks')).toBe(PALETTE.BUILT)
  })

  it('mirrors the shared renderer palette indices exactly', () => {
    expect(PALETTE).toEqual(MC_DASH_PALETTE)
  })
})

describe('packCell / cell decode', () => {
  it('round-trips palette + height and clamps the height to -8..+7', () => {
    const b = packCell(PALETTE.GRASS, 3)
    expect(cellPalette(b)).toBe(PALETTE.GRASS)
    expect(cellHeight(b)).toBe(3)
    expect(cellHeight(packCell(PALETTE.STONE, -20))).toBe(-8)
    expect(cellHeight(packCell(PALETTE.STONE, 20))).toBe(7)
    // Shared TS decoders agree byte-for-byte with the bot-side pack.
    expect(mcDashCellPalette(b)).toBe(PALETTE.GRASS)
    expect(mcDashCellHeight(b)).toBe(3)
  })

  it('base64 encode (bot) → decode (shared) round-trips', () => {
    const bytes = new Uint8Array([0, 1, 17, 255, packCell(PALETTE.WATER, -2)])
    const decoded = decodeMcDashCells(encodeCells(bytes))
    expect([...decoded]).toEqual([...bytes])
  })
})

describe('sampleMap', () => {
  /** Synthetic world: flat grass at y=63, a stone pillar at (2, 0) up to y=66,
   * water at (-1, -1) at y=62, and one unloaded column at (0, 2). */
  function fakeBot() {
    return {
      entity: { position: { x: 0.5, y: 64, z: 0.5, clone() { return { ...this } } } },
      blockAt(p) {
        const { x, y, z } = p
        if (x === 0 && z === 2) return null // unloaded chunk
        if (x === 2 && z === 0 && y > 63 && y <= 66) return { name: 'stone' }
        if (x === -1 && z === -1 && y === 62) return { name: 'water' }
        if (x === -1 && z === -1 && y > 62) return { name: 'air' }
        if (y === 63) return { name: 'grass_block' }
        if (y < 63) return { name: 'dirt' }
        return { name: 'air' }
      },
    }
  }

  it('produces a size*size grid with the bot on a grass center cell', () => {
    const size = 5
    const map = sampleMap(fakeBot(), size)
    expect(map).not.toBeNull()
    expect(map.size).toBe(size)
    const cells = decodeMcDashCells(map.cells)
    expect(cells.length).toBe(size * size)
    const center = cells[Math.floor((size * size) / 2)]
    expect(mcDashCellPalette(center)).toBe(PALETTE.GRASS)
    expect(mcDashCellHeight(center)).toBe(-1) // grass top one below the feet
  })

  it('encodes terrain features at the right grid positions', () => {
    const size = 5
    const r = Math.floor(size / 2)
    const cells = decodeMcDashCells(sampleMap(fakeBot(), size).cells)
    const at = (dx, dz) => cells[(dz + r) * size + (dx + r)]
    expect(mcDashCellPalette(at(2, 0))).toBe(PALETTE.STONE)
    expect(mcDashCellHeight(at(2, 0))).toBe(2) // pillar top at y=66, feet at 64
    expect(mcDashCellPalette(at(-1, -1))).toBe(PALETTE.WATER)
    expect(mcDashCellPalette(at(0, 2))).toBe(PALETTE.VOID) // unloaded column
  })

  it('returns null before the bot has spawned', () => {
    expect(sampleMap({ entity: null })).toBeNull()
  })
})
