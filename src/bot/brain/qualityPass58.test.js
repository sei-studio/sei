// 261118: quality pass 58. A bit she had just made ("you still owe me a wood
// run tho") came back in the next reply. pass58-probe ablations: in a
// mid-loop reply (a player line while her follow runs) the payload held her
// recent lines twice over, once in the seed turn's conversation and
// own-lines note and again in the mid-loop turn's, and dropping the seed's
// copies cut the reuse from 84% to 56%, the rate of a fresh loop. Once a
// later turn of the loop carries the conversation, the seed's copies leave
// the payload. The canonical messages are not changed.

import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createLoop } from './loop.js'
import { createOrchestrator, _setTickIntervalForTests } from './orchestrator.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const texts = (payload, i) => payload[i].content.filter((b) => b.type === 'text').map((b) => b.text)

describe('loop.supersedeSeedConversation', () => {
  function seeded() {
    const loop = createLoop({ iterationCap: 30 })
    loop.appendUserTurn([
      { type: 'text', name: 'seed_player', text: 'PLAYER' },
      { type: 'text', name: 'recent_conversation', text: 'CONVO v1' },
      { type: 'text', name: 'event', text: 'EVENT' },
      { type: 'text', name: 'own_repeats', text: 'NOTE v1' },
      { type: 'text', name: 'snapshot', text: 'SNAP 1' },
    ], { seed: true })
    loop.appendAssistant([{ type: 'tool_use', id: 'f1', name: 'follow', input: {} }])
    return loop
  }

  it('keeps the seed conversation and note until a later turn carries its own', () => {
    const loop = seeded()
    loop.appendToolResults([{ type: 'tool_result', tool_use_id: 'f1', content: 'still in progress' }], { snapshot: 'SNAP 2' })
    expect(texts(loop.buildAnthropicPayload(), 0)).toEqual(['PLAYER', 'CONVO v1', 'EVENT', 'NOTE v1'])
  })

  it('drops only those two seed blocks once superseded, and leaves the canonical turn whole', () => {
    const loop = seeded()
    loop.supersedeSeedConversation()
    loop.appendToolResults([{ type: 'tool_result', tool_use_id: 'f1', content: 'still in progress' }], {
      snapshot: 'SNAP 2', eventText: 'CONVO v2\n\nthanks for the help\n\nNOTE v2',
    })
    const payload = loop.buildAnthropicPayload()
    expect(texts(payload, 0)).toEqual(['PLAYER', 'EVENT'])
    expect(texts(payload, 2)).toEqual(['CONVO v2\n\nthanks for the help\n\nNOTE v2', 'SNAP 2'])
    expect(loop._internal.messages[0].content.map((b) => b.name))
      .toEqual(['seed_player', 'recent_conversation', 'event', 'own_repeats', 'snapshot'])
  })

  it('leaves blocks of the same name on later turns alone', () => {
    const loop = seeded()
    loop.supersedeSeedConversation()
    loop.appendToolResults([{ type: 'tool_result', tool_use_id: 'f1', content: 'done' }])
    loop.appendAssistant([{ type: 'text', text: 'ok' }])
    loop.appendUserTurn([
      { type: 'text', name: 'recent_conversation', text: 'CONVO v3' },
      { type: 'text', name: 'own_repeats', text: 'NOTE v3' },
    ])
    expect(texts(loop.buildAnthropicPayload(), 4)).toEqual(['CONVO v3', 'NOTE v3'])
  })
})

describe('a player line while her action runs', () => {
  it('shows the conversation once: the seed copy leaves the payload', async () => {
    _setTickIntervalForTests(10_000_000)
    let finish
    const calls = []
    const script = [
      { text: '', toolUses: [{ id: 's1', name: 'say', input: { text: 'jk jk huh. you still owe me a wood run tho' } }] },
      { text: '', toolUses: [{ id: 's2', name: 'say', input: { text: 'ok ok, 10 logs' } }, { id: 'g1', name: 'gather', input: { kind: 'oak_log' } }] },
      { text: '', toolUses: [{ id: 's3', name: 'say', input: { text: 'anytime' } }] },
    ]
    const provider = {
      buildCachedSystem: (blocks) => blocks,
      setAuthToken() {},
      setBackend() {},
      async call(args) {
        calls.push(JSON.parse(JSON.stringify(args.messages)))
        return script[Math.min(calls.length - 1, script.length - 1)]
      },
    }
    const adapter = {
      gameName: 'Minecraft',
      listActions: () => ['follow', 'unfollow', 'goTo', 'gather'],
      getActionSchema: () => z.object({ player: z.string().optional(), kind: z.string().optional() }),
      getActionDescription: (n) => `do ${n}`,
      capabilityParagraph: () => 'caps',
      worldPrimer: () => 'world',
      actionRules: () => 'rules',
      eventAddendum: () => '',
      createSnapshotComposer: () => ({ next: () => 'SNAPSHOT' }),
      chat: vi.fn(),
      closeAnySessions: async () => {},
      executeAction: () => new Promise((resolve) => { finish = resolve }),
    }
    const config = {
      player_username: 'Alex',
      preferred_name: 'Alex',
      persona: { name: 'Sui', expanded: 'You are Sui.' },
      anthropic: { model: 'claude-haiku-4-5', timeout_ms: 20_000, max_retries: 1 },
      llm: { provider: 'anthropic', rate_limit_per_min: 60, debounce_ms: 0, max_hops: 5 },
      memory: {
        memory_md_path: path.join(os.tmpdir(), `sei-pass58-test-${process.pid}-${Date.now()}.md`),
        iteration_cap: 30,
      },
      web: { enabled: false },
    }
    const orch = createOrchestrator({
      adapter, config,
      reenqueue: () => {},
      sessionState: { playerData: () => ({}), onLoopTerminal: async () => {} },
      playerStore: { formatPlayerSeedBlock: () => 'PLAYER' },
      _anthropicOverride: provider,
    })
    const chat = (text) => ({ text, message: text, username: 'Alex', playerSpoke: true, ts: Date.now() })
    for (const line of ['jk jk', 'get me 10 more logs']) {
      orch.recordIncomingChat('Alex', line)
      await orch.handleDispatch('sei:chat_received', chat(line))
    }
    orch.recordIncomingChat('Alex', 'thanks for the help')
    await orch.handleDispatch('sei:chat_received', chat('thanks for the help'))
    // The line lands while the gather runs and is answered in the same loop.
    expect(calls).toHaveLength(3)
    expect(calls[2].map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const last = calls.at(-1)
    const all = JSON.stringify(last)
    expect(all).toContain('thanks for the help')
    // One transcript and one quote of her line, both in the newest turn.
    expect(all.split('Your recent conversation with the player').length - 1).toBe(1)
    expect(all.split('you still owe me a wood run tho').length - 1).toBe(2)
    const seedText = texts(last, 0).join('\n')
    expect(seedText).not.toContain('Your recent conversation with the player')
    expect(seedText).not.toContain('you still owe me a wood run tho')
    finish?.('done')
  })
})




