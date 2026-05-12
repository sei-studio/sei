// src/adapter/minecraft/registry.js
//
// Minecraft action registry: registers the 12-action set against the generic
// createRegistry() factory in src/registry.js. The behaviors imported here
// are mineflayer-specific — keeping them in the adapter layer ensures the
// brain stays game-agnostic.

import { z } from 'zod'
import mcDataLib from 'minecraft-data'
import { createRegistry } from '../../registry.js'
import { goTo } from './behaviors/pathfind.js'
import { resolveTerm } from './loose-terms.js'
import { mineVeinAction } from './behaviors/mineVein.js'
import { getHealedPos } from './observers/posHealer.js'
import { setFollowTarget, getFollowTargetLabel } from './behaviors/follow.js'
import { resolveEntity } from './observers/targeting.js'
import { digAction } from './behaviors/dig.js'
import { buildAction } from './behaviors/build.js'
import { placeBlockAction } from './behaviors/place.js'
import { equipAction } from './behaviors/equip.js'
import { attackEntityAction } from './behaviors/attack.js'
import { consumeItemAction } from './behaviors/consume.js'
import { lookAtAction } from './behaviors/lookAt.js'
import { dropItemAction } from './behaviors/drop.js'
import { activateItemAction } from './behaviors/activate.js'
import { sleepAction } from './behaviors/sleep.js'
import {
  openContainerAction,
  depositItemAction,
  withdrawItemAction,
} from './behaviors/container.js'

// Standard target shape consumed by resolveBlock (D-25).
const TargetShape = z.object({
  block: z.string().optional(),
  target: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  maxDistance: z.number().min(1).max(64).default(32),
}).refine(
  (a) => a.block || a.target || (a.x != null && a.y != null && a.z != null),
  { message: 'must specify block, #N target, or x/y/z' }
)

const Vec3Shape = z.object({ x: z.number(), y: z.number(), z: z.number() })

// Phase 7 (D-01, D-11): cuboid dig schema. Extends TargetShape with optional
// `to` for cuboid mode + matching 256-cell cap. Single-cell dispatch unchanged.
const DigSchema = z.object({
  block: z.string().optional(),
  target: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  to: Vec3Shape.optional(),
  hollow: z.boolean().optional(),
  maxDistance: z.number().min(1).max(64).default(32),
}).refine(
  (a) => a.block || a.target || (a.x != null && a.y != null && a.z != null),
  { message: 'must specify block, #N target, or x/y/z' }
).refine(
  (a) => {
    if (a.to == null) return true
    if (a.x == null || a.y == null || a.z == null) return false
    const dx = Math.abs(a.to.x - a.x) + 1
    const dy = Math.abs(a.to.y - a.y) + 1
    const dz = Math.abs(a.to.z - a.z) + 1
    return dx * dy * dz <= 256
  },
  { message: 'cuboid dig too large (>256 cells) or missing explicit from coords (need x,y,z when using to)' }
)

// Phase 7 (D-01, D-02, D-11): cuboid build schema. Schema-layer cell cap
// prevents any expensive side effect from running with an out-of-bounds cuboid.
const BuildSchema = z.object({
  from: Vec3Shape,
  to: Vec3Shape,
  block: z.string().min(1),
  hollow: z.boolean().optional().default(false),
}).refine(
  ({ from, to }) => {
    const dx = Math.abs(to.x - from.x) + 1
    const dy = Math.abs(to.y - from.y) + 1
    const dz = Math.abs(to.z - from.z) + 1
    return dx * dy * dz <= 256
  },
  { message: 'cuboid too large (>256 cells) — split into smaller calls (e.g. build one floor at a time)' }
)

/**
 * Plan 03.1-05 Task 3 (D-H-9): coords-at-known-player detector. When goTo is
 * called with (x, y, z) that match a known player's current position to
 * within ~1.5 blocks, treat it as "go to the player" and bump the default
 * range to 2 so the bot stops at conversation distance instead of trying to
 * stand on top of them. The LLM emitted goTo with range=0 when sent to a
 * player and then sat in pathfind retries; default range:2 closes that loop.
 */
function isCoordsAtKnownPlayer(bot, x, y, z) {
  if (!bot?.players) return false
  for (const username in bot.players) {
    const p = bot.players[username]
    const e = p?.entity
    if (!e || !e.position) continue
    if (
      Math.abs(e.position.x - x) < 1.5 &&
      Math.abs(e.position.y - y) < 1.5 &&
      Math.abs(e.position.z - z) < 1.5
    ) return true
  }
  return false
}

/** Pre-built registry with all minecraft adapter actions registered. */
export function createDefaultRegistry() {
  const registry = createRegistry()

  registry.register(
    'goTo',
    z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      range: z.number().min(0).default(1),
    }),
    async (args, bot, config) => {
      const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
      // Plan 03.1-05 Task 3 (D-H-9): default range:2 when target matches a
      // known player's position. Only kicks in when the LLM omitted range
      // (Zod default fired range=1) and the coords align with a player.
      let range = args.range
      if (range <= 1 && isCoordsAtKnownPlayer(bot, args.x, args.y, args.z)) {
        range = 2
      }
      return goTo(bot, args.x, args.y, args.z, range, timeoutMs)
    }
  )

  registry.register(
    'setGoals',
    z.object({
      list: z.enum(['owner', 'self']),
      op:   z.enum(['add', 'remove']),
      goal: z.string().min(1),
    }),
    async (args, bot, config) => {
      const store = config?._goalStore
      if (!store) throw new Error('setGoals invoked without _goalStore in config')
      if (args.op === 'add')    return { ok: store.add(args.list, args.goal),    snapshot: store.snapshot() }
      if (args.op === 'remove') return { ok: store.remove(args.list, args.goal), snapshot: store.snapshot() }
    }
  )

  registry.register('dig', DigSchema, digAction)

  // Phase 6 (D-NEW-SCAV-2): `find` resolves a loose term or exact MC ID to the
  // nearest loaded-chunk hit. Does NOT move the bot — returns
  // `{found,id,pos,distance}` or `{found:false,reason}`. NaN-safe origin via
  // getHealedPos.
  registry.register('find',
    z.object({
      name: z.string().min(1),
      maxDistance: z.number().min(1).max(128).default(64),
    }),
    async (args, bot) => {
      const ids = resolveTerm(args.name)
      if (!ids.length) return { found: false, reason: `no known IDs for ${args.name}` }
      let mcData
      try { mcData = mcDataLib(bot.version) } catch { mcData = null }
      let matching
      if (mcData?.blocksByName) {
        const idNums = ids.map(n => mcData.blocksByName[n]?.id).filter(v => v != null)
        if (idNums.length === 0) {
          return { found: false, reason: `no known IDs for ${args.name}` }
        }
        matching = idNums
      } else {
        matching = (b) => ids.includes(b?.name)
      }
      const healed = getHealedPos(bot) ?? bot.entity?.position
      const point = healed && Number.isFinite(healed.x) ? healed : undefined
      const hits = bot.findBlocks({ matching, maxDistance: args.maxDistance, count: 1, point })
      if (!hits || !hits.length) {
        return { found: false, reason: `no ${args.name} in loaded chunks within ${args.maxDistance}m` }
      }
      const h = hits[0]
      const blk = bot.blockAt(h)
      const d = point && typeof h.distanceTo === 'function'
        ? Number(h.distanceTo(point).toFixed(1))
        : 0
      return {
        found: true,
        id: blk?.name ?? 'unknown',
        pos: { x: h.x, y: h.y, z: h.z },
        distance: d,
      }
    }
  )

  // Phase 6 (D-NEW-SCAV-3): mine an entire connected vein in one call.
  // Schema accepts either `name` (loose term / exact ID) OR `(x,y,z)` anchor.
  registry.register('mine_vein',
    z.object({
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      maxDistance: z.number().min(1).max(64).default(32),
    }).refine(
      (a) => (typeof a.name === 'string' && a.name.length > 0)
          || (typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number'),
      { message: 'must specify name or x,y,z' }
    ),
    mineVeinAction
  )

  registry.register(
    'placeBlock',
    z.object({
      block: z.string(),
      against: TargetShape,
      faceVector: Vec3Shape.optional(),
    }),
    placeBlockAction
  )

  registry.register('build', BuildSchema, buildAction)

  registry.register(
    'equip',
    z.object({
      item: z.string(),
      destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']),
    }),
    equipAction
  )

  // `target` must be a "#N" handle or an entity/block name — never a coordinate
  // string. Schema-level rejection avoids prompt clutter when the LLM tries
  // `target: "-60,71,-117"` (which would name-resolve to nothing).
  const EntityTarget = z.string().refine(
    (s) => !s.includes(','),
    { message: 'target must be #N or an entity name, not coordinates' },
  )

  registry.register(
    'attackEntity',
    z.object({
      entity: z.string().optional(),
      target: EntityTarget.optional(),
      times: z.number().int().min(1).max(10).default(1),
    }).refine(
      (a) => a.entity || a.target,
      { message: 'must specify entity name or #N target' }
    ),
    attackEntityAction
  )

  registry.register(
    'follow',
    z.object({
      entity: z.string().optional(),
      target: EntityTarget.optional(),
      player: z.string().optional(),
    }).refine(
      (a) => a.entity || a.target || a.player,
      { message: 'must specify entity name, #N target, or player username' }
    ),
    async (args, bot) => {
      if (args.player) {
        if (!bot.players?.[args.player]) return `no such player: ${args.player}`
        setFollowTarget({ kind: 'player', username: args.player })
        return `following ${args.player}`
      }
      const ent = resolveEntity(args, bot)
      if (!ent) return 'target gone'
      if (ent.type === 'player' || ent.username) {
        setFollowTarget({ kind: 'player', username: ent.username })
        return `following ${ent.username}`
      }
      const label = ent.name ?? ent.displayName ?? `entity-${ent.id}`
      setFollowTarget({ kind: 'entity', entityId: ent.id, label })
      return `following ${label}`
    }
  )

  registry.register(
    'unfollow',
    z.object({}),
    async () => {
      setFollowTarget(null)
      // Plan 03.1-09 (D-H-16): assert post-condition — the snapshot's
      // follow_target line reads `(none)` immediately after this returns.
      // Returning the readback in the result string surfaces the clear to
      // the LLM (replaces the old generic 'unfollowed' string).
      const label = getFollowTargetLabel()
      return label == null ? 'unfollowed (no longer following anyone)' : `unfollow failed (still following ${label})`
    }
  )

  registry.register(
    'consumeItem',
    z.object({ item: z.string().optional() }),
    consumeItemAction
  )

  registry.register(
    'lookAt',
    z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      entity: z.string().optional(),
      target: z.string().optional(),
    }),
    lookAtAction
  )

  registry.register(
    'dropItem',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).default(1),
    }),
    dropItemAction
  )

  registry.register('activateItem', z.object({}), activateItemAction)

  registry.register('sleep', TargetShape, sleepAction)

  registry.register('openContainer', TargetShape, openContainerAction)

  registry.register(
    'depositItem',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).default(1),
    }),
    depositItemAction
  )

  registry.register(
    'withdrawItem',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).default(1),
    }),
    withdrawItemAction
  )

  return registry
}
