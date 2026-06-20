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
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { skyColorForTime } from './skyColor.js'

const require = createRequire(import.meta.url)

// prismarine-viewer's worldrenderer reads `global.THREE` and spawns worker_threads that
// reference `global.Worker`. Mirror lib/headless.js: set the globals before first use.
//
// THREE must be resolved from prismarine-viewer's OWN dependency tree, not from this
// module: skinview3d hoists a newer three (0.156.x) to the root node_modules, while
// prismarine-viewer's internals (viewer.js, worldrenderer.js) require their nested
// 0.128.0. A bare require('three') here hands the renderer + entity code the hoisted
// copy, and mixing the two THREE instances breaks every render (blank/throwing frames
// surfacing as CANT_SEE). lib/headless.js gets away with a bare require because it
// lives inside the package; we have to re-anchor resolution there explicitly.
const pvRequire = createRequire(require.resolve('prismarine-viewer/package.json'))
if (!globalThis.THREE) globalThis.THREE = pvRequire('three')
if (!globalThis.Worker) globalThis.Worker = require('worker_threads').Worker

const THREE = globalThis.THREE
// node-canvas-webgl exposes createCanvas from its /lib subpath (the package's own headless
// example imports 'node-canvas-webgl/lib').
const { createCanvas } = require('node-canvas-webgl/lib')
const { Viewer, WorldView } = require('prismarine-viewer/viewer')

// ── Entity-model guard ──────────────────────────────────────────────────────
// prismarine-viewer's entity models are frozen at ~1.16 (94 types in
// viewer/lib/entity/entities.json). Every modern type the server spawns (item
// drops, glow_squid, frog, axolotl, armadillo, ...) throws inside getEntityMesh,
// which console.logs a FULL stack trace per spawn event — flooding the bot log
// and the dev viewer — then falls back to a magenta debug box that pollutes the
// LLM's view with "strange pink blocks". A SECOND failure mode does the same:
// 7 stock 1.16 models (piglin, piglin_brute, pillager, vex, witch,
// zombified_piglin) have a bone whose `parent` is missing, so getMesh throws at
// `bones[parent].add` — caught by getEntityMesh but still logged + magenta-boxed.
// Alias the 1:1 lookalike (glow_squid -> squid), and for anything that would
// still throw — NO model OR a structurally broken one — swallow every event
// (one line per type). modelRenderable() below judges which.
// pvRequire resolves inside prismarine-viewer's own tree, so these are the very
// module instances Entity.js / viewer.js close over.
const entityModels = pvRequire('./viewer/lib/entity/entities.json')
if (!entityModels.glow_squid && entityModels.squid) entityModels.glow_squid = entityModels.squid
{
  const { Entities } = pvRequire('./viewer/lib/entities')
  const warnedTypes = new Set()
  // entityMoved/entityGone events carry only the id (no name) — getEntityMesh
  // on a name-less, never-meshed entity builds a NaN-sized box, so every event
  // for a skipped id must be swallowed too, not just the spawn.
  const skippedIds = new Set()

  // Would `new Entity('1.16.4', name)` throw inside getMesh? It does when a
  // textured geometry has a bone whose `parent` is not in the model (the
  // Entity.js:171 `bones[parent].add` crash). Judge it up front from the static
  // model JSON and memoize — same outcome as the no-model case: skip + warn.
  const renderableByName = new Map()
  function modelRenderable (name) {
    if (renderableByName.has(name)) return renderableByName.get(name)
    let ok = true
    const e = entityModels[name]
    if (!e || !e.geometry) {
      ok = false
    } else {
      for (const [geoName, jsonModel] of Object.entries(e.geometry)) {
        if (!e.textures || !e.textures[geoName]) continue // ctor skips textureless geoms
        const bones = jsonModel && jsonModel.bones
        if (!Array.isArray(bones)) continue
        const names = new Set(bones.map(b => b && b.name))
        if (bones.some(b => b && b.parent && !names.has(b.parent))) { ok = false; break }
      }
    }
    renderableByName.set(name, ok)
    return ok
  }

  const realUpdate = Entities.prototype.update
  Entities.prototype.update = function (entity) {
    if (entity?.name && !modelRenderable(entity.name)) {
      if (!warnedTypes.has(entity.name)) {
        warnedTypes.add(entity.name)
        const why = entityModels[entity.name] ? 'broken viewer model' : 'no viewer model'
        console.log(`[sei/vision] ${why} for entity "${entity.name}" — not rendered`)
      }
      skippedIds.add(entity.id)
      return
    }
    if (entity && skippedIds.has(entity.id)) {
      if (entity.delete) skippedIds.delete(entity.id)
      return
    }
    return realUpdate.call(this, entity)
  }
}

/**
 * Spawn-race guard — the FSM's first idle tick can run visualize 1-2s after
 * join, while the server is STILL STREAMING chunks to mineflayer. worldView.init
 * then snapshots only the 1-2 columns loaded so far and waitForChunksToRender
 * happily resolves with almost nothing meshed: the "single dirt mound floating
 * in sky" frames. Wait (deadline-bounded) for the 5x5 columns around the bot
 * before snapshotting. On a settled world mineflayer resolves this immediately
 * from loaded-column lookups — effectively free on the idle hot path.
 */
async function waitForNearbyColumns (bot, deadlineAt) {
  if (typeof bot.waitForChunksToLoad !== 'function') return
  let handle = null
  const timer = new Promise((resolve) => {
    handle = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()))
  })
  // mineflayer rejects after its own internal 10s — degrade to "render what we
  // have" rather than failing the frame.
  await Promise.race([bot.waitForChunksToLoad().catch(() => {}), timer])
  if (handle != null) clearTimeout(handle)
}

/**
 * The block-texture atlas loads asynchronously (worldrenderer.updateTexturesData
 * -> loadTexture) and waitForChunksToRender does NOT cover it: the first render
 * after process start can win that race and ship an untextured vertex-color-only
 * frame. Upstream consumers never see this because they run continuous render
 * loops. loadTexture caches by path, so only the first render per process waits.
 */
async function waitForAtlas (viewer, deadlineAt) {
  while (!viewer.world.material.map && Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Degrade sentinel — returned instead of throwing/hanging (VIS-08). */
const CANT_SEE = Object.freeze({ ok: false, reason: 'cant_see' })

/**
 * Dev-only tap for scripts/dev-viewer.mjs (`npm run dev` browser viewer):
 * mirror each successful frame to $SEI_DEV_VIEWER_DIR/latest-render.jpg via
 * tmp+rename so the viewer's HTTP reads never see a half-written file.
 * Fire-and-forget and inert in production — only the dev-viewer wrapper sets
 * the env var, and a write failure can never affect the render result.
 */
function devViewerTap (buffer) {
  const dir = process.env.SEI_DEV_VIEWER_DIR
  if (!dir) return
  const tmp = join(dir, `.latest-render.${process.pid}.tmp`)
  writeFile(tmp, buffer)
    .then(() => rename(tmp, join(dir, 'latest-render.jpg')))
    .catch(() => { /* viewer misses a frame; bot unaffected */ })
}

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
 * sampled pixel is the scene's background clear color — i.e. nothing rendered in
 * front of the camera. Sampling a sparse grid keeps this O(1)-ish regardless of resolution.
 *
 * @param {number[]} bg  The [r,g,b] the scene background was set to for THIS
 *   render (time-of-day dependent — must match the color actually used, or
 *   night frames would never read as blank / day frames always would).
 */
function isBlankFrame (canvas, bg) {
  try {
    const gl = canvas.__gl__
    if (!gl) return true
    const w = canvas.width
    const h = canvas.height
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const BG = bg ?? [173, 216, 230]
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
 * @param {number} [opts.timeoutMs=7000]  Wall-clock cap on column wait + chunk mesh + render.
 * @returns {Promise<{ok:true,buffer:Buffer,mediaType:'image/jpeg'}|{ok:false,reason:'cant_see'}>}
 */
export async function renderPov (bot, {
  width = 256,
  height = 256,
  viewDistance = 4,
  quality = 0.4,
  timeoutMs = 7000
} = {}) {
  // VIS-08 guard: setVersion calls window.alert on an unsupported version (ReferenceError in
  // headless Node), so we never call it without a version string.
  if (!bot?.version || !bot?.entity?.position || !bot?.world) return CANT_SEE

  // ONE deadline shared by every wait below (CLAUDE.md invariant): column
  // streaming + section meshing + atlas load together never exceed timeoutMs.
  const deadlineAt = Date.now() + timeoutMs

  let viewer = null
  let worldView = null
  let timeoutHandle = null
  let timedOut = false
  const { canvas, renderer } = acquireRenderer(width, height)

  try {
    // Spawn race: don't snapshot a world the server is still streaming in.
    await waitForNearbyColumns(bot, deadlineAt)

    viewer = new Viewer(renderer)
    if (!viewer.setVersion(bot.version)) return CANT_SEE // unsupported version (VIS-08)

    // RAW body position (NOT pre-offset by eyeHeight) — the camera set below adds
    // viewer.playerHeight itself, matching what setFirstPersonCamera would do.
    const center = bot.entity.position
    worldView = new WorldView(bot.world, viewDistance, center)
    viewer.listen(worldView)
    worldView.listenToBot(bot)
    await worldView.init(center)

    // VIS-08: if no columns loaded (unloaded world), the scene is empty — degrade instead of
    // returning a blue-sky frame. loadedChunks only gains keys for columns the world actually
    // had data for.
    if (Object.keys(worldView.loadedChunks).length === 0) return CANT_SEE

    // Wall-clock timeout race (CLAUDE.md invariant): waitForChunksToRender can hang if a
    // worker never reports back. Whichever settles first wins. Uses the budget
    // REMAINING after the column wait, so the overall cap stays timeoutMs.
    const renderReady = viewer.waitForChunksToRender()
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => { timedOut = true; resolve('timeout') }, Math.max(0, deadlineAt - Date.now()))
    })
    const outcome = await Promise.race([renderReady.then(() => 'ok'), timeout])
    if (timeoutHandle != null) { clearTimeout(timeoutHandle); timeoutHandle = null }
    if (outcome === 'timeout' || timedOut) return CANT_SEE

    // First-render-per-process texture race: geometry can finish meshing before
    // the atlas image decodes; rendering then ships untextured blocks.
    await waitForAtlas(viewer, deadlineAt)

    // Set the camera DIRECTLY — do not use viewer.setFirstPersonCamera. It
    // tweens position over 50ms (TWEEN.update() driven by a continuous render
    // loop), so a single-frame render ships with the camera still at the
    // origin, staring at the underside of the world from y=0. The +playerHeight
    // eye offset and the 'ZYX' Euler order mirror setFirstPersonCamera's own
    // internals (confirmed against the installed lib/viewer.js).
    viewer.camera.position.set(center.x, center.y + viewer.playerHeight, center.z)
    viewer.camera.rotation.set(bot.entity.pitch, bot.entity.yaw, 0, 'ZYX')

    // Time-of-day sky (260611): override the viewer's hardcoded 'lightblue'
    // with an approximate color for the world's current time, so night
    // renders read as night. isBlankFrame compares against the SAME color.
    const sky = skyColorForTime(bot.time?.timeOfDay)
    try { viewer.scene.background = new THREE.Color(sky[0] / 255, sky[1] / 255, sky[2] / 255) } catch { /* best-effort */ }

    viewer.update()
    renderer.render(viewer.scene, viewer.camera)

    // VIS-08 secondary gate: even with chunks "loaded", if the camera faces an empty/unbuilt
    // direction the frame can be pure sky — treat an all-background frame as can't-see.
    if (isBlankFrame(canvas, sky)) return CANT_SEE

    // Downscale + encode in one step: the canvas IS the target resolution (~256px), so
    // toBuffer('image/jpeg', {quality}) emits the aggressively-compressed frame directly
    // (D-03 / VIS-06 — well under the 512px ceiling).
    const buffer = canvas.toBuffer('image/jpeg', { quality })
    if (!buffer || buffer.length === 0) return CANT_SEE

    devViewerTap(buffer)

    return { ok: true, buffer, mediaType: 'image/jpeg' }
  } catch (err) {
    // Any unexpected failure degrades rather than crashing the bot (VIS-08) —
    // but log it: a silent catch here hid the three.js version-mismatch
    // regression behind an indistinguishable "can't see".
    try { console.error(`[sei/vision] renderPov failed: ${err && err.message}`) } catch { /* best-effort */ }
    return CANT_SEE
  } finally {
    // Post-race / post-render teardown to avoid the GL-context / listener leak (Pitfall 5).
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
    try { worldView?.removeListenersFromBot?.(bot) } catch { /* best-effort */ }
    // The per-render Viewer's WorldRenderer spawns 4 worker_threads (each with a
    // 50ms setInterval) and prismarine-viewer never terminates them — without
    // this, EVERY render leaks 4 live threads and the bot process degrades over
    // a session. The geometry they produced is already in the encoded JPEG.
    try { viewer?.world?.workers?.forEach((w) => w.terminate?.()) } catch { /* best-effort */ }
    // The shared renderer/canvas are intentionally NOT disposed here (reused across renders);
    // callers free them via disposeRenderer() on bot stop.
  }
}

export { CANT_SEE }
