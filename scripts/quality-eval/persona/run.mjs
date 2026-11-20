// scripts/quality-eval/persona/run.mjs: generation half of the persona eval.
//
// Puts every character through every situation in situations.mjs, N reps,
// through the REAL brain: createOrchestrator + handleDispatch build the cached
// system prefix, the seed blocks (player, memory, heartbeat + frontier,
// conversation, event, snapshot, core, speak reminder, player message) and the
// tool list exactly as a live Minecraft session does. Only three things are
// stubbed: the mineflayer bot (an inert object), the snapshot composer (the
// situation's fixed snapshot) and the provider, which forwards the FIRST model
// call to the real Anthropic API and then stops the loop. What the model said
// (say() lines), did (other tool calls) and wrote privately (scratchpad text)
// on that first call is the sample.
//
// Runs under Electron-as-node because the adapter pulls native modules:
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/quality-eval/persona/run.mjs \
//     --chars ~/suisei/eval/characters --out <dir> [--reps 3] [--only sui,marv]
//     [--situations greeting,tease] [--concurrency 5]
//     [--history <samples.jsonl> [--history-n 3]]
//
// --history replays a longer session before each situation: after the
// greeting, N earlier exchanges of the same character and rep (the player's
// line, if any, and what the character answered) are taken from another run's
// samples.jsonl and put in the transcript as lines already said. Use the SAME
// history file for both arms of a comparison, so the session behind every
// item is identical and only the prompt under test differs. This is what a
// tic in every line looks like after a few minutes, which a single primed
// greeting cannot show.
//
// Without --history every item is the second turn of a session, so the
// own_repeats tic note (a word in 3 of her last 4 turns, ownRepeats.js) can
// never fire: the tic rates are what the opening minutes of a session sound
// like, before anything pulls a tic back. 261103 (pass 39), same dev code:
// Roger's "big brother" was in 86% of items in the default mode and 21% with
// --history-n 3, where the note fired in 7 of 15 situations. A card that puts
// a tic in every opening line is still the problem; this is only how to read
// the number. To try a card change, see card-edits.mjs.
//
// The Anthropic key is read from ~/.sei-dev/anthropic-test-key (or
// ANTHROPIC_API_KEY) and never printed. Output: <out>/samples.jsonl, one row
// per (character, situation, rep), plus <out>/requests/<char>-<situation>.json holding
// one full captured request per character and situation for diagnosis.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigSchema } from '../../../src/bot/config.js'
import { createMinecraftAdapter } from '../../../src/bot/adapter/minecraft/index.js'
import { createOrchestrator } from '../../../src/bot/brain/orchestrator.js'
import { createSessionState } from '../../../src/bot/brain/sessionState.js'
import { createAnthropicProvider } from '../../../src/bot/brain/llm/anthropicProvider.js'
import { loadPlayer, savePlayer, formatPlayerSeedBlock } from '../../../src/bot/brain/memory/player.js'
import { SITUATIONS, PLAYER_NAME } from './situations.mjs'
import { loadCharacters } from './characters.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const CHARS_DIR = arg('chars', path.join(os.homedir(), 'suisei/eval/characters'))
const OUT = arg('out')
const REPS = Number(arg('reps', 3))
const CONC = Number(arg('concurrency', 5))
const ONLY = arg('only')?.split(',')
const SITS = arg('situations')?.split(',')
const MODEL = arg('model', 'claude-haiku-5-5')
const HISTORY = arg('history')
const HISTORY_N = Number(arg('history-n', 3))
if (!OUT) { console.error('--out required'); process.exit(2) }
fs.mkdirSync(path.join(OUT, 'requests'), { recursive: true })

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim()
  return fs.readFileSync(path.join(os.homedir(), '.sei-dev/anthropic-test-key'), 'utf8').trim()
}
const KEY = apiKey()

const MEMORY_MD = `# MEMORY

- [2026-10-05 18:02] ${PLAYER_NAME} is in high school and usually plays after homework.
- [2026-10-08 19:15] We built a small dirt hut by the river together in our last world.
`

const quietLogger = {
  info() {}, debug() {}, trace() {},
  warn: (m) => { if (process.env.PE_VERBOSE) console.error('WARN', m) },
  error: (m) => console.error('ERR', String(m).slice(0, 300)),
}

const textOf = (content) => (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()

/**
 * One brain instance for one (character, situation, rep). `prime` replays a
 * greeting line through a stubbed first dispatch so the session reads as a
 * few minutes in. Returns the sample row.
 */
async function runOne({ ch, sit, rep, primeLine, history = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-eval-'))
  const mem = (f) => path.join(dir, f)
  await savePlayer(mem('PLAYER.md'), {
    exists: true, player_uuid: 'u-alex', player_username: PLAYER_NAME, first_seen: '2026-10-01T10:00:00Z',
    last_seen: '2026-10-10T19:30:00Z', total_sessions: 3, preferred_name: PLAYER_NAME, pronouns: null,
  })
  fs.writeFileSync(mem('MEMORY.md'), MEMORY_MD)
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER_NAME, player_display_name: PLAYER_NAME,
    persona: { name: ch.botName, expanded: ch.expanded, proactiveness: 2, ...(ch.punctuation ? { punctuation: ch.punctuation } : {}) },
    anthropic: { api_key: KEY, model: MODEL },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: ch.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: {},
  })
  const bot = {
    chat() {}, whisper() {}, username: ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20,
  }
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: true })
  const overrides = {
    createSnapshotComposer: () => ({ next: () => sit.snapshot }),
    closeAnySessions: async () => {},
  }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })

  const real = createAnthropicProvider(config)
  let mode = primeLine != null ? 'prime' : 'live'
  let pendingPrime = primeLine
  let calls = 0
  let sample = null
  const endLoop = () => ({
    text: '', toolUses: [{ id: 'stop1', name: 'end_loop', input: {} }],
    content: [{ type: 'tool_use', id: 'stop1', name: 'end_loop', input: {} }], usage: {}, stopReason: 'tool_use',
  })
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (mode === 'prime') {
        // Stand-in for the greeting turn that opened this session: the
        // character's own greeting line from the same rep.
        mode = 'primed'
        const tu = { id: 'prime1', name: 'say', input: { text: pendingPrime } }
        return { text: '', toolUses: [tu], content: [{ type: 'tool_use', ...tu }], usage: {}, stopReason: 'tool_use' }
      }
      if (mode === 'primed') return endLoop()
      calls++
      if (calls > 1) return endLoop()
      const t0 = Date.now()
      const resp = await real.call(req)
      const says = resp.toolUses.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? t.input?.message ?? ''))
      const actions = resp.toolUses.filter((t) => t.name !== 'say').map((t) => ({ name: t.name, input: t.input }))
      sample = {
        says, actions, scratchpad: String(resp.text ?? '').trim(), stopReason: resp.stopReason,
        usage: resp.usage, ms: Date.now() - t0,
      }
      if (!captured.has(`${ch.key}-${sit.id}`)) {
        captured.add(`${ch.key}-${sit.id}`)
        fs.writeFileSync(path.join(OUT, 'requests', `${ch.key}-${sit.id}.json`), JSON.stringify({
          systemBlocks: req.systemBlocks, messages: req.messages, tools: (req.tools ?? []).map((t) => t.name),
        }, null, 1))
      }
      // Hand the orchestrator only the speech so say() is emitted for real and
      // nothing touches the stub world. No say at all: stop the loop cleanly
      // (end_loop is never retried) so the turn ends on the model's choice.
      const sayUses = resp.toolUses.filter((t) => t.name === 'say')
      if (!sayUses.length) return endLoop()
      return {
        text: resp.text, toolUses: sayUses,
        content: (resp.content ?? []).filter((b) => b.type === 'text' || (b.type === 'tool_use' && b.name === 'say')),
        usage: resp.usage, stopReason: 'tool_use',
      }
    },
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot, logger: quietLogger })
  const orch = createOrchestrator({
    adapter, config, logger: quietLogger, sessionState,
    playerStore: { loadPlayer, savePlayer, formatPlayerSeedBlock }, _anthropicOverride: provider,
  })
  if (primeLine != null) {
    await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
    // Earlier exchanges of a longer session (--history). Each is its own
    // stubbed turn, a beat apart: a turn's lines are recorded within a few ms
    // of each other, and two turns are seconds apart in a real session.
    for (const h of history) {
      await new Promise((r) => setTimeout(r, 300))
      if (h.playerLine) orch.recordIncomingChat(PLAYER_NAME, h.playerLine)
      pendingPrime = h.say
      mode = 'prime'
      await orch.handleDispatch('sei:idle', { quietMs: 20000 }, new AbortController().signal)
    }
    if (history.length) await new Promise((r) => setTimeout(r, 300))
    mode = 'live'
  }
  const data = JSON.parse(JSON.stringify(sit.dispatch.data).replaceAll('{NAME}', ch.name))
  let error = null
  try {
    await orch.handleDispatch(sit.dispatch.event, data, new AbortController().signal)
  } catch (err) { error = String(err?.message ?? err) }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  if (!sample) error = error ?? 'no model call captured'
  return {
    char: ch.key, name: ch.name, situation: sit.id, rep, model: MODEL,
    playerLine: sit.dispatch.event === 'player_chat' ? data.text : null,
    event: sit.dispatch.event, primeLine: primeLine ?? null,
    ...(history.length ? { history: history.map((h) => h.say) } : {}), error, ...(sample ?? {}),
  }
}

const captured = new Set()

async function pool(items, n, fn) {
  const out = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      try { out[idx] = await fn(items[idx]) } catch (err) { out[idx] = { error: String(err?.message ?? err), ...items[idx].meta } }
    }
  }
  await Promise.all(Array.from({ length: n }, worker))
  return out
}

const chars = loadCharacters(CHARS_DIR).filter((c) => !ONLY || ONLY.includes(c.key))
const sits = SITUATIONS.filter((s) => !SITS || SITS.includes(s.id) || s.id === 'greeting')
const samplesPath = path.join(OUT, 'samples.jsonl')
const out = fs.createWriteStream(samplesPath, { flags: 'a' })
const write = (row) => {
  out.write(JSON.stringify(row) + '\n')
  const said = row.says?.length ? row.says.join(' | ') : '(silent)'
  const acts = row.actions?.map((a) => a.name).join(',') || '-'
  console.log(`[${row.char}/${row.situation}/${row.rep}] ${row.error ? 'ERROR ' + row.error : said}  {${acts}}`)
}

// Greetings first: every primed situation replays the same rep's greeting.
const greet = sits.find((s) => s.id === 'greeting')
const greetJobs = chars.flatMap((ch) => Array.from({ length: REPS }, (_, rep) => ({ ch, sit: greet, rep, primeLine: null, meta: { char: ch.key, situation: 'greeting', rep } })))
const greetRows = await pool(greetJobs, CONC, runOne)
const greetingLine = new Map()
for (const r of greetRows) {
  write(r)
  greetingLine.set(`${r.char}/${r.rep}`, r.says?.[0] || 'hey')
}
const rest = sits.filter((s) => s.id !== 'greeting' && (!SITS || SITS.includes(s.id)))
// --history: the same character and rep's spoken lines from another run, in
// situation order. Each item gets the N situations that come before it
// (wrapping around), never itself, the greeting or the goodbye.
const historyRows = HISTORY
  ? fs.readFileSync(HISTORY, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.error && r.says?.length)
  : []
const HIST_SITS = SITUATIONS.map((s) => s.id).filter((id) => id !== 'greeting' && id !== 'goodbye')
function historyFor(ch, sit, rep) {
  if (!HISTORY || sit.prime === false) return []
  const i = HIST_SITS.indexOf(sit.id)
  const out = []
  for (let k = 1; k < HIST_SITS.length && out.length < HISTORY_N; k++) {
    const id = HIST_SITS[((i < 0 ? 0 : i) - k + HIST_SITS.length) % HIST_SITS.length]
    if (id === sit.id) continue
    const row = historyRows.find((r) => r.char === ch.key && r.rep === rep && r.situation === id)
    if (row) out.unshift({ playerLine: row.playerLine ?? null, say: row.says.join(' ') })
  }
  return out
}
const jobs = []
for (const sit of rest) for (const ch of chars) for (let rep = 0; rep < REPS; rep++) {
  jobs.push({ ch, sit, rep, primeLine: sit.prime === false ? null : greetingLine.get(`${ch.key}/${rep}`), history: historyFor(ch, sit, rep), meta: { char: ch.key, situation: sit.id, rep } })
}
await pool(jobs, CONC, async (j) => { const r = await runOne(j); write(r); return r })
out.end()
await new Promise((r) => out.on('finish', r))
console.log(`done -> ${samplesPath}`)
process.exit(0)
