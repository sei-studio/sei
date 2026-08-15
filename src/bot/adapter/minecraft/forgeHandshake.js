// src/bot/adapter/minecraft/forgeHandshake.js
//
// SPIKE (260806) — join a Forge/NeoForge world as a vanilla-protocol client.
// OFF unless SEI_FORGE_HANDSHAKE=1. Nothing below runs in a normal build.
//
// ── Why this can work at all ────────────────────────────────────────────────
//
// node-minecraft-protocol answers "not understood" to every login plugin
// request (src/client/pluginChannels.js onLoginPluginRequest), exactly like a
// Notchian client. A Forge server sees a vanilla connection and, if any mod
// requires a client-side counterpart, kicks with "This server has mods that
// require NeoForge to be installed on the client."
//
// The negotiation is more forgiving than it looks. Read against NeoForge 1.20.1
// (src/main/java/net/minecraftforge/network/HandshakeHandler.java:237), the
// SERVER-side check on our reply is:
//
//     Map<ResourceLocation, String> mismatchedChannels =
//         NetworkRegistry.validateServerChannels(clientModList.getChannels());
//
// It validates the CHANNELS map only. The mod list is logged and stored; the
// registries map is not examined at all. So a client that echoes the server's
// own channel map back reports, by construction, an exact version match for
// every channel, and is accepted. That is what this module does.
//
// ── Wire format (all source-verified against NeoForge 1.20.1) ───────────────
//
//   login_plugin_request.channel == 'fml:loginwrapper'
//   payload (LoginWrapper.wrapPacket):
//       String  targetChannel        ("fml:handshake")
//       VarInt  innerLength
//       bytes   inner
//   inner (simple/IndexedMessageCodec:120 writes the discriminator as one byte):
//       u8      discriminator        (the packet id)
//       ...     message body
//
//   The login index is NOT in the payload: it rides the vanilla
//   login_plugin_request messageId, and the reply reuses it. nmp already does
//   that for us.
//
//   Discriminators (NetworkInitialization.java:25-73):
//       1  S2CModList             ->  reply 2  C2SModListReply
//       2  C2SModListReply        (client -> server)
//       3  S2CRegistry            ->  reply 99 C2SAcknowledge
//       4  S2CConfigData          ->  reply 99
//       5  S2CModData             ->  reply 99
//       6  S2CChannelMismatchData (the server rejecting us; see below)
//      99  C2SAcknowledge         (empty body)
//
//   S2CModList body (HandshakeMessages.java:76):
//       VarInt n; n x String                      mods
//       VarInt n; n x (String name, String ver)   channels
//       VarInt n; n x String                      registries
//       VarInt n; n x String                      dataPackRegistries  (1.20.1+)
//   C2SModListReply body (HandshakeMessages.java:213):
//       VarInt n; n x String                      mods
//       VarInt n; n x (String name, String ver)   channels
//       VarInt n; n x (String name, String ver)   registries
//
//   Note the asymmetry: the server sends registries as bare names, the client
//   replies with name/marker PAIRS. So the reply cannot be a byte-for-byte
//   echo; the names are re-emitted with an empty marker, which is safe
//   precisely because nothing server-side reads them.
//
// ── The handshake address marker ────────────────────────────────────────────
//
// ConnectionType.forVersionFlag (ConnectionType.java:23) decides MODDED vs
// VANILLA purely from `vers.startsWith("FML")`, where `vers` is the second
// null-delimited field of the handshake's server-address string. So the client
// must send `<host>\0FML3\0`. NETVERSION is FMLNETMARKER + FMLNETVERSION =
// "FML" + 3 on 1.20.1 (NetworkConstants.java:25-30); older Forge lines use
// FML2, hence FML_MARKER being a parameter rather than a constant.
// nmp exposes `client.tagHost`, appended to options.host in setProtocol.js.
//
// ── WHAT THIS DOES NOT DO, AND THE OPEN QUESTION ────────────────────────────
//
// S2CRegistry (id 3) carries the server's registry SNAPSHOT: the numeric ids
// for blocks, items and entities including modded content. A real Forge client
// applies that snapshot and remaps its registries. We acknowledge it and throw
// it away, because mineflayer's ids come from minecraft-data and there is no
// seam to remap them through.
//
// Forge is believed to preserve vanilla ids and append modded content above
// them, which would mean vanilla blocks stay correct and modded ones read as
// unknown. THAT IS THE HYPOTHESIS THIS SPIKE EXISTS TO TEST, not an established
// fact. If it is wrong, vanilla block ids shift too and the bot would mine,
// path and report against a world it is misreading, which is a far worse
// failure than being kicked. `summarizeRegistrySnapshot` below logs what the
// server actually sent so the answer can be read off a real session.
//
// DO NOT ship this on by default until that has been measured against a live
// NeoForge world.

/** Default FML network version marker. "FML" + FMLNETVERSION (3 on 1.20.1). */
export const FML_MARKER = 'FML3'

/** The wrapper channel every Forge login packet arrives on. */
export const LOGIN_WRAPPER_CHANNEL = 'fml:loginwrapper'
/** The inner channel the handshake itself speaks. */
export const HANDSHAKE_CHANNEL = 'fml:handshake'

export const PACKET_MOD_LIST = 1
export const PACKET_MOD_LIST_REPLY = 2
export const PACKET_REGISTRY = 3
export const PACKET_CONFIG_DATA = 4
export const PACKET_MOD_DATA = 5
export const PACKET_CHANNEL_MISMATCH = 6
export const PACKET_ACKNOWLEDGE = 99

// ── Primitive codecs ────────────────────────────────────────────────────────
// Minecraft VarInt + length-prefixed UTF-8. Deliberately hand-rolled rather
// than reached for from protodef: this module has to stay usable from a plain
// unit test with no minecraft-data version loaded.

/** @returns {{ value: number, size: number }} */
export function readVarInt (buf, offset = 0) {
  let value = 0
  let size = 0
  let byte
  do {
    if (offset + size >= buf.length) throw new Error('varint truncated')
    byte = buf[offset + size]
    value |= (byte & 0x7f) << (7 * size)
    size += 1
    if (size > 5) throw new Error('varint too long')
  } while (byte & 0x80)
  return { value: value >>> 0, size }
}

/** @returns {Buffer} */
export function writeVarInt (value) {
  const out = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return Buffer.from(out)
}

/** @returns {{ value: string, size: number }} */
export function readString (buf, offset = 0) {
  const len = readVarInt(buf, offset)
  const start = offset + len.size
  const end = start + len.value
  if (end > buf.length) throw new Error('string truncated')
  return { value: buf.toString('utf8', start, end), size: len.size + len.value }
}

/** @returns {Buffer} */
export function writeString (str) {
  const body = Buffer.from(str, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

// ── fml:loginwrapper ────────────────────────────────────────────────────────

/**
 * Unwrap a `fml:loginwrapper` payload.
 * @returns {{ channel: string, inner: Buffer }}
 */
export function parseLoginWrapper (data) {
  const channel = readString(data, 0)
  const len = readVarInt(data, channel.size)
  const start = channel.size + len.size
  return {
    channel: channel.value,
    inner: data.subarray(start, start + len.value),
  }
}

/** Wrap a reply for a target channel. Mirrors LoginWrapper.wrapPacket. */
export function buildLoginWrapper (channel, inner) {
  return Buffer.concat([writeString(channel), writeVarInt(inner.length), inner])
}

// ── fml:handshake messages ──────────────────────────────────────────────────

/**
 * Decode S2CModList. `inner` INCLUDES the discriminator byte.
 *
 * dataPackRegistries is 1.20.1+ and absent on older lines, so a buffer that
 * ends after `registries` is not an error.
 */
export function decodeModList (inner) {
  let off = 1 // discriminator
  const readList = (perItem) => {
    const n = readVarInt(inner, off)
    off += n.size
    const items = []
    for (let i = 0; i < n.value; i++) items.push(perItem())
    return items
  }
  const str = () => {
    const s = readString(inner, off)
    off += s.size
    return s.value
  }
  const mods = readList(str)
  const channels = readList(() => ({ name: str(), version: str() }))
  const registries = readList(str)
  let dataPackRegistries = []
  try {
    if (off < inner.length) dataPackRegistries = readList(str)
  } catch {
    dataPackRegistries = [] // pre-1.20.1 server, field absent
  }
  return { mods, channels, registries, dataPackRegistries }
}

/**
 * Encode C2SModListReply.
 *
 * `channels` MUST be the server's own list echoed back: that is the only field
 * validateServerChannels looks at, and echoing guarantees a version match for
 * every channel. Registry markers are empty strings because nothing server-side
 * reads them (see the header note).
 */
export function encodeModListReply ({ mods, channels, registries }) {
  const parts = [Buffer.from([PACKET_MOD_LIST_REPLY])]
  parts.push(writeVarInt(mods.length))
  for (const m of mods) parts.push(writeString(m))
  parts.push(writeVarInt(channels.length))
  for (const c of channels) parts.push(writeString(c.name), writeString(c.version))
  parts.push(writeVarInt(registries.length))
  for (const r of registries) parts.push(writeString(r), writeString(''))
  return Buffer.concat(parts)
}

/** Encode C2SAcknowledge. Empty body (HandshakeMessages.java:245). */
export function encodeAcknowledge () {
  return Buffer.from([PACKET_ACKNOWLEDGE])
}

/**
 * Decide the reply to one `fml:loginwrapper` request.
 *
 * Pure: no client, no sockets. Returns the wrapped response payload, or null
 * meaning "answer the vanilla not-understood way".
 *
 * @param {Buffer} data  the login_plugin_request payload
 * @param {(msg: string) => void} [log]
 * @returns {Buffer|null}
 */
export function respondToLoginWrapper (data, log = () => {}) {
  let unwrapped
  try {
    unwrapped = parseLoginWrapper(data)
  } catch (err) {
    log(`[sei/forge] malformed loginwrapper payload (${err.message})`)
    return null
  }
  if (unwrapped.channel !== HANDSHAKE_CHANNEL) {
    log(`[sei/forge] ignoring wrapped channel ${unwrapped.channel}`)
    return null
  }
  const inner = unwrapped.inner
  if (inner.length === 0) return null
  const id = inner[0]

  if (id === PACKET_MOD_LIST) {
    let list
    try {
      list = decodeModList(inner)
    } catch (err) {
      log(`[sei/forge] could not decode the server mod list (${err.message})`)
      return null
    }
    log(
      `[sei/forge] server mod list: ${list.mods.length} mods, ${list.channels.length} channels, ` +
        `${list.registries.length} registries, ${list.dataPackRegistries.length} datapack registries`,
    )
    return buildLoginWrapper(
      HANDSHAKE_CHANNEL,
      encodeModListReply({
        mods: list.mods,
        channels: list.channels,
        registries: list.registries,
      }),
    )
  }

  // The server telling us our channel list did not match. It disconnects
  // immediately after sending this, so there is nothing to reply; log it,
  // because it is the signal that the echo strategy has stopped working.
  if (id === PACKET_CHANNEL_MISMATCH) {
    log('[sei/forge] server reported a channel mismatch — the mod-list echo was rejected')
    return null
  }

  if (id === PACKET_REGISTRY || id === PACKET_CONFIG_DATA || id === PACKET_MOD_DATA) {
    if (id === PACKET_REGISTRY) log(summarizeRegistrySnapshot(inner))
    return buildLoginWrapper(HANDSHAKE_CHANNEL, encodeAcknowledge())
  }

  log(`[sei/forge] unhandled fml:handshake packet id ${id}`)
  return null
}

/**
 * One log line per registry the server sends us and then we discard.
 *
 * This is the measurement the spike is for: a snapshot arriving for
 * minecraft:block or minecraft:item means the server is asserting ids that
 * mineflayer's minecraft-data does not know about. Reading these off a live
 * session is how we find out whether vanilla ids survived.
 */
export function summarizeRegistrySnapshot (inner) {
  try {
    const name = readString(inner, 1)
    const hasSnapshot = inner[1 + name.size] === 1
    const bytes = inner.length - (1 + name.size + 1)
    return `[sei/forge] registry ${name.value}: snapshot=${hasSnapshot} (${bytes} bytes, DISCARDED)`
  } catch {
    return '[sei/forge] registry packet (unparsed)'
  }
}

// ── Installation ────────────────────────────────────────────────────────────

/** Is the spike enabled? Off unless explicitly asked for. */
export function forgeHandshakeEnabled (env = process.env) {
  return env.SEI_FORGE_HANDSHAKE === '1'
}

/**
 * THE MEASUREMENT. Sample the loaded world and report how much of it
 * mineflayer could not name.
 *
 * The open question this spike exists to answer is whether discarding the
 * server's registry snapshot leaves VANILLA block ids intact. Forge is believed
 * to preserve them and append modded content above, in which case this reports
 * a small unknown fraction made up entirely of modded blocks. If instead the
 * vanilla ids shifted, the bot is misreading the world, and the honest outcome
 * of the spike is to abandon it rather than ship a companion that mines the
 * wrong block.
 *
 * A read-only sample of already-loaded chunk data: no pathfinding, no chunk
 * requests, no packets. Bounded by construction (a fixed lattice around the
 * bot), so it cannot become a per-tick cost.
 *
 * @param {object} bot        mineflayer bot, post-spawn
 * @param {{info?: Function}} [logger]
 * @param {number} [radius]   half-extent of the sample cube, in blocks
 * @returns {{ sampled: number, unknown: number, names: string[] }}
 */
export function sampleWorldNames (bot, logger = console, radius = 16) {
  const origin = bot?.entity?.position
  const counts = new Map()
  let sampled = 0
  let unknown = 0
  if (!origin || !bot.blockAt) return { sampled: 0, unknown: 0, names: [] }

  const STEP = 4
  for (let dx = -radius; dx <= radius; dx += STEP) {
    for (let dy = -radius / 2; dy <= radius / 2; dy += STEP) {
      for (let dz = -radius; dz <= radius; dz += STEP) {
        let block
        try {
          block = bot.blockAt(origin.offset(dx, dy, dz))
        } catch {
          block = null
        }
        if (!block) continue
        sampled += 1
        // An id the local minecraft-data cannot name is exactly the symptom
        // a shifted registry would produce.
        const name = block.name
        if (!name || name === 'unknown' || name === 'undefined') {
          unknown += 1
          counts.set(`id:${block.type}`, (counts.get(`id:${block.type}`) ?? 0) + 1)
        } else {
          counts.set(name, (counts.get(name) ?? 0) + 1)
        }
      }
    }
  }
  const names = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([n, c]) => `${n}x${c}`)
  const pct = sampled ? Math.round((unknown / sampled) * 100) : 0
  logger.info?.(
    `[sei/forge] world sample: ${sampled} blocks, ${unknown} unnameable (${pct}%). ` +
      `Top: ${names.join(' ') || 'none'}`,
  )
  if (unknown / Math.max(sampled, 1) > 0.2) {
    logger.info?.(
      '[sei/forge] WARNING: over a fifth of sampled blocks could not be named. ' +
        'That is consistent with the registry snapshot having shifted VANILLA ids, ' +
        'not just added modded ones. Do not ship the handshake if this reproduces.',
    )
  }
  return { sampled, unknown, names }
}

/**
 * Attach the handshake to a mineflayer bot's underlying protocol client.
 *
 * Must run BEFORE the connection reaches the login state, i.e. immediately
 * after createBot — `tagHost` is read in nmp's `connect` handler.
 *
 * nmp installs its own `login_plugin_request` listener that unconditionally
 * replies "not understood"; leaving it attached would send a SECOND response
 * for every request we answer. There is no handle to remove just that one, so
 * every listener is dropped and ours re-implements the vanilla fallback for
 * anything it does not handle.
 *
 * @param {object} bot     mineflayer bot (uses bot._client)
 * @param {object} [opts]
 * @param {string} [opts.marker]  FML network marker, default FML3
 * @param {{info?: Function, warn?: Function}} [opts.logger]
 */
export function installForgeHandshake (bot, opts = {}) {
  const client = bot && bot._client
  if (!client) throw new Error('installForgeHandshake: bot._client is not available yet')
  const marker = opts.marker ?? FML_MARKER
  const logger = opts.logger ?? console
  const log = (m) => logger.info?.(m)

  // `<host>\0FML3\0` — see the ConnectionType note in the header.
  client.tagHost = `\0${marker}\0`

  client.removeAllListeners('login_plugin_request')
  client.on('login_plugin_request', (packet) => {
    let response = null
    if (packet.channel === LOGIN_WRAPPER_CHANNEL) {
      try {
        response = respondToLoginWrapper(packet.data, log)
      } catch (err) {
        logger.warn?.(`[sei/forge] handshake reply failed (${err && err.message})`)
        response = null
      }
    }
    // `data` omitted is the vanilla "not understood" response, which is both
    // the correct answer for channels we do not speak and the safe fallback
    // when our own reply could not be built.
    client.write('login_plugin_response',
      response ? { messageId: packet.messageId, data: response } : { messageId: packet.messageId })
  })

  log(`[sei/forge] handshake spike active (marker ${marker}) — modded content will NOT be visible`)
}
