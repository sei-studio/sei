#!/usr/bin/env node
// scripts/factorio-brain-session.mjs: a real companion session in Factorio,
// headless. Boots the REAL bot (src/bot/index.js, the app's code path, real
// brain and LLM) against a Factorio 2.1 headless server running the
// sei-companion mod, plays a scripted player for a while, and reports the
// LLM token use per hour of play plus a transcript of what she said and did.
//
// The player is a stand-in character the script moves over RCON; its chat
// lines go in through the mod's `inject_chat` test seam (a headless server has
// no player who could type).
//
// Key (dev only): ~/.sei-dev/anthropic-test-key, or SEI_TEST_KEY_FILE. Never printed.
//
// Usage: node scripts/factorio-brain-session.mjs [--minutes 15] [--factorio <bin>]
//          [--out /path/transcript.jsonl] [--max-tokens 4000000]

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startFactorioServer, defaultBin, sleep } from './lib/factorioServer.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const args = process.argv.slice(2)
const opt = (name, d = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const MINUTES = Number(opt('minutes', '15'))
const OUT = opt('out', null)
const MAX_TOKENS = Number(opt('max-tokens', '4000000'))
const BIN = opt('factorio', defaultBin())
const PLAYER = 'Tester'

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

const out = OUT ? fs.createWriteStream(OUT) : null
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`
function record(ev) {
  out?.write(JSON.stringify({ t: Date.now() - t0, ...ev }) + '\n')
}

// ── log tap: the bot logs each event as one "[ts] [tag] begin ... end" block.
const usage = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, errors: 0 }
const said = []
const acted = []
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
    const calls = field(lines, 'calls')
    record({ kind: 'turn', usage: u, calls })
  } else if (tag === '[haiku✗]') {
    usage.errors += 1
    record({ kind: 'llm_error', error: field(lines, 'error') })
  } else if (tag === '[chat->]') {
    const text = field(lines, 'text') ?? ''
    said.push(text)
    console.log(`${stamp()} Sui: ${text}`)
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

// ── server + stand-in player
const srv = await startFactorioServer({ bin: BIN, speed: 1 })
const { lua, J } = srv
const CID = `0:${character.username ? String(character.username).toLowerCase() : 'sui'}`
await lua(`local e = game.surfaces.nauvis.create_entity{name='character', position={0, 0}, force='player'} storage.tester = e remote.call('sei_companion', 'set_test_owner', '${CID}', e.unit_number) ${J('e.unit_number')}`)
const chat = async (text) => {
  say(`${stamp()} ${PLAYER}: ${text}`)
  record({ kind: 'player', text })
  await lua(`remote.call('sei_companion', 'inject_chat', '${PLAYER}', ${JSON.stringify(text)}) ${J('1')}`)
}
const walkTo = (x, y) => lua(`storage.tester.teleport({${x}, ${y}}) ${J('1')}`)

// ── fake supervisor + the real bot
class FakePort extends EventEmitter {
  start() {}
  close() {}
  postMessage(data) {
    if (data?.type === 'factorio-stats') record({ kind: 'stats', stats: data.stats })
    if (data?.type === 'lifecycle' || data?.type === 'summon-ready' || data?.type === 'error') record({ kind: 'lifecycle', data })
  }
  send(data) { this.emit('message', { data }) }
}
const botPort = new FakePort()
const parentPort = new EventEmitter()
process.parentPort = parentPort
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-fct-ud-'))
fs.mkdirSync(path.join(userDataDir, 'memory', character.id), { recursive: true })
await import(pathToFileURL(path.join(repo, 'src', 'bot', 'index.js')).href)
parentPort.emit('message', {
  data: {
    type: 'init',
    character,
    apiKey,
    game: 'factorio',
    joinTarget: { port: srv.udpPort, label: 'Sei test map' },
    worldLabel: 'Sei test map',
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

// ── the scripted hour, compressed: talk, ask for work, a raid, quiet stretches
const plan = [
  [15, () => chat('hey sui! ok fresh map, wanna help me get going?')],
  [45, () => chat('can you grab some wood and stone for me')],
  [150, () => chat('nice. can you make a couple of stone furnaces?')],
  [240, () => walkTo(30, 10)],
  [300, () => chat('ok put one down near the iron over here and keep it fed')],
  [420, () => lua(`for i = 1, 3 do game.surfaces.nauvis.create_entity{name='small-biter', position={storage.tester.position.x + 12 + i, storage.tester.position.y - 8}, force='enemy'} end ${J('1')}`)],
  [480, () => chat('whoa that was close lol')],
  [600, () => walkTo(-20, -15)],
  [660, () => chat('what should we work on next?')],
  [780, () => chat('brb getting a drink')],
]
const endAt = MINUTES * 60
const started = Date.now()
let next = 0
while ((Date.now() - started) / 1000 < endAt) {
  const t = (Date.now() - started) / 1000
  while (next < plan.length && plan[next][0] * (MINUTES / 15) <= t) {
    try { await plan[next][1]() } catch (e) { say(`plan step failed: ${e?.message ?? e}`) }
    next += 1
  }
  if (usage.input + usage.cacheRead + usage.cacheWrite > MAX_TOKENS) { say('token cap reached, stopping early'); break }
  await sleep(1000)
}

// ── report, then stop (the bot's graceful stop exits the process)
const minutes = (Date.now() - started) / 60_000
const perHour = (n) => Math.round((n / minutes) * 60)
const report = {
  minutes: Number(minutes.toFixed(1)),
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
  actions: acted.length,
}
say('\n' + JSON.stringify(report, null, 2))
record({ kind: 'report', report })
out?.end()
try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
botPort.send({ type: 'stop' })
await sleep(3000)
srv.stop()
setTimeout(() => process.exit(0), 1500)
