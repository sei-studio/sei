// src/bot/adapter/minecraft/behaviors/visualize.js
//
// VIS-02 / VIS-08 — the `look` action handler (LLM-callable explicit render),
// plus the shared low-level capture/face helpers that `explore` reuses for its
// auto-look on arrival. It drives renderPov (proven in 15-01) behind a
// wall-clock timeout (CLAUDE.md "every external call has a timeout"), honors
// config.signal abort (lookAt convention), and degrades to a short STRING when
// chunks aren't loaded (VIS-08) — it never throws and never hangs.
//
// 260617: `look` is now DIRECTIONAL and RELATIVE to the bot's current facing:
//   look()                       — current view
//   look({orientation})          — forward | backwards | left | right (turn, then render)
//   look({angle})                — 0..360° clockwise from current facing
//   look({around:true})          — four frames (forward, right, behind, left), each labelled
// The old coordinate/entity aiming (x,y,z / entity / target) is GONE — the new
// model is "turn relative to where I'm facing", which is what a player does.
//
// ESM-only on the module graph here: the only heavy thing this imports is
// renderPov, whose module statically requires native gl/canvas. Tests vi.mock
// '../render/povRenderer.js' so the natives never load under system-Node vitest.
//
// RETURN SHAPE — the load-bearing contract the orchestrator reads to attach the image:
//   single success: { text: string, image: { mediaType, dataBase64 } }
//   around success: { text: string, images: [{ mediaType, dataBase64, label }, ...] }
//   degrade:        "I can't see clearly right now"   (VIS-08 — a string)
//   aborted:        'aborted'                           (lookAt convention)
//   idle duplicate: { skip: true }                      (D-02 — drop the send)
// The single-image keys are asserted in visualize.test.js; do NOT add keys or
// re-nest without updating the orchestrator's destructure
// (image.mediaType / image.dataBase64 / images[].*).

import { renderPov } from '../render/povRenderer.js'

/** VIS-08 degrade copy (D-01 discretion wording). Returned, never thrown. */
export const CANT_SEE_COPY = "I can't see clearly right now"

/**
 * Anti-hallucination grounding that rides with every rendered view (the result
 * `text`, which sits right next to the image and the fresh snapshot in the same
 * turn). The render is a low-resolution JPEG of a world drawn with frozen,
 * approximate models, so it is easy to over-read — the model was confidently
 * reporting "pink sheep" / specific species and counts that the snapshot's
 * ground-truth entity list contradicted. Tell it to read the picture loosely and
 * defer to the snapshot for what is actually there.
 */
export const VISION_GROUNDING = 'The picture is low resolution and rough, so read it loosely: name only the broad things you can clearly make out (terrain shape, water, trees, structures, your own builds) and do not invent specific mob types, animal colors, counts, or fine detail from it. For which mobs or animals are actually nearby, trust the nearby-entities list in your snapshot, which is accurate, over the picture.'

/** Cap on the pre-render head turn — facing is best-effort, never a stall. */
export const FACE_TIMEOUT_MS = 800

/** Handler-level wall-clock cap. renderPov is already timeout-wrapped (7s —
 * the budget now also covers waiting out the post-join chunk stream), but we
 * ALSO race a timer here so a hung/never-settling renderPov (or a mock that
 * never resolves) can never wedge the bot loop. Slightly longer than
 * renderPov's internal default so the inner timeout normally wins first. */
export const DEFAULT_VISION_TIMEOUT_MS = 9000

// Aggressive-compression ceiling on the outbound base64 (request-size safety,
// ASVS V5). ~256px q0.4 keeps a frame to low single-digit KB; this is a guard
// against a misconfigured huge resolution_px, not the primary size control.
const MAX_BASE64_BYTES = 256 * 1024 // 256 KB of base64 chars

// ── Relative-direction grammar ───────────────────────────────────────────────
// Orientation names and angles are CLOCKWISE / right-positive, relative to the
// bot's current facing: forward = 0, right = 90, backwards = 180, left = 270.
// In mineflayer the look vector for a yaw is (-sin yaw, -cos yaw) (matches the
// povRenderer camera, our ground truth), under which INCREASING yaw turns LEFT.
// So a clockwise/right-positive angle maps to a NEGATIVE yaw offset.
export const ORIENTATION_DEG = Object.freeze({
  forward: 0, forwards: 0, front: 0,
  right: 90,
  backward: 180, backwards: 180, back: 180, behind: 180,
  left: 270,
})

/** Parse {orientation}|{angle} into a yaw offset in radians, or null if neither
 * was supplied (caller treats null as "don't turn — current facing"). */
export function orientationToYawOffset(args) {
  let deg = null
  if (typeof args?.angle === 'number' && Number.isFinite(args.angle)) {
    deg = args.angle
  } else if (typeof args?.orientation === 'string') {
    const key = args.orientation.toLowerCase()
    if (key in ORIENTATION_DEG) deg = ORIENTATION_DEG[key]
  }
  if (deg == null) return null
  // Clockwise/right-positive angle → negative yaw offset (see note above).
  return -(((deg % 360) + 360) % 360) * Math.PI / 180
}

/** Unit ground vector [dx, dz] for a mineflayer yaw (matches the POV camera). */
export function yawToUnit(yaw) {
  return [-Math.sin(yaw), -Math.cos(yaw)]
}

/** Best-effort head turn to an absolute yaw; capped so it never stalls. */
export async function faceYaw(bot, yaw) {
  if (typeof bot?.look !== 'function' || !Number.isFinite(yaw)) return
  let timer = null
  // Hold the gaze controller (behaviors/gaze.js) off the head while we aim
  // this render's turn — it would otherwise fight this lookAt on its own
  // ~4Hz tick and jitter the shot.
  if (bot) bot._seiGazeHold = (bot._seiGazeHold ?? 0) + 1
  try {
    await Promise.race([
      Promise.resolve().then(() => bot.look(yaw, 0, true)).catch(() => { /* best-effort */ }),
      new Promise((resolve) => { timer = setTimeout(resolve, FACE_TIMEOUT_MS) }),
    ])
  } finally {
    if (bot) bot._seiGazeHold = Math.max(0, (bot._seiGazeHold ?? 1) - 1)
  }
  if (timer != null) clearTimeout(timer)
}

// ── Idle frame dedupe (D-02) ────────────────────────────────────────────────
// Cheap pose-quantization hash: a parked bot re-renders the same view every
// idle tick, so quantizing position (whole blocks) + yaw/pitch (coarse buckets)
// detects "effectively unchanged" without hashing the JPEG buffer. Only the
// IDLE caller (15-07) opts into dedupe (idle === true); the EXPLICIT path
// (the model asked for a fresh look) never dedupes.
let _lastIdleHash = null

function poseHash(bot) {
  const p = bot?.entity?.position
  if (!p) return null
  const qx = Math.round(p.x)
  const qy = Math.round(p.y)
  const qz = Math.round(p.z)
  // ~8 yaw buckets and ~4 pitch buckets — enough to notice the bot turned to
  // look somewhere genuinely different without firing on sub-degree jitter.
  const yaw = bot?.entity?.yaw ?? 0
  const pitch = bot?.entity?.pitch ?? 0
  const qyaw = Math.round((yaw / (Math.PI / 4)))
  const qpitch = Math.round((pitch / (Math.PI / 4)))
  return `${qx},${qy},${qz}|${qyaw},${qpitch}`
}

/** Test seam — reset the idle dedupe cache between cases. */
export function __resetVisualizeDedupeCache() {
  _lastIdleHash = null
}

/**
 * Low-level single-frame capture: render the bot's CURRENT POV behind the
 * wall-clock + abort race and return a structured frame, a degrade string, or
 * 'aborted'. Shared by `look` (every variant) and `explore`'s auto-look.
 *
 * @param {object} bot     Live mineflayer bot (utilityProcess only).
 * @param {object} config  Validated config; reads config.vision + config.signal.
 * @param {{ idle?: boolean }} [opts]  idle:true opts into D-02 dedupe.
 * @returns {Promise<
 *   { ok: true, mediaType: string, dataBase64: string }
 *   | { skip: true }
 *   | string >}   ('aborted' or CANT_SEE_COPY)
 */
export async function captureFrame(bot, config, { idle = false } = {}) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  // config.vision is the source of truth for the render knobs (D-03/D-04).
  // resolution_px is already .max(512)-capped at parse time (15-03 / VIS-06).
  const vision = config?.vision ?? {}
  const res = vision.resolution_px ?? 256
  const quality = vision.image_quality ?? 0.4
  const timeoutMs = config?.vision_timeout_ms ?? DEFAULT_VISION_TIMEOUT_MS

  // ── Wall-clock + abort race around renderPov (CLAUDE.md invariant) ──────────
  // renderPov is itself timeout-wrapped + never throws by contract, but we
  // defend in depth: a Promise.race against our own timer + the abort signal so
  // nothing here can ever wedge the loop. Cleanup runs after the race regardless.
  let timeoutHandle = null
  let abortListener = null

  const renderPromise = Promise.resolve()
    .then(() => renderPov(bot, { width: res, height: res, quality }))
    .then((r) => ({ kind: 'render', value: r }))
    .catch(() => ({ kind: 'render', value: { ok: false, reason: 'cant_see' } }))

  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })

  const abortPromise = signal
    ? new Promise((resolve) => {
        abortListener = () => resolve({ kind: 'aborted' })
        signal.addEventListener('abort', abortListener, { once: true })
      })
    : null

  const racers = abortPromise
    ? [renderPromise, timeoutPromise, abortPromise]
    : [renderPromise, timeoutPromise]

  const outcome = await Promise.race(racers)

  if (timeoutHandle != null) clearTimeout(timeoutHandle)
  if (signal && abortListener) {
    try { signal.removeEventListener('abort', abortListener) } catch { /* best-effort */ }
  }

  if (outcome.kind === 'aborted') return 'aborted'
  if (outcome.kind === 'timeout') return CANT_SEE_COPY

  const result = outcome.value
  // VIS-08: renderPov reported it can't see (unloaded chunks, blank frame, etc.)
  if (!result || result.ok !== true) return CANT_SEE_COPY

  // ── Idle dedupe (D-02) — only on the idle path, AFTER a successful render ───
  if (idle === true) {
    const hash = poseHash(bot)
    if (hash != null && hash === _lastIdleHash) return { skip: true }
    _lastIdleHash = hash
  }

  // base64-encode the render buffer for the LLM image content block.
  const dataBase64 = result.buffer.toString('base64')

  // Request-size safety (ASVS V5): a misconfigured huge resolution could blow
  // up the payload — degrade rather than ship an oversized image.
  if (dataBase64.length > MAX_BASE64_BYTES) return CANT_SEE_COPY

  return { ok: true, mediaType: result.mediaType, dataBase64 }
}

// The four cardinal relative directions for look({around:true}), in clockwise
// order so the model reads them as a coherent sweep.
const AROUND = Object.freeze([
  { label: 'forward', deg: 0 },
  { label: 'right', deg: 90 },
  { label: 'behind', deg: 180 },
  { label: 'left', deg: 270 },
])

function degToYawOffset(deg) {
  return -(((deg % 360) + 360) % 360) * Math.PI / 180
}

/**
 * `look` action handler. Renders the bot's POV — current, turned to a relative
 * orientation/angle, or all four directions ({around:true}). Mirrors the
 * abort-first / timeout discipline of lookAt.
 *
 * @param {{orientation?:string, angle?:number, around?:boolean, idle?:boolean}} args
 * @param {object} bot     Live mineflayer bot (utilityProcess only).
 * @param {object} config  Validated config; reads config.vision + config.signal.
 */
export async function visualizeAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  // ── look({around:true}) — four labelled frames, restoring facing after ──────
  if (args?.around === true) {
    const startYaw = bot?.entity?.yaw ?? 0
    const images = []
    for (const dir of AROUND) {
      if (signal?.aborted) break
      await faceYaw(bot, startYaw + degToYawOffset(dir.deg))
      if (signal?.aborted) break
      const f = await captureFrame(bot, config)
      if (f && typeof f === 'object' && f.ok) {
        images.push({ mediaType: f.mediaType, dataBase64: f.dataBase64, label: dir.label })
      }
    }
    await faceYaw(bot, startYaw) // leave the bot facing where it started
    if (signal?.aborted) return 'aborted'
    if (!images.length) return CANT_SEE_COPY
    return {
      text: `looked around — ${images.length} views: ${images.map((i) => i.label).join(', ')}. ${VISION_GROUNDING}`,
      images,
    }
  }

  // ── look({orientation}|{angle}) — turn relative, then render one frame ───────
  // Idle/passive cadence renders never pass a direction (they document the
  // bot's own current view) and never turn the head.
  if (args?.idle !== true) {
    const offset = orientationToYawOffset(args)
    if (offset != null) {
      await faceYaw(bot, (bot?.entity?.yaw ?? 0) + offset)
      if (signal?.aborted) return 'aborted'
    }
  }

  const f = await captureFrame(bot, config, { idle: args?.idle === true })
  if (typeof f === 'string') return f               // 'aborted' or CANT_SEE_COPY
  if (f.skip === true) return { skip: true }        // idle near-duplicate (D-02)
  return { text: `rendered view attached. ${VISION_GROUNDING}`, image: { mediaType: f.mediaType, dataBase64: f.dataBase64 } }
}
