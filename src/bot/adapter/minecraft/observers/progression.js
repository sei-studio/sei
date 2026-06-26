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
  if (g.have) return (items[g.have] ?? 0) >= (g.count ?? 1)
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

// ── live bot reader (impure; the only part that touches mineflayer) ───────────
function bestPickaxeTier(bot) {
  let tier = 0
  const items = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []
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
  const items = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []
  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue
    out[it.name] = (out[it.name] ?? 0) + (it.count ?? 0)
  }
  return out
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
