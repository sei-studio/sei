// src/bot/adapter/minecraft/behaviors/chat.death.test.js
//
// 260730 — the PLAYER's death reaches the model as a death, with its cause.
// Vanilla death lines arrive as SYSTEM chat, so before this they were relabeled
// "ran a command (in-game, not a message or instruction to you): ..." and the
// model discounted them: live, Sui asked the player how they died while
// "Shawn was blown up by Creeper" sat verbatim in its own context.
//
// Contract under test: a death line is emitted once, framed as a death, naming
// the cause, waking a turn but never preempting (playerSpoke false); the bot's
// OWN death is dropped here (connect.js emits sei:death for it); and an
// ordinary system line still gets the command relabel.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { startChat, parseDeathLine } from './chat.js'

function makeBot(username) {
  const bot = new EventEmitter()
  bot.username = username
  bot.players = {}
  bot.entity = { position: { x: 0, y: 0, z: 0, distanceTo: () => 5 } }
  return bot
}

// Reproduce the real ordering: mineflayer emits `messagestr` first (our
// prepended listener runs before its legacy pattern matcher), and the pattern
// matcher then re-emits system lines as `chat`.
function serverLine(bot, text, position, jsonMsg) {
  bot.emit('messagestr', text, position, jsonMsg)
  bot.emit('chat', bot.username === 'Sui' ? 'Shawn' : 'Shawn', text)
}

const DEATH_JSON = { translate: 'death.attack.explosion', with: [{ text: 'Shawn' }, { text: 'Creeper' }] }

describe('parseDeathLine', () => {
  it('recognizes a translated death message and its subject', () => {
    expect(parseDeathLine('Shawn was blown up by Creeper', DEATH_JSON)).toEqual({
      subject: 'Shawn',
      text: 'Shawn was blown up by Creeper',
    })
  })

  it('falls back to the text when there is no translate key', () => {
    expect(parseDeathLine('Shawn fell from a high place', null)?.subject).toBe('Shawn')
    expect(parseDeathLine('Shawn drowned', null)?.subject).toBe('Shawn')
  })

  it('does not fire on ordinary system lines', () => {
    expect(parseDeathLine('Set own game mode to Creative Mode', null)).toBe(null)
    expect(parseDeathLine('Shawn joined the game', null)).toBe(null)
    expect(parseDeathLine('', null)).toBe(null)
  })
})

describe('chat.js death routing', () => {
  let bot, events
  const config = { player_username: 'Shawn', player_display_name: 'Ouen' }

  beforeEach(() => {
    bot = makeBot('Sui')
    events = []
    bot.on('sei:chat_received', (p) => events.push(p))
    startChat(bot, config, null)
  })

  it("frames the player's death as a death, with the cause, exactly once", () => {
    serverLine(bot, 'Shawn was blown up by Creeper', 'system', DEATH_JSON)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.username).toBe('Ouen') // display name, never the gamertag
    expect(e.message).toContain('just DIED in-game')
    expect(e.message).toContain('Shawn was blown up by Creeper')
    expect(e.message).not.toContain('ran a command')
    // Wakes a turn, but is not the player speaking, so it cannot preempt.
    expect(e.suppressInterrupt).toBe(false)
    expect(e.playerSpoke).toBe(false)
  })

  it("drops the bot's OWN death line (connect.js emits sei:death for it)", () => {
    serverLine(bot, 'Sui was slain by Zombie', 'system', {
      translate: 'death.attack.mob',
      with: [{ text: 'Sui' }, { text: 'Zombie' }],
    })
    expect(events).toHaveLength(0)
  })

  it('still relabels an ordinary system line as a command', () => {
    serverLine(bot, 'Set own game mode to Creative Mode', 'system', null)
    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('ran a command')
    expect(events[0].suppressInterrupt).toBe(true)
  })

  it('leaves real player chat alone', () => {
    bot.emit('messagestr', '<Shawn> hey sui', 'chat', null)
    bot.emit('chat', 'Shawn', 'hey sui')
    expect(events).toHaveLength(1)
    expect(events[0].message).toBe('hey sui')
    expect(events[0].playerSpoke).toBe(true)
  })
})
