// 261027: the Minecraft bot logs in under the accent-folded name, and that is
// the same name main and the renderer compute (effectiveMcUsername), so the
// duplicate-name guard, the skin server and the roster all agree with it.
import { describe, it, expect } from 'vitest'
import { botUsernameFor } from './runtime.js'
import { effectiveMcUsername } from '../../../shared/characterSchema'

const NAMES = [
  'Sofía', 'Lucía', 'Élodie', 'Björn', 'Łukasz', 'Straße', 'Søren', 'İpek', 'Zoë',
  'Chén Huǒ', 'Catalina Vásquez', '诗诗', '민지 (Min-ji)', 'Йордан', 'Sui', '', 'Straßenmusikantin',
]

describe('botUsernameFor (minecraft)', () => {
  it('folds accents instead of deleting them', () => {
    expect(botUsernameFor({ name: 'Sofía' })).toBe('Sofia')
    expect(botUsernameFor({ name: 'Élodie' })).toBe('Elodie')
    expect(botUsernameFor({ name: 'Łukasz' })).toBe('Lukasz')
    expect(botUsernameFor({ name: 'Straßenmusikantin' })).toBe('Strassenmusikant')
  })

  it('keeps an explicit username and the Sei fallback', () => {
    expect(botUsernameFor({ name: 'Sofía', username: 'Sofa' })).toBe('Sofa')
    expect(botUsernameFor({ name: '诗诗' })).toBe('Sei')
    expect(botUsernameFor({})).toBe('Sei')
  })

  it('matches effectiveMcUsername for every name', () => {
    for (const name of NAMES) {
      expect(botUsernameFor({ name, username: null })).toBe(effectiveMcUsername({ name, username: null }))
    }
  })
})
