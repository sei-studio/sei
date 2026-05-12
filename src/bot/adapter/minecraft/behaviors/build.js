// src/bot/adapter/minecraft/behaviors/build.js — Phase 7 R-01, R-03, R-04.
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
const APEX_MAX_MS = 600
const LANDING_MAX_MS = 800

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

export const BUILD_DESCRIPTION = "Place blocks in a cuboid region. Args: `{from:{x,y,z}, to:{x,y,z}, block:\"<name>\", hollow?:boolean}` — both corners are absolute; corners may be passed in any order. See seed_cuboid_grammar for shape recipes (pillar, wall, platform, tunnel, hollow shell). Volume cap is 256 cells per call. Build SKIPS occupied cells (will not break-and-replace — dig first if you need a fresh canvas) and silently scaffolds up by jumping and placing under itself when the next cell is above its reach. `hollow:true` places only the 4 vertical wall faces (no floor, no ceiling — compose those via flat single-Y cuboids). Returns `built K placed, S skipped, of N cells` or `aborted after K placed of N cells`. The `block` arg is REQUIRED — there is no inventory fallback."

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

async function waitForApex(bot, maxMs) {
  const start = Date.now()
  let lastY = bot.entity?.position?.y ?? 0
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 40))
    const y = bot.entity?.position?.y ?? lastY
    if (y <= lastY && bot.entity?.onGround === false) return
    lastY = y
  }
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
    const startY = bot.entity.position.y
    const invItem = bot.inventory.items().find(i => i.name === blockName)
    if (!invItem) return `no ${blockName} in inventory`
    try { await bot.equip(invItem, 'hand') }
    catch (e) { return `cannot hold ${blockName}: ${reason(e) || ''}`.trim() }
    bot.setControlState('jump', true)
    await waitForApex(bot, APEX_MAX_MS)
    bot.setControlState('jump', false)
    const refPos = new Vec3(
      Math.floor(bot.entity.position.x),
      Math.floor(startY) - 1,
      Math.floor(bot.entity.position.z),
    )
    const refBlock = bot.blockAt(refPos)
    if (!refBlock || isAir(refBlock.name)) return 'scaffold failed: no floor below'
    try {
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
    } catch (e) {
      return `scaffold place failed: ${reason(e) || ''}`.trim()
    }
    await waitForLanding(bot, LANDING_MAX_MS)
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

  const invItem = bot.inventory.items().find(i => i.name === args.block)
  if (!invItem) return `no ${args.block} in inventory`

  const cells = enumerateBuildCells(args.from, args.to, args.hollow === true)
  const total = cells.length
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

  return `built ${placed} placed, ${skipped} skipped, of ${total} cells`
}
