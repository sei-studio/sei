import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { modVersionAtLeast, modHasCaps, CAPS_MIN_MOD } from './modVersion.js'

const modFile = (rel) => readFileSync(fileURLToPath(new URL(`../../../../native/dst-mod/sei/${rel}`, import.meta.url)), 'utf8')

describe('DST helper mod version gate', () => {
  it('compares major.minor.patch numerically and treats unknown as old', () => {
    expect(modVersionAtLeast('0.3.0', '0.3.0')).toBe(true)
    expect(modVersionAtLeast('0.10.0', '0.3.0')).toBe(true)
    expect(modVersionAtLeast('v1.0', '0.3.0')).toBe(true)
    expect(modVersionAtLeast('0.2.9', '0.3.0')).toBe(false)
    expect(modHasCaps(null)).toBe(false)
    expect(modHasCaps('')).toBe(false)
    expect(modHasCaps('garbage')).toBe(false)
  })

  it('the mod reports the version its modinfo declares, and it carries the caps', () => {
    const reported = /return\s+"([^"]+)"/.exec(modFile('scripts/sei/version.lua'))?.[1]
    const declared = /^version\s*=\s*"([^"]+)"/m.exec(modFile('modinfo.lua'))?.[1]
    expect(reported).toBeTruthy()
    expect(reported).toBe(declared)
    expect(modVersionAtLeast(reported, CAPS_MIN_MOD)).toBe(true)
  })
})
