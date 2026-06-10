// src/bot/adapter/minecraft/behaviors/visualize.test.js
//
// VIS-02 / VIS-08 — the `visualize` action handler. This test MOCKS the
// renderPov module (./render/povRenderer.js) so the native gl/canvas chain is
// NEVER imported under system-Node vitest (the natives are built for the
// Electron 42 ABI and fail to dlopen here — see 15-01-SUMMARY).
//
// The load-bearing assertion is the EXACT success-result shape
//   { text: string, image: { mediaType: string, dataBase64: string } }
// which 15-06 destructures (image.mediaType / image.dataBase64) to attach the
// rendered frame as an image content block on the LLM turn. Extra keys or a
// nesting change would silently break that downstream contract.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the renderPov contract from 15-01. visualize.js imports renderPov from
// this exact specifier; mocking it keeps node-canvas-webgl / gl / canvas off
// the module graph entirely.
const renderPovMock = vi.fn()
vi.mock('../render/povRenderer.js', () => ({
  renderPov: (...args) => renderPovMock(...args),
}))

// Imported AFTER the mock is declared (vi.mock is hoisted, so this is safe).
const { visualizeAction, __resetVisualizeDedupeCache } = await import('./visualize.js')

// A minimal bot stub with the fields the dedupe hash quantizes (position +
// yaw/pitch). renderPov itself is mocked, so the bot is only read by the
// dedupe hash, never by a real render.
function makeBot(overrides = {}) {
  return {
    entity: {
      position: { x: 10.2, y: 64.0, z: -5.7 },
      yaw: 1.23,
      pitch: 0.1,
    },
    ...overrides,
  }
}

const config = { vision: { resolution_px: 256, image_quality: 0.4 } }

const okJpeg = () => ({
  ok: true,
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  mediaType: 'image/jpeg',
})

beforeEach(() => {
  renderPovMock.mockReset()
  __resetVisualizeDedupeCache()
})

describe('visualizeAction — success result shape (15-06 contract)', () => {
  it('returns EXACTLY { text, image:{ mediaType, dataBase64 } } on a successful render', async () => {
    renderPovMock.mockResolvedValue(okJpeg())
    const res = await visualizeAction({}, makeBot(), config)

    // Exact top-level keys — no extras, no nesting changes.
    expect(Object.keys(res)).toEqual(['text', 'image'])
    expect(Object.keys(res.image)).toEqual(['mediaType', 'dataBase64'])

    expect(typeof res.text).toBe('string')
    expect(res.text.length).toBeGreaterThan(0)
    expect(typeof res.image.mediaType).toBe('string')
    expect(res.image.mediaType).toBe('image/jpeg')
    expect(typeof res.image.dataBase64).toBe('string')

    // dataBase64 is the base64 encoding of the render buffer.
    expect(res.image.dataBase64).toBe(okJpeg().buffer.toString('base64'))
  })

  it('passes config.vision.resolution_px + image_quality through to renderPov', async () => {
    renderPovMock.mockResolvedValue(okJpeg())
    await visualizeAction({}, makeBot(), { vision: { resolution_px: 192, image_quality: 0.3 } })
    expect(renderPovMock).toHaveBeenCalledTimes(1)
    const [bot, opts] = renderPovMock.mock.calls[0]
    expect(bot).toBeDefined()
    expect(opts.width).toBe(192)
    expect(opts.height).toBe(192)
    expect(opts.quality).toBe(0.3)
  })
})

describe('visualizeAction — VIS-08 graceful degrade', () => {
  it('returns the degrade STRING when renderPov reports { ok:false }', async () => {
    renderPovMock.mockResolvedValue({ ok: false, reason: 'cant_see' })
    const res = await visualizeAction({}, makeBot(), config)
    expect(res).toBe("I can't see clearly right now")
  })

  it('returns the degrade STRING (never throws) when renderPov rejects', async () => {
    renderPovMock.mockRejectedValue(new Error('boom'))
    const res = await visualizeAction({}, makeBot(), config)
    expect(res).toBe("I can't see clearly right now")
  })

  it('returns the degrade STRING when renderPov exceeds the wall-clock timeout', async () => {
    // Never resolves — the handler's own timeout must fire.
    renderPovMock.mockImplementation(() => new Promise(() => {}))
    const res = await visualizeAction({}, makeBot(), { vision: { resolution_px: 256, image_quality: 0.4 }, vision_timeout_ms: 20 })
    expect(res).toBe("I can't see clearly right now")
  })
})

describe('visualizeAction — abort (lookAt convention)', () => {
  it("returns 'aborted' immediately when config.signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const res = await visualizeAction({}, makeBot(), { ...config, signal: controller.signal })
    expect(res).toBe('aborted')
    // renderPov must not even be called once we've early-returned on abort.
    expect(renderPovMock).not.toHaveBeenCalled()
  })
})

describe('visualizeAction — idle dedupe (D-02)', () => {
  it('returns { skip:true } for an idle near-duplicate frame (same pose)', async () => {
    renderPovMock.mockResolvedValue(okJpeg())
    const bot = makeBot()

    // First idle render: a real structured result is sent + remembered.
    const first = await visualizeAction({ idle: true }, bot, config)
    expect(Object.keys(first)).toEqual(['text', 'image'])

    // Second idle render at the SAME quantized pose: skipped.
    const second = await visualizeAction({ idle: true }, bot, config)
    expect(second).toEqual({ skip: true })
  })

  it('does NOT dedupe the EXPLICIT path — a fresh look always renders', async () => {
    renderPovMock.mockResolvedValue(okJpeg())
    const bot = makeBot()

    const first = await visualizeAction({}, bot, config) // explicit
    const second = await visualizeAction({}, bot, config) // explicit again, same pose
    expect(Object.keys(first)).toEqual(['text', 'image'])
    expect(Object.keys(second)).toEqual(['text', 'image'])
    expect(second).not.toEqual({ skip: true })
  })

  it('idle re-renders (no skip) when the pose changed enough to dedupe-differ', async () => {
    renderPovMock.mockResolvedValue(okJpeg())
    const bot = makeBot()

    const first = await visualizeAction({ idle: true }, bot, config)
    expect(Object.keys(first)).toEqual(['text', 'image'])

    // Move the bot far enough that the quantized pose differs.
    bot.entity.position = { x: 50.0, y: 64.0, z: 80.0 }
    const second = await visualizeAction({ idle: true }, bot, config)
    expect(Object.keys(second)).toEqual(['text', 'image'])
  })
})
