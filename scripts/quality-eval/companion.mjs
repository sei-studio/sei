// scripts/quality-eval/companion.mjs: runs the REAL Sei companion bot
// (src/bot/index.js, same code path as the app) against the eval server.
//
// Run under Electron-as-node so the render natives match their ABI:
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/companion.mjs
//
// The app forks the bot as an Electron utilityProcess and hands it a
// MessagePort carrying {type:'init', ...}. Here a fake parentPort + port stand
// in for the supervisor, so the bot boots exactly as it does in the app.
//
// Env:
//   QE_KEY_FILE     Anthropic key file (default ~/.sei-dev/anthropic-test-key)
//   QE_CHARACTER    character row JSON (id, name, username, persona_expanded, metadata)
//   QE_PORT         server port (25590)
//   QE_PLAYER       the human player's MC username
//   QE_USERDATA     fresh userData dir for this session (memory lands here)
//   QE_RAW_LOG      raw bot log file (every console line)
//   QE_EVENTS       structured JSONL events file
//   QE_BOT_REPO     repo whose src/bot runs (default: this one). The paired
//                   comparison points it at a worktree of another ref, so the
//                   harness stays fixed while the bot code varies.
//   QE_LLM_PROVIDER optional companion LLM other than the default Anthropic
//                   BYOK path, e.g. 'chatgpt' (the ChatGPT-plan Responses
//                   provider; a platform OpenAI key stands in for the plan
//                   token) or 'openai'. Shipped as the init `llm` section,
//                   exactly like main does. Needs QE_LLM_KEY_ENV.
//   QE_LLM_MODEL    that provider's model (e.g. gpt-6-luna)
//   QE_LLM_EFFORT   reasoning effort (chatgpt only; the app sends 'low' when
//                   the account catalog lists it)
//   QE_LLM_KEY_ENV  NAME of the env var holding that provider's key (the key
//                   itself never goes on a command line or into a file)
//   QE_MODE         'brain' (default): the full app path, Haiku decides.
//                   'direct': the same runtime and adapter with a stub brain;
//                   the orchestrator calls actions itself over stdin
//                   ({"type":"qe-exec",id,name,args} / {"type":"qe-abort",id}),
//                   so a benchmark can tell skill failures from brain ones.
//
// Structured events are also written to stdout as `@@QE <json>` lines so the
// orchestrator sees them live. SIGTERM / SIGINT sends the bot {type:'stop'},
// which flushes its final action-stats snapshot and exits.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseSnapshot, parseSensed, makeSnapshotGate } from './snapshot.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(process.env.QE_BOT_REPO || path.resolve(here, '..', '..'))
const MODE = process.env.QE_MODE === 'direct' ? 'direct' : 'brain'

const keyFile = process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
const apiKey = fs.readFileSync(keyFile, 'utf8').trim()
if (!apiKey) { console.error('[qe-companion] empty key file'); process.exit(2) }

// Optional non-Anthropic companion LLM (see the header).
const llmProvider = process.env.QE_LLM_PROVIDER || ''
let llmInit
if (llmProvider) {
  const keyEnv = process.env.QE_LLM_KEY_ENV || ''
  const llmKey = keyEnv ? (process.env[keyEnv] || '').trim() : ''
  if (!llmKey) { console.error(`[qe-companion] QE_LLM_PROVIDER=${llmProvider} needs QE_LLM_KEY_ENV naming a set env var`); process.exit(2) }
  llmInit = {
    provider: llmProvider,
    api_key: llmKey,
    ...(process.env.QE_LLM_MODEL ? { model: process.env.QE_LLM_MODEL } : {}),
    ...(process.env.QE_LLM_EFFORT ? { reasoning_effort: process.env.QE_LLM_EFFORT } : {}),
    ...(llmProvider === 'chatgpt' ? { vision: true } : {}),
  }
}
const companionModel = llmProvider ? `${llmProvider}:${process.env.QE_LLM_MODEL || 'default'}${process.env.QE_LLM_EFFORT ? `@${process.env.QE_LLM_EFFORT}` : ''}` : 'claude-haiku-5-5'

const charFile = process.env.QE_CHARACTER
if (!charFile) { console.error('[qe-companion] QE_CHARACTER is required'); process.exit(2) }
let row = JSON.parse(fs.readFileSync(charFile, 'utf8'))
if (Array.isArray(row)) row = row[0]
const character = {
  id: row.id,
  name: row.name,
  username: row.username,
  persona: { source: row.persona_source ?? '', expanded: row.persona_expanded ?? row.persona?.expanded ?? '' },
  metadata: row.metadata ?? {},
}

const port = Number(process.env.QE_PORT || 25590)
const player = process.env.QE_PLAYER || 'Alex'
const userDataDir = process.env.QE_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'qe-userdata-'))
// The app's characterStore creates memory/<id> when the character is saved;
// the bot assumes it exists.
fs.mkdirSync(path.join(userDataDir, 'memory', character.id), { recursive: true })

const rawLog = process.env.QE_RAW_LOG ? fs.createWriteStream(process.env.QE_RAW_LOG, { flags: 'a' }) : null
const eventsOut = process.env.QE_EVENTS ? fs.createWriteStream(process.env.QE_EVENTS, { flags: 'a' }) : null

function emit(ev) {
  const line = JSON.stringify({ t: Date.now(), ...ev })
  eventsOut?.write(line + '\n')
  try { process.stdout.write('@@QE ' + line + '\n') } catch {}
}

// ── log tap ─────────────────────────────────────────────────────────────
// Every bot log event is ONE console.log call (src/bot/brain/log.js
// emitBlock): "[ts] [tag] begin\n  label: body...\n[ts] [tag] end". Parse the
// tags the eval needs into structured events; keep everything in the raw log.
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

// Ground truth for the judge: a compact slice of the bot's own snapshot at
// each LLM turn (snapshot.mjs), rate limited.
const snapGate = makeSnapshotGate()
// 261014: the gated snapshot can be 20s old when she speaks, so the judge
// marked counts that matched her prompt as wrong. Each llm_turn carries what
// that turn's prompt showed.
let lastSensed = null
function grabSnapshot(s) {
  try { lastSensed = parseSensed(s) } catch { lastSensed = null }
  const snap = parseSnapshot(s)
  if (snap && snapGate(Date.now(), snap)) emit({ kind: 'snapshot', ...snap })
}

function onLogString(s) {
  rawLog?.write(s + '\n')
  if (!s.includes('] begin')) return
  if (s.includes('[haiku?] begin')) { try { grabSnapshot(s) } catch {} return }
  const b = parseBlock(s)
  if (!b) return
  const f = b.fields
  switch (b.tag) {
    case '[chat->]': emit({ kind: 'chat_out', text: f.text ?? '' }); break
    case '[chat<-]': emit({ kind: 'chat_in', from: f.from ?? f.username ?? '', text: f.text ?? f.message ?? '' }); break
    case '[haiku!]': {
      let usage = null
      try { usage = JSON.parse(f.usage) } catch {}
      emit({
        kind: 'llm_turn',
        stop: f.stop ?? '',
        elapsed_ms: f.elapsed ? parseInt(f.elapsed, 10) : null,
        scratchpad: f.text === '(empty)' ? '' : (f.text ?? ''),
        calls: parseCalls(f.calls),
        usage,
        ...(lastSensed ? { sensed: lastSensed } : {}),
      })
      break
    }
    case '[haiku✗]': emit({ kind: 'llm_error', error: f.error ?? '' }); break
    case '[act!]': emit({ kind: 'action_result', action: f.action ?? '', result: f.result ?? '' }); break
  }
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => {
    let s
    try { s = args.map(a => (typeof a === 'string' ? a : (a instanceof Error ? a.stack : JSON.stringify(a)))).join(' ') } catch { s = String(args[0]) }
    try { onLogString(s) } catch {}
    if (process.env.QE_ECHO === '1') orig(...args)
  }
}

// ── fake supervisor ─────────────────────────────────────────────────────
class FakePort extends EventEmitter {
  start() {}
  close() {}
  // bot -> main
  postMessage(data) {
    if (!data || typeof data !== 'object') return
    switch (data.type) {
      // name null = the orchestrator drained back to idle, not a call.
      case 'action': emit(data.name ? { kind: 'action_call', name: data.name, args: data.args ?? null } : { kind: 'action_idle' }); break
      case 'action-stats': emit({ kind: 'action_stats', stats: data.stats }); break
      case 'boot-timing': case 'dashboard': case 'request-jwt': case 'vision-capability': break
      default: emit({ kind: 'lifecycle', data })
    }
  }
  // main -> bot
  send(data) { this.emit('message', { data }) }
}

const botPort = new FakePort()
const parentPort = new EventEmitter()
process.parentPort = parentPort

let stopping = false
let directQuit = null
function requestStop(sig) {
  if (directQuit) { directQuit(); return }
  if (stopping) { process.exit(0); return }
  stopping = true
  emit({ kind: 'stop_requested', signal: sig })
  botPort.send({ type: 'stop' })
  // gracefulShutdown exits on its own; this is the backstop.
  setTimeout(() => { rawLog?.end(); eventsOut?.end(); process.exit(0) }, 8000).unref()
}
process.on('SIGTERM', () => requestStop('SIGTERM'))
process.on('SIGINT', () => requestStop('SIGINT'))
// Orchestrator may also send a line on stdin: {"type":"game-mode",...} etc.
process.stdin.setEncoding('utf8')
let stdinBuf = ''
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk
  let i
  while ((i = stdinBuf.indexOf('\n')) >= 0) {
    const ln = stdinBuf.slice(0, i).trim(); stdinBuf = stdinBuf.slice(i + 1)
    if (!ln) continue
    try {
      const msg = JSON.parse(ln)
      if (msg.type === 'stop') requestStop('stdin')
      else if (msg.type === 'qe-exec') qeExec(msg)
      else if (msg.type === 'qe-abort') qeRunning.get(msg.id)?.abort()
      else if (msg.type === 'qe-probe') qeProbe(msg)
      else botPort.send(msg)
    } catch {}
  }
})
process.stdin.on('error', () => {})

// ── mineflayer capture ─────────────────────────────────────────────────
// The bot's connect.js imports createBot from the CJS mineflayer package; ESM
// imports of CJS reuse the require cache, so wrapping createBot here (before
// the bot code loads) hands the eval the live mineflayer instance for probes
// without touching bot code.
let mcBot = null
try {
  const botRequire = createRequire(path.join(repo, 'package.json'))
  const mineflayer = botRequire('mineflayer')
  const orig = mineflayer.createBot
  mineflayer.createBot = (...a) => { mcBot = orig(...a); return mcBot }
} catch (e) { emit({ kind: 'qe_warn', text: `mineflayer capture failed: ${e?.message}` }) }

function qeProbe(msg) {
  const b = mcBot
  const inv = {}
  try { for (const it of b?.inventory?.items?.() ?? []) inv[it.name] = (inv[it.name] || 0) + it.count } catch {}
  const p = b?.entity?.position
  emit({ kind: 'qe_probe', id: msg.id ?? null, pos: p ? { x: p.x, y: p.y, z: p.z } : null, hp: b?.health ?? null, food: b?.food ?? null, oxy: b?.oxygenLevel ?? null, yaw: b?.entity?.yaw ?? null, held: b?.heldItem?.name ?? null, inv })
}

// ── direct mode: actions called by the orchestrator ────────────────────
let directAdapter = null
let qeComposer = null
const qeRunning = new Map()
async function qeExec(msg) {
  const id = msg.id
  if (!directAdapter) { emit({ kind: 'qe_result', id, error: 'no adapter (brain mode or not connected)' }); return }
  const ac = new AbortController()
  qeRunning.set(id, ac)
  const t0 = Date.now()
  emit({ kind: 'action_call', name: msg.name, args: msg.args ?? {} })
  let result = null, error = null
  let shown = null
  if (msg.snap) {
    try {
      qeComposer ??= directAdapter.createSnapshotComposer?.() ?? null
      const snap = qeComposer?.next?.() ?? ''
      shown = String(snap).split('\n').find((l) => l.startsWith('facing:')) ?? null
    } catch (e) { shown = `snapshot failed: ${e?.message}` }
  }
  try {
    result = await directAdapter.executeAction(msg.name, msg.args ?? {}, { signal: ac.signal })
  } catch (e) { error = String(e?.message || e) }
  qeRunning.delete(id)
  const text = error ? `error: ${error}` : (typeof result === 'string' ? result : JSON.stringify(result))
  emit({ kind: 'action_result', action: msg.name, result: String(text).slice(0, 600) })
  emit({ kind: 'qe_result', id, result: String(text).slice(0, 600), error, aborted: ac.signal.aborted, ms: Date.now() - t0, ...(shown ? { shown } : {}) })
}

async function startDirect() {
  const { ConfigSchema } = await import(pathToFileURL(path.join(repo, 'src', 'bot', 'config.js')).href)
  const runtime = await import(pathToFileURL(path.join(repo, 'src', 'bot', 'adapter', 'minecraft', 'runtime.js')).href)
  const username = runtime.botUsernameFor(character)
  const memDir = path.join(userDataDir, 'memory', character.id)
  const config = ConfigSchema.parse({
    chat_mode: 'chat',
    player_username: player,
    player_display_name: player,
    world_label: 'Sei Quality Eval',
    persona: { name: username, expanded: character.persona.expanded || 'eval', proactiveness: 2 },
    anthropic: { api_key: apiKey },
    adapter: { kind: 'minecraft', minecraft: runtime.adapterConfigFrom({ joinTarget: { port, mc_username: player }, botUsername: username, character }) },
    memory: {
      player_md_path: `${memDir}/PLAYER.md`, memory_md_path: `${memDir}/MEMORY.md`,
      heartbeat_md_path: `${memDir}/HEARTBEAT.md`, worlds_json_path: `${memDir}/worlds.json`,
    },
    vision: { mode: 'off' },
  })
  const logger = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m), debug: () => {} }
  const stubBrain = { stop: async () => {}, setCompanions: () => {} }
  const handle = await runtime.createRuntime(config, {
    logger,
    createBrain: async (adapter) => { directAdapter = adapter; return stubBrain },
    onBrainReady: () => {},
    onBrainLost: () => { directAdapter = null },
    onConnected: () => emit({ kind: 'lifecycle', data: { type: 'summon-ready' } }),
    onDisconnected: (info) => emit({ kind: 'lifecycle', data: { type: 'disconnected', reason: info?.reason ?? null } }),
    onError: (info) => emit({ kind: 'lifecycle', data: { type: 'error', error: info?.error, message: info?.message } }),
    onDashboard: null,
    emitVisionCapability: () => {},
  })
  // A stop on stdin tears the body down (no brain to drain).
  directStop = async () => { try { await handle?.stop?.() } catch {} }
}
let directStop = null

emit({ kind: 'companion_boot', character: character.name, username: character.username, model: MODE === 'direct' ? 'none (direct actions)' : companionModel, mode: MODE, userDataDir })

if (MODE === 'direct') {
  process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT')
  const quit = async () => { emit({ kind: 'stop_requested', signal: 'direct' }); for (const ac of qeRunning.values()) ac.abort(); await directStop?.(); rawLog?.end(); eventsOut?.end(); setTimeout(() => process.exit(0), 200) }
  process.on('SIGTERM', quit); process.on('SIGINT', quit)
  directQuit = quit
  await startDirect()
} else {
await import(pathToFileURL(path.join(repo, 'src', 'bot', 'index.js')).href)

// Same field set the supervisor ships (src/main/botSupervisor.ts, type:'init'),
// BYOK path with the dev test key. App defaults: vision on-demand, realistic
// typing on, English.
parentPort.emit('message', {
  data: {
    type: 'init',
    character,
    apiKey,
    game: 'minecraft',
    joinTarget: { port, motd: 'Sei Quality Eval', mc_username: player, skinServerBaseUrl: null },
    worldLabel: 'Sei Quality Eval',
    userDataDir,
    mc_username: player,
    preferred_name: player,
    visionMode: 'on-demand',
    realisticTyping: true,
    chatLanguage: 'en',
    companions: [],
    continuity: null,
    knowledge: '',
    readyBudgetMs: 120000,
    ...(llmInit ? { llm: llmInit } : {}),
  },
  ports: [botPort],
})
}
