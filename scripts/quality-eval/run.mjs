#!/usr/bin/env node
// scripts/quality-eval/run.mjs: the Minecraft companion-quality eval.
//
// For each scenario: reset the local eval server to its pristine world, join a
// scripted + Haiku-driven "player" bot, summon the real Sei companion (Sui on
// claude-haiku-5-5 through companion.mjs, the app's own bot code), play the
// scenario's beats for N minutes, then save a per-session transcript. After
// all sessions, judge.mjs labels every companion line/action and report.mjs
// writes summary.md.
//
//   node scripts/quality-eval/run.mjs [--only id,id] [--minutes N]
//        [--out DIR] [--skip-judge] [--skip-play]
//
// Output: ~/suisei/reports/quality/<YYYY-MM-DD>/ (or --out). Needs the eval
// server set up (scripts/quality-eval/mc-server.sh) and the dev test key at
// ~/.sei-dev/anthropic-test-key. Never prints the key.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { SCENARIOS, BASE_SETUP } from './scenarios.mjs'
import { judgeSessions } from './judge.mjs'
import { writeReport } from './report.mjs'
import { playerSystem, playerAsk, repeatedBit, redoNote, stillRepeats } from './lib/playerBrain.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const require = createRequire(path.join(repo, 'package.json'))
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

// ── args / config ───────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt }

const PORT = Number(process.env.QE_MC_PORT || 25590)
const MC_DIR = process.env.QE_MC_DIR || path.join(os.homedir(), 'suisei', 'eval', 'mc-server')
const SERVER_SH = path.join(here, 'mc-server.sh')
const KEY_FILE = process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
const CHARACTER_FILE = process.env.QE_CHARACTER || path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json')
const PLAYER = process.env.QE_PLAYER || 'Alex'
const PLAYER_MODEL = 'claude-haiku-5-5'
const date = opt('date', new Date().toISOString().slice(0, 10))
const OUT = path.resolve(opt('out', path.join(os.homedir(), 'suisei', 'reports', 'quality', date)))
const only = opt('only', '')?.split(',').filter(Boolean)
const minutesOverride = opt('minutes', null)
const scenarios = SCENARIOS.filter((s) => !only?.length || only.includes(s.id))

const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim()
const anthropic = new Anthropic({ apiKey, maxRetries: 3, timeout: 60000 })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// The player's coin flips (skip a reply, which way to walk). The scorecard
// seeds this per session so paired runs face the same flips; the plain CLI
// keeps Math.random.
let rand = Math.random
const log = (...a) => console.log(`[qe ${new Date().toISOString().slice(11, 19)}]`, ...a)

function server(cmd, ...args) {
  const r = spawnSync('bash', [SERVER_SH, cmd, ...args], { encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`mc-server.sh ${cmd} failed: ${(r.stderr || '').slice(-600)}`)
  return r.stdout
}
const consoleCmd = (c) => fs.appendFileSync(path.join(MC_DIR, 'console.in'), c + '\n')

// ── player bot ──────────────────────────────────────────────────────────
function connectPlayer() {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: PORT, username: PLAYER, auth: 'offline' })
    bot.loadPlugin(pathfinder)
    const to = setTimeout(() => reject(new Error('player spawn timeout')), 60000)
    bot.once('spawn', () => {
      clearTimeout(to)
      const mv = new Movements(bot)
      mv.canDig = false
      mv.allow1by1towers = false
      bot.pathfinder.setMovements(mv)
      resolve(bot)
    })
    bot.once('error', (e) => { clearTimeout(to); reject(e) })
    bot.once('kicked', (r) => { clearTimeout(to); reject(new Error('kicked: ' + JSON.stringify(r))) })
  })
}

function companionEntity(bot, name) {
  return Object.values(bot.entities).find((e) => e.type === 'player' && e.username === name) ?? null
}

const MOVES = ['stay', 'walk_away', 'go_to_companion', 'wander', 'look_at_companion', 'attack_companion', 'walk_to_trees']

async function doMove(bot, move, botName, rec) {
  const me = bot.entity.position
  const sui = companionEntity(bot, botName)
  try {
    switch (move) {
      case 'stay': bot.pathfinder.setGoal(null); break
      case 'walk_away': case 'wander': {
        const d = move === 'walk_away' ? 18 + rand() * 8 : 6 + rand() * 4
        const a = rand() * Math.PI * 2
        bot.pathfinder.setGoal(new goals.GoalNearXZ(Math.round(me.x + Math.cos(a) * d), Math.round(me.z + Math.sin(a) * d), 2))
        break
      }
      case 'go_to_companion':
        if (sui) bot.pathfinder.setGoal(new goals.GoalNear(sui.position.x, sui.position.y, sui.position.z, 2))
        break
      case 'look_at_companion':
        if (sui) await bot.lookAt(sui.position.offset(0, 1.6, 0))
        break
      case 'walk_to_trees': {
        const log = bot.findBlock({ matching: (b) => b && /_log$/.test(b.name), maxDistance: 48 })
        if (log) bot.pathfinder.setGoal(new goals.GoalNear(log.position.x, log.position.y, log.position.z, 3))
        break
      }
      case 'attack_companion': {
        if (!sui) break
        bot.pathfinder.setGoal(new goals.GoalFollow(sui, 1), true)
        for (let i = 0; i < 4; i++) {
          await sleep(900)
          const e = companionEntity(bot, botName)
          if (e && e.position.distanceTo(bot.entity.position) < 3.5) {
            await bot.lookAt(e.position.offset(0, 1.4, 0))
            bot.attack(e)
            rec({ kind: 'player_hit', target: botName })
          }
        }
        bot.pathfinder.setGoal(null)
        break
      }
    }
  } catch (e) {
    rec({ kind: 'player_move_error', move, error: String(e?.message || e) })
  }
}

// ── player brain (Haiku) ────────────────────────────────────────────────
const PLAYER_TOOL = {
  name: 'player_turn',
  description: 'What you type in chat this moment (or nothing), and how you move.',
  input_schema: {
    type: 'object',
    properties: {
      say: { type: 'string', description: 'The chat message you type, or an empty string to say nothing.' },
      move: { type: 'string', enum: MOVES, description: 'What your character does now. stay keeps doing nothing new.' },
    },
    required: ['say', 'move'],
  },
}

// ── one session ─────────────────────────────────────────────────────────
// opts (all optional): minutes, rng (a () => [0,1) function), botRepo (whose
// src/bot runs as the companion; default this repo).
export async function runSession(sc, sessDir, opts = {}) {
  const minutes = Number(opts.minutes ?? minutesOverride ?? sc.minutes)
  rand = opts.rng ?? Math.random
  fs.mkdirSync(sessDir, { recursive: true })
  const playerEventsPath = path.join(sessDir, 'player.events.jsonl')
  const compEventsPath = path.join(sessDir, 'companion.events.jsonl')
  for (const p of [playerEventsPath, compEventsPath]) fs.writeFileSync(p, '')
  const pOut = fs.createWriteStream(playerEventsPath, { flags: 'a' })
  const rec = (ev) => pOut.write(JSON.stringify({ t: Date.now(), ...ev }) + '\n')
  const usage = { player: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, calls: 0 } }

  log(`session ${sc.id}: resetting world`)
  server('reset')
  server('start')
  await sleep(1500)

  const pbot = await connectPlayer()
  rec({ kind: 'player_join', username: PLAYER })
  const characterRow = JSON.parse(fs.readFileSync(CHARACTER_FILE, 'utf8'))
  const botName = (Array.isArray(characterRow) ? characterRow[0] : characterRow).username || 'Sui'

  // Things the player can see: chat, system/death messages.
  const heard = []   // for the brain
  pbot.on('chat', (username, message) => {
    if (username === PLAYER) return
    rec({ kind: 'heard', from: username, text: message })
    heard.push({ t: Date.now(), who: username, text: message })
    if (username === botName) onCompanionLine()
  })
  pbot.on('message', (msg, position) => {
    if (position === 'chat') return
    const tr = msg?.translate || msg?.json?.translate || ''
    const text = msg.toString()
    if (/^death\./.test(tr) || /\b(was slain|died|was shot|drowned|fell|burned|blew up|was killed)\b/.test(text)) {
      rec({ kind: 'death', text })
      heard.push({ t: Date.now(), who: '[game]', text })
    } else if (/joined the game|left the game/.test(text)) {
      rec({ kind: 'system', text })
    }
  })
  pbot.on('death', () => rec({ kind: 'player_death' }))
  pbot.on('kicked', (r) => rec({ kind: 'player_kicked', reason: JSON.stringify(r) }))

  for (const c of BASE_SETUP) consoleCmd(c)
  await sleep(2000)

  // Summon the companion (Electron-as-node so its natives load).
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `qe-${sc.id}-`))
  const electronBin = require('electron')
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LD_PRELOAD: process.env.QE_LD_PRELOAD ?? (fs.existsSync('/usr/lib/x86_64-linux-gnu/libstdc++.so.6') ? '/usr/lib/x86_64-linux-gnu/libstdc++.so.6' : ''),
    QE_CHARACTER: CHARACTER_FILE,
    QE_PORT: String(PORT),
    QE_PLAYER: PLAYER,
    QE_USERDATA: userDataDir,
    QE_RAW_LOG: path.join(sessDir, 'companion.raw.log'),
    QE_EVENTS: compEventsPath,
    QE_KEY_FILE: KEY_FILE,
    QE_BOT_REPO: opts.botRepo ?? repo,
  }
  const comp = spawn(electronBin, [path.join(here, 'companion.mjs')], { cwd: opts.botRepo ?? repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let ready = false, compExited = false
  const compStderr = fs.createWriteStream(path.join(sessDir, 'companion.stderr.log'))
  comp.stderr.pipe(compStderr)
  let buf = ''
  comp.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!ln.startsWith('@@QE ')) continue
      try {
        const ev = JSON.parse(ln.slice(5))
        if (ev.kind === 'lifecycle' && ev.data?.type === 'summon-ready') ready = true
        if (ev.kind === 'lifecycle' && ev.data?.type === 'error') log(`companion error: ${ev.data.error} ${ev.data.message}`)
      } catch {}
    }
  })
  const compDone = new Promise((r) => comp.on('exit', (code) => { compExited = true; r(code) }))

  const t0wait = Date.now()
  while (!ready && !compExited && Date.now() - t0wait < 120000) await sleep(250)
  if (!ready) {
    rec({ kind: 'session_error', error: 'companion never became ready' })
    try { comp.kill('SIGKILL') } catch {}
    pbot.quit()
    pOut.end()
    return { id: sc.id, ok: false, usage }
  }
  const t0 = Date.now()
  rec({ kind: 'session_start', scenario: sc.id, minutes })
  log(`session ${sc.id}: companion ready, playing ${minutes} min`)
  await sleep(1500)
  for (const c of sc.setup) consoleCmd(c.replaceAll('{player}', PLAYER).replaceAll('{bot}', botName))

  // Periodic world view from the player's side (ground truth for the judge).
  const worldTick = setInterval(() => {
    try {
      const sui = companionEntity(pbot, botName)
      const mobs = Object.values(pbot.entities)
        .filter((e) => (e.type === 'hostile' || ['zombie', 'skeleton', 'spider', 'creeper'].includes(e.name)) && e.position.distanceTo(pbot.entity.position) < 24)
        .map((e) => `${e.name}@${e.position.distanceTo(pbot.entity.position).toFixed(0)}m`)
      rec({
        kind: 'world',
        time_of_day: pbot.time?.timeOfDay,
        player_hp: pbot.health, player_food: pbot.food,
        companion_dist: sui ? Number(sui.position.distanceTo(pbot.entity.position).toFixed(1)) : null,
        companion_held: sui?.heldItem?.name ?? null,
        mobs_near_player: mobs.slice(0, 8),
      })
    } catch {}
  }, 30000)

  // ── brain loop ──
  const history = []   // what the player brain sees: {who, text}
  const ownLines = []  // the player's own lines: {text, at}
  let pendingTrigger = null
  let debounce = null
  let busy = false
  let lastPlayerSayAt = 0
  let lastHeardIdx = 0
  const end = t0 + minutes * 60000

  function onCompanionLine() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => { debounce = null; trigger({ type: 'companion_spoke' }) }, 3500)
  }
  function trigger(tr) {
    // A beat always wins over a reaction; keep the most important pending one.
    if (!pendingTrigger || tr.type === 'beat' || pendingTrigger.type !== 'beat') pendingTrigger = tr
    pump()
  }

  async function pump() {
    if (busy || !pendingTrigger || Date.now() > end) return
    const tr = pendingTrigger; pendingTrigger = null
    // Real players do not answer every line. Skip some reactions outright and
    // never react twice within 7s; beats and idle prompts always go through.
    if (tr.type === 'companion_spoke') {
      if (Date.now() - lastPlayerSayAt < 7000 || rand() < 0.25) {
        rec({ kind: 'player_quiet', trigger: tr.type, cue: null, skipped: true })
        return
      }
    }
    busy = true
    try {
      // Fold newly heard lines into history.
      for (; lastHeardIdx < heard.length; lastHeardIdx++) {
        const h = heard[lastHeardIdx]
        history.push({ who: h.who, text: h.text })
      }
      const sui = companionEntity(pbot, botName)
      const distNum = sui ? sui.position.distanceTo(pbot.entity.position) : null
      const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1)
      const inv = pbot.inventory.items().map((i) => `${i.name} x${i.count}`).join(', ') || 'nothing'
      // 261123 (pass 61): prompt and repeat backstop in lib/playerBrain.mjs.
      const ask = playerAsk({
        history, ownLines, botName, player: PLAYER, dist: distNum, hp: pbot.health, inv, elapsedMin, trigger: tr.type, cue: tr.cue,
      })
      const turn = async (content) => {
        const resp = await anthropic.messages.create({
          model: PLAYER_MODEL,
          max_tokens: 200,
          system: [{ type: 'text', text: playerSystem(sc, botName, PLAYER), cache_control: { type: 'ephemeral' } }],
          tools: [PLAYER_TOOL],
          tool_choice: { type: 'tool', name: 'player_turn' },
          messages: [{ role: 'user', content }],
        })
        const u = resp.usage || {}
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) usage.player[k] += u[k] || 0
        usage.player.calls++
        const tu = resp.content.find((c) => c.type === 'tool_use')
        return {
          say: String(tu?.input?.say ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
          move: MOVES.includes(tu?.input?.move) ? tu.input.move : 'stay',
        }
      }
      let { say, move } = await turn(ask)
      if (tr.type !== 'beat') {
        const lastHerLineAt = [...heard].reverse().find((h) => h.who === botName)?.t ?? 0
        const rep = repeatedBit(say, ownLines, { now: Date.now(), lastHerLineAt, dist: distNum, names: [botName, PLAYER] })
        if (rep) {
          const first = say
          ;({ say, move } = await turn(ask.replace(/\n\nCall player_turn\.$/, '') + redoNote(rep, botName) + '\n\nCall player_turn.'))
          if (stillRepeats(say, rep, [botName, PLAYER])) say = ''
          rec({ kind: 'player_redo', bit: rep.bit, times: rep.times, first, second: say })
        }
      }
      if (tr.type === 'beat' && tr.move) move = tr.move
      // Keep at least 4s between player messages so chat reads like a human.
      const gap = Date.now() - lastPlayerSayAt
      if (say && gap < 4000) await sleep(4000 - gap)
      if (say && Date.now() < end) {
        pbot.chat(say)
        lastPlayerSayAt = Date.now()
        history.push({ who: PLAYER, text: say })
        ownLines.push({ text: say, at: lastPlayerSayAt })
        rec({ kind: 'player_say', text: say, trigger: tr.type, cue: tr.cue ?? null })
      } else {
        rec({ kind: 'player_quiet', trigger: tr.type, cue: tr.cue ?? null })
      }
      if (move !== 'stay' || tr.move) {
        rec({ kind: 'player_move', move })
        doMove(pbot, move, botName, rec)
      }
    } catch (e) {
      rec({ kind: 'player_brain_error', error: String(e?.message || e) })
    } finally {
      busy = false
      if (pendingTrigger) setTimeout(pump, 500)
    }
  }

  // Beats + idle triggers.
  const beatTimers = []
  for (const b of sc.beats) {
    beatTimers.push(setTimeout(() => {
      if (b.cmd) for (const c of b.cmd) { const cmd = c.replaceAll('{player}', PLAYER).replaceAll('{bot}', botName); consoleCmd(cmd); rec({ kind: 'server_cmd', cmd }) }
      if (b.cue) trigger({ type: 'beat', cue: b.cue, move: b.move })
      else if (b.move) doMove(pbot, b.move, botName, rec)
    }, b.at * 1000))
  }
  const idleTick = setInterval(() => {
    const now = Date.now()
    const nextBeat = sc.beats.map((b) => t0 + b.at * 1000).filter((x) => x > now).sort((a, b) => a - b)[0] ?? Infinity
    if (now - Math.max(lastPlayerSayAt, t0) > 75000 && nextBeat - now > 20000 && !busy) trigger({ type: 'idle' })
  }, 5000)

  while (Date.now() < end && !compExited) await sleep(1000)

  // ── wrap up ──
  for (const t of beatTimers) clearTimeout(t)
  clearInterval(idleTick); clearInterval(worldTick)
  if (debounce) clearTimeout(debounce)
  rec({ kind: 'session_end', companion_exited_early: compExited })
  log(`session ${sc.id}: stopping companion`)
  try { comp.stdin.write(JSON.stringify({ type: 'stop' }) + '\n') } catch {}
  const killer = setTimeout(() => { try { comp.kill('SIGKILL') } catch {} }, 20000)
  await compDone
  clearTimeout(killer)
  try { pbot.quit() } catch {}
  await sleep(500)
  pOut.end()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({ scenario: sc.id, title: sc.title, minutes, started: t0, player: PLAYER, companion: botName, usage }, null, 2))
  return { id: sc.id, ok: true, usage }
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(path.join(OUT, 'sessions'), { recursive: true })
  log(`output ${OUT}`)
  if (!flag('skip-play')) {
    if (!fs.existsSync(CHARACTER_FILE)) throw new Error(`character file missing: ${CHARACTER_FILE}`)
    for (const sc of scenarios) {
      try {
        const r = await runSession(sc, path.join(OUT, 'sessions', sc.id))
        log(`session ${sc.id}: ${r.ok ? 'done' : 'FAILED'}`)
      } catch (e) {
        log(`session ${sc.id}: crashed: ${e?.stack || e}`)
        fs.writeFileSync(path.join(OUT, 'sessions', sc.id, 'error.txt'), String(e?.stack || e))
      }
    }
    try { server('stop') } catch {}
  }
  if (!flag('skip-judge')) {
    await judgeSessions(OUT, { anthropic, only: only?.length ? only : null })
  }
  await writeReport(OUT)
  log(`report: ${path.join(OUT, 'summary.md')}`)
}

// Run as a CLI only; the scorecard imports runSession.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
