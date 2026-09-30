#!/usr/bin/env node
// scripts/dst-headless-harness.mjs: drive the REAL Sei DST mod inside a
// headless Don't Starve Together dedicated server, over the same loopback
// protocol the app uses (native/dst-mod/PROTOCOL.md). No Electron, no LLM.
//
// It plays both Sei processes:
//   - main's watcher: answers the mod's GET /hello on a discovery port and
//     hands it one summon offer;
//   - the bot runtime: createDstLink() from the adapter (the real /obs, /cmd,
//     /event server) plus the real registry (the tools the model calls) and
//     the real snapshot composer (the text the model reads).
//
// Input is line-based on stdin (pipe a scenario file, or a FIFO for live use):
//   tool <name> <json args>     run a registry tool and print its result
//   snap                        print the snapshot the model would read
//   obs                         print the parsed world block and every
//                               non-item entity with a target or activity
//   lua <code>                  send one line of Lua to the server console
//                               (needs --console <fifo>, the server's stdin)
//   wait <ms>                   sleep
//   waitfor <event> [ms]        wait for a mod event kind (default 30 s)
//   events                      print mod events seen since the last call
//   # ...                       comment
//   quit                        despawn and exit
//
// Usage (see native/dst-mod/README.md, "Headless testing"):
//   node scripts/dst-headless-harness.mjs --console ~/dst-run/console.fifo \
//     --prefab wilson --name Sui < scenario.txt

import http from 'node:http'
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { createDstLink } from '../src/bot/adapter/dontstarve/runtime.js'
import { createDefaultRegistry } from '../src/bot/adapter/dontstarve/registry.js'
import { createSnapshotComposer } from '../src/bot/adapter/dontstarve/observers/snapshot.js'
import { createHabitLog } from '../src/bot/adapter/dontstarve/observers/habits.js'

const args = process.argv.slice(2)
const opt = (name, d = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const HELLO_PORT = Number(opt('hello-port', '27424'))
const CONSOLE = opt('console')
const PREFAB = opt('prefab', 'wilson')
const NAME = opt('name', 'Sui')
const NEAR = opt('near', '')

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`
const out = (...a) => console.log(stamp(), ...a)

const dst = { username: NAME, prefab: PREFAB, announce: true, nearUserid: NEAR, nearName: opt('near-name', null), label: 'headless' }
const link = createDstLink({ dst, logger: { info: out, warn: out, error: out } })
// Built after the spawn: the verb set depends on the helper's reported
// version (give needs mod 0.3.0+), exactly as in the app.
let registry = null
const habits = createHabitLog(link.events)
const composer = createSnapshotComposer({ state: link.state, handles: link.handles, dst, getBodyState: () => link.body, getSelfGuid: () => link.guid, getHabits: () => habits.recent() })

const seen = []
let lastResult = null
for (const kind of ['spawned', 'spawnfailed', 'despawned', 'chat', 'attacked', 'death', 'enterdark', 'enterlight', 'actionfailed', 'phase', 'survival', 'moderror']) {
  link.events.on(kind, (ev) => {
    seen.push({ kind, ...ev })
    if (kind !== 'enterlight' && kind !== 'enterdark') out(`EVENT ${kind}`, JSON.stringify(ev).slice(0, 300))
  })
}

await link.listen()
out(`bot link on 127.0.0.1:${link.port}`)

let offered = false
let spawnedInfo = null
link.events.on('spawned', (ev) => { spawnedInfo = ev })
const hello = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  let body = { ok: true, app: 'sei' }
  if (u.pathname === '/hello') {
    if (!offered) {
      offered = true
      let q = {}
      try { q = JSON.parse(u.searchParams.get('q') ?? '{}') } catch {}
      out(`hello from mod ${q.mod ?? '?'} world "${q.world}" day ${q.day} ${q.season} ${q.phase}, players ${JSON.stringify(q.players ?? [])}`)
      body = { ...body, summon: { token: link.token, botPort: link.port, name: NAME, prefab: PREFAB, nearUserid: NEAR, announce: true } }
    }
  }
  const text = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
})
await new Promise((r) => hello.listen(HELLO_PORT, '127.0.0.1', r))
out(`watcher stand-in on 127.0.0.1:${HELLO_PORT}, waiting for the mod's heartbeat`)

function lua(code) {
  if (!CONSOLE) { out('lua: no --console fifo given'); return }
  appendFileSync(CONSOLE, code.replace(/\n/g, ' ') + '\n')
}

async function waitFor(kind, ms = 30_000) {
  const start = seen.length
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (seen.slice(start).some((e) => e.kind === kind)) return true
    if (kind === 'spawned' && spawnedInfo) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function run(line) {
  const s = line.trim()
  if (!s || s.startsWith('#')) { if (s) out(s); return true }
  const [cmd, ...restArr] = s.split(' ')
  const rest = restArr.join(' ')
  switch (cmd) {
    case 'tool': {
      const sp = rest.indexOf(' ')
      const name = sp < 0 ? rest : rest.slice(0, sp)
      const json = sp < 0 ? '{}' : rest.slice(sp + 1)
      let a = {}
      try { a = JSON.parse(json) } catch (err) { out(`bad json for ${name}: ${err.message}`); return true }
      out(`TOOL ${name} ${JSON.stringify(a)}`)
      try {
        lastResult = await registry.execute(name, a, null, { timeoutMs: 120_000 })
      } catch (err) { lastResult = `threw: ${err.message}` }
      out(`RESULT ${name}: ${lastResult}`)
      return true
    }
    case 'snap':
      out(`SNAPSHOT\n${composer.next({ lastActionResult: lastResult })}`)
      return true
    case 'obs': {
      const ents = [...link.state.ents.values()].filter((e) => e.flags.includes('player') || e.name != null || e.target != null || e.activity != null)
      out(`OBS world ${JSON.stringify(link.state.world)}`)
      for (const e of ents) out(`OBS ent ${JSON.stringify(e)}`)
      return true
    }
    case 'lua': lua(rest); out(`LUA ${rest.slice(0, 160)}`); return true
    case 'wait': await new Promise((r) => setTimeout(r, Number(rest) || 1000)); return true
    case 'waitfor': {
      const [kind, ms] = rest.split(' ')
      const ok = await waitFor(kind, Number(ms) || 30_000)
      out(`waitfor ${kind}: ${ok ? 'seen' : 'TIMEOUT'}`)
      return true
    }
    case 'events': {
      out(`events: ${seen.map((e) => e.kind + (e.what ? `:${e.what}` : '')).join(', ')}`)
      seen.length = 0
      return true
    }
    case 'quit': return false
    default: out(`unknown line: ${s}`); return true
  }
}

const ok = await waitFor('spawned', Number(opt('spawn-wait', '120000')))
if (!ok) { out('no spawn: is the server up with the sei mod enabled?'); process.exit(2) }
out(`SPAWNED ${JSON.stringify(spawnedInfo)}`)
registry = createDefaultRegistry({ link })
out(`helper mod ${link.modVersion ?? '< 0.3.0'}; tools: ${registry.list().join(', ')}`)
await waitFor('__never__', 1500) // let the first full /obs frame land

const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!(await run(line))) break
}
out('despawning')
await link.send({ kind: 'despawn' }, { timeoutMs: 3000 })
await new Promise((r) => setTimeout(r, 1500))
await link.close()
hello.close()
process.exit(0)
