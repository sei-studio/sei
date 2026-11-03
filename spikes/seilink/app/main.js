// SeiLink spike runner. Technical spike only, NO product UI.
//
// One launch = one variant. It creates a full-screen test-pattern window, attaches it to the
// desktop layer (Windows: Progman/WorkerW parenting; macOS: native window level), dumps the
// window tree, takes screenshots, checks them by pixel, measures FPS/RAM and writes
// <out>/result.json + log.txt. See ../README.md for the variant list.
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

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

const PRESETS = {
  // Windows
  baseline: { noWindow: true },
  auto: { mode: 'auto', full: true },
  'auto-showfirst': { mode: 'auto', showFirst: true },
  'auto-nodcomp': { mode: 'auto', switches: [['disable-direct-composition']] },
  'auto-nogpu': { mode: 'auto', switches: [['disable-gpu']] },
  'auto-noocclusion': {
    mode: 'auto',
    noThrottle: true,
    switches: [['disable-features', 'CalculateNativeWinOcclusion']],
  },
  workerw: { mode: 'workerw', full: true },
  'explorer-restart': { mode: 'auto', explorerRestart: true },
  // Supervisor + room in a child Electron process that re-attaches itself on a new Explorer.
  'explorer-restart-child': { explorerRestartChild: true },
  'room-child': { mode: 'auto', roomOnly: true },
  // macOS
  'mac-baseline': { noWindow: true },
  'electron-desktop': { mac: 'electron-desktop' },
  'native-icon-1': { mac: 'native', levelKey: 'desktopIcon', delta: -1, full: true, proxy: true },
  'native-desktop+1': { mac: 'native', levelKey: 'desktop', delta: 1 },
  'native-icon-1-nothrottle': { mac: 'native', levelKey: 'desktopIcon', delta: -1, noThrottle: true },
}
const variant = String(argv.variant || (IS_MAC ? 'native-icon-1' : 'auto'))
const preset = PRESETS[variant]
if (!preset) {
  console.error('unknown variant', variant)
  process.exit(2)
}
const OUT = path.resolve(String(argv.out || path.join(ROOT, 'out', variant)))
fs.mkdirSync(OUT, { recursive: true })
for (const s of preset.switches || []) app.commandLine.appendSwitch(...s)

const T0 = Date.now()
const logFile = path.join(OUT, 'log.txt')
function log(...a) {
  const line = `[${((Date.now() - T0) / 1000).toFixed(2)}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = { variant, preset, platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, checks: {}, fps: [], proxyClicks: [] }
function save() {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
}
function dump(name, obj) {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(obj, null, 2))
}

let addon = null
try {
  addon = require(path.join(ROOT, 'build', 'Release', 'seilink.node'))
} catch (e) {
  result.addonError = String(e && e.stack)
}

// ---------------------------------------------------------------- renderer telemetry
let latestRoom = null
let childFrames = null
ipcMain.on('frame', (_e, d) => {
  latestRoom = d
  result.fps.push({ t: +((Date.now() - T0) / 1000).toFixed(1), fps: +d.fps.toFixed(1), frames: d.frames, vis: d.vis, phase })
})
ipcMain.on('proxy-click', (_e, d) => {
  result.proxyClicks.push(d)
  log('proxy mousedown', d)
})
let phase = 'start'

// ---------------------------------------------------------------- screenshots + pixel check
function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ err: err ? String(err.message || err) : null, stdout: String(stdout).trim(), stderr: String(stderr).trim() }),
    )
  })
}

async function shot(name, { dc = false } = {}) {
  const file = path.join(OUT, `${name}.png`)
  const framesAt = latestRoom ? latestRoom.frames : childFrames ? childFrames() : null
  let r
  if (argv['no-shots']) return { file, framesAt, ok: false }
  if (IS_WIN) {
    r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'shot-win.ps1'), '-Path', file])
  } else if (IS_MAC) {
    r = await run('/usr/sbin/screencapture', ['-x', '-C', file])
  } else {
    r = { err: 'no screenshot tool on this platform' }
  }
  if (r.err) log('shot error', name, r.err, r.stderr)
  if (dc && IS_WIN) {
    // Second opinion through Chromium's own capturer (WGC/DXGI duplication path).
    try {
      const b = screen.getPrimaryDisplay().bounds
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: b.width, height: b.height } })
      if (sources[0]) fs.writeFileSync(path.join(OUT, `${name}-dc.png`), sources[0].thumbnail.toPNG())
    } catch (e) {
      log('desktopCapturer error', String(e))
    }
  }
  return { file, framesAt, ok: !r.err && fs.existsSync(file) }
}

// Region stats in screen DIP coords; scaled to the image.
function analyze(file, regions = {}) {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return { error: 'empty image' }
  const { width: W, height: H } = img.getSize()
  const bmp = img.toBitmap()
  const disp = screen.getPrimaryDisplay().bounds
  const sx = W / disp.width
  const sy = H / disp.height
  const px = (x, y) => {
    const i = (y * W + x) * 4
    return [bmp[i], bmp[i + 1], bmp[i + 2]]
  }
  const isMag = ([a, g, b]) => a > 180 && b > 180 && g < 90
  const isGreen = ([a, g, b]) => g > 180 && a < 90 && b < 90
  function stats(rx, ry, rw, rh) {
    const x0 = Math.max(0, Math.round(rx * sx)), y0 = Math.max(0, Math.round(ry * sy))
    const x1 = Math.min(W, Math.round((rx + rw) * sx)), y1 = Math.min(H, Math.round((ry + rh) * sy))
    let n = 0, mag = 0, green = 0, gx = 0, gy = 0
    for (let y = y0; y < y1; y += 2)
      for (let x = x0; x < x1; x += 2) {
        const p = px(x, y)
        n++
        if (isMag(p)) mag++
        else if (isGreen(p)) {
          green++
          gx += x
          gy += y
        }
      }
    return {
      magenta: n ? +(mag / n).toFixed(3) : 0,
      green: n ? +(green / n).toFixed(4) : 0,
      greenCentroid: green > 50 ? { x: Math.round(gx / green / sx), y: Math.round(gy / green / sy) } : null,
    }
  }
  const out = { size: `${W}x${H}`, all: stats(0, 0, disp.width, disp.height) }
  for (const [k, r] of Object.entries(regions)) if (r) out[k] = stats(r.x, r.y, r.w, r.h)
  return out
}

function baseRegions() {
  const b = screen.getPrimaryDisplay().bounds
  // Windows icons sit in the top-left column, Finder icons in the top-right column.
  const iconColumn = IS_MAC ? { x: b.width - 120, y: 30, w: 120, h: Math.min(700, b.height - 60) } : { x: 0, y: 0, w: 90, h: Math.min(560, b.height - 60) }
  const center = { x: b.width * 0.35, y: b.height * 0.35, w: b.width * 0.3, h: b.height * 0.3 }
  // The ticker band of pattern.html (y 79%..89%), clear of the icon column and of CI console windows.
  const band = { x: b.width * 0.12, y: b.height * 0.8, w: b.width * 0.76, h: b.height * 0.08 }
  return { iconColumn, center, band }
}

async function shotAndCheck(name, extraRegions = {}, opts = {}) {
  const s = await shot(name, opts)
  const a = s.ok ? analyze(s.file, { ...baseRegions(), ...extraRegions }) : { error: 'no shot' }
  const rec = { name, framesAt: s.framesAt, ...a }
  if (opts.dc && fs.existsSync(path.join(OUT, `${name}-dc.png`))) rec.dc = analyze(path.join(OUT, `${name}-dc.png`), { ...baseRegions(), ...extraRegions })
  log('shot', rec)
  result.shots = result.shots || []
  result.shots.push(rec)
  save()
  return rec
}

// Pixel verdicts from two shots. Uses the GDI/screencapture image, else the desktopCapturer one.
function pick(S) {
  return S && S.band ? S : S && S.dc && S.dc.band ? S.dc : null
}
function judge(A, B) {
  const a = pick(A), b = pick(B)
  if (!a || !b) return { visible: false, animates: false, iconsOver: false, source: null }
  const ca = a.band.greenCentroid, cb = b.band.greenCentroid
  return {
    source: a === A ? 'screenshot' : 'desktopCapturer',
    visible: a.band.magenta > 0.3 && b.band.magenta > 0.3,
    animates: !!(ca && cb && Math.abs(ca.x - cb.x) > 15) && B.framesAt > A.framesAt,
    iconsOver: a.iconColumn.magenta < a.band.magenta - 0.08,
    centerMagenta: a.center.magenta,
  }
}

// ---------------------------------------------------------------- RAM
function ram(label) {
  const m = app.getAppMetrics()
  const per = m.map((p) => ({ type: p.type, pid: p.pid, wsMB: +(p.memory.workingSetSize / 1024).toFixed(1), privMB: p.memory.privateBytes != null ? +(p.memory.privateBytes / 1024).toFixed(1) : null }))
  const total = per.reduce((s, p) => s + p.wsMB, 0)
  const totalPriv = per.reduce((s, p) => s + (p.privMB || 0), 0)
  const r = { label, totalWorkingSetMB: +total.toFixed(1), totalPrivateMB: totalPriv ? +totalPriv.toFixed(1) : null, processes: per }
  result.ram = result.ram || []
  result.ram.push(r)
  log('ram', label, r.totalWorkingSetMB, 'MB working set,', r.totalPrivateMB, 'MB private,', per.length, 'processes')
  return r
}

// ---------------------------------------------------------------- room window
let room = null
let roomClosedAt = null

function displayBoundsPx() {
  const d = screen.getPrimaryDisplay()
  const b = d.bounds
  const s = d.scaleFactor
  return { x: Math.round(b.x * s), y: Math.round(b.y * s), w: Math.round(b.width * s), h: Math.round(b.height * s), scale: s }
}

async function createRoom() {
  const b = screen.getPrimaryDisplay().bounds
  const opts = {
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
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: !preset.noThrottle },
  }
  if (IS_MAC && preset.mac === 'electron-desktop') opts.type = 'desktop'
  const w = new BrowserWindow(opts)
  w.on('closed', () => {
    roomClosedAt = Date.now()
    log('room window CLOSED (hwnd destroyed?)')
    if (room === w) room = null
  })
  w.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d))
  const ready = new Promise((r) => w.once('ready-to-show', () => r('ready-to-show')))
  w.loadFile(path.join(__dirname, 'pattern.html'), { query: { variant } })
  log('room created; waiting:', await Promise.race([ready, sleep(5000).then(() => 'timeout')]))
  room = w
  return w
}

async function attachWin(w) {
  const hwnd = w.getNativeWindowHandle()
  const px = displayBoundsPx()
  if (preset.showFirst) {
    w.showInactive()
    await sleep(600)
  }
  const res = addon.attach(hwnd, { mode: preset.mode, x: px.x, y: px.y, w: px.w, h: px.h })
  log('attach', res.ok ? 'OK' : 'FAILED', res.method, res.error || '')
  for (const s of res.steps || []) log('  step', s)
  if (!preset.showFirst) w.showInactive()
  await sleep(500)
  return res
}

async function attachMac(w) {
  const levels = addon.levels()
  const beh = addon.behaviors()
  let res = { method: 'electron type:desktop (Electron sets kCGDesktopWindowLevel - 1)' }
  if (preset.mac === 'native') {
    const level = levels[preset.levelKey] + preset.delta
    res = addon.setLevel(w.getNativeWindowHandle(), { level, behavior: beh.canJoinAllSpaces | beh.stationary | beh.ignoresCycle, ignoresMouse: true })
    res.method = `native level ${preset.levelKey}${preset.delta > 0 ? '+' : ''}${preset.delta} = ${level}, canJoinAllSpaces|stationary|ignoresCycle, ignoresMouseEvents`
  }
  w.showInactive()
  await sleep(500)
  res.afterShow = addon.windowInfo(w.getNativeWindowHandle())
  log('mac attach', res.method, 'level after show:', res.afterShow.level, 'frame:', res.afterShow.frame)
  return res
}

function treeDump(name) {
  try {
    const t = IS_WIN ? addon.inspect(room ? room.getNativeWindowHandle() : undefined) : { windowList: addon.windowList(), room: room ? addon.windowInfo(room.getNativeWindowHandle()) : null }
    dump(name, t)
    return t
  } catch (e) {
    log('treeDump error', String(e))
    return null
  }
}

function summarizeWinTree(t) {
  if (!t || !t.desk) return null
  const ours = t.oursChain && t.oursChain[0]
  return {
    os: `${t.os.product} ${t.os.displayVersion} build ${t.os.build}.${t.os.ubr}`,
    layout: t.desk.layout,
    progmanExStyle: t.desk.progman.exStyle,
    progmanChildren: (t.progmanChildren || []).map((c) => `${c.z}:${c.class}${c.hwnd === (ours && ours.hwnd) ? '(OURS)' : ''}[${(c.flags || []).join('|')}]`),
    oursParentChain: (t.oursChain || []).map((c) => `${c.class}`),
    oursFlags: ours && ours.flags,
    topLevelShell: (t.topLevel || []).filter((w) => ['Progman', 'WorkerW', 'Shell_TrayWnd'].includes(w.class) || w.hasDefView).map((w) => `${w.z}:${w.class}${w.hasDefView ? '(DefView)' : ''}${w.visible ? '' : '(hidden)'}`),
  }
}

// ---------------------------------------------------------------- scenario
function fpsSummary(ph) {
  const xs = result.fps.filter((f) => f.phase === ph).map((f) => f.fps).sort((a, b) => a - b)
  if (!xs.length) return null
  return { n: xs.length, median: xs[Math.floor(xs.length / 2)], min: xs[0], max: xs[xs.length - 1] }
}

async function scenario() {
  log('variant', variant, 'preset', preset, 'electron', process.versions.electron)
  log('display', screen.getPrimaryDisplay().bounds, 'scale', screen.getPrimaryDisplay().scaleFactor)
  if (!addon) throw new Error('addon failed to load: ' + result.addonError)
  if (IS_MAC) {
    result.macLevels = addon.levels()
    log('mac levels', result.macLevels)
  }
  const before = treeDump('tree-before')
  if (IS_WIN) {
    result.winBefore = summarizeWinTree(before)
    log('win before', result.winBefore)
  }
  if (preset.roomOnly) return roomOnly()
  await shotAndCheck('00-before')
  if (preset.explorerRestartChild) return explorerRestartChild()
  if (preset.noWindow) return

  phase = 'visible'
  const w = await createRoom()
  result.attach = IS_WIN ? await attachWin(w) : await attachMac(w)
  save()
  const after = treeDump('tree-attached')
  if (IS_WIN) {
    result.winAttached = summarizeWinTree(after)
    log('win attached', result.winAttached)
  } else if (after) {
    const mine = after.windowList.filter((x) => x.pid === process.pid)
    result.macAttached = { ours: mine, finderDesktop: after.windowList.filter((x) => x.owner === 'Finder' || x.owner === 'Dock' || x.owner === 'WindowManager').map((x) => ({ owner: x.owner, layer: x.layer, name: x.name, bounds: x.bounds, z: x.z })) }
    log('mac window list (ours):', mine.map((x) => ({ layer: x.layer, z: x.z, bounds: x.bounds })))
  }

  let proxy = null
  if (preset.proxy) proxy = await createProxy()

  if (argv.hold) {
    // Real-machine mode: keep the room up so a human/VNC can screenshot and click it.
    log(`HOLD ${argv.hold}s: take screenshots / click the yellow hit proxy now`)
    phase = 'hold'
    await sleep(Number(argv.hold) * 1000)
    result.checks.fpsHold = fpsSummary('hold')
    phase = 'visible'
  }
  await sleep(2500)
  const A = await shotAndCheck('01-a', {}, { dc: true })
  await sleep(3000)
  const B = await shotAndCheck('02-b', {}, { dc: true })
  const J = judge(A, B)
  result.checks.pixelSource = J.source
  result.checks.rendersBehindIcons = J.visible
  result.checks.animates = J.animates
  result.checks.iconColumnLessMagenta = J.iconsOver
  result.checks.framesBetweenShots = A.framesAt != null && B.framesAt != null ? B.framesAt - A.framesAt : null
  result.checks.fpsVisible = fpsSummary('visible')
  ram('steady-visible')
  log('checks', result.checks)
  save()

  if (preset.full && IS_WIN) await fullWin()
  if (preset.full && IS_MAC) await fullMac(proxy)
  if (preset.explorerRestart && IS_WIN) await explorerRestart()
  ram('end')
}

async function fullWin() {
  const b = screen.getPrimaryDisplay().bounds
  addon.rawInputStart()
  await sleep(400)
  // 1) click on empty desktop while desktop has focus
  const pt = { x: Math.round(b.width * 0.62), y: Math.round(b.height * 0.84) }
  addon.testClick(pt.x, pt.y)
  await sleep(800)
  result.rawInput1 = addon.rawInputStats()
  result.foregroundAfterDesktopClick = addon.foreground()
  log('raw input after desktop click', result.rawInput1, 'fg', result.foregroundAfterDesktopClick.class, 'roomFocused', room && room.isFocused())

  // 2) a normal app window on top
  phase = 'covered'
  const txt = path.join(OUT, 'notepad.txt')
  fs.writeFileSync(txt, 'SeiLink spike: this normal window must cover the room.\r\n'.repeat(30))
  const np = cp.spawn('notepad.exe', [txt], { detached: true, stdio: 'ignore' })
  await sleep(3000)
  const tops = addon.findTop('Notepad')
  result.notepad = tops
  const r = tops[0] && tops[0].rect
  log('notepad windows', tops.map((t) => t.rect))
  const C = await shotAndCheck('03-notepad', { cover: r && { x: r.x + 10, y: r.y + 40, w: r.w - 20, h: r.h - 50 } }, { dc: true })
  const pc = pick(C)
  result.checks.normalWindowCovers = !!(pc && pc.cover && pc.cover.magenta < 0.03 && pc.band.magenta > 0.3)
  result.checks.fpsCovered = fpsSummary('covered')

  // 3) click on empty desktop while Notepad is the foreground app (outside Notepad)
  const pt2 = { x: Math.round(b.width * 0.95), y: Math.round(b.height * 0.84) }
  addon.testClick(pt2.x, pt2.y)
  await sleep(800)
  result.rawInput2 = addon.rawInputStats()
  log('raw input after 2nd click', result.rawInput2)
  result.checks.rawInputSeesDesktopClicks = (result.rawInput2.clicks || []).filter((c) => c.includes(',desktop,')).length
  try {
    np.kill()
    cp.execFileSync('taskkill', ['/F', '/IM', 'notepad.exe'], { stdio: 'ignore' })
  } catch {}
  phase = 'visible2'
  await sleep(1500)
  await shotAndCheck('04-after-notepad', {}, { dc: true })
  result.checks.fpsAfterCover = fpsSummary('visible2')
  save()
}

async function createProxy() {
  const b = screen.getPrimaryDisplay().bounds
  const rect = { x: Math.round(b.width * 0.22), y: Math.round(b.height * 0.66), width: 240, height: 90 }
  const p = new BrowserWindow({
    ...rect,
    type: 'panel',
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    acceptFirstMouse: true,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  await p.loadFile(path.join(__dirname, 'proxy.html'))
  const lv = addon.levels()
  const beh = addon.behaviors()
  const res = addon.setLevel(p.getNativeWindowHandle(), { level: lv.desktopIcon + 1, behavior: beh.canJoinAllSpaces | beh.stationary | beh.ignoresCycle, ignoresMouse: false })
  p.showInactive()
  await sleep(400)
  result.proxy = { rect, setLevel: res, afterShow: addon.windowInfo(p.getNativeWindowHandle()) }
  log('hit proxy', result.proxy.afterShow)
  return p
}

function textEditWindow() {
  return addon.windowList().find((x) => x.owner === 'TextEdit' && x.layer === 0 && x.bounds.w > 100)
}

async function fullMac(proxy) {
  const b = screen.getPrimaryDisplay().bounds
  phase = 'covered'
  const txt = path.join(OUT, 'textedit.txt')
  fs.writeFileSync(txt, 'SeiLink spike: this normal window must cover the room.\n'.repeat(30))
  await run('/usr/bin/open', ['-a', 'TextEdit', txt])
  await sleep(4000)
  const te = textEditWindow()
  result.textEdit = te || null
  log('TextEdit window', te)
  const r = te && te.bounds
  const C = await shotAndCheck('03-textedit', { cover: r && { x: r.x + 10, y: r.y + 40, w: r.w - 20, h: r.h - 50 } })
  result.checks.normalWindowCovers = !!(C.cover && C.cover.magenta < 0.03)
  result.checks.fpsCovered = fpsSummary('covered')
  result.frontmostBefore = addon.frontmost()

  // Click tests (test harness stand-in for a hand; needs Accessibility for CGEventPost).
  const activateTextEdit = async () => {
    await run('/usr/bin/open', ['-a', 'TextEdit'])
    await sleep(1500)
    return addon.frontmost()
  }
  if (proxy) {
    // A) plain AppKit non-activating NSPanel at desktopIcon+1: does a click activate us at all?
    const lv = addon.levels()
    const nr = { x: Math.round(b.width * 0.5), y: Math.round(b.height * 0.66), w: 240, h: 90 }
    result.nativeProxy = { rect: nr, info: addon.nativeProxy({ ...nr, level: lv.desktopIcon + 1 }) }
    await sleep(600)
    const fA = addon.frontmost()
    addon.testClick(nr.x + nr.w / 2, nr.y + nr.h / 2)
    await sleep(1200)
    const teA = textEditWindow()
    result.afterNativeProxyClick = { frontmostBefore: fA, clicks: addon.nativeProxyClicks(), frontmost: addon.frontmost(), textEditBounds: teA && teA.bounds }
    log('after native NSPanel proxy click', result.afterNativeProxyClick)
    result.checks.nativeProxyReceivesClick = addon.nativeProxyClicks() > 0
    result.checks.nativeProxyKeepsFrontApp = result.afterNativeProxyClick.frontmost === fA && fA === 'TextEdit'

    // B) Electron type:'panel' proxy at desktopIcon+1.
    const fB = await activateTextEdit()
    const pr = result.proxy.rect
    const n0 = result.proxyClicks.length
    result.clickPosted1 = addon.testClick(pr.x + pr.width / 2, pr.y + pr.height / 2)
    await sleep(1200)
    const te1 = textEditWindow()
    result.afterProxyClick = { frontmostBefore: fB, proxyClicks: result.proxyClicks.length - n0, frontmost: addon.frontmost(), textEditBounds: te1 && te1.bounds, axTrusted: result.clickPosted1 }
    log('after Electron panel proxy click', result.afterProxyClick)
    result.checks.proxyReceivesClick = result.proxyClicks.length > n0
    result.checks.proxyKeepsFrontApp = result.afterProxyClick.frontmost === fB && fB === 'TextEdit'
    await shotAndCheck('03b-after-proxy-clicks')

    // C) empty wallpaper click (no proxy there) with TextEdit frontmost: does macOS sweep windows away?
    const fC = await activateTextEdit()
    const n1 = result.proxyClicks.length
    addon.testClick(Math.round(b.width * 0.85), Math.round(b.height * 0.3))
    await sleep(1800)
    const te2 = textEditWindow()
    result.afterWallpaperClick = { frontmostBefore: fC, proxyClicks: result.proxyClicks.length - n1, frontmost: addon.frontmost(), textEditBounds: te2 ? te2.bounds : 'not on screen (swept?)' }
    log('after wallpaper click', result.afterWallpaperClick)
    await shotAndCheck('04-after-wallpaper-click')
    addon.nativeProxyClose()
  }
  await run('/usr/bin/osascript', ['-e', 'quit app "TextEdit" saving no'], 8000).catch(() => {})
  await run('/usr/bin/pkill', ['-x', 'TextEdit'])
  phase = 'visible2'
  await sleep(1500)
  result.checks.fpsAfterCover = fpsSummary('visible2')
  save()
}

async function explorerRestart() {
  phase = 'explorer'
  const st0 = addon.status(room.getNativeWindowHandle())
  log('status before explorer kill', st0)
  const tKill = Date.now()
  await run('taskkill', ['/F', '/IM', 'explorer.exe'])
  let started = false
  let reattached = false
  const timeline = []
  for (let i = 0; i < 120 && !reattached; i++) {
    await sleep(250)
    const alive = room && !room.isDestroyed()
    const st = addon.status(alive ? room.getNativeWindowHandle() : Buffer.alloc(8))
    if (i % 4 === 0) timeline.push({ ms: Date.now() - tKill, roomAlive: alive, ...st })
    if (!started && Date.now() - tKill > 6000 && !st.explorerPid) {
      log('explorer did not auto-restart; starting explorer.exe')
      cp.spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref()
      started = true
    }
    if (st.defViewExists && st.explorerPid && st.explorerPid !== st0.explorerPid) {
      await sleep(2000)  // let the new shell finish building Progman/DefView/WorkerW
      if (!room || room.isDestroyed()) {
        log('room window was destroyed with old Explorer; recreating')
        await createRoom()
      } else {
        log('room window survived; parent now', addon.status(room.getNativeWindowHandle()))
      }
      result.reattach = await attachWin(room)
      result.reattach.ms = Date.now() - tKill
      reattached = !!result.reattach.ok
      break
    }
  }
  result.explorerTimeline = timeline
  result.checks.explorerRestartReattached = reattached
  result.checks.roomDestroyedByExplorerExit = roomClosedAt != null
  treeDump('tree-after-explorer-restart')
  result.winAfterExplorer = summarizeWinTree(addon.inspect(room ? room.getNativeWindowHandle() : undefined))
  log('after explorer restart', result.winAfterExplorer)
  phase = 'visible3'
  await sleep(3000)
  const D = await shotAndCheck('05-after-explorer-restart', {}, { dc: true })
  await sleep(2000)
  const E = await shotAndCheck('06-after-explorer-restart-b', {}, { dc: true })
  const JR = judge(D, E)
  result.checks.rendersAfterRestart = JR.visible
  result.checks.animatesAfterRestart = JR.animates
  save()
}

// Child: room + attach, then watch for a new Explorer and re-attach in place (or recreate the room).
async function roomOnly() {
  phase = 'visible'
  const w = await createRoom()
  result.attach = await attachWin(w)
  save()
  setInterval(save, 1000)
  setTimeout(() => ram('child-steady'), 5000)
  let pid0 = addon.status(w.getNativeWindowHandle()).explorerPid
  result.watch = []
  for (;;) {
    await sleep(300)
    const alive = room && !room.isDestroyed()
    const st = addon.status(alive ? room.getNativeWindowHandle() : Buffer.alloc(8))
    if (st.explorerPid !== pid0 && result.watch.length < 40) result.watch.push({ ms: Date.now() - T0, alive, ...st })
    if (st.explorerPid && st.explorerPid !== pid0 && st.defViewExists) {
      log('child: new Explorer', st, 'room alive', alive)
      await sleep(1500)
      if (!room || room.isDestroyed()) {
        log('child: room was destroyed; recreating')
        await createRoom()
      }
      result.reattach = await attachWin(room)
      result.reattach.atMs = Date.now() - T0
      result.winAfterExplorer = summarizeWinTree(addon.inspect(room.getNativeWindowHandle()))
      log('child: reattached', result.reattach.ok, result.winAfterExplorer)
      pid0 = st.explorerPid
      phase = 'visible3'
      save()
    }
  }
}

function spawnChild(tag) {
  const out = path.join(OUT, `child-${tag}`)
  const p = cp.spawn(process.execPath, [ROOT, '--variant=room-child', `--out=${out}`, '--timeout=150', '--no-shots'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  })
  const rec = { tag, pid: p.pid, out, exit: null, stderrTail: '' }
  p.stderr.on('data', (d) => (rec.stderrTail = (rec.stderrTail + d).slice(-4000)))
  p.on('exit', (code, sig) => {
    rec.exit = { code, sig, hex: code != null ? '0x' + (code >>> 0).toString(16) : null, atMs: Date.now() - T0 }
    log('child exit', tag, rec.exit)
  })
  return { p, rec }
}
function readChild(c) {
  try {
    return JSON.parse(fs.readFileSync(path.join(c.rec.out, 'result.json'), 'utf8'))
  } catch {
    return null
  }
}
async function waitChildFrames(c, ms) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const r = readChild(c)
    if (r && r.attach && r.fps.length >= 2) return r
    await sleep(300)
  }
  return readChild(c)
}

async function explorerRestartChild() {
  phase = 'visible'
  let c = spawnChild('a')
  const children = [c]
  childFrames = () => {
    const r = readChild(c)
    return r && r.fps.length ? r.fps[r.fps.length - 1].frames : null
  }
  const r0 = await waitChildFrames(c, 20000)
  result.attach = r0 && r0.attach
  log('child a attach', result.attach && result.attach.ok, result.attach && result.attach.method)
  await sleep(1500)
  const A = await shotAndCheck('01-a', {}, { dc: true })
  await sleep(3000)
  const B = await shotAndCheck('02-b', {}, { dc: true })
  const J = judge(A, B)
  Object.assign(result.checks, { pixelSource: J.source, rendersBehindIcons: J.visible, animates: J.animates, iconColumnLessMagenta: J.iconsOver })

  phase = 'explorer'
  const st0 = addon.status(Buffer.alloc(8))
  log('status before explorer kill', st0)
  const tKill = Date.now()
  await run('taskkill', ['/F', '/IM', 'explorer.exe'])
  let started = false
  let newShell = null
  const timeline = []
  for (let i = 0; i < 100; i++) {
    await sleep(250)
    const st = addon.status(Buffer.alloc(8))
    if (i % 4 === 0) timeline.push({ ms: Date.now() - tKill, childAlive: c.rec.exit == null, ...st })
    if (!started && Date.now() - tKill > 6000 && !st.explorerPid) {
      log('explorer did not auto-restart; starting explorer.exe')
      cp.spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref()
      started = true
    }
    if (st.defViewExists && st.explorerPid && st.explorerPid !== st0.explorerPid) {
      newShell = { ms: Date.now() - tKill, ...st }
      break
    }
  }
  result.explorerTimeline = timeline
  result.newShell = newShell
  log('new shell', newShell)
  await sleep(4000)
  result.checks.childDiedOnExplorerExit = c.rec.exit != null
  if (c.rec.exit != null) {
    log('child a died with Explorer; respawning child b')
    c = spawnChild('b')
    children.push(c)
    const rb = await waitChildFrames(c, 20000)
    result.reattach = rb && rb.attach
    result.checks.recoveredBy = 'respawn'
  } else {
    const ra = readChild(c)
    result.reattach = ra && ra.reattach
    result.checks.recoveredBy = ra && ra.reattach ? 'in-place re-attach' : 'none'
  }
  result.checks.recoveryMsAfterKill = Date.now() - tKill
  phase = 'visible3'
  await sleep(2000)
  const D = await shotAndCheck('05-after-explorer-restart', {}, { dc: true })
  await sleep(3000)
  const E = await shotAndCheck('06-after-explorer-restart-b', {}, { dc: true })
  const JR = judge(D, E)
  result.checks.rendersAfterRestart = JR.visible
  result.checks.animatesAfterRestart = JR.animates
  result.checks.explorerRestartReattached = !!(result.reattach && result.reattach.ok)
  treeDump('tree-after-explorer-restart')
  for (const k of children) {
    const r = readChild(k)
    k.rec.result = r && { attach: r.attach && { ok: r.attach.ok, method: r.attach.method }, reattach: r.reattach && { ok: r.reattach.ok, atMs: r.reattach.atMs }, watch: r.watch, winAfterExplorer: r.winAfterExplorer, fpsTail: r.fps.slice(-5), ram: r.ram }
    k.rec.stderrTail = k.rec.stderrTail.split('\n').filter((l) => /FATAL|ERROR|Check failed|crash|0x/i.test(l)).slice(-30).join('\n')
  }
  result.children = children.map((k) => k.rec)
  // RAM of the room process tree (the supervisor's own metrics do not include the child).
  save()
  for (const k of children) if (k.rec.exit == null) k.p.kill()
  await sleep(500)
}

// ---------------------------------------------------------------- lifecycle
app.on('window-all-closed', () => {
  /* keep running: Explorer restart destroys our child window and we recreate it */
})
const hardStop = setTimeout(() => {
  log('HARD TIMEOUT')
  result.hardTimeout = true
  save()
  app.exit(3)
}, (Number(argv.timeout || 150) + Number(argv.hold || 0)) * 1000)

if (IS_MAC && app.setActivationPolicy) app.setActivationPolicy('accessory')
app
  .whenReady()
  .then(scenario)
  .then(() => 0, (e) => {
    log('FATAL', String(e && e.stack))
    result.fatal = String(e && e.stack)
    return 1
  })
  .then((code) => {
    result.seconds = (Date.now() - T0) / 1000
    save()
    clearTimeout(hardStop)
    log('done', code)
    app.exit(code)
  })
