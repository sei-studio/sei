// src/observers/posHealer.js — recover bot.entity.position from NaN poisoning.
//
// Background: prismarine-physics occasionally produces NaN for vel.x/vel.z under
// knockback. Once pos goes NaN, mineflayer's physics tick (line 79) and outbound
// position packet (line 160) both early-return on non-finite checks, so the bot
// is stuck client-side until something heals it. Server inbound position packets
// only heal if absolute (rare in survival).
//
// Strategy: track lastGoodPos from `move` events (which fire only AFTER mineflayer
// has already accepted+sent that position to the server). On NaN detection, write
// lastGoodPos back into bot.entity.position and zero velocity. From the server's
// perspective this is a 0-block, 0-packet "teleport" — no anti-cheat trigger.

import { Vec3 } from 'vec3'
import { logHeal } from '../log.js'

let _lastGood = null
let _lastGoodYaw = 0
let _lastGoodPitch = 0
let _watchdog = null
let _attached = null

const WATCHDOG_MS = 100  // catch NaN within ~2 physics ticks

function isFiniteVec(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

/**
 * Read a healed position. If bot.entity.position is finite, return it.
 * Otherwise return the last known good position (or null if we've never had one).
 * Use this in observers/snapshot/dig instead of bot.entity.position when you want
 * resilience against the brief gap before the watchdog heals.
 */
export function getHealedPos(bot) {
  const p = bot?.entity?.position
  if (isFiniteVec(p)) return p
  return _lastGood
}

/**
 * Start the healer. Idempotent — calling twice replaces the prior install.
 * @param {import('mineflayer').Bot} bot
 */
export function startPosHealer(bot) {
  stopPosHealer()
  _attached = bot

  // Capture last good pos/yaw/pitch on every successful move.
  // mineflayer fires `move` from sendPacketPosition, AFTER it has guarded against
  // NaN, so by definition the entity state at this moment is finite.
  const onMove = () => {
    const p = bot.entity?.position
    if (!isFiniteVec(p)) return
    if (_lastGood) {
      _lastGood.set(p.x, p.y, p.z)
    } else {
      _lastGood = new Vec3(p.x, p.y, p.z)
    }
    if (Number.isFinite(bot.entity.yaw))   _lastGoodYaw   = bot.entity.yaw
    if (Number.isFinite(bot.entity.pitch)) _lastGoodPitch = bot.entity.pitch
  }
  bot.on('move', onMove)

  // Initial capture (in case 'move' hasn't fired yet but bot is spawned).
  onMove()

  // Watchdog — heal if NaN detected.
  _watchdog = setInterval(() => {
    if (!bot.entity) return
    const p = bot.entity.position
    const v = bot.entity.velocity

    const posBad = !isFiniteVec(p)
    const velBad = !isFiniteVec(v)
    const yawBad = !Number.isFinite(bot.entity.yaw)
    const pitchBad = !Number.isFinite(bot.entity.pitch)

    if (!posBad && !velBad && !yawBad && !pitchBad) return

    // Heal velocity first — without this, the next physics tick re-NaNs pos.
    if (velBad && v) {
      v.x = 0; v.y = 0; v.z = 0
    }

    if (posBad && _lastGood && p) {
      // 0-block teleport from the server's perspective: server's authoritative
      // last-known pos for us is exactly what we sent before NaN cut packets off.
      p.x = _lastGood.x
      p.y = _lastGood.y
      p.z = _lastGood.z
    }

    if (yawBad)   bot.entity.yaw   = _lastGoodYaw
    if (pitchBad) bot.entity.pitch = _lastGoodPitch

    logHeal({
      pos: posBad ? (_lastGood ? `→${_lastGood.x.toFixed(2)},${_lastGood.y.toFixed(2)},${_lastGood.z.toFixed(2)}` : 'NaN (no lastGood)') : 'ok',
      vel: velBad ? '→0,0,0' : 'ok',
      yaw: yawBad ? `→${_lastGoodYaw.toFixed(2)}` : 'ok',
      pitch: pitchBad ? `→${_lastGoodPitch.toFixed(2)}` : 'ok',
    })
  }, WATCHDOG_MS)

  // Detach the move listener if the bot is replaced.
  bot.once('end', () => {
    try { bot.removeListener('move', onMove) } catch {}
  })
}

export function stopPosHealer() {
  if (_watchdog) clearInterval(_watchdog)
  _watchdog = null
  _attached = null
}
