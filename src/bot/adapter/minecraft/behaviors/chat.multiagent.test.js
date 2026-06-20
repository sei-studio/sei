// src/bot/adapter/minecraft/behaviors/chat.multiagent.test.js
//
// 260618 (M1) — multi-agent chat routing. A message aimed only at a sibling
// companion (or a sibling's own chatter) must be RECORDED to history but NOT
// wake this bot: chat.js emits sei:chat_received with suppressInterrupt=true,
// and brain/index.js's onChat records-then-skips on that flag. Here we assert
// the chat.js half: the addressing classification and the suppress flag.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { startChat } from './chat.js'

function makeBot(username) {
  const bot = new EventEmitter()
  bot.username = username
  bot.players = {}
  bot.entity = { position: { x: 0, y: 0, z: 0, distanceTo: () => 5 } }
  return bot
}

function capture(bot) {
  const events = []
  bot.on('sei:chat_received', (p) => events.push(p))
  return events
}

describe('chat.js multi-agent addressing', () => {
  let bot, events
  // Sui is this bot; Marv is the sibling companion; Ouen is the human.
  const config = { player_display_name: 'Ouen', _seiCompanions: ['Marv'] }

  beforeEach(() => {
    bot = makeBot('Sui')
    events = capture(bot)
    startChat(bot, config, null)
  })

  it('emits and does NOT suppress when the human addresses this bot', () => {
    bot.emit('chat', 'Ouen', 'sui come here')
    expect(events).toHaveLength(1)
    expect(events[0].suppressInterrupt).toBe(false)
    expect(events[0].addressed).toBe(true)
    expect(events[0].username).toBe('Ouen') // human substituted to display name
  })

  it('emits but SUPPRESSES when the human names only the sibling', () => {
    bot.emit('chat', 'Ouen', 'marv get going')
    expect(events).toHaveLength(1)
    expect(events[0].suppressInterrupt).toBe(true)
    expect(events[0].addressed).toBe(false)
  })

  it('does NOT suppress when both this bot and the sibling are named', () => {
    bot.emit('chat', 'Ouen', 'sui give marv tasks')
    expect(events[0].suppressInterrupt).toBe(false)
    expect(events[0].addressed).toBe(true)
  })

  it('does NOT suppress a general message to no one in particular', () => {
    bot.emit('chat', 'Ouen', "let's build a base")
    expect(events[0].suppressInterrupt).toBe(false)
  })

  it("suppresses a sibling bot's own chatter and keeps its real name", () => {
    bot.emit('chat', 'Marv', 'on it')
    expect(events).toHaveLength(1)
    expect(events[0].suppressInterrupt).toBe(true)
    expect(events[0].playerSpoke).toBe(false)
    expect(events[0].username).toBe('Marv') // NOT rewritten to the human's name
  })

  it('does NOT suppress when a sibling bot addresses THIS bot BY NAME (260619)', () => {
    // The player can delegate task-giving to a teammate ("marv, listen to sui").
    // A sibling's by-name command must wake us, not just land silently in history
    // — otherwise the directed bot sits idle while its teammate keeps asking.
    bot.emit('chat', 'Marv', 'sui, mine that stone with me')
    expect(events).toHaveLength(1)
    expect(events[0].suppressInterrupt).toBe(false) // by-name → wake
    expect(events[0].addressed).toBe(true)
    expect(events[0].playerSpoke).toBe(false) // still a teammate, not the human
    expect(events[0].username).toBe('Marv') // keeps the sibling's real name
  })

  it('matches names on whole words only (no substring false-positives)', () => {
    // "suit" must not count as addressing "Sui"; "marvelous" not as "Marv".
    bot.emit('chat', 'Ouen', 'nice suit, very marvelous')
    expect(events[0].addressed).toBe(false)
    expect(events[0].suppressInterrupt).toBe(false) // sibling not actually named
  })

  it('falls back to single-bot behavior with no roster', () => {
    const solo = makeBot('Sui')
    const soloEvents = capture(solo)
    startChat(solo, { player_display_name: 'Ouen' }, null)
    solo.emit('chat', 'Ouen', 'marv get going')
    expect(soloEvents[0].suppressInterrupt).toBe(false)
  })
})
