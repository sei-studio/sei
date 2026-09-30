// Minecraft system-prompt byte pin (game-adapters M0, 260908).
//
// The adapter-contract-v2 refactor moves every Minecraft-specific string the
// brain used to own (surface baseline, chat cap, background/progress/vision
// action sets, quit_game wording, paused notice, stuck nudges, session-end
// clause) behind adapter-declared members with Minecraft defaults. The promise
// is NO behavior change for Minecraft: the cached system prefix and the tool
// list the model sees must be byte-identical before and after.
//
// __fixtures__/minecraftSystemBlocks.json was generated on the PRE-refactor
// tree by running this file with SEI_WRITE_SYSBLOCKS_FIXTURE=1. It covers the
// three configurations that exercise every optional block the prefix carries
// (base; zh + deliberate punctuation + knowledge; vision off, which also drops
// the look tool). Regenerate ONLY for a deliberate prompt change:
//   SEI_WRITE_SYSBLOCKS_FIXTURE=1 npx vitest run src/bot/brain/systemBlocks.minecraft.test.js
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The Minecraft registry statically imports behaviors/visualize.js, which
// pulls the native gl/canvas render path (built for the Electron ABI, not
// loadable under system-Node vitest). Same mock adapter/minecraft/index.test.js
// uses; the tool DESCRIPTIONS the fixture pins come from promptLibrary, not
// from this module, so mocking it changes nothing the test measures.
vi.mock('../adapter/minecraft/behaviors/visualize.js', () => ({
  visualizeAction: vi.fn(async () => ({ text: 'x', image: { mediaType: 'image/jpeg', dataBase64: 'AAAA' } })),
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
  orientationToYawOffset: vi.fn(() => null),
  yawToUnit: vi.fn(() => [0, -1]),
  faceYaw: vi.fn(async () => {}),
  captureFrame: vi.fn(async () => ({ ok: true, mediaType: 'image/jpeg', dataBase64: 'AAAA' })),
}))

import { buildMinecraftSystemFixture } from './systemBlocks.minecraft.build.js'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'minecraftSystemBlocks.json')

describe('Minecraft cached system prefix + tool list are byte-identical to the pinned fixture', () => {
  it('matches __fixtures__/minecraftSystemBlocks.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sei-sysblocks-'))
    const actual = await buildMinecraftSystemFixture(dir)
    if (process.env.SEI_WRITE_SYSBLOCKS_FIXTURE === '1') {
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n')
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    for (const variant of Object.keys(expected)) {
      // Block-by-block first so a diff names the block that moved.
      expect(actual[variant].blocks.length, `${variant}: block count`).toBe(expected[variant].blocks.length)
      expected[variant].blocks.forEach((b, i) => {
        expect(actual[variant].blocks[i], `${variant}: block [${i}]`).toBe(b)
      })
      expect(actual[variant].tools.map((t) => t.name), `${variant}: tool order`).toEqual(
        expected[variant].tools.map((t) => t.name),
      )
      expect(actual[variant].tools, `${variant}: tools`).toEqual(expected[variant].tools)
    }
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  })
})
