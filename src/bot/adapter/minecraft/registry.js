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
import { gatherAction } from './behaviors/mineVein.js'
import { getHealedPos } from './observers/posHealer.js'
import { setFollowTarget, getFollowTargetLabel } from './behaviors/follow.js'
import { resolveEntity } from './observers/targeting.js'
import { digAction } from './behaviors/dig.js'
import { exploreAction } from './behaviors/explore.js'
import { buildAction } from './behaviors/build.js'
import { shelterAction } from './behaviors/shelter.js'
import { placeBlockAction } from './behaviors/place.js'
import { equipAction } from './behaviors/equip.js'
import { craftAction } from './behaviors/craft.js'
import { attackEntityAction } from './behaviors/attack.js'
import { consumeItemAction } from './behaviors/consume.js'
import { visualizeAction } from './behaviors/visualize.js'
import { dropItemAction } from './behaviors/drop.js'
import { activateItemAction } from './behaviors/activate.js'
import { activateBlockAction } from './behaviors/activateBlock.js'
import { readSignAction } from './behaviors/readSign.js'
import { sleepAction } from './behaviors/sleep.js'
import {
  openContainerAction,
  depositItemAction,
  withdrawItemAction,
} from './behaviors/container.js'
import {
  openFurnaceAction,
  smeltInputAction,
  addFuelAction,
  takeSmeltedAction,
} from './behaviors/furnace.js'

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

// Cuboid dig schema. Extends TargetShape with optional `to` for cuboid mode
// + matching 256-cell cap. Single-cell dispatch unchanged.
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

// Cuboid build schema. Schema-layer cell cap prevents any expensive side
// effect from running with an out-of-bounds cuboid.
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
 * Coords-at-known-player detector. When goTo is called with (x, y, z) that
 * match a known player's current position to within ~1.5 blocks, treat it as
 * "go to the player" and bump the default range to 2 so the bot stops at
 * conversation distance instead of trying to stand on top of them. The LLM
 * emitted goTo with range=0 when sent to a player and then sat in pathfind
 * retries; default range:2 closes that loop.
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

/**
 * Pre-built registry with all minecraft adapter actions registered.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.visionEnabled=false] — D-10 gate. The `visualize`
 *   action is registered ONLY when the active provider supports vision
 *   (capabilities.vision). A non-VLM provider never gets the tool in the
 *   registry (belt-and-suspenders with the orchestrator tool-list filter).
 */
export function createDefaultRegistry({ visionEnabled = false } = {}) {
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
      // 260607: an explicit goTo is a "relocate and stay" command — it ends
      // follow mode. Without this, the 1s follow tick (follow.js) would
      // re-install GoalFollow the instant goTo reaches its destination and yank
      // the bot back to the owner. Incidental actions (dig/gather/build) leave
      // follow intact so the bot resumes trailing after them.
      setFollowTarget(null)
      const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
      // Default range:2 when target matches a known player's position.
      // Only kicks in when the LLM omitted range
      // (Zod default fired range=1) and the coords align with a player.
      let range = args.range
      if (range <= 1 && isCoordsAtKnownPlayer(bot, args.x, args.y, args.z)) {
        range = 2
      }
      // 260513-wkd: pass through config.signal so loop-level abort halts the
      // pathfind via bot.pathfinder.stop() rather than waiting for the 12s
      // wall-clock timeout. Returns 'aborted' on abort (distinct from timeout).
      return goTo(bot, args.x, args.y, args.z, range, timeoutMs, config?.signal)
    }
  )

  registry.register('dig', DigSchema, digAction)

  // `explore`: short directional hop to load new terrain when a target is
  // unreachable or there's nothing nearby. Walks `blocks` (default 16) in a
  // direction RELATIVE to current facing (forward/backwards/left/right, or an
  // angle 0..360°), then auto-looks in that direction. opts.vision gates the
  // auto-look so a non-VLM provider gets text only (visionEnabled is always true
  // at build time — see index.js — so the render-then-drop is handled in the
  // orchestrator's capabilities.vision gate too).
  registry.register('explore',
    z.object({
      orientation: z.enum(['forward', 'forwards', 'backward', 'backwards', 'back', 'left', 'right', 'up', 'down']).optional(),
      angle: z.number().min(0).max(360).optional(),
      blocks: z.number().min(4).max(48).optional(),
    }),
    (args, bot, config) => {
      // 'up'/'down' used to hard-REJECT at the schema (invalid_enum_value), so the
      // LLM couldn't even ask to escape vertically (live drowning run). Accept
      // them now but intercept before exploreAction (which is yaw-only, horizontal):
      // vertical isn't an explore hop, so return actionable guidance instead.
      if (args?.orientation === 'up') {
        return bot?.entity?.isInWater
          ? "you're in water — swimming up is automatic; stay put or dig up to break out"
          : "can't fly up — build up with scaffold/build, or dig up to break through the ceiling"
      }
      if (args?.orientation === 'down') {
        return 'can\'t drop straight down with explore — use dig to tunnel down'
      }
      return exploreAction(args, bot, config, { vision: visionEnabled })
    }
  )

  // `find` resolves a loose term or exact MC ID to the nearest loaded-chunk
  // hit. Does NOT move the bot — returns
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

  // `gather`: dig N of a block type in one call when the specific instances
  // don't matter. Schema accepts either `name` (loose term / exact ID) OR
  // `(x,y,z)` anchor.
  registry.register('gather',
    z.object({
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      maxDistance: z.number().min(1).max(64).default(32),
      count: z.number().int().min(1).max(64).default(16),
    }).refine(
      (a) => (typeof a.name === 'string' && a.name.length > 0)
          || (typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number'),
      { message: 'must specify name or x,y,z' }
    ),
    gatherAction
  )

  registry.register(
    'placeBlock',
    z.object({
      block: z.string(),
      against: TargetShape.optional(),
      faceVector: Vec3Shape.optional(),
    }),
    placeBlockAction
  )

  registry.register('build', BuildSchema, buildAction)

  // `shelter`: a thin convenience composing build() (hollow walls + a roof
  // layer) and dig() (a doorway) into one enclosed structure. size.max(5) caps
  // the composed cuboids (≤48 wall + 25 roof cells) well within the 256-cell
  // guarantee. center defaults to the bot's position (base = bot.y + 1).
  const ShelterSchema = z.object({
    center: Vec3Shape.optional(),
    size: z.number().int().min(3).max(5).default(3),
    material: z.string().min(1).default('cobblestone'),
  })
  registry.register('shelter', ShelterSchema, shelterAction)

  // digIn (panic shelter) is deliberately NOT registered: the tool is disabled
  // and hidden from prompts (260707). behaviors/digIn.js is kept for potential
  // re-enable; shelter() remains the only build-a-refuge tool.

  registry.register(
    'equip',
    z.object({
      item: z.string(),
      destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']),
    }),
    equipAction
  )

  // `craft`: make N of a product item from inventory materials. `count` is the
  // number of the PRODUCT wanted; batch recipes (1 log → 4 planks) may overshoot
  // to the batch boundary, and the result string reports what was actually made.
  // 3×3 recipes need a crafting_table in reach — craft() does NOT walk there;
  // the snapshot's `craftable:` list reflects what's possible from where you are.
  registry.register(
    'craft',
    z.object({
      item: z.string().min(1),
      count: z.number().int().min(1).max(64).default(1),
    }),
    craftAction
  )

  // `target` must be a "#N" handle or an entity/block name — never a coordinate
  // string. Schema-level rejection avoids prompt clutter when the LLM tries
  // `target: "-60,71,-117"` (which would name-resolve to nothing).
  const EntityTarget = z.string().refine(
    (s) => !s.includes(','),
    { message: 'target must be #N or an entity name, not coordinates' },
  )

  // `setPvp`: toggle PvP spar mode on/off at the player's request. Off by
  // default and reset every session (a plain per-bot runtime flag, bot._seiPvp;
  // never persisted). When ON, the companion may attack the player back
  // (attackEntity accepts player targets), auto-retaliates against player hits,
  // and circle-strafes the player like a melee opponent (reflex.js). When OFF,
  // all of that reverts to the no-auto-PvP default.
  registry.register(
    'setPvp',
    z.object({ enabled: z.boolean() }),
    async (args, bot) => {
      bot._seiPvp = Boolean(args.enabled)
      // Drop the reflex opponent lock when leaving PvP so the bot stops kiting
      // the last opponent the instant sparring is turned off (Task 2).
      if (!bot._seiPvp) bot._seiPvpOpponent = null
      return bot._seiPvp
        ? 'PvP mode ON — sparring enabled; you can attack the player and hit back. Keep sparring until THEY say stop or one of you drops — never concede a fight that is still going, and only turn this off when they ask to stop.'
        : 'PvP mode OFF — you will no longer attack or hit the player back.'
    }
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

  // 260516-0yw: follow is now an OPEN-ENDED long-running action. The handler
  // installs the follow target and then BLOCKS on the AbortSignal until
  // either: (a) the orchestrator aborts it (P0/P1 preempt, R2/R3/R4 dispatch,
  // or the model called unfollow), or (b) the controller is otherwise
  // aborted. Resolving synchronously (the prior behavior) made the
  // long-runner promise settle immediately, action_complete fired, and the
  // bot entered a "following you" spam loop on every iteration. The 10s
  // action_tick (sei:action_tick at P2.3) gives the model a chance to peel
  // away with end_loop or unfollow without re-saying "following you".
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
    async (args, bot, config) => {
      // Resolve target and install it (same as before).
      let label
      if (args.player) {
        if (!bot.players?.[args.player]) return `no such player: ${args.player}`
        setFollowTarget({ kind: 'player', username: args.player })
        label = args.player
      } else {
        const ent = resolveEntity(args, bot)
        if (!ent) return 'target gone'
        if (ent.type === 'player' || ent.username) {
          setFollowTarget({ kind: 'player', username: ent.username })
          label = ent.username
        } else {
          label = ent.name ?? ent.displayName ?? `entity-${ent.id}`
          setFollowTarget({ kind: 'entity', entityId: ent.id, label })
        }
      }
      // Open-ended block: resolve ONLY on abort. The orchestrator's
      // startLongRunner plumbs config.signal end-to-end via
      // _buildExecOpts → adapter.executeAction → registry.execute(name,
      // args, bot, execConfig) → handler third arg. If a future regression
      // strips config.signal, the test-actionTick.mjs end-to-end assertion
      // fails loudly.
      const signal = config?.signal
      if (!signal) {
        // Safety: no signal means we're in a test env or a caller that
        // didn't plumb it. Preserve the legacy synchronous contract so
        // existing unit tests don't hang.
        return `following ${label}`
      }
      // 260607: do NOT clear the follow target on abort. An abort here is
      // almost always a PLAYER CHAT waking the suspended loop (handleDispatch
      // aborts the in-flight long-runner to deliver the message). Clearing the
      // target made EVERY message cancel the follow, so the model had to
      // re-issue `follow` each turn — the churn seen in the field logs. Follow
      // is now PERSISTENT state: the body keeps trailing via the 1s pathfinder
      // tick, and only `unfollow` or an explicit relocate (goTo) clears it. A
      // chat-wake therefore leaves the bot following while the model answers; a
      // real task-switch (goTo / unfollow) ends it cleanly.
      if (signal.aborted) return `follow ${label} interrupted (still trailing them)`
      await new Promise(resolve => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve() }
        signal.addEventListener('abort', onAbort)
      })
      return `follow ${label} interrupted (still trailing them)`
    }
  )

  registry.register(
    'unfollow',
    z.object({}),
    async () => {
      setFollowTarget(null)
      // Assert post-condition — the snapshot's follow_target line reads
      // `(none)` immediately after this returns.
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

  // VIS-02 / D-10 — the LLM-callable explicit render `look`. Registered ONLY
  // when the active provider is VLM-capable (visionEnabled). The orchestrator
  // ALSO filters `look` out of the tool list when the provider lacks vision, so
  // even a registration leak never reaches a non-VLM model (belt-and-suspenders,
  // VIS-03).
  //
  // 260617: directional + relative. {orientation} (forward/backwards/left/right)
  // or {angle} (0..360° clockwise) turns the head before rendering; {around:true}
  // returns four labelled frames (forward/right/behind/left). No args = current
  // view. Degrades gracefully if the area isn't loaded.
  // 260709: up/down tilt the head instead of turning it — the live session had
  // the player ask "pay attention to the bottom", the model called
  // look({orientation:"down"}), and the schema hard-rejected it.
  if (visionEnabled) {
    registry.register(
      'look',
      z.object({
        orientation: z.enum(['forward', 'forwards', 'backward', 'backwards', 'back', 'left', 'right', 'up', 'down']).optional(),
        angle: z.number().min(0).max(360).optional(),
        around: z.boolean().optional(),
      }),
      visualizeAction
    )
  }

  registry.register(
    'dropItem',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).default(1),
    }),
    dropItemAction
  )

  registry.register('activateItem', z.object({}), activateItemAction)

  // Door/gate/lever activation (MCRAFT-05). Uses the block-interact packet
  // (bot.activateBlock), unaffected by #3742 — distinct from activateItem.
  registry.register('activateBlock', TargetShape, activateBlockAction)

  // Bounded + sanitized sign read (MCRAFT-04, T-17-07). Read-only; the text is
  // control-char-stripped and capped to MAX_SIGN_CHARS before it can reach a prompt.
  registry.register('readSign', TargetShape, readSignAction)

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

  // Furnace 3-slot smelting (MCRAFT-01, D-09). openFurnace resolves a
  // furnace/blast_furnace/smoker block via TargetShape; the three slot ops act
  // on the single-flight FURNACE_SESSION. Schemas stay typed (closed registry).
  registry.register('openFurnace', TargetShape, openFurnaceAction)

  registry.register(
    'smeltInput',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).default(1),
    }),
    smeltInputAction
  )

  registry.register(
    'addFuel',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).default(1),
    }),
    addFuelAction
  )

  registry.register('takeSmelted', z.object({}), takeSmeltedAction)

  return registry
}
