/**
 * atomicWrite rename retry (261121): a Windows rename that fails with a
 * transient sharing error is retried; anything else, or any other platform,
 * fails straight through as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = { left: 0, code: 'EPERM' }
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig()
  return {
    ...real,
    rename: vi.fn(async (from, to) => {
      if (failures.left > 0) {
        failures.left--
        throw Object.assign(new Error(`${failures.code}: operation not permitted, rename`), { code: failures.code })
      }
      return real.rename(from, to)
    }),
  }
})

const { atomicWrite } = await import('./atomicWrite.js')
const fsp = await import('node:fs/promises')

const realPlatform = process.platform
function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('atomicWrite rename retry', () => {
  let dir
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomicwrite-'))
    failures.left = 0
    failures.code = 'EPERM'
    vi.mocked(fsp.rename).mockClear()
  })
  afterEach(async () => {
    setPlatform(realPlatform)
    await rm(dir, { recursive: true, force: true })
  })

  it('retries a transient EPERM on Windows and lands the write', async () => {
    setPlatform('win32')
    failures.left = 2
    const target = join(dir, 'sync-queue.json')
    await atomicWrite(target, '[]\n')
    expect(await readFile(target, 'utf8')).toBe('[]\n')
    expect(fsp.rename).toHaveBeenCalledTimes(3)
    expect((await readdir(dir)).filter((f) => f.includes('.tmp.'))).toEqual([])
  })

  it('gives up after the retry budget, rethrows, and removes the tmp file', async () => {
    setPlatform('win32')
    failures.left = 100
    failures.code = 'EBUSY'
    const target = join(dir, 'x.json')
    await expect(atomicWrite(target, 'a')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(fsp.rename).toHaveBeenCalledTimes(6)
    expect(await readdir(dir)).toEqual([])
  })

  it('does not retry off Windows', async () => {
    setPlatform('linux')
    failures.left = 1
    await expect(atomicWrite(join(dir, 'y.json'), 'a')).rejects.toMatchObject({ code: 'EPERM' })
    expect(fsp.rename).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-transient error on Windows', async () => {
    setPlatform('win32')
    failures.left = 1
    failures.code = 'ENOENT'
    await expect(atomicWrite(join(dir, 'z.json'), 'a')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fsp.rename).toHaveBeenCalledTimes(1)
  })
})




