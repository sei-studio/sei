// scripts/dev-viewer.mjs
//
// Dev-only sidecar: wraps `electron-vite dev` and serves a minimal browser
// viewer at http://localhost:7077 with three tabs:
//   LOGS    log tail on the left, latest bot-POV render on the right
//   PROMPT  persona-expansion tuning tool: edit the user persona blurb and
//           the expansion instruction, regenerate the final persona prompt,
//           then chat against it. The expansion instruction default is read
//           live from src/bot/brain/promptLibrary.js (EXPANSION_SYSTEM).
//   LIBRARY edit EVERY field in src/bot/brain/promptLibrary.js (the single
//           prompt document) in-browser and save changes straight back to the
//           file. Each save is validated (temp-import) before it overwrites the
//           source, so a broken edit can't corrupt it. Re-summon the bot to
//           pick up changes.
// The viewer AND the app's DevTools console are OFF by default: a plain
// `npm run dev` launches the app clean. Turn both on with the dev-tools flag:
// `npm run dev:tools` (or `npm run dev -- --tools`, or SEI_DEV_TOOLS=1).
//
// How it gets its data — log + render feeds are file-based, zero IPC:
//   LOG    tails the newest *.log across BOTH userData log dirs — the dev run
//          (`Sei Dev/logs`) and the packaged app (`Sei/logs`)
//          — the per-line tee written by src/main/logRouter.ts. Newest-by-mtime
//          is re-resolved on every poll, so a fresh summon switches files
//          automatically regardless of which app instance produced it.
//   RENDER povRenderer.js mirrors each successful frame to
//          `$SEI_DEV_VIEWER_DIR/latest-render.jpg` (tmp+rename, so reads here
//          never see a half-written file). This script owns that dir (in
//          os.tmpdir()) and passes it to the app through the env — the tap is
//          inert in any process this wrapper didn't start.
//   PROMPT calls the Anthropic API directly (BYOK). Key comes from the
//          ANTHROPIC_API_KEY env var, or an ANTHROPIC_API_KEY= line in
//          sei/.env (gitignored; re-read per request, so adding it needs no
//          restart). Without a key the tab loads but generate/chat return a
//          friendly error.
//
// Flags / env:
//   --tools                  open the viewer + the app's DevTools console
//                            (off by default; also via SEI_DEV_TOOLS=1)
//   --viewer-only            serve the viewer without spawning electron-vite
//                            (implies --tools)
//   SEI_DEV_VIEWER_PORT      preferred port (default 7077; +1 up to 10 tries)
//   SEI_DEV_VIEWER_NO_OPEN=1 don't auto-open the browser
//   ANTHROPIC_API_KEY        enables the prompt-tuning tab's LLM calls
//                            (also picked up from sei/.env)

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile, rename, stat, open, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { buildLibraryFields, applyEdits, ID_SEP } from './lib/promptLibraryEdit.mjs'

const VIEWER_ONLY = process.argv.includes('--viewer-only')
// Dev-tools gate: the browser viewer AND the Electron DevTools console only open
// when this is on. Enable with `--tools` (or `--viewer-only`), or SEI_DEV_TOOLS=1.
// A plain `npm run dev` now just launches the app — no viewer tab, no console.
const DEV_TOOLS = VIEWER_ONLY || process.argv.includes('--tools') || process.env.SEI_DEV_TOOLS === '1'
const BASE_PORT = Number(process.env.SEI_DEV_VIEWER_PORT) || 7077
const TAIL_BYTES = 64 * 1024 // first paint: last 64KB of the active log

// Mirrors src/main/index.ts dev branch: userData = <appData>/Sei Launcher Dev.
function appDataDir () {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
}
// Both possible userData roots (src/main/index.ts: app.setName packaged → 'Sei',
// dev → 'Sei Dev'). Summons from EITHER instance must show up here, so the
// newest-log scan covers both; the `key` prefixes the viewer's file id.
const LOG_DIRS = [
  { key: 'dev', dir: path.join(appDataDir(), 'Sei Dev', 'logs') },
  { key: 'app', dir: path.join(appDataDir(), 'Sei', 'logs') },
]
const RENDER_DIR = path.join(os.tmpdir(), 'sei-dev-viewer')
const RENDER_FILE = path.join(RENDER_DIR, 'latest-render.jpg')
const PERSONA_EXPANSION_TS = new URL('../src/main/personaExpansion.ts', import.meta.url)
// The single editable prompt document — the LIBRARY tab reads/writes it.
const PROMPT_LIBRARY_URL = new URL('../src/bot/brain/promptLibrary.js', import.meta.url)
const PROMPT_LIBRARY_PATH = fileURLToPath(PROMPT_LIBRARY_URL)

async function newestLogFile () {
  let best = null
  for (const { key, dir } of LOG_DIRS) {
    let entries
    try { entries = await readdir(dir) } catch { continue } // dir may not exist yet
    for (const name of entries) {
      if (!name.endsWith('.log')) continue
      try {
        const s = await stat(path.join(dir, name))
        if (!best || s.mtimeMs > best.mtimeMs) {
          best = { id: `${key}/${name}`, file: path.join(dir, name), size: s.size, mtimeMs: s.mtimeMs }
        }
      } catch { /* raced with rotation — skip */ }
    }
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

async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

// GET /api/log?id=<file>&offset=<n>
// Same id  -> incremental chunk from offset.
// Different/new id (rotation or first poll) -> reset:true + last 64KB.
// `file` is the absolute path of the active log, shown in the viewer header.
async function handleLog (url, res) {
  const current = await newestLogFile()
  if (!current) return json(res, { id: null, offset: 0, chunk: '', reset: true, waiting: true })
  const id = url.searchParams.get('id')
  const offset = Number(url.searchParams.get('offset')) || 0
  try {
    if (id !== current.id || offset > current.size) {
      const start = Math.max(0, current.size - TAIL_BYTES)
      const chunk = await readSlice(current.file, start, current.size)
      return json(res, { id: current.id, file: current.file, offset: current.size, chunk, reset: true })
    }
    const chunk = offset < current.size ? await readSlice(current.file, offset, current.size) : ''
    return json(res, { id: current.id, file: current.file, offset: current.size, chunk, reset: false })
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

// ---------------------------------------------------------------------------
// Prompt-tuning tab backend
//
// The expansion instruction now lives in the single prompt document
// (src/bot/brain/promptLibrary.js, exported as EXPANSION_SYSTEM). Import it
// fresh (cache-busted) so an edit in the LIBRARY tab — or in the file — shows
// up on the next request without a sidecar restart. The model id still comes
// from src/main/personaExpansion.ts. Both fail soft (empty / default).

// Re-import promptLibrary.js with a cache-busting query so every read reflects
// the current on-disk file (ESM caches by full URL, query included).
async function importLibrary () {
  return import(PROMPT_LIBRARY_URL.href + '?v=' + Date.now())
}

async function expansionDefaults () {
  let instruction = ''
  let model = 'claude-haiku-4-5'
  try {
    const mod = await importLibrary()
    if (typeof mod.EXPANSION_SYSTEM === 'string') instruction = mod.EXPANSION_SYSTEM
  } catch { /* fails soft */ }
  try {
    const src = await readFile(PERSONA_EXPANSION_TS, 'utf8')
    model = src.match(/EXPANSION_MODEL = '([^']+)'/)?.[1] ?? model
  } catch { /* fails soft */ }
  return { instruction, model }
}

// Key resolution: env var wins, else an ANTHROPIC_API_KEY= line in sei/.env
// (gitignored — already the home of local build-time config). Re-read on every
// request so adding the key to .env works without restarting the sidecar.
const ENV_FILE = new URL('../.env', import.meta.url)
async function anthropicKey () {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const m = (await readFile(ENV_FILE, 'utf8')).match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n#]+)/m)
    return m?.[1].trim() ?? ''
  } catch {
    return ''
  }
}

let _anthropic = null
async function anthropicClient () {
  const apiKey = await anthropicKey()
  if (!apiKey) {
    throw new Error('no API key — add ANTHROPIC_API_KEY=sk-ant-… to sei/.env (picked up on the next click, no restart) or export it before `npm run dev`')
  }
  if (!_anthropic || _anthropic._key !== apiKey) {
    _anthropic = new Anthropic({ apiKey })
    _anthropic._key = apiKey
  }
  return _anthropic
}

// Mirrors buildExpansionUserMessage() in personaExpansion.ts (sans priorExpanded).
function expansionUserMessage (name, source) {
  return [
    `Character name: ${name}`,
    '',
    'Source persona (user-written blurb):',
    source,
    '',
    'Expand into the four-section prompt now. If the name matches a known franchise character (e.g. Pikachu, Goku), let that context inform the IDENTITY and VOICE sections.',
  ].join('\n')
}

function messageText (msg) {
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
}

async function handlePromptConfig (res) {
  const { instruction, model } = await expansionDefaults()
  json(res, { instruction, model, hasKey: Boolean(await anthropicKey()) })
}

// POST /api/expand {name, source, instruction} -> {text} | {error}
async function handleExpand (req, res) {
  try {
    const { name = 'Sei', source = '', instruction = '' } = await readBody(req)
    if (!source.trim()) return json(res, { error: 'user persona is empty' })
    const { model } = await expansionDefaults()
    const msg = await (await anthropicClient()).messages.create(
      {
        model,
        max_tokens: 2048, // EXPANSION_MAX_TOKENS
        system: instruction || undefined,
        messages: [{ role: 'user', content: expansionUserMessage(name.trim() || 'Sei', source) }],
      },
      { timeout: 60_000 }, // EXPANSION_TIMEOUT_MS
    )
    json(res, { text: messageText(msg) })
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) })
  }
}

// POST /api/chat {system, messages:[{role,content}]} -> {text} | {error}
async function handleChat (req, res) {
  try {
    const { system = '', messages = [] } = await readBody(req)
    if (!messages.length) return json(res, { error: 'no messages' })
    const { model } = await expansionDefaults()
    const msg = await (await anthropicClient()).messages.create(
      {
        model,
        max_tokens: 1024,
        system: system || undefined,
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
      },
      { timeout: 60_000 },
    )
    json(res, { text: messageText(msg) })
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// LIBRARY tab backend — read/edit EVERY editable field in promptLibrary.js.
//
// Values are read by importing the module (accurate, no parsing). Write-back
// edits the SOURCE TEXT in place (scripts/lib/promptLibraryEdit.mjs — a small
// JS-literal-aware scanner) so the file's functions, comments and structure are
// preserved; only the edited string/array literal is swapped. Every save is
// validated by importing a temp copy first, so a syntactically broken edit can
// never overwrite the real file. Function-valued object props (NUDGES.actionTurn,
// EVENT_GUIDANCE['sei:idle'], …) are not editable and are skipped automatically —
// but where such a function's PROSE was factored out into string constants
// (REFLEX_ADDENDUM_TEXT, IDLE_TICK_TEXT, ATTACKED_ADDENDUM_*, …), those constants
// ARE listed in LIBRARY_LAYOUT and edit the wording the function fills in.

// GET /api/library -> { fields:[{id,section,label,kind,value}] }
async function handleLibraryGet (res) {
  try {
    const mod = await importLibrary()
    json(res, { fields: buildLibraryFields(mod) })
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) })
  }
}

// POST /api/library {edits:[{id,value}]} -> { ok, count } | { error }
async function handleLibrarySave (req, res) {
  let tmp
  try {
    const { edits = [] } = await readBody(req)
    if (!Array.isArray(edits) || edits.length === 0) return json(res, { error: 'no edits' })
    const src = await readFile(PROMPT_LIBRARY_PATH, 'utf8')
    const next = applyEdits(src, edits)
    if (next === src) return json(res, { ok: true, count: 0, note: 'no changes' })

    // Validate by importing a temp copy BEFORE touching the real file — a
    // syntactically broken edit (or a bad scan) can never corrupt the source.
    tmp = PROMPT_LIBRARY_PATH.replace(/\.js$/, '') + '.devviewer-' + Date.now() + '.mjs'
    await writeFile(tmp, next, 'utf8')
    const check = await import('file://' + tmp + '?v=' + Date.now())
    for (const { id } of edits) {
      const name = id.indexOf(ID_SEP) === -1 ? id : id.slice(0, id.indexOf(ID_SEP))
      if (!(name in check)) throw new Error('export missing after edit: ' + name)
    }
    await unlink(tmp).catch(() => {})
    tmp = null

    // Atomic-ish write: temp in the same dir, then rename over the original.
    const realTmp = PROMPT_LIBRARY_PATH + '.tmp-' + Date.now()
    await writeFile(realTmp, next, 'utf8')
    await rename(realTmp, PROMPT_LIBRARY_PATH)
    json(res, { ok: true, count: edits.length })
  } catch (err) {
    if (tmp) await unlink(tmp).catch(() => {})
    json(res, { error: err instanceof Error ? err.message : String(err) })
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
  header .meta { color:var(--dim); font-size:11px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tab { background:none; border:1px solid var(--line); color:var(--dim); font:inherit; font-size:11px; padding:2px 10px; cursor:pointer; letter-spacing:.06em; text-transform:uppercase; }
  .tab.active { color:var(--accent); border-color:var(--accent); }
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
  /* prompt tool — light theme + readable sans (body.light is toggled with the
     Prompt tab; the Logs tab keeps the dark terminal palette) */
  body.light { --bg:#f6f7f9; --panel:#ffffff; --line:#d9dee7; --fg:#1c2430; --dim:#6b7787; --accent:#2563eb; --warn:#9a6700; --error:#c4314b; }
  #promptview { display:none; gap:12px; padding:12px 14px; font:13px/1.55 -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif; }
  .pcol { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; }
  .pwin { flex:1; min-height:0; display:flex; flex-direction:column; gap:6px; }
  .pwin.small { flex:0 0 28%; }
  .pwin.fs { position:fixed; inset:0; z-index:10; background:var(--bg); padding:14px; }
  .pcol label, .prow label { font-size:11px; font-weight:600; color:var(--dim); letter-spacing:.08em; text-transform:uppercase; }
  .pcol textarea { flex:1; min-height:0; resize:none; background:var(--panel); border:1px solid var(--line); color:var(--fg); font:inherit; padding:10px; outline:none; }
  .pcol textarea:focus, .pcol input:focus, #chatinput:focus { border-color:var(--accent); }
  .pcol input, #chatinput { background:var(--panel); border:1px solid var(--line); color:var(--fg); font:inherit; padding:5px 8px; outline:none; }
  .prow { display:flex; align-items:center; gap:8px; }
  .prow .spacer { flex:1; }
  .pbtn { background:none; border:1px solid var(--accent); color:var(--accent); font:inherit; font-size:11px; padding:3px 10px; cursor:pointer; letter-spacing:.06em; text-transform:uppercase; }
  .pbtn:disabled { border-color:var(--dim); color:var(--dim); cursor:default; }
  #pstatus { font-size:11px; color:var(--dim); min-height:16px; }
  #pstatus.error { color:var(--error); }
  #chatcol { display:none; }
  #chatlog { flex:1; min-height:0; overflow-y:auto; border:1px solid var(--line); background:var(--panel); padding:8px; display:flex; flex-direction:column; gap:6px; }
  #chatlog .msg { white-space:pre-wrap; word-break:break-word; }
  #chatlog .who { color:var(--dim); }
  #chatlog .user .who { color:var(--accent); }
  #chatlog .note { color:var(--dim); font-style:italic; }
  #chatlog .error { color:var(--error); }
  /* library editor — full-width scrolling list of every promptLibrary field */
  #libraryview { display:none; flex-direction:column; min-height:0; font:13px/1.5 -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif; }
  #libbar { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--line); flex:none; background:var(--panel); }
  #libbar .spacer { flex:1; }
  #libtitle { font-size:11px; font-weight:600; color:var(--dim); letter-spacing:.06em; text-transform:uppercase; }
  #libstatus { font-size:11px; color:var(--dim); }
  #libstatus.error { color:var(--error); }
  #libstatus.ok { color:var(--accent); }
  #liblist { flex:1; min-height:0; overflow-y:auto; padding:12px 14px 60px; }
  .libsec { font-size:11px; font-weight:700; color:var(--accent); letter-spacing:.08em; text-transform:uppercase; margin:18px 0 8px; }
  .libsec:first-child { margin-top:0; }
  .lfield { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
  .lfield label { font-size:11px; font-weight:600; color:var(--dim); }
  .lfield.dirty label { color:var(--accent); }
  .lfield.dirty label::after { content:" ●"; color:var(--accent); }
  .lfield textarea { resize:vertical; background:var(--panel); border:1px solid var(--line); color:var(--fg); font:12px/1.5 "SF Mono",ui-monospace,Menlo,monospace; padding:8px; outline:none; min-height:60px; }
  .lfield textarea:focus { border-color:var(--accent); }
  .lfield.dirty textarea { border-color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Sei Dev Viewer</h1>
  <button class="tab active" id="tab-logs">Logs</button>
  <button class="tab" id="tab-prompt">Prompt</button>
  <button class="tab" id="tab-library">Library</button>
  <span class="meta" id="logfile">waiting for bot logs…</span>
</header>
<main id="logview">
  <div id="logpane"></div>
  <aside>
    <h2>Latest render (bot POV)</h2>
    <img id="render" alt="latest bot POV render">
    <div id="render-empty">no render yet — renders appear when the bot's visualize action, idle auto-look, or the SEI_VISION_SPIKE probe produces a frame</div>
    <div id="render-meta"></div>
  </aside>
</main>
<main id="promptview">
  <div class="pcol" id="tunecol">
    <div class="prow"><label for="pname">Name</label><input id="pname" value="Sei" size="14"></div>
    <div class="pwin small">
      <div class="prow"><label for="psource">User persona</label><span class="spacer"></span><button class="pbtn fsbtn" title="fullscreen">⤢</button></div>
      <textarea id="psource" placeholder="short user-written persona blurb…"></textarea>
    </div>
    <div class="pwin">
      <div class="prow"><label for="pinstr">Expansion instruction (system prompt)</label><span class="spacer"></span><button class="pbtn fsbtn" title="fullscreen">⤢</button></div>
      <textarea id="pinstr"></textarea>
    </div>
  </div>
  <div class="pcol" id="finalcol">
    <div class="pwin">
      <div class="prow">
        <label for="pfinal">Final persona prompt</label>
        <span class="spacer"></span>
        <button class="pbtn fsbtn" title="fullscreen">⤢</button>
        <button class="pbtn" id="pgen">Generate</button>
        <button class="pbtn" id="pchat-toggle">Chat ▸</button>
      </div>
      <textarea id="pfinal" placeholder="generated persona prompt — or paste/edit directly…"></textarea>
      <div id="pstatus"></div>
    </div>
  </div>
  <div class="pcol" id="chatcol">
    <label id="chatlabel">Chat</label>
    <div id="chatlog"></div>
    <div class="prow">
      <input id="chatinput" style="flex:1" placeholder="say something to the persona…">
      <button class="pbtn" id="chatsend">Send</button>
    </div>
  </div>
</main>
<main id="libraryview">
  <div id="libbar">
    <span id="libtitle">promptLibrary.js</span>
    <span class="spacer"></span>
    <span id="libstatus"></span>
    <button class="pbtn" id="libreload">Reload</button>
    <button class="pbtn" id="libsave" disabled>Save</button>
  </div>
  <div id="liblist"></div>
</main>
<script>
  var $ = function (id) { return document.getElementById(id) }
  var pane = $('logpane')
  var logfileEl = $('logfile')
  var img = $('render')
  var empty = $('render-empty')
  var renderMeta = $('render-meta')

  // --- tabs ---
  function showTab (name) {
    $('logview').style.display = name === 'logs' ? 'flex' : 'none'
    $('promptview').style.display = name === 'prompt' ? 'flex' : 'none'
    $('libraryview').style.display = name === 'library' ? 'flex' : 'none'
    $('tab-logs').classList.toggle('active', name === 'logs')
    $('tab-prompt').classList.toggle('active', name === 'prompt')
    $('tab-library').classList.toggle('active', name === 'library')
    document.body.classList.toggle('light', name !== 'logs')
    logfileEl.style.display = name === 'logs' ? '' : 'none'
    if (name === 'library' && !libLoaded) loadLibrary()
  }
  $('tab-logs').onclick = function () { showTab('logs') }
  $('tab-prompt').onclick = function () { showTab('prompt') }
  $('tab-library').onclick = function () { showTab('library') }

  // --- log tail ---
  // Stable per-tag color: hash -> hue, skipping the red band (reserved for errors).
  var tagColor = function (tag) {
    var h = 0
    for (var i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
    return 'hsl(' + (40 + (h % 280)) + ' 60% 68%)'
  }
  var LINE_RE = /^(\\[\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\])\\s+(\\[[^\\]]+\\])\\s?(.*)$/
  var level = function (line) {
    return /\\[error\\]|^ERROR\\b|^Error:/i.test(line) ? 'error'
      : /\\[warn\\]|^WARN\\b/i.test(line) ? 'warn' : 'info'
  }

  function appendLines (text) {
    var atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 8
    var frag = document.createDocumentFragment()
    var lines = text.split('\\n')
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (!line) continue
      var div = document.createElement('div')
      var lvl = level(line)
      if (lvl !== 'info') div.className = lvl
      var m = line.match(LINE_RE)
      if (m) {
        var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = m[1] + ' '
        var tag = document.createElement('span'); tag.textContent = m[2] + ' '
        if (lvl === 'info') tag.style.color = tagColor(m[2])
        var msg = document.createElement('span'); msg.textContent = m[3]
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

  var logId = null, logOffset = 0, partial = ''
  async function pollLog () {
    try {
      var r = await fetch('/api/log?id=' + encodeURIComponent(logId == null ? '' : logId) + '&offset=' + logOffset)
      var b = await r.json()
      if (b.waiting) { logfileEl.textContent = 'waiting for bot logs… (summon a character)'; return }
      if (b.reset) { pane.textContent = ''; partial = '' }
      logfileEl.textContent = b.file || b.id
      logfileEl.title = b.file || ''
      logId = b.id; logOffset = b.offset
      if (b.chunk) {
        var text = partial + b.chunk
        var lastNl = text.lastIndexOf('\\n')
        partial = lastNl === -1 ? text : text.slice(lastNl + 1)
        if (lastNl !== -1) appendLines(text.slice(0, lastNl))
      }
    } catch { /* server restarting — retry next tick */ }
  }

  var renderMtime = 0
  async function pollRender () {
    try {
      var r = await fetch('/api/render-info')
      var b = await r.json()
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

  // --- prompt tool ---
  // Fields persist in localStorage so a sidecar restart doesn't lose edits.
  var PFIELDS = [['pname', 'sei-pt-name'], ['psource', 'sei-pt-source'], ['pinstr', 'sei-pt-instr'], ['pfinal', 'sei-pt-final']]
  PFIELDS.forEach(function (f) {
    var el = $(f[0])
    var saved = localStorage.getItem(f[1])
    if (saved !== null && saved !== '') el.value = saved
    el.addEventListener('input', function () { localStorage.setItem(f[1], el.value) })
  })

  function setStatus (text, isError) {
    $('pstatus').textContent = text || ''
    $('pstatus').className = isError ? 'error' : ''
  }

  // expand any prompt window to fullscreen (one at a time; Esc or ✕ to exit)
  function exitFs () {
    document.querySelectorAll('.pwin.fs').forEach(function (w) {
      w.classList.remove('fs')
      w.querySelector('.fsbtn').textContent = '⤢'
    })
  }
  document.querySelectorAll('.fsbtn').forEach(function (btn) {
    btn.onclick = function () {
      var win = btn.closest('.pwin')
      var open = !win.classList.contains('fs')
      exitFs()
      if (open) {
        win.classList.add('fs')
        btn.textContent = '✕'
        win.querySelector('textarea').focus()
      }
    }
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') exitFs() })

  fetch('/api/prompt-config').then(function (r) { return r.json() }).then(function (c) {
    if (!$('pinstr').value) $('pinstr').value = c.instruction
    $('chatlabel').textContent = 'Chat (' + c.model + ')'
    if (!c.hasKey) setStatus('no API key — add ANTHROPIC_API_KEY=sk-ant-… to sei/.env (no restart needed)', true)
  }).catch(function () {})

  $('pgen').onclick = async function () {
    $('pgen').disabled = true
    setStatus('generating…')
    try {
      var r = await fetch('/api/expand', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: $('pname').value, source: $('psource').value, instruction: $('pinstr').value }),
      })
      var b = await r.json()
      if (b.error) { setStatus(b.error, true) } else {
        $('pfinal').value = b.text
        localStorage.setItem('sei-pt-final', b.text)
        resetChat('persona regenerated — chat reset')
        setStatus('')
      }
    } catch (e) { setStatus(String(e), true) }
    $('pgen').disabled = false
  }

  // chat mode: collapse the tuning column, final prompt moves left, chat on the right
  var chatMode = false
  $('pchat-toggle').onclick = function () {
    chatMode = !chatMode
    $('tunecol').style.display = chatMode ? 'none' : 'flex'
    $('chatcol').style.display = chatMode ? 'flex' : 'none'
    $('pchat-toggle').textContent = chatMode ? '◂ Tuning' : 'Chat ▸'
    if (chatMode) $('chatinput').focus()
  }

  var chatMsgs = []
  var chatBusy = false
  function addBubble (who, text) {
    var div = document.createElement('div')
    div.className = 'msg ' + who
    var label = document.createElement('span')
    label.className = 'who'
    label.textContent = (who === 'user' ? 'you' : 'bot') + ' › '
    var body = document.createElement('span')
    body.textContent = text
    div.append(label, body)
    $('chatlog').appendChild(div)
    $('chatlog').scrollTop = $('chatlog').scrollHeight
    return body
  }
  function resetChat (reason) {
    if (!chatMsgs.length && !$('chatlog').childNodes.length) return
    chatMsgs = []
    $('chatlog').textContent = ''
    if (reason) {
      var note = document.createElement('div')
      note.className = 'note'
      note.textContent = reason
      $('chatlog').appendChild(note)
    }
  }
  // Direct edits to the final persona prompt also reset the conversation.
  $('pfinal').addEventListener('input', function () { resetChat('persona edited — chat reset') })

  async function sendChat () {
    var text = $('chatinput').value.trim()
    if (!text || chatBusy) return
    $('chatinput').value = ''
    chatMsgs.push({ role: 'user', content: text })
    addBubble('user', text)
    var pending = addBubble('bot', '…')
    chatBusy = true
    try {
      var r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: $('pfinal').value, messages: chatMsgs }),
      })
      var b = await r.json()
      if (b.error) {
        pending.textContent = '[error] ' + b.error
        pending.parentNode.classList.add('error')
      } else {
        pending.textContent = b.text
        chatMsgs.push({ role: 'assistant', content: b.text })
      }
    } catch (e) {
      pending.textContent = '[error] ' + e
      pending.parentNode.classList.add('error')
    }
    chatBusy = false
    $('chatlog').scrollTop = $('chatlog').scrollHeight
  }
  $('chatsend').onclick = sendChat
  $('chatinput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat() })

  // --- library editor ---
  // Loads every editable field in promptLibrary.js, edits in textareas, and
  // saves changes straight back to the file (server validates before writing).
  var libLoaded = false
  var libFields = []   // [{id, original, el}]
  function libSetStatus (text, cls) {
    var s = $('libstatus'); s.textContent = text || ''; s.className = cls || ''
  }
  function libRefreshDirty () {
    var anyDirty = false
    libFields.forEach(function (f) {
      var dirty = f.el.value !== f.original
      f.el.closest('.lfield').classList.toggle('dirty', dirty)
      if (dirty) anyDirty = true
    })
    $('libsave').disabled = !anyDirty
    return anyDirty
  }
  function autoSize (ta) {
    ta.style.height = 'auto'
    ta.style.height = Math.min(420, Math.max(60, ta.scrollHeight + 4)) + 'px'
  }
  async function loadLibrary () {
    libSetStatus('loading…')
    try {
      var r = await fetch('/api/library')
      var b = await r.json()
      if (b.error) { libSetStatus(b.error, 'error'); return }
      var list = $('liblist'); list.textContent = ''
      libFields = []
      var lastSection = null
      b.fields.forEach(function (f) {
        if (f.section !== lastSection) {
          var h = document.createElement('div'); h.className = 'libsec'; h.textContent = f.section
          list.appendChild(h); lastSection = f.section
        }
        var wrap = document.createElement('div'); wrap.className = 'lfield'
        var lab = document.createElement('label'); lab.textContent = f.label + (f.kind === 'array' ? '  (one line per array entry)' : '')
        var ta = document.createElement('textarea'); ta.value = f.value; ta.spellcheck = false
        wrap.append(lab, ta); list.appendChild(wrap)
        autoSize(ta)
        ta.addEventListener('input', function () { autoSize(ta); libRefreshDirty() })
        libFields.push({ id: f.id, original: f.value, el: ta })
      })
      libLoaded = true
      libRefreshDirty()
      libSetStatus(b.fields.length + ' fields', 'ok')
    } catch (e) { libSetStatus(String(e), 'error') }
  }
  $('libreload').onclick = function () {
    if (libRefreshDirty() && !confirm('Discard unsaved edits and reload from disk?')) return
    libLoaded = false; loadLibrary()
  }
  $('libsave').onclick = async function () {
    var edits = libFields.filter(function (f) { return f.el.value !== f.original })
      .map(function (f) { return { id: f.id, value: f.el.value } })
    if (!edits.length) return
    $('libsave').disabled = true
    libSetStatus('saving ' + edits.length + ' field' + (edits.length > 1 ? 's' : '') + '…')
    try {
      var r = await fetch('/api/library', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits: edits }),
      })
      var b = await r.json()
      if (b.error) { libSetStatus('save failed: ' + b.error, 'error'); libRefreshDirty(); return }
      // Commit: the saved values become the new baseline (no reparse needed).
      libFields.forEach(function (f) { f.original = f.el.value })
      libRefreshDirty()
      libSetStatus('saved ' + (b.count || 0) + ' — re-summon the bot to apply', 'ok')
    } catch (e) { libSetStatus(String(e), 'error'); libRefreshDirty() }
  }
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
  if (url.pathname === '/api/prompt-config') return void handlePromptConfig(res)
  if (url.pathname === '/api/expand' && req.method === 'POST') return void handleExpand(req, res)
  if (url.pathname === '/api/chat' && req.method === 'POST') return void handleChat(req, res)
  if (url.pathname === '/api/library' && req.method === 'POST') return void handleLibrarySave(req, res)
  if (url.pathname === '/api/library') return void handleLibraryGet(res)
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

// Spawn `electron-vite dev`, forwarding our own flags out of the arg list and
// merging any extra env (the render-mirror dir + the dev-tools flag).
function spawnElectron (extraEnv) {
  const child = spawn(
    'electron-vite',
    ['dev', ...process.argv.slice(2).filter((a) => a !== '--viewer-only' && a !== '--tools')],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32', // resolve electron-vite.cmd via PATH
      env: { ...process.env, ...extraEnv },
    },
  )
  const forward = (sig) => { try { child.kill(sig) } catch { /* already gone */ } }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))
  return child
}

if (!DEV_TOOLS) {
  // Clean launch: no viewer server, no browser tab, no auto DevTools console.
  const child = spawnElectron({})
  child.on('exit', (code, signal) => process.exit(signal ? 0 : code ?? 0))
} else {
  await mkdir(RENDER_DIR, { recursive: true })
  // Drop the previous session's frame so a stale render is never mistaken for live.
  await unlink(RENDER_FILE).catch(() => {})

  const { server, port } = await listen(BASE_PORT, 10)
  const url = `http://localhost:${port}`
  console.log(`[dev-viewer] ${url}  (logs: ${LOG_DIRS.map((d) => d.dir).join(' | ')})`)
  openBrowser(url)

  if (VIEWER_ONLY) {
    // Serve until killed; nothing else to manage.
  } else {
    // SEI_DEV_TOOLS=1 tells the app (windowChrome.ts) to auto-open its console.
    const child = spawnElectron({ SEI_DEV_VIEWER_DIR: RENDER_DIR, SEI_DEV_TOOLS: '1' })
    child.on('exit', (code, signal) => {
      server.close()
      process.exit(signal ? 0 : code ?? 0)
    })
  }
}
