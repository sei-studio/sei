// src/bot/adapter/minecraft/behaviors/craft.js
//
// craft(item, n) — craft N of a product item using mineflayer's built-in recipe
// API. Decisions in docs/design/craft-tool-260617.md:
//   - n is the number of the PRODUCT desired. Many recipes batch (1 log → 4
//     planks), so we craft ceil(n / batchSize) repetitions (may overshoot to the
//     batch boundary), capped by available materials, and report the ACTUAL
//     produced.
//   - 261011: walks to a crafting_table within 16 blocks and crafts missing
//     parts first (see "Crafting the parts first"). Before that: no auto-walk.
//     A 3×3 recipe needs a crafting_table in reach; if none is,
//     craft() fails with actionable guidance and the LLM moves itself (find/goTo)
//     or crafts a crafting_table first.
//
// Mirrors the timeout + abort race used across behaviors (container.js, equip.js).
import mcDataLib from 'minecraft-data'
import { reason } from '../../../brain/errStrings.js'
import { detectCraftingTable, maxRepetitions } from '../observers/craftable.js'
import { recordOwnStation } from '../observers/ownStations.js'
import { goTo } from './pathfind.js'
import { digReachDistance, DIG_REACH } from './dig.js'
import { liveInventoryItems, liveCount, hasLiveInventory, waitInventoryQuiet } from '../observers/liveInventory.js'

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
  const items = liveInventoryItems(bot)
  for (const it of items) {
    if (!it || typeof it.type !== 'number') continue
    out.set(it.type, (out.get(it.type) ?? 0) + (it.count ?? 0))
  }
  return out
}

function nameById(bot, id) {
  try { return mcDataLib(bot.version)?.items?.[id]?.name ?? `item_${id}` } catch { return `item_${id}` }
}

// What is the bot short on for the closest recipe of `item`? Uses recipesAll
// (inventory-independent) so we can name the gap even when nothing is craftable
// now. The old "not enough materials" left the model guessing, and it burned
// ~5 calls reverse-engineering that a stone pickaxe also needs sticks. Returns
// a "N more name + M more name" string, or '' if it can't tell. (260618)
//
// 261011: the closest variant is the one with the fewest missing ingredient
// kinds, then the fewest missing items. Ranking by kinds alone tied every
// wood variant, so a bot holding 2 oak_planks was told it needed
// "4x cherry_planks". Each missing ingredient also says how many the bot
// has and whether it can be crafted from the inventory right now.
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
    let total = 0
    let makeable = 0
    for (const c of consumed) {
      const have = inv.get(c.id) ?? 0
      const need = -c.count
      if (have < need) {
        miss.push({ id: c.id, have, short: need - have })
        total += need - have
        if (canCraftNow(bot, c.id, craftingTable)) makeable++
      }
    }
    // Ties (every wood variant short the same planks) go to the variant whose
    // missing parts can be crafted from the bag: oak_planks for a bag of oak
    // logs, not the first wood in the recipe list (261011).
    const better = best === null ||
      miss.length < best.miss.length ||
      (miss.length === best.miss.length && makeable > best.makeable) ||
      (miss.length === best.miss.length && makeable === best.makeable && total < best.total)
    if (better) best = { miss, total, makeable }
  }
  if (!best || !best.miss.length) return ''
  return best.miss.map((m) => {
    const name = nameById(bot, m.id)
    const parts = []
    if (m.have > 0) parts.push(`have ${m.have}`)
    if (canCraftNow(bot, m.id, craftingTable)) parts.push('you can craft it from what you have')
    return `${m.short} more ${name}${parts.length ? ` (${parts.join(', ')})` : ''}`
  }).join(' + ')
}

function canCraftNow(bot, itemId, craftingTable) {
  try {
    const rs = bot.recipesFor?.(itemId, null, 1, craftingTable ?? null)
    return Array.isArray(rs) && rs.length > 0
  } catch {
    return false
  }
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
    ? `not enough materials to craft ${item}: need ${miss}`
    : `not enough materials to craft ${item}`
}

// ── Crafting the parts first (261011) ───────────────────────────────────────
// Asked for a wooden_pickaxe with only logs in the bag, craft used to answer
// "need 3 more oak_planks + 2 more stick (you can craft it from what you
// have)" and the model then spent two or three more calls (and as many
// failures) on planks and sticks; in the eval it often asked for the wrong
// wood. A player saying "make a pickaxe" expects the planks and sticks to
// happen on the way. So when the item cannot be crafted from the bag as is,
// craft plans the missing parts from minecraft-data's recipes against a
// simulated inventory (at most MAX_PART_DEPTH levels: logs -> planks ->
// sticks) and crafts them first. Only plain parts: it never spends a table
// it does not have, and the plan is all-or-nothing, so nothing is crafted
// unless the whole chain fits the bag.
export const MAX_PART_DEPTH = 2
const PART_MAX_STEPS = 6

function recipeVariants(bot, itemId) {
  try { return mcDataLib(bot.version)?.recipes?.[itemId] ?? [] } catch { return [] }
}

function variantIngredients(v) {
  const tally = new Map()
  const add = (x) => {
    const id = typeof x === 'number' ? x : (x && typeof x.id === 'number' ? x.id : null)
    if (id == null || id < 0) return
    tally.set(id, (tally.get(id) ?? 0) + 1)
  }
  if (Array.isArray(v?.inShape)) for (const row of v.inShape) for (const x of (row ?? [])) add(x)
  else if (Array.isArray(v?.ingredients)) for (const x of v.ingredients) add(x)
  return tally
}

/**
 * Plan to have `need` of itemId in the simulated inventory `inv` (mutated on
 * success). Returns the craft steps in order ([] when the bag already has
 * them), or null when it cannot be done from the bag within `depth` levels.
 */
export function planParts(bot, itemId, need, inv, depth, hasTable) {
  const have = inv.get(itemId) ?? 0
  if (have >= need) { inv.set(itemId, have - need); return [] }
  if (depth <= 0) return null
  const short = need - have
  for (const v of recipeVariants(bot, itemId)) {
    if (variantNeedsTable(v) && !hasTable) continue
    const perRep = v?.result?.count ?? 1
    const reps = Math.ceil(short / perRep)
    const sim = new Map(inv)
    sim.set(itemId, 0)
    const steps = []
    let ok = true
    for (const [ingId, n] of variantIngredients(v)) {
      const sub = planParts(bot, ingId, n * reps, sim, depth - 1, hasTable)
      if (!sub) { ok = false; break }
      steps.push(...sub)
    }
    if (!ok) continue
    sim.set(itemId, (sim.get(itemId) ?? 0) + reps * perRep - short)
    for (const k of [...inv.keys()]) if (!sim.has(k)) inv.delete(k)
    for (const [k, val] of sim) inv.set(k, val)
    return [...steps, { id: itemId, reps, perRep }]
  }
  return null
}

function craftWithTimeout(bot, recipe, reps, table, timeoutMs, signal) {
  const op = Promise.resolve().then(() => bot.craft(recipe, reps, table)).then(() => 'ok').catch((err) => reason(err) || 'failed')
  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))
  const abrt = new Promise((r) => {
    if (!signal) return
    if (signal.aborted) return r('aborted')
    signal.addEventListener('abort', () => r('aborted'), { once: true })
  })
  return Promise.race([op, tmo, abrt])
}

// 261012 (quality pass 5): window clicks are not confirmed on 1.17+, so
// bot.craft resolves on the client's own prediction and the server can undo
// the craft 50-500 ms later (materials back in the bag, no product). The eval
// had "crafted 1 crafting_table" and then "no crafting_table in inventory"
// 1.3 s later, several times in a row. So: wait for slot updates to stop
// before crafting (a gather's pickups still landing make the server reject
// the clicks), wait again after, and count what actually arrived.
const SETTLE_BEFORE = { quietMs: 200, maxMs: 1000 }
const SETTLE_AFTER = { quietMs: 300, minMs: 400, maxMs: 2000 }
const withSignal = (o, signal) => ({ ...o, signal })

/** Craft the planned part steps, in order. Returns the made list or an error. */
async function craftParts(bot, steps, table, timeoutMs, signal) {
  const made = []
  for (const st of steps) {
    if (signal?.aborted) return { error: 'aborted', made }
    const name = nameById(bot, st.id)
    let recipes = []
    try { recipes = bot.recipesFor(st.id, null, 1, table) ?? [] } catch { recipes = [] }
    const inv = inventoryById(bot)
    const recipe = recipes.find((r) => maxRepetitions(r, inv) >= st.reps) ?? null
    if (!recipe) return { error: `could not craft the ${name} it needs`, made }
    const r = await craftWithTimeout(bot, recipe, st.reps, table, timeoutMs, signal)
    if (r !== 'ok') return { error: r === 'aborted' ? 'aborted' : `crafting ${name} failed (${r})`, made }
    // 261012: let the server's answer land before the next step reads the bag.
    if (await waitInventoryQuiet(bot, withSignal(SETTLE_AFTER, signal)) === 'aborted') return { error: 'aborted', made }
    made.push(`${st.reps * st.perRep} ${name}`)
  }
  return { error: null, made }
}

// A crafting table the bot can walk to when none is in reach. 261011: the
// model was told "it needs a crafting table, go to one" with a table eight
// blocks away, and goTo then timed out. craft walks there itself.
const TABLE_WALK_RADIUS = 16
const TABLE_WALK_TIMEOUT_MS = 8000

function nearbyCraftingTable(bot) {
  try {
    const tid = mcDataLib(bot.version)?.blocksByName?.crafting_table?.id
    if (tid == null || typeof bot?.findBlock !== 'function') return null
    return bot.findBlock({ matching: tid, maxDistance: TABLE_WALK_RADIUS }) ?? null
  } catch {
    return null
  }
}

function allVariantsNeedTable(bot, itemId) {
  const vs = recipeVariants(bot, itemId)
  return vs.length > 0 && vs.every(variantNeedsTable)
}

function holdsCraftingTable(bot) {
  try {
    return liveInventoryItems(bot).some((it) => it?.name === 'crafting_table')
  } catch {
    return false
  }
}

// 261011 (quality pass 2): "crafted 1 crafting_table" read as "the table is
// down": in the eval she told the player a crafted table or furnace was
// placed three times while it sat in her bag. Say where it is.
const PLACEABLE_STATIONS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'bed', 'white_bed'])
export function placeNote(item) {
  if (!PLACEABLE_STATIONS.has(item) && !/_bed$/.test(item)) return ''
  return `; it is in your inventory, not placed yet (placeBlock ${item} to put it down)`
}

export async function craftAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const item = String(args?.item ?? '').trim()
  if (!item) return 'no item specified'
  const want = Math.max(1, Math.floor(Number(args?.count ?? 1)) || 1)

  const itemId = itemIdByName(bot, item)
  if (itemId == null) return `no item named ${item}`

  let tableBlock = detectCraftingTable(bot)
  const timeoutMs = args?.timeout_ms ?? config?.craft_timeout_ms ?? CRAFT_TIMEOUT_MS

  // Needs a table and none is in reach: walk to one that is close by.
  if (!tableBlock && allVariantsNeedTable(bot, itemId)) {
    const near = nearbyCraftingTable(bot)
    if (near?.position) {
      const p = near.position
      const walk = await goTo(bot, p.x, p.y, p.z, 2, TABLE_WALK_TIMEOUT_MS, signal, { reach: 3.5 })
      if (walk === 'aborted' || signal?.aborted) return 'aborted'
      tableBlock = detectCraftingTable(bot)
      // 261025 (pass 27): detectCraftingTable measures from the feet (4m), the
      // walk from the eyes. A walk that "reached" a table on a ledge or in a
      // dip could still fail the feet test; the table is usable from the eyes.
      if (!tableBlock && digReachDistance(bot, p) <= DIG_REACH) {
        const live = bot.blockAt?.(p)
        if (live?.name === 'crafting_table') tableBlock = live
      }
      if (!tableBlock) {
        return `can't craft ${item}: it needs a crafting table, and the walk to the one at ${p.x},${p.y},${p.z} did not get there (${walk})`
      }
    } else if (holdsCraftingTable(bot)) {
      return `can't craft ${item} here: it needs a crafting table, and there is none in reach. You have one in your inventory: place it (placeBlock crafting_table), then craft`
    }
  }

  let recipes
  try { recipes = bot.recipesFor(itemId, null, 1, tableBlock) } catch { recipes = null }
  let partsMade = []
  if (!recipes || recipes.length === 0) {
    // Not craftable from the bag as is: make the parts first if they fit.
    // 261025 (pass 27): the plan is for `want` MORE of the item, so the copies
    // already in the bag must not count. Counting them made the top step
    // "already have it" and dropped the part steps it needed: with a wooden
    // pickaxe in the bag, a second one came back "need 2 more stick" while
    // the planks for the sticks were right there.
    const planInv = inventoryById(bot)
    planInv.set(itemId, 0)
    const steps = planParts(bot, itemId, want, planInv, MAX_PART_DEPTH + 1, tableBlock != null)
    if (!steps || steps.length < 2 || steps.length > PART_MAX_STEPS) {
      return explainNoRecipe(bot, itemId, item, tableBlock != null)
    }
    const res = await craftParts(bot, steps.slice(0, -1), tableBlock, timeoutMs, signal)
    if (res.error === 'aborted') return 'aborted'
    const madeNote = res.made.length ? ` (made ${res.made.join(', ')} first)` : ''
    if (res.error) return `can't craft ${item}: ${res.error}${madeNote}`
    partsMade = res.made
    try { recipes = bot.recipesFor(itemId, null, 1, tableBlock) } catch { recipes = null }
    if (!recipes || recipes.length === 0) {
      return `${explainNoRecipe(bot, itemId, item, tableBlock != null)}${madeNote}`
    }
  }
  const partsNote = partsMade.length ? `, made ${partsMade.join(', ')} for it first` : ''

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
      ? `not enough materials to craft ${item}: need ${miss}`
      : `not enough materials to craft ${item}`
  }

  const perRep = recipe.result?.count ?? 1
  const reps = Math.min(Math.ceil(want / perRep), maxReps)
  const produced = reps * perRep
  const over = produced > want ? ` (recipe makes ${perRep} at a time)` : ''

  // Without a live inventory (test fakes) there is nothing to wait on or
  // count, so report the craft as mineflayer did.
  const live = hasLiveInventory(bot)
  if (live && await waitInventoryQuiet(bot, withSignal(SETTLE_BEFORE, signal)) === 'aborted') return 'aborted'
  const before = liveCount(bot, itemId)

  const first = await craftWithTimeout(bot, recipe, reps, tableBlock, timeoutMs, signal)
  if (first === 'aborted') return 'aborted'
  if (first === 'timeout') return `timeout crafting ${item}`
  if (first !== 'ok') return first === 'failed' ? `cannot craft ${item}` : `cannot craft ${item}: ${first}`
  // 261017 (pass 14b): a table she crafted at counts as hers for the spine.
  if (tableBlock?.position) recordOwnStation(bot, 'crafting_table', tableBlock.position)
  if (!live) return `crafted ${produced} ${item}${over}${partsNote}${placeNote(item)}`

  if (await waitInventoryQuiet(bot, withSignal(SETTLE_AFTER, signal)) === 'aborted') return 'aborted'
  let got = liveCount(bot, itemId) - before
  let retried = false
  if (got < produced) {
    // The server undid some or all of it. Try once more for what is missing,
    // from what the bag holds now.
    let again = []
    try { again = bot.recipesFor(itemId, null, 1, tableBlock) ?? [] } catch { again = [] }
    const inv = inventoryById(bot)
    const r2 = again.find((r) => maxRepetitions(r, inv) > 0) ?? null
    const reps2 = r2 ? Math.min(Math.ceil((produced - got) / (r2.result?.count ?? 1)), maxRepetitions(r2, inv)) : 0
    if (reps2 > 0) {
      retried = true
      const second = await craftWithTimeout(bot, r2, reps2, tableBlock, timeoutMs, signal)
      if (second === 'aborted') return 'aborted'
      if (await waitInventoryQuiet(bot, withSignal(SETTLE_AFTER, signal)) === 'aborted') return 'aborted'
      got = liveCount(bot, itemId) - before
    }
  }
  const have = liveCount(bot, itemId)
  if (got <= 0) {
    return `the craft of ${item} did not go through: the server put the materials back${retried ? ' twice' : ''}, and you have ${have} ${item}. Check your inventory and try craft again`
  }
  if (got < produced) {
    return `crafted ${got} ${item}, not ${produced}: the server undid the rest (you have ${have} ${item})${partsNote}${placeNote(item)}`
  }
  return `crafted ${got} ${item}${over}${partsNote}${placeNote(item)}`
}
