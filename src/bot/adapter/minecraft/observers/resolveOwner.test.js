// src/bot/adapter/minecraft/observers/resolveOwner.test.js
//
// 260625 — owner-whereabouts bug. The snapshot pins the owner by
// config.player_username, which is often a preferred_name ("Ouen") while the
// LAN tab list is keyed by the actual login ("SSk1tz"). A hard
// bot.players[pinUsername] lookup then ALWAYS missed and the snapshot reported
// the owner "out of view — position unknown" on every tick even when adjacent,
// so the bot could never do anything but follow(). resolveOwner falls back to a
// case-insensitive match, then to the lone human in the tab list.

import { describe, it, expect } from 'vitest'
import { resolveOwner } from './snapshot.js'

function bot(self, players) {
  return { username: self, players }
}

describe('resolveOwner (260625)', () => {
  it('exact username match wins', () => {
    const b = bot('YancyBot', { SSk1tz: { username: 'SSk1tz' } })
    expect(resolveOwner(b, 'SSk1tz', [])).toEqual({ username: 'SSk1tz', player: { username: 'SSk1tz' } })
  })

  it('falls back case-insensitively when the pin differs only in case', () => {
    const b = bot('YancyBot', { SSk1tz: { username: 'SSk1tz' } })
    const r = resolveOwner(b, 'ssk1tz', [])
    expect(r?.username).toBe('SSk1tz')
  })

  it('THE BUG: preferred_name pin resolves to the lone human login', () => {
    // pin "Ouen" has no tab-list entry; the only human is "SSk1tz".
    const b = bot('YancyBot', { YancyBot: { username: 'YancyBot' }, SSk1tz: { username: 'SSk1tz' } })
    const r = resolveOwner(b, 'Ouen', [])
    expect(r?.username).toBe('SSk1tz')
  })

  it('excludes the bot itself and companions from the single-human fallback', () => {
    const b = bot('YancyBot', {
      YancyBot: { username: 'YancyBot' },
      SuiBot: { username: 'SuiBot' },
      SSk1tz: { username: 'SSk1tz' },
    })
    const r = resolveOwner(b, 'Ouen', ['SuiBot'])
    expect(r?.username).toBe('SSk1tz')
  })

  it('returns null when the human is ambiguous (two non-bot, non-companion players)', () => {
    const b = bot('YancyBot', {
      YancyBot: { username: 'YancyBot' },
      SSk1tz: { username: 'SSk1tz' },
      Someone: { username: 'Someone' },
    })
    expect(resolveOwner(b, 'Ouen', [])).toBeNull()
  })

  it('returns null when there is no pin', () => {
    const b = bot('YancyBot', { SSk1tz: { username: 'SSk1tz' } })
    expect(resolveOwner(b, null, [])).toBeNull()
  })
})
