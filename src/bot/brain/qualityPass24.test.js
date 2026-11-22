// 261022: MC quality pass 24.
//  - her own goals are written as hers: the setGoal description and the
//    agentic frontier block say a goal of her own leaves the player's name,
//    "we" and "together" out until the player agreed to join (first-spawn
//    goals named the player in 62 of 64 eval sessions, and the goodbye then
//    saved that goal as a shared plan)
//  - a finished mob fight says what it cost her (attack.test.js)

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
import { renderHeartbeat } from './prompts.js'

const OWN_RULE = 'Write a goal of your own as yours: leave the player\'s name, "we" and "together" out of it unless they agreed in the conversation to do it with you.'

describe('her own goal is written as hers', () => {
  it('the setGoal tool says so, and keeps shared plans and tasks open', async () => {
    const built = await buildMinecraftSystemFixture(mkdtempSync(path.join(tmpdir(), 'sei-p24-')))
    const tool = built.base.tools.find((t) => t.name === 'setGoal')
    expect(tool.description).toContain(OWN_RULE)
    expect(tool.description).toContain('Asking them to join is something you say to them, and it does not make the goal theirs.')
    expect(tool.description).toContain('A plan the two of you agreed on, or a task they gave you, can say who does which part.')
  })

  it('the agentic frontier block offers the part out loud and keeps the goal text hers', () => {
    const hb = renderHeartbeat(2, '', 'stone tools')
    expect(hb).toContain('Reachable next: stone tools')
    expect(hb).toContain('Offer them that part with say().')
    expect(hb).toContain('The setGoal text stays your own plan until they agree to join, so write it without their name or "we".')
    // Still the "plays WITH you" companion.
    expect(hb).toContain('pick something with a part for them')
  })

  it('the frontier block is not added once she has a goal', () => {
    expect(renderHeartbeat(2, 'Get stone tools: done when I have a stone pickaxe', 'stone tools')).not.toContain('Offer them that part')
  })

  it('has no em dashes in the new text', async () => {
    const built = await buildMinecraftSystemFixture(mkdtempSync(path.join(tmpdir(), 'sei-p24-')))
    const tool = built.base.tools.find((t) => t.name === 'setGoal')
    const added = tool.description.slice(tool.description.indexOf('Write a goal of your own'))
    expect(added).not.toContain('â€”')
  })
})




