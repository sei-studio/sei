// scripts/decision-eval/state.mjs: what a decider sees, per integration level.
//
// A live mineflayer view is first reduced to a plain observation object
// (scanObs, below, or hand-written in offline.mjs), then each level formats
// it as text and builds its typed option list. Every decider (Laya, Haiku,
// OpenAI) gets exactly the same text and options.
//
//   obs = { task, step, maxSteps, last, timeLeftS,
//           self: { pos, yaw, pitch, hp, food, held, inv: {name: n}, hotbar: [name|null] x9, selected },
//           blocks: [{ name, pos, dist, bearing, pitchTo, reach }],   nearest first
//           entities: [{ name, kind, pos, dist, bearing }],          kind hostile|player|item
//           crosshair: { block: {name, dist}|null, entity: {name, dist}|null },
//           below: [name, name],                                     the two blocks under her feet
//           ui: null | { title, slots: [{ slot, role, name, count }], cursor: {name,count}|null },
//           reflex: current L1 reflex name, reflexForS }

const r1 = (v) => Math.round(v * 10) / 10
const fmtPos = (p) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`
const invText = (inv) => Object.entries(inv || {}).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'

export const HOSTILES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'witch', 'zombie_villager'])
export const INTEREST = ['oak_log', 'gold_block', 'crafting_table', 'stone', 'furnace', 'cobblestone']

/** Signed degrees from facing to a target; + = to the LEFT (mineflayer yaw grows counterclockwise). */
export function bearingDeg(selfPos, yaw, target) {
  const dx = target.x - selfPos.x, dz = target.z - selfPos.z
  const want = Math.atan2(-dx, -dz)
  let d = (want - yaw) * 180 / Math.PI
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return Math.round(d)
}
export function pitchToDeg(eye, target) {
  const dx = target.x - eye.x, dz = target.z - eye.z, dy = target.y - eye.y
  return Math.round(Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI)
}
function bearingText(b) {
  if (b == null) return ''
  const a = Math.abs(b)
  if (a <= 5) return 'straight ahead'
  if (a >= 160) return 'behind you'
  return `${a}° ${b > 0 ? 'left' : 'right'}`
}
function pitchText(p) {
  if (p == null) return ''
  if (Math.abs(p) <= 5) return 'level'
  return `${Math.abs(p)}° ${p > 0 ? 'up' : 'down'}`
}
function compass(yaw) {
  // mineflayer yaw 0 = north (-z), +pi/2 = west (-x)
  const deg = ((yaw * 180 / Math.PI) % 360 + 360) % 360
  const names = ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east']
  return names[Math.round(deg / 45) % 8]
}

// ── live scan (mineflayer) ──────────────────────────────────────────────
/**
 * Reduce a live view to an obs. `world` is the mineflayer bot whose chunks and
 * entities we read (the agent itself, or the observer player for the Sei
 * runtime); `self` overrides position/inventory when the body is another
 * process (L2: comp.probe()).
 */
export function scanObs(world, { self = null, selfName = null, Vec3, perType = 1, radius = 32 } = {}) {
  const me = self || selfOf(world)
  const pos = me.pos
  const eye = { x: pos.x, y: pos.y + 1.62, z: pos.z }
  const mcData = world.registry
  const blocks = []
  for (const name of INTEREST) {
    const id = mcData.blocksByName[name]?.id
    if (id == null) continue
    const found = world.findBlocks({ point: new Vec3(pos.x, pos.y, pos.z), matching: id, maxDistance: radius, count: 200 })
    const ranked = found.map((p) => ({ p, d: Math.hypot(p.x + 0.5 - pos.x, p.y + 0.5 - eye.y, p.z + 0.5 - pos.z) })).sort((a, b) => a.d - b.d)
    for (const { p, d } of ranked.slice(0, perType)) {
      const c = { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }
      blocks.push({ name, pos: { x: p.x, y: p.y, z: p.z }, dist: r1(d), bearing: bearingDeg(pos, me.yaw ?? 0, c), pitchTo: pitchToDeg(eye, c), reach: d <= 4.5, count: found.length })
    }
  }
  blocks.sort((a, b) => a.dist - b.dist)
  const entities = []
  for (const e of Object.values(world.entities)) {
    if (!e?.position || e === world.entity && !self) continue
    if (selfName && e.username === selfName) continue
    if (self == null && e === world.entity) continue
    let kind = null, name = e.name
    if (e.type === 'player') { kind = 'player'; name = e.username }
    else if (HOSTILES.has(e.name)) kind = 'hostile'
    else if (e.name === 'item') { kind = 'item'; try { name = e.getDroppedItem?.()?.name || 'item' } catch { name = 'item' } }
    if (!kind) continue
    const d = Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z)
    if (d > 24) continue
    entities.push({ name, kind, pos: { x: e.position.x, y: e.position.y, z: e.position.z }, dist: r1(d), bearing: bearingDeg(pos, me.yaw ?? 0, e.position), id: e.id })
  }
  entities.sort((a, b) => a.dist - b.dist)
  const below = []
  for (const dy of [1, 2]) {
    try { below.push(world.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - dy, Math.floor(pos.z)))?.name ?? '?') } catch { below.push('?') }
  }
  let crosshair = { block: null, entity: null }
  if (!self) {
    try {
      const b = world.blockAtCursor(6)
      if (b) crosshair.block = { name: b.name, dist: r1(Math.hypot(b.position.x + 0.5 - eye.x, b.position.y + 0.5 - eye.y, b.position.z + 0.5 - eye.z)), pos: b.position }
    } catch {}
    try {
      const e = world.entityAtCursor(3.5)
      if (e) crosshair.entity = { name: e.type === 'player' ? e.username : e.name, dist: r1(e.position.distanceTo(world.entity.position)) }
    } catch {}
  }
  return { self: me, blocks, entities, below, crosshair }
}

export function selfOf(bot) {
  const inv = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
  const hotbar = []
  for (let i = 0; i < 9; i++) { const it = bot.inventory.slots[36 + i]; hotbar.push(it ? `${it.name}${it.count > 1 ? ' x' + it.count : ''}` : null) }
  const p = bot.entity.position
  return { pos: { x: p.x, y: p.y, z: p.z }, yaw: bot.entity.yaw, pitch: bot.entity.pitch, hp: bot.health, food: bot.food, held: bot.heldItem?.name ?? null, inv, hotbar, selected: bot.quickBarSlot }
}

// ── L1: reflexes ────────────────────────────────────────────────────────
export const L1_OPTIONS = {
  attack: 'attack the nearest hostile mob with what you hold',
  flee: 'turn away and sprint away from the hostiles',
  eat: 'eat food from your inventory',
  back_off: 'face the nearest hostile and step backwards away from it',
  none: 'do nothing for now',
}
export const L1_INSTRUCTIONS = 'Which reflex should you run right now to survive and win the fight?'

export function formatL1(o) {
  const s = o.self
  const hs = o.entities.filter((e) => e.kind === 'hostile').slice(0, 4)
  return [
    `TASK: ${o.task}`,
    `YOU: health ${Math.round(s.hp)}/20, food ${Math.round(s.food)}/20, holding ${s.held || 'nothing'}. Inventory: ${invText(s.inv)}.`,
    `HOSTILES: ${hs.length ? hs.map((e) => `${e.name} ${e.dist} m ${bearingText(e.bearing)}`).join('; ') : 'none nearby'}.`,
    `CURRENT REFLEX: ${o.reflex || 'none'}${o.reflexForS != null ? ` (for ${o.reflexForS} s)` : ''}. ${o.last ? `Last: ${o.last}.` : ''}`,
    o.timeLeftS != null ? `TIME LEFT: ${o.timeLeftS} s.` : '',
  ].filter(Boolean).join('\n')
}

// ── L2: Sei's Minecraft actions with pre-filled arguments ────────────────
export const L2_INSTRUCTIONS = 'Which action should you run next to get the task done? Pick complete only when the task is already done.'
const L2_CRAFTS = ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'wooden_sword']
const TOOLS = /(_pickaxe|_axe|_shovel|_sword|_hoe)$/
const FOODS = new Set(['bread', 'cooked_beef', 'apple', 'cooked_porkchop', 'carrot', 'baked_potato'])

/** -> { key: { desc, call: {name, args} | null } } (null call = complete) */
export function optionsL2(o, { player = 'Alex' } = {}) {
  const out = {}
  const seen = new Set()
  for (const b of o.blocks) {
    if (seen.has(b.name)) continue
    seen.add(b.name)
    const at = fmtPos(b.pos)
    const k = b.name.replace(/^oak_/, '').replace(/_block$/, '')
    out[`goto_${k}`] = { desc: `walk to the ${b.name} at ${at}`, call: { name: 'goTo', args: { x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, range: 2 } } }
    out[`dig_${k}`] = { desc: `dig one ${b.name} at ${at}`, call: { name: 'dig', args: { x: b.pos.x, y: b.pos.y, z: b.pos.z } } }
    out[`gather_${k}`] = { desc: `gather 5 ${b.name} (walks, digs, picks up)`, call: { name: 'gather', args: { name: b.name, count: 5 } } }
  }
  for (const it of L2_CRAFTS) out[`craft_${it.replace(/^oak_/, '').replace(/^wooden_/, 'wood_')}`] = { desc: `craft ${it}`, call: { name: 'craft', args: { item: it, count: 1 } } }
  if (o.self.inv.crafting_table) out.place_table = { desc: 'place a crafting_table next to you', call: { name: 'placeBlock', args: { block: 'crafting_table' } } }
  for (const name of Object.keys(o.self.inv)) {
    if (TOOLS.test(name) && o.self.held !== name) out[`equip_${name}`] = { desc: `hold the ${name}`, call: { name: 'equip', args: { item: name, destination: 'hand' } } }
    if (FOODS.has(name)) out[`eat_${name}`] = { desc: `eat ${name}`, call: { name: 'consume', args: { item: name } } }
  }
  const host = o.entities.find((e) => e.kind === 'hostile')
  if (host) out.attack = { desc: `attack the ${host.name} ${host.dist} m away`, call: { name: 'attackEntity', args: { entity: host.name, times: 3 } } }
  if (o.entities.some((e) => e.kind === 'item')) out.pickup = { desc: 'pick up the items on the ground', call: { name: 'pickup', args: {} } }
  out.goto_player = { desc: `walk to the player ${player}`, call: { name: 'goTo', args: { player, range: 2 } } }
  out.complete = { desc: 'the task is done: finish', call: null }
  return out
}

export function formatL2(o) {
  const s = o.self
  const bl = []
  const seen = new Set()
  for (const b of o.blocks) { if (seen.has(b.name)) continue; seen.add(b.name); bl.push(`${b.name} ${b.dist} m at ${fmtPos(b.pos)}${b.count > 1 ? ` (${b.count} in range)` : ''}`) }
  const ents = o.entities.slice(0, 5).map((e) => `${e.name}${e.kind === 'item' ? ' (dropped item)' : ''} ${e.dist} m`)
  return [
    `TASK: ${o.task}`,
    `STEP ${o.step}/${o.maxSteps}. Last action: ${o.last || 'none yet'}`,
    `YOU: at ${fmtPos(s.pos)}, health ${Math.round(s.hp)}/20, food ${Math.round(s.food)}/20, holding ${s.held || 'nothing'}.`,
    `INVENTORY: ${invText(s.inv)}.`,
    `BLOCKS NEARBY: ${bl.join('; ') || 'nothing notable'}.`,
    `UNDER YOU: ${o.below.join(', then ')}.`,
    `ENTITIES: ${ents.join('; ') || 'none'}.`,
  ].join('\n')
}

// ── L3: raw, game-agnostic controls ─────────────────────────────────────
// Discrete versions of what a keyboard + mouse can do. Durations live in
// body.mjs. The keymap note explains them the way an omnigame adapter would.
export const L3_KEYMAP = 'Controls (Minecraft-style keyboard and mouse): W forward, S back, A/D strafe, Space jump, Shift sneak, Ctrl+W sprint; mouse moves the view (turn left/right, look up/down); left mouse = attack/hold to break the block in the crosshair; right mouse = use/place; keys 1-9 pick a hotbar slot; E opens the inventory (2x2 crafting grid), in which you click slots. Blocks break only when the crosshair is on them and they are in reach (about 4.5 m). Walking over a dropped item picks it up.'
export const L3_INSTRUCTIONS = 'Which control should you press next to make progress on the task? Pick complete only when the task is already done.'

const L3_MOVE = {
  forward: 'W: walk forward ~2 blocks',
  sprint: 'Ctrl+W: sprint forward ~5 blocks',
  back: 'S: walk back ~2 blocks',
  left: 'A: strafe left ~2 blocks',
  right: 'D: strafe right ~2 blocks',
  jump: 'Space+W: jump forward (up one block)',
  sneak: 'Shift: sneak for a moment',
  turn_left_15: 'mouse: turn left 15°',
  turn_left_45: 'mouse: turn left 45°',
  turn_right_15: 'mouse: turn right 15°',
  turn_right_45: 'mouse: turn right 45°',
  look_up_15: 'mouse: look up 15°',
  look_up_45: 'mouse: look up 45°',
  look_down_15: 'mouse: look down 15°',
  look_down_45: 'mouse: look down 45°',
  attack: 'left mouse: hold attack on the crosshair (breaks the block or hits the mob)',
  use: 'right mouse: use the held item / place a block / open the block in the crosshair',
  inventory: 'E: open the inventory',
}

/** -> { key: desc }; in UI mode the slot clicks replace the world controls. */
export function optionsL3(o) {
  const out = {}
  if (o.ui) {
    for (const sl of o.ui.slots) {
      const what = sl.name ? `${sl.name} x${sl.count}` : 'empty'
      out[`click_${sl.slot}`] = `left-click slot ${sl.slot} (${sl.role}: ${what})`
      out[`rclick_${sl.slot}`] = `right-click slot ${sl.slot} (${sl.role}: ${what})`
      if (sl.name) out[`shift_${sl.slot}`] = `shift-click slot ${sl.slot} (${sl.role}: ${what})`
    }
    out.close = 'E/Esc: close the inventory'
    out.complete = 'the task is done: finish'
    return out
  }
  Object.assign(out, L3_MOVE)
  for (let i = 0; i < 9; i++) out[`hotbar_${i + 1}`] = `key ${i + 1}: select hotbar slot ${i + 1} (${o.self.hotbar?.[i] || 'empty'})`
  out.complete = 'the task is done: finish'
  return out
}

export function formatL3(o) {
  const s = o.self
  if (o.ui) {
    const sl = o.ui.slots.map((x) => `slot ${x.slot} ${x.role}: ${x.name ? `${x.name} x${x.count}` : 'empty'}`).join('; ')
    return [
      `TASK: ${o.task}`,
      L3_KEYMAP,
      `STEP ${o.step}/${o.maxSteps}. Last: ${o.last || 'none yet'}`,
      `SCREEN: ${o.ui.title} is open. Cursor holds: ${o.ui.cursor ? `${o.ui.cursor.name} x${o.ui.cursor.count}` : 'nothing'}.`,
      `SLOTS: ${sl}.`,
      'Crafting: put items in the grid slots in the recipe shape; the result shows in the output slot, click it to take it. 1 log anywhere in the grid = 4 planks; 4 planks filling the 2x2 grid = 1 crafting table.',
    ].join('\n')
  }
  const cb = o.crosshair?.block, ce = o.crosshair?.entity
  const cross = ce ? `${ce.name} at ${ce.dist} m` : cb ? `${cb.name} at ${cb.dist} m${cb.dist <= 4.5 ? ' (in reach)' : ' (out of reach)'}` : 'sky / nothing'
  const pitchDeg = Math.round((s.pitch || 0) * 180 / Math.PI)
  const see = []
  const seen = new Map()
  for (const b of o.blocks) {
    const n = seen.get(b.name) || 0
    if (n >= 2) continue
    seen.set(b.name, n + 1)
    see.push(`${b.name} ${b.dist} m, ${bearingText(b.bearing)}, ${pitchText(b.pitchTo - pitchDeg)} from your view${b.reach ? ' (in reach)' : ''}`)
  }
  for (const e of o.entities.slice(0, 4)) see.push(`${e.name}${e.kind === 'item' ? ' (dropped item)' : ''} ${e.dist} m, ${bearingText(e.bearing)}`)
  const hb = (s.hotbar || []).map((h, i) => `${i + 1}${i === s.selected ? '*' : ''} ${h || '-'}`).join(', ')
  return [
    `TASK: ${o.task}`,
    L3_KEYMAP,
    `STEP ${o.step}/${o.maxSteps}. Last: ${o.last || 'none yet'}`,
    `YOU: facing ${compass(s.yaw)}, view ${pitchText(pitchDeg)}; health ${Math.round(s.hp)}/20, food ${Math.round(s.food)}/20; holding ${s.held || 'nothing'}.`,
    `CROSSHAIR: ${cross}.`,
    `UNDER YOU: ${o.below.join(', then ')}.`,
    `YOU SEE: ${see.join('; ') || 'nothing notable'}.`,
    `HOTBAR (* = selected): ${hb}.`,
    `INVENTORY: ${invText(s.inv)}.`,
  ].join('\n')
}
