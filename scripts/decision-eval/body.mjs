// scripts/decision-eval/body.mjs: a plain mineflayer body for the L1 and L3
// arms (no Sei adapter, so none of Sei's own reflexes, gaze or auto-eat run).
//
//   const bot = await connectAgent({ username })
//   const motor = startReflexMotor(bot)   // L1: motor.set('attack' | 'flee' | ...)
//   await l3Exec(bot, key, uiState)       // L3: one discrete control press
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { HOSTILES } from './state.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', '..', 'package.json'))
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
export const { Vec3 } = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

export function connectAgent({ port = Number(process.env.QE_MC_PORT || 25590), username }) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, auth: 'offline' })
    bot.loadPlugin(pathfinder)
    const to = setTimeout(() => reject(new Error('agent spawn timeout')), 60000)
    bot.once('spawn', () => {
      clearTimeout(to)
      const mv = new Movements(bot)
      mv.canDig = false
      bot.pathfinder.setMovements(mv)
      resolve(bot)
    })
    bot.once('error', (e) => { clearTimeout(to); reject(e) })
    bot.once('kicked', (r) => { clearTimeout(to); reject(new Error('kicked: ' + JSON.stringify(r))) })
  })
}

export function clearControls(bot) {
  for (const c of CONTROLS) { try { bot.setControlState(c, false) } catch {} }
}

function nearestHostile(bot) {
  let best = null, bd = Infinity
  for (const e of Object.values(bot.entities)) {
    if (!e?.position || !HOSTILES.has(e.name)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d < bd) { bd = d; best = e }
  }
  return best ? { e: best, d: bd } : null
}

// ── L1 reflex motor ────────────────────────────────────────────────────
// The decider picks an intent; this 20 Hz controller carries it out until
// the next pick (System 1 chooses, motor code executes, like Sei's own
// behaviors/*). Stone-sword cooldown 0.625 s; reach 3 m.
export function startReflexMotor(bot) {
  let mode = 'none', since = Date.now(), eating = false, lastSwing = 0, hits = 0
  const weapon = () => bot.inventory.items().find((i) => /_sword$/.test(i.name))
  async function eat() {
    if (eating) return
    const food = bot.inventory.items().find((i) => ['bread', 'cooked_beef', 'apple'].includes(i.name))
    if (!food || bot.food >= 20) return
    eating = true
    try { clearControls(bot); await bot.equip(food, 'hand'); await bot.consume() } catch {} finally {
      eating = false
      const w = weapon(); if (w) bot.equip(w, 'hand').catch(() => {})
    }
  }
  const tick = () => {
    if (eating) return
    const h = nearestHostile(bot)
    const look = (e) => bot.lookAt(e.position.offset(0, e.height ?? 1.6, 0), true).catch(() => {})
    switch (mode) {
      case 'attack': {
        if (!h) { clearControls(bot); return }
        look(h.e)
        const w = weapon()
        if (w && bot.heldItem?.name !== w.name) bot.equip(w, 'hand').catch(() => {})
        if (h.d > 2.8) { bot.setControlState('forward', true); bot.setControlState('sprint', h.d > 4) } else { bot.setControlState('forward', false); bot.setControlState('sprint', false) }
        if (h.d <= 3.2 && Date.now() - lastSwing >= 650) { lastSwing = Date.now(); hits++; try { bot.attack(h.e) } catch {} }
        break
      }
      case 'flee': {
        if (!h) { clearControls(bot); return }
        const away = bot.entity.position.minus(h.e.position)
        const yaw = Math.atan2(-away.x, -away.z)
        bot.look(yaw, 0, true).catch(() => {})
        bot.setControlState('forward', true); bot.setControlState('sprint', true)
        bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
        break
      }
      case 'back_off': {
        if (!h) { clearControls(bot); return }
        look(h.e)
        bot.setControlState('sprint', false); bot.setControlState('forward', false)
        bot.setControlState('back', h.d < 5)
        break
      }
      case 'eat': eat(); break
      default: clearControls(bot)
    }
  }
  const iv = setInterval(tick, 50)
  return {
    set(m) { if (m !== mode) { clearControls(bot); mode = m; since = Date.now() } },
    get mode() { return mode },
    get forS() { return Math.round((Date.now() - since) / 100) / 10 },
    get hits() { return hits },
    stop() { clearInterval(iv); clearControls(bot) },
  }
}

// ── L3 raw controls ─────────────────────────────────────────────────────
const HOLD = { forward: 450, back: 450, left: 450, right: 450, sneak: 400 }
const LOOK = { turn_left_15: [15, 0], turn_left_45: [45, 0], turn_right_15: [-15, 0], turn_right_45: [-45, 0], look_up_15: [0, 15], look_up_45: [0, 45], look_down_15: [0, -15], look_down_45: [0, -45] }
const D2R = Math.PI / 180

/** UI view of the open window (player inventory = window 0, or a crafting table). */
export function uiState(bot, ui) {
  if (!ui) return null
  const win = bot.currentWindow || bot.inventory
  const isTable = win !== bot.inventory && win.type?.includes?.('crafting')
  const slots = []
  const role = (i) => {
    if (i === 0) return 'craft output'
    if (isTable) return i <= 9 ? `craft grid ${i}` : i >= win.inventoryStart && i >= win.inventoryEnd - 9 ? 'hotbar' : 'inventory'
    if (i >= 1 && i <= 4) return `craft grid ${i}`
    if (i >= 36 && i <= 44) return `hotbar ${i - 35}`
    return 'inventory'
  }
  const gridEnd = isTable ? 9 : 4
  for (let i = 0; i < win.slots.length; i++) {
    const it = win.slots[i]
    const inGrid = i <= gridEnd
    if (!inGrid && !it) continue
    if (!isTable && i >= 5 && i <= 8) continue // armor
    if (i === 45) continue // offhand
    slots.push({ slot: i, role: role(i), name: it?.name ?? null, count: it?.count ?? 0 })
  }
  const cur = win.selectedItem
  return { title: isTable ? 'crafting table (3x3 grid)' : 'inventory (2x2 crafting grid)', slots, cursor: cur ? { name: cur.name, count: cur.count } : null }
}

/**
 * Press one discrete control. Returns a short result text for the next
 * state's "Last:" line. `st` carries the UI flag across steps.
 */
export async function l3Exec(bot, key, st) {
  if (st.ui) {
    const m = /^(click|rclick|shift)_(\d+)$/.exec(key)
    if (key === 'close') {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); else bot.closeWindow(bot.inventory) } catch {}
      st.ui = false
      await sleep(250)
      return 'closed the inventory'
    }
    if (m) {
      const slot = Number(m[2])
      const [button, mode] = m[1] === 'click' ? [0, 0] : m[1] === 'rclick' ? [1, 0] : [0, 1]
      try { await bot.clickWindow(slot, button, mode) } catch (e) { return `click failed: ${String(e?.message || e).slice(0, 60)}` }
      await sleep(200)
      return `${m[1]} slot ${slot}`
    }
    return 'that control does nothing while the inventory is open'
  }
  if (HOLD[key]) {
    bot.setControlState(key, true)
    await sleep(HOLD[key])
    bot.setControlState(key, false)
    return `held ${key}`
  }
  if (key === 'sprint') {
    bot.setControlState('forward', true); bot.setControlState('sprint', true)
    await sleep(1000)
    clearControls(bot)
    return 'sprinted forward'
  }
  if (key === 'jump') {
    bot.setControlState('forward', true); bot.setControlState('jump', true)
    await sleep(500)
    clearControls(bot)
    return 'jumped forward'
  }
  if (LOOK[key]) {
    const [dy, dp] = LOOK[key]
    const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.entity.pitch + dp * D2R))
    await bot.look(bot.entity.yaw + dy * D2R, pitch, true)
    await sleep(50)
    return key.replace(/_/g, ' ') + '°'
  }
  const hb = /^hotbar_(\d)$/.exec(key)
  if (hb) { bot.setQuickBarSlot(Number(hb[1]) - 1); await sleep(100); return `selected hotbar ${hb[1]} (${bot.heldItem?.name || 'empty'})` }
  if (key === 'attack') {
    const e = bot.entityAtCursor(3.5)
    if (e) { bot.attack(e); await sleep(300); return `hit ${e.name}` }
    const b = bot.blockAtCursor(4.5)
    if (b && b.diggable && b.name !== 'air') {
      // Hold the button until it breaks (a real client can do the same: hold LMB, release when the crosshair block changes).
      const t0 = Date.now()
      try {
        await Promise.race([bot.dig(b, 'ignore', 'raycast'), sleep(8000).then(() => { throw new Error('gave up after 8 s') })])
        await sleep(150)
        return `broke ${b.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s`
      } catch (err) { try { bot.stopDigging() } catch {} return `could not break ${b.name}: ${String(err?.message || err).slice(0, 60)}` }
    }
    bot.swingArm()
    await sleep(250)
    return b ? `${b.name} is out of reach (swung at air)` : 'swung at air'
  }
  if (key === 'use') {
    const b = bot.blockAtCursor(4.5)
    const held = bot.heldItem
    if (b && b.name === 'crafting_table') {
      try { await bot.activateBlock(b); await sleep(400); st.ui = true; return 'opened the crafting table' } catch (e) { return 'could not open it' }
    }
    if (b && held && bot.registry.blocksByName[held.name]) {
      // Place against the face the crosshair hits (raycast face).
      const face = b.face ?? 1
      const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
      try { await bot.placeBlock(b, FACES[face] || new Vec3(0, 1, 0)); return `placed ${held.name}` } catch (e) { return `could not place: ${String(e?.message || e).slice(0, 60)}` }
    }
    if (held) { bot.activateItem(); await sleep(1700); bot.deactivateItem(); return `used ${held.name}` }
    return 'nothing to use'
  }
  if (key === 'inventory') { st.ui = true; await sleep(150); return 'opened the inventory' }
  return `unknown control ${key}`
}
