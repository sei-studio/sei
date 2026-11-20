// The undici package and the fetch built into Electron's Node share one
// global dispatcher slot, so they must stay on the same major (261103, T303).
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { installSystemProxy, resetInstallForTest } from './systemProxy.js'

const require = createRequire(import.meta.url)
const root = new URL('../../../', import.meta.url)
const major = (v) => Number(String(v).split('.')[0])

/** process.versions.undici inside Electron's own Node, or null when Electron cannot run here. */
function electronUndici() {
  try {
    const bin = require('electron')
    return execFileSync(bin, ['-p', 'process.versions.undici'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30_000,
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

describe('undici dependency', () => {
  it('is pinned to an exact version', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    expect(pkg.dependencies.undici).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("has the same major as the undici inside Electron's Node", () => {
    const installed = require('undici/package.json').version
    const builtIn = electronUndici()
    if (builtIn === null) {
      console.warn('electron could not run here; skipping the undici major check')
      return
    }
    // Plain `process.versions.undici` here is the test runner's Node (22 on
    // the dev server, undici 6), not what the app runs.
    expect(major(installed)).toBe(major(builtIn))
  })

  it('is never imported statically by the bot entry (no proxy = no undici)', () => {
    const src = readFileSync(new URL('src/bot/index.js', root), 'utf8')
    expect(src).not.toMatch(/^import[^\n]*['"]\.\/net\/systemProxy\.js['"]/m)
    expect(src).toMatch(/import\(['"]\.\/net\/systemProxy\.js['"]\)/)
  })
})

describe('installSystemProxy', () => {
  const SLOT = Symbol.for('undici.globalDispatcher.1')
  const before = globalThis[SLOT]
  afterEach(() => {
    // Node defines the slot non-configurable, so put the old value back
    // rather than deleting it.
    if (before !== undefined) globalThis[SLOT] = before
    resetInstallForTest()
  })

  it('loads undici only at install time', () => {
    // Importing systemProxy.js (top of this file) left the shared slot empty;
    // the undici package would have filled it on load.
    expect(before).toBeUndefined()
    const src = readFileSync(new URL('src/bot/net/systemProxy.js', root), 'utf8')
    expect(src).not.toMatch(/^import[^\n]*from ['"]undici['"]/m)
  })

  it("keeps Node's built-in Agent for DIRECT and is idempotent", async () => {
    const d = await installSystemProxy({ resolve: () => 'DIRECT' })
    const { SystemProxyDispatcher } = await import('./proxyDispatcher.js')
    const { Agent } = await import('undici')
    expect(d).toBeInstanceOf(SystemProxyDispatcher)
    expect(globalThis[SLOT]).toBe(d)
    // The built-in fetch made its own Agent on the data: request; that is the
    // one DIRECT uses, not a fresh Agent from the undici package.
    expect(d.direct).toBeDefined()
    expect(d.direct).not.toBeInstanceOf(Agent)
    if (before !== undefined) expect(d.direct).toBe(before)
    expect(await installSystemProxy({ resolve: () => 'DIRECT' })).toBe(d)
  })
})
