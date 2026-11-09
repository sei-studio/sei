// src/bot/adapter/minecraft/observers/progression.js
//
// 17-04: the spine DAG is now EXTERNALIZED to progression.json (D-04/D-07) —
// the static progression-graph layer of the hybrid hierarchy. The graph is
// data, not a GOAP planner; this file loads it, derives its maps, and walks it
// (computeProgression / matchGoalToNode / nextMilestone). The live bot reader
// stays here. Each node MAY carry two optional fields beyond the original
// id/kind/label/key/needs/goal: `next_action` (a terse advancing-action phrase
// for the per-turn `next:` advisory line) and `procedure` (a terse known-good
// procedure recorded to per-world memory when the milestone completes, D-08).
//
// The MINIMAL vanilla progression spine — the critical path from an empty
// inventory to a dead Ender Dragon — plus the frontier computation that surfaces
// "what's reachable next" to the brain.
//
// What this is (and isn't):
//   - It is a hand-authored dependency DAG of the ~16 milestones on the win
//     path (get wood → tools → iron → diamond → nether → eyes → end → dragon).
//     Crafting micro-steps (planks, sticks) are NOT nodes — they are HOW the bot
//     reaches a milestone, handled by the live craftable: list + the craft tool.
//   - It is NOT a goal generator and NOT a behaviour script. It only answers
//     "which milestones are reachable RIGHT NOW", as a constraint on selection.
//     Villages, taming, building, exploring for its own sake are deliberately
//     OFF the graph — those are emergent, personality-driven, not progression.
//
// Two ideas make it correct rather than naive:
//   1. Live predicates, not latched gear. `have(item)` / pickaxe-tier / dimension
//      are re-read from the live bot every call, so losing a tool re-opens the
//      milestone that needs it (self-correcting) — see computeProgression.
//   2. Monotonic-progress closure. A prerequisite counts as done if its own
//      predicate holds OR any milestone that REQUIRED it is already done. This
//      is what stops the "consumption gotcha": crafting your diamonds into a
//      diamond pickaxe (or spending obsidian/eyes building a portal) must NOT
//      re-open "get diamonds" just because the raw item left your inventory.
//
// Defensive contract (mirrors craftable.js): readProgressionState swallows its
// own errors and degrades to an empty state, so a snapshot tick never throws on
// a stub bot.

import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { liveInventoryItems } from './liveInventory.js'
import { OWN_STATIONS, ownStationPositions } from './ownStations.js'

// Pickaxe material → tool tier. A milestone gated on `pickaxe: N` is satisfied
// when the bot's BEST pickaxe is tier ≥ N. Gold mines like wood, so it is tier 1.
const PICKAXE_TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

// ── The spine ────────────────────────────────────────────────────────────────
// The spine literal lives in progression.json (D-04/D-07). Each node:
//   { id, kind, label, key, needs[], goal, next_action?, procedure? }
//   kind  — general action category: 'get' | 'enter' | 'defeat'. (discover() is
//           folded into get(): "blaze rods" implies finding a fortress, so the
//           node is just get(blaze_rod), checkable from inventory — no separate
//           discover node to track.)
//   label — short, plain LLM-facing phrasing of the milestone (no flourish).
//   key   — the salient noun used to link a free-text setGoal back to this node.
//   needs — prerequisite node ids (the DAG edges).
//   goal  — the completion predicate, evaluated against live state:
//             { have, count? }       inventory holds ≥count of an exact item
//             { haveSuffix, count? }  inventory holds ≥count of any item whose
//                                     name ends with the suffix (e.g. '_log')
//             { pickaxe }            best pickaxe tier ≥ this
//             { dim }                current dimension is this (or has been —
//                                     latched via flags.entered_*)
//             { flag }               a latched one-way flag (e.g. killed_dragon)
//   next_action — terse advancing-action phrase for the `next:` advisory line.
//   procedure   — terse known-good procedure recorded to memory on completion.
//
// Defensive contract (mirrors readProgressionState): a missing/malformed
// progression.json degrades to an EMPTY spine rather than throwing, so a module
// import or snapshot tick never crashes on a bad asset.
export function loadSpine(url) {
  try {
    const arr = JSON.parse(readFileSync(url, 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export const SPINE = loadSpine(new URL('./progression.json', import.meta.url))

const SPINE_BY_ID = new Map(SPINE.map(n => [n.id, n]))
// id → ids of nodes that list it in `needs` (its successors on the path forward).
const SUCCESSORS = new Map(SPINE.map(n => [n.id, []]))
for (const n of SPINE) for (const p of n.needs) SUCCESSORS.get(p)?.push(n.id)

function dimShort(dim) {
  return dim === 'the_nether' ? 'nether' : dim === 'the_end' ? 'end' : 'overworld'
}

// Does a node's OWN predicate hold against the current state?
function rawDone(node, state) {
  const g = node.goal
  const items = state.items ?? {}
  if (g.have) {
    if ((items[g.have] ?? 0) >= (g.count ?? 1)) return true
    // 261017 (pass 14): a station she placed (or used) nearby counts as had. Placing
    // the furnace emptied the inventory predicate, and the next: line went
    // back to "make a furnace... You have 0 cobblestone".
    return (g.count ?? 1) <= 1 && !!state.placed?.[g.have]
  }
  if (g.haveSuffix) {
    let total = 0
    for (const [name, c] of Object.entries(items)) if (name.endsWith(g.haveSuffix)) total += c
    return total >= (g.count ?? 1)
  }
  if (g.pickaxe) return (state.pickaxeTier ?? 0) >= g.pickaxe
  if (g.dim) return state.dim === g.dim || !!state.flags?.[`entered_${dimShort(g.dim)}`]
  if (g.flag) return !!state.flags?.[g.flag]
  return false
}

/**
 * Compute the progression view for a normalized state.
 *
 * @param {{ items?: Record<string,number>, pickaxeTier?: number, dim?: string,
 *           flags?: Record<string,boolean> }} state
 * @returns {{
 *   done: Set<string>,            // effective-done ids (raw OR implied by a done successor)
 *   raw: Set<string>,            // ids whose own predicate currently holds
 *   frontier: Array<object>,     // not-done nodes whose needs are all done (spine order)
 *   currentMilestone: object|null,  // first frontier node (the nearest rung)
 *   furthest: object|null,       // deepest done node (rough "where you are")
 *   complete: boolean,           // dragon done
 *   spine: Array<object>,        // every node, spine order
 * }}
 */
export function computeProgression(state = {}) {
  const raw = new Set(SPINE.filter(n => rawDone(n, state)).map(n => n.id))
  // Monotonic closure: a node is done if its predicate holds OR any successor is
  // done (you cannot have completed a milestone without its prerequisites). This
  // makes progress one-way against item CONSUMPTION while leaving raw predicates
  // self-correcting against item LOSS up to the deepest milestone reached.
  const done = new Set(raw)
  let changed = true
  while (changed) {
    changed = false
    for (const n of SPINE) {
      if (done.has(n.id)) continue
      if ((SUCCESSORS.get(n.id) ?? []).some(s => done.has(s))) { done.add(n.id); changed = true }
    }
  }
  const frontier = SPINE.filter(n => !done.has(n.id) && n.needs.every(p => done.has(p)))
  let furthest = null
  for (const n of SPINE) if (done.has(n.id)) furthest = n
  return {
    done,
    raw,
    frontier,
    currentMilestone: frontier[0] ?? null,
    furthest,
    complete: done.has('dragon'),
    spine: SPINE,               // the whole node list (goal linking, goalLink.js)
  }
}

/**
 * Link a free-text setGoal back to a spine node by matching its `key` against
 * the goal text. Only the supplied candidate nodes are considered (normally the
 * current frontier), and the LONGEST matching key wins so "diamond pickaxe"
 * beats the bare "diamond". Returns the node or null.
 */
export function matchGoalToNode(goalText, candidates = SPINE) {
  const t = String(goalText ?? '').toLowerCase()
  if (!t) return null
  let best = null
  for (const n of candidates) {
    const k = n.key.toLowerCase()
    if (t.includes(k) && (!best || k.length > best.key.length)) best = n
  }
  return best
}

/**
 * The nearest milestone + the single action that advances it (D-07). This is
 * the static-graph walker that supersedes a GOAP planner: given the live state
 * (and an optional free-text goal), it returns the frontier node the goal names
 * — when the goal matches a reachable frontier node — otherwise the current
 * milestone (frontier[0]). `action` is the node's `next_action` advisory phrase
 * (falling back to its `label`, then null when the game is complete).
 *
 * @param {object} state  normalized progression state (see computeProgression)
 * @param {string} [goal] optional free-text goal to bias the pick
 * @returns {{ node: object|null, action: string|null }}
 */
export function nextMilestone(state = {}, goal) {
  const prog = computeProgression(state)
  const node = matchGoalToNode(goal, prog.frontier) ?? prog.currentMilestone ?? null
  return { node, action: node?.next_action ?? node?.label ?? null }
}

// 261012 (pass 4a): the recipe for the next milestone and what she holds of
// each part, for the `next:` line. In the eval she told the player she had
// "enough for a stone pickaxe" while holding 2 cobblestone: nothing in her
// state said how many it takes. `planks` counts any *_planks. Sticks and
// planks are noted as makeable from logs, since craft() makes those parts on
// the way. Returns '' when the node has no recipe.
export function recipeNote(node, items = {}) {
  const recipe = node?.recipe
  if (!recipe || typeof recipe !== 'object') return ''
  const count = (name) => {
    let n = 0
    for (const [k, v] of Object.entries(items ?? {})) {
      if (name === 'planks' ? k.endsWith('_planks') : k === name) n += Number(v) || 0
    }
    return n
  }
  // Item ids as the inventory line spells them; only stick reads oddly bare.
  const plural = (name, n) => (name === 'stick' && n !== 1 ? 'sticks' : name)
  const parts = Object.entries(recipe).map(([name, n]) => `${n} ${plural(name, n)}`)
  const station = node.station ? ` at a ${node.station.replace(/_/g, ' ')}` : ''
  const held = Object.keys(recipe).map((name) => { const n = count(name); return `${n} ${plural(name, n)}` })
  let note = `Recipe: ${parts.join(' + ')}${station}. You have ${held.join(', ')}`
  const wood = logsForRecipe(node, items)
  if (wood) {
    const { logs, need } = wood
    if (!('planks' in recipe)) note += `, ${count('planks')} planks`
    note += `, ${logs} ${logs === 1 ? 'log' : 'logs'} (craft makes planks from logs and sticks from planks on the way: 1 log is 4 planks, 2 planks are 4 sticks)`
    // 261018 (pass 17): the total. work_session-02 (pass 15 eval) read
    // "0 planks, 0 sticks, 7 logs" for the wooden pickaxe, gave the player 6
    // of the 7 logs while saying "i'm making the pickaxe", then called craft
    // with 1 log and it failed. Nothing said the pickaxe takes 2.
    // The pass 17 eval then cut mine_stone from 5/5 to 3/5: "what is missing
    // takes 1 log ... so you need 1 more first" on the stone pickaxe read as
    // logs before anything else, and asked for 10 stone with a wooden pickaxe
    // in hand she went for logs (the pass 4a failure again). The note now
    // names the wood parts and gives the two totals with no shortfall clause
    // (pass17-probe mine_ask: 3/8 with it, 7/8 with "before you can craft
    // it", 7/8 with totals only and the miss an explore() for stone;
    // give_then_ask stayed 8/8).
    const logWord = need === 1 ? 'log' : 'logs'
    if (need > 0) {
      const { planks } = woodHeld(items)
      const wanted = [(recipe.planks ?? 0) > planks && 'planks', stickShort(recipe, items) > 0 && 'sticks'].filter(Boolean).join(' and ')
      note += `. The ${wanted} for it take ${need} ${logWord}, and you have ${logs}`
    }
  }
  return `${note}.`
}

function woodHeld(items = {}) {
  let planks = 0
  let sticks = 0
  let logs = 0
  for (const [k, v] of Object.entries(items ?? {})) {
    const n = Number(v) || 0
    if (k.endsWith('_planks')) planks += n
    else if (k === 'stick') sticks += n
    else if (k.endsWith('_log') || k.endsWith('_stem')) logs += n
  }
  return { planks, sticks, logs }
}
const stickShort = (recipe, items) => Math.max(0, (recipe.stick ?? 0) - woodHeld(items).sticks)
// Planks still to make, counting the ones the missing sticks take.
const planksShort = (recipe, items) => {
  const { planks } = woodHeld(items)
  const demand = (recipe.planks ?? 0) + Math.ceil(stickShort(recipe, items) / STICKS_PER_CRAFT) * PLANKS_PER_STICK_CRAFT
  return Math.max(0, demand - planks)
}

const PLANKS_PER_LOG = 4
const STICKS_PER_CRAFT = 4
const PLANKS_PER_STICK_CRAFT = 2

/**
 * 261018 (pass 17): how many logs the rest of a recipe takes when its planks
 * or sticks are short, counting the planks and sticks already held. Null when
 * the recipe has neither part or both are covered.
 *
 * @returns {{ need: number, logs: number } | null}
 */
export function logsForRecipe(node, items = {}) {
  const recipe = node?.recipe
  if (!recipe || typeof recipe !== 'object') return null
  const { planks, logs } = woodHeld(items)
  if (stickShort(recipe, items) === 0 && planks >= (recipe.planks ?? 0)) return null
  const need = Math.ceil(planksShort(recipe, items) / PLANKS_PER_LOG)
  return { need, logs }
}

/**
 * 261018 (pass 17): what a hand-over leaves short for her next milestone, for
 * the give result. Only when the given item feeds that recipe (the item
 * itself, or wood that becomes its planks or sticks) and she no longer has
 * enough. '' otherwise.
 */
export function nextNeedAfterGive(node, items = {}, given = '') {
  const recipe = node?.recipe
  if (!recipe || typeof recipe !== 'object' || !given) return ''
  const label = node.label ?? 'your next step'
  const isWood = given.endsWith('_log') || given.endsWith('_stem') || given.endsWith('_planks') || given === 'stick'
  if (isWood && ('planks' in recipe || 'stick' in recipe)) {
    const wood = logsForRecipe(node, items)
    if (wood && wood.need > wood.logs) {
      // 261109 (pass 48): the other parts she is short of too. "get an iron
      // pickaxe takes 1 log" read as the whole recipe, and she told the
      // player one more log would make her an iron pickaxe with no iron.
      const rest = Object.entries(recipe)
        .filter(([k, n]) => k !== 'planks' && k !== 'stick' && (Number(items?.[k]) || 0) < n)
        .map(([k, n]) => `${n} ${k} (you have ${Number(items?.[k]) || 0})`)
      const logs = `${wood.need} ${wood.need === 1 ? 'log' : 'logs'}`
      if (rest.length) return `your next step (${label}) takes ${logs} for its planks and sticks and you have ${wood.logs}, and it also takes ${rest.join(' and ')}`
      return `your next step (${label}) takes ${logs} to make and you have ${wood.logs}, so you need ${wood.need - wood.logs} more for it`
    }
    return ''
  }
  if (given in recipe) {
    const have = Number(items?.[given]) || 0
    if (have < recipe[given]) {
      return `your next step (${label}) takes ${recipe[given]} ${given} and you have ${have}, so you need ${recipe[given] - have} more for it`
    }
  }
  return ''
}

// 261012 (pass 4a): what her best pickaxe can mine, for the snapshot line
// under the inventory. Asked for 10 stone while holding a wooden pickaxe she
// said "i need a stone pickaxe first" and went for wood; the tool-tier facts
// sat in the cached prompt, far from the inventory she was reading.
const PICKAXE_REACH = [
  'none, so stone and ore drop nothing when dug',
  'mines stone (it drops cobblestone) and coal ore. Iron, copper and lapis ore need a stone pickaxe',
  'mines stone, coal, iron, copper and lapis ore. Diamond, gold, redstone and emerald ore need an iron pickaxe',
  'mines every ore. Obsidian needs a diamond pickaxe',
  'mines every ore and obsidian',
]
export function pickaxeLine(items = {}) {
  let best = null
  let tier = 0
  for (const name of Object.keys(items ?? {})) {
    if (!name.endsWith('_pickaxe') || !(Number(items[name]) > 0)) continue
    const t = PICKAXE_TIER[name.slice(0, -'_pickaxe'.length)] ?? 0
    if (t > tier) { tier = t; best = name }
  }
  if (!best) return `pickaxe: ${PICKAXE_REACH[0]}.`
  return `pickaxe: ${best} ${PICKAXE_REACH[Math.min(tier, 4)]}.`
}

// 261012 (pass 4a): what she left cooking. The snapshot does not open the
// furnace, and the eval saw her take 1 of 3 ingots, then walk off to her own
// goal (the inventory line lagged and no line said anything was still in the
// furnace). Built from the last furnace action's view, with its age.
export function furnaceLine(rec, now = Date.now()) {
  if (!rec || !(rec.input || rec.output) || !Array.isArray(rec.pos)) return null
  const ageS = Math.max(0, Math.round((now - (rec.t ?? now)) / 1000))
  if (ageS > 600) return null
  const held = [rec.input && `${rec.input} cooking`, rec.output && `${rec.output} done and not taken`].filter(Boolean).join(', ')
  const cook = rec.input ? ' (each item takes about 10s to cook)' : ''
  return `furnace @${rec.pos.join(',')}: ${held} when you checked ${ageS}s ago${cook}; takeSmelted at the furnace collects what is done`
}

// ── live bot reader (impure; the only part that touches mineflayer) ───────────
function bestPickaxeTier(bot) {
  let tier = 0
  const items = liveInventoryItems(bot)
  for (const it of items) {
    const name = it?.name
    if (typeof name !== 'string' || !name.endsWith('_pickaxe')) continue
    const mat = name.slice(0, -'_pickaxe'.length)
    tier = Math.max(tier, PICKAXE_TIER[mat] ?? 0)
  }
  return tier
}

function itemsByName(bot) {
  const out = {}
  const items = liveInventoryItems(bot)
  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue
    out[it.name] = (out[it.name] ?? 0) + (it.count ?? 0)
  }
  return out
}

// 261017 (pass 14): stations that count once placed, and how far to look.
// 261017 (pass 14b): only her own (ownStations.js): one she placed or used,
// still standing, within the radius.
export const PLACED_STATIONS = OWN_STATIONS
export const PLACED_STATION_RADIUS = 24
const PLACED_CACHE_MS = 5000

function placedStations(bot, now = Date.now()) {
  const cache = bot?._seiPlacedStations
  if (cache && now - cache.at < PLACED_CACHE_MS) return cache.placed
  const placed = {}
  try {
    const here = bot?.entity?.position
    if (typeof bot?.blockAt === 'function' && here) {
      for (const name of PLACED_STATIONS) {
        for (const p of ownStationPositions(bot, name)) {
          const d = Math.hypot(p.x + 0.5 - here.x, p.y - here.y, p.z + 0.5 - here.z)
          if (d > PLACED_STATION_RADIUS) continue
          const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
          if (b?.name === name) { placed[name] = true; break }
        }
      }
    }
  } catch { /* best effort: no world read means nothing placed */ }
  if (bot && typeof bot === 'object') bot._seiPlacedStations = { at: now, placed }
  return placed
}

function normalizeDim(raw) {
  const s = String(raw ?? '').toLowerCase()
  if (s.includes('nether')) return 'the_nether'
  if (s.includes('end')) return 'the_end'
  return 'overworld'
}

/**
 * Build the normalized progression state from a live mineflayer bot plus the
 * caller-owned latched `flags` (entered_nether / entered_end / killed_dragon).
 * Degrades to a safe empty state on any error.
 */
export function readProgressionState(bot, flags = {}) {
  try {
    return {
      items: itemsByName(bot),
      placed: placedStations(bot),
      pickaxeTier: bestPickaxeTier(bot),
      dim: normalizeDim(bot?.game?.dimension),
      flags,
    }
  } catch {
    return { items: {}, pickaxeTier: 0, dim: 'overworld', flags }
  }
}

/**
 * Convenience: read state + compute in one call (what the adapter exposes).
 */
export function getProgression(bot, flags = {}) {
  return computeProgression(readProgressionState(bot, flags))
}
