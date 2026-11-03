// SeiLink spike round 2: the main-process harness (`<electron> . --variant=r2 --out=<dir>`).
//
// Main is the app: it owns a small ordinary window (stand-in for Sei's own UI) and a Supervisor
// that runs the room in a separate `--room-host` process. This script drives the scenarios and
// measures them; the host (host.js) does the attaching, coverage and hit work on its own.
//
//   common   start + attach, shots (visible / animates), RAM main + host, ping RTT, hide/show,
//            set-fps / pause / resume, SIGKILL recovery, hang -> missed heartbeat, crash-loop backoff
//   windows  coverage (normal / maximized / Win+D / fullscreen), display change, wallpaper change,
//            WM_CLOSE to WorkerW, then taskkill explorer (last)
//   mac      native hit panel: click / dblclick / drag with TextEdit in front (frontmost + bounds
//            after each), rect update, coverage (zoomed TextEdit / show desktop / fullscreen),
//            Dock + Finder restarts
const { app, BrowserWindow, screen, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { Supervisor } = require('./supervisor.js')

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
const variant = String(argv.variant || 'r2')
const OUT = path.resolve(String(argv.out || path.join(ROOT, 'out', variant)))
fs.mkdirSync(OUT, { recursive: true })
const T0 = Date.now()
const logFile = path.join(OUT, 'log.txt')
function log(...a) {
  const line = `[main ${((Date.now() - T0) / 1000).toFixed(2)}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  try { fs.appendFileSync(logFile, line + '\n') } catch {}
  console.log(line.slice(0, 600))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { variant, round: 2, platform: process.platform, arch: process.arch, electron: process.versions.electron, mainPid: process.pid, checks: {}, numbers: {}, events: [] }
function save() {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
}
const step = (name, data) => {
  log('STEP', name, data || '')
  result.events.push({ t: Date.now() - T0, name, ...(data || {}) })
}

let addon = null
try {
  addon = require(path.join(ROOT, 'build', 'Release', 'seilink.node'))
} catch (e) {
  log('addon load failed', String(e))
}

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ err: err ? String(err.message || err) : null, stdout: String(stdout).trim(), stderr: String(stderr).trim() }),
    )
  })
}

// ---------------------------------------------------------------- shots + pixel checks (from main.js)
let lastHb = null
async function shot(name) {
  const file = path.join(OUT, `${name}.png`)
  const framesAt = lastHb ? lastHb.frames : null
  let r
  if (IS_WIN) r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'shot-win.ps1'), '-Path', file])
  else if (IS_MAC) r = await run('/usr/sbin/screencapture', ['-x', '-C', file])
  else r = { err: 'no screenshot tool' }
  if (r.err) log('shot error', name, r.err, r.stderr)
  return { file, framesAt, ok: !r.err && fs.existsSync(file) }
}
function analyze(file, regions) {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return { error: 'empty image' }
  const { width: W, height: H } = img.getSize()
  const bmp = img.toBitmap() // BGRA
  const disp = screen.getPrimaryDisplay().bounds
  const sx = W / disp.width
  const sy = H / disp.height
  const px = (x, y) => {
    const i = (y * W + x) * 4
    return [bmp[i + 2], bmp[i + 1], bmp[i]]
  }
  const isMag = ([r, g, b]) => r > 180 && b > 180 && g < 90
  const isGreen = ([r, g, b]) => g > 180 && r < 90 && b < 90
  const isYellow = ([r, g, b]) => r > 200 && g > 170 && b < 80
  function stats(rx, ry, rw, rh) {
    const x0 = Math.max(0, Math.round(rx * sx)), y0 = Math.max(0, Math.round(ry * sy))
    const x1 = Math.min(W, Math.round((rx + rw) * sx)), y1 = Math.min(H, Math.round((ry + rh) * sy))
    let n = 0, mag = 0, green = 0, yel = 0, gx = 0, gy = 0
    for (let y = y0; y < y1; y += 2)
      for (let x = x0; x < x1; x += 2) {
        const p = px(x, y)
        n++
        if (isMag(p)) mag++
        else if (isYellow(p)) yel++
        else if (isGreen(p)) {
          green++
          gx += x
          gy += y
        }
      }
    return {
      magenta: n ? +(mag / n).toFixed(3) : 0,
      green: n ? +(green / n).toFixed(4) : 0,
      yellow: n ? +(yel / n).toFixed(3) : 0,
      greenCentroid: green > 50 ? { x: Math.round(gx / green / sx), y: Math.round(gy / green / sy) } : null,
    }
  }
  const out = { size: `${W}x${H}` }
  for (const [k, r] of Object.entries(regions)) if (r) out[k] = stats(r.x, r.y, r.w, r.h)
  return out
}
function bandRegion() {
  const b = screen.getPrimaryDisplay().bounds
  return { x: b.width * 0.12, y: b.height * 0.8, w: b.width * 0.76, h: b.height * 0.08 }
}
async function shotAndCheck(name, extra = {}) {
  const s = await shot(name)
  const a = s.ok ? analyze(s.file, { band: bandRegion(), ...extra }) : { error: 'no shot' }
  const rec = { name, framesAt: s.framesAt, ...a }
  log('shot', rec)
  result.shots = result.shots || []
  result.shots.push(rec)
  save()
  return rec
}
// visible = the room's magenta fills the ticker band; animates = the band's green block moved
// between two shots while the host's frame counter advanced.
function judge(A, B) {
  if (!A || !B || !A.band || !B.band) return { visible: false, animates: false }
  const ca = A.band.greenCentroid, cb = B.band.greenCentroid
  return {
    visible: A.band.magenta > 0.3 && B.band.magenta > 0.3,
    animates: !!(ca && cb && Math.abs(ca.x - cb.x) > 15) && B.framesAt > A.framesAt,
  }
}

// ---------------------------------------------------------------- metrics
function mainRam() {
  const m = app.getAppMetrics()
  const ws = m.reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024
  const mu = process.memoryUsage()
  return { totalWorkingSetMB: +ws.toFixed(1), procs: m.map((p) => ({ type: p.type, wsMB: +(p.memory.workingSetSize / 1024).toFixed(1) })), heapUsedMB: +(mu.heapUsed / 1048576).toFixed(1), rssMB: +(mu.rss / 1048576).toFixed(1) }
}
function mainCpu() {
  return +app.getAppMetrics().reduce((s, p) => s + (p.cpu ? p.cpu.percentCPUUsage : 0), 0).toFixed(2)
}
const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null)

// Collect heartbeats for ms and summarise FPS + CPU of the host tree (and main's own CPU).
async function measure(label, ms = 5000) {
  const hbs = []
  const mc = []
  const on = (m) => hbs.push(m)
  sup.on('heartbeat', on)
  mainCpu() // first call primes the counters
  const iv = setInterval(() => mc.push(mainCpu()), 1000)
  await sleep(ms)
  clearInterval(iv)
  sup.off('heartbeat', on)
  const tail = hbs.slice(1) // first beat can straddle the change
  const r = {
    label,
    beats: hbs.length,
    fpsMedian: median(tail.map((h) => h.fps)),
    framesDelta: hbs.length > 1 ? hbs[hbs.length - 1].frames - hbs[0].frames : null,
    hostCpuMean: mean(tail.map((h) => h.cpu)),
    hostRamMB: hbs.length ? hbs[hbs.length - 1].ramMB : null,
    mainCpuMean: mean(mc.slice(1)),
    effectiveFps: hbs.length ? hbs[hbs.length - 1].effectiveFps : null,
    covered: hbs.length ? hbs[hbs.length - 1].covered : null,
    hostProcs: hbs.length ? hbs[hbs.length - 1].procs : null,
  }
  log('measure', label, r.fpsMedian, 'fps,', r.hostCpuMean, '% host cpu,', r.mainCpuMean, '% main cpu, covered', r.covered)
  result.numbers.measure = result.numbers.measure || {}
  result.numbers.measure[label] = r
  save()
  return r
}

// Wait for the host to report it is drawing after an attach: the page's first drawn frame after
// the attach (first-frame), else a heartbeat whose frame counter advanced (1 s granularity).
let lastFirstFrame = null
async function framesAdvancing(ms = 15000, since = 0) {
  if (lastFirstFrame && lastFirstFrame.recvAt >= since) return lastFirstFrame.recvAt
  const ff = await sup.waitFor('first-frame', (m) => m.recvAt >= since, ms)
  if (ff) return ff.recvAt
  const first = await sup.waitFor('heartbeat', (m) => m.attached, 3000)
  if (!first) return null
  const next = await sup.waitFor('heartbeat', (m) => m.frames > first.frames && m.host === first.host, 4000)
  return next ? next.recvAt : null
}

// ---------------------------------------------------------------- main window (Sei's own UI stand-in)
let mainWin = null
async function createMainWindow() {
  const b = screen.getPrimaryDisplay().workArea
  mainWin = new BrowserWindow({ x: Math.round(b.x + b.width * 0.4), y: b.y + 10, width: 300, height: 150, show: false, title: 'SeiLink main', backgroundColor: '#202020', webPreferences: { backgroundThrottling: false } })
  await mainWin.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#202020;color:#fff;font:16px sans-serif"><p id=t style="padding:12px">SeiLink main (app UI stand-in)</p><script>let n=0;setInterval(()=>{document.getElementById("t").textContent="SeiLink main alive "+(++n)},1000)</script></body>'))
  mainWin.showInactive()
}
async function mainWindowAlive() {
  if (!mainWin || mainWin.isDestroyed()) return { alive: false }
  try {
    const t = await Promise.race([mainWin.webContents.executeJavaScript('document.getElementById("t").textContent'), sleep(3000).then(() => null)])
    return { alive: t != null, text: t, visible: mainWin.isVisible() }
  } catch (e) {
    return { alive: false, err: String(e) }
  }
}

// Main event-loop lag sampler (max drift of a 50 ms interval).
let lagMax = 0
let lagSamples = []
function startLag() {
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const d = now - last - 50
    last = now
    if (d > lagMax) lagMax = d
    lagSamples.push(d)
  }, 50)
}
function takeLag() {
  const r = { maxMs: lagMax, p99Ms: lagSamples.length ? [...lagSamples].sort((a, b) => a - b)[Math.floor(lagSamples.length * 0.99)] : null }
  lagMax = 0
  lagSamples = []
  return r
}

// ---------------------------------------------------------------- supervisor
const sup = new Supervisor({ exe: process.execPath, appPath: ROOT, outDir: OUT, log, hostArgs: process.platform === 'linux' ? ['--no-sandbox'] : [] })
const covEvents = []
const clicks = []
sup.on('msg', (m) => {
  if (m.type === 'heartbeat') lastHb = m
  if (m.type === 'first-frame') lastFirstFrame = m
  if (m.type === 'covered') {
    covEvents.push(m)
    log('host covered ->', m.covered, m.reason)
  }
  if (m.type === 'click') clicks.push(m)
  if (m.type === 'attached') log('host', m.host, 'attached', m.reason, m.layout, m.method, 'ok', m.ok, 'attachMs', m.attachMs)
  if (m.type === 'event' && m.event !== 'coverage' && m.event !== 'occlusion') log('host event', m.event, JSON.stringify(m).slice(0, 300))
  if (m.type === 'log') log('host log', m)
})
sup.on('restart-scheduled', (r) => step('restart-scheduled', r))
sup.on('missed-heartbeat', (r) => step('missed-heartbeat', r))

async function waitCovered(want, ms = 6000, t0 = Date.now()) {
  if (lastHb && lastHb.covered === want && covEvents.length && covEvents[covEvents.length - 1].covered === want) return { already: true, ms: 0 }
  const m = await sup.waitFor('covered', (x) => x.covered === want, ms)
  return m ? { ms: m.recvAt - t0, reason: m.reason } : null
}

// ---------------------------------------------------------------- common block
async function common() {
  const tStart = Date.now()
  sup.start()
  const att = await sup.waitFor('attached', () => true, 30000)
  if (!att) throw new Error('host never attached')
  const fa = await framesAdvancing(15000, att.recvAt)
  result.numbers.coldStart = { attachedMs: att.recvAt - tStart, hostAttachMs: att.attachMs, firstFramesMs: fa && fa - tStart, layout: att.layout, method: att.method }
  result.checks.attached = !!att.ok
  step('attached', result.numbers.coldStart)
  await sleep(2500)
  const A = await shotAndCheck('01-visible-a')
  await sleep(2500)
  const B = await shotAndCheck('02-visible-b')
  Object.assign(result.checks, judge(A, B))

  // RAM
  await sleep(1000)
  result.numbers.ram = { main: mainRam(), host: lastHb && { totalWorkingSetMB: lastHb.ramMB, procs: lastHb.procs } }
  log('ram main', result.numbers.ram.main.totalWorkingSetMB, 'MB; host', lastHb && lastHb.ramMB, 'MB')

  // ping RTT
  const rtts = []
  for (let i = 0; i < 5; i++) {
    const t = Date.now()
    sup.send({ type: 'ping', id: i, sentAt: t })
    const p = await sup.waitFor('pong', (m) => m.id === i, 3000)
    if (p) rtts.push(p.recvAt - t)
    await sleep(100)
  }
  result.numbers.pingRttMs = { samples: rtts, median: median(rtts) }

  // hide / show
  sup.send({ type: 'hide' })
  await sleep(1200)
  const H = await shotAndCheck('03-hidden')
  sup.send({ type: 'show' })
  await sleep(1200)
  const S = await shotAndCheck('04-shown')
  result.checks.hideShow = !!(H.band && S.band && H.band.magenta < 0.1 && S.band.magenta > 0.3)

  // fps control
  await measure('visible-60', 5000)
  sup.send({ type: 'set-fps', fps: 15 })
  await sleep(1000)
  const m15 = await measure('set-fps-15', 5000)
  sup.send({ type: 'set-fps', fps: 60 })
  sup.send({ type: 'pause' })
  await sleep(1000)
  const mp = await measure('paused', 5000)
  sup.send({ type: 'resume' })
  await sleep(1000)
  const mr = await measure('resumed', 4000)
  result.checks.setFps15 = m15.fpsMedian != null && m15.fpsMedian > 10 && m15.fpsMedian < 20
  result.checks.pauseZero = mp.fpsMedian === 0 && mp.framesDelta === 0
  result.checks.resumeDraws = mr.fpsMedian > 20

  // SIGKILL / taskkill /F the host
  {
    const rec = sup.child.rec
    const t = Date.now()
    sup.kill(rec)
    const ex = await new Promise((r) => sup.once('exit', r))
    const sp = await new Promise((r) => sup.once('spawn', r))
    const at = await sup.waitFor('attached', () => true, 20000)
    const fr = at && (await framesAdvancing(15000, at.recvAt))
    result.numbers.killRecovery = { exitMs: ex.exit.at - t, spawnMs: sp.spawnedAt - t, attachedMs: at && at.recvAt - t, framesMs: fr && fr - t, exit: ex.exit }
    result.checks.killRecovered = !!(at && fr)
    step('kill-recovery', result.numbers.killRecovery)
  }
  await sleep(1500)

  // hang -> missed heartbeat
  {
    const t = Date.now()
    sup.send({ type: 'test-hang', ms: 15000 })
    const mh = await new Promise((r) => {
      sup.once('missed-heartbeat', r)
      setTimeout(() => r(null), 12000)
    })
    const at = await sup.waitFor('attached', () => true, 25000)
    const fr = at && (await framesAdvancing(15000, at.recvAt))
    result.numbers.hangRecovery = { detectMs: mh && mh.at - t, gapMs: mh && mh.gap, attachedMs: at && at.recvAt - t, framesMs: fr && fr - t }
    result.checks.hangRecovered = !!(mh && at && fr)
    step('hang-recovery', result.numbers.hangRecovery)
  }
  await sleep(1500)

  // crash loop -> backoff
  {
    const n0 = sup.restarts.length
    const t = Date.now()
    sup.crashNext = 3
    sup.send({ type: 'test-exit', code: 1 })
    const at = await sup.waitFor('attached', () => true, 45000)
    const fr = at && (await framesAdvancing(15000, at.recvAt))
    const rs = sup.restarts.slice(n0)
    result.numbers.crashLoop = { restarts: rs.map((r) => ({ reason: r.reason, delay: r.delay, streak: r.streak, lived: r.lived })), attachedMs: at && at.recvAt - t, framesMs: fr && fr - t }
    result.checks.crashLoopRecovered = !!(at && fr)
    result.checks.backoffGrows = rs.length >= 4 && rs.every((r, i) => i === 0 || r.delay >= rs[i - 1].delay) && rs[rs.length - 1].delay > rs[0].delay
    step('crash-loop', result.numbers.crashLoop)
  }
  await sleep(2000)
  save()
}

// ---------------------------------------------------------------- Windows
async function notepad() {
  const txt = path.join(OUT, 'notepad.txt')
  fs.writeFileSync(txt, 'SeiLink round 2: a normal app window.\r\n'.repeat(20))
  cp.spawn('notepad.exe', [txt], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    const t = addon.findTop('Notepad')
    if (t.length) return t[0]
  }
  return null
}

async function winCoverage() {
  const b = screen.getPrimaryDisplay().bounds
  // 1) normal window: must NOT count as covered.
  let np = await notepad()
  let fallbackWin = null
  if (!np) {
    log('no Notepad window; using an Electron window as the app window')
    fallbackWin = new BrowserWindow({ x: 60, y: 60, width: 500, height: 300, title: 'SeiLink app window', backgroundColor: '#3060c0' })
    await fallbackWin.loadURL('data:text/html,<body style="background:#3060c0">app window</body>')
    await sleep(800)
  }
  result.notepad = np
  await sleep(1500)
  const normal = await measure('normal-window', 4000)
  result.checks.normalWindowNotCovered = normal.covered === false
  const hwnd = np ? np.hwnd : fallbackWin.getNativeWindowHandle()

  // 2) maximize -> covered
  let t = Date.now()
  if (np) addon.testShowWindow(hwnd, 3)
  else fallbackWin.maximize()
  const c1 = await waitCovered(true, 6000, t)
  result.numbers.coverMaximize = c1
  await sleep(800)
  await shotAndCheck('10-maximized')
  const mc = await measure('covered-maximized', 5000)
  result.checks.maximizedCovered = !!c1 && mc.covered === true && mc.fpsMedian === 0

  // 3) Win+D -> uncovered
  t = Date.now()
  addon.testKeys([0x5b, 0x44])
  let u1 = await waitCovered(false, 5000, t)
  let showDesktopVia = 'Win+D'
  if (!u1) {
    log('Win+D did not uncover; trying Shell.Application ToggleDesktop')
    t = Date.now()
    await run('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Shell.Application).ToggleDesktop()'])
    u1 = await waitCovered(false, 5000, t)
    showDesktopVia = 'ToggleDesktop'
  }
  result.numbers.uncoverShowDesktop = { ...(u1 || {}), via: showDesktopVia }
  await sleep(800)
  const D1 = await shotAndCheck('11-show-desktop-a')
  const mu = await measure('uncovered-show-desktop', 5000)
  const D2 = await shotAndCheck('12-show-desktop-b')
  result.checks.showDesktopUncovered = !!u1 && mu.fpsMedian > 20 && judge(D1, D2).animates

  // 4) restore the app window (normal) -> stays uncovered
  if (np) addon.testShowWindow(hwnd, 9) // SW_RESTORE
  else fallbackWin.restore()
  await sleep(1500)
  if (np) addon.testShowWindow(hwnd, 1)
  await sleep(1000)
  // 5) a fullscreen window (borderless monitor-sized, no maximize bit)
  t = Date.now()
  const fs1 = new BrowserWindow({ ...b, fullscreen: true, frame: false, backgroundColor: '#204020', title: 'SeiLink fullscreen' })
  await fs1.loadURL('data:text/html,<body style="background:#204020;color:#fff;font:40px sans-serif">fullscreen app</body>')
  const c2 = await waitCovered(true, 6000, t)
  result.numbers.coverFullscreen = c2
  const mf = await measure('covered-fullscreen', 4000)
  result.checks.fullscreenCovered = !!c2 && mf.fpsMedian === 0
  t = Date.now()
  fs1.close()
  const u2 = await waitCovered(false, 6000, t)
  result.numbers.uncoverFullscreenClosed = u2
  await sleep(1000)
  try { cp.execFileSync('taskkill', ['/F', '/IM', 'notepad.exe'], { stdio: 'ignore' }) } catch {}
  if (fallbackWin && !fallbackWin.isDestroyed()) fallbackWin.close()
  await sleep(1000)
  result.coverageEvents = covEvents.map((c) => ({ t: c.recvAt - T0, covered: c.covered, reason: c.reason }))
  save()
}

async function validated() {
  sup.send({ type: 'validate' })
  const v = await sup.waitFor('validated', () => true, 4000)
  return v && v.v
}

async function hostReaction(label, fn, ms = 8000) {
  const t = Date.now()
  const evs = []
  const on = (m) => {
    if (m.type === 'event' || m.type === 'attached' || m.type === 'exit') evs.push({ ms: m.recvAt - t, type: m.type, event: m.event, reason: m.reason || m.trigger, reasons: m.reasons, layout: m.layout })
  }
  sup.on('msg', on)
  const ex = []
  const onExit = (r) => ex.push({ ms: r.exit.at - t, code: r.exit.hex })
  sup.on('exit', onExit)
  const ret = await fn()
  const at = await sup.waitFor('attached', (m) => m.recvAt >= t, ms)
  await sleep(1500)
  sup.off('msg', on)
  sup.off('exit', onExit)
  const v = await validated()
  const r = { label, ret, reattachedMs: at && at.recvAt - t, reattachReason: at && at.reason, hostExits: ex, events: evs.slice(0, 30), validAfter: v && { ok: v.ok, reasons: v.reasons, layout: v.layout } }
  log('reaction', label, r.reattachedMs, r.reattachReason, 'validAfter', r.validAfter)
  result.numbers.shell = result.numbers.shell || {}
  result.numbers.shell[label] = r
  save()
  return r
}

async function winShellEvents() {
  // a) WorkerW destroyed without Explorer dying.
  const v0 = await validated()
  result.validateBefore = v0
  if (v0 && v0.workerW && v0.workerW !== '0x0') {
    await hostReaction('workerw-wm-close', async () => addon.testPostMessage(v0.workerW, 0x0010), 10000)
    await sleep(500)
    const A = await shotAndCheck('20-after-workerw-close-a')
    await sleep(2000)
    const B = await shotAndCheck('21-after-workerw-close-b')
    result.checks.workerwCloseRecovered = judge(A, B)
  } else {
    result.checks.workerwCloseRecovered = 'no WorkerW handle'
  }
  // b) wallpaper change (SPI_SETDESKWALLPAPER -> WM_SETTINGCHANGE).
  await hostReaction('wallpaper-change', async () => addon.testSetWallpaper(''), 5000)
  {
    const A = await shotAndCheck('22-after-wallpaper-a')
    await sleep(2000)
    const B = await shotAndCheck('23-after-wallpaper-b')
    result.checks.wallpaperChangeStillVisible = judge(A, B)
  }
  // c) display mode change and back.
  const modes = addon.testDisplayModes()
  const b = screen.getPrimaryDisplay().bounds
  const alt = modes.find((m) => m.w !== b.width && m.w >= 800 && m.w <= 1600 && m.h >= 600) || null
  result.displayModes = { current: b, alt, count: modes.length }
  if (alt) {
    await hostReaction('display-change', async () => addon.testSetDisplay(alt.w, alt.h), 8000)
    await sleep(1000)
    const A = await shotAndCheck('24-display-changed-a')
    await sleep(2000)
    const B = await shotAndCheck('25-display-changed-b')
    result.checks.displayChangeStillVisible = judge(A, B)
    await hostReaction('display-restore', async () => addon.testSetDisplay(0, 0), 8000)
    await sleep(1000)
    const C = await shotAndCheck('26-display-restored-a')
    await sleep(2000)
    const D = await shotAndCheck('27-display-restored-b')
    result.checks.displayRestoreStillVisible = judge(C, D)
  } else {
    result.checks.displayChangeStillVisible = 'no alternative display mode'
  }
  save()
}

async function winExplorerKill() {
  const st0 = addon.status(Buffer.alloc(8))
  const hostBefore = sup.child && sup.child.rec
  await sleep(500)
  takeLag()
  const t = Date.now()
  let exitRec = null
  sup.once('exit', (r) => (exitRec = r))
  let spawnRec = null
  sup.once('spawn', (r) => (spawnRec = r))
  await run('taskkill', ['/F', '/IM', 'explorer.exe'])
  const tKilled = Date.now()
  // Main watches the shell itself so the Explorer restart can be told apart from our recovery.
  let shellReadyAt = null
  let started = false
  const attachedP = sup.waitFor('attached', (m) => m.recvAt >= t, 40000)
  for (let i = 0; i < 160 && !shellReadyAt; i++) {
    await sleep(100)
    const st = addon.status(Buffer.alloc(8))
    if (!started && Date.now() - t > 4000 && !st.explorerPid) {
      log('explorer did not auto-restart within 4 s; starting explorer.exe')
      cp.spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref()
      started = true
    }
    if (st.defViewExists && st.explorerPid && st.explorerPid !== st0.explorerPid) shellReadyAt = Date.now()
  }
  const at = await attachedP
  const fr = at && (await framesAdvancing(15000, at.recvAt))
  const lag = takeLag()
  const alive = await mainWindowAlive()
  const r = {
    killCmdMs: tKilled - t,
    hostExitMs: exitRec && exitRec.exit.at - t,
    hostExitCode: exitRec && exitRec.exit.hex,
    hostBefore: hostBefore && hostBefore.n,
    respawnMs: spawnRec && spawnRec.spawnedAt - t,
    shellReadyMs: shellReadyAt && shellReadyAt - t,
    startedExplorerOurselves: started,
    attachedMs: at && at.recvAt - t,
    framesMs: fr && fr - t,
    ourRecoveryAfterShellReadyMs: at && shellReadyAt ? at.recvAt - shellReadyAt : null,
    attachLayout: at && at.layout,
    attachReason: at && at.reason,
    mainEventLoopLag: lag,
    mainAlive: alive,
    mainPid: process.pid,
  }
  result.numbers.explorerKill = r
  step('explorer-kill', r)
  result.checks.explorerKillRecovered = !!(at && fr)
  result.checks.mainSurvivedExplorerKill = alive.alive
  await sleep(1500)
  const A = await shotAndCheck('30-after-explorer-a')
  await sleep(2500)
  const B = await shotAndCheck('31-after-explorer-b')
  result.checks.afterExplorer = judge(A, B)
  result.numbers.ramAfterExplorer = { main: mainRam(), host: lastHb && lastHb.ramMB }
  if (IS_WIN) result.watchStatsMain = null
  save()
}

// ---------------------------------------------------------------- macOS
function teWin() {
  return addon.windowList().find((x) => x.owner === 'TextEdit' && x.layer === 0 && x.bounds.w > 100)
}
async function frontTextEdit() {
  await run('/usr/bin/open', ['-a', 'TextEdit'])
  await sleep(1200)
  return addon.frontmostInfo()
}
const sameBounds = (a, b) => !!(a && b && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2)

async function macHit() {
  const b = screen.getPrimaryDisplay().bounds
  const rect = { x: Math.round(b.width * 0.22), y: Math.round(b.height * 0.62), w: 200, h: 160 }
  sup.send({ type: 'set-hit-rect', rect })
  const hp = await sup.waitFor('event', (m) => m.event === 'hit-panel', 4000)
  result.hitPanel = hp && { info: hp.info, appActive: hp.appActive }
  log('hit panel', result.hitPanel)

  const txt = path.join(OUT, 'textedit.txt')
  fs.writeFileSync(txt, 'SeiLink round 2: TextEdit stays in front.\n'.repeat(10))
  await run('/usr/bin/open', ['-a', 'TextEdit', txt])
  await sleep(3500)
  let te = teWin()
  const want = { x: 40, y: 60, w: 520, h: Math.min(300, Math.round(b.height * 0.4)) }
  if (te) {
    result.axMove = addon.axSetFrame(te.pid, want)
    await sleep(800)
    te = teWin()
    if (!te || !sameBounds(te.bounds, want)) {
      const as = await run('/usr/bin/osascript', ['-e', `tell application "TextEdit" to set bounds of front window to {${want.x}, ${want.y}, ${want.x + want.w}, ${want.y + want.h}}`], 8000)
      result.osascriptMove = as.err || 'ok'
      await sleep(800)
      te = teWin()
    }
  }
  result.textEditStart = te || null
  log('TextEdit', te && te.bounds, 'ax', result.axMove, 'osa', result.osascriptMove)
  await shotAndCheck('40-hit-panel-textedit', { hit: rect })

  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
  const trial = async (kind, fn, expectKinds) => {
    const f0 = await frontTextEdit()
    const b0 = teWin()
    const n0 = clicks.length
    const posted = fn()
    await sleep(1500)
    const evs = clicks.slice(n0)
    const f1 = addon.frontmostInfo()
    const b1 = teWin()
    const r = {
      kind,
      axTrusted: posted,
      frontBefore: f0.name,
      frontAfter: f1.name,
      events: evs.map((e) => e.kind),
      eventAppActive: [...new Set(evs.map((e) => e.appActive))],
      eventPos: evs.length ? { x: evs[0].x, y: evs[0].y } : null,
      textEditBefore: b0 && b0.bounds,
      textEditAfter: b1 ? b1.bounds : 'not on screen (swept?)',
      seiActiveAfter: addon.appActive(),
    }
    r.received = expectKinds.every((k) => r.events.includes(k))
    r.keptFront = f0.name === 'TextEdit' && f1.name === 'TextEdit'
    r.notSwept = sameBounds(r.textEditBefore, r.textEditAfter)
    r.neverActive = !r.eventAppActive.includes(true) && !r.seiActiveAfter
    r.pass = r.received && r.keptFront && r.notSwept && r.neverActive
    log('hit trial', r)
    result.hitTrials = result.hitTrials || []
    result.hitTrials.push(r)
    save()
    return r
  }
  const tc = await trial('click', () => addon.testClick(cx, cy), ['click'])
  const td = await trial('dblclick', () => addon.testDoubleClick(cx, cy), ['dblclick'])
  const tg = await trial('drag', () => addon.testDrag(cx - 40, cy, cx + 40, cy, 24), ['drag-start', 'drag-move', 'drag-end'])
  result.checks.hitClick = tc.pass
  result.checks.hitDblclick = td.pass
  result.checks.hitDrag = tg.pass
  await shotAndCheck('41-after-hit-trials', { hit: rect })

  // Rect update from JS: move the panel, click the new spot (expect an event), then the old spot
  // (now bare wallpaper: expect macOS's click-to-show-desktop sweep, the control case).
  const rect2 = { x: Math.round(b.width * 0.55), y: rect.y, w: rect.w, h: rect.h }
  sup.send({ type: 'set-hit-rect', rect: rect2 })
  const hp2 = await sup.waitFor('event', (m) => m.event === 'hit-panel', 4000)
  result.hitPanelMoved = hp2 && hp2.info
  await sleep(500)
  const tn = await trial('click-new-rect', () => addon.testClick(rect2.x + rect2.w / 2, rect2.y + rect2.h / 2), ['click'])
  result.checks.hitRectUpdate = tn.pass
  const to = await trial('click-old-rect-control', () => addon.testClick(cx, cy), [])
  result.checks.controlWallpaperClickSweeps = !to.notSwept || to.frontAfter !== 'TextEdit'
  result.checks.oldRectNoEvent = to.events.length === 0
  if (!to.notSwept) {
    // restore the swept windows (second wallpaper click toggles them back)
    addon.testClick(cx, cy)
    await sleep(1500)
  }
  await shotAndCheck('42-after-control-click', { hit: rect2 })
  // put the panel back where the coverage tests expect it
  sup.send({ type: 'set-hit-rect', rect })
  await sleep(800)
  result.hitRect = rect
  save()
}

async function macCoverage() {
  const b = screen.getPrimaryDisplay().bounds
  const wa = screen.getPrimaryDisplay().workArea
  const rect = result.hitRect
  let te = teWin()
  if (!te) {
    await run('/usr/bin/open', ['-a', 'TextEdit', path.join(OUT, 'textedit.txt')])
    await sleep(2500)
    te = teWin()
  }
  await frontTextEdit()
  await sleep(800)
  const small = await measure('mac-small-window', 4000)
  result.checks.smallWindowNotCovered = small.covered === false

  // 1) zoom TextEdit over the work area (a maximized app) -> covered
  let t = Date.now()
  result.axZoom = te ? addon.axSetFrame(te.pid, { x: wa.x, y: wa.y, w: wa.width, h: wa.height }) : 'no TextEdit'
  let c1 = await waitCovered(true, 6000, t)
  if (!c1 && te) {
    const as = await run('/usr/bin/osascript', ['-e', `tell application "TextEdit" to set bounds of front window to {${wa.x}, ${wa.y}, ${wa.x + wa.width}, ${wa.y + wa.height}}`], 8000)
    result.osascriptZoom = as.err || 'ok'
    c1 = await waitCovered(true, 6000, t)
  }
  result.numbers.coverZoom = c1
  await sleep(800)
  await shotAndCheck('50-zoomed-textedit', { hit: rect })
  const mz = await measure('mac-covered-zoomed', 5000)
  result.checks.zoomedCovered = !!c1 && mz.fpsMedian === 0
  result.occlusionLog = []

  // 2) show desktop -> uncovered
  const attempts = [
    ['mission-control-1', async () => run('/System/Applications/Mission Control.app/Contents/MacOS/Mission Control', ['1'], 6000)],
    ['f11', async () => addon.testKey(103, 0)],
    ['fn-f11', async () => addon.testKey(103, 0x800000)],
    ['wallpaper-click', async () => addon.testClick(Math.round(b.width * 0.9), Math.round(b.height * 0.92))],
  ]
  let u1 = null
  let via = null
  for (const [name, fn] of attempts) {
    t = Date.now()
    const r = await fn()
    u1 = await waitCovered(false, 4000, t)
    log('show desktop via', name, '->', u1, r && r.err)
    if (!u1 && name === 'mission-control-1') {
      addon.testKey(53, 0) // Escape, in case it opened Mission Control instead
      await sleep(1200)
    }
    if (u1) {
      via = name
      break
    }
  }
  result.numbers.uncoverShowDesktop = { ...(u1 || {}), via }
  await sleep(1000)
  const D1 = await shotAndCheck('51-show-desktop-a', { hit: rect })
  const mu = await measure('mac-uncovered-show-desktop', 5000)
  const D2 = await shotAndCheck('52-show-desktop-b', { hit: rect })
  result.checks.showDesktopUncovered = !!u1 && mu.fpsMedian > 20 && judge(D1, D2).animates
  result.textEditAfterShowDesktop = teWin() ? teWin().bounds : 'not on screen'
  // undo show desktop (same gesture toggles back), then close TextEdit
  if (via === 'mission-control-1') await run('/System/Applications/Mission Control.app/Contents/MacOS/Mission Control', ['1'], 6000)
  else if (via === 'f11') addon.testKey(103, 0)
  else if (via === 'fn-f11') addon.testKey(103, 0x800000)
  else if (via === 'wallpaper-click') addon.testClick(Math.round(b.width * 0.9), Math.round(b.height * 0.92))
  await sleep(1500)
  await run('/usr/bin/osascript', ['-e', 'quit app "TextEdit" saving no'], 8000)
  await run('/usr/bin/pkill', ['-x', 'TextEdit'])
  await sleep(1500)
  const after = await measure('mac-textedit-closed', 3000)
  result.checks.uncoveredAfterClose = after.covered === false

  // 3) an Electron simple-fullscreen window -> covered
  t = Date.now()
  const fw = new BrowserWindow({ ...b, simpleFullscreen: true, backgroundColor: '#204020', title: 'SeiLink fullscreen', show: false })
  await fw.loadURL('data:text/html,<body style="background:#204020;color:#fff;font:40px sans-serif">fullscreen app</body>')
  fw.show()
  fw.setSimpleFullScreen(true)
  const c2 = await waitCovered(true, 6000, t)
  result.numbers.coverFullscreen = c2
  const mf = await measure('mac-covered-fullscreen', 4000)
  result.checks.fullscreenCovered = !!c2 && mf.fpsMedian === 0
  t = Date.now()
  fw.setSimpleFullScreen(false)
  fw.close()
  const u2 = await waitCovered(false, 6000, t)
  result.numbers.uncoverFullscreenClosed = u2
  await sleep(1000)
  result.coverageEvents = covEvents.map((c) => ({ t: c.recvAt - T0, covered: c.covered, reason: c.reason }))
  save()
}

async function macShellRestarts() {
  for (const proc of ['Dock', 'Finder']) {
    const t = Date.now()
    const exits = []
    const onExit = (r) => exits.push(r.exit)
    sup.on('exit', onExit)
    await run('/usr/bin/killall', [proc])
    await sleep(6000)
    sup.off('exit', onExit)
    const hb = await sup.waitFor('heartbeat', () => true, 3000)
    const r = { hostExits: exits, attached: hb && hb.attached, fps: hb && hb.fps, covered: hb && hb.covered, ms: Date.now() - t }
    const A = await shotAndCheck(`6${proc === 'Dock' ? 0 : 2}-after-${proc.toLowerCase()}-a`)
    await sleep(2000)
    const B = await shotAndCheck(`6${proc === 'Dock' ? 1 : 3}-after-${proc.toLowerCase()}-b`)
    r.judge = judge(A, B)
    result.numbers[`kill${proc}`] = r
    result.checks[`survives${proc}Restart`] = exits.length === 0 && r.judge.visible
    log('after killall', proc, r)
  }
  save()
}

// ---------------------------------------------------------------- run
async function scenario() {
  startLag()
  result.display = { bounds: screen.getPrimaryDisplay().bounds, scale: screen.getPrimaryDisplay().scaleFactor }
  if (IS_MAC) result.macLevels = addon.levels()
  await createMainWindow()
  await common()
  if (IS_WIN) {
    await winCoverage()
    await winShellEvents()
    await winExplorerKill()
  } else if (IS_MAC) {
    await macHit()
    await macCoverage()
    await macShellRestarts()
  }
  result.numbers.ramEnd = { main: mainRam(), host: lastHb && { totalWorkingSetMB: lastHb.ramMB, procs: lastHb.procs } }
  result.restarts = sup.restarts
  result.mainAliveEnd = await mainWindowAlive()
  save()
}

app.on('window-all-closed', () => {})
const hardStop = setTimeout(() => {
  log('HARD TIMEOUT')
  result.hardTimeout = true
  save()
  try { sup.stop() } catch {}
  setTimeout(() => app.exit(3), 1000)
}, Number(argv.timeout || 380) * 1000)

if (IS_MAC && app.setActivationPolicy) app.setActivationPolicy('accessory')
app
  .whenReady()
  .then(scenario)
  .then(() => 0, (e) => {
    log('FATAL', String(e && e.stack))
    result.fatal = String(e && e.stack)
    return 1
  })
  .then(async (code) => {
    result.seconds = (Date.now() - T0) / 1000
    save()
    clearTimeout(hardStop)
    sup.stop()
    await sleep(1500)
    log('done', code)
    app.exit(code)
  })
