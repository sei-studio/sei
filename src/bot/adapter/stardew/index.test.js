import { describe, it, expect, vi } from 'vitest'
import { createStardewAdapter } from './index.js'
import { CAPABILITY_PARAGRAPH, CAPABILITY_PARAGRAPH_CHORES, ACTION_RULES, ACTION_RULES_CHORES } from './prompts.js'

function fakeClient(version) {
  return {
    welcome: version ? { hello: { version } } : null,
    on: vi.fn(),
    off: vi.fn(),
    request: vi.fn(async (frame) => (frame.t === 'observe' ? { ok: true, obs: null } : { ok: true, detail: `did ${frame.name}` })),
  }
}

describe('stardew adapter mod-version gating', () => {
  it('hides ship and give from an older mod and shows them to 0.1.3', () => {
    const old = createStardewAdapter({ client: fakeClient('0.1.2'), config: {}, botUsername: 'Sui', logger: { warn() {} } })
    expect(old.listActions()).not.toContain('ship')
    expect(old.listActions()).not.toContain('give')
    expect(old.listActions()).toContain('till')
    expect(old.capabilityParagraph()).toBe(CAPABILITY_PARAGRAPH)
    expect(old.actionRules()).toBe(ACTION_RULES)
    expect(old.getActionDescription('water')).not.toMatch(/scope/)

    const now = createStardewAdapter({ client: fakeClient('0.1.3'), config: {}, botUsername: 'Sui', logger: { warn() {} } })
    expect(now.listActions()).toEqual(expect.arrayContaining(['ship', 'give']))
    expect(now.capabilityParagraph()).toBe(CAPABILITY_PARAGRAPH_CHORES)
    expect(now.actionRules()).toBe(ACTION_RULES_CHORES)
    expect(now.getActionDescription('water')).toMatch(/scope/)
    expect(now.getActionDescription('ship')).toMatch(/shipping bin/)
  })

  it('reports till progress through the exec config and ships through the socket', async () => {
    const client = fakeClient('0.1.3')
    const a = createStardewAdapter({ client, config: {}, botUsername: 'Sui', logger: { warn() {} } })
    expect(a.progressActions).toEqual(expect.arrayContaining(['till', 'plant', 'ship', 'give']))
    const onProgress = vi.fn()
    const out = await a.executeAction('till', { x: 1, y: 1, width: 2, height: 1 }, { onProgress })
    expect(out).toMatch(/^tilled 2 tiles of the 2x1 patch/)
    expect(onProgress).toHaveBeenLastCalledWith({ dug: 2, total: 2 })
    expect(await a.executeAction('ship', {})).toBe('did ship')
  })
})
