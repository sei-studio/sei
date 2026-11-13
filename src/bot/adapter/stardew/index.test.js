import { describe, it, expect, vi } from 'vitest'
import { createActionStats } from '../../brain/actionStats.js'
import { createStardewAdapter } from './index.js'
import { CAPABILITY_PARAGRAPH, CAPABILITY_PARAGRAPH_CHORES, CAPABILITY_PARAGRAPH_FARMHAND, ACTION_RULES, ACTION_RULES_CHORES, STARDEW_BASELINE, eventAddendum } from './prompts.js'
import { VERB_NAMES } from './registry.js'

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

  it('shows load only to a 0.1.4 mod and says so in the capability list', () => {
    const chores = createStardewAdapter({ client: fakeClient('0.1.3'), config: {}, botUsername: 'Sui', logger: { warn() {} } })
    expect(chores.listActions()).not.toContain('load')
    expect(chores.capabilityParagraph()).not.toMatch(/put inputs into them/)
    const farmhand = createStardewAdapter({ client: fakeClient('0.1.4'), config: {}, botUsername: 'Sui', logger: { warn() {} } })
    expect(farmhand.listActions()).toContain('load')
    expect(farmhand.capabilityParagraph()).toBe(CAPABILITY_PARAGRAPH_FARMHAND)
    expect(farmhand.capabilityParagraph()).toMatch(/empty machines and put inputs into them/)
    expect(farmhand.getActionDescription('load')).toMatch(/machine/)
  })

  // The prompt may only point the model at verbs the connected mod runs: a
  // tool named in the text but missing from the tool list is a dead end
  // (the 0.1.3 interact result sent her to place(), which cannot load).
  it('every world verb the prompt text calls exists in the tool list, for every mod version', () => {
    const nonWorld = new Set(['say', 'setGoal', 'remember', 'search', 'visit'])
    for (const version of [null, '0.1.1', '0.1.2', '0.1.3', '0.1.4']) {
      const a = createStardewAdapter({ client: fakeClient(version), config: {}, botUsername: 'Sui', logger: { warn() {} } })
      const tools = new Set(a.listActions())
      const texts = [a.capabilityParagraph(), a.actionRules(), ...a.listActions().map((n) => a.getActionDescription(n)),
        eventAddendum('sei:idle', { quietMs: 10_000 }), eventAddendum('sei:attacked', { attackerKind: 'monster', attackerLabel: 'Bat', health: 50, maxHealth: 100 })]
      for (const text of texts) {
        for (const m of text.matchAll(/\b([a-zA-Z]+)\((?=[^)]*\))/g)) {
          const name = m[1]
          if (nonWorld.has(name)) continue
          expect(tools.has(name), `mod ${version}: "${name}(" named in prompt text but not a tool`).toBe(true)
        }
      }
    }
    // The baseline list names verbs; all of them are registry verbs.
    const listed = STARDEW_BASELINE.match(/tool list \(([^)]*)\)/)[1].split(',').map((s) => s.trim()).filter((s) => /^[a-zA-Z]+$/.test(s))
    for (const name of listed) expect(VERB_NAMES, name).toContain(name)
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

describe('stardew adapter action stats (261113)', () => {
  it('records each verb: "failed:" results with their class, the rest as successes', async () => {
    const stats = createActionStats()
    const client = fakeClient('0.1.4')
    client.request = vi.fn(async (frame) => {
      if (frame.t === 'observe') return { ok: true, obs: null }
      if (frame.name === 'water') return { ok: false, detail: 'no path to (3, 4)' }
      return { ok: true, detail: `did ${frame.name}` }
    })
    const adapter = createStardewAdapter({ client, config: {}, botUsername: 'Sui', logger: { warn() {} }, actionStats: stats })
    await adapter.executeAction('water', { x: 3, y: 4 })
    await adapter.executeAction('harvest', { x: 1, y: 1 })
    const a = stats.snapshot().actions
    expect(a.water).toMatchObject({ n: 1, ok: 0, fail: 1, reasons: { no_path: 1 } })
    expect(a.harvest).toMatchObject({ n: 1, ok: 1, fail: 0 })
  })
})
