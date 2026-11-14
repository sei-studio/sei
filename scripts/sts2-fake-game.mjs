#!/usr/bin/env node
// scripts/sts2-fake-game.mjs: a stand-in for Slay the Spire 2 + the Sei mod,
// for testing the REAL app end to end without the game (dev machine or a
// Mac that does not own the game).
//
// It plays both windows the way the mod does (native/sts2-mod/PROTOCOL.md):
//   - writes status-host.json (lobby "enet") and status-seat.json heartbeats
//     every 3 s, so the app sees an open "Play with Sei" lobby and a running
//     companion window (main then skips spawning the real game);
//   - watches link.json; when the app writes a new {port, token} for a
//     summon, connects a host and a seat fake mod to the bot's link;
//   - the seat runs the synthetic run in src/bot/adapter/sts2/fixtures
//     (rules enforced there, every companion move is the bot's);
//   - every line typed on stdin is the player typing in the game (sei/chat);
//     the companion's in-game speech (sei/say) is printed.
//
// Usage: node scripts/sts2-fake-game.mjs [--link-dir <dir>] [--seed 7]
//          [--player-delay-ms 1500] [--upstream] [--player Tester]
// Stop with Ctrl-C (removes the heartbeats so the app sees the game close).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createFakeMod } from '../src/bot/adapter/sts2/fixtures/fakeMod.js'

const args = process.argv.slice(2)
const opt = (name, d = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const flag = (name) => args.includes(`--${name}`)

/** Same folder as src/main/games/sts2/link.ts linkDirFor. */
function defaultLinkDir() {
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'sei-sts2')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'sei-sts2')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'sei-sts2')
}

const LINK_DIR = opt('link-dir', defaultLinkDir())
const SEED = Number(opt('seed', '7'))
const PLAYER_DELAY_MS = Number(opt('player-delay-ms', '1500'))
const STRUCTURED = !flag('upstream')
const PLAYER = opt('player', 'Tester')
const HEARTBEAT_MS = 3_000

const log = (...a) => process.stdout.write(`[fake sts2] ${a.join(' ')}\n`)
fs.mkdirSync(LINK_DIR, { recursive: true })

let link = null // { port, token }
let host = null
let seat = null
let saidSeen = 0
let stopping = false

function screenOf() {
  const sc = seat?.scenario
  if (!sc) return 'main_menu'
  return sc.phase === 'won' || sc.phase === 'lost' ? 'game_over' : String(sc.phase ?? 'map')
}

function writeStatus(role) {
  const sc = seat?.scenario
  const body = {
    ts: Date.now(),
    role,
    version: '0.1.0-fake',
    protocol: 1,
    game_version: 'fake',
    screen: role === 'host' ? (sc ? screenOf() : 'multiplayer_lobby') : screenOf(),
    lobby: 'enet',
    in_run: !!sc && sc.phase !== 'lobby',
    players: sc ? [PLAYER, 'companion'] : [PLAYER],
    pid: process.pid,
    linked: role === 'host' ? !!host?.open : !!seat?.open,
  }
  const file = path.join(LINK_DIR, `status-${role}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(body))
  fs.renameSync(tmp, file)
}

function heartbeat() {
  try { writeStatus('host'); writeStatus('seat') } catch (e) { log('heartbeat failed:', e.message) }
}

function readLink() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(LINK_DIR, 'link.json'), 'utf8'))
    return Number.isInteger(raw?.port) && typeof raw?.token === 'string' ? { port: raw.port, token: raw.token } : null
  } catch {
    return null
  }
}

function closeMods() {
  try { host?.close() } catch {}
  try { seat?.close() } catch {}
  host = null
  seat = null
  saidSeen = 0
}

/** Connect one fake mod, retrying every 2 s while this link is current (the mod's own loop). */
async function connectLoop(mod, forLink, role) {
  while (!stopping && link === forLink) {
    try {
      await mod.connect()
      log(`${role} window linked on port ${forLink.port}`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
}

function startSession(l) {
  closeMods()
  link = l
  const url = `ws://127.0.0.1:${l.port}/sei-sts2?token=${encodeURIComponent(l.token)}`
  seat = createFakeMod({ url, role: 'seat', structured: STRUCTURED, seed: SEED, playerName: PLAYER, playerDelayMs: PLAYER_DELAY_MS, settleMs: 200 })
  seat.onBye(() => { log('the companion left (sei/bye); waiting for the next summon'); })
  connectLoop(seat, l, 'seat')
  if (STRUCTURED) {
    // Only the Sei fork has a host role; it carries the player's typed chat.
    host = createFakeMod({ url, role: 'host', structured: true, playerName: PLAYER, scenario: seat.scenario })
    connectLoop(host, l, 'host')
  }
}

function poll() {
  const l = readLink()
  if (l && (!link || l.port !== link.port || l.token !== link.token)) {
    log(`new summon: link port ${l.port}`)
    startSession(l)
  }
  if (seat) {
    while (saidSeen < seat.said.length) log(`companion says: ${seat.said[saidSeen++]}`)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  const via = host?.open ? host : seat?.open ? seat : null
  if (!via) return log('not linked yet; nothing sent')
  via.chat(text, PLAYER)
})

function shutdown() {
  if (stopping) return
  stopping = true
  closeMods()
  for (const role of ['host', 'seat']) { try { fs.rmSync(path.join(LINK_DIR, `status-${role}.json`), { force: true }) } catch {} }
  log('stopped; heartbeats removed')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

log(`link folder ${LINK_DIR}`)
log(`${STRUCTURED ? 'Sei mod' : 'upstream neuro-sts2'} mode, seed ${SEED}. Open Sei, pick Slay the Spire 2 and press Launch. Type here to talk in the game.`)
heartbeat()
setInterval(heartbeat, HEARTBEAT_MS)
setInterval(poll, 1_000)
