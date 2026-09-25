// src/bot/adapter/minecraft/render/povStackLoader.js
//
// 260926: load the POV render stack (native canvas + gl and their shared
// libraries, three, prismarine-viewer) without stalling the bot's event loop.
//
// Why: `import('./povRenderer.js')` runs one long SYNCHRONOUS chain of
// require()s and dlopen()s. On a cold Windows machine each native library is
// scanned by Defender as it is opened (canvas alone ships ~40 DLLs), so the
// chain could hold the event loop for 15 s or more. The bot is in the world by
// then, and a blocked loop cannot answer the server's keep-alive: the server
// kicks the bot right after it joins.
//
// How: three steps, each short on the loop.
//   1. prefetch  read every file of the stack ASYNCHRONOUSLY (libuv threads),
//                the native libraries first. The antivirus scan and the disk
//                read happen here, off the loop, and leave the OS file cache
//                and the scan verdict warm for step 2.
//   2. require   the heavy CommonJS pieces one at a time, in the order
//                povRenderer loads them (three, canvas, gl), yielding to the
//                event loop between them so keep-alives and packets drain.
//   3. import    povRenderer.js itself, which now only evaluates small JS.
//
// A failure is cached for the session and NOT retried. A failed ESM import
// stays in Node's module cache, and the usual causes (a missing module in the
// game pack, a native library that will not load) do not fix themselves in a
// running process; retrying would re-pay the whole load on every look().
// Callers ask visionUnavailable() and tell the player once.
//
// This module must not import the natives itself (it is imported by
// visualize.js, which the Minecraft runtime loads at boot).

import { createRequire } from 'module'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const NATIVE_FILE = /\.(node|dll|dylib)$|\.so(\.\d+)*$/i
const JS_FILE = /\.(c?js|json)$/i

const nowMs = () => (globalThis.performance?.now?.() ?? Date.now())
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

/**
 * The files to prefetch, native libraries first. Best-effort: a package that
 * does not resolve is skipped here and reported by the real require in step 2.
 * @param {(id: string) => string} resolve  a require.resolve anchored in prismarine-viewer
 */
async function stackFiles(resolve, { readdirFn = readdir } = {}) {
  const files = []
  const pkgDir = (name) => {
    try { return dirname(resolve(`${name}/package.json`)) } catch { return null }
  }
  // Natives: the top level of build/Release holds the addon and, on Windows
  // and macOS, the shared libraries it links (the build's obj/ trees are not
  // shipped and are skipped by the extension filter anyway).
  for (const name of ['canvas', 'gl']) {
    const dir = pkgDir(name)
    if (!dir) continue
    try {
      const release = join(dir, 'build', 'Release')
      for (const e of await readdirFn(release, { withFileTypes: true })) {
        if (e.isFile() && NATIVE_FILE.test(e.name)) files.push(join(release, e.name))
      }
    } catch { /* no build dir: let the require report it */ }
  }
  // JS: three (one ~1 MB file) and prismarine-viewer's viewer/ tree.
  try { files.push(resolve('three')) } catch {}
  const pv = pkgDir('prismarine-viewer')
  if (pv) {
    try {
      for (const e of await readdirFn(join(pv, 'viewer'), { withFileTypes: true, recursive: true })) {
        const parent = e.parentPath ?? e.path
        if (e.isFile() && JS_FILE.test(e.name) && parent) files.push(join(parent, e.name))
      }
    } catch {}
  }
  return files
}

/**
 * Build a loader. Everything injectable so the sequencing is unit-testable
 * without the natives.
 * @param {object} [deps]
 * @param {(msg: string) => void} [deps.log]
 * @param {(timing: object) => void} [deps.onLoaded]  gets the timing summary (success or failure)
 * @param {() => Promise<any>} [deps.importRenderer]
 * @param {(id: string) => any} [deps.pvRequire]  a require anchored in prismarine-viewer
 * @param {typeof readFile} [deps.readFileFn]
 * @param {typeof readdir} [deps.readdirFn]
 * @param {() => Promise<void>} [deps.yieldFn]
 */
export function createPovStackLoader(deps = {}) {
  const log = deps.log ?? ((m) => console.log(m))
  const importRenderer = deps.importRenderer ?? (() => import('./povRenderer.js'))
  const readFileFn = deps.readFileFn ?? readFile
  const readdirFn = deps.readdirFn ?? readdir
  const yieldFn = deps.yieldFn ?? yieldToLoop
  const getPvRequire = () => {
    if (deps.pvRequire) return deps.pvRequire
    const require = createRequire(import.meta.url)
    return createRequire(require.resolve('prismarine-viewer/package.json'))
  }

  let promise = null
  let failure = null
  let timing = null

  async function run() {
    const t0 = nowMs()
    const t = { ok: false, files: 0, bytes: 0, prefetch_ms: 0, require_ms: {}, import_ms: 0, total_ms: 0, longest_block_ms: 0 }
    const block = (ms) => { t.longest_block_ms = Math.max(t.longest_block_ms, Math.round(ms)) }
    try {
      const pvRequire = getPvRequire()

      // 1. prefetch, off the loop
      const tp = nowMs()
      for (const f of await stackFiles((id) => pvRequire.resolve(id), { readdirFn })) {
        try {
          const buf = await readFileFn(f)
          t.files += 1
          t.bytes += buf?.length ?? 0
        } catch { /* unreadable: the require reports it */ }
      }
      t.prefetch_ms = Math.round(nowMs() - tp)

      // 2. the heavy CommonJS pieces, one per event-loop turn. canvas and gl
      // resolve through node-canvas-webgl, as povRenderer's chain does.
      const ncwRequire = (() => {
        try { return createRequire(pvRequire.resolve('node-canvas-webgl/package.json')) } catch { return pvRequire }
      })()
      const steps = [
        ['three', () => pvRequire('three')],
        ['canvas', () => ncwRequire('canvas')],
        ['gl', () => ncwRequire('gl')],
      ]
      for (const [name, load] of steps) {
        await yieldFn()
        const ts = nowMs()
        load()
        const ms = nowMs() - ts
        t.require_ms[name] = Math.round(ms)
        block(ms)
      }

      // 3. the renderer module itself
      await yieldFn()
      const ti = nowMs()
      const mod = await importRenderer()
      t.import_ms = Math.round(nowMs() - ti)
      block(t.import_ms)
      t.ok = true
      return mod
    } catch (err) {
      t.error = String((err && err.message) || err).slice(0, 300)
      throw err
    } finally {
      t.total_ms = Math.round(nowMs() - t0)
      timing = t
      const req = Object.entries(t.require_ms).map(([k, v]) => `${k}=${v}`).join(' ')
      try {
        log(
          `[sei/vision] render stack ${t.ok ? 'loaded' : 'FAILED to load'} in ${t.total_ms}ms ` +
          `(prefetch ${t.prefetch_ms}ms, ${t.files} files, ${Math.round(t.bytes / 1024)}KB; ` +
          `require ${req || 'none'}; import ${t.import_ms}ms; longest block ${t.longest_block_ms}ms)` +
          (t.ok ? '' : `: ${t.error}. Vision is off for this session.`),
        )
      } catch {}
      try { deps.onLoaded?.({ ...t }) } catch {}
    }
  }

  return {
    /** Resolves to the povRenderer module. Loads once; a failure is final. */
    load() {
      if (!promise) {
        promise = run().catch((err) => {
          failure = err
          throw err
        })
      }
      return promise
    },
    /** True once a load has failed: vision is off for this process. */
    unavailable: () => failure != null,
    /** True once the renderer module is ready (no load cost left). */
    ready: () => timing?.ok === true,
    /** The last load's timing summary, or null before one finished. */
    timing: () => (timing ? { ...timing } : null),
  }
}

// ── Process-wide instance ───────────────────────────────────────────────────
let _loader = null
let _hooks = {}

/** Set the log/timing sinks for the process-wide loader (runtime.js, once). */
export function configurePovStackLoader(hooks = {}) {
  _hooks = { ...hooks }
}

function loader() {
  if (!_loader) {
    _loader = createPovStackLoader({
      log: (m) => (_hooks.log ?? ((x) => console.log(x)))(m),
      onLoaded: (t) => _hooks.onLoaded?.(t),
    })
  }
  return _loader
}

export const loadPovStack = () => loader().load()
export const povStackUnavailable = () => _loader?.unavailable() === true
export const povStackReady = () => _loader?.ready() === true

/** Test-only reset of the process-wide loader. */
export function __resetPovStackLoader() {
  _loader = null
  _hooks = {}
}
