#!/usr/bin/env node
// scripts/quality-eval/terraria/probe.mjs: token cost of the Terraria
// companion with the real brain, on a REAL tModLoader server running the
// SeiCompanion mod with `devCommands` and `headlessTick` on in link.json.
//
//   QE_CHARACTER=<character row json> node scripts/quality-eval/terraria/probe.mjs \
//        --link <tModLoader save>/SeiCompanion/link.json [--minutes 12] [--json out.json]
//
// Plays a scripted session: a pretend player (dev frames) walks around and
// talks at a normal pace, night falls with zombies, a boss shows up. The bot
// is the real src/bot entry (companion-terraria.mjs). Reports tokens per turn
// (input, cache read, cache write, output), turns per hour, and the cost per
// hour at the Haiku 5.5 list price, plus the verbs the model chose.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
const LINK = opt('--link', null)
if (!LINK || !process.env.QE_CHARACTER) { console.error('usage: QE_CHARACTER=<row.json> probe.mjs --link <link.json> [--minutes 12]'); process.exit(2) }
const MINUTES = Number(opt('--minutes', 12))
const JSON_OUT = opt('--json', null)
const PLAYER = 'Ouen'
const link = JSON.parse(readFileSync(LINK, 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Haiku 5.5 list price, USD per million tokens (prompts under 100K).
const PRICE = { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 }

/* ── driver link (dev frames only; the bot has its own session) ── */
function connect(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(link.token)}`)
  const pending = new Map()
  const events = []
  let seq = 0
  ws.onmessage = (ev) => {
    for (const line of String(ev.data).split('\n')) {
      if (!line.trim()) continue
      let f
      try { f = JSON.parse(line) } catch { continue }
      if (f.t === 'result' && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); continue }
      if (f.t !== 'obs') events.push({ at: Date.now(), ...f })
    }
  }
  const send = (frame, timeoutMs = 20_000) => new Promise((resolve) => {
    const id = `p${++seq}`
    pending.set(id, resolve)
    ws.send(JSON.stringify({ ...frame, id }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, detail: 'timeout' }) } }, timeoutMs)
  })
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, send, events })
    ws.onerror = (e) => reject(new Error(`link: ${e.message ?? 'error'}`))
  })
}

/* ── bot process ── */
const turns = []
const calls = []
const chatOut = []
const errors = []
let companionName = null
const hello = await (await fetch(`http://localhost:${link.port}/hello`)).json()
const join = { port: link.port, token: link.token, label: hello.world?.name ?? 'world', uniqueId: hello.world?.uniqueId ?? '', owner: PLAYER }
const child = spawn(process.execPath, [path.join(here, 'companion-terraria.mjs')], {
  env: { ...process.env, QE_JOIN: JSON.stringify(join), QE_PLAYER: PLAYER, POSTHOG_KEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => {
  out += d
  let i
  while ((i = out.indexOf('\n')) >= 0) {
    const ln = out.slice(0, i); out = out.slice(i + 1)
    if (!ln.startsWith('@@QE ')) continue
    let ev
    try { ev = JSON.parse(ln.slice(5)) } catch { continue }
    if (ev.kind === 'llm_turn') turns.push({ at: ev.t, usage: ev.usage, calls: ev.calls.map((c) => c.name) })
    else if (ev.kind === 'action_call') calls.push(ev.name)
    else if (ev.kind === 'chat_out') chatOut.push(ev.text)
    else if (ev.kind === 'llm_error') errors.push(ev.error)
  }
})
child.stderr.on('data', () => {})

const D = await connect(link.port)
const dev = (type, args = {}) => D.send({ t: type, companion: companionName, ...args })
const state = await D.send({ t: 'devState' })
const SPAWN = { x: state.spawn[0], y: state.spawn[1] }

// Wait for her body: the world's companion list (from /hello) gains her name.
const before = new Set(hello.world?.companions ?? [])
let body = null
const t0 = Date.now()
while (!body && Date.now() - t0 < 90_000) {
  await sleep(1000)
  const h = await (await fetch(`http://localhost:${link.port}/hello`)).json().catch(() => null)
  body = (h?.world?.companions ?? []).find((c) => !before.has(c)) ?? null
}
if (!body) { console.error('the companion never spawned'); child.kill('SIGTERM'); process.exit(1) }
companionName = body
console.log(`[probe] ${companionName} is in the world; running ${MINUTES} min`)
const startedAt = Date.now()
await dev('devAnchor', { x: SPAWN.x })
await dev('devTime', { day: true, time: 6000 })
for (const [item, count] of [['Copper Shortsword', 1], ['Copper Pickaxe', 1], ['Copper Axe', 1], ['Lesser Healing Potion', 3], ['Torch', 10]]) await dev('devGive', { item, count })

const say = (text) => dev('devChat', { from: PLAYER, text, dist: 4 })
let anchorX = SPAWN.x
const walk = async (dx) => { anchorX += dx; await dev('devAnchor', { x: anchorX }) }

// A normal-paced session, compressed to MINUTES (the script's times scale).
const scale = (MINUTES * 60_000) / (12 * 60_000)
const script = [
  [5, () => say('hey, follow me, we need wood')],
  [40, () => walk(18)],
  [70, () => say('can you chop that tree for me')],
  [130, () => walk(-12)],
  [150, () => say('what do you have on you?')],
  [210, () => say('mine some dirt here, we need blocks')],
  [270, () => walk(20)],
  [300, async () => { await dev('devTime', { day: false, time: 0 }); for (let i = 0; i < 3; i++) await dev('devSpawn', { npc: 'Zombie', dx: 10 + i * 3 }) }],
  [310, () => say('zombies! help')],
  [390, () => say('nice. can you make a work bench?')],
  [450, () => walk(-15)],
  [470, () => dev('devSpawn', { npc: 'Eye of Cthulhu', dy: -20 })],
  [540, () => say('come here, stay close')],
  [600, () => say('ok stay here for a bit, I am going to look around')],
  [620, () => walk(30)],
]
for (const [sec, fn] of script) {
  const at = startedAt + sec * 1000 * scale
  while (Date.now() < at) await sleep(250)
  await fn()
}
while (Date.now() < startedAt + MINUTES * 60_000) await sleep(500)
const elapsedMin = (Date.now() - startedAt) / 60_000
const deaths = D.events.filter((e) => e.t === 'death').length
const alerts = D.events.filter((e) => e.t === 'event').map((e) => e.kind)
await dev('devClear')

child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n')
await Promise.race([new Promise((r) => child.once('exit', r)), sleep(10_000)])
if (child.exitCode == null) child.kill('SIGKILL')
D.ws.close()

/* ── report ── */
const inSession = turns.filter((t) => t.at >= startedAt)
const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
for (const t of inSession) {
  const u = t.usage ?? {}
  sum.input += u.input_tokens ?? 0
  sum.cacheRead += u.cache_read_input_tokens ?? 0
  sum.cacheWrite += u.cache_creation_input_tokens ?? 0
  sum.output += u.output_tokens ?? 0
}
const n = inSession.length || 1
const perHour = 60 / elapsedMin
const cost = (s) => (s.input * PRICE.input + s.output * PRICE.output + s.cacheRead * PRICE.cacheRead + s.cacheWrite * PRICE.cacheWrite) / 1e6
const verbCounts = {}
for (const c of calls) verbCounts[c] = (verbCounts[c] ?? 0) + 1
const report = {
  minutes: Number(elapsedMin.toFixed(1)),
  turns: inSession.length,
  turnsPerHour: Math.round(inSession.length * perHour),
  perTurn: { input: Math.round(sum.input / n), cacheRead: Math.round(sum.cacheRead / n), cacheWrite: Math.round(sum.cacheWrite / n), output: Math.round(sum.output / n) },
  perHour: { input: Math.round(sum.input * perHour), cacheRead: Math.round(sum.cacheRead * perHour), cacheWrite: Math.round(sum.cacheWrite * perHour), output: Math.round(sum.output * perHour) },
  usdPerHour: Number((cost(sum) * perHour).toFixed(4)),
  usdThisRun: Number(cost(sum).toFixed(4)),
  verbs: verbCounts,
  lines: chatOut.length,
  llmErrors: errors.length,
  deaths,
  alerts,
}
console.log(JSON.stringify(report, null, 2))
console.log('[probe] her lines:')
for (const l of chatOut) console.log(`  ${l}`)
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ report, turns: inSession, chatOut, errors: errors.slice(0, 20) }, null, 2))
process.exit(0)
