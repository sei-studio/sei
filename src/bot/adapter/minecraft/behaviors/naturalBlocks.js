// src/bot/adapter/minecraft/behaviors/naturalBlocks.js
//
// Generated ground vs player builds. Split out of climbOut.js (261017) so
// build.js can use it without an import cycle (climbOut imports build.js).

// 261016 review: the staircase only cuts NATURAL ground. A closed room (shut
// door, player upstairs) reads as a hole too, and with an axe planks, doors,
// chests and beds all break under the 2.5s step limit (glass by hand).
// Anything not on this list is refused as built, and the climb says so.
const NATURAL_BLOCKS = new Set([
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite',
  'dripstone_block', 'smooth_basalt', 'basalt', 'blackstone', 'netherrack', 'end_stone',
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'moss_block',
  'clay', 'gravel', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'soul_sand', 'soul_soil',
  'terracotta', 'snow_block', 'packed_ice',
])
const TERRACOTTA_COLORS = new Set(['white', 'orange', 'yellow', 'red', 'brown', 'light_gray'])

/** Ground the world generated, which a staircase may cut through. */
export function isNaturalBlock(name) {
  if (!name) return false
  if (NATURAL_BLOCKS.has(name)) return true
  if (name.endsWith('_ore') || name === 'ancient_debris') return true
  // Badlands bands; glazed terracotta is always player-made.
  if (name.endsWith('_terracotta') && !name.includes('glazed')) return TERRACOTTA_COLORS.has(name.slice(0, -'_terracotta'.length))
  return false
}




