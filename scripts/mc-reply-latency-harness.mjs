// mc-reply-latency-harness.mjs (261126, O5): times the in-game reply path
// with the REAL bot code (src/bot/index.js in cloud-proxy mode) against a
// local Minecraft server and a stub Anthropic endpoint with a fixed model
// delay. No real LLM, no analytics. Prints one reply_latency sample per line
// (with the phase props from brain/actionStats.js) and a per-scenario summary:
// `client_p50` = ms - llm_model_ms, the time spent outside the model.
//
// Start a scratch server on its own port and directory (never the eval
// server's), then run with Electron's Node so the native deps load:
//   QE_MC_DIR=<scratch dir> QE_MC_PORT=25611 bash scripts/quality-eval/mc-server.sh setup  # then start
//   env -u POSTHOG_KEY ELECTRON_RUN_AS_NODE=1 H_REPO=$PWD H_PORT=25611 \
//     H_MODEL_MS=1000 H_LINES=6 H_OUT=<dir>/out.jsonl \
//     timeout 300 node_modules/.bin/electron scripts/mc-reply-latency-harness.mjs
// Env: H_REPO (bot repo), H_PORT (MC port), H_MODEL_MS (stub delay),
//      H_LINES (player lines per scenario), H_OUT (jsonl results; bot logs go
//      to bot-raw.log beside it), H_EARLY_MS (delay of the first line after
//      she joins). The player client speaks 1.21.11 (the eval server's jar).
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repo = process.env.H_REPO
const mcPort = Number(process.env.H_PORT || 25611)
const MODEL_MS = Number(process.env.H_MODEL_MS || 1000)
const LINES = Number(process.env.H_LINES || 8)
const outFile = process.env.H_OUT || null
const PLAYER = 'Alex'
const out = outFile ? fs.createWriteStream(outFile, { flags: 'w' }) : null
const rec = (o) => { const l = JSON.stringify({ t: Date.now(), ...o }); out?.write(l + '\n'); process.stdout.write('@@H ' + l + '\n') }

// ── stub Anthropic ─────────────────────────────────────────────────────
let scenario = 'say'
let callN = 0
const callLog = []
function lastUserText(body) {
  const msgs = body.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue
    const c = msgs[i].content
    return typeof c === 'string' ? c : JSON.stringify(c)
  }
  return ''
}
const stub = http.createServer((req, res) => {
  let buf = ''
  req.on('data', (d) => { buf += d })
  req.on('end', () => {
    const t0 = Date.now()
    let body = {}
    try { body = JSON.parse(buf) } catch {}
    if (!req.url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"nope"}'); return
    }
    const id = ++callN
    const text = lastUserText(body)
    const m = /PING(\d+)/.exec(text)
    let content
    if (m) {
      const n = m[1]
      content = [{ type: 'text', text: 'thinking' }]
      if (scenario === 'follow' && n === '0') content.push({ type: 'tool_use', id: `tu_f${id}`, name: 'follow', input: { player: PLAYER } })
      content.push({ type: 'tool_use', id: `tu_s${id}`, name: 'say', input: { text: `pong ${n}` } })
    } else {
      content = [{ type: 'text', text: '' }, { type: 'tool_use', id: `tu_e${id}`, name: 'end_loop', input: {} }]
    }
    const reqBytes = buf.length
    setTimeout(() => {
      const closed = res.destroyed || res.socket?.destroyed === true
      callLog.push({ id, ping: m?.[1] ?? null, reqBytes, ms: Date.now() - t0, aborted: closed })
      if (closed) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model || 'stub',
        content, stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }))
    }, MODEL_MS)
  })
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const stubUrl = `http://127.0.0.1:${stub.address().port}`

// ── fake supervisor ─────────────────────────────────────────────────────
const samples = []
let summonReady = false
class FakePort extends EventEmitter {
  start() {} close() {}
  postMessage(data) {
    if (!data || typeof data !== 'object') return
    if (data.type === 'reply-latency') { samples.push({ ...data, scenario }); rec({ kind: 'sample', scenario, ...data }) }
    else if (data.type === 'summon-ready') summonReady = true
  }
  send(data) { this.emit('message', { data }) }
}
const botPort = new FakePort()
const parentPort = new EventEmitter()
process.parentPort = parentPort

// Bot logs: keep quiet, but time-stamp a few for the breakdown.
const logFile = fs.createWriteStream(path.join(path.dirname(outFile || os.tmpdir() + '/x'), 'bot-raw.log'), { flags: 'w' })
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    let s; try { s = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.stack : JSON.stringify(a)))).join(' ') } catch { s = String(args[0]) }
    logFile.write(`${Date.now()} ${s}\n`)
  }
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcreply-ud-'))
const character = { id: 'harness-sui', name: 'Sui', username: 'Sui', persona: { source: '', expanded: 'You are Sui, a cheerful companion.' }, metadata: {} }
fs.mkdirSync(path.join(userDataDir, 'memory', character.id), { recursive: true })

const botRequire = createRequire(path.join(repo, 'package.json'))
const mineflayer = botRequire('mineflayer')

await import(pathToFileURL(path.join(repo, 'src', 'bot', 'index.js')).href)

// The human player joins first (the companion follows the owner).
const player = mineflayer.createBot({ host: '127.0.0.1', port: mcPort, username: PLAYER, version: '1.21.11', auth: 'offline' })
await new Promise((r, j) => { player.once('spawn', r); player.once('error', j) })
rec({ kind: 'player_spawned' })

parentPort.emit('message', {
  data: {
    type: 'init',
    character,
    cloudMode: { baseURL: stubUrl, authToken: 'stub-token' },
    game: 'minecraft',
    joinTarget: { port: mcPort, motd: 'harness', mc_username: PLAYER, skinServerBaseUrl: null },
    worldLabel: 'harness',
    userDataDir,
    mc_username: PLAYER,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
while (!summonReady && Date.now() - t0 < 120_000) await sleep(200)
rec({ kind: 'summon_ready', ok: summonReady, ms: Date.now() - t0 })
if (!summonReady) process.exit(3)
let n = 0
// A line right after she joins (her first-contact turn may be in flight).
scenario = 'early'
await sleep(Number(process.env.H_EARLY_MS || 300))
{ const before = samples.length; player.chat('hi sui PING900'); const ts = Date.now(); while (samples.length === before && Date.now() - ts < 25_000) await sleep(20) }
// Let the greeting / first-contact turn finish.
await sleep(8000)

async function runScenario(name, lines, gapMs) {
  scenario = name
  for (let i = 0; i < lines; i++) {
    const before = samples.length
    player.chat(`hey sui PING${name === 'follow' ? i : n}`)
    n++
    const ts = Date.now()
    while (samples.length === before && Date.now() - ts < 25_000) await sleep(20)
    await sleep(gapMs)
  }
}
await runScenario('say', LINES, 3000)
// follow: line 0 starts follow (action), later lines arrive mid-action.
await runScenario('follow', LINES, 3000)

rec({ kind: 'calls', calls: callLog })
// Summary.
for (const sc of ['early', 'say', 'follow']) {
  const s = samples.filter((x) => x.scenario === sc && x.outcome === 'replied')
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null }
  rec({
    kind: 'summary', scenario: sc, n: s.length, model_ms: MODEL_MS,
    ms_p50: med(s.map((x) => x.ms)),
    client_p50: med(s.map((x) => x.ms - (x.llm_model_ms ?? 0))),
    first_req_p50: med(s.map((x) => x.llm_request_ms ?? -1)),
    dispatch_p50: med(s.map((x) => x.dispatch_ms ?? -1)),
    after_resp_p50: med(s.map((x) => x.ms - (x.llm_response_ms ?? x.ms))),
    calls: s.map((x) => x.llm_calls), busy: s.map((x) => x.busy_at_line), aborted: s.map((x) => x.llm_aborted),
  })
}
botPort.send({ type: 'stop' })
await sleep(3000)
try { player.quit() } catch {}
stub.close()
out?.end(); logFile.end()
setTimeout(() => process.exit(0), 500)
