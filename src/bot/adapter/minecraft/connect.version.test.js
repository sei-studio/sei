// 260926: the UNSUPPORTED_MC_VERSION text names the versions Sei can join.
// 19 people in 30 days hit this class on Minecraft 26.2 / 26.3, and the copy
// they saw named no version at all. A plain "oldest to newest" range hid the
// gaps (1.9 to 1.9.2, 1.11, 1.12.1, ... are not joinable), so the text lists
// the real set, derived from the protocol table.
import { describe, it, expect } from 'vitest'
import minecraftProtocol from 'minecraft-protocol'
import minecraftData from 'minecraft-data'
import { supportedRangeText } from './connect.js'
import {
  formatMcVersionList,
  joinableMcVersions,
  mcReleases,
} from '../../../shared/mcSetup.ts'

const rows = Object.values(minecraftData.postNettyVersionsByProtocolVersion.pc).flat()

describe('supportedRangeText', () => {
  it('collapses consecutive releases and keeps every gap visible', () => {
    const table = [
      { minecraftVersion: '1.7.10', version: 5 },
      { minecraftVersion: '1.8', version: 47 },
      { minecraftVersion: '1.8.8', version: 47 },
      { minecraftVersion: '1.8.9', version: 47 },
      { minecraftVersion: '1.9', version: 107 },
      { minecraftVersion: '1.9.4', version: 110 },
      { minecraftVersion: '1.12', version: 335 },
      { minecraftVersion: '1.20.3', version: 765 },
      { minecraftVersion: '1.20.4', version: 765 },
      { minecraftVersion: '26.1-snapshot-2', version: 1 },
    ]
    expect(supportedRangeText(['1.7', '1.8.8', '1.9.4', '1.20.4'], table)).toBe('1.8 to 1.8.9, 1.9.4, 1.20.3, 1.20.4')
  })

  it('on the shipped tables: lists the gaps and ends at the newest joinable release', () => {
    const text = supportedRangeText()
    expect(text.startsWith('1.8 to 1.8.9, ')).toBe(true)
    expect(text).not.toMatch(/\b1\.9(,| to)/) // 1.9 itself is not joinable
    const newest = minecraftProtocol.supportedVersions.at(-1)
    expect(text).toContain(newest)
    expect(text).not.toMatch(/—/)
  })

  it('matches the renderer copy (src/shared/mcSetup.ts) exactly', () => {
    const shared = formatMcVersionList(
      joinableMcVersions(minecraftProtocol.supportedVersions, rows),
      mcReleases(rows),
    )
    expect(supportedRangeText()).toBe(shared)
  })
})
