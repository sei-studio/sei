// Game-adapters M0 (260908): adapter.kind is an enum, per-kind blocks, and
// the lan_motd → world_label legacy hoist.
import { describe, it, expect } from 'vitest'
import { ConfigSchema, GAME_KINDS } from './config.js'

const base = {
  player_username: 'Steve',
  persona: { name: 'Sui', expanded: 'x' },
  anthropic: { api_key: 'k' },
}
const mc = { host: '127.0.0.1', auth: 'offline', username: 'Sui' }

describe('ConfigSchema adapter.kind (game-adapters M0)', () => {
  it('lists the three games', () => {
    expect(GAME_KINDS).toEqual(['minecraft', 'stardew', 'dontstarve'])
  })

  it('defaults to minecraft and keeps the minecraft block mandatory for it', () => {
    const ok = ConfigSchema.parse({ ...base, adapter: { minecraft: mc } })
    expect(ok.adapter.kind).toBe('minecraft')
    expect(ok.adapter.minecraft.reconnect_delay_ms).toBe(5000)
    expect(() => ConfigSchema.parse({ ...base, adapter: { kind: 'minecraft' } })).toThrow(/adapter\.minecraft is required/)
  })

  it('parses a stardew / dontstarve session with no minecraft block (stardew has a real schema since M1, dontstarve a passthrough placeholder)', () => {
    const sd = ConfigSchema.parse({ ...base, adapter: { kind: 'stardew', stardew: { port: 8123, token: 'abc', username: 'Sui' } } })
    expect(sd.adapter.kind).toBe('stardew')
    expect(sd.adapter.stardew).toMatchObject({ host: '127.0.0.1', port: 8123, token: 'abc', username: 'Sui', reconnect_delay_ms: 3000 })
    expect(() => ConfigSchema.parse({ ...base, adapter: { kind: 'stardew' } })).toThrow(/adapter\.stardew is required/)
    expect(sd.adapter.minecraft).toBeUndefined()
    const dst = ConfigSchema.parse({ ...base, adapter: { kind: 'dontstarve', dontstarve: {} } })
    expect(dst.adapter.kind).toBe('dontstarve')
  })

  it('rejects an unknown kind', () => {
    expect(() => ConfigSchema.parse({ ...base, adapter: { kind: 'roblox' } })).toThrow()
  })

  it('hoists the legacy lan_motd key into world_label (explicit world_label wins)', () => {
    const legacy = ConfigSchema.parse({ ...base, lan_motd: 'Old World', adapter: { minecraft: mc } })
    expect(legacy.world_label).toBe('Old World')
    expect('lan_motd' in legacy).toBe(false)
    const both = ConfigSchema.parse({ ...base, lan_motd: 'Old', world_label: 'New', adapter: { minecraft: mc } })
    expect(both.world_label).toBe('New')
    const none = ConfigSchema.parse({ ...base, adapter: { minecraft: mc } })
    expect(none.world_label).toBeNull()
  })
})
