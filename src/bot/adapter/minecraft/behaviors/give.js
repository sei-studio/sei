// src/bot/adapter/minecraft/behaviors/give.js — `give` action (261015).
//
// Quality pass 8: handing something to the player had no verb of its own.
// The only way was dropItem, a bare "toss N of X where you stand", and the
// model planned a hand-over as walking over: with 8 coal in her bag and the
// player 14 blocks away she said "got 8 coal. coming over, catch it" and
// called goTo, and once next to them she cleared the task ("the coal is
// yours") without ever dropping it (25/25 in the order probe,
// scripts/quality-eval/order-probe.mjs). give does the whole hand-over in one
// call: walk to the player if they are out of tossing range, face them, toss
// the items, and report how many left her inventory.

import { goTo as realGoTo } from './pathfind.js'
import { dropItemAction as realDrop } from './drop.js'
import { resolveOwner } from '../observers/snapshot.js'
import { beginGivenToss } from '../observers/givenDrops.js'
import { nextMilestone, readProgressionState, nextNeedAfterGive } from '../observers/progression.js'

/** Within this many blocks a toss lands at their feet. */
export const HAND_RANGE = 3
/** After a walk that reached them, a toss from this far still lands close. */
export const TOSS_RANGE = 4
const APPROACH_TRIES = 2
const WALK_RANGE = 2
const FACE_MS = 800

function countOf(bot, item) {
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch { items = [] }
  return items.filter((i) => i?.name === item).reduce((s, i) => s + (i.count ?? 1), 0)
}

function distance(a, b) {
  if (!a || !b) return Infinity
  const d = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
  return Number.isFinite(d) ? d : Infinity
}

async function faceEntity(bot, ent) {
  const p = ent?.position
  if (!p || typeof bot?.lookAt !== 'function') return
  const target = typeof p.offset === 'function' ? p.offset(0, 1.2, 0) : { x: p.x, y: p.y + 1.2, z: p.z }
  let timer = null
  try {
    await Promise.race([
      Promise.resolve(bot.lookAt(target, false)).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, FACE_MS) }),
    ])
  } catch {
    /* facing is cosmetic; the toss still goes ahead */
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// The player she plays with goes through resolveOwner, which maps the name she
// calls them (a preferred name) to their LAN login. It gets the companion
// roster (config._seiCompanions, the list the snapshot and chat.js use), so
// its last fallback (the one human online) can never pick a sibling companion
// while the player is offline. Anyone else must be in the tab list under that
// name: the fallback would otherwise hand items meant for a named sibling to
// the player.
export function resolveRecipient(bot, who, config) {
  const lc = String(who).toLowerCase()
  const pins = [config?.player_username, config?.player_display_name].filter(Boolean).map((n) => String(n).toLowerCase())
  const companions = Array.isArray(config?._seiCompanions) ? config._seiCompanions : []
  if (pins.includes(lc)) return resolveOwner(bot, config?.player_username ?? who, companions)
  const players = bot?.players || {}
  if (players[who]) return { username: who, player: players[who] }
  for (const [name, p] of Object.entries(players)) {
    if (name.toLowerCase() === lc) return { username: name, player: p }
  }
  return null
}

// 261018 (pass 17): what the hand-over leaves short for her next milestone.
// work_session-02 (pass 15 eval): she gave 6 of her 7 logs, told the player
// "i'm making the pickaxe", and the craft failed on the 1 log left. The give
// itself is still hers to decide; this only says what it cost.
// The milestone is the one she was on before the toss: the pass 17 compare's
// work_session-06 gave all 6 logs, and read after the give the frontier was
// back at "gather wood" (no recipe), so the note was missing exactly when
// she had nothing left for the table she had just said she would make.
// 261110 (pass 49): and that what she gave stays given. work_session-01
// (11-09 scorecard, 47% off) gave all 6 logs, read "you need 1 more", and
// asked the player to toss one back four times, once in answer to "make a
// crafting table" with oak trees in view (pass47 gather_craft-02-A: eight
// times). The note stays on last_action_result until her next action, so it
// is what those later turns read. pass49-probe ws01_table (her first ask
// already said, then "make a crafting table"): asked again 10/10 -> 2/10.
function nextStepNote(bot, item, given) {
  try {
    const state = readProgressionState(bot)
    const before = { ...state, items: { ...state.items, [item]: (Number(state.items?.[item]) || 0) + given } }
    const { node } = nextMilestone(before)
    const need = nextNeedAfterGive(node, state.items, item)
    return need ? `. Note: ${need}. What you gave is theirs to keep, so get what you need yourself` : ''
  } catch {
    return ''
  }
}

/**
 * @param {{ item: string, count?: number, player?: string }} args
 * @param {import('mineflayer').Bot} bot
 * @param {{ signal?: AbortSignal, player_username?: string, pathfinder_timeout_ms?: number }} [config]
 * @param {{ goTo?: typeof realGoTo, drop?: typeof realDrop }} [_deps]
 */
export async function giveAction(args, bot, config, _deps) {
  const goTo = _deps?.goTo ?? realGoTo
  const drop = _deps?.drop ?? realDrop
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  const item = String(args?.item ?? '').trim()
  const have = countOf(bot, item)
  if (!item || have === 0) return `no ${item || 'such item'} in your inventory, nothing was given`
  const count = Math.min(Number.isFinite(args?.count) ? args.count : have, have)

  const who = (typeof args?.player === 'string' && args.player.trim()) || config?.player_username || null
  const owner = who ? resolveRecipient(bot, who, config) : null
  const name = who ?? 'the player'
  let ent = owner?.player?.entity
  if (!ent?.position) {
    return `cannot see ${name} nearby, so nothing was given; you still have ${have} ${item}. Walk to them first`
  }

  // 261015 (pass 10): the walk aims at where the player stood when it
  // started, and GoalNear measures block cells, not positions. A player who
  // kept walking, or plain cell rounding, left her "reached" but just past
  // HAND_RANGE + 0.5, and give answered "could not get to Alex (reached)"
  // (pass 9 compare errands-03-B; scorecard gather_craft-02, where the same
  // give a few seconds later worked). Now: after a walk that reached, a toss
  // from up to TOSS_RANGE still goes ahead, and a miss walks once more to
  // where the player is NOW.
  let walked = null
  for (let attempt = 0; attempt < APPROACH_TRIES; attempt++) {
    const d = distance(bot.entity?.position, ent?.position)
    if (d <= HAND_RANGE) break
    if (walked != null && String(walked).startsWith('reached') && d <= TOSS_RANGE) break
    const p = ent.position
    const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
    walked = await goTo(bot, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), WALK_RANGE, timeoutMs, signal)
    if (signal?.aborted || String(walked).startsWith('aborted')) return 'aborted'
    ent = owner?.player?.entity ?? ent
    const after = distance(bot.entity?.position, ent?.position)
    if (after <= HAND_RANGE || (String(walked).startsWith('reached') && after <= TOSS_RANGE)) break
    // A walk that did not reach will not do better a second time.
    if (!String(walked).startsWith('reached') || attempt === APPROACH_TRIES - 1) {
      const gap = Number.isFinite(after) ? `, ${after.toFixed(1)}m away` : ''
      return `could not get to ${name} (${walked}${gap}), so nothing was given; you still have ${have} ${item}`
    }
  }

  await faceEntity(bot, ent)
  if (signal?.aborted) return 'aborted'
  // 261017 (pass 14): so pickup and the drop sweep leave the toss for them.
  const toss = beginGivenToss(bot, { item, from: bot.entity?.position, to: name })
  let res
  try {
    res = String(await drop({ item, count }, bot, config))
  } catch (err) {
    toss.cancel()
    throw err
  }
  const m = /^dropped (\d+) /.exec(res)
  if (!m) toss.cancel()
  if (m) {
    toss.commit(Number(m[1]))
    const left = countOf(bot, item)
    const tail = res.slice(m[0].length - 1).replace(new RegExp(`^ ${item}`), '')
    return `gave ${m[1]} ${item} to ${name}, tossed at their feet${tail}; you have ${left} ${item} left${nextStepNote(bot, item, Number(m[1]))}`
  }
  return `could not give ${item}: ${res}`
}
