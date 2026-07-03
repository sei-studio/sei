// src/behaviors/shelter.js — thin shelter convenience (MCRAFT-06, D-09).
//
// NOT a new world primitive: a shelter is a COMPOSITION of the existing
// build()/dig() cuboid actions — four hollow walls + a solid roof layer, with a
// one-block-wide, two-tall doorway carved out of the front wall. Keeping it a
// composition preserves the closed-registry invariant (no new place/dig path)
// and the 256-cell guarantee (ShelterSchema caps size to 5 → ≤48 wall + 25 roof
// cells, well under the cap that buildAction's own schema enforces).
import { buildAction } from './build.js'
import { digAction } from './dig.js'

const WALL_HEIGHT = 3 // wall layers (y range height); roof sits one above.

export async function shelterAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const size = args?.size ?? 3
  const material = args?.material ?? 'cobblestone'

  // Default center = the bot's current position rounded. build sits on TOP of
  // terrain, so the structure base is bot.y + 1 (build.js COORD PICKING).
  const p = bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const cx = args?.center ? Math.round(args.center.x) : Math.round(p.x)
  const cz = args?.center ? Math.round(args.center.z) : Math.round(p.z)
  const baseY = args?.center ? Math.floor(args.center.y) + 1 : Math.floor(p.y) + 1

  const half = Math.floor((size - 1) / 2)
  const minX = cx - half
  const maxX = minX + size - 1
  const minZ = cz - half
  const maxZ = minZ + size - 1
  const topY = baseY + WALL_HEIGHT - 1 // highest wall layer
  const roofY = topY + 1

  // 1. Four hollow walls across the full height range.
  const wallsRes = await buildAction(
    { from: { x: minX, y: baseY, z: minZ }, to: { x: maxX, y: topY, z: maxZ }, block: material, hollow: true },
    bot,
    config,
  )
  if (wallsRes === 'aborted') return 'aborted'

  // 2. Solid roof: a single-Y cuboid capping the top.
  const roofRes = await buildAction(
    { from: { x: minX, y: roofY, z: minZ }, to: { x: maxX, y: roofY, z: maxZ }, block: material, hollow: false },
    bot,
    config,
  )
  if (roofRes === 'aborted') return 'aborted'

  // 3. Carve a one-block-wide, two-tall doorway out of the front (min-Z) wall,
  //    centered on the footprint, so the bot can walk in and out.
  const doorX = cx
  const doorRes = await digAction(
    { x: doorX, y: baseY, z: minZ, to: { x: doorX, y: baseY + 1, z: minZ } },
    bot,
    config,
  )
  if (doorRes === 'aborted') return 'aborted'

  return `built shelter ${size}x${size}x${WALL_HEIGHT} with a doorway (walls: ${wallsRes}; roof: ${roofRes}; doorway: ${doorRes})`
}
