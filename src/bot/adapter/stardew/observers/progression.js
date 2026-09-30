// src/bot/adapter/stardew/observers/progression.js — the Stardew Valley
// progression frontier (260910), the counterpart of the Minecraft spine
// (adapter/minecraft/observers/progression.js) for the brain's heartbeat.
//
// Why it exists: the agentic heartbeat says "pick from the reachable list
// below", and for Stardew that list was EMPTY, so the companion had nothing
// to lock in as a project and spent its idle ticks asking the player what
// the move was (measured live 260910, three rewordings in a minute). The
// spine is the first fortnight of a NEW farm, written as invitations with a
// part for the player in each label, because the whole surface exists to
// make the start of the game interesting for someone who has never played.
//
// The graph is DATA (progression.json), same node shape as Minecraft's:
//   { id, label, key, needs[], goal, unlock?, next_action?, procedure? }
// `goal` predicates run against a normalized state built from the mod's
// observation plus one-way flags the adapter latches from verb results:
//   { have, count? }         the companion holds >= count of an item by name
//   { haveKind, count? }     ... of an inventory `kind` (seed, forage, fish)
//   { farmCrops }            crops planted on the Farm (mod `farm.crops`)
//   { farmSoilOrCrops }      tilled tiles + crops on the Farm
//   { mineLevel }            deepest mine level the companion has stood on
//   { flag }                 a one-way flag (cleared, foraged, harvested,
//                            fished, bought, visited_town)
//   { any: [ ...predicates ] }  any one of them
// `unlock` gates a node out of the frontier until it holds ({ dayAtLeast }
// counts days played, so a farm loaded on spring 5 already qualifies).
// Monotonic closure as in Minecraft: a done successor implies its needs.

import { readFileSync } from 'node:fs'

export function loadSpine(url) {
  const raw = JSON.parse(readFileSync(url, 'utf8'))
  return raw.map((n) => ({ ...n, needs: Array.isArray(n.needs) ? n.needs : [] }))
}

export const SPINE = loadSpine(new URL('./progression.json', import.meta.url))

const SUCCESSORS = new Map()
for (const n of SPINE) for (const p of n.needs) SUCCESSORS.set(p, [...(SUCCESSORS.get(p) ?? []), n.id])

/** Every flag name a goal may reference (the adapter latches exactly these). */
export const FLAG_NAMES = Object.freeze(['cleared', 'foraged', 'harvested', 'fished', 'bought', 'visited_town'])

function holds(pred, state) {
  if (!pred || typeof pred !== 'object') return false
  if (Array.isArray(pred.any)) return pred.any.some((p) => holds(p, state))
  if (pred.have) return (state.items?.[pred.have] ?? 0) >= (pred.count ?? 1)
  if (pred.haveKind) return (state.kinds?.[pred.haveKind] ?? 0) >= (pred.count ?? 1)
  if (pred.farmCrops != null) return (state.farm?.crops ?? 0) >= pred.farmCrops
  if (pred.farmSoilOrCrops != null) return (state.farm?.crops ?? 0) + (state.farm?.soil ?? 0) >= pred.farmSoilOrCrops
  if (pred.mineLevel != null) return (state.mineLevel ?? 0) >= pred.mineLevel
  if (pred.flag) return state.flags?.[pred.flag] === true
  return false
}

function unlocked(node, state) {
  const u = node.unlock
  if (!u) return true
  if (u.dayAtLeast != null) return (state.daysPlayed ?? 0) >= u.dayAtLeast
  return true
}

/**
 * @param {{ items?: Record<string,number>, kinds?: Record<string,number>, farm?: {crops?:number, soil?:number}, mineLevel?: number, daysPlayed?: number, flags?: Record<string,boolean> }} state
 * @returns {{ done: Set<string>, raw: Set<string>, frontier: object[], currentMilestone: object|null, furthest: object|null, complete: boolean }}
 */
export function computeProgression(state = {}) {
  const raw = new Set(SPINE.filter((n) => holds(n.goal, state)).map((n) => n.id))
  const done = new Set(raw)
  let changed = true
  while (changed) {
    changed = false
    for (const n of SPINE) {
      if (done.has(n.id)) continue
      if ((SUCCESSORS.get(n.id) ?? []).some((s) => done.has(s))) { done.add(n.id); changed = true }
    }
  }
  const frontier = SPINE.filter((n) => !done.has(n.id) && n.needs.every((p) => done.has(p)) && unlocked(n, state))
  let furthest = null
  for (const n of SPINE) if (done.has(n.id)) furthest = n
  return { done, raw, frontier, currentMilestone: frontier[0] ?? null, furthest, complete: done.has('copper') }
}

/** Inventory rows -> { name: count } and { kind: count }. */
export function tallyInventory(inventory) {
  const items = {}
  const kinds = {}
  for (const it of Array.isArray(inventory) ? inventory : []) {
    if (!it || typeof it.name !== 'string') continue
    const c = Number.isFinite(Number(it.count)) ? Number(it.count) : 1
    items[it.name] = (items[it.name] ?? 0) + c
    if (typeof it.kind === 'string') kinds[it.kind] = (kinds[it.kind] ?? 0) + c
  }
  return { items, kinds }
}

/** Deepest mine level in a location name ("UndergroundMine12" -> 12), else 0. */
export function mineLevelOf(location) {
  const m = /^UndergroundMine(\d+)/.exec(String(location ?? ''))
  return m ? Number(m[1]) : 0
}

const TOWN_LOCATIONS = new Set(['Town', 'SeedShop', 'Saloon', 'CommunityCenter', 'Blacksmith', 'JojaMart', 'Hospital', 'ArchaeologyHouse', 'ManorHouse', 'HaleyHouse', 'SamHouse', 'JoshHouse', 'Trailer'])

/**
 * The one-way latches, kept by the adapter. `observe` reads a fresh
 * observation; `result` reads a verb result (the mod's detail string).
 * Never throws.
 */
export function createProgressionFlags() {
  const flags = Object.fromEntries(FLAG_NAMES.map((f) => [f, false]))
  let mineLevel = 0
  let debrisCleared = 0
  let foragePicked = 0
  return {
    flags,
    get mineLevel() { return mineLevel },
    observe(obs) {
      try {
        const loc = String(obs?.location ?? '')
        if (TOWN_LOCATIONS.has(loc)) flags.visited_town = true
        mineLevel = Math.max(mineLevel, mineLevelOf(loc))
      } catch { /* ignore */ }
    },
    result(name, args, detail) {
      try {
        const d = String(detail ?? '')
        if (/^failed|^aborted/.test(d)) {
          // A partial gather still counts what it did ("cleared 5, then: ...").
        }
        const num = (re) => { const m = re.exec(d); return m ? Number(m[1]) : 0 }
        switch (name) {
          case 'gather':
            if (args?.kind === 'debris') { debrisCleared += num(/cleared (\d+)/i); if (debrisCleared >= 8) flags.cleared = true }
            if (args?.kind === 'forage') { foragePicked += num(/(?:picked|gathered|got) (\d+)/i) || (/picked up/i.test(d) ? 1 : 0); if (foragePicked >= 3) flags.foraged = true }
            break
          case 'harvest':
            if (/harvested \d+/i.test(d) || /^harvested/i.test(d)) flags.harvested = true
            if (/picked up/i.test(d)) { foragePicked += 1; if (foragePicked >= 3) flags.foraged = true }
            break
          case 'interact':
            if (/picked up/i.test(d)) { foragePicked += 1; if (foragePicked >= 3) flags.foraged = true }
            break
          case 'fish':
            if (/caught/i.test(d) && !/caught nothing/i.test(d)) flags.fished = true
            break
          case 'buy':
            if (/bought/i.test(d) && !/^failed/.test(d)) flags.bought = true
            break
          default:
            break
        }
      } catch { /* ignore */ }
    },
  }
}

/**
 * Build the normalized state from the latest observation + the latches.
 * Degrades to an empty state on any error.
 */
export function readProgressionState(obs, latches) {
  try {
    const { items, kinds } = tallyInventory(obs?.inventory)
    return {
      items,
      kinds,
      farm: { crops: Number(obs?.farm?.crops ?? 0), soil: Number(obs?.farm?.soil ?? 0) },
      mineLevel: latches?.mineLevel ?? 0,
      daysPlayed: Number(obs?.daysPlayed ?? obs?.day ?? 0),
      flags: latches?.flags ?? {},
    }
  } catch {
    return { items: {}, kinds: {}, farm: { crops: 0, soil: 0 }, mineLevel: 0, daysPlayed: 0, flags: latches?.flags ?? {} }
  }
}

export function getProgression(obs, latches) {
  return computeProgression(readProgressionState(obs, latches))
}
