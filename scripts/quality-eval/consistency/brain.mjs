// scripts/quality-eval/consistency/brain.mjs: one Minecraft companion session
// through the REAL game brain, for the consistency eval.
//
// Same approach as persona/run.mjs: createOrchestrator + handleDispatch build
// the cached system prefix, the seed blocks (player, memory, chat continuity,
// heartbeat, conversation, snapshot) and the tool list exactly as a live
// session does. Stubbed: the mineflayer bot (an inert object), the snapshot
// composer (a fixed snapshot per turn) and the provider, which forwards to the
// real Anthropic API but lets only say() and remember() through to the brain
// (nothing touches the stub world). A turn ends at its first say() or after
// MAX_LIVE model calls.
//
// Everything is imported from `src` (a checkout root), so each arm of a
// comparison runs its own brain code.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLAYER } from './life.mjs'

const MAX_LIVE = 3
// The brain's debug transcript log (log.js) stays off: BYOK mode, no key on disk.
process.env.SEI_BACKEND = 'local'
delete process.env.SEI_HAS_API_KEY

export function snapshotText(o = {}) {
  return [
    'world: #1 Meadow',
    `pos: ${o.pos ?? '112,71,-40'}`,
    'facing: north. forward -z, back +z, left -x, right +x',
    `biome: ${o.biome ?? 'plains'}  surroundings: ${o.surroundings ?? 'outside'}  light: sky 15 block 0  time: ${o.time ?? 'day (2400)'}`,
    `real time: 8:10 PM — you joined this session ${o.joined ?? '12 minutes ago'}`,
    `hp: ${o.hp ?? '20/20'}  food: ${o.food ?? '18/20'}  xp: lvl 2`,
    `holding: ${o.holding ?? 'stone_pickaxe'}`,
    `inventory (6/36 slots): ${o.inventory ?? 'oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6, crafting_table×1'}`,
    'terrain at feet: 25 grass_block',
    'nearby blocks:',
    ...(o.blocks ?? ['#1 grass_block x412 @111,70,-40', '#2 oak_log x14 @118,72,-47', '#3 water x30 @104,70,-52']),
    'nearby entities:',
    ...(o.entities ?? [`#4 ${PLAYER} @109,71,-38`, '#5 cow @121,71,-31']),
    'follow_target: (none)',
    `owner ${PLAYER}: @109,71,-38 (3 blocks away), hp 20/20`,
    `last_action_result: ${o.last ?? '(none)'}`,
  ].join('\n')
}

const quietLogger = {
  info() {}, debug() {}, trace() {},
  warn: (m) => { if (process.env.CE_VERBOSE) console.error('WARN', m) },
  error: (m) => { if (process.env.CE_VERBOSE) console.error('ERR', String(m).slice(0, 300)) },
}

/**
 * @param {{src: string, ch: object, memDir: string, key: string, model?: string,
 *   continuity?: {summary: string, recent: object[]} | null, usage?: object[]}} o
 */
export async function createGameBrain(o) {
  const imp = (rel) => import(pathToFileURL(path.join(o.src, rel)).href)
  const [{ ConfigSchema }, { createMinecraftAdapter }, { createOrchestrator }, { createSessionState }, { createAnthropicProvider }, player] = await Promise.all([
    imp('src/bot/config.js'),
    imp('src/bot/adapter/minecraft/index.js'),
    imp('src/bot/brain/orchestrator.js'),
    imp('src/bot/brain/sessionState.js'),
    imp('src/bot/brain/llm/anthropicProvider.js'),
    imp('src/bot/brain/memory/player.js'),
  ])
  const mem = (f) => path.join(o.memDir, f)
  fs.mkdirSync(o.memDir, { recursive: true })
  if (!fs.existsSync(mem('PLAYER.md'))) {
    await player.savePlayer(mem('PLAYER.md'), {
      exists: true, player_uuid: 'u-alex', player_username: PLAYER, first_seen: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      last_seen: new Date(Date.now() - 86_400_000).toISOString(), total_sessions: 6, preferred_name: PLAYER, pronouns: null,
    })
  }
  const config = ConfigSchema.parse({
    chat_mode: 'chat', realistic_typing: false, player_username: PLAYER, player_display_name: PLAYER,
    persona: { name: o.ch.botName, expanded: o.ch.expanded, proactiveness: 2, ...(o.ch.punctuation ? { punctuation: o.ch.punctuation } : {}) },
    anthropic: { api_key: o.key, model: o.model ?? 'claude-haiku-5-5' },
    adapter: { kind: 'minecraft', minecraft: { host: '127.0.0.1', port: 25565, auth: 'offline', username: o.ch.botName, version: 'auto' } },
    memory: { player_md_path: mem('PLAYER.md'), memory_md_path: mem('MEMORY.md'), heartbeat_md_path: mem('HEARTBEAT.md'), worlds_json_path: mem('worlds.json') },
    vision: {},
  })
  // Launch continuity rides on config exactly as bot/index.js stashes it.
  config._seiContinuity = o.continuity ?? null
  const bot = {
    chat() {}, whisper() {}, username: o.ch.botName, players: {}, on() {}, off() {}, removeListener() {}, once() {}, emit() {},
    entity: { position: { x: 112, y: 71, z: -40 } }, health: 20, food: 20,
  }
  let snapshot = snapshotText()
  const realAdapter = createMinecraftAdapter({ bot, config, visionEnabled: false })
  const overrides = { createSnapshotComposer: () => ({ next: () => snapshot }), closeAnySessions: async () => {} }
  const adapter = new Proxy(realAdapter, { get: (t, k) => (k in overrides ? overrides[k] : t[k]) })
  const real = createAnthropicProvider(config)

  const st = { mode: 'live', prime: null, live: 0, says: [], remembers: [], farewell: null, done: false }
  const endLoop = () => ({
    text: '', toolUses: [{ id: 'stop1', name: 'end_loop', input: {} }],
    content: [{ type: 'tool_use', id: 'stop1', name: 'end_loop', input: {} }], usage: {}, stopReason: 'tool_use',
  })
  const provider = {
    ...real,
    get model() { return real.model },
    async call(req) {
      if (st.mode === 'prime') {
        st.mode = 'primed'
        const tu = { id: `prime${Date.now()}`, name: 'say', input: { text: st.prime } }
        return { text: '', toolUses: [tu], content: [{ type: 'tool_use', ...tu }], usage: {}, stopReason: 'tool_use' }
      }
      if (st.mode === 'primed' || st.done || st.live >= MAX_LIVE) return endLoop()
      st.live++
      let resp
      for (let attempt = 0; ; attempt++) {
        try { resp = await real.call(req); break } catch (err) {
          if (attempt >= 4) throw err
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
      o.usage?.push({ model: config.anthropic.model, ...(resp.usage ?? {}) })
      const says = resp.toolUses.filter((t) => t.name === 'say').map((t) => String(t.input?.text ?? t.input?.message ?? ''))
      const rem = resp.toolUses.filter((t) => t.name === 'remember').map((t) => String(t.input?.text ?? ''))
      const quit = resp.toolUses.find((t) => t.name === 'quit_game' && t.input?.farewell)
      st.says.push(...says.filter(Boolean))
      st.remembers.push(...rem.filter(Boolean))
      if (quit) st.farewell = String(quit.input.farewell)
      if (says.length || quit) st.done = true
      const keep = resp.toolUses.filter((t) => t.name === 'say' || t.name === 'remember')
      if (!keep.length) return endLoop()
      return {
        text: resp.text, toolUses: keep,
        content: (resp.content ?? []).filter((b) => b.type === 'text' || (b.type === 'tool_use' && (b.name === 'say' || b.name === 'remember'))),
        usage: resp.usage, stopReason: 'tool_use',
      }
    },
  }
  const sessionState = await createSessionState({ playerMdPath: config.memory.player_md_path, config, bot, logger: quietLogger })
  const orch = createOrchestrator({
    adapter, config, logger: quietLogger, sessionState,
    playerStore: { loadPlayer: player.loadPlayer, savePlayer: player.savePlayer, formatPlayerSeedBlock: player.formatPlayerSeedBlock },
    _anthropicOverride: provider,
  })
  const beat = () => new Promise((r) => setTimeout(r, 250))

  return {
    /** The session's opening: a stubbed greeting line, as if she had just said hi. */
    async primeGreeting(line) {
      st.mode = 'prime'; st.prime = line
      await orch.handleDispatch('sei:idle', { reason: 'just_connected_first_spawn' }, new AbortController().signal)
      st.mode = 'live'
      await beat()
    },
    /** An earlier exchange replayed as already said (no model call). */
    async primeExchange(playerLine, sayLine) {
      if (playerLine) orch.recordIncomingChat(PLAYER, playerLine)
      st.mode = 'prime'; st.prime = sayLine
      await orch.handleDispatch('sei:idle', { quietMs: 20000 }, new AbortController().signal)
      st.mode = 'live'
      await beat()
    },
    /** A live player line through the real model. Returns what she said and remembered. */
    async playerTurn(text, snap = {}) {
      snapshot = snapshotText(snap)
      st.says = []; st.remembers = []; st.farewell = null; st.live = 0; st.done = false
      orch.recordIncomingChat(PLAYER, text)
      let error = null
      try {
        await orch.handleDispatch('player_chat', { username: PLAYER, text, playerSpoke: true }, new AbortController().signal)
      } catch (err) { error = String(err?.message ?? err) }
      await beat()
      const says = [...st.says, ...(st.farewell ? [st.farewell] : [])]
      return { says, remembers: [...st.remembers], error, calls: st.live }
    },
  }
}
