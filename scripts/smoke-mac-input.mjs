#!/usr/bin/env node
// Smoke test for the sei-mac-input helper (native/mac-input). Spawns the built
// binary, drives every query over the JSON-lines protocol and prints what came
// back. Used by the macOS CI job and by hand on a Mac:
//
//   node scripts/smoke-mac-input.mjs [path/to/sei-mac-input] [--act] [--e2e] [--abort]
//
// --e2e (CI only, it drives TextEdit): opens a new TextEdit document, clicks
// into it, types a line, and checks the text arrived through the AX tree and
// through OCR. Never run it on a machine someone is using.
//
// --abort (CI only, it types into TextEdit): the player-takes-over check.
// Arms the watcher, checks that our own click and a long type do NOT trip it
// (every event we post is tagged), then starts a long type and a hold and
// injects one UNTAGGED key or mouse event through the helper's test-only
// test_user_event command (SEI_MAC_INPUT_TEST=1, set here and never by Sei).
// The action must end as cancelled by user input within ABORT_MAX_MS on the
// helper's own clock, and a user_input event must arrive.
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
const abortCheck = args.includes('--abort')
const ABORT_MAX_MS = 100
const bin = args.find((a) => !a.startsWith('--')) ?? 'resources/mac-input/sei-mac-input'
if (!existsSync(bin)) {
  console.error(`missing helper binary: ${bin}`)
  process.exit(1)
}

const child = spawn(bin, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: abortCheck ? { ...process.env, SEI_MAC_INPUT_TEST: '1' } : process.env,
})
const userInputs = []
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
    else if (msg.event === 'user_input') {
      userInputs.push({ ...msg, recvAt: Date.now() })
      console.log('event', msg)
    } else if (msg.event) console.log('event', msg)
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

if (!abortCheck) {
  const gated = await req('test_user_event', { kind: 'key' })
  check('test_user_event needs SEI_MAC_INPUT_TEST', gated.ok === false, gated.error)
}

const tooLong = await req('type', { text: 'x'.repeat(201) })
check('type over 200 characters rejected', tooLong.ok === false && /too long/.test(tooLong.error), tooLong.error)

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
  const safe = async (name, fn) => {
    try {
      return await fn()
    } catch (e) {
      check(name, false, String(e?.message ?? e).slice(0, 300))
      return undefined
    }
  }
  // What is on screen before we start (diagnosis on a headless runner).
  const d = (await req('displays')).displays?.[0]
  if (d) {
    const full = await req('screenshot', { displayId: d.id, width: d.bounds.w, height: d.bounds.h, ocr: true, ocrAccurate: true }, 20000)
    console.log(`info screen text before e2e: ${JSON.stringify((full.ocr ?? []).map((b) => b.text).slice(0, 40))}`)
  }
  // LaunchServices only: osascript needs an Automation grant and times out on a runner.
  const doc = '/tmp/sei-act-smoke.txt'
  execFileSync('bash', ['-c', `printf '' > ${doc}; open -a TextEdit ${doc}`])
  await sleep(3000)
  const ws = (await req('windows')).windows ?? []
  const te = ws.find((w) => w.owner === 'TextEdit' && w.bounds.w > 200 && w.bounds.h > 150)
  check('e2e: TextEdit window found', !!te, JSON.stringify(te ?? ws.map((w) => w.owner)))
  console.log(`info frontmost after open: ${JSON.stringify(await req('frontmost'))}`)
  if (te) {
    const c = { x: Math.round(te.bounds.x + te.bounds.w / 2), y: Math.round(te.bounds.y + te.bounds.h / 2) }
    const t0 = Date.now()
    const click = await req('click', { ...c, button: 'left', count: 1 })
    const tClick = Date.now() - t0
    const cur = await req('cursor')
    check('e2e: click moved the cursor', Math.abs(cur.x - c.x) < 2 && Math.abs(cur.y - c.y) < 2, `${JSON.stringify(cur)} want ${JSON.stringify(c)}`)
    const text = 'sei act smoke 4217'
    const t1 = Date.now()
    const typed = await req('type', { text }, 15000)
    const tType = Date.now() - t1
    check('e2e: click + type replied', click.ok && typed.ok, `click ${tClick} ms, type ${tType} ms`)
    await sleep(700)
    console.log(`info frontmost after click: ${JSON.stringify(await req('frontmost'))}`)
    const t2 = Date.now()
    const ax = await safe('e2e: ax_dump', () => req('ax_dump', { pid: te.pid, maxNodes: 400 }, 8000))
    const tAx = Date.now() - t2
    const hit = (ax?.nodes ?? []).find((n) => typeof n.value === 'string' && n.value.toLowerCase().includes(text)) // TextEdit auto-capitalizes
    check('e2e: ax_dump reads TextEdit', (ax?.nodes?.length ?? 0) > 0, `${ax?.nodes?.length} nodes in ${tAx} ms; roles ${JSON.stringify([...new Set((ax?.nodes ?? []).map((n) => n.role))].slice(0, 12))}`)
    check('e2e: typed text visible in the AX tree', !!hit, hit ? hit.role : 'no match')
    const foc = await req('ax_focused')
    check('e2e: focused element is the text area', foc.element?.role === 'AXTextArea', JSON.stringify({ role: foc.element?.role, pid: foc.element?.pid }))
    const t3 = Date.now()
    const shot = await req('screenshot', { rect: te.bounds, width: Math.round(te.bounds.w), height: Math.round(te.bounds.h), thumb: true, ocr: true, ocrAccurate: true }, 15000)
    const ocrHit = (shot.ocr ?? []).find((b) => /smoke/i.test(b.text))
    check('e2e: typed text found by OCR', !!ocrHit, `${shot.ocr?.length} boxes in ${Date.now() - t3} ms timing=${JSON.stringify(shot.timing)} text=${JSON.stringify((shot.ocr ?? []).map((b) => b.text).slice(0, 10))}`)
    if (ocrHit) {
      const inside = ocrHit.x >= te.bounds.x - 2 && ocrHit.y >= te.bounds.y - 2 && ocrHit.x + ocrHit.w <= te.bounds.x + te.bounds.w + 2
      check('e2e: OCR box is in global points inside the window', inside, JSON.stringify(te.bounds))
    }
  }
  try {
    execFileSync('pkill', ['-x', 'TextEdit'])
  } catch {}
}

if (abortCheck) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // Somewhere harmless for the keys to land.
  const doc = '/tmp/sei-act-abort.txt'
  execFileSync('bash', ['-c', `printf '' > ${doc}; open -a TextEdit ${doc}`])
  await sleep(3000)
  const ws = (await req('windows')).windows ?? []
  const te = ws.find((w) => w.owner === 'TextEdit' && w.bounds.w > 200 && w.bounds.h > 150)
  console.log(`info abort: TextEdit window ${JSON.stringify(te?.bounds ?? null)}`)

  const arm = async () => {
    const w = await req('watch', { enabled: true })
    check('abort: watcher armed with the event tap', w.ok && w.mode === 'tap', JSON.stringify(w))
    return w.ok
  }

  if (await arm()) {
    // 1. Our own input must not trip it: a click (cursor move + button) and a
    //    long type, all tagged.
    const before = userInputs.length
    if (te) {
      const c = { x: Math.round(te.bounds.x + te.bounds.w / 2), y: Math.round(te.bounds.y + te.bounds.h / 2) }
      const click = await req('click', { ...c, button: 'left', count: 1 })
      check('abort: our click completes with the watcher armed', click.ok, JSON.stringify(click))
    }
    const own = await req('type', { text: 'our own typing does not count as the player. '.repeat(3).slice(0, 140) }, 20000)
    await sleep(300)
    check('abort: our long type completes with the watcher armed', own.ok, JSON.stringify(own))
    check('abort: no user_input from our own events', userInputs.length === before, JSON.stringify(userInputs.slice(before)))

    // 2. The player mid-action: an untagged event during a long type (key,
    //    then mouse) and during a hold.
    const trial = async (name, start, kind) => {
      if (!(await arm())) return
      const seen = userInputs.length
      const pending = start()
      await sleep(400)
      const posted = await req('test_user_event', { kind })
      const res = await pending
      const helperMs = (res.at - posted.at) * 1000
      await sleep(100)
      check(
        `abort: ${name} cancelled by an untagged ${kind} event`,
        res.ok === false && /user input/.test(res.error ?? ''),
        JSON.stringify({ error: res.error, ranMs: res.ms }),
      )
      check(`abort: ${name} stopped within ${ABORT_MAX_MS} ms`, Number.isFinite(helperMs) && helperMs >= 0 && helperMs < ABORT_MAX_MS, `${helperMs.toFixed(1)} ms on the helper clock`)
      check(`abort: ${name} reported user_input`, userInputs.length === seen + 1, JSON.stringify(userInputs.slice(seen)))
    }
    await trial('type', () => req('type', { text: 'a'.repeat(200) }, 20000), 'key')
    await trial('type', () => req('type', { text: 'b'.repeat(200) }, 20000), 'mouse')
    await trial('hold', () => req('hold', { key: 'shift', ms: 3000 }, 20000), 'key')
    const off = await req('watch', { enabled: false })
    check('abort: watcher disarms', off.ok)
  }
  try {
    execFileSync('pkill', ['-x', 'TextEdit'])
  } catch {}
}

child.stdin.end()
const code = await new Promise((r) => child.on('exit', r))
check('exits on stdin EOF', code === 0, `code ${code}`)
process.exit(failed ? 1 : 0)
