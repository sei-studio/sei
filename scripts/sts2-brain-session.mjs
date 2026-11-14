#!/usr/bin/env node
// scripts/sts2-brain-session.mjs: a real companion session in Slay the Spire
// 2, headless. Boots the REAL bot (src/bot/index.js, the app's code path, real
// brain and LLM) against the fake mod (src/bot/adapter/sts2/fixtures: a
// synthetic co-op run whose rules are enforced there, like the game does),
// plays a scripted player for a while, and reports the LLM token use per hour
// of play plus a transcript of what she said and did.
//
// The player is simulated by the scenario (their own turns in co-op fights);
// their chat lines go in over the host window's link (sei/chat), the same way
// the Sei mod forwards in-game chat.
//
// Key (dev only): ~/.sei-dev/anthropic-test-key, or SEI_TEST_KEY_FILE. Never printed.
//
// Usage: node scripts/sts2-brain-session.mjs [--minutes 10] [--seed 7]
//          [--upstream] [--player-delay-ms 2000] [--out /path/transcript.jsonl]
//          [--max-tokens 3000000]

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFakeMod } from '../src/bot/adapter/sts2/fixtures/fakeMod.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const args = process.argv.slice(2)
const opt = (name, d = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const MINUTES = Number(opt('minutes', '10'))
const OUT = opt('out', null)
const MAX_TOKENS = Number(opt('max-tokens', '3000000'))
const SEED = Number(opt('seed', '7'))
const STRUCTURED = !args.includes('--upstream')
const PLAYER_DELAY_MS = Number(opt('player-delay-ms', '2000'))
const PLAYER = 'Tester'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const keyFile = process.env.SEI_TEST_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
const apiKey = fs.readFileSync(keyFile, 'utf8').trim()
if (!apiKey) { console.error('empty key file'); process.exit(2) }
const charFile = process.env.SEI_CHARACTER || path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json')
let row = JSON.parse(fs.readFileSync(charFile, 'utf8'))
if (Array.isArray(row)) row = row[0]
const character = {
  id: row.id,
  name: row.name,
  username: row.username,
  persona: { source: row.persona_source ?? '', expanded: row.persona_expanded ?? '' },
  metadata: row.metadata ?? {},
}

// Analytics stays off in test runs.
delete process.env.POSTHOG_KEY

let out = OUT ? fs.createWriteStream(OUT) : null
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`
function record(ev) {
  out?.write(JSON.stringify({ t: Date.now() - t0, ...ev }) + '\n')
}

// ── log tap: the bot logs each event as one "[ts] [tag] begin ... end" block.
const usage = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, errors: 0 }
const said = []
const acted = []
let lastStats = null
function field(lines, name) {
  const i = lines.findIndex((l) => l.startsWith(`  ${name}:`))
  if (i < 0) return null
  const parts = [lines[i].slice(name.length + 3).trim()]
  for (let j = i + 1; j < lines.length && lines[j].startsWith('    '); j++) parts.push(lines[j].trim())
  return parts.join('\n')
}
function onLog(s) {
  if (!s.includes('] begin')) return
  const lines = s.split('\n')
  const tag = /\] (\[[^\]]+\]) begin$/.exec(lines[0] || '')?.[1]
  if (tag === '[haiku!]') {
    let u = null
    try { u = JSON.parse(field(lines, 'usage') ?? 'null') } catch {}
    if (u) {
      usage.turns += 1
      usage.input += u.input_tokens ?? 0
      usage.cacheRead += u.cache_read_input_tokens ?? 0
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0
      usage.output += u.output_tokens ?? 0
    }
    record({ kind: 'turn', usage: u, calls: field(lines, 'calls') })
  } else if (tag === '[haiku✗]') {
    usage.errors += 1
    record({ kind: 'llm_error', error: field(lines, 'error') })
  } else if (tag === '[chat->]') {
    const text = field(lines, 'text') ?? ''
    said.push(text)
    console.log(`${stamp()} ${character.name}: ${text}`)
    record({ kind: 'said', text })
  } else if (tag === '[act!]') {
    const a = `${field(lines, 'action')} -> ${(field(lines, 'result') ?? '').slice(0, 160)}`
    acted.push(a)
    console.log(`${stamp()}   [act] ${a}`)
    record({ kind: 'act', text: a })
  }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[level].bind(console)
  console[level] = (...a) => {
    let s
    try { s = a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' ') } catch { s = String(a[0]) }
    if (s.includes('] begin')) { try { onLog(s) } catch {} return }
    if (/^\s*\d+s /.test(s) || process.env.SEI_ECHO === '1') orig(...a)
  }
}
const say = (...a) => process.stdout.write(a.join(' ') + '\n')

// ── a free loopback port for the bot's link (main's pickLinkPort in the app)
const port = await new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const token = 'probe-' + Math.random().toString(36).slice(2, 10)

// ── fake supervisor + the real bot
class FakePort extends EventEmitter {
  start() {}
  close() {}
  postMessage(data) {
    if (data?.type === 'sts2-stats') { lastStats = data.stats; record({ kind: 'stats', stats: data.stats }) }
    if (data?.type === 'lifecycle' || data?.type === 'summon-ready' || data?.type === 'error') record({ kind: 'lifecycle', data })
    if (data?.type === 'error') say(`${stamp()} bot error: ${JSON.stringify(data).slice(0, 300)}`)
  }
  send(data) { this.emit('message', { data }) }
}
const botPort = new FakePort()
const parentPort = new EventEmitter()
process.parentPort = parentPort
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-sts2-ud-'))
fs.mkdirSync(path.join(userDataDir, 'memory', character.id), { recursive: true })
await import(pathToFileURL(path.join(repo, 'src', 'bot', 'index.js')).href)
parentPort.emit('message', {
  data: {
    type: 'init',
    character,
    apiKey,
    game: 'sts2',
    joinTarget: { port, token, label: 'Slay the Spire 2' },
    worldLabel: 'Slay the Spire 2',
    userDataDir,
    preferred_name: PLAYER,
    visionMode: 'off',
    realisticTyping: true,
    chatLanguage: 'en',
    companions: [],
    continuity: null,
    knowledge: '',
    readyBudgetMs: 120000,
  },
  ports: [botPort],
})

// ── the two game windows (the mod's connect loop: retry until the link listens)
const url = `ws://127.0.0.1:${port}/sei-sts2?token=${token}`
const seat = createFakeMod({ url, role: 'seat', structured: STRUCTURED, seed: SEED, playerName: PLAYER, playerDelayMs: PLAYER_DELAY_MS, settleMs: 200 })
const host = STRUCTURED ? createFakeMod({ url, role: 'host', structured: true, playerName: PLAYER, scenario: seat.scenario }) : null
async function connect(mod) {
  for (let i = 0; i < 60; i++) {
    try { await mod.connect(); return true } catch { await sleep(2000) }
  }
  return false
}
if (!(await connect(seat))) { say('the bot link never came up'); process.exit(1) }
if (host) await connect(host)
say(`${stamp()} linked (${STRUCTURED ? 'Sei mod' : 'upstream'} mode, seed ${SEED})`)
const sc = seat.scenario
const chat = (text) => {
  say(`${stamp()} ${PLAYER}: ${text}`)
  record({ kind: 'player', text })
  ;(host ?? seat).chat(text, PLAYER)
}

// ── the scripted player: talk around the run the scenario plays out
const plan = [
  [20, () => chat('hey! ready to climb? pick whoever you like')],
  [90, () => chat('what do you think of that fight?')],
  [200, () => chat('should we take the elite or play it safe')],
  [330, () => chat('your hp ok? i can block for you')],
  [450, () => chat('that card pick, why that one?')],
  [540, () => chat('brb, getting a snack')],
]
const endAt = MINUTES * 60
const started = Date.now()
let next = 0
let lastPhase = null
let saidSeen = 0
while ((Date.now() - started) / 1000 < endAt) {
  const t = (Date.now() - started) / 1000
  while (next < plan.length && plan[next][0] * (MINUTES / 10) <= t) {
    try { plan[next][1]() } catch (e) { say(`plan step failed: ${e?.message ?? e}`) }
    next += 1
  }
  if (sc.phase !== lastPhase) {
    lastPhase = sc.phase
    say(`${stamp()} -- ${sc.phase} (floor ${sc.run?.floor ?? '?'})`)
    record({ kind: 'phase', phase: sc.phase, run: sc.run })
  }
  while (saidSeen < seat.said.length) record({ kind: 'bubble', text: seat.said[saidSeen++] })
  if (sc.phase === 'won' || sc.phase === 'lost') { await sleep(15_000); break }
  if (usage.input + usage.cacheRead + usage.cacheWrite > MAX_TOKENS) { say('token cap reached, stopping early'); break }
  await sleep(1000)
}

// ── report, then stop (the bot's graceful stop exits the process)
const minutes = (Date.now() - started) / 60_000
const perHour = (n) => Math.round((n / minutes) * 60)
const moves = seat.received.filter((m) => m.command === 'action')
const report = {
  minutes: Number(minutes.toFixed(1)),
  mode: STRUCTURED ? 'sei' : 'upstream',
  run: { phase: sc.phase, ...(sc.run ?? {}) },
  turns: usage.turns,
  llm_errors: usage.errors,
  per_hour: {
    turns: perHour(usage.turns),
    input_uncached: perHour(usage.input),
    cache_read: perHour(usage.cacheRead),
    cache_write: perHour(usage.cacheWrite),
    output: perHour(usage.output),
  },
  totals: { ...usage },
  lines_said: said.length,
  bubbles: seat.said.length,
  moves_sent: moves.length,
  stats: lastStats,
}
say('\n' + JSON.stringify(report, null, 2))
record({ kind: 'report', report })
// The bot keeps logging while it stops; nothing may write to a closed stream.
const ended = out
out = null
ended?.end()
botPort.send({ type: 'stop' })
await sleep(3000)
try { host?.close() } catch {}
try { seat.close() } catch {}
try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
setTimeout(() => process.exit(0), 1500)
