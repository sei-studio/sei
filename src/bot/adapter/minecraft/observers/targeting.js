// src/observers/targeting.js — handle table + targeting resolvers (D-25/D-35)
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'

export const HANDLE_TTL_MS = 10_000

/**
 * @typedef {{ kind:'block', pos:{x:number,y:number,z:number}, expiresAt:number }} BlockHandle
 * @typedef {{ kind:'entity', entityId:number, expiresAt:number }} EntityHandle
 * @typedef {BlockHandle | EntityHandle} HandleEntry
 */

/** @type {Map<string, HandleEntry>} */
const _handles = new Map()

/**
 * Replace the handle table with a fresh set (per-snapshot replace strategy, RESEARCH Pattern 4).
 * @param {Array<[string, HandleEntry]>} entries
 */
export function setHandles(entries) {
  _handles.clear()
  for (const [k, v] of entries) _handles.set(k, v)
}

/** @returns {Map<string, HandleEntry>} */
export function getHandles() {
  return _handles
}

function lookupHandle(key) {
  const h = _handles.get(key)
  if (!h) return null
  if (h.expiresAt < Date.now()) return null
  return h
}

/**
 * @param {{ target?:string }} args
 * @returns {boolean} true iff target is "#N" but handle is missing/stale/wrong-kind.
 *   Note: kind-mismatch caller-context is not knowable from args alone; we treat any
 *   missing/expired handle as stale here.
 */
export function isStaleHandle(args) {
  if (!args || typeof args.target !== 'string' || !args.target.startsWith('#')) return false
  const h = _handles.get(args.target)
  if (!h) return true
  if (h.expiresAt < Date.now()) return true
  return false
}

/**
 * Resolve a block target. Returns Block | null.
 * Order: explicit (x,y,z) -> "#N" handle -> name lookup.
 * Uses minecraft-data when available; falls back to function-form matching otherwise.
 * @param {{ block?:string, target?:string, x?:number, y?:number, z?:number, maxDistance?:number }} args
 * @param {import('mineflayer').Bot} bot
 */
export async function resolveBlock(args, bot) {
  if (!args) return null
  const { block, target, x, y, z } = args
  const maxDistance = args.maxDistance ?? 32

  // Explicit coordinate
  if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
    return bot.blockAt(new Vec3(x, y, z))
  }

  // "#N" handle, OR a non-# string passed via `target` (LLMs treat `target`
  // and `block` interchangeably; accept either rather than silently dropping).
  if (typeof target === 'string' && target.length > 0) {
    if (target.startsWith('#')) {
      const h = lookupHandle(target)
      if (!h || h.kind !== 'block') return null
      return bot.blockAt(new Vec3(h.pos.x, h.pos.y, h.pos.z))
    }
    // Fall through to name lookup using `target` as the block name.
    return resolveBlockByName(target, bot, maxDistance)
  }

  // Name lookup
  if (typeof block === 'string' && block.length > 0) {
    return resolveBlockByName(block, bot, maxDistance)
  }

  return null
}

function resolveBlockByName(name, bot, maxDistance) {
  let mcData
  try { mcData = mcDataLib(bot.version) } catch { mcData = null }
  const def = mcData?.blocksByName?.[name]
  if (def) {
    return bot.findBlock({ matching: [def.id], maxDistance })
  }
  return bot.findBlock({ matching: (b) => b?.name === name, maxDistance })
}

/**
 * Resolve an entity target. Returns Entity | null.
 * Order: entity_id -> "#N" handle -> name lookup.
 * @param {{ entity?:string, target?:string, entity_id?:number }} args
 * @param {import('mineflayer').Bot} bot
 */
export function resolveEntity(args, bot) {
  if (!args) return null
  const { entity, target, entity_id } = args

  if (typeof entity_id === 'number') {
    return bot.entities?.[entity_id] ?? null
  }

  // "#N" handle, OR a non-# string passed via `target` — LLMs use `target`
  // and `entity` interchangeably; accept either rather than returning
  // "target gone" for what is clearly a name lookup.
  if (typeof target === 'string' && target.length > 0) {
    if (target.startsWith('#')) {
      const h = lookupHandle(target)
      if (!h || h.kind !== 'entity') return null
      return bot.entities?.[h.entityId] ?? null
    }
    return resolveEntityByName(target, bot)
  }

  if (typeof entity === 'string' && entity.length > 0) {
    return resolveEntityByName(entity, bot)
  }

  return null
}

// Bound name-based entity lookup so a fresh `attackEntity({target:"zombie"})`
// can't latch onto a zombie 40 blocks away after the original target dies —
// observed bug where killing the immediate threat made the next swing call
// chase the next-nearest hostile across the map. Players are excluded from
// the bound (player follow shouldn't break if they walk away).
const NAMED_ENTITY_MAX_DIST = 16

function resolveEntityByName(name, bot) {
  const want = String(name).toLowerCase()
  const me = bot.entity
  return bot.nearestEntity((e) => {
    const n = (e?.name ?? '').toLowerCase()
    const u = (e?.username ?? '').toLowerCase()
    if (n !== want && u !== want) return false
    if (u) return true   // username match: don't apply distance cap
    if (!me?.position || !e?.position) return true
    try {
      return e.position.distanceTo(me.position) <= NAMED_ENTITY_MAX_DIST
    } catch {
      return true
    }
  }) ?? null
}
