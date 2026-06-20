// src/bot/adapter/minecraft/behaviors/craft.js
//
// craft(item, n) — craft N of a product item using mineflayer's built-in recipe
// API. Decisions in .planning/quick/260617-qhs CONTEXT.md:
//   - n is the number of the PRODUCT desired. Many recipes batch (1 log → 4
//     planks), so we craft ceil(n / batchSize) repetitions (may overshoot to the
//     batch boundary), capped by available materials, and report the ACTUAL
//     produced.
//   - No auto-walk. A 3×3 recipe needs a crafting_table in reach; if none is,
//     craft() fails with actionable guidance and the LLM moves itself (find/goTo)
//     or crafts a crafting_table first.
//
// Mirrors the timeout + abort race used across behaviors (container.js, equip.js).
import mcDataLib from 'minecraft-data'
import { reason } from '../../../brain/errStrings.js'
import { detectCraftingTable, maxRepetitions } from '../observers/craftable.js'

export const CRAFT_TIMEOUT_MS = 8000

function itemIdByName(bot, name) {
  try {
    return mcDataLib(bot.version)?.itemsByName?.[name]?.id ?? null
  } catch {
    return null
  }
}

function inventoryById(bot) {
  const out = new Map()
  const items = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []
  for (const it of items) {
    if (!it || typeof it.type !== 'number') continue
    out.set(it.type, (out.get(it.type) ?? 0) + (it.count ?? 0))
  }
  return out
}

function nameById(bot, id) {
  try { return mcDataLib(bot.version)?.items?.[id]?.name ?? `item_${id}` } catch { return `item_${id}` }
}

// What is the bot short on for the cheapest recipe of `item`? Uses recipesAll
// (inventory-independent) so we can name the gap even when nothing is craftable
// now — the old "not enough materials" left the model guessing, and it burned
// ~5 calls reverse-engineering that a stone pickaxe also needs sticks. Returns
// a "Nx name + Mx name" string, or '' if it can't tell. (260618)
function missingFor(bot, itemId, craftingTable) {
  let all = []
  try { all = bot.recipesAll?.(itemId, null, craftingTable ?? true) ?? [] } catch { all = [] }
  if (!all.length) return ''
  const inv = inventoryById(bot)
  let best = null
  for (const r of all) {
    const consumed = (r?.delta ?? []).filter((d) => d && d.count < 0)
    if (!consumed.length) continue
    const miss = []
    for (const c of consumed) {
      const have = inv.get(c.id) ?? 0
      const need = -c.count
      if (have < need) miss.push(`${need - have}x ${nameById(bot, c.id)}`)
    }
    if (best === null || miss.length < best.length) best = miss
  }
  return best && best.length ? best.join(' + ') : ''
}

// A recipe variant needs a crafting table when its shape doesn't fit the 2×2
// inventory grid: a shaped recipe taller/wider than 2, or a shapeless recipe
// with more than 4 ingredients. Mirrors prismarine-recipe's requiresTable
// derivation, computed straight from minecraft-data so this behavior depends
// only on minecraft-data (already imported across the adapter).
function variantNeedsTable(v) {
  if (Array.isArray(v?.inShape)) {
    const rows = v.inShape.length
    let cols = 0
    for (const row of v.inShape) if (Array.isArray(row)) cols = Math.max(cols, row.length)
    return rows > 2 || cols > 2
  }
  if (Array.isArray(v?.ingredients)) return v.ingredients.length > 4
  return false
}

// Why no craftable-now recipe? Inspect ALL recipe variants (inventory-independent)
// to tell the model whether it's a table-access problem or a materials problem.
function explainNoRecipe(bot, itemId, item, hadTable) {
  let variants = []
  try { variants = mcDataLib(bot.version)?.recipes?.[itemId] ?? [] } catch { variants = [] }
  if (variants.length === 0) return `can't craft ${item} (no crafting recipe)`
  // A recipe exists but none were craftable now. If every variant needs a table
  // and we weren't near one, that's the blocker; otherwise it's materials.
  const allNeedTable = variants.every(variantNeedsTable)
  if (allNeedTable && !hadTable) {
    return `can't craft ${item} here — it needs a crafting table. Go to a crafting_table (find/goTo one), or craft a crafting_table from planks first.`
  }
  const miss = missingFor(bot, itemId, hadTable)
  return miss
    ? `not enough materials to craft ${item} — need ${miss} (craft those first if they're craftable)`
    : `not enough materials to craft ${item}`
}

export async function craftAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const item = String(args?.item ?? '').trim()
  if (!item) return 'no item specified'
  const want = Math.max(1, Math.floor(Number(args?.count ?? 1)) || 1)

  const itemId = itemIdByName(bot, item)
  if (itemId == null) return `no item named ${item}`

  const tableBlock = detectCraftingTable(bot)

  let recipes
  try { recipes = bot.recipesFor(itemId, null, 1, tableBlock) } catch { recipes = null }
  if (!recipes || recipes.length === 0) {
    return explainNoRecipe(bot, itemId, item, tableBlock != null)
  }

  // Pick the craftable variant that yields the most per inventory.
  const invById = inventoryById(bot)
  let recipe = null
  let maxReps = 0
  for (const r of recipes) {
    const reps = maxRepetitions(r, invById)
    if (reps > maxReps) { maxReps = reps; recipe = r }
  }
  if (!recipe || maxReps <= 0) {
    const miss = missingFor(bot, itemId, tableBlock)
    return miss
      ? `not enough materials to craft ${item} — need ${miss} (craft those first if they're craftable)`
      : `not enough materials to craft ${item}`
  }

  const perRep = recipe.result?.count ?? 1
  const reps = Math.min(Math.ceil(want / perRep), maxReps)
  const produced = reps * perRep

  const timeoutMs = args?.timeout_ms ?? config?.craft_timeout_ms ?? CRAFT_TIMEOUT_MS

  const op = Promise.resolve(bot.craft(recipe, reps, tableBlock))
    .then(() => {
      const over = produced > want ? ` (recipe makes ${perRep} at a time)` : ''
      return `crafted ${produced} ${item}${over}`
    })
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot craft ${item}: ${r}` : `cannot craft ${item}`
    })

  const tmo = new Promise((r) => setTimeout(() => r(`timeout crafting ${item}`), timeoutMs))
  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })

  return Promise.race([op, tmo, abrt])
}
