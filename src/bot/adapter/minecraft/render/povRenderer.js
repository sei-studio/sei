// src/bot/adapter/minecraft/render/povRenderer.js
//
// VIS-01 — single-frame headless bot-POV render: world chunks -> downscaled JPEG buffer.
//
// THREE-PROCESS INVARIANT (CLAUDE.md): this MUST run in the bot utilityProcess ONLY.
// It needs live `bot.world` + `bot.entity` and dlopens native gl/canvas built for the
// Electron ABI. NEVER import this from src/main or src/renderer.
//
// Render path (15-RESEARCH.md "Pattern 1: Direct single-frame headless render"):
//   node-canvas-webgl createCanvas -> three.WebGLRenderer -> prismarine-viewer Viewer +
//   WorldView(bot.world) -> waitForChunksToRender -> renderer.render -> canvas.toBuffer JPEG.
//   We drive Viewer+WorldView DIRECTLY (NOT the `headless` MP4/ffmpeg export).
//
// ESM/CJS interop (CRITICAL — this repo is ESM, package.json "type":"module"):
//   prismarine-viewer, node-canvas-webgl, three are CJS-only. `require` is undefined in an
//   ESM module, so we build one via createRequire(import.meta.url). The packages also expect
//   `global.THREE` + `global.Worker` (the viewer's worldrenderer spawns worker_threads and
//   reads the THREE global) — set both before constructing anything, exactly as the package's
//   own lib/headless.js does.
//
// VIS-08 graceful degradation: on missing bot.version, unsupported version, no loaded chunks
// (unloaded world), a black/empty frame, OR the wall-clock timeout, return the sentinel
// { ok: false, reason: 'cant_see' } — NEVER throw, NEVER hang the bot.
//
// Wall-clock timeout (CLAUDE.md invariant — every external call has a timeout, no exceptions):
//   waitForChunksToRender can hang if chunks never arrive. We Promise.race it against a timer
//   and, after the race, clearTimeout + tear down the renderer/WorldView listeners to avoid
//   the GL-context / listener leak (15-RESEARCH.md Pitfall 5).

import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// prismarine-viewer's worldrenderer reads `global.THREE` and spawns worker_threads that
// reference `global.Worker`. Mirror lib/headless.js: set the globals before first use.
if (!globalThis.THREE) globalThis.THREE = require('three')
if (!globalThis.Worker) globalThis.Worker = require('worker_threads').Worker

const THREE = globalThis.THREE
// node-canvas-webgl exposes createCanvas from its /lib subpath (the package's own headless
// example imports 'node-canvas-webgl/lib').
const { createCanvas } = require('node-canvas-webgl/lib')
const { Viewer, WorldView } = require('prismarine-viewer/viewer')

/** Degrade sentinel — returned instead of throwing/hanging (VIS-08). */
const CANT_SEE = Object.freeze({ ok: false, reason: 'cant_see' })

// A single long-lived WebGLRenderer is reused across renders to avoid headless-gl's live
// GL-context limit (15-RESEARCH.md Pitfall 5 — "too many active WebGL contexts"). The Viewer
// + WorldView, by contrast, are per-render (they bind to a specific bot + position) and are
// always torn down in the finally block.
let sharedCanvas = null
let sharedRenderer = null
let sharedSize = { width: 0, height: 0 }

function acquireRenderer (width, height) {
  if (sharedRenderer && (sharedSize.width !== width || sharedSize.height !== height)) {
    // Size changed (e.g. config.vision.resolution_px edited) — rebuild the context.
    disposeRenderer()
  }
  if (!sharedRenderer) {
    sharedCanvas = createCanvas(width, height)
    sharedRenderer = new THREE.WebGLRenderer({ canvas: sharedCanvas })
    sharedSize = { width, height }
  }
  return { canvas: sharedCanvas, renderer: sharedRenderer }
}

/**
 * Release the shared GL context. Callers may invoke this on bot stop to free the
 * headless-gl context, or leave the renderer alive for the every-60s idle hot path.
 */
export function disposeRenderer () {
  try { sharedRenderer?.dispose?.() } catch { /* best-effort */ }
  try {
    const gl = sharedCanvas?.__gl__
    gl?.getExtension?.('STACKGL_destroy_context')?.destroy?.()
  } catch { /* best-effort */ }
  sharedRenderer = null
  sharedCanvas = null
  sharedSize = { width: 0, height: 0 }
}

/**
 * Cheap black/empty-frame detector. Reads back the GL framebuffer and returns true if every
 * sampled pixel is the scene's background clear color (lightblue) — i.e. nothing rendered in
 * front of the camera. Sampling a sparse grid keeps this O(1)-ish regardless of resolution.
 */
function isBlankFrame (canvas) {
  try {
    const gl = canvas.__gl__
    if (!gl) return true
    const w = canvas.width
    const h = canvas.height
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    // three sets scene.background to THREE.Color('lightblue') = (173,216,230). If every
    // sampled pixel is within a tolerance of that, the scene drew nothing but sky.
    const BG = [173, 216, 230]
    const TOL = 12
    const samples = 64
    let nonBg = 0
    for (let s = 0; s < samples; s++) {
      const idx = Math.floor((s / samples) * (w * h)) * 4
      const dr = Math.abs(pixels[idx] - BG[0])
      const dg = Math.abs(pixels[idx + 1] - BG[1])
      const db = Math.abs(pixels[idx + 2] - BG[2])
      if (dr > TOL || dg > TOL || db > TOL) nonBg++
    }
    return nonBg === 0
  } catch {
    // If we can't read pixels, don't claim blank — let the chunk-count gate decide.
    return false
  }
}

/**
 * Render one bot-POV frame to a downscaled JPEG buffer.
 *
 * @param {import('mineflayer').Bot} bot  Live mineflayer bot (utilityProcess only).
 * @param {object} [opts]
 * @param {number} [opts.width=256]       Render width in px (D-03 ~256; VIS-06 ≤512 ceiling).
 * @param {number} [opts.height=256]      Render height in px.
 * @param {number} [opts.viewDistance=4]  Chunk view distance for the WorldView.
 * @param {number} [opts.quality=0.4]     JPEG quality 0..1 (D-03 aggressive compression).
 * @param {number} [opts.timeoutMs=5000]  Wall-clock cap on chunk wait + render.
 * @returns {Promise<{ok:true,buffer:Buffer,mediaType:'image/jpeg'}|{ok:false,reason:'cant_see'}>}
 */
export async function renderPov (bot, {
  width = 256,
  height = 256,
  viewDistance = 4,
  quality = 0.4,
  timeoutMs = 5000
} = {}) {
  // VIS-08 guard: setVersion calls window.alert on an unsupported version (ReferenceError in
  // headless Node), so we never call it without a version string.
  if (!bot?.version || !bot?.entity?.position || !bot?.world) return CANT_SEE

  let worldView = null
  let timeoutHandle = null
  let timedOut = false
  const { canvas, renderer } = acquireRenderer(width, height)

  try {
    const viewer = new Viewer(renderer)
    if (!viewer.setVersion(bot.version)) return CANT_SEE // unsupported version (VIS-08)

    const center = bot.entity.position
    // viewer.setFirstPersonCamera adds viewer.playerHeight to pos.y internally, so we pass the
    // RAW body position (NOT pre-offset by eyeHeight) — confirmed against the installed
    // lib/viewer.js + lib/headless.js.
    worldView = new WorldView(bot.world, viewDistance, center)
    viewer.listen(worldView)
    worldView.listenToBot(bot)
    await worldView.init(center)

    // VIS-08: if no columns loaded (unloaded world), the scene is empty — degrade instead of
    // returning a blue-sky frame. loadedChunks only gains keys for columns the world actually
    // had data for.
    if (Object.keys(worldView.loadedChunks).length === 0) return CANT_SEE

    // Wall-clock timeout race (CLAUDE.md invariant): waitForChunksToRender can hang if a
    // worker never reports back. Whichever settles first wins.
    const renderReady = viewer.waitForChunksToRender()
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => { timedOut = true; resolve('timeout') }, timeoutMs)
    })
    const outcome = await Promise.race([renderReady.then(() => 'ok'), timeout])
    if (timeoutHandle != null) { clearTimeout(timeoutHandle); timeoutHandle = null }
    if (outcome === 'timeout' || timedOut) return CANT_SEE

    viewer.setFirstPersonCamera(center, bot.entity.yaw, bot.entity.pitch)
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)

    // VIS-08 secondary gate: even with chunks "loaded", if the camera faces an empty/unbuilt
    // direction the frame can be pure sky — treat an all-background frame as can't-see.
    if (isBlankFrame(canvas)) return CANT_SEE

    // Downscale + encode in one step: the canvas IS the target resolution (~256px), so
    // toBuffer('image/jpeg', {quality}) emits the aggressively-compressed frame directly
    // (D-03 / VIS-06 — well under the 512px ceiling).
    const buffer = canvas.toBuffer('image/jpeg', { quality })
    if (!buffer || buffer.length === 0) return CANT_SEE

    return { ok: true, buffer, mediaType: 'image/jpeg' }
  } catch {
    // Any unexpected failure degrades rather than crashing the bot (VIS-08).
    return CANT_SEE
  } finally {
    // Post-race / post-render teardown to avoid the GL-context / listener leak (Pitfall 5).
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
    try { worldView?.removeListenersFromBot?.(bot) } catch { /* best-effort */ }
    // The shared renderer/canvas are intentionally NOT disposed here (reused across renders);
    // callers free them via disposeRenderer() on bot stop.
  }
}

export { CANT_SEE }
