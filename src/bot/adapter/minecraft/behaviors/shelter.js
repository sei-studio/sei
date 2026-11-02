// src/behaviors/shelter.js — thin shelter convenience (MCRAFT-06, D-09).
//
// NOT a new world primitive: a shelter is a COMPOSITION of the existing
// build()/dig() cuboid actions — four hollow walls + a solid roof layer, with a
// one-block-wide, two-tall doorway carved out of the front wall. Keeping it a
// composition preserves the closed-registry invariant (no new place/dig path)
// and the 256-cell guarantee (ShelterSchema caps size to 5 → ≤48 wall + 25 roof
// cells, well under the cap that buildAction's own schema enforces).
import { Vec3 } from 'vec3'
import { buildAction, enumerateBuildCells, isOccupied, bodyInCell } from './build.js'
import { digAction } from './dig.js'
import { digToolAction } from './digTool.js'
import { goTo as realGoTo } from './pathfind.js'

// Wall layers (y range height); the roof sits one above. 261102 (pass 36):
// 2, not 3. A 2-high room fits her and the player, and a 3x3 now takes 25
// blocks instead of 33, which is the difference between a shelter and a
// refusal on most nights.
const WALL_HEIGHT = 2

// 261102 (pass 36): when she is short of blocks she digs them out of the
// ground around the shelter first. 65 of 82 shelter calls in the free-play
// evals since 10-20 came back "no shelter built" for want of blocks, and the
// gather('dirt') she ran next dug the pit she then built the shelter in.
// Dirt-like ground breaks by hand and drops dirt; stone needs a pickaxe.
const HAND_DIG = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt'])
const PICK_DIG = new Set(['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff'])
export const SUPPLY_RADIUS = 6
export const SUPPLY_BUDGET_MS = 75000
const SUPPLY_FAILS = 4

// 261012: cheap full blocks the shelter may switch to when the asked material
// runs short (the quality eval gave her 64 planks + 64 cobblestone, and a 5x5
// needs 73: the walls went up in planks and the roof was refused).
const FILLER = /^(cobblestone|cobbled_deepslate|stone|dirt|coarse_dirt|netherrack|blackstone|andesite|diorite|granite|tuff|deepslate|sandstone|red_sandstone|bricks|stone_bricks|mud_bricks|[a-z_]+_planks)$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 261019 (pass 19): how long a player standing where a wall goes gets to
// step away before the shelter gives up and says so.
export const BODY_WAIT_MS = 4000
const BODY_POLL_MS = 250
// Her hitbox is 0.6 wide, so within 0.2 of the middle of her block (on each
// axis) she overlaps no neighbor cell. 0.15 from the middle is inside that.
const CENTER_TOL = 0.15
const CENTER_BUDGET_MS = 1500

function invCount(bot, name) {
  try { return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0) } catch { return 0 }
}

function solidAt(bot, x, y, z) {
  const b = bot.blockAt?.(new Vec3(x, y, z))
  if (!b) return null // unloaded: unknown
  return b.boundingBox === 'block' && !/^(air|cave_air|void_air)$/.test(b.name)
}

/**
 * 261012. The layer the walls start on: the first air layer on top of solid
 * ground at the center column, searched a few blocks either way from `y0`.
 * The old base was floor(bot.y) + 1, one layer ABOVE the ground the bot
 * stands on, so every wall cell floated with nothing under or beside it and
 * all 48 cells of a 5x5 failed (quality eval build_shelter: 0 placed in every
 * direct trial). A `center` the model passes may be its feet (pos: y) or the
 * ground block under them; both land on the same layer here.
 */
export function shelterBaseY(bot, cx, y0, cz) {
  let y = y0
  for (let i = 0; i < 3 && solidAt(bot, cx, y, cz) === true; i++) y++
  for (let i = 0; i < 4 && solidAt(bot, cx, y - 1, cz) === false; i++) y--
  return y
}

/** Air cells a span still needs. */
function cellsNeeded(bot, from, to, hollow) {
  return enumerateBuildCells(from, to, hollow).reduce((n, c) => n + (isOccupied(bot, c) ? 0 : 1), 0)
}

/**
 * 261019 (pass 19). The kinds of block she can build a shelter part with, in
 * the order to use them: the asked material first, then the filler she has
 * most of. [{name, n}], only kinds she has.
 */
export function buildingKinds(bot, material) {
  const seen = new Map()
  let items = []
  try { items = bot.inventory.items() } catch {}
  for (const it of items) {
    if (it.name !== material && !FILLER.test(it.name)) continue
    seen.set(it.name, (seen.get(it.name) ?? 0) + it.count)
  }
  const kinds = [...seen].map(([name, n]) => ({ name, n }))
  kinds.sort((a, b) => (a.name === material ? -1 : b.name === material ? 1 : b.n - a.n))
  return kinds
}

/** "20 oak_planks, 6 dirt" */
function kindsText(kinds) {
  return kinds.map(k => `${k.n} ${k.name}`).join(', ')
}

/**
 * Build one part (walls or roof), switching kind when one runs out. Returns
 * the last build result and the kinds used. Stops at the first result that is
 * neither finished nor a run-out (a real failure, or an abort).
 */
async function buildPart(bot, config, span, material, hollow) {
  const used = []
  let res = null
  for (const k of buildingKinds(bot, material)) {
    if (invCount(bot, k.name) === 0) continue
    res = await buildAction({ ...span, block: k.name, hollow }, bot, config, { partial: true })
    if (!(typeof res === 'string' && /^no \S+ in inventory$/.test(res))) used.push(k.name)
    if (isAborted(res) || buildComplete(res)) break
    if (!(typeof res === 'string' && /then ran out of /.test(res))) break
  }
  return { res: res ?? `no ${material} in inventory`, used }
}

/** Players standing in the bottom ring of the walls: [{who, at}]. */
function playersInRing(bot, minX, maxX, minZ, maxZ, y) {
  const out = []
  for (const c of enumerateBuildCells({ x: minX, y, z: minZ }, { x: maxX, y, z: maxZ }, true)) {
    const who = bodyInCell(bot, c)
    if (who && who !== 'you' && isPlayerName(bot, who)) out.push({ who, at: c })
  }
  return out
}

function isPlayerName(bot, name) {
  return Object.values(bot.entities ?? {}).some(e => e?.username === name)
}

/**
 * She stands in the middle cell but her hitbox pokes into a wall cell (she
 * stood near the edge of her block), so that wall block could not go down.
 * Sneak to the middle of her block first.
 */
async function stepToMiddle(bot, cx, cz, signal) {
  const tx = cx + 0.5, tz = cz + 0.5
  const off = () => {
    const p = bot.entity?.position
    return p ? Math.hypot(p.x - tx, p.z - tz) : 0
  }
  if (off() <= CENTER_TOL || typeof bot.setControlState !== 'function') return
  try { bot.pathfinder?.stop?.() } catch {}
  const end = Date.now() + CENTER_BUDGET_MS
  try {
    bot.setControlState('sneak', true)
    while (off() > CENTER_TOL && Date.now() < end && !signal?.aborted) {
      const p = bot.entity.position
      try { await bot.lookAt?.(new Vec3(tx, p.y + 1.62, tz), true) } catch {}
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('sneak', false) } catch {}
  }
}

function blocksOnHand(bot, material) {
  return buildingKinds(bot, material).reduce((n, k) => n + k.n, 0)
}

/**
 * 261102 (pass 36). Blocks she may dig for the shelter: the top block of each
 * column near it, outside the footprint and the ring of ground around it (so
 * the walls keep their footing), off the path to the doorway, and not under
 * anyone's feet.
 */
export function supplyCandidates(bot, { cx, cz, baseY, minX, maxX, minZ, maxZ, doorX }) {
  const canPick = (() => { try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name)) } catch { return false } })()
  const out = []
  for (let dx = -SUPPLY_RADIUS; dx <= SUPPLY_RADIUS; dx++) {
    for (let dz = -SUPPLY_RADIUS; dz <= SUPPLY_RADIUS; dz++) {
      const x = cx + dx, z = cz + dz
      if (x >= minX - 1 && x <= maxX + 1 && z >= minZ - 1 && z <= maxZ + 1) continue
      if (x === doorX && z < minZ && z >= minZ - 3) continue
      for (let y = baseY + 1; y >= baseY - 3; y--) {
        const b = bot.blockAt?.(new Vec3(x, y, z))
        if (!b) break
        if (!isOccupied(bot, { x, y, z })) continue
        if ((HAND_DIG.has(b.name) || (canPick && PICK_DIG.has(b.name))) && !bodyInCell(bot, { x, y: y + 1, z })) {
          out.push({ x, y, z })
        }
        break
      }
    }
  }
  return out
}

/**
 * Dig up to `want` building blocks from `cands`, nearest to her first, within
 * the time budget. Returns how many reached her bag.
 */
async function digForBlocks(bot, config, material, want, cands, digBlock) {
  const signal = config?.signal
  const end = Date.now() + SUPPLY_BUDGET_MS
  const left = cands.slice()
  let got = 0, fails = 0
  let stop = 'none_left'
  while (got < want && left.length) {
    if (fails >= SUPPLY_FAILS) { stop = 'fails'; break }
    if (Date.now() >= end) { stop = 'time'; break }
    if (signal?.aborted) return { got, aborted: true }
    const p = bot.entity?.position
    if (p) {
      const d = (c) => Math.hypot(c.x + 0.5 - p.x, c.y + 0.5 - (p.y + 1.62), c.z + 0.5 - p.z)
      left.sort((a, b) => d(a) - d(b))
    }
    const c = left.shift()
    if (!isOccupied(bot, c)) continue
    const before = blocksOnHand(bot, material)
    const r = await digBlock({ x: c.x, y: c.y, z: c.z }, bot, config)
    if (r === 'aborted' || signal?.aborted) return { got, aborted: true }
    const gain = blocksOnHand(bot, material) - before
    if (gain > 0) { got += gain; fails = 0 } else fails++
  }
  return { got, stop }
}

/** Kinds of block she dug, for the result: "12 dirt". */
function dugText(bot, material, before) {
  const now = new Map(buildingKinds(bot, material).map(k => [k.name, k.n]))
  const parts = []
  for (const [name, n] of now) {
    const d = n - (before.get(name) ?? 0)
    if (d > 0) parts.push(`${d} ${name}`)
  }
  return parts.join(', ')
}

/**
 * 261102 (pass 36). Her own body in a wall cell fails that cell. The model
 * nearly always passes `center`, and then she was never moved: she stood
 * where a wall goes and the result said "had you standing in them". Walk to
 * the middle of the shelter when there is room to stand there.
 */
async function standClearOfWalls(bot, wallCells, cx, baseY, cz, signal, walk, backInside = false) {
  const inWalls = () => wallCells.some(c => bodyInCell(bot, c) === 'you')
  if (!inWalls() && !backInside) return
  const p = bot.entity?.position
  const inMiddle = p && Math.floor(p.x) === cx && Math.floor(p.z) === cz
  if (!inMiddle) {
    if (solidAt(bot, cx, baseY - 1, cz) !== true || isOccupied(bot, { x: cx, y: baseY, z: cz }) || isOccupied(bot, { x: cx, y: baseY + 1, z: cz })) return
    try { await walk(bot, cx, baseY, cz, 0, 6000, signal) } catch {}
    if (signal?.aborted) return
  }
  await stepToMiddle(bot, cx, cz, signal)
}

export async function shelterAction(args, bot, config, deps = {}) {
  const walk = deps.goTo ?? realGoTo
  const digBlock = deps.digBlock ?? digToolAction
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const size = args?.size ?? 3
  const material = args?.material ?? 'cobblestone'

  // Default center = the bot's current position.
  const p = bot.entity?.position ?? { x: 0, y: 64, z: 0 }
  const cx = args?.center ? Math.round(args.center.x) : Math.floor(p.x)
  const cz = args?.center ? Math.round(args.center.z) : Math.floor(p.z)
  const y0 = args?.center ? Math.floor(args.center.y) : Math.floor(p.y)
  const baseY = shelterBaseY(bot, cx, y0, cz)

  const half = Math.floor((size - 1) / 2)
  const minX = cx - half
  const maxX = minX + size - 1
  const minZ = cz - half
  const maxZ = minZ + size - 1
  const topY = baseY + WALL_HEIGHT - 1 // highest wall layer
  const roofY = topY + 1

  const wallFrom = { x: minX, y: baseY, z: minZ }, wallTo = { x: maxX, y: topY, z: maxZ }
  const roofFrom = { x: minX, y: roofY, z: minZ }, roofTo = { x: maxX, y: roofY, z: maxZ }
  const notes = []

  // 1. Enough blocks for the whole shelter? 261019 (pass 19): the walls used
  // to need enough of ONE kind, so 20 planks and 30 dirt came back "1 short"
  // and she retried the same call, or crafted the planks away. Now any full
  // building block she carries counts, walls and roof together. 261102
  // (pass 36): when that is not enough she digs the rest out of the ground
  // nearby, and only says the shortfall when the ground could not cover it.
  const wallNeed = cellsNeeded(bot, wallFrom, wallTo, true)
  const roofNeed = cellsNeeded(bot, roofFrom, roofTo, false)
  const need = wallNeed + roofNeed
  const doorX = cx
  let have = blocksOnHand(bot, material)
  let supplyStop = null
  // Inside the footprint when she called it (the default: centered on her).
  const sp = bot.entity?.position
  const startedInside = !!sp && Math.floor(sp.x) > minX && Math.floor(sp.x) < maxX && Math.floor(sp.z) > minZ && Math.floor(sp.z) < maxZ
  let wentDigging = false
  if (have < need) {
    const before = new Map(buildingKinds(bot, material).map(k => [k.name, k.n]))
    const cands = supplyCandidates(bot, { cx, cz, baseY, minX, maxX, minZ, maxZ, doorX })
    const dug = cands.length ? await digForBlocks(bot, config, material, need - have, cands, digBlock) : { got: 0, stop: 'none_left' }
    supplyStop = dug.stop
    wentDigging = cands.length > 0
    const dugWhat = dugText(bot, material, before)
    if (dug.aborted) {
      return `shelter stopped while digging blocks for it, nothing is built yet${dugWhat ? ` (dug ${dugWhat} so far)` : ''}`
    }
    if (dugWhat) notes.push(`dug ${dugWhat} nearby first`)
    have = blocksOnHand(bot, material)
  }
  if (have < need) {
    const kinds = buildingKinds(bot, material)
    const short = need - have
    const smaller = size > 3
      ? `, or ask for a smaller shelter (size ${size - 1} or 3)`
      : ' (3x3 is the smallest shelter, so it will not fit in fewer blocks)'
    const what = kinds.length ? `${have} building blocks (${kindsText(kinds)})` : 'no building blocks'
    const why = supplyStop === 'time' ? 'digging took too long'
      : supplyStop === 'fails' ? 'the last few digs brought nothing in'
      : 'there is no more dirt or grass close by that you can dig by hand'
    const dugNote = notes.length ? ` You ${notes[0]}, then stopped: ${why}.`
      : supplyStop === 'none_left' ? ' There is no dirt or grass close by that you can dig for it.' : ` Digging for blocks failed: ${why}.`
    return `no shelter built: it needs ${need} full blocks (${wallNeed} for the walls, ${roofNeed} for the roof) and you have ${what}, ${short} short.${dugNote} Any mix of full blocks works (dirt, cobblestone, planks, stone). Gather at least ${short} more (or ask the player for some) before trying again${smaller}.`
  }

  // 2. Nobody in the way. A block cannot go where a body is: she stood near
  // the edge of her block, or the player stood next to her where the wall
  // goes (combat_night eval: the same 3x3 shelter failed three times with
  // the player in a wall cell).
  const wallCells = enumerateBuildCells(wallFrom, wallTo, true)
  // After digging around, she goes back in the middle when that is where she
  // was going to be.
  const awayFromMiddle = () => { const q = bot.entity?.position; return !!q && (Math.floor(q.x) !== cx || Math.floor(q.z) !== cz) }
  await standClearOfWalls(bot, wallCells, cx, baseY, cz, signal, walk, startedInside && wentDigging && awayFromMiddle())
  if (signal?.aborted) return 'aborted'
  let inRing = playersInRing(bot, minX, maxX, minZ, maxZ, baseY)
  const waitEnd = Date.now() + BODY_WAIT_MS
  while (inRing.length && Date.now() < waitEnd) {
    await sleep(BODY_POLL_MS)
    if (signal?.aborted) return 'aborted'
    inRing = playersInRing(bot, minX, maxX, minZ, maxZ, baseY)
  }
  if (inRing.length) {
    const { who, at } = inRing[0]
    const where = `${at.x},${at.y},${at.z}`
    if (size === 3) {
      const h5 = 2, y5 = baseY
      const need5 = cellsNeeded(bot, { x: cx - h5, y: y5, z: cz - h5 }, { x: cx + h5, y: topY, z: cz + h5 }, true) +
        cellsNeeded(bot, { x: cx - h5, y: roofY, z: cz - h5 }, { x: cx + h5, y: roofY, z: cz + h5 }, false)
      return `no shelter built yet: ${who} is standing where a wall goes (${where}), and a block cannot go where someone stands. A 3x3 shelter only has room inside for you. Ask ${who} to step a few blocks away and build it again, or build size 5 so you both fit inside (that needs ${need5} blocks, you have ${have}).`
    }
    return `no shelter built yet: ${who} is standing where a wall goes (${where}), and a block cannot go where someone stands. Ask ${who} to step into the middle with you or a few blocks away, then build it again.`
  }

  // 3. Four hollow walls across the full height range, then a solid roof.
  // 261102 (pass 36): walls that are already there (she stands in a pit or
  // against a hillside) are a finished part, not "built NOTHING".
  const walls = wallNeed === 0
    ? { res: allThere(wallCells.length), used: [] }
    : await buildPart(bot, config, { from: wallFrom, to: wallTo }, material, true)
  const wallsRes = walls.res
  if (isAborted(wallsRes)) return abortedAt('walls', wallsRes)
  // 261011: a shelter with no walls is not a shelter. The result used to read
  // "built shelter 3x3x3 with a doorway (walls: no cobblestone in inventory...)"
  // and the model told the player they were safe inside.
  if (!placedSome(wallsRes)) return `no shelter built: walls: ${wallsRes}`
  if (walls.used.some(k => k !== material)) notes.push(`walls in ${walls.used.join(' and ')}`)

  const roof = roofNeed === 0
    ? { res: allThere(size * size), used: [] }
    : await buildPart(bot, config, { from: roofFrom, to: roofTo }, material, false)
  const roofRes = roof.res
  if (isAborted(roofRes)) return abortedAt('roof', roofRes, wallsRes)
  if (roof.used.some(k => k !== material)) notes.push(`roof in ${roof.used.join(' and ')}`)

  // 4. Carve a one-block-wide, two-tall doorway out of the front (min-Z) wall,
  //    centered on the footprint, so the bot can walk in and out.
  const inMiddleBeforeDoor = !awayFromMiddle()
  const doorRes = await digAction(
    { x: doorX, y: baseY, z: minZ, to: { x: doorX, y: baseY + 1, z: minZ } },
    bot,
    config,
  )
  if (doorRes === 'aborted') return 'aborted'
  // 261102 (pass 36): a dug dirt doorway drops an item and the dig walks onto
  // it, which left her standing in the doorway instead of inside (probe: 3 of
  // 3 dirt shelters; cobblestone dug by hand drops nothing, so it never
  // showed). Step back in when she was in the middle before the doorway.
  if (inMiddleBeforeDoor && awayFromMiddle()) {
    await standClearOfWalls(bot, wallCells, cx, baseY, cz, signal, walk, true)
    if (signal?.aborted) return 'aborted'
  }

  const done = buildComplete(wallsRes) && buildComplete(roofRes)
  const detail = `(walls: ${wallsRes}; roof: ${roofRes}; doorway: ${doorRes}${notes.length ? `; ${notes.join('; ')}` : ''})`
  if (!done) return `shelter UNFINISHED, it has gaps and is not safe yet ${detail}`
  return `built shelter ${size}x${size}x${WALL_HEIGHT} with a doorway at ${doorX},${baseY},${minZ} ${detail}`
}

/** A part whose every cell was already solid, in buildAction's words. */
function allThere(n) {
  return `built 0 placed, ${n} skipped (already solid), of ${n} cells`
}

/** buildAction stopped by an abort ('aborted' or 'aborted after ...'). */
function isAborted(r) {
  return typeof r === 'string' && r.startsWith('aborted')
}

// 261012: an interrupted build used to fall through to "no shelter built:
// walls: aborted after 32 placed of 48 cells", which reads as a failure to
// build rather than a stop partway.
function abortedAt(part, res, wallsRes) {
  const done = wallsRes ? `; walls: ${wallsRes}` : ''
  return `shelter stopped partway while building the ${part}, it is not finished (${part}: ${res}${done})`
}

/** buildAction placed at least one block, or the span was already all there. */
function placedSome(r) {
  return /^built [1-9]\d* /.test(r) || buildComplete(r)
}

/** buildAction finished the whole span (every cell placed or already solid). */
function buildComplete(r) {
  return /^built \d+ placed, \d+ skipped \(already solid\), of \d+ cells$/.test(r)
}
