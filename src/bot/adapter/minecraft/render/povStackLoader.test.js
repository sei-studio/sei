// 260926: the render-stack loader must keep the bot's event loop free. The
// natives are prefetched asynchronously BEFORE any synchronous require, the
// heavy requires run one per event-loop turn, and a failed load is final for
// the session (and says so in the log with its timings).
import { describe, it, expect, vi } from 'vitest'
import { createPovStackLoader } from './povStackLoader.js'

function dirent(name, parentPath) {
  return { name, parentPath, isFile: () => true }
}

function harness({ requireFails = null, importFails = false } = {}) {
  const events = []
  const pvRequire = (id) => {
    events.push(`require:${id}`)
    if (id === requireFails) throw new Error(`Cannot find module '${id}'`)
    return {}
  }
  pvRequire.resolve = (id) => {
    if (id === 'three') return '/pv/node_modules/three/build/three.js'
    if (id === 'node-canvas-webgl/package.json') throw new Error('not here') // falls back to pvRequire
    const name = id.replace('/package.json', '')
    return `/nm/${name}/package.json`
  }
  const readdirFn = vi.fn(async (dir) => {
    if (dir === '/nm/canvas/build/Release') {
      return [dirent('canvas.node', dir), dirent('libcairo-2.dll', dir), dirent('libpango.so.1.0', dir), dirent('notes.txt', dir)]
    }
    if (dir === '/nm/gl/build/Release') return [dirent('webgl.node', dir), dirent('ANGLE.a', dir)]
    if (dir === '/nm/prismarine-viewer/viewer') return [dirent('index.js', dir), dirent('entities.json', `${dir}/lib`)]
    throw new Error('ENOENT')
  })
  const readFileFn = vi.fn(async (f) => {
    events.push(`read:${f}`)
    return Buffer.alloc(10)
  })
  const yieldFn = vi.fn(async () => { events.push('yield') })
  const importRenderer = vi.fn(async () => {
    events.push('import')
    if (importFails) throw new Error('boom in povRenderer')
    return { renderPov: () => {} }
  })
  const logs = []
  const onLoaded = vi.fn()
  const loader = createPovStackLoader({
    pvRequire, readdirFn, readFileFn, yieldFn, importRenderer, onLoaded, log: (m) => logs.push(m),
  })
  return { loader, events, readFileFn, importRenderer, logs, onLoaded }
}

describe('createPovStackLoader', () => {
  it('prefetches every native library and the JS asynchronously before any require', async () => {
    const h = harness()
    await h.loader.load()
    const firstRequire = h.events.findIndex((e) => e.startsWith('require:'))
    const reads = h.events.filter((e) => e.startsWith('read:'))
    expect(reads).toEqual([
      'read:/nm/canvas/build/Release/canvas.node',
      'read:/nm/canvas/build/Release/libcairo-2.dll',
      'read:/nm/canvas/build/Release/libpango.so.1.0',
      'read:/nm/gl/build/Release/webgl.node',
      'read:/pv/node_modules/three/build/three.js',
      'read:/nm/prismarine-viewer/viewer/index.js',
      'read:/nm/prismarine-viewer/viewer/lib/entities.json',
    ])
    expect(h.events.lastIndexOf(reads[reads.length - 1])).toBeLessThan(firstRequire)
  })

  it('runs the heavy requires one per event-loop turn, in povRenderer order, then imports it', async () => {
    const h = harness()
    await h.loader.load()
    const tail = h.events.filter((e) => !e.startsWith('read:'))
    expect(tail).toEqual(['yield', 'require:three', 'yield', 'require:canvas', 'yield', 'require:gl', 'yield', 'import'])
    expect(h.loader.ready()).toBe(true)
  })

  it('loads once and reports its timings', async () => {
    const h = harness()
    const a = await h.loader.load()
    const b = await h.loader.load()
    expect(b).toBe(a)
    expect(h.importRenderer).toHaveBeenCalledTimes(1)
    expect(h.onLoaded).toHaveBeenCalledTimes(1)
    const t = h.onLoaded.mock.calls[0][0]
    expect(t).toMatchObject({ ok: true, files: 7, bytes: 70 })
    expect(Object.keys(t.require_ms)).toEqual(['three', 'canvas', 'gl'])
    expect(typeof t.longest_block_ms).toBe('number')
    expect(h.logs[0]).toMatch(/render stack loaded in \d+ms \(prefetch \d+ms, 7 files/)
  })

  it('a failed require is final for the session: no retry, unavailable, logged', async () => {
    const h = harness({ requireFails: 'canvas' })
    await expect(h.loader.load()).rejects.toThrow(/canvas/)
    await expect(h.loader.load()).rejects.toThrow(/canvas/)
    expect(h.events.filter((e) => e === 'require:canvas')).toHaveLength(1)
    expect(h.importRenderer).not.toHaveBeenCalled()
    expect(h.loader.unavailable()).toBe(true)
    expect(h.loader.ready()).toBe(false)
    expect(h.logs[0]).toMatch(/FAILED to load .*Cannot find module 'canvas'.*Vision is off for this session/)
    expect(h.onLoaded.mock.calls[0][0]).toMatchObject({ ok: false })
  })

  it('a failed renderer import is final too', async () => {
    const h = harness({ importFails: true })
    await expect(h.loader.load()).rejects.toThrow('boom in povRenderer')
    await expect(h.loader.load()).rejects.toThrow('boom in povRenderer')
    expect(h.importRenderer).toHaveBeenCalledTimes(1)
    expect(h.loader.unavailable()).toBe(true)
  })

  it('a prefetch read error does not stop the load (the require reports real problems)', async () => {
    const h = harness()
    h.readFileFn.mockRejectedValueOnce(new Error('EACCES'))
    await expect(h.loader.load()).resolves.toBeTruthy()
    expect(h.onLoaded.mock.calls[0][0]).toMatchObject({ ok: true, files: 6 })
  })
})
