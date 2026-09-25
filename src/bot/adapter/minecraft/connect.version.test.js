// 260926: the UNSUPPORTED_MC_VERSION text names the real supported range.
// 19 people in 30 days hit this class on Minecraft 26.2 / 26.3, and the copy
// they saw named no version at all.
import { describe, it, expect } from 'vitest'
import minecraftProtocol from 'minecraft-protocol'
import { supportedRangeText } from './connect.js'

describe('supportedRangeText', () => {
  it('uses release versions from the bot floor to the newest table entry', () => {
    expect(supportedRangeText(['1.7', '1.8.8', '1.21.4', '26.1', '1.12.2'])).toBe('1.8.8 to 26.1')
  })

  it('tracks the shipped protocol table, never a hardcode', () => {
    const table = minecraftProtocol.supportedVersions
    const text = supportedRangeText()
    expect(text.endsWith(` to ${table[table.length - 1]}`)).toBe(true)
    expect(text).not.toMatch(/—/)
  })
})
