// src/bot/adapter/minecraft/behaviors/build.js
//
// Cuboid build with hand-rolled jump+place scaffolding (D-04).
// Mirrors mineVein.js loop structure. Iterates Y↑→X→Z (D-07).
// Skips occupied cells (D-05). Walls-only when hollow:true (D-04 derivative).

import { Vec3 } from 'vec3'
import { placeBlockAction } from './place.js'
import { goTo } from './pathfind.js'
import { isNaturalBlock } from './naturalBlocks.js'
import { reason } from '../../../brain/errStrings.js'
import { bodyInCell } from './placeSpots.js'

export const DEFAULT_TIMEOUT_MS = 4000 // per-cell, inherited via placeBlockAction
export const ITERATION_ORDER = 'Y-asc, then nearest-to-builder first within each layer (hollow layers: perimeter walk rotated to start nearest)' // D-07 documented constant
export const WALK_TIMEOUT_MS = 6000 // walk-closer step per out-of-reach cell (best-effort)
const REACH = 4.5

/**
 * 260803. How far the builder may stand HORIZONTALLY from the cell it is about
 * to place. Deliberately much tighter than REACH, and deliberately only the
 * horizontal component, because the two axes are not alike for a player:
 *
 *   VERTICAL reach is normal. You stand on the ground beside a 5-high wall and
 *   place the whole column without moving; the 260709 eye-anchored `withinReach`
 *   exists precisely so the builder does that instead of scaffolding.
 *
 *   HORIZONTAL reach at range is NOT. Standing still and laying a run of blocks
 *   away from your feet is not something a player can do, and it looks like the
 *   bot cheating. Live symptom: a bridge grew several blocks out over a drop
 *   while the character never left the spot it started from.
 *
 * At 2.5 the builder places about two cells, steps, places two more, which is
 * what bridging actually looks like: it FOLLOWS the tip of its own build. It
 * also keeps the body near the work, so a bridge that is heading the wrong way
 * is obvious to the player standing there rather than something they discover
 * five blocks later.
 */
export const FOLLOW_HORIZ = 2.5
const JUMP_PLACE_WINDOW_MS = 800 // airborne budget to land the scaffold place
const LANDING_MAX_MS = 800       // max wait to settle on the new block
const SCAFFOLD_ATTEMPTS = 4      // re-jumps per layer before giving up
const REFIRE_MS = 120            // min gap between place packets within one jump
// 260730 jump timing. bot.placeBlock does not send the place packet the moment
// it is called: it aims at the block and waits a tick first, so a fire at the
// instant the feet clear the cell (feetY >= cellY + 1) lands the packet ~1-2
// ticks LATER, by which time the bot is at or past the apex and often already
// falling back into the cell — the server then rejects the block because the
// player's hitbox intersects it. That is the "it takes a few tries" behavior.
// So we fire one tick EARLY (a jump rises ~0.35 blocks in the tick after 0.75)
// and let the packet arrive while the bot is genuinely clear. An early packet
// that still arrives too soon is simply refused and refired; the loop reads
// success from the WORLD, never from the promise, so a wasted packet is free.
const PLACE_LEAD_Y = 0.75
const FACE_UP = new Vec3(0, 1, 0)

// 6 neighbor offsets in placement priority: floor first, then horizontal,
// then ceiling. Picker iterates this order; first non-air neighbor wins.
const FACE_PRIORITY = [
  { off: [0, -1, 0], face: [0, 1, 0] }, // ref below, place on its top
  { off: [0, 0, -1], face: [0, 0, 1] }, // ref north, place on its south face
  { off: [0, 0, 1], face: [0, 0, -1] },
  { off: [1, 0, 0], face: [-1, 0, 0] },
  { off: [-1, 0, 0], face: [1, 0, 0] },
  { off: [0, 1, 0], face: [0, -1, 0] }, // ref above, place on its bottom
]

// LLM-facing tool description moved to ../prompts.js → ACTION_DESCRIPTIONS.build.

/** Squared horizontal distance from `origin` to a cell's CENTER. Horizontal
 * only: ordering happens within one Y layer, where the vertical term is a
 * constant and cannot change the order, and horizontal is what the walk step
 * below actually has to close. */
function horizD2(c, origin) {
  const dx = (c.x + 0.5) - origin.x
  const dz = (c.z + 0.5) - origin.z
  return dx * dx + dz * dz
}

/**
 * 260803. Reorder ONE layer so the builder starts at the cell nearest itself.
 *
 * Y stays ascending (lowest first) — a build wants its own support under it
 * before the course above. What changed is X/Z: the old order was a min-corner
 * scan, so `build({from:{z:30}, to:{z:20}})` from z=42 began at z=20, the FAR
 * side, and the out-of-reach walk below marched the bot 22 blocks across the
 * terrain to get there. Live (260731) that walked Sui off a basalt ledge into
 * lava with the player still standing where the bridge was supposed to start.
 * Nearest-first makes a 1-wide span build OUTWARD FROM YOUR OWN FEET, which is
 * both what a bridge is and what makes a misaimed span fail cheaply and in
 * plain sight instead of expensively and 22 blocks away.
 */
function orderLayer(layer, hollow, origin) {
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.z) || layer.length < 2) return layer
  if (hollow) {
    // The perimeter walk is a CLOSED cycle (its last cell is adjacent to its
    // first), so ROTATING it to begin at the nearest cell keeps every
    // consecutive pair adjacent and only moves the seam. A full nearest-first
    // sort would not: on a ring it alternates between opposite walls at equal
    // radius, which is exactly the criss-cross the 260709 perimeter walk was
    // written to remove.
    let best = 0, bestD = Infinity
    for (let i = 0; i < layer.length; i++) {
      const d = horizD2(layer[i], origin)
      if (d < bestD) { bestD = d; best = i }
    }
    return best === 0 ? layer : layer.slice(best).concat(layer.slice(0, best))
  }
  // Solid layer: straight nearest-first. Array#sort is stable, so cells at
  // equal distance keep their scan order.
  return layer.slice().sort((a, b) => horizD2(a, origin) - horizD2(b, origin))
}

/**
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 * @param {boolean} hollow
 * @param {{x:number,y:number,z:number}|null} [origin] Builder position, read
 *   ONCE at call time. Ordering is fixed up front on purpose: re-sorting as the
 *   bot moves would make the sequence depend on wherever the walk step happened
 *   to land, which is nondeterministic and untestable. Omit for the raw
 *   min-corner order.
 */
export function enumerateBuildCells(from, to, hollow, origin = null) {
  const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x)
  const minY = Math.min(from.y, to.y), maxY = Math.max(from.y, to.y)
  const minZ = Math.min(from.z, to.z), maxZ = Math.max(from.z, to.z)
  const cells = []
  for (let y = minY; y <= maxY; y++) {
    const layer = []
    if (hollow) {
      // Perimeter-walk order (260709): emit each layer's wall cells as one
      // trip around the rectangle instead of X→Z scan order. The scan order
      // alternated between opposite walls, so the builder faced a far-side
      // cell every other step; walking the ring keeps consecutive cells
      // adjacent and the walk-closer step below cheap.
      const seen = new Set()
      const push = (x, z) => {
        const k = `${x},${z}`
        if (seen.has(k)) return
        seen.add(k)
        layer.push({ x, y, z })
      }
      for (let z = minZ; z <= maxZ; z++) push(minX, z)
      for (let x = minX + 1; x <= maxX; x++) push(x, maxZ)
      for (let z = maxZ - 1; z >= minZ; z--) push(maxX, z)
      for (let x = maxX - 1; x >= minX + 1; x--) push(x, minZ)
    } else {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          layer.push({ x, y, z })
        }
      }
    }
    for (const c of orderLayer(layer, hollow, origin)) cells.push(c)
  }
  return cells
}

function isAir(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

// 261011: a full collision block (stone, dirt, planks). Water, lava, grass and
// other pass-through blocks are not solid. The scaffold step reads success
// and its floor through this; isAir alone counted water as a placed block.
function isSolid(blk) {
  return !!blk && !isAir(blk.name) && blk.boundingBox === 'block'
}

// 261012: plants and snow a placed block simply replaces, as it does for a
// player. They used to count as "already solid", so a wall or shelter on
// grassy ground came out with a gap at every grass tuft and reported done.
// They are no use as a face to place against either.
const REPLACEABLE = new Set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'glow_lichen'])

export function isOccupied(bot, c) {
  const blk = bot.blockAt(new Vec3(c.x, c.y, c.z))
  return !!(blk && !isAir(blk.name) && !REPLACEABLE.has(blk.name))
}

export function pickReferenceFace(bot, c) {
  for (const { off, face } of FACE_PRIORITY) {
    const refPos = new Vec3(c.x + off[0], c.y + off[1], c.z + off[2])
    const refBlk = bot.blockAt(refPos)
    if (refBlk && !isAir(refBlk.name) && !REPLACEABLE.has(refBlk.name)) {
      return {
        refPos: { x: refPos.x, y: refPos.y, z: refPos.z },
        face: { x: face[0], y: face[1], z: face[2] },
      }
    }
  }
  return null
}

/** Horizontal (X/Z only) distance from the bot to a cell's center. */
export function horizToCell(bot, c) {
  const p = bot.entity?.position
  if (!p) return 0
  return Math.hypot(p.x - (c.x + 0.5), p.z - (c.z + 0.5))
}

export function withinReach(bot, c) {
  const p = bot.entity?.position
  if (!p) return false
  // Eye-anchored to the cell CENTER (260709) — the server measures placement
  // reach from the eyes, and the old feet-to-corner distance under-reported
  // reach by ~1.5 blocks upward. A 5-high wall is placeable from the ground
  // standing beside it; the feet-based check sent those cells to scaffolding.
  const eyeY = p.y + (Number.isFinite(bot.entity?.eyeHeight) ? bot.entity.eyeHeight : 1.62)
  const dx = p.x - (c.x + 0.5), dy = eyeY - (c.y + 0.5), dz = p.z - (c.z + 0.5)
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= REACH
}

/**
 * Place the scaffold block in the cell the feet just vacated, mid-jump. Fires
 * the place the instant the feet clear the target cell ON THE WAY UP — not at
 * the apex. placeBlock has unavoidable latency (it faces the block and waits a
 * tick); firing while still rising means the bot is HIGHER when the packet
 * lands, so the cell is reliably clear of its hitbox. The old code placed at the
 * apex, and that latency let the bot fall back into the cell before the packet
 * landed, so the server rejected the block. Success is read from the WORLD (the
 * target cell turned solid), not from placeBlock's promise. (260617)
 */
async function jumpPlace(bot, refBlock, col, cellY) {
  const targetCell = new Vec3(col.x, cellY, col.z)
  const deadline = Date.now() + JUMP_PLACE_WINDOW_MS
  let lastFire = 0
  while (Date.now() < deadline) {
    const cur = bot.blockAt(targetCell)
    if (isSolid(cur)) return true
    const now = Date.now()
    const feetY = bot.entity?.position?.y ?? 0
    // 260730: gate on the refire clock ONLY. The old code also held an
    // `inFlight` flag until placeBlock's promise settled — but a REJECTED place
    // does not settle until its own block-update wait times out (seconds), so
    // one early miss silently blocked every retry for the rest of the jump and
    // the whole attempt was wasted. Rising + past the lead height is the whole
    // condition now; the world check above is still the only success signal.
    if (bot.entity?.onGround === false && feetY >= cellY + PLACE_LEAD_Y && now - lastFire >= REFIRE_MS) {
      lastFire = now
      // Fire-and-forget: a missed place rejects seconds later via placeBlock's
      // own block-update wait; we don't await it — the world check confirms.
      Promise.resolve(bot.placeBlock(refBlock, FACE_UP)).catch(() => {})
    }
    await new Promise(r => setTimeout(r, 20))
  }
  return isSolid(bot.blockAt(targetCell))
}

async function waitForLanding(bot, maxMs, signal) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (bot.entity?.onGround || signal?.aborted) return
    await new Promise(r => setTimeout(r, 40))
  }
}

const MAX_SHUFFLES = 2
const SHUFFLE_MS = 1200
const HALF_WIDTH = 0.3 // player hitbox half-width

// 261102 (pass 36): someone standing in a cell. A player or mob gets a moment
// to move on (the scripted player follows her and kept walking into the wall
// she was building, which failed the cell at once and sent the model into the
// same build again). The wait is capped per build so a player who stays put
// costs seconds, not seconds per cell.
export const BODY_RETRY_MS = 3000
const BODY_WAIT_TOTAL_MS = 6000
const BODY_POLL_MS = 250
// How far she looks for a free spot to step to when she stands in a cell.
const STEP_OUT_RADIUS = 2
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Room to stand at feet cell x,y,z: a solid floor and two free cells. */
function standable(bot, x, y, z) {
  return isSolid(bot.blockAt(new Vec3(x, y - 1, z))) &&
    !isOccupied(bot, { x, y, z }) && !isOccupied(bot, { x, y: y + 1, z })
}

/**
 * 261102 (pass 36). The nearest spot she can stand on that keeps her body out
 * of every cell of the span. Null when there is none close by.
 * @param {Set<string>} span keys "x,y,z" of the span's cells
 */
export function stepOutSpot(bot, span) {
  const p = bot.entity?.position
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return null
  const fx = Math.floor(p.x), fy = Math.floor(p.y + 0.01), fz = Math.floor(p.z)
  let best = null
  for (let dx = -STEP_OUT_RADIUS; dx <= STEP_OUT_RADIUS; dx++) {
    for (let dz = -STEP_OUT_RADIUS; dz <= STEP_OUT_RADIUS; dz++) {
      if (dx === 0 && dz === 0) continue
      for (const dy of [0, 1, -1]) {
        const x = fx + dx, y = fy + dy, z = fz + dz
        if (span.has(`${x},${y},${z}`) || span.has(`${x},${y + 1},${z}`)) continue
        if (!standable(bot, x, y, z)) continue
        const who = bodyInCell(bot, { x, y, z })
        if (who && who !== 'you') continue
        const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) + Math.abs(dy) * 0.75
        if (!best || d < best.d) best = { x, y, z, d }
      }
    }
  }
  return best && { x: best.x, y: best.y, z: best.z }
}

/**
 * 261017. The block holding her up when the one under her feet column is
 * not solid: another cell her hitbox overlaps, with a solid top at the same
 * level and room to stand in. Null when there is none.
 */
export function supportCell(bot, cellY) {
  const p = bot.entity?.position
  if (!p) return null
  const fx = Math.floor(p.x), fz = Math.floor(p.z)
  let best = null
  for (const dx of [-HALF_WIDTH, 0, HALF_WIDTH]) {
    for (const dz of [-HALF_WIDTH, 0, HALF_WIDTH]) {
      const x = Math.floor(p.x + dx), z = Math.floor(p.z + dz)
      if (x === fx && z === fz) continue
      if (!isSolid(bot.blockAt(new Vec3(x, cellY - 1, z)))) continue
      if (isSolid(bot.blockAt(new Vec3(x, cellY, z))) || isSolid(bot.blockAt(new Vec3(x, cellY + 1, z)))) continue
      const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z)
      if (!best || d < best.d) best = { x, z, d }
    }
  }
  return best && { x: best.x, z: best.z }
}

/** Walk (no jump) onto the centre of cell (x, cellY, z) next to her. */
async function shuffleTo(bot, cell, cellY, signal) {
  const cx = cell.x + 0.5, cz = cell.z + 0.5
  const t0 = Date.now()
  bot._seiGazeHold = (bot._seiGazeHold ?? 0) + 1
  try {
    while (Date.now() - t0 < SHUFFLE_MS) {
      if (signal?.aborted) break
      const p = bot.entity.position
      if (Math.abs(p.x - cx) < 0.2 && Math.abs(p.z - cz) < 0.2) break
      try { await bot.lookAt?.(new Vec3(cx, p.y + 1.6, cz), true) } catch {}
      bot.setControlState?.('forward', true)
      await new Promise(r => setTimeout(r, 50))
    }
  } finally {
    // A reflex or survival takeover that cut the step short drives the body
    // now; clearing its controls would stall a creeper flee (as in
    // climbOut.js stepUpTo).
    if (!bot._seiReflexActive && !bot._seiSurvivalActive && !bot._seiCriticalRetreat) {
      bot.setControlState?.('forward', false)
    }
    bot._seiGazeHold = Math.max(0, (bot._seiGazeHold ?? 1) - 1)
  }
  await waitForLanding(bot, LANDING_MAX_MS, signal)
  return Math.floor(bot.entity.position.x) === cell.x && Math.floor(bot.entity.position.z) === cell.z && Math.floor(bot.entity.position.y) === cellY
}

/**
 * D-04: hand-rolled jump+place. Builds a column of `blockName` under the bot
 * until bot.entity.position.y ≥ targetY - 1 (so feet are at targetY-1 and the
 * next placement on the face above is in reach).
 */
export async function scaffoldUp(bot, blockName, targetY, config) {
  // 261011: every pass must raise the feet. Quality eval 2026-10-11
  // (gather_craft): standing in water, the feet cell already read as "placed",
  // the bot was on the floor so the landing wait returned at once, and the
  // loop spun on resolved promises without yielding. The event loop starved,
  // keep-alives stopped, and the server dropped the bot for the rest of the
  // session. Success is now a solid block, each pass yields a tick, and passes
  // that do not raise the feet count toward the attempt limit.
  let stalled = 0
  let shuffles = 0
  while (Math.floor(bot.entity.position.y) < targetY - 1) {
    if (config?.signal?.aborted) return 'aborted'
    await new Promise(r => setTimeout(r, 0))
    const yBefore = Math.floor(bot.entity.position.y)
    const invItem = bot.inventory.items().find(i => i.name === blockName)
    if (!invItem) return `no ${blockName} in inventory`
    try { await bot.equip(invItem, 'hand') }
    catch (e) { return `cannot hold ${blockName}: ${reason(e) || ''}`.trim() }

    // A single jump can miss the place (a hitch in the jump, a slow packet);
    // re-jump a few times before giving up on the whole build rather than
    // bailing on the first miss.
    let placed = false
    for (let attempt = 0; attempt < SCAFFOLD_ATTEMPTS && !placed; attempt++) {
      if (config?.signal?.aborted) return 'aborted'
      // Mid-air (still falling into the cell, or the last jump not landed):
      // the floor and head room read below would be off by a block.
      if (bot.entity?.onGround === false) {
        await waitForLanding(bot, LANDING_MAX_MS, config?.signal)
        if (config?.signal?.aborted) return 'aborted'
      }
      const pos = bot.entity.position
      const cellY = Math.floor(pos.y)               // cell the feet rest in / vacate on jump
      const col = { x: Math.floor(pos.x), z: Math.floor(pos.z) }
      const refBlock = bot.blockAt(new Vec3(col.x, cellY - 1, col.z))
      if (!isSolid(refBlock)) {
        // 261017 (pass 12): she can stand on the EDGE of a block with her
        // feet column over a gap (errands eval: centre over her own shaft,
        // held up by the block beside it), and the column under floor(x,z)
        // is then air. Step onto the block that is actually holding her up
        // and pillar from its centre.
        const support = shuffles < MAX_SHUFFLES ? supportCell(bot, cellY) : null
        if (!support) return 'scaffold failed: no solid floor below'
        shuffles++
        await shuffleTo(bot, support, cellY, config?.signal)
        if (config?.signal?.aborted) return 'aborted'
        attempt--
        continue
      }
      // 261017: a jump needs two blocks of air over her feet. With a block
      // right above her head the jump goes nowhere and the place can never
      // land, which used to come back as a bare "could not place block under
      // feet" after four wasted jumps.
      const roof = bot.blockAt(new Vec3(col.x, cellY + 2, col.z))
      if (isSolid(roof)) {
        // Review: only natural ground is hers to dig; a plank ceiling is
        // someone's build (the same rule as the climb's staircase).
        const advice = isNaturalBlock(roof.name)
          ? 'Dig that block out first, or move to a spot with open space above'
          : 'It looks built, and you do not dig through builds. Move to a spot with open space above, or leave by a door or stairs'
        return `scaffold failed: no head room. There is ${roof.name} at ${col.x},${cellY + 2},${col.z} right above your head, ` +
          `so you cannot jump to put a block under you. ${advice}`
      }

      // Hold the gaze controller (behaviors/gaze.js) off the head for this
      // aim + jump-place step so it doesn't fight the forced look-down.
      bot._seiGazeHold = (bot._seiGazeHold ?? 0) + 1
      try {
        // Face straight down first so the in-jump place doesn't spend airtime
        // turning toward the block. (pitch +PI/2 = straight down)
        try { await bot.look(bot.entity.yaw, Math.PI / 2, true) } catch {}

        bot.setControlState('jump', true)
        placed = await jumpPlace(bot, refBlock, col, cellY)
        bot.setControlState('jump', false)
        await waitForLanding(bot, LANDING_MAX_MS)      // settle before re-check / re-jump
      } finally {
        bot._seiGazeHold = Math.max(0, (bot._seiGazeHold ?? 1) - 1)
      }
    }
    if (!placed) {
      const feet = bot.blockAt(new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)))
      if (feet && (feet.name === 'water' || feet.name === 'lava')) {
        return `scaffold place failed: you are in ${feet.name}, where a jump does not clear the cell under you. Get onto dry ground first`
      }
      return 'scaffold place failed: could not place block under feet'
    }
    if (Math.floor(bot.entity.position.y) <= yBefore && ++stalled >= SCAFFOLD_ATTEMPTS) {
      return 'scaffold place failed: the block went down but you did not rise onto it'
    }
  }
  return 'ok'
}

/**
 * R-01 + R-03 + R-04. Cuboid build with internal scaffolding.
 * @param {{from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}, block:string, hollow?:boolean}} args
 * @param {object} bot
 * @param {{signal?:AbortSignal, onProgress?:(p:{placed:number,skipped:number,total:number,currentY:number})=>void}} [config]
 * @param {{goTo?:Function, partial?:boolean}} [deps]
 *   partial (261019, shelter only, never from the model's arguments): build
 *   as much of the span as this block covers and stop when it runs out,
 *   instead of refusing up front. shelter() then goes on with another kind.
 */
export async function buildAction(args, bot, config, deps = {}) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const walk = deps.goTo ?? goTo

  const invCount = () => bot.inventory.items().filter(i => i.name === args.block).reduce((n, i) => n + i.count, 0)
  if (invCount() === 0) return `no ${args.block} in inventory`

  // 260730: scaffolding is build's `below` direction. Placing blocks UNDER
  // yourself is the one build that has no fixed coordinates — where it goes
  // depends on where you are standing when the block lands — so it cannot be
  // expressed as a from/to span, and asking the model to compute the column it
  // is standing in was a coin flip. `{direction:'below', count:N}` pillars up N
  // blocks using the same jump+place scaffolding the cuboid path already uses
  // to reach high cells.
  if (args.direction === 'below') {
    const n = args.count ?? 1
    const have = invCount()
    if (have < n) {
      return `you only have ${have} ${args.block}, and pillaring up ${n} needs ${n}. Get more ${args.block} first, or pillar up ${have}.`
    }
    const startY = Math.floor(bot.entity?.position?.y ?? 0)
    // scaffoldUp climbs while floor(y) < targetY - 1, so targetY = start + n + 1
    // leaves the feet exactly n blocks higher.
    const r = await scaffoldUp(bot, args.block, startY + n + 1, config)
    const endY = Math.floor(bot.entity?.position?.y ?? startY)
    const rose = endY - startY
    if (r === 'aborted') return `aborted after pillaring up ${rose} of ${n}`
    if (r !== 'ok') {
      // 261017: say where she is, so a failed pillar is not read as progress.
      const p = bot.entity?.position
      const at = p ? `${Math.floor(p.x)},${endY},${Math.floor(p.z)}` : `y=${endY}`
      return rose > 0
        ? `pillared up ${rose} of ${n}, then stopped (now at ${at}): ${r}`
        : `could not pillar up, you did not rise and are still at ${at}: ${r}`
    }
    return `pillared up ${rose} block${rose === 1 ? '' : 's'} (standing at y=${endY})`
  }

  const cells = enumerateBuildCells(args.from, args.to, args.hollow === true, bot.entity?.position ?? null)
  const total = cells.length
  // Material check (260617): how many cells actually need a block placed (the
  // rest are already solid). If the bot runs out mid-build the end-return says
  // so explicitly — the old path returned "0 placed" with no hint that the real
  // problem was too few blocks (the log: a 84-cell wall attempted with 4 dirt).
  const needed = cells.reduce((n, c) => n + (isOccupied(bot, c) ? 0 : 1), 0)

  // 260730: decide BEFORE moving. Both of these used to be discovered only
  // after the builder had walked the span, scaffolded, and placed what it
  // could — minutes of the session spent to produce a result the block counts
  // predicted up front.
  if (needed === 0 && total > 0) {
    // 261102 (pass 36): a single block aimed AT the ground (the model gave the
    // ground block's own y, the most common failed build in free play: a
    // crafting table "into" grass). The block goes on top, as a player's would.
    const c = cells[0]
    const above = { x: c.x, y: c.y + 1, z: c.z }
    // Only on natural ground: the same block she just placed there (the model
    // repeating a 1-cell build that worked) would stack a tower, and water,
    // lava or a flower is not ground to stand a block on.
    const name = bot.blockAt(new Vec3(c.x, c.y, c.z))?.name ?? 'a block'
    if (total === 1 && !deps._lifted && isNaturalBlock(name) && name !== args.block && !isOccupied(bot, above)) {
      const r = await buildAction({ ...args, from: above, to: above }, bot, config, { ...deps, _lifted: true })
      return `${c.x},${c.y},${c.z} is already ${name}, so it went on top of it at y=${above.y}: ${r}`
    }
    return `built NOTHING: all ${total} cells of that span are ALREADY solid, so you are building into terrain. Pick a clear span: a wall starts on the first air layer above the ground, which is your own y when you stand on that ground.`
  }
  const have = invCount()
  if (have < needed && !deps.partial) {
    // 261019 (pass 19): the exact shortfall, so the same call is not retried.
    return `you only have ${have} ${args.block}, and that span needs ${needed} (${total} cells, ${total - needed} already solid), ${needed - have} short. Gather at least ${needed - have} more ${args.block} (or ask the player for some), or build a smaller span you can finish.`
  }

  let placed = 0, skippedSolid = 0, skippedFail = 0
  const skipped = () => skippedSolid + skippedFail
  const progress = (c) => config?.onProgress?.({ placed, skipped: skipped(), total, currentY: c.y })
  const abortedMsg = () => `aborted after ${placed} placed of ${total} cells`

  const spanKeys = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`))
  let bodyWaitLeft = Number.isFinite(deps.bodyWaitMs) ? deps.bodyWaitMs : BODY_WAIT_TOTAL_MS

  // 261102 (pass 36): she stands in the cell herself. Step to the nearest
  // free spot outside the span and try again. Before, a cell her own body
  // was in failed after one retry, and a shelter or a 1-cell build came back
  // "had you standing in them" for the model to puzzle out.
  async function stepOut(c) {
    const spot = stepOutSpot(bot, spanKeys)
    if (!spot) return
    await walk(bot, spot.x, spot.y, spot.z, 0, WALK_TIMEOUT_MS, signal)
    if (signal?.aborted) return
    if (bodyInCell(bot, c) === 'you') await shuffleTo(bot, spot, spot.y, signal)
  }

  // One cell. Returns 'placed' | 'solid' | 'unreachable' | 'noref' | 'failed'
  // | 'aborted', or { halt } when scaffolding gave up on the whole build.
  async function tryCell(c, { stepOutOfIt = false } = {}) {
    if (isOccupied(bot, c)) return 'solid'
    // 261012: nothing to place against yet. Deferred by the caller, not
    // failed: a roof's inner cells and a wall cell over a dip in the ground
    // only get a neighbor once the cells around them are down. Checked before
    // walking so a floating span costs no walks.
    if (!pickReferenceFace(bot, c)) return 'noref'

    // 260709: WALK before scaffolding. scaffoldUp only pillars straight up at
    // the bot's current column — it never closes horizontal distance, so a
    // far-wall cell used to fall through to a placeBlock that burned its 4s
    // timeout and counted as a silent skip. The live symptom: a 4-wall hollow
    // build finished as the two walls near the bot's corner (49 placed, 71
    // skipped) while the far walls were never touched.
    //
    // 260803: this step now fires on FOLLOW_HORIZ rather than on total reach,
    // so the builder keeps up with its own work instead of only moving once a
    // cell has fallen out of reach entirely. FOLLOW_HORIZ (2.5) is below the
    // old trigger (REACH - 1 = 3.5), so this strictly subsumes it — every cell
    // that used to trigger a walk still does.
    //
    // Best-effort by design, and the ordering below is what makes that safe: a
    // failed walk falls through to the SAME reach test as before, so the worst
    // case is today's behavior (place from range) rather than a stall. That
    // matters for bridging, where the goal column is thin air until the bridge
    // reaches it — `range: 2` is load-bearing there, since it lets the goal be
    // satisfied from the built part a couple of blocks short of the tip.
    if (horizToCell(bot, c) > FOLLOW_HORIZ) {
      await walk(bot, c.x, Math.floor(bot.entity?.position?.y ?? c.y), c.z, 2, WALK_TIMEOUT_MS, signal)
      if (signal?.aborted) return 'aborted'
    }

    if (!withinReach(bot, c)) {
      // Scaffold only if the cell is still ABOVE us after the walk.
      if (c.y > (bot.entity?.position?.y ?? c.y)) {
        const r = await scaffoldUp(bot, args.block, c.y, config)
        if (r === 'aborted') return 'aborted'
        if (r !== 'ok') return { halt: `build halted: ${r} (placed ${placed}/${total})` }
      }
      // Still out of reach after walking (and scaffolding, when the cell is
      // above) — skip WITHOUT attempting the place. The doomed placeBlock
      // used to cost its full timeout per far cell.
      if (!withinReach(bot, c)) return 'unreachable'
    }

    const ref = pickReferenceFace(bot, c)
    if (!ref) return 'noref'
    // 261019 (pass 19): the server refuses a block where a body stands. That
    // used to read as "could not reach or place", and she retried the same
    // 1-cell build with the player (or herself) still in the cell.
    let body = bodyInCell(bot, c)
    if (body === 'you' && stepOutOfIt) {
      await stepOut(c)
      if (signal?.aborted) return 'aborted'
      body = bodyInCell(bot, c)
    }
    if (body && body !== 'you' && bodyWaitLeft > 0) {
      const t0 = Date.now()
      const until = t0 + Math.min(BODY_RETRY_MS, bodyWaitLeft)
      while (body && body !== 'you' && Date.now() < until) {
        await sleep(BODY_POLL_MS)
        if (signal?.aborted) return 'aborted'
        body = bodyInCell(bot, c)
      }
      bodyWaitLeft -= Date.now() - t0
    }
    if (body) return { body }

    const r = await placeBlockAction(
      {
        block: args.block,
        against: { x: ref.refPos.x, y: ref.refPos.y, z: ref.refPos.z },
        faceVector: ref.face,
      },
      bot,
      config,
    )
    if (r === 'aborted') return 'aborted'
    // Other failure strings (no inventory, cannot place, timeout) count as
    // failed per mineVein discipline: aggregate failure surfaces via K<N.
    return typeof r === 'string' && r.startsWith('placed ') ? 'placed' : 'failed'
  }

  // Cells skipped because someone stood in them, by who.
  const bodies = new Map()
  function noteBody(r) {
    if (r?.body) bodies.set(r.body, (bodies.get(r.body) ?? 0) + 1)
  }
  function bodyNote() {
    if (!bodies.size) return ''
    const n = [...bodies.values()].reduce((a, b) => a + b, 0)
    const who = [...bodies.keys()].join(' and ')
    return ` ${n} of them had ${who} standing in them; a block cannot go where a body is, so move out of the span (or wait for them to) and build again.`
  }

  // 261102 (pass 36): remember that the bag emptied with cells left. The
  // check at the end used to re-read the bag, and a dropped block she picked
  // up in between (she digs shelter blocks out of the ground right there) hid
  // the stop: "built 8 placed, 0 skipped (already solid), of 9 cells" read
  // as a finished roof with one cell missing.
  let ranOutWithCellsLeft = false
  const ranOut = () => {
    const out = deps.partial === true && invCount() === 0
    if (out) ranOutWithCellsLeft = true
    return out
  }
  let deferred = []
  for (const c of cells) {
    if (signal?.aborted) return abortedMsg()
    if (ranOut()) break
    const r = await tryCell(c)
    if (r === 'aborted') return abortedMsg()
    if (r?.halt) return r.halt
    if (r === 'placed') placed++
    else if (r === 'solid') skippedSolid++
    else if (r === 'noref') { deferred.push(c); continue }
    // She stands in it herself: try it again after the rest, when the walks
    // to the other cells have moved her.
    else if (r?.body === 'you') { deferred.push(c); continue }
    else { skippedFail++; noteBody(r) }
    progress(c)
  }

  // 261012: retry the cells that had nothing to attach to, now that their
  // neighbors may be down. Keeps going while a pass places something, so a
  // solid roof fills in from its edges toward the middle.
  while (deferred.length && !ranOut()) {
    const next = []
    const placedBefore = placed
    for (const c of deferred) {
      if (signal?.aborted) return abortedMsg()
      if (ranOut()) { next.push(c); continue }
      const r = await tryCell(c, { stepOutOfIt: true })
      if (r === 'aborted') return abortedMsg()
      if (r?.halt) return r.halt
      if (r === 'placed') placed++
      else if (r === 'solid') skippedSolid++
      else if (r === 'noref') { next.push(c); continue }
      else { skippedFail++; noteBody(r) }
      progress(c)
    }
    deferred = next
    if (placed === placedBefore) break
  }
  const floating = deferred
  skippedFail += floating.length
  for (const c of floating) progress(c)

  // 261102 (pass 36): a wall or pillar that floats a layer or two above the
  // ground as a whole (the model counted from the ground block, or from its
  // own eyes) is built where it was meant to stand, on the ground. Nothing
  // was placed and nothing was walked to, so this costs one more pass.
  const tallSpan = args.from.y !== args.to.y
  if (tallSpan && !deps._lowered && placed === 0 && floating.length > 0 && skippedFail === floating.length && !bodies.size) {
    const ground = groundBelow(bot, floating)
    const lowY = Math.min(args.from.y, args.to.y), highY = Math.max(args.from.y, args.to.y)
    const drop = ground == null ? 0 : lowY - (ground + 1)
    if (drop >= 1 && drop <= 2) {
      const from = { ...args.from, y: args.from.y - drop }, to = { ...args.to, y: args.to.y - drop }
      const r = await buildAction({ ...args, from, to }, bot, config, { ...deps, _lowered: true })
      return `that span floated ${drop} above the ground, so it was built ${drop} lower, at y=${lowY - drop}..${highY - drop}: ${r}`
    }
  }

  // Ran out of material before finishing (this also catches scaffolding
  // consumption, since invCount() is the live remaining count). Make it an
  // explicit, actionable signal — gather/ask for more — instead of a bare
  // "0 placed" the model couldn't distinguish from building into terrain.
  if (placed < needed && (ranOutWithCellsLeft || invCount() === 0)) {
    return `built ${placed} of ~${needed} needed, then ran out of ${args.block}. Get more ${args.block} (gather it, or ask the player for it) before finishing this build.`
  }

  // 260607: a 0-placed result is NOT a soft success — every cell was already
  // solid (building into terrain or at the bot's own feet level). The model
  // previously read "built 0 placed, N skipped" as progress and kept
  // "extending" a bridge that never grew. Make the no-op explicit so it
  // changes coordinates instead of repeating the same call.
  if (placed === 0 && total > 0 && skippedFail === 0) {
    return `built NOTHING: all ${total} cells were already occupied, so you are placing into solid blocks. Pick a clear span: a wall starts on the first air layer above the ground.`
  }
  // Skip-reason honesty (260709): the bare "N skipped" read as done — the
  // model rationalized 71 missing wall cells as "uneven terrain" and moved
  // on. Name what is missing and tell it the fix is another build call.
  if (skippedFail > 0) {
    // 261012: say WHY. A span that starts a layer above the ground has no
    // block under or beside any cell, and "walk closer and try again" sent
    // the model back to the same floating span (quality eval build_shelter).
    if (floating.length > 0) {
      const head = `built ${placed} placed, ${skippedFail} cells FAILED, ${skippedSolid} were already solid, of ${total}. The build is incomplete: those ${skippedFail} cells are still missing.`
      // Something that rises out of the ground (more than one layer) gets
      // the exact layer to start on. A single flat layer may be a walkway
      // over a gap, where the ground far below is the wrong answer.
      const tall = args.from.y !== args.to.y
      const ground = tall ? groundBelow(bot, floating) : null
      const fix = ground != null
        ? ` They are floating: the ground under them is at y=${ground}, so start the span at y=${ground + 1}, the air layer right on top of the ground.`
        : ' They are floating with no block below or beside them. Start the span next to a solid block so the first cell has something to attach to (a walkway starts at the block under your own feet).'
      const rest = skippedFail - floating.length
      return `${head} ${floating.length} of them had nothing to place against.${fix}${bodyNote()}${rest > 0 ? ` The other ${rest} could not be reached or placed; walk near them and call build again on that span.` : ''}`
    }
    const inBody = [...bodies.values()].reduce((a, b) => a + b, 0)
    if (inBody > 0) {
      const rest = skippedFail - inBody
      return `built ${placed} placed, ${skippedFail} cells FAILED, ${skippedSolid} were already solid, of ${total}. The build is incomplete: those ${skippedFail} cells are still missing.${bodyNote()}${rest > 0 ? ` The other ${rest} could not be reached or placed; walk near them and call build again on that span.` : ''}`
    }
    return `built ${placed} placed, ${skippedFail} cells FAILED (could not reach or place them), ${skippedSolid} were already solid, of ${total}. The build is incomplete: those ${skippedFail} cells are still missing. Walk near the unbuilt part and call build again on that span to finish it.`
  }
  return `built ${placed} placed, ${skippedSolid} skipped (already solid), of ${total} cells`
}

// 261019 (quality pass 19): who stands in a build cell. Moved to placeSpots.js
// (261108) so placeBlock's own spot search can share it.
export { bodyInCell }

/**
 * 261012. The highest solid block under the lowest floating cell, scanning at
 * most 16 down; null when there is nothing under it in that range. Grass
 * tufts, snow layers and liquids are passed through: they are not ground.
 */
const LIQUID = new Set(['water', 'lava', 'bubble_column'])
function groundBelow(bot, cells) {
  const low = cells.reduce((a, c) => (c.y < a.y ? c : a), cells[0])
  for (let y = low.y - 1; y >= low.y - 16; y--) {
    const b = bot.blockAt(new Vec3(low.x, y, low.z))
    if (b && !isAir(b.name) && !REPLACEABLE.has(b.name) && !LIQUID.has(b.name)) return y
  }
  return null
}
