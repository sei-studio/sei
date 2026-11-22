// 261027: the Minecraft bot logs in under the accent-folded name, and that is
// the same name main and the renderer compute (effectiveMcUsername), so the
// duplicate-name guard, the skin server and the roster all agree with it.
import { describe, it, expect } from 'vitest'
import { botUsernameFor } from './runtime.js'
import { effectiveMcUsername } from '../../../shared/characterSchema'

const NAMES = [
  'SofÃ­a', 'LucÃ­a', 'Ã‰lodie', 'BjÃ¶rn', 'Åukasz', 'StraÃŸe', 'SÃ¸ren', 'Ä°pek', 'ZoÃ«',
  'ChÃ©n HuÇ’', 'Catalina VÃ¡squez', 'è¯—è¯—', 'ë¯¼ì§€ (Min-ji)', 'Ð™Ð¾Ñ€Ð´Ð°Ð½', 'Sui', '', 'StraÃŸenmusikantin',
]

describe('botUsernameFor (minecraft)', () => {
  it('folds accents instead of deleting them', () => {
    expect(botUsernameFor({ name: 'SofÃ­a' })).toBe('Sofia')
    expect(botUsernameFor({ name: 'Ã‰lodie' })).toBe('Elodie')
    expect(botUsernameFor({ name: 'Åukasz' })).toBe('Lukasz')
    expect(botUsernameFor({ name: 'StraÃŸenmusikantin' })).toBe('Strassenmusikant')
  })

  it('keeps an explicit username and the Sei fallback', () => {
    expect(botUsernameFor({ name: 'SofÃ­a', username: 'Sofa' })).toBe('Sofa')
    expect(botUsernameFor({ name: 'è¯—è¯—' })).toBe('Sei')
    expect(botUsernameFor({})).toBe('Sei')
  })

  it('matches effectiveMcUsername for every name', () => {
    for (const name of NAMES) {
      expect(botUsernameFor({ name, username: null })).toBe(effectiveMcUsername({ name, username: null }))
    }
  })
})




