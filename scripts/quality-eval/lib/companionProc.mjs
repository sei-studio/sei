// scripts/quality-eval/lib/companionProc.mjs: spawn one companion process
// (companion.mjs under Electron-as-node) and talk to it.
//
//   const c = await startCompanion({ sessDir, mode: 'brain' | 'direct', botRepo })
//   c.events          EventEmitter of every @@QE event ({kind, t, ...})
//   c.log             array of all events so far
//   await c.exec(name, args, { timeoutMs })   direct mode: run one action
//   c.execStart(name, args) -> { id, done }   same, without waiting
//   c.abort(id)
//   await c.probe()   live mineflayer view: {pos, hp, held, inv}
//   await c.stop()
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const harnessRepo = path.resolve(here, '..', '..', '..')
const require = createRequire(path.join(harnessRepo, 'package.json'))

export const KEY_FILE = process.env.QE_KEY_FILE || path.join(os.homedir(), '.sei-dev', 'anthropic-test-key')
export const CHARACTER_FILE = process.env.QE_CHARACTER || path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json')
export const PLAYER = process.env.QE_PLAYER || 'Alex'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// QE_CHARACTER_BY_REPO: {repoDir: characterFile}, set by scorecard.mjs
// --char-b so one arm of a compare plays a proposed card. Same username.
function characterFor(botRepo) {
  try {
    const map = JSON.parse(process.env.QE_CHARACTER_BY_REPO || '{}')
    return map[botRepo] || CHARACTER_FILE
  } catch { return CHARACTER_FILE }
}

export function companionName() {
  let row = JSON.parse(fs.readFileSync(CHARACTER_FILE, 'utf8'))
  if (Array.isArray(row)) row = row[0]
  return row.username || 'Sui'
}

export async function startCompanion({ sessDir, mode = 'brain', botRepo = harnessRepo, port = Number(process.env.QE_MC_PORT || 25590), readyTimeoutMs = 120000, tag = 'qe' }) {
  fs.mkdirSync(sessDir, { recursive: true })
  const eventsPath = path.join(sessDir, 'companion.events.jsonl')
  fs.writeFileSync(eventsPath, '')
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
  const electronBin = require('electron')
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LD_PRELOAD: process.env.QE_LD_PRELOAD ?? (fs.existsSync('/usr/lib/x86_64-linux-gnu/libstdc++.so.6') ? '/usr/lib/x86_64-linux-gnu/libstdc++.so.6' : ''),
    QE_CHARACTER: characterFor(botRepo),
    QE_PORT: String(port),
    QE_PLAYER: PLAYER,
    QE_USERDATA: userDataDir,
    QE_RAW_LOG: path.join(sessDir, 'companion.raw.log'),
    QE_EVENTS: eventsPath,
    QE_KEY_FILE: KEY_FILE,
    QE_BOT_REPO: botRepo,
    QE_MODE: mode,
  }
  const proc = spawn(electronBin, [path.join(here, '..', 'companion.mjs')], { cwd: botRepo, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = new EventEmitter()
  events.setMaxListeners(100)
  const log = []
  let ready = false, exited = false, exitCode = null
  proc.stderr.pipe(fs.createWriteStream(path.join(sessDir, 'companion.stderr.log')))
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!ln.startsWith('@@QE ')) continue
      let ev
      try { ev = JSON.parse(ln.slice(5)) } catch { continue }
      log.push(ev)
      if (ev.kind === 'lifecycle' && ev.data?.type === 'summon-ready') ready = true
      events.emit('event', ev)
      events.emit(ev.kind, ev)
    }
  })
  const done = new Promise((r) => proc.on('exit', (code) => { exited = true; exitCode = code; r(code) }))
  const send = (m) => { try { proc.stdin.write(JSON.stringify(m) + '\n') } catch {} }

  const t0 = Date.now()
  while (!ready && !exited && Date.now() - t0 < readyTimeoutMs) await sleep(200)
  let nextId = 1
  const c = {
    events, log, proc, userDataDir, bootMs: Date.now() - t0,
    get ready() { return ready }, get exited() { return exited }, get exitCode() { return exitCode },
    send,
    execStart(name, args = {}) {
      const id = `x${nextId++}`
      const doneP = new Promise((resolve) => {
        const on = (ev) => { if (ev.id === id) { events.off('qe_result', on); resolve(ev) } }
        events.on('qe_result', on)
        done.then(() => resolve({ id, error: 'companion exited' }))
      })
      send({ type: 'qe-exec', id, name, args })
      return { id, done: doneP }
    },
    async exec(name, args = {}, { timeoutMs = 120000 } = {}) {
      const { id, done: d } = c.execStart(name, args)
      const tm = setTimeout(() => send({ type: 'qe-abort', id }), timeoutMs)
      try { return await d } finally { clearTimeout(tm) }
    },
    abort(id) { send({ type: 'qe-abort', id }) },
    probe(timeoutMs = 3000) {
      const id = `p${nextId++}`
      return new Promise((resolve) => {
        const on = (ev) => { if (ev.id === id) { events.off('qe_probe', on); clearTimeout(tm); resolve(ev) } }
        const tm = setTimeout(() => { events.off('qe_probe', on); resolve(null) }, timeoutMs)
        events.on('qe_probe', on)
        send({ type: 'qe-probe', id })
      })
    },
    async stop() {
      if (!exited) {
        send({ type: 'stop' })
        const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 20000)
        await done
        clearTimeout(killer)
      }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
      return exitCode
    },
  }
  if (!ready) { await c.stop().catch(() => {}); try { proc.kill('SIGKILL') } catch {}; throw new Error(`companion never became ready (${mode})`) }
  return c
}
