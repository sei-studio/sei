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
