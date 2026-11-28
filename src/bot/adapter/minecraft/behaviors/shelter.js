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
import { HOSTILE_MOBS } from './hostiles.js'

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
// Two more than the count: a block can go to scaffolding on the way up, or
// a cell can need a second try, and a roof one block short is no shelter
// (free-play eval 11-02: roof 8 of 9 after digging exactly the count).
export const SUPPLY_MARGIN = 2

// 261012: cheap full blocks the shelter may switch to when the asked material
// runs short (the quality eval gave her 64 planks + 64 cobblestone, and a 5x5
// needs 73: the walls went up in planks and the roof was refused).
const FILLER = /^(cobblestone|cobbled_deepslate|stone|dirt|coarse_dirt|rooted_dirt|netherrack|blackstone|andesite|diorite|granite|tuff|deepslate|sandstone|red_sandstone|bricks|stone_bricks|mud_bricks|[a-z_]+_planks)$/

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
    // _lowered: the shelter decides its own layers. Lowering the walls
    // alone (she stood on a pillar) left the roof a layer up with nothing
    // under it.
    res = await buildAction({ ...span, block: k.name, hollow }, bot, config, { partial: true, _lowered: true })
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
        // Solid under it: a 1-thick roof over a cave is not dug out.
        if ((HAND_DIG.has(b.name) || (canPick && PICK_DIG.has(b.name))) && !bodyInCell(bot, { x, y: y + 1, z }) && solidAt(bot, x, y - 1, z) === true) {
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
async function digForBlocks(bot, config, material, want, cands, digBlock, onDug = null) {
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
    // Checked again right before the dig: someone (her included) may have
    // walked onto it since the list was made.
    if (bodyInCell(bot, { x: c.x, y: c.y + 1, z: c.z })) continue
    const before = blocksOnHand(bot, material)
    const r = await digBlock({ x: c.x, y: c.y, z: c.z }, bot, config)
    if (r === 'aborted' || signal?.aborted) return { got, aborted: true }
    const gain = blocksOnHand(bot, material) - before
    if (gain > 0) { got += gain; fails = 0; onDug?.() } else fails++
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

// 261128 (pass 67): the pit shelter. When her bag is short of blocks the
// shelter used to dig the whole count (25 + 2 for a 3x3) out of the ground
// around it before placing the first one, about 2s a block, so roughly a
// minute of digging. In the combat_night free-play evals 11-14 to 11-27, 32
// of ~55 shelter calls ended "stopped while digging blocks for it, nothing is
// built yet" (a fight or the player calling her back stopped it after 4-45s),
// and she told the scared player the walls were going up. Dug into the ground
// instead, the ground itself is the walls: the inside of the footprint goes 3
// blocks down, and the top layer goes back as the roof (a roof one layer
// lower than the old ground has the ground beside it to be placed against). A
// 3x3 is 3 digs and 1 block, a few seconds. Whoever stands in the middle ends
// up inside; the model centers most shelters on the player.
export const PIT_DEPTH = 3
const LOOSE_DIG = new Set(['sand', 'red_sand', 'gravel', 'clay', 'dirt_path', 'farmland', 'snow_block'])
const LIQUID = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/
const GROUND_WAIT_MS = 800
const GROUND_TICK_MS = 100
const SETTLE_MS = 2000

function isAirName(n) { return /^(air|cave_air|void_air)$/.test(n) }

/** Inner columns of the footprint (inside the walls). */
function innerColumns(minX, maxX, minZ, maxZ) {
  const out = []
  for (let x = minX + 1; x <= maxX - 1; x++) for (let z = minZ + 1; z <= maxZ - 1; z++) out.push({ x, z })
  return out
}

/**
 * Can the footprint be dug in? Every inner cell of the PIT_DEPTH layers under
 * the walls' base must be air already (a pit left by an interrupted call) or
 * a block she can break by hand (or with her pickaxe), with solid floor under
 * it; every ring cell beside them must be solid ground. No liquid anywhere,
 * nothing unloaded. Returns { cells (top layer first), roofY } or null.
 */
export function pitPlan(bot, { baseY, minX, maxX, minZ, maxZ }) {
  const canPick = (() => { try { return bot.inventory.items().some(i => /_pickaxe$/.test(i.name)) } catch { return false } })()
  const inner = innerColumns(minX, maxX, minZ, maxZ)
  if (!inner.length) return null
  const cells = []
  for (let d = 1; d <= PIT_DEPTH; d++) {
    const y = baseY - d
    for (const { x, z } of inner) {
      const b = bot.blockAt?.(new Vec3(x, y, z))
      if (!b) return null
      if (isAirName(b.name)) continue
      if (!(HAND_DIG.has(b.name) || LOOSE_DIG.has(b.name) || (canPick && PICK_DIG.has(b.name)))) return null
      cells.push({ x, y, z })
    }
  }
  for (const { x, z } of inner) {
    if (solidAt(bot, x, baseY - PIT_DEPTH - 1, z) !== true) return null
    const top = bot.blockAt?.(new Vec3(x, baseY, z))
    if (!top || LIQUID.test(top.name)) return null
  }
  for (const c of enumerateBuildCells({ x: minX, y: baseY - PIT_DEPTH, z: minZ }, { x: maxX, y: baseY - 1, z: maxZ }, true)) {
    const b = bot.blockAt?.(new Vec3(c.x, c.y, c.z))
    if (!b || LIQUID.test(b.name) || b.boundingBox !== 'block' || isAirName(b.name)) return null
  }
  return { cells, roofY: baseY - 1 }
}

/** Who stands inside the footprint's inner columns: { me, players: [names], mobs: [names] }. */
function whoInside(bot, minX, maxX, minZ, maxZ, baseY) {
  const inCols = (p) => !!p && [p.x, p.y, p.z].every(Number.isFinite) &&
    Math.floor(p.x) > minX && Math.floor(p.x) < maxX && Math.floor(p.z) > minZ && Math.floor(p.z) < maxZ &&
    p.y >= baseY - PIT_DEPTH - 0.01 && p.y < baseY + 1.5
  const me = inCols(bot.entity?.position)
  const players = [], mobs = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !inCols(e.position)) continue
    if (e.type === 'player' || e.username) players.push(e.username ?? 'a player')
    else if (HOSTILE_MOBS.has(e.name)) mobs.push(e.name)
  }
  return { me, players, mobs }
}

/**
 * True while she stands in a roofed pit shelter this session dug (under its
 * roof, roof still on). Getting out means digging the roof and pillaring up
 * 3 blocks, which a live run (261128) measured at 10-15 s of pathfinding, so
 * goTo gives such a walk PIT_EXIT_MS more than its usual budget.
 */
export function inPitShelter(bot) {
  const pit = bot?._seiPit
  const p = bot?.entity?.position
  if (!pit || !p) return false
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
  if (x < pit.minX || x > pit.maxX || z < pit.minZ || z > pit.maxZ || y >= pit.roofY) return false
  return isOccupied(bot, { x, y: pit.roofY, z })
}
export const PIT_EXIT_MS = 15000

async function waitOnGround(bot, signal) {
  // onGround stays true for a physics tick after the block under her goes,
  // so let two ticks pass before trusting it.
  await sleep(GROUND_TICK_MS)
  const end = Date.now() + GROUND_WAIT_MS
  while (bot.entity && bot.entity.onGround === false && Date.now() < end && !signal?.aborted) await sleep(50)
}

// Until nobody is in a roof cell any more (whoever was on the ground there
// is still falling down the shaft), or SETTLE_MS. Live run 261128: the 1x1
// roof went on while she was still dropping through it and failed with "had
// you standing in them".
async function waitClearOf(bot, cells, signal) {
  const end = Date.now() + SETTLE_MS
  while (cells.some(c => bodyInCell(bot, c)) && Date.now() < end && !signal?.aborted) await sleep(50)
}

/**
 * Dig in (see PIT_DEPTH). Returns the result text, or null when this spot
 * cannot take a pit (the caller builds walls the old way).
 */
async function pitShelter(bot, config, deps, g) {
  const { size, material, cx, cz, minX, maxX, minZ, maxZ, report } = g
  const signal = config?.signal
  const walk = deps.goTo ?? realGoTo
  const digPit = deps.digPit ?? digAction
  // Called again from inside a pit an earlier call left half dug: the
  // center's floor is the pit's, so climb back to the ground level around it
  // (ground on all four sides of the column).
  let baseY = g.baseY
  for (let i = 0; i < PIT_DEPTH; i++) {
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solidAt(bot, cx + dx, baseY, cz + dz) === true) && !isOccupied(bot, { x: cx, y: baseY, z: cz })) baseY++
    else break
  }
  const plan = pitPlan(bot, { ...g, baseY })
  if (!plan) return null
  const inner = innerColumns(minX, maxX, minZ, maxZ)
  const roofFrom = { x: minX + 1, y: plan.roofY, z: minZ + 1 }
  const roofTo = { x: maxX - 1, y: plan.roofY, z: maxZ - 1 }
  const roofNeed = inner.length

  // Nobody in the middle yet: she goes in herself, like the walled shelter.
  let inside = whoInside(bot, minX, maxX, minZ, maxZ, baseY)
  if (!inside.me && !inside.players.length) {
    if (isOccupied(bot, { x: cx, y: baseY, z: cz }) || isOccupied(bot, { x: cx, y: baseY + 1, z: cz })) return null
    try { await walk(bot, cx, baseY, cz, 0, 6000, signal) } catch {}
    if (signal?.aborted) return 'aborted'
    inside = whoInside(bot, minX, maxX, minZ, maxZ, baseY)
    if (!inside.me) return null
  }

  // She stays outside (the player is in the middle): the dug blocks fall
  // down the shaft to them, so she gets the roof blocks first.
  const notes = []
  if (!inside.me && blocksOnHand(bot, material) < roofNeed) {
    const roofTick = () => report(`digging up blocks for the pit's roof first (${Math.min(blocksOnHand(bot, material), roofNeed)} of the ${roofNeed} it needs so far). Nothing is dug in yet and there is no roof`)
    roofTick()
    const before = new Map(buildingKinds(bot, material).map(k => [k.name, k.n]))
    const cands = supplyCandidates(bot, { cx, cz, baseY, minX, maxX, minZ, maxZ, doorX: cx })
    const dug = cands.length ? await digForBlocks(bot, config, material, roofNeed - blocksOnHand(bot, material) + 1, cands, deps.digBlock ?? digToolAction, roofTick) : { got: 0 }
    const what = dugText(bot, material, before)
    if (dug.aborted) return `shelter stopped while digging blocks for its roof, nothing is dug in yet${what ? ` (dug ${what} so far)` : ''}`
    if (what) notes.push(`dug ${what} nearby for the roof`)
  }

  // Top layer first, so whoever stands there drops one block at a time;
  // the cell under a body goes last in its layer.
  const total = plan.cells.length
  let done = 0
  // 261128 (quality pass 68): how deep the pit is so far, counted from the
  // ground (a layer counts once every inner cell of it is open).
  const pitDepth = () => {
    let d = 0
    for (let k = 1; k <= PIT_DEPTH; k++) {
      if (inner.every(({ x, z }) => !isOccupied(bot, { x, y: baseY - k, z }))) d = k
      else break
    }
    return d
  }
  const pitTick = (n, of) => `digging the pit (${pitDepth()} of ${PIT_DEPTH} deep so far, ${n} of ${of} blocks dug). The ground around it will be its walls, nothing is placed and there is no roof on it yet`
  if (total) report(pitTick(0, total))
  const layers = [...new Set(plan.cells.map(c => c.y))].sort((a, b) => b - a)
  for (const y of layers) {
    const row = plan.cells.filter(c => c.y === y)
    row.sort((a, b) => (bodyInCell(bot, { ...a, y: y + 1 }) ? 1 : 0) - (bodyInCell(bot, { ...b, y: y + 1 }) ? 1 : 0))
    for (const c of row) {
      if (signal?.aborted) return `shelter stopped while digging in, dug ${done} of ${total} blocks of the pit, no roof yet: call shelter again to go on from there`
      if (!isOccupied(bot, c)) { done++; continue }
      await waitOnGround(bot, signal)
      const r = await digPit({ x: c.x, y: c.y, z: c.z }, bot, { ...config, noDropWalk: true })
      const gone = !isOccupied(bot, c)
      if (r === 'aborted' || signal?.aborted) return `shelter stopped while digging in, dug ${done + (gone ? 1 : 0)} of ${total} blocks of the pit, no roof yet: call shelter again to go on from there`
      if (!gone) {
        return `no shelter built: digging in stopped at ${c.x},${c.y},${c.z} (${typeof r === 'string' ? r : 'the dig failed'}), ${done} of ${total} pit blocks dug and no roof on it`
      }
      done++
      report(pitTick(done, total))
    }
  }
  await waitOnGround(bot, signal)
  // Drops still falling down the shaft.
  if (inside.me && blocksOnHand(bot, material) < roofNeed) await sleep(400)

  inside = whoInside(bot, minX, maxX, minZ, maxZ, baseY)
  const where = `${cx},${baseY - PIT_DEPTH},${cz}`
  if (inside.mobs.length) {
    return `no roof put on: the pit at ${where} is dug, but ${inside.mobs[0]} is down in it. Deal with it first, then call shelter again to roof it.`
  }
  if (!inside.me && !inside.players.length) {
    return `no roof put on: the pit at ${where} is dug ${PIT_DEPTH} deep, but nobody is in it now. Whoever should be safe has to drop in (step onto it); then call shelter again and it only puts the roof on.`
  }
  if (blocksOnHand(bot, material) === 0) {
    return `no roof put on: the pit at ${where} is dug ${PIT_DEPTH} deep but you have no blocks left for its roof (${roofNeed} needed). Pick up the dug blocks or dig one more, then call shelter again.`
  }
  report(`the pit is dug ${PIT_DEPTH} deep and it is putting the roof on. It is not closed yet`)
  await waitClearOf(bot, innerColumns(minX, maxX, minZ, maxZ).map(({ x, z }) => ({ x, y: plan.roofY, z })), signal)
  const roof = await buildPart(bot, { ...config, onProgress: undefined }, { from: roofFrom, to: roofTo }, material, false)
  if (isAborted(roof.res)) return `shelter stopped while roofing the pit at ${where}, it is not closed yet (roof: ${roof.res})`
  const closed = buildComplete(roof.res)
  inside = whoInside(bot, minX, maxX, minZ, maxZ, baseY)
  const who = [inside.me ? 'you' : null, ...inside.players].filter(Boolean)
  const whoText = who.length ? who.join(' and ') : 'nobody'
  const outside = inside.me ? '' : ' You are outside, on top of it.'
  const extra = notes.length ? `; ${notes.join('; ')}` : ''
  if (!closed) {
    return `shelter UNFINISHED: dug a pit ${PIT_DEPTH} deep at ${where} (${whoText} in it), but the roof has gaps and it is not safe yet (roof: ${roof.res}${extra})`
  }
  bot._seiPit = { minX: minX + 1, maxX: maxX - 1, minZ: minZ + 1, maxZ: maxZ - 1, roofY: plan.roofY }
  const room = size === 3 ? ' It is 1x1 inside, room for one.' : ''
  return `dug in: a ${size}x${size} pit shelter, ${PIT_DEPTH} blocks down at ${where} with the ground as its walls and a roof of ${roof.used.join(' and ') || material} (${roof.res}${extra}). Inside: ${whoText}, out of reach of mobs.${outside}${room} It has no door: any walk (follow, goTo) digs out of it again.`
}

export async function shelterAction(args, bot, config, deps = {}) {
  const walk = deps.goTo ?? realGoTo
  const digBlock = deps.digBlock ?? digToolAction
  // 261128 (pass 67): the in_flight line said only "shelter running" while it
  // dug for a minute, and she told the player the walls were going up.
  // 261128 (quality pass 68): same in the 11-28 scorecard (night_social-02,
  // "im almost done with the walls" with no wall placed). Every stage says
  // what is NOT done yet. The parts it is made of (dig, build) report their
  // own progress in other shapes ("broke 0 of 2" for the doorway), so they get
  // a config without the hook and the shelter reports for them.
  const onProgress = typeof config?.onProgress === 'function' ? config.onProgress : null
  const report = (text) => { if (onProgress) { try { onProgress({ text }) } catch { /* never break the build */ } } }
  if (onProgress) config = { ...config, onProgress: undefined }
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
    const pit = await pitShelter(bot, config, deps, { size, material, cx, cz, baseY, minX, maxX, minZ, maxZ, report })
    if (pit != null) return pit
    const before = new Map(buildingKinds(bot, material).map(k => [k.name, k.n]))
    const cands = supplyCandidates(bot, { cx, cz, baseY, minX, maxX, minZ, maxZ, doorX })
    const want = need - have + SUPPLY_MARGIN
    const supplyTick = () => report(`still digging up blocks to build it with, about 2s each (${Math.min(blocksOnHand(bot, material), need)} of the ${need} it needs so far). Nothing is built yet: no wall or roof is placed`)
    if (cands.length) supplyTick()
    const dug = cands.length ? await digForBlocks(bot, config, material, want, cands, digBlock, supplyTick) : { got: 0, stop: 'none_left' }
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
  // Cells of a part in place right now (placed, or solid ground already).
  const partTick = (stage, from, to, hollow) => {
    const cells = enumerateBuildCells(from, to, hollow).length
    const tick = () => {
      const filled = Math.max(0, cells - cellsNeeded(bot, from, to, hollow))
      report(stage === 'walls'
        ? `placing the walls (${filled} of the ${cells} wall blocks are in place, ${cells - filled} still to go, and the roof goes on after them). It is not finished and keeps nothing out yet`
        : `the walls are up and it is putting on the roof (${filled} of ${cells} roof blocks in place). It is not finished yet`)
    }
    tick()
    return onProgress ? { ...config, onProgress: tick } : config
  }
  const walls = wallNeed === 0
    ? { res: allThere(wallCells.length), used: [] }
    : await buildPart(bot, partTick('walls', wallFrom, wallTo, true), { from: wallFrom, to: wallTo }, material, true)
  const wallsRes = walls.res
  if (isAborted(wallsRes)) return abortedAt('walls', wallsRes)
  // 261011: a shelter with no walls is not a shelter. The result used to read
  // "built shelter 3x3x3 with a doorway (walls: no cobblestone in inventory...)"
  // and the model told the player they were safe inside.
  if (!placedSome(wallsRes)) return `no shelter built: walls: ${wallsRes}`
  if (walls.used.some(k => k !== material)) notes.push(`walls in ${walls.used.join(' and ')}`)

  const roof = roofNeed === 0
    ? { res: allThere(size * size), used: [] }
    : await buildPart(bot, partTick('roof', roofFrom, roofTo, false), { from: roofFrom, to: roofTo }, material, false)
  const roofRes = roof.res
  if (isAborted(roofRes)) return abortedAt('roof', roofRes, wallsRes)
  if (roof.used.some(k => k !== material)) notes.push(`roof in ${roof.used.join(' and ')}`)

  // 4. Carve a one-block-wide, two-tall doorway out of the front (min-Z) wall,
  //    centered on the footprint, so the bot can walk in and out.
  const inMiddleBeforeDoor = !awayFromMiddle()
  report('the walls and roof are up and it is cutting the doorway')
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
