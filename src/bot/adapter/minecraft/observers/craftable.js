// src/bot/adapter/minecraft/observers/craftable.js
//
// Per-tick "what can I craft right now" enumeration, surfaced in the world
// snapshot and shared with the craft() behavior.
//
// Design (locked in docs/design/craft-tool-260617.md):
//   - Built on mineflayer's recipe API — no extra dependency.
//       bot.recipesFor(id, meta, minCount, tableBlock): recipes craftable given
//       CURRENT inventory. tableBlock=null ⇒ 2×2 inventory grid only; a table
//       Block ⇒ 3×3 recipes too.
//   - The full enumeration is on the hot per-tick path, so it is CACHED at
//     module level (safe: one bot per utilityProcess) and recomputed only when
//     the inventory signature OR the crafting-table-in-range boolean changes.
//   - The bot only ever SEES the product (this list + the craft result), never
//     the ingredients — by design. The capability text tells the model crafting
//     consumes materials so it plans carefully.
//
// Defensive contract: every export swallows its own errors and degrades to an
// empty result. A snapshot tick must never throw because a bot stub lacks
// recipesFor / findBlock (unit-test bots do).

import mcDataLib from 'minecraft-data'
import { liveInventoryItems } from './liveInventory.js'

// Crafting-table interaction reach. Matches the reach gate the craft() behavior
// enforces, so the "you can craft 3×3 recipes" the snapshot advertises is
// exactly what craft() will accept.
export const CRAFT_TABLE_REACH = 4

// ── per-version memoized helpers ─────────────────────────────────────────────
// minecraft-data keyed by version string. Cheap to call repeatedly but we cache
// the heavier derived structures (the ingredient→results reverse index).
const _mcDataByVersion = new Map()
function mcData(bot) {
  const ver = bot?.version
  if (!ver) return null
  if (_mcDataByVersion.has(ver)) return _mcDataByVersion.get(ver)
  let d = null
  try { d = mcDataLib(ver) } catch { d = null }
  _mcDataByVersion.set(ver, d)
  return d
}

// ingredient item-id → Set(result item-ids). Lets us prune the candidate set to
// only recipes whose ingredients the bot actually holds, instead of probing all
// ~780 recipe outputs every recompute.
const _reverseIndexByVersion = new Map()
function reverseIndex(bot) {
  const ver = bot?.version
  if (!ver) return null
  if (_reverseIndexByVersion.has(ver)) return _reverseIndexByVersion.get(ver)
  const d = mcData(bot)
  const idx = new Map()
  try {
    const recipes = d?.recipes ?? {}
    for (const resultId of Object.keys(recipes)) {
      const rid = Number(resultId)
      for (const variant of recipes[resultId] ?? []) {
        for (const ing of ingredientIds(variant)) {
          let set = idx.get(ing)
          if (!set) { set = new Set(); idx.set(ing, set) }
          set.add(rid)
        }
      }
    }
  } catch { /* leave whatever we built; partial is fine */ }
  _reverseIndexByVersion.set(ver, idx)
  return idx
}

// Flatten a minecraft-data recipe variant's ingredient item-ids. Variants are
// either shapeless (`ingredients: [id|{id}]`) or shaped (`inShape: [[id|null]]`).
function ingredientIds(variant) {
  const out = []
  const push = (cell) => {
    if (cell == null) return
    const id = typeof cell === 'object' ? cell.id : cell
    if (typeof id === 'number' && id >= 0) out.push(id)
  }
  if (Array.isArray(variant?.ingredients)) {
    for (const c of variant.ingredients) push(c)
  }
  if (Array.isArray(variant?.inShape)) {
    for (const row of variant.inShape) {
      if (Array.isArray(row)) for (const c of row) push(c)
    }
  }
  return out
}

// ── inventory helpers ────────────────────────────────────────────────────────
function inventoryById(bot) {
  const out = new Map()
  const items = liveInventoryItems(bot)
  for (const it of items) {
    if (!it || typeof it.type !== 'number') continue
    out.set(it.type, (out.get(it.type) ?? 0) + (it.count ?? 0))
  }
  return out
}

// A stable signature of the inventory used as the cache key. Sorted so order
// changes don't bust the cache.
function inventorySig(invById) {
  return [...invById.entries()].sort((a, b) => a[0] - b[0]).map(([id, n]) => `${id}:${n}`).join(',')
}

// Max number of times `recipe` can be applied given inventory, from its delta
// (negative entries = consumed). Returns 0 if any ingredient is missing.
export function maxRepetitions(recipe, invById) {
  const consumed = (recipe?.delta ?? []).filter((d) => d && d.count < 0)
  if (consumed.length === 0) return 0
  let reps = Infinity
  for (const c of consumed) {
    const have = invById.get(c.id) ?? 0
    const need = -c.count
    if (need <= 0) continue
    reps = Math.min(reps, Math.floor(have / need))
  }
  return Number.isFinite(reps) ? reps : 0
}

// ── crafting-table detection ─────────────────────────────────────────────────
/**
 * Nearest crafting_table Block within reach, or null. Pass the returned Block to
 * bot.recipesFor / bot.craft to unlock 3×3 recipes.
 * @returns {import('prismarine-block').Block | null}
 */
export function detectCraftingTable(bot) {
  try {
    const d = mcData(bot)
    const id = d?.blocksByName?.crafting_table?.id
    if (id == null || typeof bot?.findBlock !== 'function') return null
    const point = bot.entity?.position
    const block = bot.findBlock({ matching: id, maxDistance: CRAFT_TABLE_REACH, point })
    return block ?? null
  } catch {
    return null
  }
}

/**
 * 261126 (O5, T554): the same yes/no as `detectCraftingTable(bot) != null`,
 * for the per-snapshot craftable list, without mineflayer's full section scan.
 *
 * Profiled on the reply path (local server, real bot, stub LLM): with a
 * crafting table in a nearby section, `bot.findBlock` walked every one of
 * that section's 4096 blocks through `bot.blockAt` (a Block object each) to
 * find one within 4 blocks. That was ~55% of the snapshot's CPU (400 of
 * 736 ms over 20 snapshots), and a snapshot is built before every LLM call.
 *
 * This visits exactly the sections mineflayer's findBlocks does for
 * maxDistance 4 (OctahedronIterator apothem 1: the feet section, then its 6
 * face neighbours; the one more it yields is 16+ blocks away), skips a
 * section on the same palette test, and then checks only the positions
 * within 4 blocks of the floored feet (mineflayer's distance test), with the
 * same `bot.blockAt(p, false)` type match. So it finds a table exactly when
 * findBlock does. It returns the FIRST table found, not the nearest: callers
 * only need whether one is in reach (recipesFor reads the table argument as
 * a boolean). craft() keeps detectCraftingTable, which it activates.
 *
 * Falls back to detectCraftingTable when the bot has no world to scan (stubs).
 * @returns {import('prismarine-block').Block | null}
 */
const FIND_SECTION_OFFSETS = [[0, 0, 0], [-1, 0, 0], [0, 0, -1], [0, -1, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0]]
export function craftingTableInReach(bot) {
  try {
    const world = bot?.world
    const game = bot?.game
    const pos = bot?.entity?.position
    if (typeof world?.getColumn !== 'function' || typeof bot?.blockAt !== 'function' || !pos ||
        !Number.isFinite(game?.minY) || !Number.isFinite(game?.height)) {
      return detectCraftingTable(bot)
    }
    const def = bot.registry?.blocksByName?.crafting_table ?? mcData(bot)?.blocksByName?.crafting_table
    if (!def || !Number.isFinite(def.minStateId) || !Number.isFinite(def.maxStateId)) return detectCraftingTable(bot)
    const R = CRAFT_TABLE_REACH
    const px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z)
    const sx = Math.floor(px / 16), sy = Math.floor(py / 16), sz = Math.floor(pz / 16)
    const yShift = Math.abs(game.minY >> 4)
    const totalSections = game.height >> 4
    const cursor = pos.clone ? pos.floored() : null
    if (!cursor) return detectCraftingTable(bot)
    for (const [ox, oy, oz] of FIND_SECTION_OFFSETS) {
      const cx = sx + ox, cy = sy + oy, cz = sz + oz
      const sectionY = cy + yShift
      if (sectionY < 0 || sectionY >= totalSections) continue
      const column = world.getColumn(cx, cz)
      if (!column) continue
      const section = column.sections?.[sectionY]
      if (!section) continue
      if (section.palette) {
        let has = false
        for (const stateId of section.palette) {
          if (stateId >= def.minStateId && stateId <= def.maxStateId) { has = true; break }
        }
        if (!has) continue
      }
      // This section's blocks within R of the feet (mineflayer's own bounds:
      // x/z = section * 16, y = sectionY * 16 + minY).
      const x0 = Math.max(cx * 16, px - R), x1 = Math.min(cx * 16 + 15, px + R)
      const yBase = sectionY * 16 + game.minY
      const y0 = Math.max(yBase, py - R), y1 = Math.min(yBase + 15, py + R)
      const z0 = Math.max(cz * 16, pz - R), z1 = Math.min(cz * 16 + 15, pz + R)
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const dx = x - px, dy = y - py, dz = z - pz
            if (Math.sqrt(dx * dx + dy * dy + dz * dz) > R) continue
            cursor.x = x; cursor.y = y; cursor.z = z
            const b = bot.blockAt(cursor, false)
            if (b && b.type === def.id) return bot.blockAt(cursor)
          }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// ── enumeration (cached) ─────────────────────────────────────────────────────
// Module-level cache. One bot per process, so a single slot is correct.
let _cache = { key: null, value: null }

/**
 * Everything the bot can craft right now.
 * @returns {{ entries: Array<{name:string, count:number}>, nearTable: boolean }}
 */
export function getCraftableEntries(bot) {
  try {
    const d = mcData(bot)
    if (!d || typeof bot?.recipesFor !== 'function') return { entries: [], nearTable: false }

    // 261126: same answer as detectCraftingTable, a fraction of the scan.
    const tableBlock = craftingTableInReach(bot)
    const nearTable = tableBlock != null
    const invById = inventoryById(bot)
    const key = `${bot.version}|${nearTable ? 'T' : 'F'}|${inventorySig(invById)}`
    if (_cache.key === key && _cache.value) return _cache.value

    const idx = reverseIndex(bot)
    // Candidate result-ids: outputs of any recipe that uses an item we hold.
    const candidates = new Set()
    for (const heldId of invById.keys()) {
      const results = idx?.get(heldId)
      if (results) for (const r of results) candidates.add(r)
    }

    const entries = []
    for (const resultId of candidates) {
      let recipes
      try { recipes = bot.recipesFor(resultId, null, 1, tableBlock) } catch { recipes = null }
      if (!recipes || recipes.length === 0) continue
      // Best (most productive) achievable count across craftable variants.
      let best = 0
      for (const r of recipes) {
        const reps = maxRepetitions(r, invById)
        if (reps <= 0) continue
        const produced = reps * (r.result?.count ?? 1)
        if (produced > best) best = produced
      }
      if (best <= 0) continue
      const name = d.items?.[resultId]?.name ?? `item_${resultId}`
      entries.push({ name, count: best })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    const value = { entries, nearTable }
    _cache = { key, value }
    return value
  } catch {
    return { entries: [], nearTable: false }
  }
}

// Test seam: drop the memoized cache so a test can assert recompute behavior.
export function __resetCraftableCache() {
  _cache = { key: null, value: null }
}
