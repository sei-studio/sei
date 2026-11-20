// DST quality eval: one companion bot process (scripts/quality-eval/dst/).
//
// The REAL bot entry (src/bot/index.js) with the real brain, booted the way
// the supervisor boots it: a fake parentPort carrying {type:'init', game:
// 'dontstarve', joinTarget} plus a fake MessagePort. The DST runtime posts
// {type:'dst-listen'|'dst-lives'|'dst-offer-cancel'} up the port; this
// process relays every port message to the driver (run.ts) as an `@@QE`
// stdout line, and the driver answers (dst-respawn-offer, stop) on stdin.
//
// Env:
//   QE_BOT_REPO   repo root whose src/bot runs (default: this checkout)
//   QE_CHARACTER  character row JSON (~/suisei/eval/characters/sui.json)
//   QE_JOIN       DstJoinTarget JSON (main's getJoinTarget)
//   QE_USERDATA   userData dir (fresh per rep)
//   QE_RAW_LOG    raw bot log path (optional)
//   QE_KEY_FILE   Anthropic key file (default ~/.sei-dev/anthropic-test-key)
//   QE_PLAYER     host name (default Steve)
//
// The key is read from disk and never printed. The bot sends no analytics
// (main owns PostHog, and main is not running).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(process.env.QE_BOT_REPO || path.resolve(here, '..', '..', '..'))
const keyFile = process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
const apiKey = fs.readFileSync(keyFile, 'utf8').trim()
if (!apiKey) { process.stderr.write('[qe-dst] empty key file\n'); process.exit(2) }

let row = JSON.parse(fs.readFileSync(process.env.QE_CHARACTER, 'utf8'))
if (Array.isArray(row)) row = row[0]
const character = {
  id: row.id,
  name: row.name,
  username: row.username,
  persona: { source: row.persona_source ?? '', expanded: row.persona_expanded ?? row.persona?.expanded ?? '' },
  metadata: row.metadata ?? {},
}
const joinTarget = JSON.parse(process.env.QE_JOIN || '{}')
const player = process.env.QE_PLAYER || 'Steve'
const userDataDir = process.env.QE_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'qe-dst-'))
fs.mkdirSync(path.join(userDataDir, 'memory', character.id), { recursive: true })
const rawLog = process.env.QE_RAW_LOG ? fs.createWriteStream(process.env.QE_RAW_LOG, { flags: 'a' }) : null

const realWrite = process.stdout.write.bind(process.stdout)
function emit(ev) {
  try { realWrite('@@QE ' + JSON.stringify({ t: Date.now(), ...ev }) + '\n') } catch {}
}

// ── log tap (same block format as scripts/quality-eval/companion.mjs) ──
const WANT = new Set(['[chat->]', '[chat<-]', '[haiku!]', '[haiku✗]', '[act!]'])
function parseBlock(s) {
  const lines = s.split('\n')
  const m = /^\[[\d:.]+\] (\[[^\]]+\]) begin$/.exec(lines[0] || '')
  if (!m || !WANT.has(m[1])) return null
  const fields = {}
  let cur = null
  for (const ln of lines.slice(1, -1)) {
    const fm = /^ {2}([a-z_]+): ?(.*)$/.exec(ln)
    if (fm) { cur = fm[1]; fields[cur] = fm[2]; continue }
    if (cur) fields[cur] += (fields[cur] ? '\n' : '') + ln.replace(/^ {4}/, '')
  }
  return { tag: m[1], fields }
}
function parseCalls(body) {
  if (!body || body === '(none)') return []
  const out = []
  for (const ln of body.split('\n')) {
    const m = /^([A-Za-z_][\w]*)\((.*)\)$/s.exec(ln.trim())
    if (!m) continue
    let input = null
    try { input = JSON.parse(m[2]) } catch { input = m[2] }
    out.push({ name: m[1], input })
  }
  return out
}
function onLogString(s) {
  rawLog?.write(s + '\n')
  if (!s.includes('] begin')) return
  const b = parseBlock(s)
  if (!b) return
  const f = b.fields
  switch (b.tag) {
    case '[chat->]': emit({ kind: 'chat_out', text: f.text ?? '' }); break
    case '[chat<-]': emit({ kind: 'chat_in', from: f.from ?? f.username ?? '', text: f.text ?? f.message ?? '' }); break
    case '[haiku!]': {
      let usage = null
      try { usage = JSON.parse(f.usage) } catch {}
      emit({ kind: 'llm_turn', stop: f.stop ?? '', scratchpad: f.text === '(empty)' ? '' : (f.text ?? ''), calls: parseCalls(f.calls), usage })
      break
    }
    case '[haiku✗]': emit({ kind: 'llm_error', error: f.error ?? '' }); break
    case '[act!]': emit({ kind: 'action_result', action: f.action ?? '', result: (f.result ?? '').slice(0, 400) }); break
  }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    let s
    try { s = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.stack : JSON.stringify(a)))).join(' ') } catch { s = String(args[0]) }
    try { onLogString(s) } catch {}
  }
}

// ── fake supervisor port ──
class FakePort extends EventEmitter {
  start() {}
  close() {}
  postMessage(data) {
    if (!data || typeof data !== 'object') return
    switch (data.type) {
      case 'action': emit(data.name ? { kind: 'action_call', name: data.name, args: data.args ?? null } : { kind: 'action_idle' }); break
      case 'boot-timing': case 'dashboard': case 'request-jwt': case 'vision-capability': case 'action-stats': case 'session-digest': break
      default: emit({ kind: 'port', data })
    }
  }
  send(data) { this.emit('message', { data }) }
}
const botPort = new FakePort()
const parentPort = new EventEmitter()
process.parentPort = parentPort

let stopping = false
function requestStop() {
  if (stopping) { process.exit(0); return }
  stopping = true
  botPort.send({ type: 'stop' })
  setTimeout(() => { rawLog?.end(); process.exit(0) }, 8000).unref()
}
process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!ln) continue
    try {
      const msg = JSON.parse(ln)
      if (msg.type === 'stop') requestStop()
      else botPort.send(msg)
    } catch {}
  }
})
process.stdin.on('error', () => {})

emit({ kind: 'companion_boot', character: character.name, repo, userDataDir })
await import(pathToFileURL(path.join(repo, 'src', 'bot', 'index.js')).href)
parentPort.emit('message', {
  data: {
    type: 'init',
    character,
    apiKey,
    game: 'dontstarve',
    joinTarget,
    worldLabel: joinTarget.label || 'SeiTest',
    userDataDir,
    mc_username: player,
    preferred_name: player,
    visionMode: 'off',
    realisticTyping: false,
    chatLanguage: 'en',
    companions: [],
    continuity: null,
    knowledge: '',
    readyBudgetMs: 60000,
  },
  ports: [botPort],
})
