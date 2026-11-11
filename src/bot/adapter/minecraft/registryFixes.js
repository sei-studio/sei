// src/bot/adapter/minecraft/registryFixes.js — correct the tool speed table
// (registry.materials) that prismarine-block's digTime reads.
//
// 261111 (user feedback ae9a758e, on Minecraft 26.3): two data faults made
// the dig tool choice (toolSelect.js) and mineflayer's own dig timing wrong.
//
//  1. Our 26.3 backport (patches/minecraft-data+3.114.0.patch) points 26.3's
//     materials at pc/26.2. materials.json is keyed by numeric item id, and
//     26.3 renumbered items (wooden_pickaxe is 941 in 26.2 and 1027 in 26.3),
//     so on 26.3 the pickaxe row named poplar_fence_gate, detector_rail,
//     minecart and so on. No tool counted as the right tool: every pickaxe
//     dug stone in 2300ms (hand speed with harvest) and the choice between
//     tools was arbitrary.
//  2. minecraft-data lists every copper tool (1.21.9+) with speed 1, the hand
//     speed. In the game copper tools mine at 5, between stone (4) and iron
//     (6), so a wooden pickaxe was preferred over a copper one.
//
// The fix builds a corrected copy and assigns it to registry.materials (a
// plain writable property), so the require-cached JSON other versions share
// is never mutated. Idempotent.

const COPPER_TOOL_SPEED = 5
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']
const PROBE_TABLE = 'mineable/pickaxe'
const SOURCE_SCAN = 8

function alignedWith(items, table) {
  const ids = Object.keys(table ?? {})
  return ids.length > 0 && ids.every((id) => /_pickaxe$/.test(items?.[id]?.name ?? ''))
}

/**
 * The item list materials.json was numbered against, when it is not the
 * registry's own: the newest known version that loads the very same
 * materials object and whose item ids name pickaxes in the pickaxe row.
 */
function sourceItems(registry, mcDataLib) {
  const mats = registry.materials
  const known = mcDataLib?.supportedVersions?.pc ?? []
  for (const v of known.slice(-SOURCE_SCAN).reverse()) {
    let data = null
    try { data = mcDataLib(v) } catch { data = null }
    if (!data) continue
    let same = false
    try { same = data.materials === mats } catch { same = false }
    if (same && alignedWith(data.items, mats[PROBE_TABLE])) return data.items
  }
  return null
}

/**
 * Fix registry.materials in place on the registry (new object). Returns
 * {remapped, copper}: how many ids were renumbered and how many copper
 * entries were raised to the copper speed.
 * @param {object} registry  bot.registry
 * @param {Function} [mcDataLib]  the minecraft-data module (for the remap)
 */
export function fixToolMaterials(registry, mcDataLib) {
  const result = { remapped: 0, copper: 0 }
  const mats = registry?.materials
  const items = registry?.items
  const byName = registry?.itemsByName
  if (!mats || !items || !byName || registry._seiMaterialsFixed) return result

  let src = null
  if (mats[PROBE_TABLE] && !alignedWith(items, mats[PROBE_TABLE])) src = sourceItems(registry, mcDataLib)

  const out = {}
  for (const [key, table] of Object.entries(mats)) {
    if (!table || typeof table !== 'object') { out[key] = table; continue }
    const next = {}
    for (const [id, speed] of Object.entries(table)) {
      if (src) {
        const name = src[id]?.name
        const cur = name ? byName[name]?.id : null
        if (cur == null) continue
        next[cur] = speed
        if (String(cur) !== id) result.remapped++
      } else {
        next[id] = speed
      }
    }
    out[key] = next
  }

  for (const kind of TOOL_KINDS) {
    const copper = byName[`copper_${kind}`]?.id
    const stone = byName[`stone_${kind}`]?.id
    if (copper == null || stone == null) continue
    for (const table of Object.values(out)) {
      if (!table || typeof table !== 'object') continue
      if (table[copper] === 1 && table[stone] === 4) { table[copper] = COPPER_TOOL_SPEED; result.copper++ }
    }
  }

  registry.materials = out
  registry._seiMaterialsFixed = true
  return result
}
