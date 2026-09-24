#!/usr/bin/env node
// Smoke test for the sei-mac-input helper (native/mac-input). Spawns the built
// binary, drives every query over the JSON-lines protocol and prints what came
// back. Used by the macOS CI job and by hand on a Mac:
//
//   node scripts/smoke-mac-input.mjs [path/to/sei-mac-input] [--act]
//
// Queries must answer. Injection is only exercised with --act (it moves the
// real cursor): a CI runner has no Accessibility grant, so posted events are
// dropped silently there and the check would say nothing. Screenshots are
// reported, not required, for the same reason (no Screen Recording grant).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const act = args.includes('--act')
const bin = args.find((a) => !a.startsWith('--')) ?? 'resources/mac-input/sei-mac-input'
if (!existsSync(bin)) {
  console.error(`missing helper binary: ${bin}`)
  process.exit(1)
}

const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.stderr.write(`[helper] ${d}`))
let buf = ''
const pending = new Map()
let ready
const readyP = new Promise((r) => (ready = r))
child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.event === 'ready') ready(msg)
    else if (msg.event) console.log('event', msg)
    else pending.get(msg.id)?.(msg)
  }
})
let nextId = 1
function req(cmd, extra = {}, timeoutMs = 8000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${cmd} timed out`)), timeoutMs)
    pending.set(id, (m) => {
      clearTimeout(t)
      pending.delete(id)
      resolve(m)
    })
    child.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n')
  })
}

let failed = false
function check(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!cond) failed = true
}

const r = await Promise.race([readyP, new Promise((_, j) => setTimeout(() => j(new Error('no ready event')), 5000))])
check('ready', r.version, JSON.stringify(r))

const ping = await req('ping')
check('ping', ping.ok, JSON.stringify(ping))

const displays = await req('displays')
check('displays', displays.ok && displays.displays.length > 0, JSON.stringify(displays.displays))

const front = await req('frontmost')
check('frontmost', front.ok, JSON.stringify(front))

const wins = await req('windows')
check('windows', wins.ok && Array.isArray(wins.windows), `${wins.windows?.length} windows`)
if (wins.windows?.length) {
  const w0 = wins.windows[0]
  const one = await req('window', { windowId: w0.id })
  check('window by id', one.ok && one.window?.id === w0.id, JSON.stringify(one.window))
}

const keys = await req('keys')
check('keys', keys.ok && keys.keys.includes('return') && keys.keys.includes('a'), `${keys.keys?.length} keys`)

const cur = await req('cursor')
check('cursor', cur.ok && Number.isFinite(cur.x), JSON.stringify(cur))

const bad = await req('click', { x: 'nope' })
check('bad action rejected', bad.ok === false, bad.error)

const unknown = await req('frobnicate')
check('unknown command rejected', unknown.ok === false, unknown.error)

const wait = req('wait', { ms: 3000 })
await new Promise((r) => setTimeout(r, 100))
const t0 = Date.now()
const cancel = await req('cancel')
const waited = await wait
check('cancel interrupts a wait', cancel.ok && Date.now() - t0 < 1000, `wait reply ${JSON.stringify(waited)} after ${Date.now() - t0} ms`)

const rel = await req('release_all')
check('release_all', rel.ok)

const d0 = displays.displays?.[0]
if (d0) {
  const shot = await req(
    'screenshot',
    { displayId: d0.id, width: Math.round(d0.bounds.w / 2), height: Math.round(d0.bounds.h / 2), quality: 0.7 },
    15000,
  )
  console.log(
    `info screenshot: ${shot.ok ? `${shot.width}x${shot.height} ${shot.data.length} b64 chars rect=${JSON.stringify(shot.rect)} timing=${JSON.stringify(shot.timing)}` : shot.error}`,
  )
}

if (act) {
  const target = { x: (d0?.bounds.x ?? 0) + 200, y: (d0?.bounds.y ?? 0) + 200 }
  const mv = await req('move', target)
  const after = await req('cursor')
  check('move moved the cursor', mv.ok && Math.abs(after.x - target.x) < 2 && Math.abs(after.y - target.y) < 2, JSON.stringify(after))
}

child.stdin.end()
const code = await new Promise((r) => child.on('exit', r))
check('exits on stdin EOF', code === 0, `code ${code}`)
process.exit(failed ? 1 : 0)
