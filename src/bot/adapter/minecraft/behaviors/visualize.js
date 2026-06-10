// src/bot/adapter/minecraft/behaviors/visualize.js
//
// VIS-02 / VIS-08 — the `visualize` action handler. This is path (a) of D-01:
// the LLM-callable explicit render. It drives renderPov (proven in 15-01)
// behind a wall-clock timeout (CLAUDE.md "every external call has a timeout"),
// honors config.signal abort (lookAt convention), and degrades to a short
// STRING when chunks aren't loaded (VIS-08) — it never throws and never hangs.
//
// ESM-only on the module graph here: the only heavy thing this imports is
// renderPov, whose module statically requires native gl/canvas. Tests vi.mock
// '../render/povRenderer.js' so the natives never load under system-Node vitest.
//
// RETURN SHAPE — the load-bearing contract 15-06 reads to attach the image:
//   success:        { text: string, image: { mediaType: string, dataBase64: string } }
//   degrade:        "I can't see clearly right now"   (VIS-08 — a string)
//   aborted:        'aborted'                           (lookAt convention)
//   idle duplicate: { skip: true }                      (D-02 — drop the send)
// The exact success keys are asserted in visualize.test.js; do NOT add keys or
// re-nest without updating 15-06's destructure (image.mediaType / image.dataBase64).

import { renderPov } from '../render/povRenderer.js'

/** VIS-08 degrade copy (D-01 discretion wording). Returned, never thrown. */
export const CANT_SEE_COPY = "I can't see clearly right now"

/** Handler-level wall-clock cap. renderPov is already timeout-wrapped (5s), but
 * we ALSO race a timer here so a hung/never-settling renderPov (or a mock that
 * never resolves) can never wedge the bot loop. Slightly longer than
 * renderPov's internal default so the inner timeout normally wins first. */
export const DEFAULT_VISION_TIMEOUT_MS = 8000

// Aggressive-compression ceiling on the outbound base64 (request-size safety,
// ASVS V5). ~256px q0.4 keeps a frame to low single-digit KB; this is a guard
// against a misconfigured huge resolution_px, not the primary size control.
const MAX_BASE64_BYTES = 256 * 1024 // 256 KB of base64 chars

// ── Idle frame dedupe (D-02) ────────────────────────────────────────────────
// Cheap pose-quantization hash: a parked bot re-renders the same view every
// idle tick, so quantizing position (whole blocks) + yaw/pitch (coarse buckets)
// detects "effectively unchanged" without hashing the JPEG buffer. Only the
// IDLE caller (15-07) opts into dedupe (args.idle === true); the EXPLICIT path
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
 * Render the bot's current POV and return a structured image result (or a
 * graceful degrade). Mirrors lookAt's (args, bot, config) signature, abort-first
 * early return, and timeout/abort race discipline.
 *
 * @param {{ idle?: boolean }} args   `idle:true` opts into D-02 dedupe (15-07).
 * @param {object} bot                Live mineflayer bot (utilityProcess only).
 * @param {object} config             Validated config; reads config.vision + config.signal.
 * @returns {Promise<
 *   { text: string, image: { mediaType: string, dataBase64: string } }
 *   | { skip: true }
 *   | string >}
 */
export async function visualizeAction(args, bot, config) {
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
  // nothing here can ever wedge the loop. Cleanup (clearTimeout /
  // removeEventListener) runs after the race regardless of who wins.
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

  // Post-race cleanup (pathfind.js discipline) — clear the orphan timer and the
  // abort listener so neither lingers against a reused renderer/listener set.
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
  // We quantize the bot pose; a matching hash means a parked bot is sending the
  // same view again, so the idle caller (15-07) should drop the send. The
  // explicit path (no idle flag) always returns the fresh frame.
  if (args?.idle === true) {
    const hash = poseHash(bot)
    if (hash != null && hash === _lastIdleHash) return { skip: true }
    _lastIdleHash = hash
  }

  // base64-encode the render buffer for the LLM image content block.
  const dataBase64 = result.buffer.toString('base64')

  // Request-size safety (ASVS V5): a misconfigured huge resolution could blow
  // up the payload — degrade rather than ship an oversized image. ~256px q0.4
  // is well under this ceiling.
  if (dataBase64.length > MAX_BASE64_BYTES) return CANT_SEE_COPY

  // EXACT shape — 15-06 destructures image.mediaType / image.dataBase64.
  return {
    text: 'rendered view attached',
    image: {
      mediaType: result.mediaType,
      dataBase64,
    },
  }
}
