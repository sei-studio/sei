// Forge/NeoForge login handshake spike (260806).
//
// The codec is pinned against NeoForge 1.20.1 source rather than against a
// capture, so these tests are round-trip + shape tests: they encode what
// HandshakeMessages.java says the server decodes, and decode what it says the
// server encodes. A live NeoForge world is still owed before this ships.
//
// The load-bearing behaviour, in one line: the reply must echo the server's
// CHANNELS verbatim, because HandshakeHandler.handleClientModListOnServer:240
// validates that map and nothing else.

import { describe, it, expect, vi } from 'vitest'
import {
  readVarInt,
  writeVarInt,
  readString,
  writeString,
  parseLoginWrapper,
  buildLoginWrapper,
  decodeModList,
  encodeModListReply,
  encodeAcknowledge,
  respondToLoginWrapper,
  forgeHandshakeEnabled,
  installForgeHandshake,
  sampleWorldNames,
  HANDSHAKE_CHANNEL,
  LOGIN_WRAPPER_CHANNEL,
  PACKET_MOD_LIST,
  PACKET_MOD_LIST_REPLY,
  PACKET_REGISTRY,
  PACKET_ACKNOWLEDGE,
  PACKET_CHANNEL_MISMATCH,
  FML_MARKER,
} from './forgeHandshake.js'

/** Build an S2CModList exactly as HandshakeMessages.java:97 encodes it. */
function serverModList ({ mods, channels, registries, dataPackRegistries = [] }) {
  const parts = [Buffer.from([PACKET_MOD_LIST])]
  parts.push(writeVarInt(mods.length))
  for (const m of mods) parts.push(writeString(m))
  parts.push(writeVarInt(channels.length))
  for (const c of channels) parts.push(writeString(c.name), writeString(c.version))
  parts.push(writeVarInt(registries.length))
  for (const r of registries) parts.push(writeString(r))
  parts.push(writeVarInt(dataPackRegistries.length))
  for (const r of dataPackRegistries) parts.push(writeString(r))
  return Buffer.concat(parts)
}

describe('primitive codecs', () => {
  it('round-trips varints across the byte-length boundaries', () => {
    for (const n of [0, 1, 127, 128, 255, 300, 16383, 16384, 2097151, 2097152, 2147483647]) {
      const buf = writeVarInt(n)
      expect(readVarInt(buf, 0)).toEqual({ value: n, size: buf.length })
    }
  })

  it('round-trips strings including non-ASCII', () => {
    for (const s of ['', 'minecraft:block', 'fml:handshake', '模组']) {
      const buf = writeString(s)
      expect(readString(buf, 0).value).toBe(s)
    }
  })

  it('reads at an offset without disturbing the rest of the buffer', () => {
    const buf = Buffer.concat([writeVarInt(7), writeString('create')])
    const n = readVarInt(buf, 0)
    expect(n.value).toBe(7)
    expect(readString(buf, n.size).value).toBe('create')
  })

  it('rejects a truncated string rather than reading past the end', () => {
    expect(() => readString(Buffer.from([0x10, 0x61]), 0)).toThrow(/truncated/)
  })
})

describe('fml:loginwrapper', () => {
  it('round-trips channel + inner payload', () => {
    const inner = Buffer.from([PACKET_ACKNOWLEDGE])
    const wrapped = buildLoginWrapper(HANDSHAKE_CHANNEL, inner)
    expect(parseLoginWrapper(wrapped)).toEqual({ channel: HANDSHAKE_CHANNEL, inner })
  })
})

describe('S2CModList / C2SModListReply', () => {
  const SERVER = {
    mods: ['minecraft', 'neoforge', 'create', 'jei'],
    channels: [
      { name: 'create:main', version: '1' },
      { name: 'jei:channel', version: '1.0.0' },
    ],
    registries: ['minecraft:block', 'minecraft:item', 'create:fluids'],
    dataPackRegistries: ['minecraft:worldgen/biome'],
  }

  it('decodes the server mod list, including the 1.20.1 datapack field', () => {
    expect(decodeModList(serverModList(SERVER))).toEqual(SERVER)
  })

  // Older Forge lines do not send dataPackRegistries; the buffer simply ends.
  it('decodes a pre-1.20.1 list with no datapack registries field', () => {
    const parts = [Buffer.from([PACKET_MOD_LIST])]
    parts.push(writeVarInt(1), writeString('minecraft'))
    parts.push(writeVarInt(0))
    parts.push(writeVarInt(1), writeString('minecraft:block'))
    const decoded = decodeModList(Buffer.concat(parts))
    expect(decoded.mods).toEqual(['minecraft'])
    expect(decoded.dataPackRegistries).toEqual([])
  })

  // THE load-bearing assertion. validateServerChannels compares the client's
  // advertised version per channel against the server's; echoing makes every
  // comparison an identity.
  it('echoes the channel map verbatim so validateServerChannels cannot mismatch', () => {
    const reply = encodeModListReply(SERVER)
    let off = 1
    const readList = (perItem) => {
      const n = readVarInt(reply, off)
      off += n.size
      return Array.from({ length: n.value }, perItem)
    }
    const str = () => {
      const s = readString(reply, off)
      off += s.size
      return s.value
    }
    expect(reply[0]).toBe(PACKET_MOD_LIST_REPLY)
    expect(readList(str)).toEqual(SERVER.mods)
    expect(readList(() => ({ name: str(), version: str() }))).toEqual(SERVER.channels)
    // The asymmetry: the server sends bare names, the reply sends pairs.
    expect(readList(() => ({ name: str(), version: str() }))).toEqual(
      SERVER.registries.map((name) => ({ name, version: '' })),
    )
    expect(off).toBe(reply.length)
  })

  it('answers a mod list with a wrapped ModListReply', () => {
    const out = respondToLoginWrapper(
      buildLoginWrapper(HANDSHAKE_CHANNEL, serverModList(SERVER)),
    )
    const { channel, inner } = parseLoginWrapper(out)
    expect(channel).toBe(HANDSHAKE_CHANNEL)
    expect(inner[0]).toBe(PACKET_MOD_LIST_REPLY)
  })
})

describe('respondToLoginWrapper', () => {
  const wrap = (inner) => buildLoginWrapper(HANDSHAKE_CHANNEL, inner)

  it('acknowledges registry, config and mod-data packets', () => {
    for (const id of [3, 4, 5]) {
      const out = respondToLoginWrapper(wrap(Buffer.concat([Buffer.from([id]), writeString('x'), Buffer.from([0])])))
      expect(parseLoginWrapper(out).inner).toEqual(encodeAcknowledge())
    }
  })

  // The registry snapshot is the thing we throw away, and the reason this is a
  // spike rather than a feature. It must be logged, not silently dropped.
  it('logs the discarded registry snapshot so the id question can be measured', () => {
    const log = vi.fn()
    const inner = Buffer.concat([
      Buffer.from([PACKET_REGISTRY]),
      writeString('minecraft:block'),
      Buffer.from([1]),
      Buffer.alloc(64),
    ])
    respondToLoginWrapper(wrap(inner), log)
    const line = log.mock.calls.map((c) => c[0]).find((m) => m.includes('minecraft:block'))
    expect(line).toContain('snapshot=true')
    expect(line).toContain('DISCARDED')
  })

  it('does not reply to a channel-mismatch rejection, and says so', () => {
    const log = vi.fn()
    expect(respondToLoginWrapper(wrap(Buffer.from([PACKET_CHANNEL_MISMATCH])), log)).toBeNull()
    expect(log.mock.calls.map((c) => c[0]).join(' ')).toMatch(/channel mismatch/i)
  })

  it('falls back to not-understood for a non-handshake wrapped channel', () => {
    expect(respondToLoginWrapper(buildLoginWrapper('other:thing', Buffer.from([1])))).toBeNull()
  })

  it('falls back to not-understood on a malformed payload instead of throwing', () => {
    expect(respondToLoginWrapper(Buffer.from([0xff, 0xff]))).toBeNull()
  })
})

describe('sampleWorldNames', () => {
  const at = (name, type) => ({ name, type })
  function fakeBot (blockFor) {
    return {
      entity: { position: { offset: (x, y, z) => ({ x, y, z }) } },
      blockAt: (p) => blockFor(p),
    }
  }

  it('reports zero unnameable blocks on a clean vanilla world', () => {
    const log = vi.fn()
    const r = sampleWorldNames(fakeBot(() => at('stone', 1)), { info: log })
    expect(r.sampled).toBeGreaterThan(0)
    expect(r.unknown).toBe(0)
    expect(log.mock.calls[0][0]).toContain('0 unnameable')
  })

  // The failure the spike is looking for: ids that minecraft-data cannot name.
  it('counts unnameable ids and warns when they dominate', () => {
    const log = vi.fn()
    const r = sampleWorldNames(fakeBot(() => at(undefined, 4242)), { info: log })
    expect(r.unknown).toBe(r.sampled)
    const all = log.mock.calls.map((c) => c[0]).join('\n')
    expect(all).toContain('id:4242')
    expect(all).toMatch(/shifted VANILLA ids/)
  })

  it('stays quiet about shifted ids when only a few blocks are modded', () => {
    const log = vi.fn()
    let n = 0
    sampleWorldNames(fakeBot(() => (n++ % 20 === 0 ? at(undefined, 9001) : at('dirt', 3))), { info: log })
    expect(log.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/shifted VANILLA ids/)
  })

  it('is inert before spawn', () => {
    expect(sampleWorldNames({}, { info: vi.fn() })).toEqual({ sampled: 0, unknown: 0, names: [] })
  })

  it('survives blockAt throwing on an unloaded chunk', () => {
    const r = sampleWorldNames(
      fakeBot(() => {
        throw new Error('chunk not loaded')
      }),
      { info: vi.fn() },
    )
    expect(r.sampled).toBe(0)
  })
})

describe('forgeHandshakeEnabled', () => {
  it('is off unless explicitly asked for', () => {
    expect(forgeHandshakeEnabled({})).toBe(false)
    expect(forgeHandshakeEnabled({ SEI_FORGE_HANDSHAKE: '0' })).toBe(false)
    expect(forgeHandshakeEnabled({ SEI_FORGE_HANDSHAKE: '1' })).toBe(true)
  })
})

describe('installForgeHandshake', () => {
  function fakeClient () {
    const listeners = new Map()
    return {
      written: [],
      tagHost: undefined,
      on (ev, fn) {
        listeners.set(ev, [...(listeners.get(ev) ?? []), fn])
      },
      removeAllListeners (ev) {
        listeners.delete(ev)
      },
      write (name, payload) {
        this.written.push({ name, payload })
      },
      emit (ev, payload) {
        for (const fn of listeners.get(ev) ?? []) fn(payload)
      },
      count (ev) {
        return (listeners.get(ev) ?? []).length
      },
    }
  }

  it('sets the null-delimited FML marker nmp appends to the handshake host', () => {
    const client = fakeClient()
    installForgeHandshake({ _client: client }, { logger: { info () {}, warn () {} } })
    expect(client.tagHost).toBe(`\0${FML_MARKER}\0`)
  })

  // nmp's own listener replies "not understood" to everything. Leaving it
  // attached would send two responses for every request we answer.
  it('replaces nmp’s listener rather than stacking on it', () => {
    const client = fakeClient()
    client.on('login_plugin_request', () => {})
    client.on('login_plugin_request', () => {})
    installForgeHandshake({ _client: client }, { logger: { info () {}, warn () {} } })
    expect(client.count('login_plugin_request')).toBe(1)
  })

  it('answers a wrapped mod list once, reusing the messageId', () => {
    const client = fakeClient()
    installForgeHandshake({ _client: client }, { logger: { info () {}, warn () {} } })
    client.emit('login_plugin_request', {
      messageId: 7,
      channel: LOGIN_WRAPPER_CHANNEL,
      data: buildLoginWrapper(
        HANDSHAKE_CHANNEL,
        serverModList({ mods: ['minecraft'], channels: [], registries: [] }),
      ),
    })
    expect(client.written).toHaveLength(1)
    expect(client.written[0].name).toBe('login_plugin_response')
    expect(client.written[0].payload.messageId).toBe(7)
    expect(parseLoginWrapper(client.written[0].payload.data).inner[0]).toBe(PACKET_MOD_LIST_REPLY)
  })

  it('answers an unknown channel the vanilla not-understood way', () => {
    const client = fakeClient()
    installForgeHandshake({ _client: client }, { logger: { info () {}, warn () {} } })
    client.emit('login_plugin_request', { messageId: 3, channel: 'bungeecord:main', data: Buffer.alloc(0) })
    expect(client.written[0].payload).toEqual({ messageId: 3 })
  })

  it('throws if wired before the protocol client exists', () => {
    expect(() => installForgeHandshake({})).toThrow(/_client/)
  })
})
