// 260926: reproduces the game-pack layout behind `Cannot find module 'three'`
// (0.6.5-beta.1): three.meshline hoisted to the top node_modules, the only
// `three` nested under prismarine-viewer. Fake packages keep it fast and free
// of the real three / native deps.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { loadMeshlineWithViewerThree } from './meshlineThree.js'

let root

function pkg(dir, name, main, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main }))
  mkdirSync(dirname(join(dir, main)), { recursive: true })
  writeFileSync(join(dir, main), body)
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sei-meshline-')))
  const nm = join(root, 'node_modules')
  // three.meshline's real THREE lookup (src/THREE.MeshLine.js).
  pkg(join(nm, 'three.meshline'), 'three.meshline', 'src/THREE.MeshLine.js', `
    ;(function () {
      var root = this
      var THREE = root.THREE || require('three')
      module.exports = { boundTo: THREE.copy }
    }.call(this))
  `)
  pkg(join(nm, 'prismarine-viewer'), 'prismarine-viewer', 'index.js', 'module.exports = {}')
  pkg(join(nm, 'prismarine-viewer', 'node_modules', 'three'), 'three', 'index.js', "module.exports = { copy: 'viewer-0.128' }")
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('loadMeshlineWithViewerThree', () => {
  it('the pack layout alone reproduces the field error', () => {
    const pvRequire = createRequire(join(root, 'node_modules', 'prismarine-viewer', 'package.json'))
    expect(() => pvRequire('three.meshline')).toThrow(/Cannot find module 'three'/)
    // Node drops a module that threw during load from the cache; be explicit.
    delete Module._cache?.[pvRequire.resolve('three.meshline')]
  })

  it("binds three.meshline to prismarine-viewer's three and caches it for the viewer", () => {
    const pvRequire = createRequire(join(root, 'node_modules', 'prismarine-viewer', 'package.json'))
    const origResolve = Module._resolveFilename
    const m = loadMeshlineWithViewerThree(pvRequire)
    expect(m.boundTo).toBe('viewer-0.128')
    // The resolver hook is gone again.
    expect(Module._resolveFilename).toBe(origResolve)
    // primitives.js (inside prismarine-viewer) now gets the cached module.
    const fromViewerLib = createRequire(join(root, 'node_modules', 'prismarine-viewer', 'viewer', 'lib', 'primitives.js'))
    expect(fromViewerLib('three.meshline')).toBe(m)
  })

  it('leaves every other resolution alone while the hook is in place', () => {
    const pvRequire = createRequire(join(root, 'node_modules', 'prismarine-viewer', 'package.json'))
    const other = createRequire(join(root, 'other.js'))
    expect(() => other.resolve('three')).toThrow(/Cannot find module 'three'/)
    expect(() => loadMeshlineWithViewerThree(pvRequire)).not.toThrow()
  })

  it('restores the resolver when three.meshline is missing', () => {
    const lonely = realpathSync(mkdtempSync(join(tmpdir(), 'sei-meshline-none-')))
    try {
      pkg(join(lonely, 'node_modules', 'prismarine-viewer'), 'prismarine-viewer', 'index.js', '')
      pkg(join(lonely, 'node_modules', 'prismarine-viewer', 'node_modules', 'three'), 'three', 'index.js', '')
      const origResolve = Module._resolveFilename
      const pvRequire = createRequire(join(lonely, 'node_modules', 'prismarine-viewer', 'package.json'))
      expect(() => loadMeshlineWithViewerThree(pvRequire)).toThrow(/three\.meshline/)
      expect(Module._resolveFilename).toBe(origResolve)
    } finally {
      rmSync(lonely, { recursive: true, force: true })
    }
  })
})
