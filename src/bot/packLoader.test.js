// Game pack loader (260908). The pure plan + specifier helpers run in-process;
// the resolution itself is exercised in a REAL `node` child, because vitest
// runs test-file imports through its own module runner (vite-node), which
// never consults Node's `module.register()` hooks or NODE_PATH. Invariants:
//   1. packLoaderPlan is a no-op for null / the bot's own root, active
//      otherwise, with a directory-shaped parentURL.
//   2. isBareSpecifier tells packages from paths and URLs.
//   3. In a real node process: an ESM `import x from 'fake-esm-dep'` in APP
//      code resolves from the pack after preparePackLoader; without it the
//      same import fails with ERR_MODULE_NOT_FOUND.
//   4. A CJS `require('fake-cjs-dep')` from an ESM importer's createRequire
//      resolves from the pack too (the NODE_PATH half).
//   5. A package the app tree already has wins over the pack's copy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { packLoaderPlan, OWN_APP_ROOT } from './packLoader.js'
import { isBareSpecifier } from './packLoaderHooks.js'

const execFileP = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOADER = path.join(HERE, 'packLoader.js')

describe('packLoaderPlan', () => {
  it('Test 1: no-op for null and for the own root; active elsewhere', () => {
    expect(packLoaderPlan(null).active).toBe(false)
    expect(packLoaderPlan('').active).toBe(false)
    expect(packLoaderPlan(OWN_APP_ROOT).active).toBe(false)
    expect(packLoaderPlan('/tmp/x/..' + '/' + path.basename(OWN_APP_ROOT), '/tmp/' + path.basename(OWN_APP_ROOT)).active).toBe(false)
    const plan = packLoaderPlan('/some/pack/root', '/other/app')
    expect(plan.active).toBe(true)
    expect(plan.nodeModulesDir).toBe(path.join(path.resolve('/some/pack/root'), 'node_modules'))
    expect(plan.parentURL.endsWith('/')).toBe(true)
    expect(plan.parentURL.startsWith('file:')).toBe(true)
  })
})

describe('isBareSpecifier', () => {
  it('Test 2: packages yes, paths and URLs no', () => {
    expect(isBareSpecifier('mineflayer')).toBe(true)
    expect(isBareSpecifier('@scope/pkg/sub')).toBe(true)
    expect(isBareSpecifier('prismarine-viewer/viewer')).toBe(true)
    expect(isBareSpecifier('./x.js')).toBe(false)
    expect(isBareSpecifier('../x.js')).toBe(false)
    expect(isBareSpecifier('/abs/x.js')).toBe(false)
    expect(isBareSpecifier('node:fs')).toBe(false)
    expect(isBareSpecifier('file:///x')).toBe(false)
    expect(isBareSpecifier('C:\\x')).toBe(false)
    expect(isBareSpecifier('')).toBe(false)
  })
})

describe('preparePackLoader in a real node process', () => {
  let work
  let pack
  let appDir

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'sei-pack-loader-'))
    pack = path.join(work, 'pack')
    appDir = path.join(work, 'app')
    // The pack: one ESM package, one CJS package, and a copy of a package the
    // app tree ALSO has (to prove the app copy wins).
    await mkdir(path.join(pack, 'node_modules', 'fake-esm-dep'), { recursive: true })
    await writeFile(
      path.join(pack, 'node_modules', 'fake-esm-dep', 'package.json'),
      JSON.stringify({ name: 'fake-esm-dep', type: 'module', exports: './index.js' }),
    )
    await writeFile(path.join(pack, 'node_modules', 'fake-esm-dep', 'index.js'), 'export default "esm-from-pack"\n')
    await mkdir(path.join(pack, 'node_modules', 'fake-cjs-dep'), { recursive: true })
    await writeFile(
      path.join(pack, 'node_modules', 'fake-cjs-dep', 'package.json'),
      JSON.stringify({ name: 'fake-cjs-dep', main: 'index.js' }),
    )
    await writeFile(path.join(pack, 'node_modules', 'fake-cjs-dep', 'index.js'), 'module.exports = "cjs-from-pack"\n')
    await mkdir(path.join(pack, 'node_modules', 'shared-dep'), { recursive: true })
    await writeFile(path.join(pack, 'node_modules', 'shared-dep', 'package.json'), JSON.stringify({ name: 'shared-dep', main: 'index.js' }))
    await writeFile(path.join(pack, 'node_modules', 'shared-dep', 'index.js'), 'module.exports = "shared-from-pack"\n')
    // The "app": a consumer importing bare specifiers, plus its own shared-dep.
    await mkdir(path.join(appDir, 'node_modules', 'shared-dep'), { recursive: true })
    await writeFile(path.join(appDir, 'node_modules', 'shared-dep', 'package.json'), JSON.stringify({ name: 'shared-dep', main: 'index.js' }))
    await writeFile(path.join(appDir, 'node_modules', 'shared-dep', 'index.js'), 'module.exports = "shared-from-app"\n')
    await writeFile(
      path.join(appDir, 'consumer.mjs'),
      [
        "import esm from 'fake-esm-dep'",
        "import { createRequire } from 'node:module'",
        'const require = createRequire(import.meta.url)',
        "export const cjs = require('fake-cjs-dep')",
        "export const shared = require('shared-dep')",
        'export default esm',
        '',
      ].join('\n'),
    )
  })

  afterAll(async () => {
    await rm(work, { recursive: true, force: true })
  })

  async function runChild(withLoader) {
    const script = [
      `import { preparePackLoader } from ${JSON.stringify(pathToFileURL(LOADER).href)}`,
      withLoader
        ? `const active = await preparePackLoader(${JSON.stringify(pack)}, { ownRoot: ${JSON.stringify(appDir)} })`
        : 'const active = false',
      'try {',
      `  const m = await import(${JSON.stringify(pathToFileURL(path.join(appDir, 'consumer.mjs')).href)})`,
      '  console.log(JSON.stringify({ active, esm: m.default, cjs: m.cjs, shared: m.shared }))',
      '} catch (err) {',
      '  console.log(JSON.stringify({ active, error: err.code || String(err) }))',
      '}',
      '',
    ].join('\n')
    const entry = path.join(work, withLoader ? 'run-with.mjs' : 'run-without.mjs')
    await writeFile(entry, script)
    const { stdout } = await execFileP(process.execPath, [entry], { cwd: appDir, env: { ...process.env, NODE_PATH: '' } })
    return JSON.parse(stdout.trim().split('\n').pop())
  }

  it('Test 3: without the loader the pack-only ESM import is not found', async () => {
    const out = await runChild(false)
    expect(out.active).toBe(false)
    expect(out.error).toBe('ERR_MODULE_NOT_FOUND')
  })

  it('Test 4: with the loader, ESM and CJS bare imports resolve from the pack', async () => {
    const out = await runChild(true)
    expect(out.active).toBe(true)
    expect(out.error).toBeUndefined()
    expect(out.esm).toBe('esm-from-pack')
    expect(out.cjs).toBe('cjs-from-pack')
  })

  it('Test 5: a package the app tree already has beats the pack copy', async () => {
    const out = await runChild(true)
    expect(out.shared).toBe('shared-from-app')
  })
})
