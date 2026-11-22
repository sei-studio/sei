// 261017 (pass 14b): the crafting tables and furnaces that are hers.
//
// The progression spine counts a placed station as had (so a furnace she put
// down does not leave "make a furnace" as her next milestone). Any furnace in
// range used to count, so the player's or a village's cleared her milestone
// and produced a false "you just finished make a furnace". Now only a station
// she placed herself (placeBlock, and build through it) or one she actually
// used (crafted at, opened) counts, and only while the block is still there.

export const OWN_STATIONS = ['crafting_table', 'furnace']
const MAX_PER_STATION = 8

function plain(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

/** Remember a station block at `pos` as hers. No-op for other blocks. */
export function recordOwnStation(bot, name, pos) {
  if (!bot || typeof bot !== 'object' || !OWN_STATIONS.includes(name)) return
  const p = plain(pos)
  if (!p) return
  const all = bot._seiOwnStations ?? (bot._seiOwnStations = {})
  const list = (all[name] ?? []).filter((q) => q.x !== p.x || q.y !== p.y || q.z !== p.z)
  list.push(p)
  all[name] = list.slice(-MAX_PER_STATION)
  // The progression read caches its result for a few seconds; a new station
  // should count on the next read.
  bot._seiPlacedStations = null
}

/** Her recorded stations of `name` (block positions). */
export function ownStationPositions(bot, name) {
  return Array.isArray(bot?._seiOwnStations?.[name]) ? bot._seiOwnStations[name] : []
}




