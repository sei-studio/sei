// src/bot/adapter/minecraft/render/textureFallback.test.js
//
// 260806: a missing entity texture killed the bot mid-session. prismarine-viewer's
// loadTexture has no .catch, so an absent PNG became an unhandled rejection, which
// src/bot/index.js turns into BOT_CRASH + process.exit(1). Live: three sessions on
// one install died at 47s, 47s and 6.8min with the world still open.
//
// The regression these lock is specifically "the failure is SURVIVABLE": the
// callback still fires, with a usable texture, and NO promise is left rejected.
// `createSafeLoadTexture` takes its filesystem probe and image loader as deps, so
// none of this needs prismarine-viewer, node-canvas or a GL context.

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createSafeLoadTexture,
  texturePresent,
  placeholderPixels,
  PLACEHOLDER_RGB,
  PLACEHOLDER_SIZE,
} from './textureFallback.js'

const PUBLIC_DIR = '/pv/public'

/** Distinguishable stand-ins so a test can tell which branch produced the texture. */
const REAL = { kind: 'real' }
const PLACEHOLDER = { kind: 'placeholder' }

function harness (overrides = {}) {
  const warn = vi.fn()
  // `in`, not `??` — one test deliberately passes loadImage: null.
  const loadImage = 'loadImage' in overrides ? overrides.loadImage : vi.fn(async () => ({ img: true }))
  const makeTexture = overrides.makeTexture ?? vi.fn(() => REAL)
  const makePlaceholder = overrides.makePlaceholder ?? vi.fn(() => PLACEHOLDER)
  const present = overrides.present ?? vi.fn(() => true)
  const load = createSafeLoadTexture({
    publicDir: PUBLIC_DIR,
    loadImage,
    makeTexture,
    makePlaceholder,
    present,
    warn,
  })
  return { load, warn, loadImage, makeTexture, makePlaceholder, present }
}

/** loadTexture is callback-style; give the promise chain a turn to settle. */
const call = (load, texture) =>
  new Promise((resolve) => {
    load(texture, resolve)
  })

describe('createSafeLoadTexture', () => {
  it('loads a texture that is on disk', async () => {
    const h = harness()
    await expect(call(h.load, 'textures/1.16.4/entity/creeper/creeper.png')).resolves.toBe(REAL)
    expect(h.loadImage).toHaveBeenCalledWith(
      path.resolve(PUBLIC_DIR, 'textures/1.16.4/entity/creeper/creeper.png'),
    )
    expect(h.warn).not.toHaveBeenCalled()
  })

  // THE regression. `textures/entity/steve` is the player texture — the one that
  // is missing from every texture tree a packaged build ships, and therefore the
  // one that actually fired. Before the fix this call never invoked its callback
  // at all; it left a rejected promise that killed the process.
  it('falls back to the placeholder when the file is missing, and still calls back', async () => {
    const h = harness({ present: vi.fn(() => false) })
    await expect(call(h.load, 'textures/1.16.4/entity/steve.png')).resolves.toBe(PLACEHOLDER)
    expect(h.loadImage).not.toHaveBeenCalled()
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(h.warn.mock.calls[0][0]).toContain('steve')
  })

  it('never creates a promise for a missing texture', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const h = harness({ present: vi.fn(() => false) })
      await call(h.load, 'textures/1.16.4/entity/arrow.png')
      // Two macrotask turns is well past where an unhandled rejection is reported.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  // A file that opens but does not decode (truncated / half-copied install) takes
  // the same route. This is the case the on-disk check alone cannot cover, and the
  // reason the .catch exists as well as the statSync.
  it('falls back when a present file fails to decode', async () => {
    const h = harness({
      loadImage: vi.fn(async () => {
        throw new Error('Invalid PNG')
      }),
    })
    await expect(call(h.load, 'textures/1.16.4/entity/squid.png')).resolves.toBe(PLACEHOLDER)
    expect(h.warn.mock.calls[0][0]).toContain('Invalid PNG')
  })

  it('caches misses so a missing texture costs one probe, not one per spawn', async () => {
    const h = harness({ present: vi.fn(() => false) })
    for (let i = 0; i < 5; i++) await call(h.load, 'textures/1.16.4/entity/steve.png')
    expect(h.present).toHaveBeenCalledTimes(1)
    expect(h.makePlaceholder).toHaveBeenCalledTimes(1)
    expect(h.warn).toHaveBeenCalledTimes(1) // one line per texture, not per entity
  })

  it('caches hits so a present texture decodes once', async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) await call(h.load, 'textures/1.16.4/entity/pig/pig.png')
    expect(h.loadImage).toHaveBeenCalledTimes(1)
  })

  it('keeps separate entries per texture key', async () => {
    const present = vi.fn((f) => !f.includes('steve'))
    const h = harness({ present })
    await expect(call(h.load, 'textures/1.16.4/entity/steve.png')).resolves.toBe(PLACEHOLDER)
    await expect(call(h.load, 'textures/1.16.4/entity/pig/pig.png')).resolves.toBe(REAL)
  })

  // Degraded natives: node-canvas-webgl dlopens `gl`, built for the Electron ABI.
  // viewer/lib/utils.js tolerates that require failing, so this must too — every
  // texture becomes a placeholder rather than the render stack failing to import.
  it('serves placeholders for everything when there is no image decoder', async () => {
    const h = harness({ loadImage: null, present: vi.fn(() => true) })
    await expect(call(h.load, 'textures/1.16.4/entity/pig/pig.png')).resolves.toBe(PLACEHOLDER)
    expect(h.makeTexture).not.toHaveBeenCalled()
  })

  // The viewer's own debug fallback is magenta, and povRenderer documents that
  // magenta debug boxes pollute the LLM's view with "strange pink blocks". The
  // placeholder must not reintroduce that.
  it('uses a neutral grey placeholder, not magenta', () => {
    expect(PLACEHOLDER_RGB.toLowerCase()).not.toMatch(/^#ff00ff$/)
    const [, r, g, b] = /^#(..)(..)(..)$/.exec(PLACEHOLDER_RGB)
    expect(parseInt(r, 16)).toBe(parseInt(g, 16))
    expect(parseInt(g, 16)).toBe(parseInt(b, 16))
    expect(PLACEHOLDER_SIZE).toBe(64)
  })
})

describe('placeholderPixels', () => {
  it('fills opaque neutral grey at the declared size', () => {
    const px = placeholderPixels()
    expect(px).toBeInstanceOf(Uint8Array)
    expect(px.length).toBe(PLACEHOLDER_SIZE * PLACEHOLDER_SIZE * 4)
    const grey = parseInt(PLACEHOLDER_RGB.slice(1, 3), 16)
    for (let i = 0; i < px.length; i += 4) {
      expect([px[i], px[i + 1], px[i + 2], px[i + 3]]).toEqual([grey, grey, grey, 255])
    }
  })
})

describe('texturePresent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sei-texfallback-'))

  it('accepts a real non-empty file', () => {
    const f = path.join(dir, 'ok.png')
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(texturePresent(f)).toBe(true)
  })

  it('rejects a missing file', () => {
    expect(texturePresent(path.join(dir, 'nope.png'))).toBe(false)
  })

  // A truncated or half-copied install leaves zero-byte entries, and node-canvas
  // rejects on those in exactly the same unhandled way as an absent file.
  it('rejects a zero-byte file', () => {
    const f = path.join(dir, 'empty.png')
    writeFileSync(f, '')
    expect(texturePresent(f)).toBe(false)
  })

  it('rejects a directory', () => {
    const d = path.join(dir, 'adir.png')
    mkdirSync(d)
    expect(texturePresent(d)).toBe(false)
  })
})
