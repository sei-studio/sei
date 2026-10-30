// src/adapter/minecraft/registry.js
//
// Minecraft action registry: registers the 12-action set against the generic
// createRegistry() factory in src/registry.js. The behaviors imported here
// are mineflayer-specific — keeping them in the adapter layer ensures the
// brain stays game-agnostic.

import { z } from 'zod'
import mcDataLib from 'minecraft-data'
import { Vec3 } from 'vec3'
import { createRegistry } from '../../registry.js'
import { goTo, waitForBodyFree } from './behaviors/pathfind.js'
import { climbOut, escapeUp, findOpenColumn, isPassable, MIN_PIT_DEPTH } from './behaviors/climbOut.js'
import { noteUnreachable, isUnreachable, isUnreachableResult } from './behaviors/unreachable.js'
import { resolveTerm } from './loose-terms.js'
import { gatherAction } from './behaviors/mineVein.js'
import { getHealedPos } from './observers/posHealer.js'
import { setFollowTarget, getFollowTargetLabel } from './behaviors/follow.js'
import { resolveEntity } from './observers/targeting.js'
import { digToolAction } from './behaviors/digTool.js'
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
import { giveAction } from './behaviors/give.js'
import { pickupAction } from './behaviors/pickup.js'
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
//
// 260730: `direction:'below'` is the SCAFFOLDING mode — place blocks under
// your own feet and rise with them. It is the one build whose coordinates are
// not knowable in advance (the block lands wherever the bot is standing when
// the jump clears), so it takes `count` instead of two corners; `from`/`to`
// are optional purely to make room for it.
const BuildSchema = z.object({
  from: Vec3Shape.optional(),
  to: Vec3Shape.optional(),
  direction: z.enum(['below']).optional(),
  count: z.number().int().min(1).max(24).optional(),
  block: z.string().min(1),
  hollow: z.boolean().optional().default(false),
}).refine(
  (a) => a.direction === 'below' || (a.from != null && a.to != null),
  { message: 'specify two corners {from,to}, or direction:"below" with count to pillar up' }
).refine(
  ({ from, to, direction }) => {
    if (direction === 'below' || from == null || to == null) return true
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
// Nearest loaded entity of one type (find on a creature name).
function findEntity(bot, name, maxDistance) {
  const here = getHealedPos(bot) ?? bot.entity?.position
  let best = null
  let bestD = Infinity
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || e.name !== name || !e.position) continue
    const d = here && typeof e.position.distanceTo === 'function' ? e.position.distanceTo(here) : Infinity
    if (d <= maxDistance && d < bestD) { bestD = d; best = e }
  }
  if (!best) return { found: false, reason: `no ${name} within ${maxDistance}m` }
  const p = best.position
  return {
    found: true,
    id: name,
    pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    distance: Number(bestD.toFixed(1)),
  }
}

// 261015 (pass 10): find looks at this many hits, nearest first.
const FIND_CANDIDATES = 24
// 261017 (pass 12): when the best of those is buried or deep, also look for
// the nearest few exposed ones, no farther than this (see the find handler).
const FIND_EXPOSED = 8
const FIND_EXPOSED_MAX_M = 32
// A buried block (no open face) counts as this much farther than it is: the
// walk to it is a tunnel, and a tunnel down is a shaft she has to climb out of.
const BURIED_PENALTY_M = 12
// Each block more than DEPTH_FREE_M below her adds this much.
const DEPTH_FREE_M = 3
const DEPTH_PENALTY_PER_M = 1.5
// A walk that timed out farther than this from its target says nothing about
// whether the target can be reached.
const UNREACHABLE_NEAR_M = 8

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
function isExposed(bot, p) {
  for (const [dx, dy, dz] of FACES) {
    try {
      const b = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz))
      if (b && isPassable(b)) return true
    } catch {}
  }
  return false
}

/** Her feet are at least MIN_PIT_DEPTH below `y`. */
function wellBelow(bot, y) {
  const feetY = bot.entity?.position?.y
  return Number.isFinite(feetY) && Number.isFinite(y) && y >= Math.floor(feetY + 0.01) + MIN_PIT_DEPTH
}

/** Drop pathfind's "— unreachable — try build to Y=N" tail. */
function stripVerticalHint(r) {
  return String(r).replace(/ — unreachable — try build to Y=-?\d+(\.\d+)?$/, '')
}

/** "you are still in the hole at x,y,z, N blocks below where you are going" */
function stillInHole(bot, y) {
  const p = bot.entity.position
  const feetY = Math.floor(p.y + 0.01)
  return `you are still down in the hole at ${Math.floor(p.x)},${feetY},${Math.floor(p.z)}, ` +
    `${Math.floor(y) - feetY} blocks below where you are going, so you are not on your way yet`
}

const HOLE_NEXT_STEP = 'Walking again from here will fail the same way. To get out, pillar up with build (direction below) using dirt or cobblestone, or dig a staircase up the wall, or ask the player for help.'

/** What the climbs did, for a result that did not get her out. */
function climbSummary(climb, esc) {
  const parts = []
  const how = (c) => (c.how === 'pillar' ? 'pillared' : 'dug a staircase')
  if (climb?.status === 'climbed') {
    parts.push(climb.exit === false
      ? `You ${how(climb)} up ${climb.depth} blocks to an opening in the wall, but it was a dead-end pocket, not the way out`
      : `You ${how(climb)} up ${climb.depth} blocks first`)
  }
  if (esc?.status === 'climbed') {
    parts.push(parts.length ? `then ${how(esc)} ${esc.depth} more and walked again` : `You ${how(esc)} up ${esc.depth} blocks and walked again`)
  }
  return parts.length ? `${parts.join(', ')}. ` : ''
}

/**
 * A goTo aimed at a BLOCK (a log, an ore, a table: the cell is not air) that
 * failed to get there marks the block unreachable for a few minutes. A walk to
 * a spot or a player is not a block target. A timeout far from the block is
 * not evidence either (a long walk simply ran out of time).
 */
/** goTo's result when its climb out of a hole was cut off. */
function climbAborted(r) {
  if (r?.why === 'paused') return 'aborted (paused while climbing out of a hole)'
  if (r?.why === 'yielded') return 'aborted (a reflex took over while climbing out of a hole)'
  return 'aborted'
}

function noteUnreachableTarget(bot, args, result) {
  try {
    if (!isUnreachableResult(result)) return
    const blk = bot.blockAt?.(new Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z)))
    if (!blk || isPassable(blk)) return
    const p = bot.entity?.position
    const far = p ? Math.hypot(p.x - args.x, p.y - args.y, p.z - args.z) : Infinity
    if (String(result).startsWith('timeout') && far > UNREACHABLE_NEAR_M) return
    noteUnreachable(bot, args, String(result).split(' ')[0])
  } catch {}
}

/**
 * The walk behind goTo(x,y,z): out of a hole first, then the walk, then a
 * climb-and-retry when the walk failed far below the target.
 */
async function goToCoords(bot, target, range, timeoutMs, signal) {
  // 261015: out of a self-dug shaft first. The pathfinder's tower climbs
  // about a block per 5s (see climbOut.js), so from a 1x1 shaft a 12s
  // walk to the surface timed out every time.
  // 261019 (pass 19): a swim-up or a creeper flee that takes the body for a
  // moment used to end the whole goTo ("aborted (a reflex took over while
  // climbing out of a hole)" three times in one night). Wait for it to let go
  // and climb again; only the action's own abort ends the goTo here.
  let climb = await climbOut(bot, target, { signal })
  for (let i = 0; i < CLIMB_YIELD_RETRIES && climb.status === 'aborted' && climb.why === 'yielded' && !signal?.aborted; i++) {
    const w = await waitForBodyFree(bot, signal, () => false, CLIMB_YIELD_WAIT_MS)
    if (w !== 'clear') break
    climb = await climbOut(bot, target, { signal })
  }
  if (climb.status === 'aborted') return climbAborted(climb)
  if (climb.status === 'failed') return climb.line
  // 260513-wkd: pass through the signal so loop-level abort halts the
  // pathfind via bot.pathfinder.stop() rather than waiting for the 12s
  // wall-clock timeout. Returns 'aborted' on abort (distinct from timeout).
  // 261019 (pass 19): resume: a mob hit or a swim-up that takes the
  // pathfinder for a moment no longer ends the walk as cant_reach.
  const walkOpts = { resume: true }
  let r = await goTo(bot, target.x, target.y, target.z, range, timeoutMs, signal, walkOpts)
  let up = climb
  let esc = null
  // 261015: the walk failed and the target is well above her: she is in
  // a hole that is not a clean 1x1 shaft (an ore pocket off the bottom).
  // Climb by hand and walk once more.
  // 261017 (pass 12): also after climbOut "climbed". In the 261016
  // errands eval it climbed two blocks to a mined-out pocket in the wall,
  // the walk timed out 13 blocks down, and this fallback never ran.
  if (isUnreachableResult(r) && wellBelow(bot, target.y)) {
    esc = await escapeUp(bot, target, { signal, goTo })
    if (esc.status === 'aborted') return climbAborted(esc)
    if (esc.status === 'failed') return [`${esc.line}.`, climbSummary(climb, null).trim()].filter(Boolean).join(' ')
    if (esc.status === 'climbed') {
      up = esc
      r = await goTo(bot, target.x, target.y, target.z, range, timeoutMs, signal, walkOpts)
    }
  }
  noteUnreachableTarget(bot, target, r)
  // 261017: say plainly when she is still down in the hole. The old line
  // was "timeout — unreachable — try build to Y=71 (first pillared out of
  // the 2-deep hole you were in)" while she stood 13 blocks underground,
  // and she told the player "almost there".
  // Only when she really is shut in: on open ground below a cliff a failed
  // walk is not a hole.
  if (isUnreachableResult(r) && wellBelow(bot, target.y) && !findOpenColumn(bot, target.y, target).open) {
    // Review: end with what to do, so she does not just call goTo again
    // (each try costs up to ~50s of climbing and walking).
    return [`${stripVerticalHint(r)}: ${stillInHole(bot, target.y)}.`, climbSummary(climb, esc).trim(), HOLE_NEXT_STEP]
      .filter(Boolean).join(' ')
  }
  if (up.status === 'climbed') {
    const how = up.how === 'pillar' ? 'pillared' : 'dug a staircase'
    return up === climb
      ? `${r} (first ${how} out of the ${up.depth}-deep hole you were in)`
      : `${r} (the first walk failed, so you ${how} ${up.depth} blocks up out of the hole and walked again)`
  }
  return r
}

const CLIMB_YIELD_RETRIES = 2
const CLIMB_YIELD_WAIT_MS = 8000

/** The live entity of a player by username (exact, then case-insensitive). */
function resolvePlayer(bot, name) {
  const players = bot?.players ?? {}
  if (players[name]) return { username: name, entity: players[name].entity ?? null }
  const lower = name.toLowerCase()
  for (const u of Object.keys(players)) {
    if (u.toLowerCase() === lower) return { username: u, entity: players[u].entity ?? null }
  }
  return null
}

const PLAYER_WALK_LEGS = 3

function fmtPos(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

/**
 * 261019 (quality pass 19): goTo(player). Walks to where the player is at
 * the start of each leg; when they moved on during the walk, walks again
 * (a few legs at most). The result says how far from them she ended.
 */
export async function goToPlayer(bot, name, range, timeoutMs, signal) {
  const who = resolvePlayer(bot, name)
  if (!who) return `no such player: ${name}`
  let r = null
  for (let leg = 0; leg < PLAYER_WALK_LEGS; leg++) {
    const ent = resolvePlayer(bot, who.username)?.entity
    const at = ent?.position
    if (!at || ![at.x, at.y, at.z].every(Number.isFinite)) {
      return `can't see ${who.username} from here (too far away or not loaded). Ask where they are, or goTo the last place you saw them`
    }
    r = await goToCoords(bot, { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }, range, timeoutMs, signal)
    if (signal?.aborted || String(r).startsWith('aborted')) return r
    const now = resolvePlayer(bot, who.username)?.entity?.position
    const me = bot.entity?.position
    if (!now || !me) return r
    const d = Math.hypot(now.x - me.x, now.y - me.y, now.z - me.z)
    if (d <= range + 1) return `reached ${who.username} (${d.toFixed(1)}m away)`
    if (!String(r).startsWith('reached')) {
      return `${r}. ${who.username} is at ${fmtPos(now)}, ${d.toFixed(1)}m from you`
    }
    // Reached where they were, but they moved on: walk again.
  }
  const now = resolvePlayer(bot, who.username)?.entity?.position
  const me = bot.entity?.position
  if (!now || !me) return r
  const d = Math.hypot(now.x - me.x, now.y - me.y, now.z - me.z)
  return `${who.username} kept moving: you are ${d.toFixed(1)}m from them (they are at ${fmtPos(now)}). follow them to keep up`
}

export function createDefaultRegistry({ visionEnabled = false } = {}) {
  const registry = createRegistry()

  // 260730: follow is a MODE, and any other action ENDS it. `_target` in
  // follow.js is module-level state that a 1s tick keeps re-installing as a
  // GoalFollow whenever the body is idle, so a stale target does not just sit
  // there — it actively yanks the bot back mid-task, and it survives the thing
  // it was following becoming unreachable (live: the player died, the bot kept
  // trailing a corpse-position it could not path to and dug itself into a hole
  // it then could not leave). goTo and explore have cleared it since 260607;
  // every other acting action now does too, via one wrapper here so a NEW
  // action inherits the rule instead of having to remember it.
  //
  // Exempt, and why:
  //   follow            — sets the target; clearing it first would be a no-op fight
  //   goTo, explore     — self-managed: explore's up/down early returns
  //                       deliberately do NOT move the bot, so they must not
  //                       drop follow either (see its handler)
  //   find, readSign,
  //   look, setPvp      — pure queries / a config toggle. They do not move the
  //                       body, so "look at that" while trailing keeps trailing.
  const FOLLOW_EXEMPT = new Set(['follow', 'goTo', 'explore', 'find', 'readSign', 'look', 'setPvp'])
  const registerRaw = registry.register.bind(registry)
  registry.register = (name, schema, handler, description = '') => {
    const wrapped = FOLLOW_EXEMPT.has(name)
      ? handler
      : (args, bot, config) => {
        setFollowTarget(null)
        return handler(args, bot, config)
      }
    return registerRaw(name, schema, wrapped, description)
  }

  registry.register(
    'goTo',
    z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      // 261019 (quality pass 19): walk to a player where they are NOW. The
      // model copied player coords out of an older snapshot or misread them
      // ("walked to a spot about 28 blocks from Alex").
      player: z.string().optional(),
      range: z.number().min(0).default(1),
    }).refine(
      (a) => (typeof a.player === 'string' && a.player.trim().length > 0)
          || (typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number'),
      { message: 'must specify player, or x,y,z' }
    ),
    async (args, bot, config) => {
      // 260607: an explicit goTo is a "relocate and stay" command — it ends
      // follow mode. Without this, the 1s follow tick (follow.js) would
      // re-install GoalFollow the instant goTo reaches its destination and yank
      // the bot back to the owner. Incidental actions (dig/gather/build) leave
      // follow intact so the bot resumes trailing after them.
      setFollowTarget(null)
      const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
      if (typeof args.player === 'string' && args.player.trim()) {
        return goToPlayer(bot, args.player.trim(), Math.max(args.range, 2), timeoutMs, config?.signal)
      }
      // Default range:2 when target matches a known player's position.
      // Only kicks in when the LLM omitted range
      // (Zod default fired range=1) and the coords align with a player.
      let range = args.range
      if (range <= 1 && isCoordsAtKnownPlayer(bot, args.x, args.y, args.z)) {
        range = 2
      }
      return goToCoords(bot, { x: args.x, y: args.y, z: args.z }, range, timeoutMs, config?.signal)
    }
  )

  // 261015: a dig that is out of reach while she stands right by the block
  // (a log up a cliff, ore behind a ledge) marks it unreachable, so the next
  // find or gather picks another one. 261025 (pass 27): the dig tool now walks
  // into reach first and says what reached her inventory (digTool.js), so an
  // "out of range" after that walk is the unreachable signal.
  registry.register('dig', DigSchema, (args, bot, config) => digToolAction(args, bot, config))

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
      // These early returns don't move the bot, so they deliberately do NOT
      // touch the follow target.
      if (args?.orientation === 'up') {
        return bot?.entity?.isInWater
          ? "you're in water — swimming up is automatic; stay put or dig up to break out"
          : "can't fly up — build up with scaffold/build, or dig up to break through the ceiling"
      }
      if (args?.orientation === 'down') {
        return 'can\'t drop straight down with explore — use dig to tunnel down'
      }
      // 260710: like goTo, explore is an explicit "leave where you are" relocate
      // — it ends follow mode. Without this, the 1s follow tick (follow.js)
      // re-installs GoalFollow the moment the hop lands and yanks the bot
      // straight back to the owner, so an explore-while-following walked out
      // and back with nothing gained (live cow-hunt run: explored 13 blocks,
      // snapshot still showed follow_target and pos back beside the player).
      setFollowTarget(null)
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
          // 261011: a creature name ("sheep") used to answer "no known IDs".
          if (mcData.entitiesByName?.[ids[0]]) return findEntity(bot, ids[0], args.maxDistance)
          return { found: false, reason: `no known IDs for ${args.name}` }
        }
        matching = idNums
      } else {
        matching = (b) => ids.includes(b?.name)
      }
      const healed = getHealedPos(bot) ?? bot.entity?.position
      const point = healed && Number.isFinite(healed.x) ? healed : undefined
      // 261015: look at more than the single nearest hit. Skip blocks a walk
      // or dig just failed to reach (behaviors/unreachable.js), so a retry
      // gets a different block instead of the same cliff log, and prefer a
      // block with an open face over one buried in rock: the nearest coal in
      // the errands eval was 17 blocks down inside the stone, the walk dug a
      // shaft after it, and she spent the rest of the session in the hole.
      const hits = bot.findBlocks({ matching, maxDistance: args.maxDistance, count: FIND_CANDIDATES, point }) ?? []
      if (!hits.length) {
        return { found: false, reason: `no ${args.name} in loaded chunks within ${args.maxDistance}m` }
      }
      const fresh = hits.filter((h) => !isUnreachable(bot, h))
      const skipped = hits.length - fresh.length
      if (!fresh.length) {
        return {
          found: false,
          reason: `every ${args.name} found nearby (${skipped}) is one you could not reach in the last few minutes. Explore to find others, or build or dig your way to one`,
        }
      }
      const distOf = (h) => (point && typeof h.distanceTo === 'function' ? h.distanceTo(point) : 0)
      // Depth below her counts extra: the walk down is a shaft she has to
      // come back up. An "exposed" ore 17 blocks down is usually on a cave
      // wall the walk cannot reach without digging (pass 10 compare,
      // errands-02-B: coal at y54 beat the surface coal 3 blocks farther).
      const depthOf = (h) => (point ? Math.max(0, point.y - h.y - DEPTH_FREE_M) : 0)
      const scoreOf = (c) => distOf(c) + (isExposed(bot, c) ? 0 : BURIED_PENALTY_M) + DEPTH_PENALTY_PER_M * depthOf(c)
      let h = fresh[0]
      let best = Infinity
      for (const c of fresh) {
        const score = scoreOf(c)
        if (score < best) { best = score; h = c }
      }
      // 261017 (pass 12): the nearest 24 can all be buried. In the 261016
      // errands eval a seed coal vein 16 blocks down filled the whole list,
      // so the exposed coal on the surface 3 blocks farther was never
      // scored, and she dug a shaft after the buried one (the eval arena has
      // ~135 coal nearer than its surface coal, so no fixed count is enough).
      // When the winner carries a penalty, ask for the nearest exposed ones
      // too (mineflayer applies a function useExtraInfo on top of
      // `matching`). Bounded: an exposed-only search reads every block of
      // every section in range until it has its count, so it is capped at
      // FIND_EXPOSED_MAX_M, and at the winner's score, since nothing farther
      // than that can beat it.
      if (point && best > distOf(h) + 0.5) {
        const reach = Math.min(args.maxDistance, FIND_EXPOSED_MAX_M, Math.ceil(best))
        let open = []
        try {
          open = bot.findBlocks({ matching, maxDistance: reach, count: FIND_EXPOSED, point, useExtraInfo: (b) => !!b?.position && isExposed(bot, b.position) }) ?? []
        } catch {}
        for (const c of open) {
          if (isUnreachable(bot, c)) continue
          const score = scoreOf(c)
          if (score < best) { best = score; h = c }
        }
      }
      const blk = bot.blockAt(h)
      const d = Number(distOf(h).toFixed(1))
      const out = {
        found: true,
        id: blk?.name ?? 'unknown',
        pos: { x: h.x, y: h.y, z: h.z },
        distance: d,
      }
      if (skipped) out.note = `skipped ${skipped} you could not reach recently`
      return out
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
  // guarantee. center defaults to the bot's position; the walls start on the
  // first air layer above the ground there (shelterBaseY).
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
  // 3×3 recipes need a crafting_table: craft() walks to one within 16 blocks
  // and makes missing planks/sticks from the bag first (261011, craft.js).
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
      // 261019 (pass 19): say whether the trail really goes on. It used to
      // claim "still trailing them" even when something had dropped the
      // target (a mob hit cleared it until this pass).
      const interrupted = () => getFollowTargetLabel() === label
        ? `follow ${label} interrupted (still trailing them)`
        : `follow ${label} ended (no longer following them)`
      if (signal.aborted) return interrupted()
      await new Promise(resolve => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); resolve() }
        signal.addEventListener('abort', onAbort)
      })
      return interrupted()
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

  // 261015 (quality pass 8): hand items to the player in one call (walk into
  // tossing range, face them, toss). Without it a hand-over was planned as a
  // goTo and the items never left her inventory. See behaviors/give.js.
  registry.register(
    'give',
    z.object({
      item: z.string(),
      count: z.number().int().min(1).max(64).optional(),
      player: z.string().optional(),
    }),
    giveAction
  )

  // 261011: walk onto dropped items so they get collected (gear after a
  // death, mob drops, blocks that fell off a gather).
  registry.register(
    'pickup',
    z.object({
      item: z.string().optional(),
      maxDistance: z.number().min(1).max(32).optional(),
    }),
    pickupAction
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
