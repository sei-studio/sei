// src/adapter/minecraft/registry.js
//
// Minecraft action registry: registers the 12-action set against the generic
// createRegistry() factory in src/registry.js. The behaviors imported here
// are mineflayer-specific — keeping them in the adapter layer ensures the
// brain stays game-agnostic.

import { z } from 'zod'
import { createRegistry } from '../../registry.js'
import { goTo } from './behaviors/pathfind.js'
import { setFollowTarget } from './behaviors/follow.js'
import { resolveEntity } from './observers/targeting.js'
import { digAction } from './behaviors/dig.js'
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
      return goTo(bot, args.x, args.y, args.z, args.range, timeoutMs)
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

  registry.register('dig', TargetShape, digAction)

  registry.register(
    'placeBlock',
    z.object({
      block: z.string(),
      against: TargetShape,
      faceVector: Vec3Shape.optional(),
    }),
    placeBlockAction
  )

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
      return 'unfollowed'
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
