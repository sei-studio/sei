// SeiLink spike round 2: the room host process (`<electron> . --room-host --ipc=<pipe>`).
//
// Owns the desktop-layer room window and (macOS) the native hit panel. Attaches, keeps itself
// attached, decides its own frame rate from the coverage signal, and reports to main over the
// IPC pipe (see supervisor.js for the message list). It never posts input anywhere and has no
// product UI: the room page is the round-1 magenta test pattern plus a box where the companion
// would stand.
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

const argv = Object.fromEntries(
  process.argv
    .slice(1)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.length ? v.join('=') : true]
    }),
)
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const ROOT = path.join(__dirname, '..')
const OUT = String(argv.out || path.join(ROOT, 'out', 'host'))
fs.mkdirSync(OUT, { recursive: true })
const T0 = Date.now()
function log(...a) {
  const line = `[host ${argv['host-n']} ${((Date.now() - T0) / 1000).toFixed(2)}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  try { fs.appendFileSync(path.join(OUT, 'log.txt'), line + '\n') } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A second Electron instance of the same app must not share the profile directory with main.
app.setPath('userData', path.join(app.getPath('userData'), 'seilink-room-host'))
if (IS_MAC && app.setActivationPolicy) app.setActivationPolicy('accessory')
// The room is wallpaper: it must keep drawing while unfocused / "occluded" by the shell's view of it.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

if (argv['crash-on-start']) {
  log('crash-on-start: exiting 7 (backoff test)')
  process.exit(7)
}

let addon = null
try {
  addon = require(path.join(ROOT, 'build', 'Release', 'seilink.node'))
} catch (e) {
  log('addon load failed', String(e))
}

// ---------------------------------------------------------------- IPC to main
let sock = null
const outbox = []
function send(m) {
  const line = JSON.stringify({ ...m, t: Date.now() }) + '\n'
  if (sock && !sock.destroyed) sock.write(line)
  else outbox.push(line)
}
function connect() {
  sock = net.connect(String(argv.ipc))
  sock.setEncoding('utf8')
  sock.on('connect', () => {
    send({ type: 'hello', pid: process.pid, n: Number(argv['host-n']) })
    while (outbox.length) sock.write(outbox.shift())
  })
  let buf = ''
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line) try { onCommand(JSON.parse(line)) } catch (e) { log('bad command', line, String(e)) }
    }
  })
  // Main went away: a host must never outlive its app.
  sock.on('close', () => { log('pipe closed; exiting'); app.exit(0) })
  sock.on('error', (e) => log('pipe error', String(e)))
}

// ---------------------------------------------------------------- state
let room = null
let attachInfo = null
let targetFps = 60
let paused = false
let covered = false
let coverWin = null    // last Windows coverage state
let roomVisible = true // mac occlusion of the room window
let panelVisible = true
let hitRect = null
let frames = 0
let lastFps = 0
let reattaching = false
const metricsWindow = []

function effectiveFps() {
  return paused || covered ? 0 : targetFps
}
function pushFps() {
  if (room && !room.isDestroyed()) room.webContents.send('set-fps', effectiveFps())
}
function setCovered(c, reason) {
  if (c === covered) return
  covered = c
  log('covered ->', c, reason)
  send({ type: 'covered', covered: c, reason, fps: effectiveFps() })
  pushFps()
}

let firstFramePending = false
ipcMain.on('frame', (_e, d) => {
  frames = d.frames
  lastFps = d.fps
  if (d.first && firstFramePending) {
    firstFramePending = false
    send({ type: 'first-frame', frames: d.frames, sinceStartMs: Date.now() - T0 })
  }
})

function onCommand(m) {
  switch (m.type) {
    case 'show':
      if (room) room.showInactive()
      send({ type: 'ack', of: m.type })
      break
    case 'hide':
      if (room) {
        room.hide()
        if (IS_WIN) log('hide repaint', JSON.stringify(addon.redrawParent(room.getNativeWindowHandle(), attachInfo && attachInfo.layout === 'classic')))
      }
      send({ type: 'ack', of: m.type })
      break
    case 'pause':
      paused = true
      pushFps()
      send({ type: 'ack', of: m.type, fps: effectiveFps() })
      break
    case 'resume':
      paused = false
      pushFps()
      send({ type: 'ack', of: m.type, fps: effectiveFps() })
      break
    case 'set-fps':
      targetFps = Math.max(0, Math.min(240, Number(m.fps) || 0))
      pushFps()
      send({ type: 'ack', of: m.type, fps: effectiveFps() })
      break
    case 'ping':
      send({ type: 'pong', id: m.id, sentAt: m.sentAt })
      break
    case 'set-hit-rect':
      setHitRect(m.rect)
      break
    case 'test-hang': {
      // Simulated wedge: block this process's main thread (no heartbeats, no IPC).
      log('test-hang', m.ms)
      const until = Date.now() + Number(m.ms || 10000)
      while (Date.now() < until) {}
      break
    }
    case 'test-exit':
      log('test-exit', m.code)
      app.exit(Number(m.code || 1))
      break
    case 'validate':
      validate('requested').then((v) => send({ type: 'validated', v }))
      break
    case 'quit':
      app.exit(0)
      break
  }
}

// ---------------------------------------------------------------- room window
function displayPx() {
  const d = screen.getPrimaryDisplay()
  const b = d.bounds
  const s = d.scaleFactor
  return { x: Math.round(b.x * s), y: Math.round(b.y * s), w: Math.round(b.width * s), h: Math.round(b.height * s), scale: s }
}

async function createRoom() {
  const b = screen.getPrimaryDisplay().bounds
  const w = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#ff00ff',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  })
  w.on('closed', () => {
    log('room window closed')
    if (room === w) {
      room = null
      if (!quitting) recoverWindow('window-closed')
    }
  })
  w.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d))
  const ready = new Promise((r) => w.once('ready-to-show', () => r('ready-to-show')))
  w.loadFile(path.join(__dirname, 'room.html'), { query: { n: String(argv['host-n']) } })
  await Promise.race([ready, sleep(6000)])
  room = w
  pushFps()
  if (hitRect) room.webContents.send('hit-rect', hitRect)
  return w
}

// Windows: wait until the shell has a Progman with a DefView (fresh Explorer starts without one).
async function waitForShell() {
  if (!IS_WIN) return { waitedMs: 0 }
  const t = Date.now()
  let told = false
  for (;;) {
    const st = addon.status(Buffer.alloc(8))
    if (st.progman !== '0x0' && st.defViewExists) {
      return { waitedMs: Date.now() - t, explorerPid: st.explorerPid, via: shellReadyVia || 'poll' }
    }
    if (!told) {
      told = true
      send({ type: 'waiting-shell', status: st })
    }
    await sleep(100)
  }
}
let shellReadyVia = null

async function attach(reason) {
  const t = Date.now()
  let res
  if (IS_WIN) {
    const px = displayPx()
    res = addon.attach(room.getNativeWindowHandle(), { mode: 'auto', x: px.x, y: px.y, w: px.w, h: px.h })
    room.showInactive()
    attachInfo = { layout: res.desk && res.desk.layout, method: res.method, ok: res.ok, px }
  } else if (IS_MAC) {
    const lv = addon.levels()
    const beh = addon.behaviors()
    res = addon.setLevel(room.getNativeWindowHandle(), { level: lv.desktopIcon - 1, behavior: beh.canJoinAllSpaces | beh.stationary | beh.ignoresCycle, ignoresMouse: true })
    room.showInactive()
    await sleep(300)
    const info = addon.windowInfo(room.getNativeWindowHandle())
    res.ok = info.level === lv.desktopIcon - 1
    attachInfo = { layout: 'mac', method: `level desktopIcon-1 = ${lv.desktopIcon - 1}`, ok: res.ok, levelAfterShow: info.level }
    roomVisible = addon.observeOcclusion(room.getNativeWindowHandle(), 'room')
  } else {
    room.showInactive()
    res = { ok: true, method: 'linux: plain window (no desktop layer)' }
    attachInfo = { layout: 'linux', method: res.method, ok: true }
  }
  log('attach', reason, attachInfo, res.steps || '')
  send({ type: 'attached', reason, reattach: reason !== 'initial', attachMs: Date.now() - t, sinceStartMs: Date.now() - T0, ...attachInfo, steps: res.steps })
  // Ask the page to report its next drawn frame at once, so main can time "drawing again".
  firstFramePending = true
  if (room && !room.isDestroyed()) room.webContents.send('report-now')
  return res
}

let quitting = false
async function recoverWindow(reason) {
  if (reattaching) return
  reattaching = true
  try {
    send({ type: 'event', event: 'recover', reason })
    await waitForShell()
    await createRoom()
    await attach(reason)
  } finally {
    reattaching = false
  }
}

// Windows: re-check the attachment after shell events (and every 2 s as a safety net).
async function validate(trigger) {
  if (!IS_WIN || !room || room.isDestroyed() || reattaching) return null
  const px = displayPx()
  const v = addon.validate(room.getNativeWindowHandle(), { w: px.w, h: px.h })
  if (v.ok) {
    workerWMissingAccepted = false
    return v
  }
  // Raised (24H2) layout: once a WorkerW is destroyed, 0x052C does not bring it back (measured on
  // windows-2025, round 2 run 1), and the room still draws fine directly under DefView. Re-attach
  // once; if that leaves only "no-workerw", accept it instead of re-attaching every 2 s.
  const onlyWorkerW = v.layout === 'raised' && v.reasons.every((r) => r === 'no-workerw' || r === 'workerw-not-bottom')
  if (onlyWorkerW && workerWMissingAccepted) return v
  log('validate failed', trigger, v)
  send({ type: 'event', event: 'validate-failed', trigger, reasons: v.reasons, layout: v.layout })
  if (v.reasons.includes('no-progman') || v.reasons.includes('no-defview')) {
    // Shell is mid-rebuild; the next trigger (TaskbarCreated or the timer) retries.
    return v
  }
  if (v.reasons.includes('own-window-gone')) {
    recoverWindow('own-window-gone')
    return v
  }
  reattaching = true
  try {
    await attach('validate:' + trigger + ':' + v.reasons.join('+'))
  } finally {
    reattaching = false
  }
  if (v.layout === 'raised' && v.reasons.some((r) => r === 'no-workerw')) {
    const v2 = addon.validate(room.getNativeWindowHandle(), { w: px.w, h: px.h })
    if (!v2.ok && v2.reasons.every((r) => r === 'no-workerw' || r === 'workerw-not-bottom')) {
      workerWMissingAccepted = true
      log('raised layout without WorkerW: accepted after one re-attach')
      send({ type: 'event', event: 'workerw-missing-accepted', reasons: v2.reasons })
    }
  }
  return v
}
let workerWMissingAccepted = false
let coverDumps = 0

function onNativeEvent(json) {
  let e
  try {
    e = JSON.parse(json)
  } catch {
    return
  }
  if (e.type === 'coverage') {
    coverWin = e
    log('coverage state', JSON.stringify(e.state).slice(0, 600))
    if (e.state.covered && coverDumps < 6) {
      coverDumps++
      try { log('coverage candidates', addon.coverageNow().candidates.slice(0, 3000)) } catch (err) { log('candidates error', String(err)) }
    }
    setCovered(!!e.state.covered, `${e.trigger}: ${e.state.kind || 'none'} ${e.state.by.class || ''} ${e.state.by.exe || ''}`.trim())
    send({ type: 'event', event: 'coverage', detail: e })
    return
  }
  if (e.type === 'occlusion') {
    if (e.tag === 'room') roomVisible = e.visible
    if (e.tag === 'panel') panelVisible = e.visible
    send({ type: 'event', event: 'occlusion', detail: e })
    const c = !roomVisible || (!!hitRect && !panelVisible)
    setCovered(c, `occlusion room=${roomVisible} panel=${hitRect ? panelVisible : 'n/a'}`)
    return
  }
  if (e.type === 'hit') {
    if (e.kind !== 'drag-move' && e.kind !== 'down') log('hit', e)
    send({ type: 'click', x: e.x, y: e.y, kind: e.kind, appActive: e.appActive, moves: e.moves, dist: e.dist, clickCount: e.clickCount })
    if (room && !room.isDestroyed()) room.webContents.send('poke', e.kind)
    return
  }
  // Windows shell events.
  send({ type: 'event', event: e.type, detail: e })
  if (e.type === 'taskbarCreated') shellReadyVia = 'taskbarCreated'
  if (['taskbarCreated', 'displayChange', 'settingChange', 'session'].includes(e.type)) {
    // Give the shell a moment to finish rebuilding, then validate twice.
    setTimeout(() => validate(e.type), 300)
    setTimeout(() => validate(e.type + '+1500'), 1500)
  }
}

function setHitRect(r) {
  hitRect = r
  if (room && !room.isDestroyed()) room.webContents.send('hit-rect', r)
  if (IS_MAC && addon) {
    const info = addon.hitPanelInfo().valid ? addon.hitPanelSetRect(r) : addon.hitPanel({ ...r })
    send({ type: 'event', event: 'hit-panel', info, appActive: addon.appActive() })
  }
}

// ---------------------------------------------------------------- heartbeat + metrics
function metrics() {
  const m = app.getAppMetrics()
  const cpu = m.reduce((s, p) => s + (p.cpu ? p.cpu.percentCPUUsage : 0), 0)
  const ws = m.reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024
  return { cpu: +cpu.toFixed(2), ramMB: +ws.toFixed(1), procs: m.map((p) => ({ type: p.type, wsMB: +(p.memory.workingSetSize / 1024).toFixed(1), cpu: p.cpu ? +p.cpu.percentCPUUsage.toFixed(2) : null })) }
}

function heartbeat() {
  const mt = metrics()
  metricsWindow.push(mt)
  send({ type: 'heartbeat', frames, fps: +lastFps.toFixed(1), targetFps, effectiveFps: effectiveFps(), paused, covered, cpu: mt.cpu, ramMB: mt.ramMB, procs: mt.procs, attached: !!(attachInfo && attachInfo.ok), uptimeMs: Date.now() - T0 })
}

// ---------------------------------------------------------------- lifecycle
app.on('window-all-closed', () => {})
app.on('before-quit', () => (quitting = true))
connect()
app.whenReady().then(async () => {
  if (!addon) throw new Error('addon missing')
  if (IS_WIN) addon.watchStart(onNativeEvent)
  if (IS_MAC) addon.onEvents(onNativeEvent)
  send({ type: 'ready', sinceStartMs: Date.now() - T0 })
  const sh = await waitForShell()
  send({ type: 'event', event: 'shell-ready', ...sh })
  await createRoom()
  await attach('initial')
  setInterval(heartbeat, 1000)
  heartbeat()
  if (IS_WIN) setInterval(() => validate('timer'), 2000)
  screen.on('display-metrics-changed', () => setTimeout(() => validate('display-metrics-changed'), 300))
}).catch((e) => {
  log('FATAL', String(e && e.stack))
  send({ type: 'log', fatal: String(e && e.stack) })
  setTimeout(() => app.exit(4), 200)
})
