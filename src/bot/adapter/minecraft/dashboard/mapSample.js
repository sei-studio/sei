// src/bot/adapter/minecraft/dashboard/mapSample.js — top-down minimap sample
// for the Minecraft dashboard (260721).
//
// A size*size grid centered on the bot: for each column the top non-air block
// inside a bounded vertical window is classified into a small palette index,
// and its height relative to the bot's feet (clamped -8..+7) becomes a
// shading hint. One byte per cell — low nibble palette, high nibble height+8
// — base64-encoded so the whole 33x33 payload is ~1.5 KB of JSON.
//
// PALETTE MUST STAY IN SYNC with MC_DASH_PALETTE / MC_DASH_PALETTE_COLORS in
// src/shared/mcDashboardIpc.ts (the bot ships as raw ESM and cannot import
// the shared TS contract).

export const PALETTE = {
  VOID: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  LAVA: 6,
  WOOD: 7,
  LEAVES: 8,
  PLANT: 9,
  SNOW: 10,
  NETHER: 11,
  END: 12,
  ORE: 13,
  BUILT: 14,
  MISC: 15,
}

const AIR = new Set(['air', 'cave_air', 'void_air'])

/**
 * Block name → palette index. Order matters: specific families are matched
 * before the generic "contains stone" bucket ("sandstone" is SAND, not STONE).
 * @param {string|null|undefined} name mineflayer block name (no namespace)
 * @returns {number}
 */
export function classifyBlockName(name) {
  if (!name || AIR.has(name)) return PALETTE.VOID
  const n = String(name)

  // Water + waterlogged flora that reads as water from above.
  if (n === 'water' || n === 'bubble_column' || n === 'seagrass' || n === 'tall_seagrass' ||
      n === 'kelp' || n === 'kelp_plant') return PALETTE.WATER
  if (n === 'lava') return PALETTE.LAVA

  if (n.endsWith('_leaves')) return PALETTE.LEAVES
  if (n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem') || n.endsWith('_hyphae') ||
      n === 'bamboo' || n === 'bamboo_block' || n.endsWith('_planks')) return PALETTE.WOOD

  if (n === 'grass_block' || n === 'moss_block' || n === 'moss_carpet') return PALETTE.GRASS

  if (n === 'snow' || n === 'snow_block' || n === 'powder_snow' ||
      n === 'ice' || n === 'packed_ice' || n === 'blue_ice' || n === 'frosted_ice') return PALETTE.SNOW

  // Sand family before the generic stone bucket ("sandstone").
  if (n === 'sand' || n === 'red_sand' || n.includes('sandstone') ||
      n.endsWith('_concrete_powder')) return PALETTE.SAND

  if (n === 'dirt' || n === 'coarse_dirt' || n === 'rooted_dirt' || n === 'podzol' ||
      n === 'mycelium' || n === 'farmland' || n === 'dirt_path' || n === 'mud' ||
      n === 'muddy_mangrove_roots' || n === 'clay') return PALETTE.DIRT

  if (n.endsWith('_ore') || n === 'ancient_debris' || n === 'gilded_blackstone') return PALETTE.ORE

  if (n === 'netherrack' || n === 'soul_sand' || n === 'soul_soil' || n === 'magma_block' ||
      n === 'crimson_nylium' || n === 'warped_nylium' || n.includes('basalt') ||
      n.includes('blackstone') || n === 'nether_wart_block' || n === 'warped_wart_block') {
    return PALETTE.NETHER
  }

  if (n === 'end_stone' || n.includes('purpur') || n === 'chorus_plant' || n === 'chorus_flower') {
    return PALETTE.END
  }

  // Player-built / crafted surfaces (planks were already routed to WOOD).
  if (n.includes('brick') || n.endsWith('_concrete') || n.endsWith('_wool') ||
      n.includes('terracotta') || n.includes('glass') || n.endsWith('_slab') ||
      n.endsWith('_stairs') || n.endsWith('_wall') || n.endsWith('_fence') ||
      n.endsWith('_door') || n.endsWith('_trapdoor') || n === 'smooth_stone' ||
      n.endsWith('_carpet') || n === 'scaffolding' || n.endsWith('_bed')) return PALETTE.BUILT

  // Generic mineral bucket (after sand/nether/built so their *stone* names win).
  if (n.includes('stone') || n.includes('deepslate') || n === 'granite' || n === 'diorite' ||
      n === 'andesite' || n === 'tuff' || n === 'calcite' || n === 'gravel' ||
      n === 'obsidian' || n === 'crying_obsidian' || n === 'bedrock' || n === 'dripstone_block' ||
      n === 'pointed_dripstone' || n.startsWith('polished_') || n.startsWith('smooth_') ||
      n.startsWith('raw_')) return PALETTE.STONE

  // Ground cover / flora / crops.
  if (n.includes('grass') || n.includes('fern') || n.includes('flower') || n.includes('tulip') ||
      n.includes('sapling') || n.includes('mushroom') || n.includes('fungus') || n.includes('vine') ||
      n.includes('bush') || n.includes('rose') || n === 'lilac' || n === 'peony' || n === 'sunflower' ||
      n === 'dandelion' || n === 'poppy' || n === 'wheat' || n === 'carrots' || n === 'potatoes' ||
      n === 'beetroots' || n === 'melon' || n === 'pumpkin' || n === 'attached_melon_stem' ||
      n === 'attached_pumpkin_stem' || n === 'cactus' || n === 'sugar_cane' || n === 'sweet_berry_bush' ||
      n === 'lily_pad' || n === 'big_dripleaf' || n === 'small_dripleaf' || n === 'azalea' ||
      n === 'flowering_azalea' || n === 'cocoa' || n === 'nether_wart') return PALETTE.PLANT

  return PALETTE.MISC
}

/**
 * Pack one cell byte: low nibble palette (0-15), high nibble height delta
 * relative to the bot's feet, clamped to -8..+7 and offset by +8.
 * @param {number} paletteIdx
 * @param {number} heightDelta
 * @returns {number}
 */
export function packCell(paletteIdx, heightDelta) {
  const h = Math.max(-8, Math.min(7, Math.round(heightDelta)))
  return (((h + 8) & 0x0f) << 4) | (paletteIdx & 0x0f)
}

/** Unpack helpers (test/debug twins of the shared TS decoders). */
export function cellPalette(byte) {
  return byte & 0x0f
}
export function cellHeight(byte) {
  return ((byte >> 4) & 0x0f) - 8
}

/**
 * Base64-encode packed cells.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeCells(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/** How far above/below the bot's feet a column is scanned for its top block. */
const SCAN_UP = 16
const SCAN_DOWN = 27

/**
 * Sample a size*size top-down map around the bot. Row-major, north (-z)
 * first row, west (-x) first column, bot at the center cell. Unloaded chunks
 * and all-air columns read as VOID.
 *
 * Cost bound: size^2 columns x ≤(SCAN_UP+SCAN_DOWN+1) blockAt lookups, only
 * while the renderer is watching and at most every ~2s.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} [size]
 * @returns {{ size: number, cells: string } | null} null before first spawn
 */
export function sampleMap(bot, size = 33) {
  const pos = bot?.entity?.position
  if (!pos || typeof bot.blockAt !== 'function') return null
  const cx = Math.floor(pos.x)
  const cy = Math.floor(pos.y)
  const cz = Math.floor(pos.z)
  const r = Math.floor(size / 2)
  const bytes = new Uint8Array(size * size)
  // Mutating one probe object avoids size^2 * scan Vec3 allocations;
  // bot.blockAt only reads x/y/z (via .floored() on a Vec3-like). We pass a
  // real Vec3 clone of the bot position and mutate its fields.
  const probe = pos.clone ? pos.clone() : { x: 0, y: 0, z: 0, floored() { return this } }
  let i = 0
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++, i++) {
      let byte = packCell(PALETTE.VOID, -8)
      for (let y = cy + SCAN_UP; y >= cy - SCAN_DOWN; y--) {
        probe.x = cx + dx
        probe.y = y
        probe.z = cz + dz
        let block = null
        try {
          block = bot.blockAt(probe, false)
        } catch {
          block = null
        }
        if (!block) break // unloaded column → VOID
        if (AIR.has(block.name)) continue
        byte = packCell(classifyBlockName(block.name), y - cy)
        break
      }
      bytes[i] = byte
    }
  }
  return { size, cells: encodeCells(bytes) }
}
