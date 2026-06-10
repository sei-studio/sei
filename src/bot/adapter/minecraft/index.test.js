// src/bot/adapter/minecraft/index.test.js
//
// 260525-s09 H4 regression tests: adapter.chat() must DROP any message whose
// first non-whitespace character is `/`. Rationale: the single-layer Haiku LLM
// can be prompt-injected by a player into emitting text like `/op MyName`.
// Forwarding that verbatim to bot.chat causes the Minecraft server to execute
// it as an operator command (since `/` is the server command prefix). We DROP
// (not strip-and-send, not escape) so the injection is fully neutralised — a
// stripped slash command would still leak the attacker's intended payload as
// visible chat noise.

import { describe, it, expect, vi } from 'vitest'

// 15-04: registry.js now statically imports ./behaviors/visualize.js, which in
// turn imports ../render/povRenderer.js -> native gl/canvas (built for the
// Electron 42 ABI, NOT loadable under system-Node vitest). createMinecraftAdapter
// -> createDefaultRegistry pulls that chain, so mock the visualize behavior here
// to keep the native modules off this suite's import graph (same strategy as
// registry.vision.test.js).
vi.mock('./behaviors/visualize.js', () => ({
  visualizeAction: vi.fn(async () => ({
    text: 'x',
    image: { mediaType: 'image/jpeg', dataBase64: 'AAAA' },
  })),
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
}))

import { createMinecraftAdapter } from './index.js'

function makeAdapter() {
  const bot = { chat: vi.fn(), username: 'sei', players: {} }
  const config = { adapter: { minecraft: {} } }
  const adapter = createMinecraftAdapter({ bot, config })
  return { adapter, bot }
}

describe('adapter.chat — H4 leading-slash guard (260525-s09)', () => {
  it('forwards normal text to bot.chat unchanged', () => {
    const { adapter, bot } = makeAdapter()
    adapter.chat('hello world')
    expect(bot.chat).toHaveBeenCalledTimes(1)
    expect(bot.chat).toHaveBeenCalledWith('hello world')
  })

  it('drops a leading-slash message (no bot.chat invocation)', () => {
    const { adapter, bot } = makeAdapter()
    adapter.chat('/op MyName')
    expect(bot.chat).not.toHaveBeenCalled()
  })

  it('drops a message with leading whitespace then slash', () => {
    const { adapter, bot } = makeAdapter()
    adapter.chat('   /op MyName')
    expect(bot.chat).not.toHaveBeenCalled()
  })

  it('drops a message with leading tab then slash', () => {
    const { adapter, bot } = makeAdapter()
    adapter.chat('\t/help')
    expect(bot.chat).not.toHaveBeenCalled()
  })

  it('forwards text where the slash is NOT leading', () => {
    const { adapter, bot } = makeAdapter()
    adapter.chat('say /help in chat')
    expect(bot.chat).toHaveBeenCalledTimes(1)
    expect(bot.chat).toHaveBeenCalledWith('say /help in chat')
  })

  it('forwards an empty string (no special-casing in the guard)', () => {
    const { adapter, bot } = makeAdapter()
    adapter.chat('')
    expect(bot.chat).toHaveBeenCalledTimes(1)
    expect(bot.chat).toHaveBeenCalledWith('')
  })

  it('emits a console.warn when dropping a leading-slash message', () => {
    const { adapter, bot } = makeAdapter()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      adapter.chat('/op MyName')
      expect(bot.chat).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
