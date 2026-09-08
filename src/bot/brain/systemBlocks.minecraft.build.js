// Shared by the fixture generator and the pin test (game-adapters M0).
// Builds the cached system blocks + tool list for a Minecraft session under
// three configurations that cover every optional block the prefix can carry.
import path from 'node:path'
import { ConfigSchema } from '../config.js'
import { createMinecraftAdapter } from '../adapter/minecraft/index.js'
import { createOrchestrator } from './orchestrator.js'

function rawConfig(memDir, extra = {}) {
  return {
    chat_mode: 'chat',
    realistic_typing: true,
    player_username: 'Steve',
    player_display_name: 'Steve',
    lan_motd: null,
    persona: { name: 'Sui', expanded: 'You are Sui, a sharp little companion who loves caves.', proactiveness: 2 },
    anthropic: { api_key: 'sk-test' },
    adapter: {
      kind: 'minecraft',
      minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: 'Sui', version: 'auto' },
    },
    memory: {
      player_md_path: `${memDir}/PLAYER.md`,
      memory_md_path: `${memDir}/MEMORY.md`,
      heartbeat_md_path: `${memDir}/HEARTBEAT.md`,
      worlds_json_path: `${memDir}/worlds.json`,
    },
    vision: {},
    ...extra,
  }
}

function capture(config, bot) {
  let captured = null
  const provider = {
    buildCachedSystem: (blocks, tools) => { captured = { blocks, tools }; return blocks },
    setAuthToken() {},
    setBackend() {},
    capabilities: { vision: true },
    async call() { return { text: '', toolUses: [] } },
  }
  const adapter = createMinecraftAdapter({ bot, config, visionEnabled: true })
  createOrchestrator({ adapter, config, reenqueue: () => {}, _anthropicOverride: provider, logger: { info() {}, warn() {}, error() {}, debug() {} } })
  return captured
}

/** @returns {Promise<Record<string, {blocks: string[], tools: object[]}>>} */
export async function buildMinecraftSystemFixture(memDir) {
  const bot = { chat() {}, username: 'Sui', players: {}, on() {}, off() {}, removeListener() {}, once() {} }
  const base = ConfigSchema.parse(rawConfig(memDir))
  const zhKnowledge = ConfigSchema.parse(rawConfig(memDir, { chat_language: 'zh', persona: { name: 'Sui', expanded: 'You are Sui.', proactiveness: 1, punctuation: 'deliberate' } }))
  zhKnowledge._seiKnowledge = 'Steve likes redstone.'
  const visionOff = ConfigSchema.parse(rawConfig(memDir, { vision: { mode: 'off' } }))
  return {
    base: capture(base, bot),
    zhKnowledge: capture(zhKnowledge, bot),
    visionOff: capture(visionOff, bot),
  }
}
