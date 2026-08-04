// src/bot/adapter/minecraft/render/povRenderer.atlas.test.js
//
// 260803 (pruned-texture crash). The packaged builds ship only a subset of
// prismarine-viewer's block-texture atlases (electron-builder.yml `files:`),
// but viewer/lib/version.js hardcodes its supported-version list instead of
// reading the textures directory. A bot on 1.16.5 therefore resolved to the
// supported '1.16.4', setVersion returned true, and worldrenderer's
// updateTexturesData called loadTexture('textures/1.16.4.png') on a file that
// was not in the build. viewer/lib/utils.js has no .catch on that loadImage
// promise, so the ENOENT rejection escaped renderPov's try/catch, reached the
// process-level unhandledRejection handler in src/bot/index.js, and killed the
// bot with BOT_CRASH on the FIRST POV render.
//
// These tests lock the precondition check that replaces the crash with the
// existing CANT_SEE degrade.
//
// Test-harness notes:
//   - povRenderer resolves node-canvas-webgl (native gl/canvas, built for the
//     Electron ABI) and prismarine-viewer through createRequire, which vi.mock
//     cannot intercept. We patch Module._load for exactly those two specifiers
//     before importing the module under test, and restore it afterwards.
//   - povRenderer only builds `global.THREE` from prismarine-viewer's tree when
//     it is unset, so seeding a stub first keeps the real three (and its real
//     WebGLRenderer, which needs a real GL context) out of the test.
//   - The real texture tree IS complete in a dev checkout; the pruned state only
//     exists in a packaged build, so the on-disk check is mocked via node:fs.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Module from 'node:module'

// ── node:fs, the atlas presence check under test ───────────────────────────
const statSync = vi.fn()
vi.mock('node:fs', () => ({ statSync: (...a) => statSync(...a) }))

// ── prismarine-viewer / node-canvas-webgl stubs ─────────────────────────────
const atlasFile = (size = 1234) => ({ isFile: () => true, size })
const ENOENT = (p) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' })

let canvas
let viewerInstances

function makeCanvas () {
  return {
    width: 8,
    height: 8,
    // Non-background pixels so isBlankFrame does not veto the frame.
    __gl__: { RGBA: 1, UNSIGNED_BYTE: 2, readPixels: (x, y, w, h, f, t, out) => out.fill(255) },
    toBuffer: () => Buffer.from('jpeg-bytes'),
  }
}

class FakeViewer {
  constructor () {
    this.playerHeight = 1.6
    this.camera = { position: { set: vi.fn() }, rotation: { set: vi.fn() } }
    this.scene = {}
    this.world = { material: { map: {} }, workers: [] }
    this.setVersion = vi.fn(() => true)
    this.listen = vi.fn()
    this.update = vi.fn()
    this.waitForChunksToRender = vi.fn(async () => {})
    viewerInstances.push(this)
  }
}

class FakeWorldView {
  constructor () {
    this.loadedChunks = { '0,0': true }
    this.init = vi.fn(async () => {})
    this.listenToBot = vi.fn()
    this.removeListenersFromBot = vi.fn()
  }
}

const stubs = {
  'node-canvas-webgl/lib': { createCanvas: () => (canvas = makeCanvas()), loadImage: async () => ({}) },
  'prismarine-viewer/viewer': { Viewer: FakeViewer, WorldView: FakeWorldView },
}

let realLoad
let renderPov
let CANT_SEE

beforeAll(async () => {
  globalThis.THREE = {
    WebGLRenderer: class { constructor () { this.render = vi.fn() } dispose () {} },
    Color: class { constructor (r, g, b) { Object.assign(this, { r, g, b }) } },
  }
  realLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request]
    return realLoad.call(this, request, parent, isMain)
  }
  const mod = await import('./povRenderer.js')
  renderPov = mod.renderPov
  CANT_SEE = mod.CANT_SEE
})

afterAll(() => {
  Module._load = realLoad
  delete globalThis.THREE
})

function makeBot (version) {
  return {
    version,
    entity: { position: { x: 1, y: 64, z: 2 }, yaw: 0, pitch: 0 },
    world: {},
    time: { timeOfDay: 1000 },
    waitForChunksToLoad: async () => {},
  }
}

beforeEach(() => {
  viewerInstances = []
  statSync.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('povRenderer texture-atlas guard (260803 pruned-build crash)', () => {
  it('renders normally when the resolved atlas IS present (no CANT_SEE)', async () => {
    statSync.mockReturnValue(atlasFile())
    const res = await renderPov(makeBot('1.21.4'), { timeoutMs: 500 })
    expect(res.ok).toBe(true)
    expect(res.mediaType).toBe('image/jpeg')
    expect(viewerInstances).toHaveLength(1) // the guard let the Viewer be built
    // Anchored off prismarine-viewer's own package root, matching loadTexture's
    // `<pkgRoot>/public/textures/<version>.png` convention.
    expect(statSync).toHaveBeenCalledWith(
      expect.stringMatching(/prismarine-viewer[/\\]public[/\\]textures[/\\]1\.21\.4\.png$/)
    )
  })

  it('THE BUG: a pruned-away atlas degrades to CANT_SEE instead of crashing', async () => {
    // 1.16.5 is not in supportedVersions; version.js maps it to 1.16.4, whose
    // atlas the mac/windows prune removes. Pre-fix this reached loadTexture.
    statSync.mockImplementation((p) => { throw ENOENT(p) })
    const res = await renderPov(makeBot('1.16.5'), { timeoutMs: 500 })
    expect(res).toEqual(CANT_SEE)
    expect(statSync).toHaveBeenCalledWith(
      expect.stringMatching(/textures[/\\]1\.16\.4\.png$/) // resolved, not the raw bot version
    )
  })

  it('the missing-atlas path never constructs a Viewer, so no texture load is started', async () => {
    statSync.mockImplementation((p) => { throw ENOENT(p) })
    await renderPov(makeBot('1.12.1'), { timeoutMs: 500 })
    expect(viewerInstances).toHaveLength(0)
  })

  it('the missing-atlas path neither throws nor leaves an unhandled rejection', async () => {
    statSync.mockImplementation((p) => { throw ENOENT(p) })
    const unhandled = []
    const onUnhandled = (err) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(renderPov(makeBot('1.16.5'), { timeoutMs: 500 })).resolves.toEqual(CANT_SEE)
      // Give the microtask + macrotask queues a turn: an escaping rejection
      // would surface here, exactly as it did in the bot utilityProcess.
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('treats a zero-byte atlas (truncated/half-copied build) as missing', async () => {
    statSync.mockReturnValue({ isFile: () => true, size: 0 })
    const res = await renderPov(makeBot('1.20.1'), { timeoutMs: 500 })
    expect(res).toEqual(CANT_SEE)
  })

  it('degrades on a version prismarine-viewer does not support at all, without touching disk', async () => {
    // getVersion('1.7.10') returns null; setVersion would have called
    // window.alert (a ReferenceError in headless Node) before we got here.
    const res = await renderPov(makeBot('1.7.10'), { timeoutMs: 500 })
    expect(res).toEqual(CANT_SEE)
    expect(statSync).not.toHaveBeenCalled()
    expect(viewerInstances).toHaveLength(0)
  })

  it('caches the check per resolved version: one statSync no matter how many renders', async () => {
    statSync.mockReturnValue(atlasFile())
    await renderPov(makeBot('1.19'), { timeoutMs: 500 })
    await renderPov(makeBot('1.19'), { timeoutMs: 500 })
    await renderPov(makeBot('1.19'), { timeoutMs: 500 })
    expect(statSync).toHaveBeenCalledTimes(1) // never per-frame
  })

  it('caches the missing result too, and logs it once', async () => {
    statSync.mockImplementation((p) => { throw ENOENT(p) })
    await renderPov(makeBot('1.15.1'), { timeoutMs: 500 })
    await renderPov(makeBot('1.15.1'), { timeoutMs: 500 })
    expect(statSync).toHaveBeenCalledTimes(1)
    const lines = console.log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('no block-texture atlas'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1.15.2') // the resolved version, not 1.15.1
  })
})
