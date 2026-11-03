// Collates out/<variant>/result.json into a markdown table.
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2] || path.join(__dirname, '..', 'out')
const rows = []
let osLine = ''
for (const v of fs.readdirSync(root).sort()) {
  const f = path.join(root, v, 'result.json')
  if (!fs.existsSync(f)) continue
  const r = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (r.winBefore && !osLine) osLine = `${r.winBefore.os}, layout **${r.winBefore.layout}** (Progman exStyle ${r.winBefore.progmanExStyle})`
  if (r.macLevels && !osLine) osLine = `macOS ${r.macLevels.os}, levels desktop=${r.macLevels.desktop} desktopIcon=${r.macLevels.desktopIcon}, axTrusted=${r.macLevels.axTrusted}, screenCapture=${r.macLevels.screenCaptureAccess}`
  const c = r.checks || {}
  const ramEnd = (r.ram || []).find((x) => x.label === 'steady-visible')
  const yn = (b) => (b === true ? 'yes' : b === false ? 'NO' : '-')
  rows.push([
    v,
    r.attach ? (r.attach.ok === false ? 'FAIL ' + (r.attach.error || '') : r.attach.method || 'ok') : '-',
    yn(c.rendersBehindIcons),
    yn(c.animates),
    yn(c.iconColumnLessMagenta),
    yn(c.normalWindowCovers),
    c.fpsVisible ? c.fpsVisible.median : '-',
    c.fpsCovered ? c.fpsCovered.median : '-',
    ramEnd ? ramEnd.totalWorkingSetMB : '-',
    [c.rawInputSeesDesktopClicks != null ? `raw=${c.rawInputSeesDesktopClicks}` : '', c.proxyReceivesClick != null ? `proxy=${yn(c.proxyReceivesClick)} keepsFront=${yn(c.proxyKeepsFrontApp)}` : '', c.nativeProxyReceivesClick != null ? `nsPanel=${yn(c.nativeProxyReceivesClick)} keepsFront=${yn(c.nativeProxyKeepsFrontApp)}` : '', r.afterWallpaperClick ? `wallpaperClick->${r.afterWallpaperClick.frontmost}` : '', c.childDiedOnExplorerExit != null ? `childDied=${yn(c.childDiedOnExplorerExit)} exit=${(r.children || []).map((k) => k.exit && k.exit.hex).join(',')} via=${c.recoveredBy} ${c.recoveryMsAfterKill}ms` : '', c.explorerRestartReattached != null ? `explorer=${yn(c.explorerRestartReattached)} render=${yn(c.rendersAfterRestart)} anim=${yn(c.animatesAfterRestart)}` : '', r.fatal ? 'FATAL' : '', r.hardTimeout ? 'TIMEOUT' : ''].filter(Boolean).join(' '),
  ])
}
console.log(`### SeiLink spike: ${osLine}\n`)
console.log('| variant | attach | renders | animates | icons over | normal win covers | fps vis | fps covered | RAM MB | extra |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log('| ' + r.join(' | ') + ' |')

// Round 2 (r2-*): one block per run with the checks and the headline numbers.
for (const v of fs.readdirSync(root).sort()) {
  const f = path.join(root, v, 'result.json')
  if (!v.startsWith('r2') || !fs.existsSync(f)) continue
  const r = JSON.parse(fs.readFileSync(f, 'utf8'))
  const n = r.numbers || {}
  const m = n.measure || {}
  const fmt = (x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))
  console.log(`\n### Round 2: ${v} (${r.platform}, ${r.display ? r.display.bounds.width + 'x' + r.display.bounds.height : '?'})${r.fatal ? ' FATAL' : ''}${r.hardTimeout ? ' TIMEOUT' : ''}\n`)
  console.log('| check | result |')
  console.log('|---|---|')
  for (const [k, x] of Object.entries(r.checks || {})) console.log(`| ${k} | ${fmt(x)} |`)
  console.log('\n| measure | fps | host cpu % | main cpu % | host RAM MB | covered |')
  console.log('|---|---|---|---|---|---|')
  for (const [k, x] of Object.entries(m)) console.log(`| ${k} | ${x.fpsMedian} | ${x.hostCpuMean} | ${x.mainCpuMean} | ${x.hostRamMB} | ${x.covered} |`)
  const keys = ['coldStart', 'pingRttMs', 'killRecovery', 'hangRecovery', 'crashLoop', 'coverMaximize', 'uncoverShowDesktop', 'coverFullscreen', 'coverZoom', 'explorerKill']
  console.log('')
  for (const k of keys) if (n[k]) console.log(`- ${k}: \`${fmt(n[k]).slice(0, 700)}\``)
  if (n.shell) for (const [k, x] of Object.entries(n.shell)) console.log(`- shell ${k}: reattached ${x.reattachedMs} ms (${x.reattachReason}), valid after ${fmt(x.validAfter)}`)
  if (n.ram) console.log(`- RAM: main ${n.ram.main.totalWorkingSetMB} MB, host ${n.ram.host && n.ram.host.totalWorkingSetMB} MB`)
  for (const t of r.hitTrials || []) console.log(`- hit ${t.kind}: pass=${t.pass} events=${t.events.join(',')} front ${t.frontBefore}->${t.frontAfter} notSwept=${t.notSwept} neverActive=${t.neverActive}`)
}
