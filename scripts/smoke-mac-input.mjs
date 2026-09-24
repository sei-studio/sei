#!/usr/bin/env node
// Smoke test for the sei-mac-input helper (native/mac-input). Spawns the built
// binary, drives every query over the JSON-lines protocol and prints what came
// back. Used by the macOS CI job and by hand on a Mac:
//
//   node scripts/smoke-mac-input.mjs [path/to/sei-mac-input] [--act] [--e2e]
//
// --e2e (CI only, it drives TextEdit): opens a new TextEdit document, clicks
// into it, types a line, and checks the text arrived through the AX tree and
// through OCR. Never run it on a machine someone is using.
//
// Queries must answer. Injection is only exercised with --act (it moves the
// real cursor): a CI runner has no Accessibility grant, so posted events are
// dropped silently there and the check would say nothing. Screenshots are
// reported, not required, for the same reason (no Screen Recording grant).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const act = args.includes('--act')
const e2e = args.includes('--e2e')
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

const focused = await req('ax_focused')
check('ax_focused answers', focused.ok, JSON.stringify(focused.element))

if (front.pid) {
  const ax = await req('ax_dump', { pid: front.pid, maxNodes: 50 }, 8000)
  check('ax_dump answers', ax.ok && Array.isArray(ax.nodes), `${ax.nodes?.length} nodes in ${ax.ms} ms (0 without the Accessibility grant)`)
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
    { displayId: d0.id, width: Math.round(d0.bounds.w / 2), height: Math.round(d0.bounds.h / 2), quality: 0.7, thumb: true, ocr: true },
    15000,
  )
  console.log(
    `info screenshot: ${shot.ok ? `${shot.width}x${shot.height} ${shot.data.length} b64 chars rect=${JSON.stringify(shot.rect)} timing=${JSON.stringify(shot.timing)} thumb=${shot.thumb?.length} ocr=${shot.ocr?.length} boxes` : shot.error}`,
  )
}

if (act) {
  const target = { x: (d0?.bounds.x ?? 0) + 200, y: (d0?.bounds.y ?? 0) + 200 }
  const mv = await req('move', target)
  const after = await req('cursor')
  check('move moved the cursor', mv.ok && Math.abs(after.x - target.x) < 2 && Math.abs(after.y - target.y) < 2, JSON.stringify(after))
}

if (e2e) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const osa = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()
  osa('tell application "TextEdit" to activate')
  await sleep(1500)
  osa('tell application "TextEdit" to make new document')
  osa('tell application "TextEdit" to activate')
  await sleep(1500)
  const ws = (await req('windows')).windows ?? []
  const te = ws.find((w) => w.owner === 'TextEdit' && w.bounds.w > 200 && w.bounds.h > 150)
  check('e2e: TextEdit window found', !!te, JSON.stringify(te))
  if (te) {
    const c = { x: te.bounds.x + te.bounds.w / 2, y: te.bounds.y + te.bounds.h / 2 }
    const t0 = Date.now()
    const click = await req('click', { ...c, button: 'left', count: 1 })
    const tClick = Date.now() - t0
    const text = 'sei act smoke 4217'
    const t1 = Date.now()
    const typed = await req('type', { text }, 15000)
    const tType = Date.now() - t1
    check('e2e: click + type replied', click.ok && typed.ok, `click ${tClick} ms, type ${tType} ms`)
    await sleep(500)
    const fr = await req('frontmost')
    check('e2e: TextEdit is frontmost', fr.name === 'TextEdit', JSON.stringify(fr))
    const t2 = Date.now()
    const ax = await req('ax_dump', { pid: te.pid, maxNodes: 400 }, 8000)
    const tAx = Date.now() - t2
    const hit = (ax.nodes ?? []).find((n) => typeof n.value === 'string' && n.value.includes(text))
    check('e2e: typed text visible in the AX tree', !!hit, `${ax.nodes?.length} nodes in ${tAx} ms; ${hit ? hit.role : 'no match'}`)
    const foc = await req('ax_focused')
    check('e2e: focused element is the text area', foc.element?.role === 'AXTextArea', JSON.stringify({ role: foc.element?.role, pid: foc.element?.pid }))
    const t3 = Date.now()
    const shot = await req('screenshot', { rect: te.bounds, width: Math.round(te.bounds.w), height: Math.round(te.bounds.h), thumb: true, ocr: true }, 15000)
    const ocrHit = (shot.ocr ?? []).find((b) => /smoke/i.test(b.text))
    check('e2e: typed text found by OCR', !!ocrHit, `${shot.ocr?.length} boxes in ${Date.now() - t3} ms timing=${JSON.stringify(shot.timing)} ${ocrHit ? JSON.stringify(ocrHit) : ''}`)
    if (ocrHit) {
      const inside = ocrHit.x >= te.bounds.x - 2 && ocrHit.y >= te.bounds.y - 2 && ocrHit.x + ocrHit.w <= te.bounds.x + te.bounds.w + 2
      check('e2e: OCR box is in global points inside the window', inside, JSON.stringify(te.bounds))
    }
    const k = await req('key', { key: 'a', modifiers: ['cmd'] })
    const del = await req('key', { key: 'delete', modifiers: [] })
    check('e2e: key combo replied', k.ok && del.ok)
  }
  try {
    osa('tell application "TextEdit" to close every document saving no')
    osa('tell application "TextEdit" to quit')
  } catch {}
}

child.stdin.end()
const code = await new Promise((r) => child.on('exit', r))
check('exits on stdin EOF', code === 0, `code ${code}`)
process.exit(failed ? 1 : 0)
