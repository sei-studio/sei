// src/bot/adapter/minecraft/behaviors/build.js
//
// Cuboid build with hand-rolled jump+place scaffolding (D-04).
// Mirrors mineVein.js loop structure. Iterates Y↑→X→Z (D-07).
// Skips occupied cells (D-05). Walls-only when hollow:true (D-04 derivative).

import { Vec3 } from 'vec3'
import { placeBlockAction } from './place.js'
import { reason } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 4000 // per-cell, inherited via placeBlockAction
export const ITERATION_ORDER = 'Y-asc → X-asc → Z-asc' // D-07 documented constant
const REACH = 4.5
const JUMP_PLACE_WINDOW_MS = 800 // airborne budget to land the scaffold place
const LANDING_MAX_MS = 800       // max wait to settle on the new block
const SCAFFOLD_ATTEMPTS = 3      // re-jumps per layer before giving up
const REFIRE_MS = 150            // min gap between place packets within one jump
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

export function enumerateBuildCells(from, to, hollow) {
  const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x)
  const minY = Math.min(from.y, to.y), maxY = Math.max(from.y, to.y)
  const minZ = Math.min(from.z, to.z), maxZ = Math.max(from.z, to.z)
  const cells = []
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (hollow) {
          const isWall = (x === minX || x === maxX || z === minZ || z === maxZ)
          if (!isWall) continue
        }
        cells.push({ x, y, z })
      }
    }
  }
  return cells
}

function isAir(name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

export function isOccupied(bot, c) {
  const blk = bot.blockAt(new Vec3(c.x, c.y, c.z))
  return !!(blk && !isAir(blk.name))
}

export function pickReferenceFace(bot, c) {
  for (const { off, face } of FACE_PRIORITY) {
    const refPos = new Vec3(c.x + off[0], c.y + off[1], c.z + off[2])
    const refBlk = bot.blockAt(refPos)
    if (refBlk && !isAir(refBlk.name)) {
      return {
        refPos: { x: refPos.x, y: refPos.y, z: refPos.z },
        face: { x: face[0], y: face[1], z: face[2] },
      }
    }
  }
  return null
}

export function withinReach(bot, c) {
  const p = bot.entity?.position
  if (!p) return false
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z
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
  let inFlight = false
  let lastFire = 0
  while (Date.now() < deadline) {
    const cur = bot.blockAt(targetCell)
    if (cur && !isAir(cur.name)) return true
    const now = Date.now()
    const feetY = bot.entity?.position?.y ?? 0
    if (!inFlight && bot.entity?.onGround === false && feetY >= cellY + 1 && now - lastFire >= REFIRE_MS) {
      lastFire = now
      inFlight = true
      // Fire-and-forget: a missed place rejects seconds later via placeBlock's
      // own block-update wait; we don't await it — the world check confirms.
      Promise.resolve(bot.placeBlock(refBlock, FACE_UP)).catch(() => {}).finally(() => { inFlight = false })
    }
    await new Promise(r => setTimeout(r, 20))
  }
  const cur = bot.blockAt(targetCell)
  return !!(cur && !isAir(cur.name))
}

async function waitForLanding(bot, maxMs) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (bot.entity?.onGround) return
    await new Promise(r => setTimeout(r, 40))
  }
}

/**
 * D-04: hand-rolled jump+place. Builds a column of `blockName` under the bot
 * until bot.entity.position.y ≥ targetY - 1 (so feet are at targetY-1 and the
 * next placement on the face above is in reach).
 */
export async function scaffoldUp(bot, blockName, targetY, config) {
  while (Math.floor(bot.entity.position.y) < targetY - 1) {
    if (config?.signal?.aborted) return 'aborted'
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
      const pos = bot.entity.position
      const cellY = Math.floor(pos.y)               // cell the feet rest in / vacate on jump
      const col = { x: Math.floor(pos.x), z: Math.floor(pos.z) }
      const refBlock = bot.blockAt(new Vec3(col.x, cellY - 1, col.z))
      if (!refBlock || isAir(refBlock.name)) return 'scaffold failed: no floor below'

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
    if (!placed) return 'scaffold place failed: could not place block under feet'
  }
  return 'ok'
}

/**
 * R-01 + R-03 + R-04. Cuboid build with internal scaffolding.
 * @param {{from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}, block:string, hollow?:boolean}} args
 * @param {object} bot
 * @param {{signal?:AbortSignal, onProgress?:(p:{placed:number,skipped:number,total:number,currentY:number})=>void}} [config]
 */
export async function buildAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const invCount = () => bot.inventory.items().filter(i => i.name === args.block).reduce((n, i) => n + i.count, 0)
  if (invCount() === 0) return `no ${args.block} in inventory`

  const cells = enumerateBuildCells(args.from, args.to, args.hollow === true)
  const total = cells.length
  // Material check (260617): how many cells actually need a block placed (the
  // rest are already solid). If the bot runs out mid-build the end-return says
  // so explicitly — the old path returned "0 placed" with no hint that the real
  // problem was too few blocks (the log: a 84-cell wall attempted with 4 dirt).
  const needed = cells.reduce((n, c) => n + (isOccupied(bot, c) ? 0 : 1), 0)
  let placed = 0, skipped = 0

  for (const c of cells) {
    if (signal?.aborted) return `aborted after ${placed} placed of ${total} cells`

    if (isOccupied(bot, c)) {
      skipped++
      config?.onProgress?.({ placed, skipped, total, currentY: c.y })
      continue
    }

    if (!withinReach(bot, c)) {
      const r = await scaffoldUp(bot, args.block, c.y, config)
      if (r === 'aborted') return `aborted after ${placed} placed of ${total} cells`
      if (r !== 'ok') return `build halted: ${r} (placed ${placed}/${total})`
    }

    const ref = pickReferenceFace(bot, c)
    if (!ref) {
      skipped++
      config?.onProgress?.({ placed, skipped, total, currentY: c.y })
      continue
    }

    const r = await placeBlockAction(
      {
        block: args.block,
        against: { x: ref.refPos.x, y: ref.refPos.y, z: ref.refPos.z },
        faceVector: ref.face,
      },
      bot,
      config,
    )
    if (r === 'aborted') return `aborted after ${placed} placed of ${total} cells`
    if (typeof r === 'string' && r.startsWith('placed ')) placed++
    // Other failure strings (no inventory, cannot place, timeout) — count as
    // skipped per mineVein discipline: aggregate failure surfaces via K<N.
    else skipped++

    config?.onProgress?.({ placed, skipped, total, currentY: c.y })
  }

  // Ran out of material before finishing (this also catches scaffolding
  // consumption, since invCount() is the live remaining count). Make it an
  // explicit, actionable signal — gather/ask for more — instead of a bare
  // "0 placed" the model couldn't distinguish from building into terrain.
  if (placed < needed && invCount() === 0) {
    return `built ${placed} of ~${needed} needed, then ran out of ${args.block}. Get more ${args.block} (gather it, or ask the player for it) before finishing this build.`
  }

  // 260607: a 0-placed result is NOT a soft success — every cell was already
  // solid (building into terrain or at the bot's own feet level). The model
  // previously read "built 0 placed, N skipped" as progress and kept
  // "extending" a bridge that never grew. Make the no-op explicit so it
  // changes coordinates instead of repeating the same call.
  if (placed === 0 && total > 0) {
    return `built NOTHING: all ${total} cells were already occupied — you are placing into solid blocks (or at your own feet level). Pick a clear span and set from.y = your y + 1.`
  }
  return `built ${placed} placed, ${skipped} skipped, of ${total} cells`
}
