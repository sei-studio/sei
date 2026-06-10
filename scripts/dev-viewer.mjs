// scripts/dev-viewer.mjs
//
// Dev-only sidecar: wraps `electron-vite dev` and serves a minimal browser
// viewer (log tail on the left, latest bot-POV render on the right) at
// http://localhost:7077. Wired as `npm run dev`; use `npm run dev:bare` to
// launch the app without it.
//
// How it gets its data — both feeds are file-based, zero IPC:
//   LOG    tails the newest *.log in `<userData>/logs/` (the per-line tee
//          written by src/main/logRouter.ts). Newest-by-mtime is re-resolved
//          on every poll, so a fresh summon switches files automatically.
//   RENDER povRenderer.js mirrors each successful frame to
//          `$SEI_DEV_VIEWER_DIR/latest-render.jpg` (tmp+rename, so reads here
//          never see a half-written file). This script owns that dir (in
//          os.tmpdir()) and passes it to the app through the env — the tap is
//          inert in any process this wrapper didn't start.
//
// Flags / env:
//   --viewer-only            serve the viewer without spawning electron-vite
//   SEI_DEV_VIEWER_PORT      preferred port (default 7077; +1 up to 10 tries)
//   SEI_DEV_VIEWER_NO_OPEN=1 don't auto-open the browser

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, open, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const VIEWER_ONLY = process.argv.includes('--viewer-only')
const BASE_PORT = Number(process.env.SEI_DEV_VIEWER_PORT) || 7077
const TAIL_BYTES = 64 * 1024 // first paint: last 64KB of the active log

// Mirrors src/main/index.ts dev branch: userData = <appData>/Sei Launcher Dev.
function appDataDir () {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
}
const LOGS_DIR = path.join(appDataDir(), 'Sei Launcher Dev', 'logs')
const RENDER_DIR = path.join(os.tmpdir(), 'sei-dev-viewer')
const RENDER_FILE = path.join(RENDER_DIR, 'latest-render.jpg')

async function newestLogFile () {
  let entries
  try { entries = await readdir(LOGS_DIR) } catch { return null }
  let best = null
  for (const name of entries) {
    if (!name.endsWith('.log')) continue
    try {
      const s = await stat(path.join(LOGS_DIR, name))
      if (!best || s.mtimeMs > best.mtimeMs) best = { name, size: s.size, mtimeMs: s.mtimeMs }
    } catch { /* raced with rotation — skip */ }
  }
  return best
}

async function readSlice (file, start, end) {
  const fh = await open(file, 'r')
  try {
    const len = Math.max(0, end - start)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function json (res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// GET /api/log?id=<file>&offset=<n>
// Same id  -> incremental chunk from offset.
// Different/new id (rotation or first poll) -> reset:true + last 64KB.
async function handleLog (url, res) {
  const current = await newestLogFile()
  if (!current) return json(res, { id: null, offset: 0, chunk: '', reset: true, waiting: true })
  const file = path.join(LOGS_DIR, current.name)
  const id = url.searchParams.get('id')
  const offset = Number(url.searchParams.get('offset')) || 0
  try {
    if (id !== current.name || offset > current.size) {
      const start = Math.max(0, current.size - TAIL_BYTES)
      const chunk = await readSlice(file, start, current.size)
      return json(res, { id: current.name, offset: current.size, chunk, reset: true })
    }
    const chunk = offset < current.size ? await readSlice(file, offset, current.size) : ''
    return json(res, { id: current.name, offset: current.size, chunk, reset: false })
  } catch {
    return json(res, { id: null, offset: 0, chunk: '', reset: true, waiting: true })
  }
}

async function handleRenderInfo (res) {
  try {
    const s = await stat(RENDER_FILE)
    return json(res, { mtimeMs: s.mtimeMs, size: s.size })
  } catch {
    return json(res, { mtimeMs: 0, size: 0 })
  }
}

async function handleRenderJpg (res) {
  try {
    const fh = await open(RENDER_FILE, 'r')
    try {
      const buf = await fh.readFile()
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
      res.end(buf)
    } finally {
      await fh.close()
    }
  } catch {
    res.writeHead(404, { 'cache-control': 'no-store' })
    res.end()
  }
}

// Summoning Terminal palette (src/renderer/src/styles/tokens.css): dark,
// sharp-edged, periwinkle #7FB0FF accent. Tags get stable colors via hash.
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sei Dev Viewer</title>
<style>
  :root { --bg:#0a0c10; --panel:#10141b; --line:#1d2530; --fg:#c9d4e3; --dim:#5b6b80; --accent:#7FB0FF; --warn:#e8b34b; --error:#ff6b6b; }
  * { box-sizing:border-box; margin:0; }
  html,body { height:100%; }
  body { background:var(--bg); color:var(--fg); font:12px/1.5 "SF Mono",ui-monospace,Menlo,monospace; display:flex; flex-direction:column; }
  header { display:flex; align-items:baseline; gap:10px; padding:8px 14px; border-bottom:1px solid var(--line); flex:none; }
  header h1 { font-size:13px; font-weight:600; color:var(--accent); letter-spacing:.08em; text-transform:uppercase; }
  header .meta { color:var(--dim); font-size:11px; }
  main { flex:1; display:flex; min-height:0; }
  #logpane { flex:1; min-width:0; overflow-y:auto; padding:10px 14px; white-space:pre-wrap; word-break:break-word; }
  #logpane .ts { color:var(--dim); }
  #logpane .warn { color:var(--warn); }
  #logpane .error { color:var(--error); }
  aside { width:440px; flex:none; border-left:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; align-items:center; padding:14px; gap:10px; overflow-y:auto; }
  aside h2 { font-size:11px; font-weight:600; color:var(--dim); letter-spacing:.08em; text-transform:uppercase; align-self:flex-start; }
  #render { width:100%; max-width:412px; image-rendering:pixelated; border:1px solid var(--line); display:none; }
  #render-empty { color:var(--dim); border:1px dashed var(--line); width:100%; max-width:412px; aspect-ratio:1; display:flex; align-items:center; justify-content:center; text-align:center; padding:20px; }
  #render-meta { color:var(--dim); font-size:11px; align-self:flex-start; }
</style>
</head>
<body>
<header>
  <h1>Sei Dev Viewer</h1>
  <span class="meta" id="logfile">waiting for bot logs…</span>
</header>
<main>
  <div id="logpane"></div>
  <aside>
    <h2>Latest render (bot POV)</h2>
    <img id="render" alt="latest bot POV render">
    <div id="render-empty">no render yet — renders appear when the bot's visualize action, idle auto-look, or the SEI_VISION_SPIKE probe produces a frame</div>
    <div id="render-meta"></div>
  </aside>
</main>
<script>
  const pane = document.getElementById('logpane')
  const logfileEl = document.getElementById('logfile')
  const img = document.getElementById('render')
  const empty = document.getElementById('render-empty')
  const renderMeta = document.getElementById('render-meta')

  // Stable per-tag color: hash -> hue, skipping the red band (reserved for errors).
  const tagColor = (tag) => {
    let h = 0
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
    return 'hsl(' + (40 + (h % 280)) + ' 60% 68%)'
  }
  const LINE_RE = /^(\\[\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\])\\s+(\\[[^\\]]+\\])\\s?(.*)$/
  const level = (line) => /\\[error\\]|^ERROR\\b|^Error:/i.test(line) ? 'error'
    : /\\[warn\\]|^WARN\\b/i.test(line) ? 'warn' : 'info'

  function appendLines (text) {
    const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 8
    const frag = document.createDocumentFragment()
    for (const line of text.split('\\n')) {
      if (!line) continue
      const div = document.createElement('div')
      const lvl = level(line)
      if (lvl !== 'info') div.className = lvl
      const m = line.match(LINE_RE)
      if (m) {
        const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = m[1] + ' '
        const tag = document.createElement('span'); tag.textContent = m[2] + ' '
        if (lvl === 'info') tag.style.color = tagColor(m[2])
        const msg = document.createElement('span'); msg.textContent = m[3]
        div.append(ts, tag, msg)
      } else {
        div.textContent = line
      }
      frag.appendChild(div)
    }
    pane.appendChild(frag)
    while (pane.childNodes.length > 5000) pane.removeChild(pane.firstChild)
    if (atBottom) pane.scrollTop = pane.scrollHeight
  }

  let logId = null, logOffset = 0, partial = ''
  async function pollLog () {
    try {
      const r = await fetch('/api/log?id=' + encodeURIComponent(logId ?? '') + '&offset=' + logOffset)
      const b = await r.json()
      if (b.waiting) { logfileEl.textContent = 'waiting for bot logs… (summon a character)'; return }
      if (b.reset) { pane.textContent = ''; partial = ''; logfileEl.textContent = b.id }
      logId = b.id; logOffset = b.offset
      if (b.chunk) {
        const text = partial + b.chunk
        const lastNl = text.lastIndexOf('\\n')
        partial = lastNl === -1 ? text : text.slice(lastNl + 1)
        if (lastNl !== -1) appendLines(text.slice(0, lastNl))
      }
    } catch { /* server restarting — retry next tick */ }
  }

  let renderMtime = 0
  async function pollRender () {
    try {
      const r = await fetch('/api/render-info')
      const b = await r.json()
      if (b.mtimeMs && b.mtimeMs !== renderMtime) {
        renderMtime = b.mtimeMs
        img.src = '/render.jpg?b=' + b.mtimeMs
        img.style.display = 'block'
        empty.style.display = 'none'
        renderMeta.textContent = (b.size / 1024).toFixed(1) + ' KB · ' + new Date(b.mtimeMs).toLocaleTimeString()
      }
    } catch { /* retry next tick */ }
  }

  pollLog(); pollRender()
  setInterval(pollLog, 600)
  setInterval(pollRender, 1000)
</script>
</body>
</html>
`

function requestHandler (req, res) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(PAGE)
  }
  if (url.pathname === '/api/log') return void handleLog(url, res)
  if (url.pathname === '/api/render-info') return void handleRenderInfo(res)
  if (url.pathname === '/render.jpg') return void handleRenderJpg(res)
  res.writeHead(404)
  res.end()
}

function listen (port, triesLeft) {
  return new Promise((resolve, reject) => {
    const server = createServer(requestHandler)
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && triesLeft > 0) {
        resolve(listen(port + 1, triesLeft - 1))
      } else {
        reject(err)
      }
    })
    server.listen(port, '127.0.0.1', () => resolve({ server, port }))
  })
}

function openBrowser (url) {
  if (process.env.SEI_DEV_VIEWER_NO_OPEN === '1') return
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    spawn(cmd, [url], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref()
  } catch { /* viewer still reachable manually */ }
}

await mkdir(RENDER_DIR, { recursive: true })
// Drop the previous session's frame so a stale render is never mistaken for live.
await unlink(RENDER_FILE).catch(() => {})

const { server, port } = await listen(BASE_PORT, 10)
const url = `http://localhost:${port}`
console.log(`[dev-viewer] ${url}  (log: ${LOGS_DIR})`)
openBrowser(url)

if (VIEWER_ONLY) {
  // Serve until killed; nothing else to manage.
} else {
  const child = spawn('electron-vite', ['dev', ...process.argv.slice(2).filter((a) => a !== '--viewer-only')], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // resolve electron-vite.cmd via PATH
    env: { ...process.env, SEI_DEV_VIEWER_DIR: RENDER_DIR },
  })
  const forward = (sig) => { try { child.kill(sig) } catch { /* already gone */ } }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))
  child.on('exit', (code, signal) => {
    server.close()
    process.exit(signal ? 0 : code ?? 0)
  })
}
