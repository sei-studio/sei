// src/observers/targeting.js â€” handle table + targeting resolvers (D-25/D-35)
import { Vec3 } from 'vec3'
import mcDataLib from 'minecraft-data'
import { isDeadEntity } from './entities.js'
import { HOSTILE_MOBS } from '../behaviors/hostiles.js'

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

/** The live "#N" snapshot handle for an entity id, or null. */
export function handleForEntity(entityId) {
  if (entityId == null) return null
  const now = Date.now()
  for (const [tag, h] of _handles) {
    if (h?.kind === 'entity' && h.entityId === entityId && h.expiresAt >= now) return tag
  }
  return null
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

  // "#N" handle, OR a non-# string passed via `target` â€” LLMs use `target`
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
// can't latch onto a zombie 40 blocks away after the original target dies â€”
// observed bug where killing the immediate threat made the next swing call
// chase the next-nearest hostile across the map. Players are excluded from
// the bound (player follow shouldn't break if they walk away).
const NAMED_ENTITY_MAX_DIST = 16

function resolveEntityByName(name, bot) {
  const want = String(name).toLowerCase()
  const me = bot.entity
  // 261012 (pass 4a): a hostile asked for by name goes to the one threatening
  // the player first. See pickHostileForOwner.
  if (HOSTILE_MOBS.has(want)) {
    const forOwner = pickHostileForOwner(bot, (e) => (e.name ?? '').toLowerCase() === want)
    if (forOwner) return forOwner
  }
  return bot.nearestEntity((e) => {
    const n = (e?.name ?? '').toLowerCase()
    const u = (e?.username ?? '').toLowerCase()
    if (n !== want && u !== want) return false
    if (isDeadEntity(bot, e)) return false
    if (u) return true   // username match: don't apply distance cap
    if (!me?.position || !e?.position) return true
    try {
      return e.position.distanceTo(me.position) <= NAMED_ENTITY_MAX_DIST
    } catch {
      return true
    }
  }) ?? null
}

/**
 * 261012: the nearest living mob with this name past the name-lookup bound,
 * for the "no zombie within 16 blocks" result. Quality eval protect_player:
 * the zombies heading for the player were 21-25 blocks out at the order, the
 * name lookup refused them, and the turn was spent finding that out. The
 * bound stays (it stops a chase across the map after a kill); the result now
 * says where the nearest one is so the model can decide to go after it.
 * @returns {{ entity:any, distance:number }|null}
 */
export function nearestNamedEntityBeyondBound(name, bot, maxDist = 48) {
  const want = String(name ?? '').toLowerCase()
  const me = bot?.entity
  if (!want || !me?.position) return null
  let best = null
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === me || e.username || !e.position) continue
    if ((e.name ?? '').toLowerCase() !== want) continue
    if (isDeadEntity(bot, e)) continue
    let d
    try { d = e.position.distanceTo(me.position) } catch { continue }
    if (!Number.isFinite(d) || d > maxDist) continue
    if (!best || d < best.distance) best = { entity: e, distance: d }
  }
  return best
}

// â”€â”€ Owner-aware hostile targeting (261012, quality pass 4a) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Quality eval protect_player: two zombies 21 blocks from a 10 hp player.
// The name lookup picked the zombie nearest to HER (or refused both past 16
// blocks), and the "nearest one is at ..." hint pointed at the same one. In
// one trial she chased a zombie 36 blocks off while the other one killed the
// player. When the player is under threat, the mob to go for is the one
// nearest to THEM.

/** A mob this close to the owner is a threat to them, and a by-name attack goes for it. */
export const OWNER_GUARD_RADIUS = 24
/** ...as long as it is no farther than this from her (one sprint of a few seconds). */
export const OWNER_GUARD_MAX_FROM_ME = 48
/** Within this of the owner a mob is on them, and beats one fighting her at her feet. */
const OWNER_ON_RADIUS = 8
/** A mob this close to her is her own fight (it is in or near swing range). */
const MY_FIGHT_RADIUS = 4

/**
 * The owner's player entity, from the owner names startCombat records on the
 * bot (config.player_username / player_display_name). Null when unknown or out
 * of entity range.
 */
export function ownerEntityOf(bot) {
  const names = Array.isArray(bot?._seiOwnerNames) ? bot._seiOwnerNames : []
  if (!names.length) return null
  for (const [name, p] of Object.entries(bot?.players ?? {})) {
    if (p?.entity?.position && names.includes(String(name).toLowerCase())) return p.entity
  }
  return null
}

/**
 * The hostile to fight for the owner: among living hostiles that pass `match`,
 * within `ownerRadius` of the owner and OWNER_GUARD_MAX_FROM_ME of her, the
 * one nearest the OWNER. One exception: when that mob is not on the owner yet
 * (over OWNER_ON_RADIUS from them) and a matching mob is already at her feet,
 * that one is the fight. Returns null when the owner is unknown or no
 * matching mob is near them; callers then fall back to their own rule.
 *
 * @param {any} bot
 * @param {(e:any)=>boolean} [match]
 * @param {{ ownerRadius?:number, excludeIds?:Set<number>|number[] }} [opts]
 */
export function pickHostileForOwner(bot, match = () => true, opts = {}) {
  const owner = ownerEntityOf(bot)
  const me = bot?.entity
  if (!owner?.position || !me?.position) return null
  const ownerRadius = Number.isFinite(opts.ownerRadius) ? opts.ownerRadius : OWNER_GUARD_RADIUS
  const exclude = opts.excludeIds instanceof Set ? opts.excludeIds : new Set(opts.excludeIds ?? [])
  let nearOwner = null
  let nearMe = null
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e?.position || e === me || e === owner || e.username) continue
    if (!HOSTILE_MOBS.has(e.name) || exclude.has(e.id)) continue
    if (isDeadEntity(bot, e)) continue
    try { if (!match(e)) continue } catch { continue }
    let dOwner, dMe
    try {
      dOwner = e.position.distanceTo(owner.position)
      dMe = e.position.distanceTo(me.position)
    } catch { continue }
    if (!Number.isFinite(dOwner) || !Number.isFinite(dMe)) continue
    if (dOwner <= ownerRadius && dMe <= OWNER_GUARD_MAX_FROM_ME && (!nearOwner || dOwner < nearOwner.dOwner)) {
      nearOwner = { entity: e, dOwner }
    }
    if (dMe <= MY_FIGHT_RADIUS && (!nearMe || dMe < nearMe.dMe)) nearMe = { entity: e, dMe }
  }
  if (!nearOwner) return null
  if (nearMe && nearOwner.dOwner > OWNER_ON_RADIUS) return nearMe.entity
  return nearOwner.entity
}




